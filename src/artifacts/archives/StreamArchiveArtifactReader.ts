import { createHash, randomUUID, type Hash } from "node:crypto";
import { lstat, type FileHandle } from "node:fs/promises";
import { basename } from "node:path";
import { Readable, finished, pipeline } from "node:stream";
import { createGunzip, createZstdDecompress, type Gunzip } from "node:zlib";

import type { ArtifactCommand } from "../../domain/artifactGraph.js";
import {
  hasTarHeader,
  ISO_DESCRIPTOR_OFFSET,
  TAR_BLOCK_BYTES,
  type ReadableArchiveStreamFormat,
} from "../../domain/archiveStreamFormat.js";
import {
  openRegularFile,
  sameRegularFileState,
  NonRegularFileReadError,
} from "../../filesystem/RegularFile.js";
import { cleanupOwnedProcessGroup } from "../../process/ProcessOwnership.js";
import {
  ProviderProcessSupervisor,
  spawnOwnedProviderProcess,
} from "../../process/ProviderProcess.js";
import {
  ArtifactReaderFailure,
  copyArtifactEntry,
  sameArtifactEntry,
  type ArtifactEntry,
  type ArtifactReader,
} from "../ArtifactReader.js";
import { streamChunkToBuffer } from "../StreamBytes.js";
import {
  resolveArchiveDecoder,
  type ArchiveDecoderTool,
  type ResolvedArchiveDecoder,
} from "./ArchiveDecoderTools.js";
import { ByteSource } from "./ByteSource.js";
import { CpioStream, type CpioMember } from "../../linuxPackage/cpio.js";
import {
  locateLinuxPayload,
  type LinuxPayload,
} from "./LinuxPackagePayload.js";
import { observeSevenZipHeader } from "./SevenZipHeader.js";
import { TarStream, type TarMember } from "./TarStream.js";

/** Whether this reader may run an external decoder process. */
export type ExternalDecoderPolicy = "allow" | "deny";

/** Archive reading policy chosen by the surface that owns the scan. */
export interface ArchiveReadPolicy {
  readonly externalDecoders: ExternalDecoderPolicy;
  /** Decoded bytes examined before the read stops with a `limit` failure. */
  readonly maximumDecodedBytes: number;
  /** Container images are read unless this is `deny` (the hosted service does not open them). */
  readonly containerImages?: "allow" | "deny";
}

/** Local default: installed decoders allowed, 16 GiB of decoded bytes. */
export const DEFAULT_ARCHIVE_READ_POLICY: ArchiveReadPolicy = {
  externalDecoders: "allow",
  maximumDecodedBytes: 16 * 1024 ** 3,
};

const DIAGNOSTIC_BYTES = 16 * 1024;
const EXIT_WAIT_MS = 30_000;
const STREAM_LABEL: Readonly<Record<ReadableArchiveStreamFormat, string>> = {
  iso: "ISO 9660",
  tar: "Tar",
  gzip: "Gzip",
  xz: "XZ",
  "7z": "7z",
  deb: "Debian package",
  rpm: "RPM package",
};

interface CurrentMember {
  readonly key: string;
  readonly metadata: ArtifactEntry;
  readonly data: () => AsyncGenerator<Buffer>;
  opened: boolean;
  settled: Promise<void> | undefined;
}

interface DecoderProcess {
  readonly decoder: ResolvedArchiveDecoder;
  readonly arguments: readonly string[];
  readonly supervisor: ProviderProcessSupervisor;
  readonly stdout: Readable;
  inputFailure: Error | undefined;
}

/**
 * Sequential reader for tar, ISO 9660, gzip and xz streams, and 7z archives.
 *
 * Compression streams are decoded in order; a decoded tar archive exposes
 * its members, and any other decoded payload is one file. ISO and 7z archives are
 * converted to a pax stream by libarchive's bsdtar and parsed by the same tar
 * parser, so exact names never pass through a column listing. Members must
 * be opened in inventory order while they are current.
 */
export class StreamArchiveArtifactReader implements ArtifactReader {
  readonly format: ReadableArchiveStreamFormat;
  readonly #path: string;
  readonly #policy: ArchiveReadPolicy;
  #handle: FileHandle | undefined;
  #process: DecoderProcess | undefined;
  #decoded: Readable | undefined;
  #gunzip: Gunzip | undefined;
  #source: ByteSource | undefined;
  #current: CurrentMember | undefined;
  #commands: ArtifactCommand[] = [];
  #observations: string[] = [];
  #omissions: string[] = [];
  /** The located payload of a .deb or .rpm, once #decode has read the package headers. */
  #linux: LinuxPayload | undefined;
  #started = false;
  #closed = false;

