import { formatEntry } from "../domain/formatRegistry.js";
import type { FormatId } from "../domain/formatIdentifiers.js";
import type { WalkedPiece } from "../domain/identification/identification.js";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** A piece while the walk still fills it in. */
export type Piece = Mutable<WalkedPiece>;

/** Thrown inside the walk when the entry budget is spent; caught at the top. */
export class EntryLimit extends Error {}

export const message = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** A member's logical path below its container's. */
export const joinPath = (parent: string, child: string): string =>
  parent === "" ? child : `${parent}/${child}`;

/** Set a piece's format with its basis and registry label together. */
export const setFormat = (
  piece: Piece,
  format: FormatId | null,
  basis: Piece["format_basis"],
): void => {
  piece.format = format;
  piece.format_basis = format === null ? null : basis;
  piece.label = format === null ? null : formatEntry(format).label;
};
