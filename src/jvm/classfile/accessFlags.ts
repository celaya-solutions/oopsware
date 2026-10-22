/** Access and property flags from JVMS 4.1-4.7, per structure that carries them. */
type FlagTable = readonly (readonly [number, string])[];

const CLASS: FlagTable = [
  [0x0001, "public"],
  [0x0010, "final"],
  [0x0020, "super"],
  [0x0200, "interface"],
  [0x0400, "abstract"],
  [0x1000, "synthetic"],
  [0x2000, "annotation"],
  [0x4000, "enum"],
  [0x8000, "module"],
];

const INNER_CLASS: FlagTable = [
  [0x0001, "public"],
  [0x0002, "private"],
  [0x0004, "protected"],
  [0x0008, "static"],
  [0x0010, "final"],
  [0x0200, "interface"],
  [0x0400, "abstract"],
  [0x1000, "synthetic"],
  [0x2000, "annotation"],
  [0x4000, "enum"],
];

const FIELD: FlagTable = [
  [0x0001, "public"],
  [0x0002, "private"],
  [0x0004, "protected"],
  [0x0008, "static"],
  [0x0010, "final"],
  [0x0040, "volatile"],
  [0x0080, "transient"],
  [0x1000, "synthetic"],
  [0x4000, "enum"],
];

const METHOD: FlagTable = [
  [0x0001, "public"],
  [0x0002, "private"],
  [0x0004, "protected"],
  [0x0008, "static"],
  [0x0010, "final"],
  [0x0020, "synchronized"],
  [0x0040, "bridge"],
  [0x0080, "varargs"],
  [0x0100, "native"],
  [0x0400, "abstract"],
  [0x0800, "strict"],
  [0x1000, "synthetic"],
];

const PARAMETER: FlagTable = [
  [0x0010, "final"],
  [0x1000, "synthetic"],
  [0x8000, "mandated"],
];

const MODULE: FlagTable = [
  [0x0020, "open"],
  [0x1000, "synthetic"],
  [0x8000, "mandated"],
];

const REQUIRES: FlagTable = [
  [0x0020, "transitive"],
  [0x0040, "static"],
  [0x1000, "synthetic"],
  [0x8000, "mandated"],
];

const EXPORTS: FlagTable = [
  [0x1000, "synthetic"],
  [0x8000, "mandated"],
];

export const ACCESS_TABLES = {
  class: CLASS,
  innerClass: INNER_CLASS,
  field: FIELD,
  method: METHOD,
  parameter: PARAMETER,
  module: MODULE,
  requires: REQUIRES,
  exports: EXPORTS,
} as const;

/** Flag names in table order; bits the table does not define are named in hex. */
export const accessFlagNames = (
  flags: number,
  table: keyof typeof ACCESS_TABLES,
): string[] => {
  const names: string[] = [];
  let known = 0;
  for (const [bit, name] of ACCESS_TABLES[table]) {
    known |= bit;
    if ((flags & bit) !== 0) names.push(name);
  }
  const unknown = flags & ~known & 0xffff;
  if (unknown !== 0) names.push(`0x${unknown.toString(16).padStart(4, "0")}`);
  return names;
};

/** Source-level modifiers (javap order) from method or field flags. */
export const sourceModifiers = (
  flags: number,
  table: "field" | "method" | "innerClass",
): string[] => {
  const keep =
    table === "method"
      ? [
          "public",
          "private",
          "protected",
          "abstract",
          "static",
          "final",
          "synchronized",
          "native",
          "strict",
        ]
      : table === "field"
        ? [
            "public",
            "private",
            "protected",
            "static",
            "final",
            "transient",
            "volatile",
          ]
        : ["public", "private", "protected", "abstract", "static", "final"];
  const present = new Set(accessFlagNames(flags, table));
  return keep
    .filter((name) => present.has(name))
    .map((name) => (name === "strict" ? "strictfp" : name));
};
