import type { FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import type { DesktopFile, DesktopFact } from "../domain/desktopApplication.js";
import { jsonValueByteLength } from "../domain/jsonValueByteLength.js";
import { IL2CPP_METADATA_MAGIC } from "../domain/il2cpp/il2cppMetadata.js";
import { parsePeRecord, peRvaToFileOffset } from "../domain/binaryTarget.js";
import { readManagedMetadataLayout } from "../dotnet/ManagedMetadataLayout.js";
import { readAssemblyReferenceName } from "../dotnet/ManagedMetadataInventoryRows.js";
import { ManagedReaderFailure } from "../dotnet/ManagedReaderFailure.js";
import { ArtifactReaderFailure } from "./ArtifactReader.js";
import { abortIfNeeded } from "./ArtifactHash.js";
import { hasMachoMagic } from "./apple/MachoLoadCommandReader.js";

export interface DesktopReadBudget {
  bytes: number;
  readonly maximum: number;
  retainedBytes: number;
  readonly maximumRetainedBytes: number;
}

/** A resource refusal is separate from malformed format declarations. */
class DesktopProbeLimit extends ArtifactReaderFailure {
  constructor() {
    super("limit", "Directory probe byte budget exhausted", {
      boundary: "capacity",
    });
  }
}

/** Inspect selected ranges on an already admitted descriptor; never hash payloads. */
export const inspectDesktopFile = async (
  file: FileHandle,
  row: DesktopFile,
  budget: DesktopReadBudget,
  signal?: AbortSignal,
  unityManagedDirectory: string | null = null,
): Promise<void> => {
  const size = row.bytes;
  if (size === null)
    throw new ArtifactReaderFailure(
      "limit",
      "File extent exceeds exact host offsets",
      { boundary: "file-size" },
    );
  const read = async (offset: number, bytes: number): Promise<Buffer> => {
    abortIfNeeded(signal);
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      offset > size ||
      bytes > size - offset
    )
      throw new ArtifactReaderFailure(
        "format",
        "Declared byte range lies outside the file",
      );
    if (bytes > budget.maximum - budget.bytes) throw new DesktopProbeLimit();
    const result = Buffer.alloc(bytes);
    let consumed = 0;
    while (consumed < bytes) {
      abortIfNeeded(signal);
      const part = await file.read(
        result,
        consumed,
        bytes - consumed,
        offset + consumed,
      );
      budget.bytes += part.bytesRead;
      if (part.bytesRead === 0)
        throw new ArtifactReaderFailure(
          "integrity",
          "File ended before its observed extent",
        );
      consumed += part.bytesRead;
    }
    abortIfNeeded(signal);
    row.ranges.push({
      offset,
      bytes,
      sha256: createHash("sha256").update(result).digest("hex"),
    });
    return result;
  };
  const fact = (observation: DesktopFact) => {
    const remaining = budget.maximumRetainedBytes - budget.retainedBytes;
    const reservation =
      512 + jsonValueByteLength(observation.value, (remaining - 512) / 12) * 12;
    if (reservation > budget.maximumRetainedBytes - budget.retainedBytes)
      throw new ArtifactReaderFailure(
        "limit",
        "Directory facts reached the retained metadata budget",
        { boundary: "memory" },
      );
    budget.retainedBytes += reservation;
    row.facts.push(observation);
  };
  const prefix = await read(0, Math.min(size, 64));
  if (prefix.length >= 8 && prefix.readUInt32LE(0) === IL2CPP_METADATA_MAGIC)
    fact({
      kind: "il2cpp-metadata-header",
      offset: 0,
      value: {
        magic: "0xfab11baf",
        raw_version: prefix.readUInt32LE(4),
      },
    });
  if (prefix.length >= 20 && prefix.toString("latin1", 0, 4) === "GDPC")
    fact({
      kind: "godot-pck-header",
      offset: 0,
      value: {
        pack_version: prefix.readUInt32LE(4),
        engine_version: [
          prefix.readUInt32LE(8),
          prefix.readUInt32LE(12),
          prefix.readUInt32LE(16),
        ],
        placement: "standalone",
      },
    });
  if (
    prefix.length >= 16 &&
    prefix.toString("latin1", 0, 4) === "FORM" &&
    prefix.toString("latin1", 8, 12) === "GEN8"
  ) {
    const containerBytes = prefix.readUInt32LE(4);
    const chunkBytes = prefix.readUInt32LE(12);
    if (
      containerBytes >= 8 &&
      containerBytes <= size - 8 &&
      chunkBytes <= containerBytes - 8
    )
      fact({
        kind: "gamemaker-form-header",
        offset: 0,
        value: {
          container: "FORM",
          first_chunk: "GEN8",
        },
      });
  }
  if (
    prefix.length >= 16 &&
    prefix.toString("latin1", 0, 16) === "-==--==--==--==-"
  )
    fact({
      kind: "unreal-container-convention",
      offset: 0,
      value: { format: "IoStore TOC" },
    });
  const native =
    prefix.length >= 4 &&
    (prefix.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
      hasMachoMagic(prefix));
  if (native)
    fact({
      kind: "native-image-header",
      offset: 0,
      value: {
        format: prefix[0] === 0x7f ? "elf" : "mach-o",
        signature: prefix.subarray(0, 4).toString("hex"),
      },
    });
  const observe = async (operation: () => Promise<void>) => {
    try {
      await operation();
    } catch (cause: unknown) {
      if (
        !(cause instanceof ArtifactReaderFailure) ||
        (cause.reason !== "format" && cause.reason !== "limit")
      )
        throw cause;
      if (!row.issues.includes(cause.message)) row.issues.push(cause.message);
    }
  };
  if (prefix.length === 64 && prefix.readUInt16LE(0) === 0x5a4d)
    await observe(() =>
      inspectPeFile(prefix, row, read, fact, unityManagedDirectory, signal),
    );
  if (
    (native || (prefix.length >= 2 && prefix.readUInt16LE(0) === 0x5a4d)) &&
    size >= 12
  )
    await observe(() => inspectPckTrailer(size, read, fact));
};

