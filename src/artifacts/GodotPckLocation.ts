import type { FileHandle } from "node:fs/promises";
import { GODOT_PCK_MAGIC } from "../domain/godotPckFormat.js";
import { ArtifactReaderFailure } from "./ArtifactReader.js";
import { assertArtifactReadActive } from "./ArtifactFileOperation.js";

export interface GodotPckLocation {
  readonly start: number;
  readonly end: number;
  readonly embedded: boolean;
}

/** Positional exact reads preserve short-read, cancellation and I/O semantics. */
export const readPckBytes = async (
  handle: Pick<FileHandle, "read">,
  position: number,
  length: number,
  end: number,
  signal?: AbortSignal,
): Promise<Buffer> => {
  if (
    !Number.isSafeInteger(position) ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    position < 0 ||
    length > end - position
  )
    throw new ArtifactReaderFailure(
      "format",
      "Godot PCK read exceeds its source range",
    );
  const buffer = Buffer.alloc(length);
  let consumed = 0;
  while (consumed < length) {
    assertArtifactReadActive(signal);
    const { bytesRead } = await handle.read(
      buffer,
      consumed,
      length - consumed,
      position + consumed,
    );
    assertArtifactReadActive(signal);
    if (bytesRead === 0)
      throw new ArtifactReaderFailure(
        "format",
        "Godot PCK source is truncated",
      );
    consumed += bytesRead;
  }
  return buffer;
};

/** Recognize a standalone header or the exact engine trailer; never scan payloads. */
export const locateGodotPck = async (
  handle: Pick<FileHandle, "read">,
  size: number,
  signal?: AbortSignal,
  prefix?: Uint8Array,
): Promise<GodotPckLocation | undefined> => {
  assertArtifactReadActive(signal);
  if (!Number.isSafeInteger(size) || size < 4) return undefined;
  const magic =
    prefix !== undefined && prefix.length >= 4
      ? Buffer.from(prefix.buffer, prefix.byteOffset, 4)
      : await readPckBytes(handle, 0, 4, size, signal);
  if (magic.readUInt32LE(0) === GODOT_PCK_MAGIC)
    return { start: 0, end: size, embedded: false };
  if (size < 12) return undefined;
  const trailer = await readPckBytes(handle, size - 12, 12, size, signal);
  if (trailer.readUInt32LE(8) !== GODOT_PCK_MAGIC) return undefined;
  const end = size - 12;
  const bytes = trailer.readBigUInt64LE(0);
  if (bytes < 4n || bytes > BigInt(end))
    throw new ArtifactReaderFailure(
      "format",
      "Godot PCK trailer declares an invalid pack range",
    );
  const start = end - Number(bytes);
  if (
    (await readPckBytes(handle, start, 4, end, signal)).readUInt32LE(0) !==
    GODOT_PCK_MAGIC
  )
    throw new ArtifactReaderFailure(
      "format",
      "Godot PCK trailer does not point at a pack header",
    );
  return { start, end, embedded: true };
};