  constructor(
    path: string,
    format: ReadableArchiveStreamFormat,
    policy: ArchiveReadPolicy = DEFAULT_ARCHIVE_READ_POLICY,
  ) {
    this.#path = path;
    this.format = format;
    this.#policy = policy;
  }

  /** Transformation facts: decoder, decoded digest, payload kind, end marker. */
  observations(): readonly string[] {
    return [...this.#observations];
  }

  /** Members seen but not exposed as entries; extraction cannot be complete. */
  omissions(): readonly string[] {
    return [...this.#omissions];
  }

  provenance(): readonly ArtifactCommand[] {
    return [...this.#commands];
  }

  async *entries(signal?: AbortSignal): AsyncIterable<ArtifactEntry> {
    if (this.#started)
      throw new ArtifactReaderFailure(
        "integrity",
        "A streamed archive reader enumerates its members once",
      );
    this.#started = true;
    abortIfNeeded(signal);
    const handle = await this.#open(signal);
    const initial = await handle.stat();
    const onAbort = (): void => {
      this.#decoded?.destroy(cancelled());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const decoded = await this.#decode(handle, initial.size, signal);
      if (decoded === null) return;
      const state = { bytes: 0, hash: createHash("sha256") };
      const source = new ByteSource(
        meter(
          decoded,
          state,
          this.#policy.maximumDecodedBytes,
          this.format,
          signal,
        ),
      );
      this.#source = source;
      if (
        this.format === "tar" ||
        this.format === "7z" ||
        this.format === "iso" ||
        this.format === "deb"
      )
        yield* this.#tarMembers(source, signal);
      else if (this.format === "rpm") yield* this.#cpioMembers(source, signal);
      else {
        const head = await source.peek(TAR_BLOCK_BYTES);
        if (head.length === TAR_BLOCK_BYTES && hasTarHeader(head))
          yield* this.#tarMembers(source, signal);
        else yield* this.#payload(source, handle);
      }
      await this.#settleCurrent();
      // Drain anything a consumer left unread so the digest covers the whole stream.
      await source.skip(Number.MAX_SAFE_INTEGER);
      await this.#finishDecoder();
      await this.#observeGzipTail(handle, initial.size);
      if (this.format !== "tar")
        this.#observations.unshift(
          this.format === "7z" || this.format === "iso"
            ? `libarchive bsdtar converted the ${STREAM_LABEL[this.format]} archive to a ${String(state.bytes)}-byte pax stream with SHA-256 ${state.hash.digest("hex")}; member bytes are read from that stream.`
            : this.#linux !== undefined
              ? `${STREAM_LABEL[this.format]} payload (${this.#linux.compression}) was decoded to a ${String(state.bytes)}-byte ${this.#linux.container} stream with SHA-256 ${state.hash.digest("hex")}.`
              : `${STREAM_LABEL[this.format]} input was decoded to ${String(state.bytes)} bytes with SHA-256 ${state.hash.digest("hex")}.`,
        );
      await this.#verifySource(handle, initial);
    } finally {
      signal?.removeEventListener("abort", onAbort);
      this.#current = undefined;
    }
  }

  open(entry: ArtifactEntry, signal?: AbortSignal): Promise<Readable> {
    try {
      abortIfNeeded(signal);
    } catch (cause: unknown) {
      return Promise.reject(cause as Error);
    }
    const current = this.#current;
    if (
      current === undefined ||
      current.opened ||
      current.key !== entry.adapterKey ||
      !sameArtifactEntry(entry, current.metadata)
    )
      return Promise.reject(
        new ArtifactReaderFailure(
          "integrity",
          `Streamed archive member is not the current unread member: ${entry.path}`,
        ),
      );
    if (entry.kind !== "file")
      return Promise.reject(
        new ArtifactReaderFailure(
          "format",
          `Archive member is not a regular file: ${entry.path}`,
        ),
      );
    current.opened = true;
    let settle: () => void = () => undefined;
    current.settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const data = current.data;
    const guarded = async function* (): AsyncGenerator<Buffer> {
      try {
        for await (const piece of data()) {
          abortIfNeeded(signal);
          yield piece;
        }
      } finally {
        settle();
      }
    };
    const stream = Readable.from(guarded(), { objectMode: false });
    finished(stream, () => settle());
    return Promise.resolve(stream);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const failures: string[] = [];
    this.#decoded?.destroy();
    const owned = this.#process;
    if (owned !== undefined) {
      const stopped = await owned.supervisor.stop().catch((cause: unknown) => ({
        status: "incomplete" as const,
        reason: cause instanceof Error ? cause.message : String(cause),
      }));
      if (stopped.status === "incomplete")
        failures.push(
          `${owned.decoder.tool} decoder cleanup: ${stopped.reason}`,
        );
    }
    if (this.#handle !== undefined)
      await this.#handle.close().catch((cause: unknown) => {
        failures.push(cause instanceof Error ? cause.message : String(cause));
      });
    this.#handle = undefined;
    if (failures.length > 0)
      throw new ArtifactReaderFailure("io", failures.join("; "), {
        cleanup: {
          reason: failures.join("; "),
          resources: [`archive reader for ${this.#path}`],
        },
      });
  }

  async #open(signal?: AbortSignal): Promise<FileHandle> {
    try {
      this.#handle = await openRegularFile(this.#path, {
        symlinks: "reject",
        signal,
      });
      return this.#handle;
    } catch (cause: unknown) {
      if (cause instanceof NonRegularFileReadError)
        throw new ArtifactReaderFailure(
          "format",
          `Archive source is not a regular file: ${this.#path}`,
          { cause },
        );
      throw cause;
    }
  }

  /** Build the decoded byte stream, or null when nothing can be listed. */
  async #decode(
    handle: FileHandle,
    size: number,
    signal?: AbortSignal,
  ): Promise<Readable | null> {
    const raw = (): Readable => readOwnedHandle(handle);
    switch (this.format) {
      case "tar":
        this.#decoded = raw();
        return this.#decoded;
      case "gzip": {
        const gunzip = createGunzip();
        pipeline(raw(), gunzip, () => undefined);
        this.#commands.push({
          tool: "node:zlib",
          arguments: ["gunzip"],
          tool_version: `zlib ${process.versions.zlib ?? "unknown"}`,
          executable_sha256: null,
          exit_code: null,
          effects: ["read"],
        });
        this.#observations.push(
          "Gzip members are decoded in process in order as one stream; concatenated members are joined.",
        );
        this.#gunzip = gunzip;
        this.#decoded = gunzip;
        return gunzip;
      }
      case "xz":
        return this.#external(
          "xz",
          ["--decompress", "--stdout"],
          handle,
          signal,
        );
      case "iso":
      case "7z": {
        if (this.format === "iso")
          await this.#validateIso(handle, size, signal);
        const header =
          this.format === "7z"
            ? await observeSevenZipHeader(handle, size)
            : null;
        if (header?.kind === "encrypted") {
          this.#omissions.push(
            `7z archive headers are encrypted (coders ${header.coderIds.join(", ")}); member names and sizes are not visible and no password was attempted.`,
          );
          return null;
        }
        if (header?.kind === "empty") {
          this.#observations.push(
            "7z archive declares an empty next header: it has no members.",
          );
          return null;
        }
        // -P keeps absolute and `..` names exactly so path validation sees them.
        return this.#external(
          "bsdtar",
          ["-c", "-f", "-", "--format", "pax", "-P", `@${this.#path}`],
          undefined,
          signal,
        );
      }
      case "deb":
      case "rpm":
        return this.#linuxPayload(handle, size, this.format, signal);
    }
  }

  /** libarchive can silently accept a truncated ISO as empty; validate its declared extent first. */
  async #validateIso(
    handle: FileHandle,
    size: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const descriptor = Buffer.alloc(2048);
    for (
      let offset = ISO_DESCRIPTOR_OFFSET;
      offset + descriptor.length <= size;
      offset += descriptor.length
    ) {
      abortIfNeeded(signal);
      if (
        offset - ISO_DESCRIPTOR_OFFSET + descriptor.length >
        this.#policy.maximumDecodedBytes
      )
        throw new ArtifactReaderFailure(
          "limit",
          "ISO volume descriptors exceed the archive byte limit",
        );
      const read = await handle.read(descriptor, 0, descriptor.length, offset);
      if (
        read.bytesRead !== descriptor.length ||
        descriptor.toString("ascii", 1, 6) !== "CD001" ||
        descriptor[6] !== 1
      )
        break;
      if (descriptor[0] === 255) break;
      if (descriptor[0] !== 1) continue;
      const blocks = descriptor.readUInt32LE(80);
      const blockSize = descriptor.readUInt16LE(128);
      if (
        blocks !== descriptor.readUInt32BE(84) ||
        blockSize !== descriptor.readUInt16BE(130) ||
        ![512, 1024, 2048].includes(blockSize) ||
        blocks * blockSize < offset + descriptor.length ||
        blocks * blockSize > size
      )
        throw new ArtifactReaderFailure(
          "format",
          "ISO volume extent is invalid or truncated",
        );
      return;
    }
    throw new ArtifactReaderFailure(
      "format",
      "ISO primary volume descriptor is missing or truncated",
    );
  }

  /** Decode the installable payload of a .deb (data.tar.*) or .rpm (cpio); nothing in the package runs. */
  async #linuxPayload(
    handle: FileHandle,
    size: number,
    format: "deb" | "rpm",
    signal?: AbortSignal,
  ): Promise<Readable | null> {
    let located: Awaited<ReturnType<typeof locateLinuxPayload>>;
    try {
      located = await locateLinuxPayload(handle, size, format);
    } catch (cause: unknown) {
      throw new ArtifactReaderFailure(
        "format",
        `${STREAM_LABEL[format]} headers are malformed: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }
    if ("omission" in located) {
      this.#omissions.push(located.omission);
      return null;
    }
    this.#linux = located;
    this.#observations.push(...located.observations);
    const range = { handle, start: located.start, end: located.end };
    const raw = (): Readable =>
      readOwnedHandle(handle, located.start, located.end);
    switch (located.compression) {
      case "none":
        this.#decoded = raw();
        return this.#decoded;
      case "gzip": {
        const gunzip = createGunzip();
        pipeline(raw(), gunzip, () => undefined);
        this.#commands.push({
          tool: "node:zlib",
          arguments: ["gunzip"],
          tool_version: `zlib ${process.versions.zlib ?? "unknown"}`,
          executable_sha256: null,
          exit_code: null,
          effects: ["read"],
        });
        this.#decoded = gunzip;
        return gunzip;
      }
      case "zstd": {
        const zstd = createZstdDecompress();
        pipeline(raw(), zstd, () => undefined);
        this.#commands.push({
          tool: "node:zlib",
          arguments: ["zstdDecompress"],
          tool_version: `zstd ${process.versions.zstd ?? "unknown"}`,
          executable_sha256: null,
          exit_code: null,
          effects: ["read"],
        });
        this.#decoded = zstd;
        return zstd;
      }
      case "xz":
      case "lzma":
        return this.#external(
          "xz",
          [
            "--decompress",
            "--stdout",
            ...(located.compression === "lzma" ? ["--format=lzma"] : []),
          ],
          range,
          signal,
        );
      case "bzip2":
        this.#omissions.push(
          `${STREAM_LABEL[format]} contents were not read: the payload is bzip2-compressed, which this reader does not decode.`,
        );
        return null;
    }
  }

  async #external(
    tool: ArchiveDecoderTool,
    arguments_: readonly string[],
    input:
      | FileHandle
      | {
          readonly handle: FileHandle;
          readonly start: number;
          readonly end: number;
        }
      | undefined,
    signal?: AbortSignal,
  ): Promise<Readable | null> {
    const label = STREAM_LABEL[this.format];
    if (this.#policy.externalDecoders === "deny") {
      this.#omissions.push(
        `${label} members were not read: decoding needs the external ${tool} program, which this surface does not run.`,
      );
      return null;
    }
    const resolved = await resolveArchiveDecoder(tool, signal);
    if (!resolved.ok) {
      this.#omissions.push(
        `${label} members were not read: ${resolved.error.message}`,
      );
      return null;
    }
    const decoder = resolved.value;
    const spawned = await spawnOwnedProviderProcess({
      command: decoder.executable,
      arguments: arguments_,
      runId: randomUUID(),
      hostEnvironment: {},
      env: {
        LC_ALL: process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8",
      },
      ...(input === undefined ? {} : { stdin: "pipe" as const }),
      ...(signal === undefined ? {} : { signal }),
    });
    const supervisor = new ProviderProcessSupervisor(
      {
        ...spawned,
        ownsProcessLifetime: true,
        cleanup:
          spawned.cleanup ??
          (() => cleanupOwnedProcessGroup(spawned.ownership)),
      },
      { captureStdout: false, maxDiagnosticBytes: DIAGNOSTIC_BYTES },
    );
    const stdout = spawned.process.stdout;
    if (stdout === null)
      throw new ArtifactReaderFailure(
        "io",
        `${tool} decoder has no output stream`,
      );
    const owned: DecoderProcess = {
      decoder,
      arguments: arguments_,
      supervisor,
      stdout,
      inputFailure: undefined,
    };
    this.#process = owned;
    const stdin = spawned.process.stdin;
    if (input !== undefined) {
      if (stdin === null || stdin === undefined)
        throw new ArtifactReaderFailure(
          "io",
          `${tool} decoder has no input stream`,
        );
      const source =
        "handle" in input
          ? readOwnedHandle(input.handle, input.start, input.end)
          : readOwnedHandle(input);
      pipeline(source, stdin, (cause) => {
        if (cause !== null && cause !== undefined) owned.inputFailure = cause;
      });
    }
    this.#decoded = stdout;
    return stdout;
  }

  /**
   * zlib stops at zero padding after the last gzip member without reading
   * it; name those bytes so the decoded digest is not mistaken for coverage
   * of the whole file.
   */
  async #observeGzipTail(handle: FileHandle, size: number): Promise<void> {
    const consumed = this.#gunzip?.bytesWritten;
    if (consumed === undefined || consumed >= size) return;
    let nonZero = 0;
    const buffer = Buffer.alloc(64 * 1024);
    for (let position = consumed; position < size;) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, size - position),
        position,
      );
      if (bytesRead === 0) break;
      for (const byte of buffer.subarray(0, bytesRead))
        if (byte !== 0) nonZero += 1;
      position += bytesRead;
    }
    this.#observations.push(
      `${String(size - consumed)} bytes follow the last gzip member, ${String(nonZero)} of them non-zero; they were not decoded or interpreted.`,
    );
  }

  /** Confirm the decoder exited cleanly; its stderr names any failure. */
  async #finishDecoder(): Promise<void> {
    const owned = this.#process;
    if (owned === undefined) return;
    const exited = await owned.supervisor.waitForExit(EXIT_WAIT_MS);
    const snapshot = owned.supervisor.snapshot();
    const exitCode = snapshot.exitCode ?? null;
    this.#commands.push({
      tool: owned.decoder.tool,
      arguments: owned.arguments.map((argument) =>
        argument === `@${this.#path}` ? "@$ARTIFACT" : argument,
      ),
      tool_version: owned.decoder.version,
      executable_sha256: owned.decoder.executableSha256,
      exit_code: exitCode,
      effects: ["read"],
    });
    const stderr = snapshot.stderr.text.trim();
    if (!exited || exitCode !== 0)
      throw new ArtifactReaderFailure(
        this.format === "7z" ? "unavailable" : "format",
        `${owned.decoder.tool} could not decode this ${STREAM_LABEL[this.format]} input (${exited ? `exit ${String(exitCode)}` : "no exit"})${stderr.length === 0 ? "" : `: ${stderr}`}.${this.format === "7z" ? " Encrypted member data, unsupported codecs, and damaged archives are not read; no password was attempted." : ""}`,
      );
    if (owned.inputFailure !== undefined)
      throw new ArtifactReaderFailure(
        "io",
        `${owned.decoder.tool} input could not be streamed: ${owned.inputFailure.message}`,
      );
  }

  async #verifySource(
    handle: FileHandle,
    initial: Awaited<ReturnType<FileHandle["stat"]>>,
  ): Promise<void> {
    const after = await handle.stat();
    const byPath = await lstat(this.#path);
    if (
      !sameRegularFileState(initial, after) ||
      byPath.dev !== initial.dev ||
      byPath.ino !== initial.ino
    )
      throw new ArtifactReaderFailure(
        "integrity",
        `Archive source changed while it was read: ${this.#path}`,
      );
  }

  async #settleCurrent(): Promise<void> {
    const settled = this.#current?.settled;
    if (settled !== undefined) await settled;
    this.#current = undefined;
  }

  async *#payload(
    source: ByteSource,
    handle: FileHandle,
  ): AsyncGenerator<ArtifactEntry> {
    const name = await this.#payloadName(handle);
    this.#observations.push(
      `The decoded ${STREAM_LABEL[this.format]} stream is not a tar archive; it is exposed as one file named ${JSON.stringify(name.value)} (${name.source}).`,
    );
    const metadata: ArtifactEntry = {
      path: name.value,
      kind: "file",
      declaredSize: null,
      compressedSize: null,
      executable: false,
      encrypted: false,
      byteOffset: null,
      declaredIntegrity: null,
      unpacked: false,
      limitations: [],
      adapterKey: "payload",
    };
    this.#current = {
      key: metadata.adapterKey,
      metadata: copyArtifactEntry(metadata),
      data: () => source.take(Number.MAX_SAFE_INTEGER),
      opened: false,
      settled: undefined,
    };
    yield metadata;
  }

  async #payloadName(
    handle: FileHandle,
  ): Promise<{ readonly value: string; readonly source: string }> {
    if (this.format === "gzip") {
      const stored = await gzipStoredName(handle);
      if (stored !== null && isSingleSafeSegment(stored))
        return {
          value: stored,
          source: "the gzip header's original file name",
        };
    }
    const base = basename(this.#path);
    const stripped = base.replace(/\.(?:gz|xz)$/iu, "");
    if (stripped !== base && isSingleSafeSegment(stripped))
      return {
        value: stripped,
        source: "the input name without its compression suffix",
      };
    return { value: "decoded-payload", source: "no stored or derivable name" };
  }

  /** RPM payload members; types other than files, directories and symlinks are omissions. */
  async *#cpioMembers(
    source: ByteSource,
    signal?: AbortSignal,
  ): AsyncGenerator<ArtifactEntry> {
    const lookup = this.#linux?.files ?? (() => null);
    const cpio = new CpioStream(source, lookup);
    let ordinal = 0;
    let dotPrefixed = 0;
    for (;;) {
      await this.#settleCurrent();
      abortIfNeeded(signal);
      const member: CpioMember | null = await cpio.next();
      if (member === null) break;
      ordinal += 1;
      if (member.name === null) {
        this.#omissions.push(
          `Member ${String(ordinal)} has a name that is not valid UTF-8 (bytes ${member.rawNameHex}); it was not listed.`,
        );
        continue;
      }
      // Stripped members take their names from the RPM header, which writes them absolute.
      const stripped =
        member.format === "stripped"
          ? member.name.replace(/^\/+/u, "")
          : member.name.replace(/^(?:\.\/)+/u, "");
      if (stripped !== member.name && member.format !== "stripped")
        dotPrefixed += 1;
      // A stripped member's mode and links come from the header's file list.
      const declared =
        member.fileIndex === null ? null : lookup(member.fileIndex);
      const mode = member.mode ?? declared?.mode ?? null;
      const links = member.nlink ?? declared?.links ?? 1;
      if (mode === null) {
        this.#omissions.push(
          `${JSON.stringify(member.name)} has no recorded file type; it was not listed or materialized.`,
        );
        for await (const piece of cpio.data()) void piece;
        continue;
      }
      const type = mode & 0o170000;
      const special = CPIO_TYPES[type];
      if (special !== undefined) {
        this.#omissions.push(
          `${JSON.stringify(member.name)} is ${special}; it was not listed or materialized.`,
        );
        continue;
      }
      if (type === 0o100000 && links > 1 && member.size === 0) {
        this.#omissions.push(
          `${JSON.stringify(member.name)} is a hard link of inode ${String(member.inode ?? declared?.inode ?? "unknown")} whose bytes are stored with another link; it was not listed separately.`,
        );
        continue;
      }
      let kind: ArtifactEntry["kind"];
      let limitations: string[];
      if (type === 0o040000) {
        kind = "directory";
        limitations = [];
      } else if (type === 0o120000) {
        const pieces: Buffer[] = [];
        let read = 0;
        for await (const piece of cpio.data()) {
          if (read < MAX_LINK_TARGET_BYTES) pieces.push(piece);
          read += piece.length;
        }
        kind = "symlink";
        limitations = [
          `Cpio symbolic link to ${JSON.stringify(Buffer.concat(pieces).subarray(0, MAX_LINK_TARGET_BYTES).toString("utf8"))}; the target was not followed or materialized.`,
        ];
      } else if (type === 0o100000) {
        kind = "file";
        limitations = specialModeLimitations(mode);
      } else {
        this.#omissions.push(
          `${JSON.stringify(member.name)} has an unknown cpio file type 0o${type.toString(8)}; it was not listed or materialized.`,
        );
        continue;
      }
      const metadata: ArtifactEntry = {
        path: stripped,
        kind,
        declaredSize: kind === "file" ? member.size : null,
        compressedSize: null,
        executable: kind === "file" && (mode & 0o111) !== 0,
        encrypted: false,
        byteOffset: null,
        declaredIntegrity: null,
        unpacked: false,
        limitations,
        adapterKey: String(ordinal),
      };
      this.#current = {
        key: metadata.adapterKey,
        metadata: copyArtifactEntry(metadata),
        data: () => cpio.data(),
        opened: false,
        settled: undefined,
      };
      yield metadata;
    }
    if (dotPrefixed > 0)
      this.#observations.push(
        `${String(dotPrefixed)} member name(s) began with "./"; that prefix was removed from their logical paths.`,
      );
  }

  async *#tarMembers(
    source: ByteSource,
    signal?: AbortSignal,
  ): AsyncGenerator<ArtifactEntry> {
    const tar = new TarStream(source);
    let ordinal = 0;
    let dotPrefixed = 0;
    let rootEntries = 0;
    let first = true;
    for (;;) {
      await this.#settleCurrent();
      abortIfNeeded(signal);
      const member = await tar.next();
      if (member === null) break;
      if (first) {
        this.#observations.push(
          this.format === "tar"
            ? `Tar first header uses the ${member.profile} profile.`
            : this.format === "7z" || this.format === "iso"
              ? `Member names, kinds, and sizes come from libarchive's pax conversion of the ${STREAM_LABEL[this.format]} archive.`
              : `The decoded ${STREAM_LABEL[this.format]} stream is a tar archive; its first header uses the ${member.profile} profile.`,
        );
        first = false;
      }
      ordinal += 1;
      const described = describeMember(member);
      if (member.name === null) {
        this.#omissions.push(
          `Member ${String(ordinal)} has a name that is not valid UTF-8 (bytes ${member.rawNameHex}); it was not listed.`,
        );
        continue;
      }
      const stripped = member.name.replace(/^(?:\.\/)+/u, "");
      if (stripped !== member.name) dotPrefixed += 1;
      if (stripped === "" || stripped === "." || stripped === "./") {
        if (described.kind === "directory") {
          rootEntries += 1;
          continue;
        }
        // Only a directory can name the root; anything else would hide bytes.
        this.#omissions.push(
          `Member ${String(ordinal)} names the archive root itself (${JSON.stringify(member.name)}) but is not a directory; it was not listed or materialized.`,
        );
        continue;
      }
      if (described.kind === "omitted") {
        this.#omissions.push(
          `${JSON.stringify(member.name)} is ${described.reason}; it was not listed or materialized.`,
        );
        continue;
      }
      const metadata: ArtifactEntry = {
        path: stripped,
        kind: described.kind,
        declaredSize: described.kind === "file" ? member.size : null,
        compressedSize: null,
        executable:
          described.kind === "file" &&
          member.mode !== null &&
          (member.mode & 0o111) !== 0,
        encrypted: false,
        byteOffset:
          this.format === "tar" && described.kind === "file"
            ? member.dataOffset
            : null,
        declaredIntegrity: null,
        unpacked: false,
        limitations:
          this.format === "deb" && described.kind === "file"
            ? [...described.limitations, ...specialModeLimitations(member.mode)]
            : described.limitations,
        adapterKey: String(ordinal),
      };
      this.#current = {
        key: metadata.adapterKey,
        metadata: copyArtifactEntry(metadata),
        data: () => tar.data(),
        opened: false,
        settled: undefined,
      };
      yield metadata;
    }
    if (dotPrefixed > 0)
      this.#observations.push(
        `${String(dotPrefixed)} member name(s) began with "./"; that prefix was removed from their logical paths.`,
      );
    if (rootEntries > 0)
      this.#observations.push(
        `${String(rootEntries)} member(s) named the archive root itself and were not listed.`,
      );
    const end = tar.end;
    if (end !== undefined) {
      if (end.marker !== "two-zero-blocks")
        this.#observations.push(
          end.marker === "none"
            ? "The tar archive has no end-of-archive marker; it ends at a header boundary."
            : "The tar archive ends with one zero block instead of two.",
        );
      if (end.trailingNonZeroBytes > 0)
        this.#observations.push(
          `${String(end.trailingBytes)} bytes follow the end-of-archive marker, ${String(end.trailingNonZeroBytes)} of them non-zero; they were not interpreted.`,
        );
      if (end.globalPaxHeaders > 0)
        this.#observations.push(
          `${String(end.globalPaxHeaders)} global pax header(s) were read and not applied to member names.`,
        );
    }
  }
}

