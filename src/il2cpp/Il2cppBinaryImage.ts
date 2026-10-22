import {
  readFatContainerHeader,
  validateFatSlice,
} from "../domain/apple/machoContainer.js";
import {
  GoBinaryFormatFailure,
  GoBinaryResourceFailure,
  mappedFileOffset,
  isZeroFilledSpan,
  type GoBinaryContainer,
} from "../go/GoBinaryContainer.js";
import { readGoBinaryContainer } from "../go/GoBinaryImage.js";
import { applyElfRelativeRelocationsSteps } from "./ElfRelocations.js";
import { Il2cppBinaryFormatFailure } from "./Il2cppBinaryFormat.js";
const MACHO_CPU = new Map([
  [0x01000007, "amd64"],
  [0x0100000c, "arm64"],
]);

/** Select one thin image; a universal Mach-O needs the caller's architecture. */
const selectImage = (
  bytes: Buffer,
  architecture: string | undefined,
): Buffer => {
  const fat = readFatContainerHeader(bytes, bytes.length);
  if (fat.state === "not-fat") {
    if (architecture !== undefined)
      throw new Il2cppBinaryFormatFailure(
        "slice-not-found",
        `architecture ${architecture} was requested but the binary is not a universal Mach-O`,
      );
    return bytes;
  }
  if (fat.state !== "parsed")
    throw new Il2cppBinaryFormatFailure(
      "malformed-container",
      fat.state === "malformed" ? fat.reason : "universal header is truncated",
    );
  const available = fat.slices.map(
    (slice) => MACHO_CPU.get(slice.cpuType) ?? `macho-cpu-${slice.cpuType}`,
  );
  if (architecture === undefined)
    throw new Il2cppBinaryFormatFailure(
      "slice-selection-required",
      `universal Mach-O holds ${available.join(", ")}; select one architecture`,
    );
  if (available.filter((value) => value === architecture).length > 1)
    throw new Il2cppBinaryFormatFailure(
      "ambiguous-slice-selection",
      `multiple universal slices declare ${architecture}; no slice was selected`,
    );
  const index = available.indexOf(architecture);
  const slice = fat.slices[index];
  if (slice === undefined)
    throw new Il2cppBinaryFormatFailure(
      "slice-not-found",
      `universal Mach-O holds ${available.join(", ")}, not ${architecture}`,
    );
  const issue = validateFatSlice(slice, bytes.length, fat.tableEnd);
  if (issue !== null)
    throw new Il2cppBinaryFormatFailure("malformed-container", issue);
  return bytes.subarray(slice.offset, slice.offset + slice.size);
};

export interface NativeImage {
  readonly bytes: Buffer;
  readonly container: GoBinaryContainer;
  readonly imageBase: bigint;
  readonly unresolvedPointerSlots: ReadonlySet<bigint>;
  readonly zeroFillPointers: ReadonlyMap<bigint, bigint>;
}

export function* openImageSteps(
  bytes: Buffer,
  architecture: string | undefined,
): Generator<void, NativeImage> {
  let image = selectImage(bytes, architecture);
  let container: GoBinaryContainer;
  try {
    container = readGoBinaryContainer(image);
  } catch (cause) {
    if (cause instanceof GoBinaryResourceFailure)
      throw new Il2cppBinaryFormatFailure(
        "native-index-capacity",
        cause.message,
      );
    if (cause instanceof GoBinaryFormatFailure)
      throw new Il2cppBinaryFormatFailure(
        cause.kind === "unsupported"
          ? "unsupported-container"
          : "malformed-container",
        cause.message,
      );
    throw cause;
  }
  if (
    architecture !== undefined &&
    (container.format !== "macho" || container.architecture !== architecture)
  )
    throw new Il2cppBinaryFormatFailure(
      "malformed-container",
      "Selected FAT declaration disagrees with the slice header architecture.",
    );
  if (container.bits !== 64 || container.byte_order !== "little")
    throw new Il2cppBinaryFormatFailure(
      "unsupported-container",
      `only 64-bit little-endian images are supported, not ${container.bits}-bit ${container.byte_order}-endian`,
    );
  let relocated:
    | {
        bytes: Buffer;
        unresolved: ReadonlySet<bigint>;
        zeroFillPointers: ReadonlyMap<bigint, bigint>;
      }
    | undefined;
  try {
    if (container.format === "elf")
      relocated = yield* applyElfRelativeRelocationsSteps(
        image,
        container.mappings,
        container.zero_fills,
      );
  } catch (cause) {
    if (cause instanceof GoBinaryFormatFailure)
      throw new Il2cppBinaryFormatFailure("malformed-container", cause.message);
    throw cause;
  }
  if (relocated !== undefined) image = relocated.bytes;
  if (container.format === "macho" && container.macho_chained_fixups === true)
    throw new Il2cppBinaryFormatFailure(
      "unsupported-pointer-encoding",
      "Mach-O chained fixups are not decoded",
    );
  if (container.format === "pe" && container.image_base === undefined)
    throw new Il2cppBinaryFormatFailure(
      "malformed-container",
      "PE image base was not observed",
    );
  const imageBase =
    container.image_base ??
    container.mappings.find((mapping) => mapping.offset === 0)?.address ??
    container.mappings.reduce<bigint | undefined>(
      (lowest, mapping) =>
        lowest === undefined || mapping.address < lowest
          ? mapping.address
          : lowest,
      undefined,
    ) ??
    0n;
  return {
    bytes: image,
    container,
    imageBase,
    unresolvedPointerSlots: relocated?.unresolved ?? new Set<bigint>(),
    zeroFillPointers: relocated?.zeroFillPointers ?? new Map<bigint, bigint>(),
  };
}

