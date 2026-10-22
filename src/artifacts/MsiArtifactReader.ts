import type { FileHandle } from "node:fs/promises";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";

import type { ArtifactCommand } from "../domain/artifactGraph.js";
import {
  NonRegularFileReadError,
  openRegularFile,
  sameRegularFileState,
} from "../filesystem/RegularFile.js";
import {
  CabUnsupportedError,
  Cabinet,
  type CabFile,
} from "../windowsInstaller/cab.js";
import { CompoundFile, type CfbEntry } from "../windowsInstaller/cfb.js";
import { MsiDatabase } from "../windowsInstaller/msi/database.js";
import { msiFacts } from "../windowsInstaller/msi/facts.js";
import {
  ArtifactReaderFailure,
  copyArtifactEntry,
  type ArtifactEntry,
  type ArtifactReader,
} from "./ArtifactReader.js";

/** Largest embedded cabinet or Binary stream read into memory for one listing. */
const MAX_STREAM_BYTES = 2 * 1024 ** 3;

const positional =
  (handle: FileHandle) =>
  async (offset: number, length: number): Promise<Uint8Array> => {
    const buffer = Buffer.alloc(length);
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await handle.read(
        buffer,
        filled,
        length - filled,
        offset + filled,
      );
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return buffer.subarray(0, filled);
  };

const inMemory =
  (bytes: Uint8Array) =>
  (offset: number, length: number): Promise<Uint8Array> =>
    Promise.resolve(
      bytes.subarray(
        Math.min(bytes.length, offset),
        Math.min(bytes.length, offset + length),
      ),
    );

const abortIfNeeded = (signal?: AbortSignal): void => {
  if (signal?.aborted === true)
    throw new ArtifactReaderFailure(
      "cancelled",
      "Windows Installer read was cancelled",
    );
};

type Source =
  | {
      readonly kind: "cabinet";
      readonly cabinet: Cabinet;
      readonly file: CabFile;
    }
  | { readonly kind: "stream"; readonly entry: CfbEntry };

/**
 * A Windows Installer database as a container: the files its File table
 * installs, read from embedded cabinets and laid out at their resolved
 * target directories, plus the Binary table streams custom actions load.
 * Nothing is installed and no custom action runs; external cabinets are not
 * searched for (inspect_windows_installer takes them as explicit companions).
 */
export class MsiArtifactReader implements ArtifactReader {
  readonly format = "msi" as const;
  readonly #path: string;
  #handle: FileHandle | undefined;
  #compound: CompoundFile | undefined;
  readonly #sources = new Map<string, Source>();
  readonly #observations: string[] = [];
  readonly #omissions: string[] = [];

  constructor(path: string) {
    this.#path = path;
  }

