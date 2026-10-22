/**
 * RPMSENSE bits other than the comparison (rpmds.h), in the order rpm's
 * `deptype` query format lists them, then the trigger and keyring bits.
 */
const DEPENDENCY_BITS: readonly (readonly [number, string])[] = [
  [9, "pre"],
  [10, "post"],
  [11, "preun"],
  [12, "postun"],
  [13, "verify"],
  [8, "interp"],
  [24, "rpmlib"],
  [14, "find-requires"],
  [15, "find-provides"],
  [6, "prereq"],
  [7, "pretrans"],
  [5, "posttrans"],
  [20, "preuntrans"],
  [21, "postuntrans"],
  [28, "config"],
  [19, "missingok"],
  [29, "meta"],
  [25, "triggerprein"],
  [16, "triggerin"],
  [17, "triggerun"],
  [18, "triggerpostun"],
  [26, "keyring"],
];

/** RPMFILE bits (rpmfiles.h). */
const FILE_BITS: readonly (readonly [number, string])[] = [
  [0, "config"],
  [1, "doc"],
  [2, "icon"],
  [3, "missingok"],
  [4, "noreplace"],
  [5, "specfile"],
  [6, "ghost"],
  [7, "license"],
  [8, "readme"],
  [11, "pubkey"],
  [12, "artifact"],
];

/** RPMSCRIPT_FLAG bits (rpm lib/rpmscript.h). */
const SCRIPT_BITS: readonly (readonly [number, string])[] = [
  [0, "expand"],
  [1, "qformat"],
  [2, "critical"],
];

/** Hash algorithm numbers rpm stores (rpmcrypto.h, mirroring OpenPGP's). */
export const HASH_ALGORITHMS: ReadonlyMap<number, string> = new Map([
  [1, "md5"],
  [2, "sha1"],
  [3, "ripemd160"],
  [5, "md2"],
  [6, "tiger192"],
  [7, "haval-5-160"],
  [8, "sha256"],
  [9, "sha384"],
  [10, "sha512"],
  [11, "sha224"],
  [12, "sha3-256"],
  [14, "sha3-512"],
]);

/** Named bits first, then any undefined bit as "bitN" so nothing is dropped. */
const names = (
  value: number,
  bits: readonly (readonly [number, string])[],
  ignored: number,
): string[] => {
  const result = bits.flatMap(([bit, name]) =>
    (value >>> bit) & 1 ? [name] : [],
  );
  const known = bits.reduce((mask, [bit]) => mask | (1 << bit), ignored);
  for (let bit = 0; bit < 32; bit += 1)
    if ((value >>> bit) & 1 && !((known >>> bit) & 1))
      result.push(`bit${String(bit)}`);
  return result;
};

/** RPMSENSE flags without the LESS/GREATER/EQUAL comparison bits (1-3); bit 0 is named if set. */
export const dependencyFlagNames = (flags: number): string[] =>
  names(flags, DEPENDENCY_BITS, 0b1110);

export const fileFlagNames = (flags: number): string[] =>
  names(flags, FILE_BITS, 0);

export const scriptFlagNames = (flags: number): string[] =>
  names(flags, SCRIPT_BITS, 0);

/** Bit value of a dependency flag name, for rendering names back to rpm's numbers. */
export const DEPENDENCY_FLAG_BITS: ReadonlyMap<string, number> = new Map(
  DEPENDENCY_BITS.map(([bit, name]) => [name, bit]),
);
export const FILE_FLAG_BITS: ReadonlyMap<string, number> = new Map(
  FILE_BITS.map(([bit, name]) => [name, bit]),
);
export const SCRIPT_FLAG_BITS: ReadonlyMap<string, number> = new Map(
  SCRIPT_BITS.map(([bit, name]) => [name, bit]),
);