/** A package's declared setuid/setgid bits are stated, never restored on extraction. */
const specialModeLimitations = (mode: number | null): string[] =>
  mode !== null && (mode & 0o6000) !== 0
    ? [
        `The package declares mode ${(mode & 0o7777).toString(8).padStart(4, "0")} (${(mode & 0o4000) !== 0 ? "setuid" : "setgid"}); only the bytes are materialized, never the mode or owner.`,
      ]
    : [];

const CPIO_TYPES: Readonly<Record<number, string>> = {
  0o020000: "a character device",
  0o060000: "a block device",
  0o010000: "a FIFO",
  0o140000: "a socket",
};

/** Largest symbolic-link target read from cpio data to describe the link. */
const MAX_LINK_TARGET_BYTES = 4096;

const describeMember = (
  member: TarMember,
):
  | {
      readonly kind: "file" | "directory" | "symlink";
      readonly limitations: string[];
    }
  | { readonly kind: "omitted"; readonly reason: string } => {
  if (member.sparse)
    return {
      kind: "omitted",
      reason: "a sparse file, whose holes are not materialized safely here",
    };
  switch (member.typeflag) {
    case "0":
    case "7":
      return { kind: "file", limitations: [] };
    case "5":
      return { kind: "directory", limitations: [] };
    case "2":
      return {
        kind: "symlink",
        limitations: [
          `Tar symbolic link to ${JSON.stringify(member.linkName ?? "")}; the target was not followed or materialized.`,
        ],
      };
    case "1":
      return {
        kind: "symlink",
        limitations: [
          `Tar hard link to ${JSON.stringify(member.linkName ?? "")}; recorded as a link entry, not materialized.`,
        ],
      };
    case "3":
      return { kind: "omitted", reason: "a character device" };
    case "4":
      return { kind: "omitted", reason: "a block device" };
    case "6":
      return { kind: "omitted", reason: "a FIFO" };
    case "V":
      return { kind: "omitted", reason: "a GNU volume label" };
    case "M":
      return {
        kind: "omitted",
        reason:
          "a GNU multi-volume continuation whose earlier volume is missing",
      };
    default:
      return {
        kind: "omitted",
        reason: `an unsupported tar member type ${JSON.stringify(member.typeflag)}`,
      };
  }
};

