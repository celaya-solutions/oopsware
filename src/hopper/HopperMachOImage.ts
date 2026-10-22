import { createHash } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";
import { z } from "zod";

import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import { BinaryTargetError } from "../domain/configurationErrors.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import {
  readFatSliceDeclarations,
  validateFatSlice,
  type FatSliceDeclaration,
} from "../domain/apple/machoContainer.js";
import { machoCpuSubtypeBase } from "../domain/apple/machoCpuIdentity.js";
import type { HeaderArchitecture } from "../domain/binaryTargetTypes.js";
import {
  HopperCancelledError,
  HopperStartError,
} from "../domain/hopperErrors.js";
import { err, ok, type Result } from "../domain/result.js";

/** Stable source coordinates committed before preparing an owned thin image. */
export const hopperMachOImageSchema = z.strictObject({
  method: z.union([
    z.literal("fat32_thin_slice"),
    z.literal("fat64_thin_slice"),
  ]),
  architecture_count: z.number().int().min(1).max(128),
  container_table_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  source_offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  byte_length: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  cpu_type: z.number().int().nonnegative(),
  cpu_subtype: z.number().int().nonnegative(),
});

export type HopperMachOImage = z.infer<typeof hopperMachOImageSchema>;

/** Validate the selected FAT slice without depending on Apple's lipo tool. */
export const resolveHopperMachOImage = async (
  target: BinaryTarget & { readonly kind: "executable" },
  signal?: AbortSignal,
): Promise<
  Result<HopperMachOImage, BinaryTargetError | AnalysisCancelledError>
