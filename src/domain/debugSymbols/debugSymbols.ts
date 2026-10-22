import { z } from "zod";

import { facetCoverageSchema } from "../formatRegistry.js";

/**
 * Debug symbols read from their bytes (format expansion F10): ELF debug files,
 * Mach-O dSYM bundles and files, and DWARF 2 to 5. Nothing is executed, no symbol
 * or source server is contacted, and a binary is paired with a debug file only by
 * identifiers both carry, never by file name.
 */

/** Default and maximum bytes read for one debug file or binary. */
export const DEFAULT_SYMBOL_FILE_BYTES = 256 * 1024 ** 2;
export const MAX_SYMBOL_FILE_BYTES = 1024 ** 3;
/** Default and maximum bytes decompressed from debug sections in one call. */
export const DEFAULT_SYMBOL_DECODED_BYTES = 512 * 1024 ** 2;
export const MAX_SYMBOL_DECODED_BYTES = 2 * 1024 ** 3;
export const MAX_SYMBOL_PAGE = 10_000;

const count = z.number().int().min(0);
const nullableString = z.string().nullable();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);

export const SYMBOL_VIEWS = ["units", "functions", "lines"] as const;

export const inspectDebugSymbolsInputSchema = z
  .strictObject({
    path: z
      .string()
      .min(1)
      .describe(
        "Absolute path to a debug file: an ELF file (such as a .debug file or a binary carrying DWARF), a Mach-O file, or a .dSYM bundle directory",
      ),
    binary: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Absolute path to the binary this debug file should describe. It is paired by identifier (Mach-O UUID, ELF build id, debug link CRC-32), never by name, and is not modified",
      ),
    architecture: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Select one image of a universal Mach-O or multi-architecture dSYM, for example arm64 or x86_64",
      ),
    member: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Select one DWARF file of a .dSYM bundle by its file name (Contents/Resources/DWARF/<member>)",
      ),
    view: z
      .enum(SYMBOL_VIEWS)
      .default("units")
      .describe(
        "units: one row per DWARF compilation unit. functions: functions that have code, with address ranges and declaration sites. lines: the line table rows of one unit (needs unit)",
      ),
    unit: count
      .optional()
      .describe(
        "Index of one compilation unit, as listed in the units view; limits functions to that unit and selects the unit for lines",
      ),
    start: count.default(0).describe("Index of the first row to return"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_SYMBOL_PAGE)
      .default(100)
      .describe("Maximum rows to return in this page"),
    max_file_bytes: z
      .number()
      .int()
      .min(1)
      .max(MAX_SYMBOL_FILE_BYTES)
      .default(DEFAULT_SYMBOL_FILE_BYTES)
      .describe("Maximum stable bytes to read from one file (default 256 MiB)"),
    max_decoded_bytes: z
      .number()
      .int()
      .min(1)
      .max(MAX_SYMBOL_DECODED_BYTES)
      .default(DEFAULT_SYMBOL_DECODED_BYTES)
      .describe(
        "Maximum bytes to decompress from compressed debug sections in this call (default 512 MiB)",
      ),
  })
  .refine((input) => input.view !== "lines" || input.unit !== undefined, {
    message:
      "The lines view needs unit: line tables belong to one compilation unit.",
    path: ["unit"],
  });
export type InspectDebugSymbolsInput = z.infer<
  typeof inspectDebugSymbolsInputSchema
>;

const diagnosticSchema = z.strictObject({
  location: nullableString,
  message: z.string().min(1),
});
export type SymbolDiagnostic = z.infer<typeof diagnosticSchema>;

const identitySchema = z.strictObject({
  /** ELF NT_GNU_BUILD_ID, lowercase hex. */
  build_id: nullableString,
  /** Mach-O LC_UUID. */
  uuid: nullableString,
  /** .gnu_debuglink: the debug file's name and the CRC-32 of its contents. */
  debug_link: z
    .strictObject({ name: z.string(), crc32: z.string() })
    .nullable(),
  /** .gnu_debugaltlink (dwz): a supplementary file this one depends on; never read. */
  debug_alt_link: z
    .strictObject({ name: z.string(), build_id: z.string() })
    .nullable(),
});

const checkSchema = z.strictObject({
  kind: z.enum([
    "format",
    "architecture",
    "uuid",
    "build_id",
    "debug_link_crc",
  ]),
  status: z.enum(["matched", "mismatched", "unavailable"]),
  debug: nullableString,
  binary: nullableString,
  note: z.string(),
});

const pairingSchema = z.strictObject({
  /** The binary image this debug image was compared with, or null when none has its architecture. */
  binary_image: z.number().int().min(0).nullable(),
  checks: z.array(checkSchema),
  /** matched and mismatched are decided by identifiers; unverified means none could be compared. */
  verdict: z.enum(["matched", "mismatched", "unverified"]),
  strength: z.enum(["strong", "weak", "none"]),
  /** Only a matched file may be used to name or locate things in the binary. */
  enrichment_allowed: z.boolean(),
  reason: z.string(),
});