/**
 * Stream a file through the reader's own handle. Unlike
 * `FileHandle.createReadStream`, destroying this stream (as `pipeline` does
 * when a decoder ends before its input) never closes the handle.
 */
const readOwnedHandle = (
  handle: FileHandle,
  start = 0,
  end = Number.MAX_SAFE_INTEGER,
): Readable =>
  Readable.from(handleChunks(handle, start, end), { objectMode: false });

async function* handleChunks(
  handle: FileHandle,
  start: number,
  end: number,
): AsyncGenerator<Buffer> {
  for (let position = start; position < end;) {
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, end - position));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) return;
    position += bytesRead;
    yield buffer.subarray(0, bytesRead);
  }
}

/** Meter decoded bytes: digest, byte budget, cancellation, typed failures. */
async function* meter(
  stream: Readable,
  state: { bytes: number; readonly hash: Hash },
  maximum: number,
  format: ReadableArchiveStreamFormat,
  signal?: AbortSignal,
): AsyncGenerator<Buffer> {
  try {
    for await (const raw of stream) {
      abortIfNeeded(signal);
      const chunk = streamChunkToBuffer(raw);
      state.bytes += chunk.length;
      if (state.bytes > maximum)
        throw new ArtifactReaderFailure(
          "limit",
          `${STREAM_LABEL[format]} input decodes to more than the ${String(maximum)}-byte budget; reading stopped there`,
        );
      state.hash.update(chunk);
      yield chunk;
    }
  } catch (cause: unknown) {
    if (signal?.aborted === true) throw cancelled();
    if (cause instanceof ArtifactReaderFailure) throw cause;
    throw new ArtifactReaderFailure(
      "format",
      `${STREAM_LABEL[format]} input could not be decoded: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}

/** RFC 1952 FNAME, ISO-8859-1 and NUL-terminated, when the header declares it. */
const gzipStoredName = async (handle: FileHandle): Promise<string | null> => {
  const header = Buffer.alloc(1024);
  const { bytesRead } = await handle.read(header, 0, header.length, 0);
  const bytes = header.subarray(0, bytesRead);
  const flags = bytes[3] ?? 0;
  if ((flags & 0x08) === 0) return null;
  let offset = 10;
  if ((flags & 0x04) !== 0) {
    if (bytes.length < offset + 2) return null;
    offset += 2 + bytes.readUInt16LE(offset);
  }
  const end = bytes.indexOf(0, offset);
  if (end <= offset) return null;
  return bytes.subarray(offset, end).toString("latin1");
};

const isSingleSafeSegment = (name: string): boolean =>
  name.length > 0 &&
  name !== "." &&
  name !== ".." &&
  !name.includes("/") &&
  !name.includes("\\") &&
  !name.includes("\0");

const cancelled = (): ArtifactReaderFailure =>
  new ArtifactReaderFailure("cancelled", "Archive operation cancelled");

const abortIfNeeded = (signal?: AbortSignal): void => {
  if (signal?.aborted === true) throw cancelled();
};
