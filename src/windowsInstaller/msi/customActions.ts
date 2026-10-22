import type { MsiDatabase, MsiValue } from "./database.js";

/**
 * Custom action types and sequence tables, decoded from the Windows
 * Installer SDK's "Summary List of All Custom Action Types" and the option
 * pages it links (return processing, execution scheduling, in-script
 * execution, hidden target, patch uninstall; msidefs.h msidbCustomActionType*).
 * The low three bits name the code kind, bits 4-5 the source, and the
 * rest how and when it runs. Conditions are kept as written, never evaluated.
 */

export interface MsiSequenceAction {
  readonly action: string;
  readonly condition: string | null;
  readonly sequence: number | null;
}

export interface MsiSequence {
  readonly table: string;
  readonly actions: readonly MsiSequenceAction[];
}

export interface MsiCustomAction {
  readonly id: string;
  readonly type: number;
  /** What Source and Target mean for this type (see SOURCE_KINDS). */
  readonly source_kind: string;
  /** "jscript" or "vbscript" for script kinds, else null. */
  readonly script: "jscript" | "vbscript" | null;
  readonly source: string | null;
  readonly target: string | null;
  readonly extended_type: number | null;
  readonly execution: readonly string[];
  readonly scheduled: readonly {
    readonly table: string;
    readonly sequence: number | null;
    readonly condition: string | null;
  }[];
}

/**
 * Indexed by (type & 0x07) then (type & 0x30) >> 4: binary stream, installed
 * file, directory, property. Types 1, 2, 5, 6 (binary), 17, 18, 21, 22 (file),
 * 34, 37, 38 (directory / text), 50, 51, 53, 54 (property), 19 (error), 35
 * (set directory), 7, 23, 39 (nested installs). Other combinations are not
 * defined and read as "undefined-<type & 0x37>".
 */
const SOURCE_KINDS: readonly (readonly (string | null)[])[] = [
  [null, null, null, null],
  ["dll-in-binary", "dll-installed-file", null, null],
  [
    "exe-in-binary",
    "exe-installed-file",
    "exe-in-directory",
    "exe-from-property",
  ],
  [null, "error-message", "set-directory", "set-property"],
  [null, null, null, null],
  [
    "script-in-binary",
    "script-installed-file",
    "script-text",
    "script-from-property",
  ],
  [
    "script-in-binary",
    "script-installed-file",
    "script-text",
    "script-from-property",
  ],
  [
    "nested-install",
    "nested-install-source",
    "nested-install-advertised",
    null,
  ],
];

const IN_SCRIPT = 0x400;

/** Return, scheduling and in-script options; scheduling bits 0x100/0x200 change meaning with in-script. */
export const customActionExecution = (
  type: number,
  extended: number | null,
): string[] => {
  const out: string[] = [];
  const inScript = (type & IN_SCRIPT) !== 0;
  const timing = type & 0x300;
  if (inScript)
    out.push(
      timing === 0x100
        ? "rollback"
        : timing === 0x200
          ? "commit"
          : timing === 0x300
            ? "rollback+commit"
            : "deferred",
      "in-script",
    );
  else {
    out.push("immediate");
    if (timing === 0x100) out.push("first-sequence");
    else if (timing === 0x200) out.push("once-per-process");
    else if (timing === 0x300) out.push("client-repeat");
  }
  if ((type & 0x800) !== 0) out.push("no-impersonate");
  if ((type & 0x80) !== 0) out.push("async");
  if ((type & 0x40) !== 0) out.push("continue-on-error");
  if ((type & 0x1000) !== 0) out.push("64-bit-script");
  if ((type & 0x2000) !== 0) out.push("hide-target");
  if ((type & 0x4000) !== 0) out.push("ts-aware");
  if (extended !== null && (extended & 0x8000) !== 0)
    out.push("patch-uninstall");
  const unknown =
    (type & (~0x7fff | 0x8)) | (extended === null ? 0 : extended & ~0x8000);
  if (unknown !== 0) out.push(`0x${(unknown >>> 0).toString(16)}`);
  return out;
};

export const customActionSource = (
  type: number,
): { kind: string; script: "jscript" | "vbscript" | null } => {
  const code = type & 0x07;
  const kind = SOURCE_KINDS[code]?.[(type & 0x30) >> 4] ?? null;
  return {
    kind: kind ?? `undefined-${String(type & 0x37)}`,
    script:
      kind !== null && (code === 5 || code === 6)
        ? code === 5
          ? "jscript"
          : "vbscript"
        : null,
  };
};

const text = (value: MsiValue | undefined): string | null =>
  typeof value === "string" ? value : null;
const integer = (value: MsiValue | undefined): number | null =>
  typeof value === "number" ? value : null;

/** Every table named *Sequence with an Action column, actions ordered by sequence (nulls last). */
export const readSequences = (database: MsiDatabase): MsiSequence[] => {
  const sequences: MsiSequence[] = [];
  for (const [name, table] of database.tables) {
    if (
      !name.endsWith("Sequence") ||
      !table.columns.some((column) => column.name === "Action")
    )
      continue;
    const actions = database
      .rows(name)
      .map((row) => ({
        action: text(row.Action) ?? "",
        condition: text(row.Condition),
        sequence: integer(row.Sequence),
      }))
      .map((action, index) => ({ action, index }))
      .sort((left, right) =>
        left.action.sequence === right.action.sequence
          ? left.index - right.index
          : left.action.sequence === null
            ? 1
            : right.action.sequence === null
              ? -1
              : left.action.sequence - right.action.sequence,
      )
      .map(({ action }) => Object.freeze(action));
    sequences.push(
      Object.freeze({ table: name, actions: Object.freeze(actions) }),
    );
  }
  return sequences;
};

export const readCustomActions = (
  database: MsiDatabase,
  sequences: readonly MsiSequence[],
): MsiCustomAction[] =>
  database.rows("CustomAction").map((row) => {
    const id = text(row.Action) ?? "";
    const type = integer(row.Type) ?? 0;
    const extended = integer(row.ExtendedType);
    const source = customActionSource(type);
    return Object.freeze({
      id,
      type,
      source_kind: source.kind,
      script: source.script,
      source: text(row.Source),
      target: text(row.Target),
      extended_type: extended,
      execution: Object.freeze(customActionExecution(type, extended)),
      scheduled: Object.freeze(
        sequences.flatMap((sequence) =>
          sequence.actions
            .filter((action) => action.action === id)
            .map((action) =>
              Object.freeze({
                table: sequence.table,
                sequence: action.sequence,
                condition: action.condition,
              }),
            ),
        ),
      ),
    });
  });
