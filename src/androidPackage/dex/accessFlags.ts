/**
 * Access flag names per member kind, bit 0 upward, as dexdump's
 * `createAccessFlagStr` names the low 18 bits; "?" marks a bit with no name
 * for that kind, and higher bits are not shown.
 */
const NAMES: Readonly<Record<"class" | "field" | "method", readonly string[]>> =
  {
    class: [
      "PUBLIC",
      "PRIVATE",
      "PROTECTED",
      "STATIC",
      "FINAL",
      "?",
      "?",
      "?",
      "?",
      "INTERFACE",
      "ABSTRACT",
      "?",
      "SYNTHETIC",
      "ANNOTATION",
      "ENUM",
      "?",
      "VERIFIED",
      "OPTIMIZED",
    ],
    method: [
      "PUBLIC",
      "PRIVATE",
      "PROTECTED",
      "STATIC",
      "FINAL",
      "SYNCHRONIZED",
      "BRIDGE",
      "VARARGS",
      "NATIVE",
      "?",
      "ABSTRACT",
      "STRICT",
      "SYNTHETIC",
      "?",
      "?",
      "MIRANDA",
      "CONSTRUCTOR",
      "DECLARED_SYNCHRONIZED",
    ],
    field: [
      "PUBLIC",
      "PRIVATE",
      "PROTECTED",
      "STATIC",
      "FINAL",
      "?",
      "VOLATILE",
      "TRANSIENT",
      "?",
      "?",
      "?",
      "?",
      "SYNTHETIC",
      "?",
      "ENUM",
      "?",
      "?",
      "?",
    ],
  };

export type DexAccessKind = "class" | "field" | "method";

/** dexdump's names for the set bits of `flags`, lowest bit first. */
export const dexAccessFlags = (flags: number, kind: DexAccessKind): string[] =>
  NAMES[kind].filter((_, bit) => ((flags >>> bit) & 1) === 1);

/** dexdump's `0x%04x (NAMES)` rendering, e.g. `0x3601 (PUBLIC INTERFACE ABSTRACT SYNTHETIC ANNOTATION)`. */
export const dexAccessFlagsText = (
  flags: number,
  kind: DexAccessKind,
): string =>
  `0x${(flags >>> 0).toString(16).padStart(4, "0")} (${dexAccessFlags(flags, kind).join(" ")})`;
