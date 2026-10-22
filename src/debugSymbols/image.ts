import { crc32, inflateSync, zstdDecompressSync } from "node:zlib";

import { DebugFormatError } from "./byteReader.js";

/** The call's decode budget ran out; raising max_decoded_bytes is the remedy. */
export class DecodeBudgetExceeded extends DebugFormatError {}

/** Bytes decompressed across one call; the limit is the caller's. */
export class DecodeBudget {
  remaining: number;
  constructor(readonly limit: number) {
    this.remaining = limit;
  }

  take(bytes: number, what: string): void {
    if (bytes > this.remaining)
      throw new DecodeBudgetExceeded(
        `Decoding ${what} needs ${bytes} bytes and ${this.remaining} of the ${this.limit}-byte decode budget remain.`,
      );
    this.remaining -= bytes;
  }
}

export type SectionCompression = "none" | "zlib" | "zstd";

/** One DWARF-related section, located but not yet read. */
export interface DebugSection {
  /** Normalized to the ELF spelling: ".debug_info" for ELF and for Mach-O "__debug_info". */
  readonly name: string;
  /** The name as the container stores it. */
  readonly storedName: string;
  /** Offset of the stored bytes inside the image's own bytes. */
  readonly offset: number;
  /** Stored size (compressed when compression is not "none"). */
  readonly size: number;
  readonly compression: SectionCompression;
  /** The decompressed size the container declares, when compressed. */
  readonly declaredSize: number | null;
  /** The section occupies no file bytes (a stripped debug file). */
  readonly noBits: boolean;
  /** Offset inside the stored bytes where the compressed stream starts. */
  readonly streamOffset: number;
  /** Why the section cannot be read (a bad header or an unsupported encoding), or null. */
  readonly problem: string | null;
}

export interface DebugLink {
  readonly name: string;
  readonly crc32: string;
}

export interface ImageIdentity {
  /** ELF NT_GNU_BUILD_ID, lowercase hex. */
  readonly buildId: string | null;
  /** Mach-O LC_UUID, uppercase 8-4-4-4-12. */
  readonly uuid: string | null;
  /** .gnu_debuglink: file name and the CRC-32 of that file's contents. */
  readonly debugLink: DebugLink | null;
  /** .gnu_debugaltlink (dwz): the supplementary file name and its build id. */
  readonly debugAltLink: {
    readonly name: string;
    readonly buildId: string;
  } | null;
}

export type ImageFormat = "elf" | "mach-o";

/** One ELF file or one Mach-O architecture slice. */
export interface DebugImage {
  readonly format: ImageFormat;
  /** Slice bytes (the whole file for ELF and thin Mach-O). */
  readonly bytes: Uint8Array;
  /** Offset of the slice inside its file. */
  readonly fileOffset: number;
  readonly architecture: string;
  readonly bits: 32 | 64;
  readonly littleEndian: boolean;
  readonly fileType: string;
  /** Object files carry relocations their DWARF depends on. */
  readonly relocatable: boolean;
  readonly identity: ImageIdentity;
  readonly sections: readonly DebugSection[];
  /** Whether a symbol table section exists (reported, not read). */
  readonly hasSymbolTable: boolean;
  /** Section counts the reader could not read in full. */
  readonly problems: readonly string[];
}

/** Return a section's bytes, decompressed inside the budget. */
export const readSection = (
  image: DebugImage,
  section: DebugSection,
  budget: DecodeBudget,
): Uint8Array => {
  if (section.problem !== null)
    throw new DebugFormatError(
      `Section ${section.storedName}: ${section.problem}`,
    );
  if (section.noBits)
    throw new DebugFormatError(
      `Section ${section.storedName} occupies no file bytes.`,
    );
  const stored = image.bytes.subarray(
    section.offset,
    section.offset + section.size,
  );
  if (stored.length !== section.size)
    throw new DebugFormatError(
      `Section ${section.storedName} extends past the end of the file.`,
    );
  if (section.compression === "none") return stored;
  const stream = stored.subarray(section.streamOffset);
  const declared = section.declaredSize;
  if (declared === null)
    throw new DebugFormatError(
      `Section ${section.storedName} does not declare its decompressed size.`,
    );
  budget.take(declared, section.storedName);
  try {
    const out =
      section.compression === "zlib"
        ? inflateSync(stream, { maxOutputLength: Math.max(declared, 1) })
        : zstdDecompressSync(stream, {
            maxOutputLength: Math.max(declared, 1),
          });
    if (out.length !== declared)
      throw new DebugFormatError(
        `Section ${section.storedName} decompressed to ${out.length} bytes, not the declared ${declared}.`,
      );
    return out;
  } catch (cause) {
    if (cause instanceof DebugFormatError) throw cause;
    throw new DebugFormatError(
      `Section ${section.storedName} could not be decompressed.`,
      { cause },
    );
  }
};

export const sectionNamed = (
  image: DebugImage,
  name: string,
): DebugSection | undefined =>
  image.sections.find((section) => section.name === name);

/** The standard CRC-32 of the bytes, as eight lowercase hex digits. */
export const crc32Hex = (bytes: Uint8Array): string =>
  crc32(bytes).toString(16).padStart(8, "0");