  observations(): readonly string[] {
    return [...this.#observations];
  }

  omissions(): readonly string[] {
    return [...this.#omissions];
  }

  provenance(): readonly ArtifactCommand[] {
    return [];
  }

  async *entries(signal?: AbortSignal): AsyncIterable<ArtifactEntry> {
    abortIfNeeded(signal);
    let handle: FileHandle;
    try {
      handle = await openRegularFile(this.#path, {
        symlinks: "reject",
        signal,
      });
    } catch (cause: unknown) {
      if (cause instanceof NonRegularFileReadError)
        throw new ArtifactReaderFailure(
          "format",
          `Installer source is not a regular file: ${this.#path}`,
          { cause },
        );
      throw cause;
    }
    this.#handle = handle;
    const initial = await handle.stat();
    let facts: ReturnType<typeof msiFacts>;
    let compound: CompoundFile;
    let database: MsiDatabase;
    try {
      compound = await CompoundFile.open(positional(handle), initial.size);
      database = await MsiDatabase.open(compound);
      facts = msiFacts(database);
    } catch (cause: unknown) {
      throw new ArtifactReaderFailure(
        "format",
        `Windows Installer database is malformed: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }
    this.#compound = compound;
    this.#observations.push(
      `Windows Installer database (compound file version ${String(compound.version)}): ${String(facts.files.length)} files in the File table, laid out at their resolved target directories; the database was read in process and nothing was installed.`,
      ...facts.problems,
    );
    // Stream names are stored in MSI's packed encoding; the database decodes them.
    const streams = new Map(
      database.streams.map((stream) => [stream.name, stream.entry]),
    );
    const cabinets = new Map<string, Cabinet | null>();
    const cabinetFor = async (name: string): Promise<Cabinet | null> => {
      if (cabinets.has(name)) return cabinets.get(name) ?? null;
      const entry = streams.get(name);
      let cabinet: Cabinet | null = null;
      if (entry !== undefined) {
        const bytes = await compound.read(entry, MAX_STREAM_BYTES);
        try {
          cabinet = await Cabinet.open(inMemory(bytes), bytes.length);
          this.#observations.push(
            ...cabinet.problems.map((problem) => `${name}: ${problem}`),
          );
        } catch (cause: unknown) {
          this.#omissions.push(
            `Embedded cabinet ${name} could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
        }
      }
      cabinets.set(name, cabinet);
      return cabinet;
    };
    const used = new Set<string>();
    let ordinal = 0;
    for (const file of facts.files) {
      abortIfNeeded(signal);
      const media = file.media;
      if (media === null) {
        this.#omissions.push(
          `${file.target_path} (File ${file.key}) has no Media row covering its sequence; its bytes were not located.`,
        );
        continue;
      }
      if (media.cabinet === null || !media.embedded) {
        this.#omissions.push(
          media.cabinet === null
            ? `${file.target_path} (File ${file.key}) is stored uncompressed beside the package on disk ${String(media.disk_id)}; it is not inside this file.`
            : `${file.target_path} (File ${file.key}) is in the external cabinet ${media.cabinet}, which is not searched for; pass it to inspect_windows_installer as a companion.`,
        );
        continue;
      }
      const cabinet = await cabinetFor(media.cabinet);
      const member = cabinet?.files.find((entry) => entry.name === file.key);
      if (cabinet === null || member === undefined) {
        this.#omissions.push(
          `${file.target_path} (File ${file.key}) is not in the embedded cabinet ${media.cabinet}.`,
        );
        continue;
      }
      if (used.has(file.target_path)) {
        this.#omissions.push(
          `${file.target_path} is installed by more than one File row (File ${file.key}); only the first is listed.`,
        );
        continue;
      }
      used.add(file.target_path);
      ordinal += 1;
      const metadata: ArtifactEntry = {
        path: file.target_path,
        kind: "file",
        declaredSize: member.size,
        compressedSize: null,
        executable: false,
        encrypted: false,
        byteOffset: null,
        // MsiFileHash is the file's declared MD5; the artifact graph checks it.
        declaredIntegrity:
          file.hash === null
            ? null
            : { algorithm: "md5" as const, digest: file.hash.md5 },
        unpacked: false,
        limitations: [
          `Installed by component ${file.component}; File key ${file.key}, cabinet ${media.cabinet}.`,
        ],
        adapterKey: String(ordinal),
      };
      this.#sources.set(metadata.adapterKey, {
        kind: "cabinet",
        cabinet,
        file: member,
      });
      yield copyArtifactEntry(metadata);
    }
    for (const binary of facts.binaries) {
      const entry = streams.get(binary.stream);
      if (entry === undefined) {
        this.#omissions.push(
          `Binary ${binary.name} names stream ${binary.stream}, which the database does not hold.`,
        );
        continue;
      }
      ordinal += 1;
      const metadata: ArtifactEntry = {
        path: `Binary/${binary.name}`,
        kind: "file",
        declaredSize: entry.size,
        compressedSize: null,
        executable: false,
        encrypted: false,
        byteOffset: null,
        declaredIntegrity: null,
        unpacked: false,
        limitations: [
          "A Binary table stream (custom action code or data); it is listed as bytes and never run.",
        ],
        adapterKey: String(ordinal),
      };
      this.#sources.set(metadata.adapterKey, { kind: "stream", entry });
      yield copyArtifactEntry(metadata);
    }
    const [opened, current] = await Promise.all([
      handle.stat(),
      stat(this.#path),
    ]);
    if (
      !sameRegularFileState(initial, opened) ||
      !sameRegularFileState(initial, current)
    )
      throw new ArtifactReaderFailure(
        "integrity",
        `Installer changed while it was read: ${this.#path}`,
      );
  }

  open(entry: ArtifactEntry, signal?: AbortSignal): Promise<Readable> {
    const source = this.#sources.get(entry.adapterKey);
    const compound = this.#compound;
    if (source === undefined || compound === undefined)
      return Promise.reject(
        new ArtifactReaderFailure(
          "integrity",
          `Installer member is not one this reader listed: ${entry.path}`,
        ),
      );
    const declared = entry.declaredSize ?? 0;
    const bounded = async function* (): AsyncGenerator<Buffer> {
      let total = 0;
      try {
        const pieces =
          source.kind === "cabinet"
            ? source.cabinet.read(
                source.file,
                source.cabinet.decodedBytes(source.file),
                signal,
              )
            : compound.stream(source.entry);
        for await (const piece of pieces) {
          abortIfNeeded(signal);
          total += piece.length;
          if (total > declared)
            throw new ArtifactReaderFailure(
              "integrity",
              `${entry.path} yielded more than its declared ${String(declared)} bytes`,
            );
          yield Buffer.from(piece.buffer, piece.byteOffset, piece.byteLength);
        }
      } catch (cause: unknown) {
        if (cause instanceof CabUnsupportedError)
          throw new ArtifactReaderFailure(
            "unavailable",
            `${entry.path}: ${cause.message}`,
            { cause },
          );
        throw cause;
      }
    };
    return Promise.resolve(Readable.from(bounded(), { objectMode: false }));
  }

  async close(): Promise<void> {
    const handle = this.#handle;
    this.#handle = undefined;
    this.#compound = undefined;
    await handle?.close();
  }
}