const sectionSchema = z.strictObject({
  name: z.string(),
  stored_name: z.string(),
  bytes: count,
  compression: z.enum(["none", "zlib", "zstd"]),
  decompressed_bytes: count.nullable(),
  no_bits: z.boolean(),
});

const imageSchema = z.strictObject({
  index: count,
  /** The DWARF file inside a .dSYM bundle, or null for a plain file. */
  member: nullableString,
  format: z.enum(["elf", "mach-o"]),
  architecture: z.string(),
  bits: z.union([z.literal(32), z.literal(64)]),
  endian: z.enum(["little", "big"]),
  file_type: z.string(),
  identity: identitySchema,
  has_symbol_table: z.boolean(),
  dwarf: z.strictObject({
    /** dwarf: units were read. none: no .debug_info. relocatable-object, split-dwarf and unreadable are described by reason. */
    state: z.enum([
      "dwarf",
      "none",
      "relocatable-object",
      "split-dwarf",
      "unreadable",
    ]),
    reason: nullableString,
    versions: z.array(z.number().int()),
    unit_count: count,
    sections: z.array(sectionSchema),
  }),
  pairing: pairingSchema.nullable(),
  selected: z.boolean(),
  problems: z.array(z.string()),
});
export type DebugSymbolsImage = z.infer<typeof imageSchema>;

const unitSchema = z.strictObject({
  index: count,
  offset: count,
  version: z.number().int(),
  unit_type: z.string(),
  address_size: z.number().int(),
  offset_size: z.number().int(),
  name: nullableString,
  comp_dir: nullableString,
  producer: nullableString,
  language: z.strictObject({ code: count, name: nullableString }).nullable(),
  low_pc: nullableString,
  high_pc: nullableString,
  has_ranges: z.boolean(),
  stmt_list: count.nullable(),
  dwo_name: nullableString,
  dwo_id: nullableString,
  counts: z.strictObject({
    dies: count,
    functions: count,
    declarations: count,
    inlined: count,
    variables: count,
    types: count,
  }),
  problem: nullableString,
});

const functionSchema = z.strictObject({
  unit: count,
  offset: count,
  name: nullableString,
  linkage_name: nullableString,
  low_pc: nullableString,
  high_pc: nullableString,
  ranges: z.array(z.strictObject({ low: z.string(), high: z.string() })),
  /** Non-empty ranges found, at most 4,096; ranges_truncated says more existed. */
  range_count: count,
  ranges_truncated: z.boolean(),
  decl_file: count.nullable(),
  decl_file_name: nullableString,
  decl_line: count.nullable(),
  external: z.boolean(),
  name_from_origin: z.boolean(),
});

const lineFileSchema = z.strictObject({
  index: count,
  path: z.string(),
  md5: nullableString,
});

const lineSchema = z.strictObject({
  address: z.string(),
  op_index: count,
  file: count,
  file_path: nullableString,
  line: count,
  column: count,
  is_stmt: z.boolean(),
  basic_block: z.boolean(),
  end_sequence: z.boolean(),
  prologue_end: z.boolean(),
  epilogue_begin: z.boolean(),
  isa: count,
  discriminator: count,
});

export const debugSymbolsReportSchema = z.strictObject({
  artifact: z.strictObject({
    path: z.string().min(1),
    kind: z.enum(["file", "directory"]),
    sha256,
    /** A file is hashed whole; a bundle by the sorted name and SHA-256 of each DWARF file. */
    sha256_of: z.enum(["content", "dwarf-files"]),
    bytes: count,
  }),
  binary: z
    .strictObject({
      path: z.string().min(1),
      sha256,
      bytes: count,
      format: z.enum(["elf", "mach-o"]),
      images: z.array(
        z.strictObject({
          index: count,
          architecture: z.string(),
          identity: identitySchema,
        }),
      ),
    })
    .nullable(),
  images: z.array(imageSchema),
  selection: z.strictObject({
    state: z.enum(["selected", "ambiguous", "none"]),
    by: z.enum(["only", "architecture", "member"]).nullable(),
    index: count.nullable(),
    reason: nullableString,
  }),
  view: z.enum(SYMBOL_VIEWS).nullable(),
  total: count.nullable(),
  page: z.strictObject({
    start: count,
    limit: z.number().int().min(1),
    returned: count,
    next: count.nullable(),
  }),
  units: z.array(unitSchema),
  functions: z.array(functionSchema),
  line_files: z.array(lineFileSchema),
  lines: z.array(lineSchema),
  diagnostics: z.array(diagnosticSchema),
  coverage: z.array(facetCoverageSchema),
  limitations: z.array(z.string()),
});
export type DebugSymbolsReport = z.infer<typeof debugSymbolsReportSchema>;