type DesktopByteRead = (offset: number, bytes: number) => Promise<Buffer>;
type RecordDesktopFact = (observation: DesktopFact) => void;

const inspectPeFile = async (
  prefix: Buffer,
  row: DesktopFile,
  read: DesktopByteRead,
  fact: RecordDesktopFact,
  unityManagedDirectory: string | null,
  signal?: AbortSignal,
): Promise<void> => {
  const peOffset = prefix.readUInt32LE(0x3c);
  const coff = await read(peOffset, 24);
  if (coff.toString("latin1", 0, 4) !== "PE\0\0") return;
  const optionalSize = coff.readUInt16LE(20);
  if (optionalSize > 4096)
    throw new ArtifactReaderFailure(
      "format",
      "PE optional header exceeds the supported format bound",
    );
  const optional = await read(peOffset + 24, optionalSize);
  const parsed = parsePeRecord(Buffer.concat([coff, optional]), undefined);
  if (!parsed.ok) {
    row.issues.push(parsed.error);
    return;
  }
  if (parsed.value.format !== "pe") return;
  fact({
    kind: "native-image-header",
    offset: peOffset,
    value: { format: "pe", machine: coff.readUInt16LE(4) },
  });
  if (!parsed.value.managed) return;
  const directories = optional.readUInt16LE(0) === 0x20b ? 112 : 96;
  const cliRva = optional.readUInt32LE(directories + 14 * 8);
  const cliSize = optional.readUInt32LE(directories + 14 * 8 + 4);
  fact({
    kind: "pe-cli-directory",
    offset: peOffset + 24 + directories + 14 * 8,
    value: { rva: cliRva, bytes: cliSize },
  });
  if (unityManagedDirectory === null) return;
  const sectionCount = coff.readUInt16LE(6);
  const sections = await read(peOffset + 24 + optionalSize, sectionCount * 40);
  const mapped = (rva: number, bytes: number) =>
    peRvaToFileOffset(
      rva,
      sections,
      sectionCount,
      optional.readUInt32LE(60),
      bytes,
    );
  const cliOffset = mapped(cliRva, 16);
  if (cliOffset === undefined || cliSize < 72)
    throw new ArtifactReaderFailure(
      "format",
      "CLI metadata directory cannot be mapped",
    );
  const cli = await read(cliOffset, 16);
  if (cli.readUInt32LE(0) < 72)
    throw new ArtifactReaderFailure(
      "format",
      "CLI header declares a truncated runtime header",
    );
  const metadataBytes = cli.readUInt32LE(12);
  const metadataOffset = mapped(cli.readUInt32LE(8), metadataBytes);
  if (metadataOffset === undefined)
    throw new ArtifactReaderFailure(
      "format",
      "CLI metadata range cannot be mapped",
    );
  const bytes = await read(metadataOffset, metadataBytes);
  try {
    const layout = readManagedMetadataLayout(bytes, 0, bytes.length);
    const refs = layout.table(35);
    for (let index = 1; index <= (refs?.rowCount ?? 0); index++) {
      // Yield between bounded batches so metadata names cannot monopolize MCP.
      if ((index - 1) % 256 === 0) {
        await setImmediate();
        abortIfNeeded(signal);
      }
      const reference = readAssemblyReferenceName(
        bytes,
        layout,
        index,
        layout.strings.size,
      );
      if (
        reference.name !== "UnityEngine" &&
        !reference.name.startsWith("UnityEngine.")
      )
        continue;
      fact({
        kind: "unity-assembly-reference",
        offset: metadataOffset + reference.row_offset,
        value: {
          name: reference.name,
          token: reference.token,
          managed_directory: unityManagedDirectory,
        },
      });
      return;
    }
  } catch (cause: unknown) {
    if (!(cause instanceof ManagedReaderFailure)) throw cause;
    throw new ArtifactReaderFailure(
      cause.issue.code === "resource-limit" ? "limit" : "format",
      cause.message,
      {
        cause,
        ...(cause.issue.code === "resource-limit"
          ? { boundary: "memory" as const }
          : {}),
      },
    );
  }
};

const inspectPckTrailer = async (
  size: number,
  read: DesktopByteRead,
  fact: RecordDesktopFact,
): Promise<void> => {
  const trailer = await read(size - 12, 12);
  if (trailer.toString("latin1", 8, 12) === "GDPC") {
    const packSize = trailer.readBigUInt64LE(0);
    if (packSize < 20n || packSize > BigInt(size - 12))
      throw new ArtifactReaderFailure(
        "format",
        "Embedded PCK trailer declares an invalid pack extent",
      );
    const offset = size - 12 - Number(packSize);
    const header = await read(offset, 20);
    if (header.toString("latin1", 0, 4) !== "GDPC")
      throw new ArtifactReaderFailure(
        "format",
        "Embedded PCK trailer does not locate a pack header",
      );
    fact({
      kind: "godot-pck-header",
      offset,
      value: {
        pack_version: header.readUInt32LE(4),
        engine_version: [
          header.readUInt32LE(8),
          header.readUInt32LE(12),
          header.readUInt32LE(16),
        ],
        placement: "embedded-trailer",
      },
    });
  }
};
