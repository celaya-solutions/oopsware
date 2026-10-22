import { stat } from "node:fs/promises";
import { basename } from "node:path";
import type { Readable } from "node:stream";

import type {
  ArtifactEntry,
  ArtifactReader,
} from "../artifacts/ArtifactReader.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import type { ArchiveReadPolicy } from "../artifacts/archives/StreamArchiveArtifactReader.js";
import {
  classifyAndHashRoot,
  classifyRootFile,
} from "../artifacts/inventory/classify.js";
import { createReader } from "../artifacts/inventory/reader.js";
import type { ArtifactOccurrence } from "../domain/artifactGraph.js";
import { detectFormatCandidates } from "../domain/formatDetection.js";
import {
  containerPlan,
  type ContainerPlan,
} from "../domain/identification/containers.js";
import {
  chooseFormat,
  type FormatChoice,
} from "../domain/identification/formatChoice.js";
import {
  MAX_IDENTIFY_DIAGNOSTICS,
  type IdentificationCounters,
  type IdentifyArtifactInput,
} from "../domain/identification/identification.js";
import {
  automaticRouteFor,
  readerRoutesFor,
  type ReaderRoute,
} from "../domain/identification/readerRoutes.js";
import type { ReadPiece } from "../application/identification/IdentificationPort.js";
import { readStreamHead, type ExaminedBytes } from "./bytes.js";
import {
  EntryLimit,
  joinPath,
  message,
  setFormat,
  type Piece,
} from "./pieces.js";
import { keyOf, ReaderBudget } from "./readerBudget.js";
import { IdentificationSpool } from "./spool.js";

export interface WalkOptions {
  readonly signal?: AbortSignal | undefined;
  readonly readPiece: ReadPiece;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly platform: NodeJS.Platform;
  readonly archive?: ArchiveReadPolicy | undefined;
  /** Where the private scratch directory is created; the host temp folder by default. */
  readonly scratchParent?: string | undefined;
}

const SPOOL_BUDGET = "Copying it out would pass the max_spool_bytes budget.";

/** One identification walk: owns its counters, spool, readers and diagnostics. */
export class Walk {
  readonly pieces: Piece[] = [];
  readonly counters: IdentificationCounters = {
    entries: 0,
    entryLimit: false,
    containersOpened: 0,
    containersNotOpened: 0,
    containersStopped: 0,
    readersRun: 0,
    readersNotRun: 0,
    spooledBytes: 0,
    spoolLimit: false,
    symlinks: 0,
    special: 0,
    unreadable: 0,
    diagnosticsOmitted: 0,
  };
  readonly diagnostics: { piece: string | null; message: string }[] = [];
  readonly limitations = new Set<string>();
  readonly #deferred: { piece: Piece; route: ReaderRoute; path: string }[] = [];
  readonly #readers: ReaderBudget<Piece>;
  readonly #spool: IdentificationSpool;
  readonly #scope = new ArtifactResourceScope();
  /** Copied-out files and the logical path each stands for, so no message names scratch. */
  readonly #copies = new Map<string, string>();

