import { z } from "zod";
import {
  hasIsoSignature,
  ISO_DESCRIPTOR_OFFSET,
  ISO_SIGNATURE_BYTES,
} from "./archiveStreamFormat.js";

import { observeMzWindowsHeader } from "./dosMz.js";
import {
  formatDimensionSchema,
  formatIdSchema,
  type FormatId,
} from "./formatIdentifiers.js";
import { formatEntry, formatsHintedByName } from "./formatRegistry.js";
import { FORMAT_REGISTRY } from "./formatRegistryEntries.js";
import {
  classifyArtifactBytes,
  hasAsarHeader,
  hasUdifTrailer,
  hasXarSignature,
  isJvmClassPrefix,
  UDIF_TRAILER_BYTES,
} from "./formatSignatures.js";

/**
 * Format candidate detection over bytes the caller already read. Nothing
 * here extracts, executes, mounts, fetches, or imports a target, and a
 * candidate is not a support claim.
 */

/** Where in the input a candidate's bytes were observed. */
const candidateEvidenceSchema = z
  .object({
    offset: z.number().int().min(0),
    length: z.number().int().min(1),
    observed_hex: z.string().regex(/^(?:[0-9a-f]{2})+$/u),
  })
  .strict();

/** One format the bytes (or bytes plus a name) are consistent with. */
export const formatCandidateSchema = z
  .object({
    format: formatIdSchema,
    dimension: formatDimensionSchema,
    basis: z.enum(["byte-signature", "byte-structure", "name-corroborated"]),
    evidence: candidateEvidenceSchema.nullable(),
    version: z.string().min(1).nullable(),
    detail: z.string().min(1),
  })
  .strict()
  .refine(
    (candidate) =>
      candidate.basis === "name-corroborated" || candidate.evidence !== null,
    "A byte-established candidate must carry its byte evidence",
  );
export type FormatCandidate = z.infer<typeof formatCandidateSchema>;

/** Candidate detection over a bounded prefix and optional trailer. */
export const formatDetectionSchema = z
  .object({
    state: z.enum(["recognized", "unrecognized"]),
    examined: z
      .object({
        file_size: z.number().int().min(0),
        prefix_bytes: z.number().int().min(0),
        trailer_offset: z.number().int().min(0).nullable(),
      })
      .strict(),
    candidates: z.array(formatCandidateSchema),
    name_hint: z
      .object({
        extension: z.string().min(2).nullable(),
        formats: z.array(formatIdSchema),
      })
      .strict(),
    contradictions: z.array(
      z
        .object({
          hinted: z.array(formatIdSchema).min(1),
          detail: z.string().min(1),
        })
        .strict(),
    ),
    limitations: z.array(z.string().min(1)),
  })
  .strict();
export type FormatDetection = z.infer<typeof formatDetectionSchema>;

/** Bytes the caller read from the target; detection reads nothing itself. */
export interface FormatDetectionInput {
  /** Leading bytes, normally {@link FORMAT_SIGNATURE_PREFIX_BYTES}. */
  readonly prefix: Buffer;
  readonly fileSize: number;
  /** Caller-selected name or path, used only as a hint. */
  readonly name: string | null;
  /** The {@link UDIF_TRAILER_BYTES} at `fileSize - 512`, when read. */
  readonly trailer?: Buffer | null;
}

type Observed = Omit<FormatCandidate, "dimension">;

/**
 * What the examined bytes could not settle: limitations for the report and
 * formats a hint may still name, so no contradiction is claimed for them.
 */
interface Unsettled {
  readonly limitations: string[];
  readonly undecided: Set<FormatId>;
}

/**
 * Leading bytes every signature here lies within: tar magic ends at 265 and
 * PDF readers accept a header anywhere in the first 1,024 bytes. A shorter
 * prefix of a longer file cannot refute a name.
 */
const SIGNATURE_WINDOW_BYTES = 1_024;

/** Universal Mach-O wraps per-architecture images and static archives. */
const FAT_SLICE_FORMATS: ReadonlySet<FormatId> = new Set(["mach-o", "ar"]);

const bytesAt = (
  bytes: Buffer,
  offset: number,
  expected: readonly number[],
): boolean =>
  bytes.length >= offset + expected.length &&
  expected.every((value, index) => bytes[offset + index] === value);

