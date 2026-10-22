import type { DocumentSegment } from "../../domain/document/structuredText.js";
import type { SourceText } from "./SourceText.js";

/** Preferred reading page size in original bytes. */
export const SEGMENT_TARGET_BYTES = 16 * 1024;
/** A single unit up to this size stays whole instead of being split. */
export const SEGMENT_MAXIMUM_BYTES = 64 * 1024;

/** Ascending, unique boundaries inside the text, ending with its length. */
const sortedBoundaries = (values: readonly number[], length: number) => {
  // Walkers record starts in source order, so this is one linear pass; a
  // sort only runs if that ever stops holding.
  let ordered = true;
  for (let index = 1; index < values.length && ordered; index += 1)
    ordered = (values[index - 1] ?? 0) <= (values[index] ?? 0);
  const source = ordered
    ? values
    : [...values].sort((left, right) => left - right);
  const boundaries: number[] = [];
  for (const value of source)
    if (value > 0 && value < length && boundaries.at(-1) !== value)
      boundaries.push(value);
  boundaries.push(length);
  return boundaries;
};

/** First index in `boundaries` greater than `position`. */
const after = (boundaries: readonly number[], position: number): number => {
  let low = 0;
  let high = boundaries.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((boundaries[middle] ?? 0) <= position) low = middle + 1;
    else high = middle;
  }
  return low;
};

/** Farthest boundary after `start` whose byte offset stays within `limit`. */
const farthestWithin = (
  source: SourceText,
  boundaries: readonly number[],
  start: number,
  limit: number,
): number | undefined => {
  let low = after(boundaries, start);
  let high = boundaries.length - 1;
  let found: number | undefined;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const boundary = boundaries[middle] ?? 0;
    if (source.byteOffset(boundary) <= limit) {
      found = boundary;
      low = middle + 1;
    } else high = middle - 1;
  }
  return found;
};

/**
 * Split decoded text into reading pages that end on the format's own unit
 * boundaries (Markdown block, record, row, YAML document, line). A unit
 * larger than the maximum falls back to line boundaries, then to bytes, and
 * the page says so.
 */
export const documentSegments = (
  source: SourceText,
  unitStarts: readonly number[],
  unit: DocumentSegment["unit"],
): DocumentSegment[] => {
  const { text } = source;
  const lines = sortedBoundaries(source.lineStarts, text.length);
  // Line-unit formats use the decoded line starts as their units.
  const units =
    unit === "line" ? lines : sortedBoundaries(unitStarts, text.length);
  const isUnitStart = (position: number) =>
    position === 0 || units[after(units, position - 1)] === position;
  const segments: DocumentSegment[] = [];
  let start = 0;
  while (start < text.length) {
    const startByte = source.byteOffset(start);
    let end = farthestWithin(
      source,
      units,
      start,
      startByte + SEGMENT_TARGET_BYTES,
    );
    let kind = unit;
    if (end === undefined) {
      const nextUnit = units[after(units, start)] ?? text.length;
      if (source.byteOffset(nextUnit) - startByte <= SEGMENT_MAXIMUM_BYTES)
        end = nextUnit;
    }
    if (end === undefined && unit !== "line") {
      kind = "line";
      end =
        farthestWithin(
          source,
          lines,
          start,
          startByte + SEGMENT_TARGET_BYTES,
        ) ??
        (() => {
          const nextLine = lines[after(lines, start)] ?? text.length;
          return source.byteOffset(nextLine) - startByte <=
            SEGMENT_MAXIMUM_BYTES
            ? nextLine
            : undefined;
        })();
    }
    if (end === undefined) {
      kind = "bytes";
      // One very long line: cut near the target without splitting a surrogate pair.
      let cut = start;
      while (
        cut < text.length &&
        source.byteOffset(cut) - startByte < SEGMENT_TARGET_BYTES
      )
        cut = Math.min(text.length, cut + 256);
      const code = text.charCodeAt(cut - 1);
      if (cut < text.length && code >= 0xd800 && code <= 0xdbff) cut -= 1;
      end = Math.max(cut, start + 1);
    }
    segments.push({
      index: segments.length,
      start: startByte,
      end: source.byteOffset(end),
      first_line: source.lineIndex(start) + 1,
      last_line: source.lineIndex(Math.max(start, end - 1)) + 1,
      unit: kind,
      complete_units:
        kind === unit &&
        isUnitStart(start) &&
        (end === text.length || isUnitStart(end)),
    });
    start = end;
  }
  return segments;
};