export const readPointer = (
  image: NativeImage,
  address: bigint,
): bigint | null => {
  if (hasUnresolvedPointer(image, address)) return null;
  const virtual = image.zeroFillPointers.get(address);
  if (virtual !== undefined) return virtual;
  try {
    const offset = mappedFileOffset(
      image.container.mappings,
      address,
      8,
      image.container.zero_fills,
    );
    return image.bytes.readBigUInt64LE(offset);
  } catch (cause) {
    if (cause instanceof GoBinaryFormatFailure) return null;
    throw cause;
  }
};

/** A UInt32 field owns four bytes; reading a pointer would also require unrelated padding. */
export const readUInt32 = (
  image: NativeImage,
  address: bigint,
): number | null => {
  if (hasUnresolvedPointer(image, address, 4)) return null;
  const virtual = image.zeroFillPointers.get(address);
  if (virtual !== undefined) return Number(virtual & 0xffffffffn);
  try {
    return image.bytes.readUInt32LE(
      mappedFileOffset(
        image.container.mappings,
        address,
        4,
        image.container.zero_fills,
      ),
    );
  } catch (cause) {
    if (cause instanceof GoBinaryFormatFailure) return null;
    throw cause;
  }
};

export const isMapped = (image: NativeImage, address: bigint, size: number) => {
  try {
    mappedFileOffset(image.container.mappings, address, size);
    return true;
  } catch (cause) {
    if (cause instanceof GoBinaryFormatFailure) return false;
    throw cause;
  }
};

// An array of slots that all lack a body can sit wholly in zero-fill (.bss):
// an iOS-only assembly in an Android build has its pointers there.
export const isZeroFilled = (
  image: NativeImage,
  address: bigint,
  size: number,
) =>
  isZeroFilledSpan(
    image.container.mappings,
    image.container.zero_fills,
    address,
    size,
  );

/** Admit readable slots across loader ranges without walking every pointer.
 * Each chunk uses the format owner's alias checks; a gap or split slot is refused.
 */
export const hasPointerArrayCoverage = (
  image: NativeImage,
  address: bigint,
  count: number,
): boolean => {
  const end = address + BigInt(count) * 8n;
  let cursor = address;
  while (cursor < end) {
    let fileEnd = cursor;
    for (const range of image.container.mappings)
      if (
        range.address <= cursor &&
        range.address + BigInt(range.size) > fileEnd
      )
        fileEnd = range.address + BigInt(range.size);
    let coveredEnd = fileEnd;
    if (fileEnd === cursor)
      for (const range of image.container.zero_fills)
        if (range.address <= cursor && range.address + range.size > coveredEnd)
          coveredEnd = range.address + range.size;
    const stop = coveredEnd < end ? coveredEnd : end;
    const size = Number(((stop - cursor) / 8n) * 8n);
    if (size <= 0) return false;
    try {
      if (fileEnd === cursor) {
        if (!isZeroFilled(image, cursor, size)) return false;
      } else {
        mappedFileOffset(
          image.container.mappings,
          cursor,
          size,
          image.container.zero_fills,
        );
      }
    } catch (cause) {
      if (cause instanceof GoBinaryFormatFailure) return false;
      throw cause;
    }
    cursor += BigInt(size);
  }
  return true;
};

/** Both executable coverage and the unique full loader mapping must agree. */
export const isExecutable = (image: NativeImage, address: bigint): boolean => {
  try {
    const offset = mappedFileOffset(
      image.container.mappings,
      address,
      1,
      image.container.zero_fills,
    );
    return (
      offset ===
      mappedFileOffset(image.container.executable_mappings ?? [], address, 1)
    );
  } catch (cause) {
    if (cause instanceof GoBinaryFormatFailure) return false;
    throw cause;
  }
};

const hasUnresolvedPointer = (
  image: NativeImage,
  address: bigint,
  size = 8,
): boolean => {
  if (image.unresolvedPointerSlots.size === 0) return false;
  // Unsupported relocation widths are unknown; conservatively cover any
  // overlap with the pointer rather than infer a zero or trust stored bytes.
  for (let delta = -7; delta < size; delta++)
    if (image.unresolvedPointerSlots.has(address + BigInt(delta))) return true;
  return false;
};

export const readSlot = (
  image: NativeImage,
  address: bigint,
): bigint | "unknown" | null => {
  if (hasUnresolvedPointer(image, address)) return "unknown";
  const virtual = image.zeroFillPointers.get(address);
  if (virtual !== undefined) return virtual;
  try {
    return isZeroFilled(image, address, 8) ? 0n : readPointer(image, address);
  } catch (cause) {
    if (cause instanceof GoBinaryFormatFailure)
      throw new Il2cppBinaryFormatFailure("malformed-container", cause.message);
    throw cause;
  }
};
