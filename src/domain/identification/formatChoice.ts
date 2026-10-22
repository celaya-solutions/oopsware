import type { FormatDetection } from "../formatDetection.js";
import type { FormatDimension, FormatId } from "../formatIdentifiers.js";
import { formatEntry } from "../formatRegistry.js";

/** The most specific format a piece's detection supports, and why. */
export interface FormatChoice {
  readonly format: FormatId | null;
  readonly basis: "bytes" | "name" | null;
  readonly candidates: readonly FormatId[];
  readonly nameConflict: string | null;
  /** The best format the bytes alone establish, or null. */
  readonly fallback: FormatId | null;
}

type Candidate = FormatDetection["candidates"][number];

const byBytes = (candidate: Candidate) =>
  candidate.basis !== "name-corroborated";

const first = (
  candidates: readonly Candidate[],
  dimension: FormatDimension,
  bytes: boolean,
): Candidate | undefined =>
  candidates.find(
    (candidate) =>
      candidate.dimension === dimension && byBytes(candidate) === bytes,
  );

/**
 * A format bytes can neither establish nor refute (text profiles) has only
 * its name as evidence; it is used when no byte candidate exists and nothing
 * contradicts the name.
 */
const nameOnly = (detection: FormatDetection): FormatId | undefined =>
  detection.candidates.length > 0 || detection.contradictions.length > 0
    ? undefined
    : detection.name_hint.formats.find(
        (format) => !formatEntry(format).byteSignature,
      );

/**
 * A byte-established package role, then a byte-established semantic profile,
 * then a role or profile the name names on observed storage (contents
 * unchecked), then the storage itself, then a text profile only the name can
 * name. Detection owns every candidate; this only orders them.
 */
export const chooseFormat = (detection: FormatDetection): FormatChoice => {
  const { candidates } = detection;
  const chosen =
    first(candidates, "package-role", true) ??
    first(candidates, "semantic-profile", true) ??
    first(candidates, "package-role", false) ??
    first(candidates, "semantic-profile", false) ??
    first(candidates, "storage", true);
  const named = chosen === undefined ? nameOnly(detection) : undefined;
  return {
    format: chosen?.format ?? named ?? null,
    basis:
      chosen !== undefined
        ? byBytes(chosen)
          ? "bytes"
          : "name"
        : named === undefined
          ? null
          : "name",
    candidates: [
      ...new Set([
        ...candidates.map(({ format }) => format),
        ...(named === undefined ? [] : [named]),
      ]),
    ],
    nameConflict: detection.contradictions[0]?.detail ?? null,
    fallback:
      (
        first(candidates, "package-role", true) ??
        first(candidates, "semantic-profile", true) ??
        first(candidates, "storage", true)
      )?.format ?? null,
  };
};
