import type { CompoundFile } from "../cfb.js";
import { codepageDecoder } from "./codepage.js";
import {
  firstSection,
  readValue,
  vtName,
  type StoredProperty,
} from "./propertySet.js";

/**
 * The "\u0005SummaryInformation" property set as Windows Installer uses it
 * (FMTID F29F85E0-4FF9-1068-AB91-08002B27B3D9): strings in the code page
 * property 1 names; template = platforms;languages, revision = package
 * code, page count = schema (minimum installer version), word count =
 * source flags. Values are as stored; nothing is checked against the
 * database.
 */

export const SUMMARY_INFORMATION_FMTID =
  "{F29F85E0-4FF9-1068-AB91-08002B27B3D9}";

export interface MsiSummaryInformation {
  readonly codepage: number | null;
  readonly title: string | null;
  readonly subject: string | null;
  readonly author: string | null;
  readonly keywords: string | null;
  readonly comments: string | null;
  readonly template: string | null;
  readonly platforms: readonly string[];
  readonly languages: readonly number[];
  readonly last_saved_by: string | null;
  /** The package code. */
  readonly revision: string | null;
  readonly last_printed: string | null;
  readonly created: string | null;
  readonly last_saved: string | null;
  /** The schema: the minimum installer version times 100. */
  readonly page_count: number | null;
  readonly word_count: number | null;
  /** Word count bits: short-names, compressed, administrative-image, no-elevation. */
  readonly source_flags: readonly string[];
  readonly character_count: number | null;
  readonly creating_application: string | null;
  readonly security: number | null;
  /** Every stored property in stream order. */
  readonly properties: readonly StoredProperty[];
  /** Stored properties whose IDs Windows Installer does not define. */
  readonly unknown_properties: number;
  readonly problems: readonly string[];
}

/** PIDSI_* IDs Windows Installer defines, with the VT each takes. */
const DEFINED: Readonly<Record<number, number>> = {
  1: 2,
  2: 30,
  3: 30,
  4: 30,
  5: 30,
  6: 30,
  7: 30,
  8: 30,
  9: 30,
  10: 64,
  11: 64,
  12: 64,
  13: 64,
  14: 3,
  15: 3,
  16: 3,
  17: 71,
  18: 30,
  19: 3,
};

const SOURCE_FLAGS: readonly (readonly [number, string])[] = [
  [0x1, "short-names"],
  [0x2, "compressed"],
  [0x4, "administrative-image"],
  [0x8, "no-elevation"],
];

/** Every stored property, the code page (property 1, read unsigned), unknown IDs and problems. */
const readProperties = (
  bytes: Uint8Array,
): {
  properties: StoredProperty[];
  codepage: number | null;
  unknown: number;
  problems: string[];
} => {
  const problems: string[] = [];
  const properties: StoredProperty[] = [];
  const section = firstSection(bytes);
  if (typeof section === "string")
    return {
      properties,
      codepage: null,
      unknown: 0,
      problems: [`SummaryInformation: ${section}.`],
    };
  if (section.fmtid !== SUMMARY_INFORMATION_FMTID)
    return {
      properties,
      codepage: null,
      unknown: 0,
      problems: [
        `SummaryInformation's first property set has FMTID ${String(section.fmtid)}, not ${SUMMARY_INFORMATION_FMTID}.`,
      ],
    };
  if (section.declared > section.body.length)
    problems.push(
      `SummaryInformation's section declares ${String(section.declared)} bytes; ${String(section.body.length)} remain.`,
    );
  const codepageAt = section.entries.find(([id]) => id === 1)?.[1];
  const codepageValue =
    codepageAt === undefined
      ? null
      : readValue(section.body, codepageAt, codepageDecoder(1252));
  // A VT_I2 holding an unsigned 16-bit code page: 65001 is stored as 0xfde9.
  const codepage =
    typeof codepageValue === "object" &&
    typeof codepageValue?.value === "number"
      ? codepageValue.value & 0xffff
      : null;
  const decoder = codepageDecoder(codepage ?? 0);
  if (!decoder.exact)
    problems.push(
      `Code page ${String(codepage)} has no decoder here; strings are read as windows-1252.`,
    );
  let unknown = 0;
  for (const [id, offset] of section.entries) {
    const value = readValue(section.body, offset, decoder);
    if (typeof value === "string") {
      problems.push(`Property ${String(id)}: ${value}.`);
      continue;
    }
    const expected = DEFINED[id];
    if (expected === undefined) unknown += 1;
    else if (expected !== value.vt)
      problems.push(
        `Property ${String(id)} is ${vtName(value.vt)}; Windows Installer stores ${vtName(expected)}.`,
      );
    const stored = id === 1 ? codepage : value.value;
    properties.push(Object.freeze({ id, vt: vtName(value.vt), value: stored }));
  }
  return { properties, codepage, unknown, problems };
};