const ascii = (text: string): number[] =>
  [...text].map((character) => character.charCodeAt(0));

const evidence = (
  bytes: Buffer,
  offset: number,
  length: number,
  absoluteOffset = offset,
): NonNullable<FormatCandidate["evidence"]> => ({
  offset: absoluteOffset,
  length,
  observed_hex: bytes.subarray(offset, offset + length).toString("hex"),
});

const signature = (
  format: FormatId,
  observed: NonNullable<FormatCandidate["evidence"]>,
  detail: string,
  version: string | null = null,
): Observed => ({
  format,
  basis: "byte-signature",
  evidence: observed,
  version,
  detail,
});

/** Magic numbers at offset 0 for formats without a richer owner. */
const MAGIC_SIGNATURES: readonly (readonly [FormatId, string, string])[] = [
  ["gzip", "\x1f\x8b\x08", "Gzip member header with deflate method."],
  ["xz", "\xfd7zXZ\0", "XZ stream header magic."],
  ["zstd", "\x28\xb5\x2f\xfd", "Zstandard frame magic."],
  [
    "ole-compound",
    "\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1",
    "OLE compound file signature.",
  ],
  ["sqlite", "SQLite format 3\0", "SQLite database header string."],
  ["ar", "!<arch>\n", "Unix ar global header."],
  ["ar", "!<thin>\n", "GNU thin ar global header; members live outside it."],
  ["rpm", "\xed\xab\xee\xdb", "RPM lead magic."],
  [
    "pdb-msf",
    "Microsoft C/C++ MSF 7.00\r\n\x1aDS\0\0\0",
    "MSF 7.0 superblock magic.",
  ],
];

