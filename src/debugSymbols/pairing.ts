import { basename } from "node:path";

import { crc32Hex, type DebugImage } from "./image.js";

export type CheckStatus = "matched" | "mismatched" | "unavailable";

export interface PairCheck {
  readonly kind: "format" | "architecture" | "uuid" | "build_id" | "debug_link_crc";
  readonly status: CheckStatus;
  readonly debug: string | null;
  readonly binary: string | null;
  readonly note: string;
}

export interface PairingResult {
  readonly checks: readonly PairCheck[];
  readonly verdict: "matched" | "mismatched" | "unverified";
  /** strong: a unique identifier matched. weak: only the debug link CRC-32 matched. */
  readonly strength: "strong" | "weak" | "none";
  readonly enrichmentAllowed: boolean;
  readonly reason: string;
}

const compare = (
  kind: PairCheck["kind"],
  debug: string | null,
  binary: string | null,
  labels: { readonly present: string; readonly absentDebug: string; readonly absentBinary: string },
): PairCheck => {
  if (debug === null || binary === null)
    return {
      kind,
      status: "unavailable",
      debug,
      binary,
      note: debug === null ? labels.absentDebug : labels.absentBinary,
    };
  return debug.toLowerCase() === binary.toLowerCase()
    ? { kind, status: "matched", debug, binary, note: labels.present }
    : {
        kind,
        status: "mismatched",
        debug,
        binary,
        note: `The identifiers differ.`,
      };
};

/**
 * Decide whether one debug image describes one binary image from their identifiers alone.
 * The file name is never evidence: `debugFile` supplies only the bytes whose CRC-32 a
 * `.gnu_debuglink` records, and the name it records is noted, not trusted.
 */
export const pairImages = (
  debug: DebugImage,
  debugFile: { readonly path: string; readonly bytes: Uint8Array } | null,
  binary: DebugImage,
): PairingResult => {
  const checks: PairCheck[] = [];
  checks.push(
    debug.format === binary.format
      ? {
          kind: "format",
          status: "matched",
          debug: debug.format,
          binary: binary.format,
          note: "Both files use the same container format.",
        }
      : {
          kind: "format",
          status: "mismatched",
          debug: debug.format,
          binary: binary.format,
          note: "An ELF file cannot describe a Mach-O image, or the reverse.",
        },
  );
  checks.push(
    debug.architecture === binary.architecture
      ? {
          kind: "architecture",
          status: "matched",
          debug: debug.architecture,
          binary: binary.architecture,
          note: "Both images are built for the same architecture.",
        }
      : {
          kind: "architecture",
          status: "mismatched",
          debug: debug.architecture,
          binary: binary.architecture,
          note: "The images are built for different architectures.",
        },
  );
  if (debug.format === "mach-o")
    checks.push(
      compare("uuid", debug.identity.uuid, binary.identity.uuid, {
        present: "LC_UUID is the same in both images.",
        absentDebug: "The debug image has no single LC_UUID.",
        absentBinary: "The binary image has no single LC_UUID.",
      }),
    );
  else {
    checks.push(
      compare("build_id", debug.identity.buildId, binary.identity.buildId, {
        present: "The GNU build id is the same in both files.",
        absentDebug: "The debug file carries no single GNU build id.",
        absentBinary: "The binary carries no single GNU build id.",
      }),
    );
    const link = binary.identity.debugLink;
    if (link === null)
      checks.push({
        kind: "debug_link_crc",
        status: "unavailable",
        debug: null,
        binary: null,
        note: "The binary has no .gnu_debuglink section.",
      });
    else if (debugFile === null)
      checks.push({
        kind: "debug_link_crc",
        status: "unavailable",
        debug: null,
        binary: link.crc32,
        note: "The CRC-32 needs the debug file's own bytes.",
      });
    else {
      const computed = crc32Hex(debugFile.bytes);
      const named = basename(debugFile.path) === link.name;
      checks.push({
        kind: "debug_link_crc",
        status: computed === link.crc32 ? "matched" : "mismatched",
        debug: computed,
        binary: link.crc32,
        note:
          (computed === link.crc32
            ? "The debug file's bytes have the CRC-32 the binary recorded."
            : "The debug file's bytes differ from the file the binary recorded; recompression or a different build changes the CRC-32.") +
          (named
            ? ""
            : ` The binary names ${JSON.stringify(link.name)}; a name is not evidence either way.`),
      });
    }
  }

  const strongKinds = ["uuid", "build_id"] as const;
  const strong = checks.filter((check) =>
    (strongKinds as readonly string[]).includes(check.kind),
  );
  const crc = checks.find((check) => check.kind === "debug_link_crc");
  const structural = checks.filter(
    (check) => check.kind === "format" || check.kind === "architecture",
  );
  const mismatch =
    structural.find((check) => check.status === "mismatched") ??
    strong.find((check) => check.status === "mismatched");
  if (mismatch !== undefined)
    return {
      checks,
      verdict: "mismatched",
      strength: "none",
      enrichmentAllowed: false,
      reason: `The ${mismatch.kind.replace("_", " ")} check failed: debug ${mismatch.debug ?? "none"} against binary ${mismatch.binary ?? "none"}.`,
    };
  if (strong.some((check) => check.status === "matched"))
    return {
      checks,
      verdict: "matched",
      strength: "strong",
      enrichmentAllowed: true,
      reason: "A unique identifier is the same in the debug file and the binary.",
    };
  if (crc?.status === "matched")
    return {
      checks,
      verdict: "matched",
      strength: "weak",
      enrichmentAllowed: true,
      reason:
        "Only the debug link CRC-32 matched. A CRC-32 can collide; a build id is the stronger identifier.",
    };
  return {
    checks,
    verdict: crc?.status === "mismatched" ? "mismatched" : "unverified",
    strength: "none",
    enrichmentAllowed: false,
    reason:
      crc?.status === "mismatched"
        ? "The debug link CRC-32 does not match and no unique identifier is available."
        : "Neither file carries an identifier both can be checked on; a same-named file is not a match.",
  };
};