  constructor(
    readonly input: IdentifyArtifactInput,
    readonly depth: number,
    readonly options: WalkOptions,
  ) {
    this.#spool = new IdentificationSpool(
      input.max_spool_bytes,
      options.scratchParent,
    );
    this.#readers = new ReaderBudget(input.max_readers);
  }

  get signal(): AbortSignal | undefined {
    return this.options.signal;
  }

  /** Count one entry against the budget. */
  examine(): void {
    this.signal?.throwIfAborted();
    if (this.counters.entries >= this.input.max_entries) {
      this.counters.entryLimit = true;
      throw new EntryLimit();
    }
    this.counters.entries += 1;
  }

  /** An entry a reader skipped (device, FIFO, socket) still costs an entry. */
  omitted(piece: string | null, path: string, kind: string): void {
    this.counters.entries += 1;
    this.counters.special += 1;
    this.diagnose(piece, `${path}: ${kind} not read.`);
  }

  /** Keep a bounded list of diagnostics; scratch paths become logical ones. */
  diagnose(piece: string | null, text: string): void {
    if (this.diagnostics.length >= MAX_IDENTIFY_DIAGNOSTICS) {
      this.counters.diagnosticsOmitted += 1;
      return;
    }
    this.diagnostics.push({ piece, message: this.scrub(text) });
  }

  /** Replace copied-out file paths with the logical paths they stand for. */
  scrub(text: string): string {
    let result = text;
    for (const [copy, logical] of this.#copies)
      result = result.replaceAll(copy, logical);
    return result;
  }

  add(fields: {
    parent: Piece | null;
    depth: number;
    path: string;
    name: string;
    kind: Piece["kind"];
    bytes: number | null;
    onDisk: string | null;
  }): Piece {
    const piece: Piece = {
      id: `p${String(this.pieces.length)}`,
      parent: fields.parent?.id ?? null,
      depth: fields.depth,
      path: fields.path,
      name: fields.name,
      kind: fields.kind,
      bytes: fields.bytes,
      format: null,
      format_basis: null,
      label: null,
      candidates: [],
      name_conflict: null,
      container: { state: "not_container", members: null, reason: null },
      reader: { tool: null, state: "none", reason: null },
      headline: null,
      onDisk: fields.onDisk,
      outer:
        fields.parent === null
          ? null
          : fields.parent.onDisk !== null
            ? fields.parent.id
            : fields.parent.outer,
      hinted: [],
      fallback: null,
      openable: false,
    };
    this.pieces.push(piece);
    return piece;
  }

  /** Record detection on a piece and return the choice. */
  detect(piece: Piece, bytes: ExaminedBytes): FormatChoice {
    return this.detection(piece, bytes).choice;
  }

  detection(
    piece: Piece,
    bytes: ExaminedBytes,
  ): {
    readonly choice: FormatChoice;
    readonly detection: ReturnType<typeof detectFormatCandidates>;
  } {
    const detection = detectFormatCandidates({
      prefix: bytes.prefix,
      fileSize: bytes.size,
      name: piece.name,
      trailer: bytes.trailer,
    });
    const choice = chooseFormat(detection);
    setFormat(piece, choice.format, choice.basis);
    piece.candidates = [...choice.candidates];
    piece.name_conflict = choice.nameConflict;
    piece.fallback = choice.fallback;
    piece.hinted = detection.name_hint.formats.filter(
      (format) => !choice.candidates.includes(format),
    );
    return { choice, detection };
  }

  containerPlan(choice: FormatChoice): ContainerPlan {
    return containerPlan(choice.candidates, this.options.platform);
  }

  /** Choose a reader for a piece now, or say why it is not run. */
  chooseReader(piece: Piece, choice: FormatChoice): ReaderRoute | undefined {
    const route = automaticRouteFor(choice.format, choice.candidates);
    if (route === undefined) {
      const offered = readerRoutesFor(choice.format, choice.candidates)[0];
      piece.reader =
        offered === undefined
          ? { tool: null, state: "none", reason: null }
          : offered.requires === null
            ? {
                tool: offered.tool,
                state: "skipped",
                reason:
                  "Offered as a next step; identification does not run it itself.",
              }
            : {
                tool: offered.tool,
                state: "needs_provider",
                reason: offered.requires,
              };
      return undefined;
    }
    const reason = this.#readers.claim(piece, route);
    if (reason !== null) {
      piece.reader = { tool: route.tool, state: "skipped", reason };
      this.counters.readersNotRun += 1;
      return undefined;
    }
    piece.reader = {
      tool: route.tool,
      state: "skipped",
      reason: "Not run yet.",
    };
    return route;
  }

  /** A claimed reader that will not run (no room to copy, unreadable member). */
  unclaim(piece: Piece, route: ReaderRoute, reason: string): void {
    this.#readers.release(piece, route);
    piece.reader = { tool: route.tool, state: "skipped", reason };
    this.counters.readersNotRun += 1;
  }

  async read(piece: Piece, route: ReaderRoute, path: string): Promise<void> {
    this.signal?.throwIfAborted();
    const outcome = await this.options
      .readPiece(route, path, piece.format, this.signal)
      .catch((cause: unknown) => {
        if (this.signal?.aborted === true) throw cause;
        return { ok: false as const, reason: message(cause), refuted: false };
      });
    this.signal?.throwIfAborted();
    this.counters.readersRun += 1;
    if (outcome.ok) {
      piece.reader = { tool: route.tool, state: "ran", reason: null };
      piece.headline = outcome.headline;
      if (piece.format_basis === "name") piece.format_basis = "reader";
      return;
    }
    const reason = this.scrub(outcome.reason);
    piece.reader = { tool: route.tool, state: "failed", reason };
    // A failed read does not stand for its format: another piece may try.
    this.#readers.failed(piece, route);
    if (!outcome.refuted || piece.format_basis !== "name") return;
    // The reader that owns the named format refuted the name; the bytes stand.
    piece.name_conflict = `The name suggests ${piece.label ?? String(piece.format)}, but ${route.tool} did not confirm it: ${reason}`;
    setFormat(piece, piece.fallback, piece.fallback === null ? null : "bytes");
  }

  defer(piece: Piece, route: ReaderRoute, path: string): void {
    this.#deferred.push({ piece, route, path });
  }

  /** Read the on-disk pieces, retrying another piece of a format whose read failed. */
  async runDeferred(): Promise<void> {
    for (const { piece, route, path } of this.#deferred) {
      let current: { piece: Piece; path: string } | undefined = { piece, path };
      while (current !== undefined) {
        const reading: Piece = current.piece;
        // Taken before reading: a refuted name changes the piece's format.
        const key = keyOf(reading, route);
        await this.read(reading, route, current.path);
        current =
          reading.reader.state === "failed"
            ? this.#readers.retry(key)
            : undefined;
        // A retried piece was counted as not read when it was skipped.
        if (current !== undefined) this.counters.readersNotRun -= 1;
      }
    }
  }

  /** Classify and hash a root file exactly as the artifact inventory does. */
  async classifyRoot(path: string): Promise<{
    readonly format: ArtifactOccurrence["artifact_format"];
    readonly sha256: string | null;
  }> {
    const metadata = await stat(path);
    const classified = await classifyAndHashRoot(path, false, metadata, {
      resourceScope: this.#scope,
      ...(this.signal === undefined ? {} : { signal: this.signal }),
    });
    return {
      format: classified.format,
      sha256: classified.digest?.sha256 ?? null,
    };
  }

  /** Open a container file on disk; a failure to open stays on this piece. */
  async openFile(container: Piece, path: string, level: number): Promise<void> {
    let format: ArtifactOccurrence["artifact_format"];
    try {
      format = await classifyRootFile(path, await stat(path), {
        resourceScope: this.#scope,
        ...(this.signal === undefined ? {} : { signal: this.signal }),
      });
    } catch (cause: unknown) {
      if (this.signal?.aborted === true) throw cause;
      this.notOpened(container, `Could not open it: ${message(cause)}`);
      return;
    }
    await this.openContainer(container, path, format, level);
  }

  notOpened(container: Piece, reason: string): void {
    container.container = {
      state: "not_opened",
      members: null,
      reason: this.scrub(reason),
    };
    this.counters.containersNotOpened += 1;
  }

  async openContainer(
    container: Piece,
    path: string,
    format: ArtifactOccurrence["artifact_format"],
    level: number,
  ): Promise<void> {
    const reader = createReader(
      path,
      format,
      this.options.environment,
      undefined,
      this.options.archive,
    );
    if (reader === undefined) {
      this.notOpened(
        container,
        `No reader opens ${format} files on this host.`,
      );
      return;
    }
    const opened = {
      state: "opened" as const,
      members: 0,
      reason: null as string | null,
    };
    container.container = opened;
    let stop: unknown;
    try {
      for await (const entry of reader.entries(this.signal, {
        onOmission: (omission) => {
          this.omitted(container.id, omission.path, omission.kind);
        },
      })) {
        this.examine();
        opened.members += 1;
        await this.member(container, reader, entry, level);
      }
    } catch (cause: unknown) {
      if (cause instanceof EntryLimit || this.signal?.aborted === true)
        stop = cause;
      else this.stopped(container, opened.members, cause);
    } finally {
      for (const omitted of reader.omissions?.() ?? [])
        this.diagnose(container.id, omitted);
      await reader.close().catch((cause: unknown) => {
        this.diagnose(
          container.id,
          `Closing the ${format} reader failed: ${message(cause)}`,
        );
      });
    }
    if (container.container.state === "opened")
      this.counters.containersOpened += 1;
    if (stop !== undefined) throw stop;
  }

  /** A container that failed before its first member was never opened. */
  stopped(container: Piece, members: number, cause: unknown): void {
    if (members === 0) {
      this.notOpened(container, `Could not open it: ${message(cause)}`);
      return;
    }
    const reason = this.scrub(
      `Stopped reading after ${String(members)} members: ${message(cause)}`,
    );
    container.container = { state: "opened", members, reason };
    this.counters.containersStopped += 1;
    this.diagnose(container.id, reason);
  }

  async member(
    parent: Piece,
    reader: ArtifactReader,
    entry: ArtifactEntry,
    level: number,
  ): Promise<void> {
    const kind =
      entry.kind === "file" || entry.kind === "slice"
        ? "file"
        : entry.kind === "directory"
          ? "directory"
          : "symlink";
    const piece = this.add({
      parent,
      depth: level,
      path: joinPath(parent.path, entry.path),
      name: basename(entry.path) || entry.path,
      kind,
      bytes: entry.declaredSize,
      onDisk: null,
    });
    if (kind === "symlink") this.counters.symlinks += 1;
    if (kind !== "file") return;
    if (entry.encrypted) {
      this.unreadable(piece, "Encrypted member; its bytes were not read.");
      return;
    }
    let stream: Readable | undefined;
    try {
      stream = await reader.open(entry, this.signal);
      await this.memberBytes(piece, stream, entry, level);
    } catch (cause: unknown) {
      if (cause instanceof EntryLimit || this.signal?.aborted === true)
        throw cause;
      // One bad member: random-access readers go on; a stream reader's next step fails by itself.
      this.unreadable(piece, `Not read: ${message(cause)}`);
    } finally {
      stream?.destroy();
    }
  }

  unreadable(piece: Piece, reason: string): void {
    this.counters.unreadable += 1;
    if (piece.reader.reason === "Not run yet." && piece.reader.tool !== null)
      piece.reader = {
        ...piece.reader,
        reason: "The member could not be read.",
      };
    this.diagnose(piece.id, reason);
  }

  async memberBytes(
    piece: Piece,
    stream: Readable,
    entry: ArtifactEntry,
    level: number,
  ): Promise<void> {
    const head = await readStreamHead(stream);
    const size = head.ended ? head.bytes : (entry.declaredSize ?? head.bytes);
    piece.bytes ??= head.ended ? head.bytes : entry.declaredSize;
    const choice = this.detect(piece, {
      prefix: head.prefix,
      trailer: null,
      size,
    });
    const plan = this.containerPlan(choice);
    const wantOpen = plan.openable && level < this.depth;
    const route = this.chooseReader(piece, choice);
    this.describeContainer(piece, plan, wantOpen);
    if (!wantOpen && route === undefined) return;
    const refuse = (reason: string) => {
      this.counters.spoolLimit = true;
      if (wantOpen) this.notOpened(piece, reason);
      if (route !== undefined) this.unclaim(piece, route, reason);
    };
    if (!this.#spool.fits(head.ended ? head.bytes : entry.declaredSize)) {
      refuse(SPOOL_BUDGET);
      return;
    }
    const copy = await this.#spool.copy(
      piece.id,
      piece.name,
      head,
      this.signal,
    );
    this.counters.spooledBytes = this.#spool.copiedBytes;
    if (copy.kind === "over-budget") {
      refuse(SPOOL_BUDGET);
      return;
    }
    this.#copies.set(copy.path, piece.path);
    try {
      if (route !== undefined) await this.read(piece, route, copy.path);
      if (wantOpen) await this.openFile(piece, copy.path, level + 1);
    } finally {
      this.#copies.delete(copy.path);
      await this.#spool.discard(copy.path);
    }
  }

  /** Container state before (or instead of) opening it. */
  describeContainer(
    piece: Piece,
    plan: ContainerPlan,
    willOpen: boolean,
  ): void {
    piece.openable = plan.openable;
    if (willOpen) return;
    if (plan.openable)
      this.notOpened(
        piece,
        this.depth === 0
          ? "depth is 0, so containers are identified but not opened."
          : `It is ${String(this.depth)} container levels down (the depth limit).`,
      );
    else if (plan.reason !== null)
      piece.container = {
        state: "not_opened",
        members: null,
        reason: plan.reason,
      };
  }

  async close(): Promise<string | null> {
    const left = await this.#spool.close();
    await this.#scope.close().catch((cause: unknown) => {
      this.diagnose(null, `Releasing file handles failed: ${message(cause)}`);
    });
    return left;
  }
}