const versionedSignatures = (prefix: Buffer): Observed[] => {
  const found: Observed[] = [];
  if (bytesAt(prefix, 0, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) {
    const version = prefix.length >= 8 ? `${prefix[6]}.${prefix[7]}` : null;
    found.push(
      signature(
        "7z",
        evidence(prefix, 0, 6),
        "7-Zip signature header.",
        version,
      ),
    );
  }
  if (bytesAt(prefix, 0, ascii("Rar!\x1a\x07\x01\x00")))
    found.push(
      signature("rar", evidence(prefix, 0, 8), "RAR 5 marker block.", "5"),
    );
  else if (bytesAt(prefix, 0, ascii("Rar!\x1a\x07\x00")))
    found.push(
      signature("rar", evidence(prefix, 0, 7), "RAR 1.5-4 marker block.", "4"),
    );
  if (
    bytesAt(prefix, 0, ascii("BZh")) &&
    prefix.length >= 4 &&
    (prefix[3] ?? 0) >= 0x31 &&
    (prefix[3] ?? 0) <= 0x39
  )
    found.push(
      signature("bzip2", evidence(prefix, 0, 4), "Bzip2 stream header."),
    );
  if (bytesAt(prefix, 257, ascii("ustar  \0")))
    found.push(
      signature("tar", evidence(prefix, 257, 8), "GNU tar magic.", "gnu"),
    );
  else if (bytesAt(prefix, 257, ascii("ustar\0")))
    found.push(
      signature("tar", evidence(prefix, 257, 6), "POSIX ustar magic.", "ustar"),
    );
  if (bytesAt(prefix, 0, ascii("hsqs")) || bytesAt(prefix, 0, ascii("sqsh")))
    found.push(
      signature(
        "squashfs",
        evidence(prefix, 0, 4),
        "SquashFS superblock magic.",
        prefix.length >= 30 && prefix[0] === 0x68
          ? String(prefix.readUInt16LE(28))
          : null,
      ),
    );
  return found;
};

/** Signatures whose version is spelled in ASCII after the magic. */
const textualSignatures = (
  prefix: Buffer,
  unsettled: Unsettled,
): Observed[] => {
  const found: Observed[] = [];
  const pdf = /%PDF-(\d\.\d)/u.exec(
    prefix.subarray(0, SIGNATURE_WINDOW_BYTES).toString("latin1"),
  );
  if (pdf?.index === 0)
    found.push(
      signature(
        "pdf",
        evidence(prefix, 0, 8),
        "PDF header comment.",
        pdf[1] ?? null,
      ),
    );
  else if (pdf !== null) {
    // Readers tolerate leading bytes before the header, but text may also
    // merely quote one; neither a candidate nor a contradiction is claimed.
    unsettled.undecided.add("pdf");
    unsettled.limitations.push(
      `A PDF header comment appears after ${pdf.index.toLocaleString("en-US")} leading bytes; it is not taken as a candidate.`,
    );
  }
  const dex = /^dex\n(\d{3})\0/u.exec(prefix.subarray(0, 8).toString("latin1"));
  if (dex !== null)
    found.push(
      signature(
        "dalvik-dex",
        evidence(prefix, 0, 8),
        "DEX file magic.",
        dex[1] ?? null,
      ),
    );
  return found;
};

const webAssembly = (prefix: Buffer): Observed[] => {
  if (!bytesAt(prefix, 0, [0x00, 0x61, 0x73, 0x6d])) return [];
  if (prefix.length < 8)
    return [
      signature(
        "wasm-binary",
        evidence(prefix, 0, 4),
        "WebAssembly magic; version not examined.",
      ),
    ];
  if (bytesAt(prefix, 4, [0x01, 0x00, 0x00, 0x00]))
    return [
      signature(
        "wasm-binary",
        evidence(prefix, 0, 8),
        "WebAssembly magic and version.",
        "1",
      ),
      signature(
        "wasm-module",
        evidence(prefix, 0, 8),
        "Core module version 1, layer 0.",
        "1",
      ),
    ];
  if (bytesAt(prefix, 6, [0x01, 0x00]))
    return [
      signature(
        "wasm-binary",
        evidence(prefix, 0, 8),
        "WebAssembly magic and version.",
      ),
      signature(
        "wasm-component",
        evidence(prefix, 0, 8),
        "Component layer 1.",
        `0x${prefix.readUInt16LE(4).toString(16)}`,
      ),
    ];
  return [
    signature(
      "wasm-binary",
      evidence(prefix, 0, 8),
      "WebAssembly magic with an unrecognized version or layer.",
      `0x${prefix.readUInt32LE(4).toString(16)}`,
    ),
  ];
};

const FAT_OR_CLASS_MAGIC = 0xcafebabe;

/** See {@link isJvmClassPrefix}: the word after 0xCAFEBABE separates the two formats. */
const fatOrClass = (prefix: Buffer, unsettled: Unsettled): Observed[] => {
  if (prefix.length < 8) {
    unsettled.undecided.add("mach-o-universal").add("jvm-classfile");
    unsettled.limitations.push(
      "0xCAFEBABE was seen but fewer than 8 bytes were available, so universal Mach-O and JVM class file cannot be told apart.",
    );
    return [];
  }
  const word = prefix.readUInt32BE(4);
  if (!isJvmClassPrefix(prefix))
    return [
      signature(
        "mach-o-universal",
        evidence(prefix, 0, 8),
        `Fat header with ${word} architecture ${word === 1 ? "entry" : "entries"}.`,
      ),
    ];
  unsettled.limitations.push(
    "The artifact graph inventories a JVM class file as an unclassified file; inspect_jvm_artifact reads it.",
  );
  return [
    signature(
      "jvm-classfile",
      evidence(prefix, 0, 8),
      "JVM class file magic and version.",
      `${prefix.readUInt16BE(6)}.${prefix.readUInt16BE(4)}`,
    ),
  ];
};

/** Executable, ZIP, and plist storage share the artifact graph's classifier. */
const classifierSignatures = (
  prefix: Buffer,
  fileSize: number,
  unsettled: Unsettled,
): Observed[] => {
  if (prefix.length >= 4 && prefix.readUInt32BE(0) === FAT_OR_CLASS_MAGIC)
    return fatOrClass(prefix, unsettled);
  switch (classifyArtifactBytes(prefix, fileSize)) {
    case "zip":
      return [
        signature("zip", evidence(prefix, 0, 4), "ZIP record signature."),
      ];
    case "plist":
      return [
        signature("binary-plist", evidence(prefix, 0, 8), "bplist00 header."),
      ];
    case "mach-o":
      return [
        signature("mach-o", evidence(prefix, 0, 4), "Mach-O header magic."),
      ];
    case "mach-o-universal":
      return [
        signature(
          "mach-o-universal",
          evidence(prefix, 0, 4),
          "Fat header magic.",
        ),
      ];
    // An AppImage is an ELF file first; the graph records it as a container.
    case "appimage":
    case "elf": {
      const found = [
        signature("elf", evidence(prefix, 0, 4), "ELF identification magic."),
      ];
      if (bytesAt(prefix, 8, [0x41, 0x49]) && prefix.length >= 11)
        found.push({
          format: "appimage",
          basis: "byte-structure",
          evidence: evidence(prefix, 8, 3),
          version: String(prefix[10]),
          detail: "AppImage magic in the ELF identification padding.",
        });
      return found;
    }
    case "pe": {
      const header = observeMzWindowsHeader(prefix, fileSize);
      const offset = header.state === "declared" ? header.offset : 0;
      return [
        signature(
          "pe",
          evidence(prefix, offset, 4),
          "PE signature at the MZ new-header offset.",
        ),
      ];
    }
    case "dos-mz":
      return [
        signature(
          "dos-mz",
          evidence(prefix, 0, 2),
          "Valid DOS MZ load-module header.",
        ),
      ];
    case "unknown":
      unsettled.undecided.add("pe").add("dos-mz");
      unsettled.limitations.push(
        "An MZ signature was seen but its header could not be classified from the examined bytes.",
      );
      return [];
    default:
      return [];
  }
};

const byteCandidates = (
  input: FormatDetectionInput,
  hinted: readonly FormatId[],
  unsettled: Unsettled,
): Observed[] => {
  const { prefix, fileSize } = input;
  const found = [
    ...classifierSignatures(prefix, fileSize, unsettled),
    ...webAssembly(prefix),
    ...versionedSignatures(prefix),
    ...textualSignatures(prefix, unsettled),
    ...MAGIC_SIGNATURES.filter(([, magic]) =>
      bytesAt(prefix, 0, ascii(magic)),
    ).map(([format, magic, detail]) =>
      signature(format, evidence(prefix, 0, magic.length), detail),
    ),
  ];
  if (hasXarSignature(prefix))
    found.push(signature("xar", evidence(prefix, 0, 4), "XAR header magic."));
  if (hasIsoSignature(prefix))
    found.push(
      signature(
        "iso",
        evidence(prefix, ISO_DESCRIPTOR_OFFSET, 7),
        "ISO 9660 volume descriptor header; filesystem contents are not validated.",
      ),
    );
  else if (
    prefix.length < ISO_SIGNATURE_BYTES &&
    fileSize >= ISO_SIGNATURE_BYTES
  ) {
    unsettled.undecided.add("iso");
    if (hinted.includes("iso"))
      unsettled.limitations.push(
        "The ISO 9660 volume descriptor header was not examined.",
      );
  }
  if (
    bytesAt(prefix, 0, ascii("!<arch>\n")) &&
    bytesAt(prefix, 8, ascii("debian-binary")) &&
    [0x20, 0x2f].includes(prefix[21] ?? 0)
  )
    found.push({
      format: "deb",
      basis: "byte-structure",
      evidence: evidence(prefix, 8, 14),
      version: null,
      detail: "The first ar member is debian-binary.",
    });
  // ASAR's header pickle is too generic to stand alone; the name corroborates it.
  if (hinted.includes("asar") && hasAsarHeader(prefix))
    found.push({
      format: "asar",
      basis: "name-corroborated",
      evidence: evidence(prefix, 0, 17),
      version: null,
      detail: "ASAR header pickle with an .asar name.",
    });
  const trailer = examinedTrailer(input);
  if (trailer !== null && hasUdifTrailer(trailer))
    found.push({
      format: "udif",
      basis: "byte-signature",
      evidence: evidence(trailer, 0, 4, fileSize - UDIF_TRAILER_BYTES),
      version: null,
      detail: "UDIF koly trailer.",
    });
  return found;
};

const examinedTrailer = (input: FormatDetectionInput): Buffer | null =>
  input.trailer === undefined ||
  input.trailer === null ||
  input.fileSize < UDIF_TRAILER_BYTES
    ? null
    : input.trailer;

/**
 * A hinted format is consistent if bytes show it, the storage carrying it,
 * or a universal wrapper whose unexamined slices may hold it.
 */
const consistentWith = (
  format: FormatId,
  observed: ReadonlySet<FormatId>,
): boolean =>
  observed.has(format) ||
  (FAT_SLICE_FORMATS.has(format) && observed.has("mach-o-universal")) ||
  (!formatEntry(format).byteSignature &&
    formatEntry(format).storage.some((storage) => observed.has(storage)));

/**
 * Bytes can refute a hint only when every hinted format is byte-checkable
 * from what was examined: a disk image is decided by its unread trailer.
 */
const checkable =
  (trailerExamined: boolean) =>
  (format: FormatId): boolean =>
    (format !== "udif" || trailerExamined) &&
    (formatEntry(format).byteSignature ||
      formatEntry(format).storage.length > 0);

const REGISTRY_ORDER: ReadonlyMap<FormatId, number> = new Map(
  FORMAT_REGISTRY.map((format, index) => [format.id, index]),
);

/**
 * Report every registry format the examined bytes are consistent with, the
 * name hint, and any contradiction between them. Candidates are not support
 * claims; capability states come from the registry separately.
 */
export const detectFormatCandidates = (
  input: FormatDetectionInput,
): FormatDetection => {
  const unsettled: Unsettled = { limitations: [], undecided: new Set() };
  const { limitations } = unsettled;
  const hint =
    input.name === null
      ? { extension: null, formats: [] }
      : formatsHintedByName(input.name);
  const byBytes = byteCandidates(input, hint.formats, unsettled);
  const observed = new Set(byBytes.map((candidate) => candidate.format));
  // A name that directly names an observed storage adds no package role:
  // a plain `.tar` is not evidence of an image archive.
  const namesObservedStorage = hint.formats.some((format) =>
    observed.has(format),
  );
  const corroborated: Observed[] = hint.formats
    .filter(
      (format) =>
        !namesObservedStorage &&
        !formatEntry(format).byteSignature &&
        formatEntry(format).storage.some((storage) => observed.has(storage)),
    )
    .map((format) => ({
      format,
      basis: "name-corroborated",
      evidence: null,
      version: null,
      detail: `The ${hint.extension ?? ""} name is consistent with the observed ${formatEntry(
        format,
      )
        .storage.filter((storage) => observed.has(storage))
        .join(", ")} storage; package contents were not checked.`,
    }));
  const candidates = [...byBytes, ...corroborated]
    .map((candidate) => ({
      ...candidate,
      dimension: formatEntry(candidate.format).dimension,
    }))
    .sort(
      (left, right) =>
        (REGISTRY_ORDER.get(left.format) ?? 0) -
        (REGISTRY_ORDER.get(right.format) ?? 0),
    );
  const windowExamined =
    input.prefix.length >= Math.min(input.fileSize, SIGNATURE_WINDOW_BYTES);
  if (!windowExamined && hint.formats.length > 0)
    limitations.push(
      `Fewer than ${SIGNATURE_WINDOW_BYTES.toLocaleString("en-US")} leading bytes were examined, so the name hint is not checked against the bytes.`,
    );
  const contradictions =
    hint.formats.length > 0 &&
    windowExamined &&
    hint.formats.every(checkable(examinedTrailer(input) !== null)) &&
    !hint.formats.some((format) => unsettled.undecided.has(format)) &&
    !hint.formats.some((format) => consistentWith(format, observed))
      ? [
          {
            hinted: hint.formats,
            detail: `The ${hint.extension ?? ""} name suggests ${hint.formats.join(
              " or ",
            )}, but the examined bytes do not match.`,
          },
        ]
      : [];
  const trailerOffset =
    examinedTrailer(input) === null
      ? null
      : input.fileSize - UDIF_TRAILER_BYTES;
  if (trailerOffset === null && input.fileSize >= UDIF_TRAILER_BYTES)
    limitations.push("The 512-byte UDIF trailer was not examined.");
  limitations.push(
    `Detection examined ${input.prefix.length.toLocaleString("en-US")} leading bytes${
      trailerOffset === null ? "" : " and the final 512 bytes"
    }. Signatures identify candidates; they do not validate the whole structure.`,
  );
  return formatDetectionSchema.parse({
    state: candidates.length > 0 ? "recognized" : "unrecognized",
    examined: {
      file_size: input.fileSize,
      prefix_bytes: input.prefix.length,
      trailer_offset: trailerOffset,
    },
    candidates,
    name_hint: hint,
    contradictions,
    limitations,
  });
};