export const readSummaryInformation = (
  bytes: Uint8Array,
): MsiSummaryInformation => {
  const { properties, codepage, unknown, problems } = readProperties(bytes);
  const get = (id: number): string | number | null =>
    properties.find((property) => property.id === id)?.value ?? null;
  const text = (id: number): string | null => {
    const value = get(id);
    return value === null ? null : String(value);
  };
  /** A number, or a decimal string (libmsi converts VT_LPSTR integers with atoi). */
  const number = (id: number): number | null => {
    const value = get(id);
    if (typeof value === "number") return value;
    return typeof value === "string" && /^-?\d+$/u.test(value.trim())
      ? Number.parseInt(value, 10)
      : null;
  };
  const template = text(7);
  const separator = template?.indexOf(";") ?? -1;
  const platforms =
    template === null
      ? ""
      : separator < 0
        ? template
        : template.slice(0, separator);
  const languages =
    template === null || separator < 0 ? "" : template.slice(separator + 1);
  const words = number(15);
  return Object.freeze({
    codepage,
    title: text(2),
    subject: text(3),
    author: text(4),
    keywords: text(5),
    comments: text(6),
    template,
    platforms: Object.freeze(platforms === "" ? [] : platforms.split(",")),
    languages: Object.freeze(
      languages === ""
        ? []
        : languages
            .split(",")
            .map((language) => Number.parseInt(language, 10))
            .filter((language) => !Number.isNaN(language)),
    ),
    last_saved_by: text(8),
    revision: text(9),
    last_printed: text(11),
    created: text(12),
    last_saved: text(13),
    page_count: number(14),
    word_count: words,
    source_flags: Object.freeze(
      words === null
        ? []
        : SOURCE_FLAGS.filter(([bit]) => (words & bit) !== 0).map(
            ([, name]) => name,
          ),
    ),
    character_count: number(16),
    creating_application: text(18),
    security: number(19),
    properties: Object.freeze(properties),
    unknown_properties: unknown,
    problems: Object.freeze(problems),
  });
};

/** Bytes read from a SummaryInformation stream; Windows Installer's are under 1 KiB. */
const SUMMARY_LIMIT = 1024 * 1024;

/** The root "\u0005SummaryInformation" stream of a compound file, read; null when absent. */
export const summaryInformationOf = async (
  file: CompoundFile,
): Promise<MsiSummaryInformation | null> => {
  const entry = file.entries.find(
    (candidate) =>
      candidate.type === "stream" &&
      candidate.path.length === 1 &&
      candidate.name === "\u0005SummaryInformation",
  );
  if (entry === undefined) return null;
  const summary = readSummaryInformation(await file.read(entry, SUMMARY_LIMIT));
  if (entry.size <= SUMMARY_LIMIT) return summary;
  return Object.freeze({
    ...summary,
    problems: Object.freeze([
      ...summary.problems,
      `SummaryInformation is ${String(entry.size)} bytes; the first ${String(SUMMARY_LIMIT)} were read.`,
    ]),
  });
};
