import type { OfficeCell } from "../../domain/officeDocument/officeDocument.js";
import type { ReaderCounters } from "../reader.js";
import { cellClip } from "./xlsCells.js";
import {
  decodeFormula,
  type DecodedFormula,
  type FormulaContext,
} from "./xlsFormula.js";
import { cellName, RT } from "./xlsRecords.js";

/**
 * The formula of each FORMULA record ([MS-XLS] 2.4.127). Its own tokens are
 * decoded; a record whose tokens are only PtgExp or PtgTbl belongs to the
 * shared, array or data-table formula that a SHRFMLA, ARRAY or TABLE record
 * anchored on the cell it names. The anchoring cell gets the text; the others
 * name it in formula_from, as the Open XML reader does for shared formulas.
 */

type FormulaKind = NonNullable<OfficeCell["formula_kind"]>;

export interface FormulaFields {
  readonly formula: string | null;
  readonly kind: FormulaKind;
  readonly from: string | null;
}

export const ANCHORS: ReadonlySet<number> = new Set([
  RT.shrFmla,
  RT.array,
  RT.table,
]);

const u16 = (bytes: Uint8Array, at: number): number =>
  (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);

/** Record data BIFF8 allows ([MS-XLS] 2.1.4); a longer formula record is not one Excel wrote. */
const MAX_RECORD = 8_224;
const OVERSIZED = {
  ok: false,
  ptg: -1,
  reason: `the record is longer than the ${String(MAX_RECORD)} bytes BIFF8 allows`,
} as const;

/** One number per cell (BIFF8 has 256 columns), so the anchor map holds no strings. */
const cellKey = (row: number, col: number): number => row * 256 + col;

export class FormulaCells {
  readonly #counters: ReaderCounters;
  readonly #context: (row: number, col: number) => FormulaContext;
  /** The kind of formula anchored on each cell; only the kind is kept, so memory stays small. */
  readonly #masters = new Map<number, FormulaKind>();
  /** The anchor just read: its formula text goes to the FORMULA record it follows, nowhere else. */
  #pending: {
    readonly key: number;
    readonly decoded: DecodedFormula | null;
  } | null = null;
  #reported = false;

  constructor(
    counters: ReaderCounters,
    context: (row: number, col: number) => FormulaContext,
  ) {
    this.#counters = counters;
    this.#context = context;
  }

  /** A SHRFMLA, ARRAY or TABLE record (its data) that follows the FORMULA of this cell. */
  anchor(type: number, data: Uint8Array, row: number, col: number): void {
    const key = cellKey(row, col);
    if (type === RT.table) {
      this.#masters.set(key, "data-table");
      this.#pending = { key, decoded: null };
      return;
    }
    // SHRFMLA: RefU, reserved, cUse, then cce. ARRAY: RefU, flags, 4 unused bytes, then cce.
    const at = type === RT.shrFmla ? 8 : 12;
    if (data.length < at + 2)
      throw new RangeError("A shared or array formula record is short.");
    const cce = u16(data, at);
    this.#masters.set(key, type === RT.shrFmla ? "shared" : "array");
    this.#pending = {
      key,
      decoded:
        data.length > MAX_RECORD
          ? OVERSIZED
          : at + 2 + cce > data.length
            ? { ok: false, ptg: -1, reason: "the token stream is cut off" }
            : decodeFormula(
                data.subarray(at + 2, at + 2 + cce),
                data.subarray(at + 2 + cce),
                this.#context(row, col),
              ),
    };
  }

  /** The formula fields of a FORMULA record's data for its cell. */
  resolve(row: number, col: number, data: Uint8Array): FormulaFields {
    const pending = this.#pending;
    this.#pending = null;
    const ref = cellName(row, col);
    const cce = u16(data, 20);
    if (data.length > MAX_RECORD) {
      this.#undecoded(ref, OVERSIZED);
      return { formula: null, kind: "normal", from: null };
    }
    if (22 + cce > data.length) {
      this.#undecoded(ref, {
        ptg: -1,
        reason: "the token stream is longer than its record",
      });
      return { formula: null, kind: "normal", from: null };
    }
    const rgce = data.subarray(22, 22 + cce);
    if ((rgce[0] === 0x01 || rgce[0] === 0x02) && rgce.length >= 5)
      return this.#continued(
        { row, col, flags: u16(data, 14) },
        rgce,
        pending?.key === cellKey(row, col) ? pending.decoded : null,
      );
    const decoded = decodeFormula(
      rgce,
      data.subarray(22 + cce),
      this.#context(row, col),
    );
    if (!decoded.ok) {
      this.#undecoded(ref, decoded);
      return { formula: null, kind: "normal", from: null };
    }
    return {
      formula: cellClip(decoded.text, this.#counters),
      kind: "normal",
      from: null,
    };
  }

  /** PtgExp or PtgTbl: row and column of the cell the formula is anchored on. */
  #continued(
    cell: {
      readonly row: number;
      readonly col: number;
      readonly flags: number;
    },
    rgce: Uint8Array,
    own: DecodedFormula | null,
  ): FormulaFields {
    const targetRow = u16(rgce, 1);
    const targetCol = u16(rgce, 3) & 0xff;
    const target = cellName(targetRow, targetCol);
    const kind = this.#masters.get(cellKey(targetRow, targetCol));
    const self = targetRow === cell.row && targetCol === cell.col;
    if (kind === undefined) {
      // fShrFmla (0x0008) tells a shared formula from an array formula.
      const named =
        rgce[0] === 0x02
          ? "data-table"
          : (cell.flags & 0x0008) !== 0
            ? "shared"
            : "array";
      this.#counters.diagnose(
        cellName(cell.row, cell.col),
        `The formula continues the ${named} formula at ${target}, which is not defined before it; its text is not given.`,
      );
      return { formula: null, kind: named, from: self ? null : target };
    }
    if (!self) return { formula: null, kind, from: target };
    if (own !== null && !own.ok) this.#undecoded(target, own);
    return {
      formula: own?.ok === true ? cellClip(own.text, this.#counters) : null,
      kind,
      from: null,
    };
  }

  /** Count a formula left without text; the first one in a sheet is named in a diagnostic. */
  #undecoded(
    ref: string,
    failure: { readonly ptg: number; readonly reason: string },
  ): void {
    this.#counters.omit(
      "undecoded-formulas",
      "Formulas holding a token this reader does not decode keep their cached value; their formula text is not given.",
    );
    if (this.#reported) return;
    this.#reported = true;
    this.#counters.diagnose(
      ref,
      `The formula could not be decoded at token ${failure.ptg < 0 ? "(none)" : `0x${failure.ptg.toString(16).padStart(2, "0")}`}: ${failure.reason}. Its text is left out; later formulas like it are counted in omissions.`,
    );
  }
}