> => {
  const invalid = (reason: string, cause?: unknown) =>
    err(
      new BinaryTargetError(
        target.path,
        reason,
        cause === undefined ? undefined : { cause },
      ),
    );
  if (signal?.aborted) return err(new AnalysisCancelledError("open_binary"));
  if (target.format !== "mach-o" && target.format !== "mach-o-universal")
    return invalid("Hopper FAT image preparation requires a Mach-O target");
  let file: FileHandle;
  try {
    file = await open(target.path, "r");
  } catch (cause: unknown) {
    // Keep the OS error so a read-permission denial reports access_denied.
    return invalid(
      `Cannot read FAT source for Hopper image preparation: ${cause instanceof Error ? cause.message : String(cause)}`,
      cause,
    );
  }
  try {
    const read = async (offset: number, length: number): Promise<Buffer> => {
      const bytes = Buffer.alloc(length);
      const { bytesRead } = await file.read(bytes, 0, length, offset);
      return bytes.subarray(0, bytesRead);
    };
    const header = await read(0, 8);
    const magic = header.length === 8 ? header.readUInt32BE(0) : 0;
    const isFatMagic = [
      0xcafebabe, 0xcafebabf, 0xbebafeca, 0xbfbafeca,
    ].includes(magic);
    if (!isFatMagic)
      return invalid(
        "FAT source header changed before Hopper image preparation",
      );
    const wide = magic === 0xcafebabf || magic === 0xbfbafeca;
    const littleEndian = magic === 0xbebafeca || magic === 0xbfbafeca;
    const entrySize = wide ? 32 : 20;
    const count = littleEndian
      ? header.readUInt32LE(4)
      : header.readUInt32BE(4);
    const size = (await file.stat()).size;
    const tableEnd = 8 + count * entrySize;
    if (count === 0 || count > 128 || tableEnd > size)
      return invalid(
        "FAT architecture table is truncated or exceeds the supported 128 entries",
      );
    const table = await read(8, count * entrySize);
    const parsed = readFatSliceDeclarations(table, {
      count,
      wide,
      littleEndian,
    });
    if (parsed.status === "malformed") return invalid(parsed.reason);
    const cpuTypes = { x86: 7, x86_64: 0x1000007, arm: 12, arm64: 0x100000c };
    const matches = [];
    const ranges = [];
    for (const slice of parsed.slices) {
      if (signal?.aborted)
        return err(new AnalysisCancelledError("open_binary"));
      const rangeError = validateFatSlice(slice, size, tableEnd);
      if (rangeError !== null) return invalid(rangeError);
      if (wide) {
        const reserved = littleEndian
          ? table.readUInt32LE(slice.index * 32 + 28)
          : table.readUInt32BE(slice.index * 32 + 28);
        if (reserved !== 0)
          return invalid(
            `FAT64 architecture ${slice.index} has a nonzero reserved field`,
          );
      }
      if (slice.size < 12)
        return invalid(
          `FAT architecture ${slice.index} has a truncated Mach-O header`,
        );
      const embedded = await read(slice.offset, 12);
      if (embedded.length !== 12)
        return invalid(`FAT architecture ${slice.index} became truncated`);
      const thinMagic = embedded.readUInt32BE(0);
      if (![0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(thinMagic))
        return invalid(
          `FAT architecture ${slice.index} does not contain a Mach-O image`,
        );
      const little = thinMagic === 0xcefaedfe || thinMagic === 0xcffaedfe;
      const identity = {
        cpuType: little ? embedded.readUInt32LE(4) : embedded.readUInt32BE(4),
        cpuSubtype: little
          ? embedded.readUInt32LE(8)
          : embedded.readUInt32BE(8),
      };
      const identityError = validateFatSlice(slice, size, tableEnd, identity);
      if (identityError !== null) return invalid(identityError);
      ranges.push(slice);
      if (slice.cpuType === cpuTypes[target.architecture]) matches.push(slice);
    }
    ranges.sort((a, b) => a.offset - b.offset);
    for (let index = 1; index < ranges.length; index++) {
      const previous = ranges[index - 1];
      const current = ranges[index];
      if (
        previous !== undefined &&
        current !== undefined &&
        current.offset < previous.offset + previous.size
      )
        return invalid("FAT slices overlap");
    }
    const selected = selectHopperSlice(matches, target.architecture);
    if (selected === undefined)
      return invalid(
        `FAT selection for ${target.architecture} is ${matches.length === 0 ? "missing" : "ambiguous"}; extract the exact architecture into a thin image before opening it`,
      );
    return ok({
      method: wide ? "fat64_thin_slice" : "fat32_thin_slice",
      architecture_count: count,
      container_table_sha256: createHash("sha256")
        .update(header)
        .update(table)
        .digest("hex"),
      source_offset: selected.offset,
      byte_length: selected.size,
      cpu_type: selected.cpuType,
      cpu_subtype: selected.cpuSubtype,
    });
  } catch (cause: unknown) {
    return invalid(
      `Cannot validate FAT image: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  } finally {
    await file.close();
  }
};

/**
 * Plain arm64 (cpusubtype 0) and arm64e (cpusubtype 2) function-entry encodings
 * decode under Hopper's --aarch64; Apple's arm64e.x1 variant (cpusubtype 12)
 * does not, so it is selected only when it is the arm64 family's only candidate.
 * Every other ambiguity stays fail-closed.
 */
const selectHopperSlice = (
  matches: readonly FatSliceDeclaration[],
  architecture: HeaderArchitecture,
): FatSliceDeclaration | undefined => {
  if (matches.length === 1) return matches[0];
  if (architecture !== "arm64") return undefined;
  for (const cpuSubtype of [0, 2]) {
    const preferred = matches.filter(
      (slice) => machoCpuSubtypeBase(slice.cpuSubtype) === cpuSubtype,
    );
    if (preferred.length === 1) return preferred[0];
    if (preferred.length > 1) return undefined;
  }
  return undefined;
};

/** Copy a selected slice and verify the entire original source in the same pass. */
export const prepareHopperMachOImage = async (
  sourcePath: string,
  sourceSha256: string,
  image: HopperMachOImage,
  destination: string,
  signal?: AbortSignal,
): Promise<Result<string, HopperStartError | HopperCancelledError>> => {
  if (signal?.aborted) return err(new HopperCancelledError());
  const tableEntrySize = image.method === "fat64_thin_slice" ? 32 : 20;
  try {
    const source = await open(sourcePath, "r");
    try {
      const output = await open(destination, "wx", 0o600);
      try {
        const hash = createHash("sha256");
        const tableHash = createHash("sha256");
        const tableEnd = 8 + image.architecture_count * tableEntrySize;
        const thinHeader: Buffer[] = [];
        let position = 0;
        let copied = 0;
        for await (const chunk of source.createReadStream({
          autoClose: false,
        })) {
          if (signal?.aborted) return err(new HopperCancelledError());
          const bytes = Buffer.from(chunk);
          hash.update(bytes);
          if (position < tableEnd)
            tableHash.update(
              bytes.subarray(0, Math.min(bytes.length, tableEnd - position)),
            );
          const start = Math.max(0, image.source_offset - position);
          const end = Math.min(
            bytes.length,
            image.source_offset + image.byte_length - position,
          );
          if (end > start) {
            if (copied < 12)
              thinHeader.push(
                bytes.subarray(start, Math.min(end, start + 12 - copied)),
              );
            await output.writeFile(bytes.subarray(start, end));
            copied += end - start;
          }
          position += bytes.length;
        }
        const observed = hash.digest("hex");
        const header = Buffer.concat(thinHeader);
        const magic = header.length === 12 ? header.readUInt32BE(0) : 0;
        const little = magic === 0xcefaedfe || magic === 0xcffaedfe;
        const headerMatches =
          header.length === 12 &&
          [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(magic) &&
          (little ? header.readUInt32LE(4) : header.readUInt32BE(4)) ===
            image.cpu_type &&
          (little ? header.readUInt32LE(8) : header.readUInt32BE(8)) ===
            image.cpu_subtype;
        if (
          tableHash.digest("hex") !== image.container_table_sha256 ||
          !headerMatches
        )
          return err(
            new HopperStartError({
              userMessage: `FAT source ${sourcePath} no longer agrees with its committed architecture table or selected Mach-O header. Open the stable source again.`,
            }),
          );
        if (observed !== sourceSha256 || copied !== image.byte_length)
          return err(
            new HopperStartError({
              userMessage: `FAT source ${sourcePath} changed before launch: expected SHA-256 ${sourceSha256}, observed ${observed}; copied ${copied} of ${image.byte_length} selected bytes. Open the stable source again.`,
            }),
          );
        return ok(destination);
      } finally {
        await output.close();
      }
    } finally {
      await source.close();
    }
  } catch (cause: unknown) {
    return signal?.aborted
      ? err(new HopperCancelledError())
      : err(
          new HopperStartError({
            cause,
            userMessage: `Cannot prepare the selected FAT image from ${sourcePath}: ${cause instanceof Error ? cause.message : String(cause)}`,
          }),
        );
  }
};
