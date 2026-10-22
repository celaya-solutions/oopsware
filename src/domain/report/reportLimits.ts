import type { GraphJson } from "../graph/graphModel.js";

/**
 * Finds what a run result says it could not establish. Showing too much is
 * acceptable; missing one is not (spec C.2.6). The Evidence envelope's own
 * limitation and coverage fields are read by schema; everything else is a
 * sweep by field name, labelled so.
 */

export interface LimitItem {
  /** JSON path inside the run result, e.g. `$.normalized_result.unknowns`. */
  readonly path: string;
  readonly value: GraphJson;
  readonly how: "evidence" | "field name";
}

const NAMES = [
  "limitations",
  "unknowns",
  "residual_unknowns",
  "coverage",
  "omissions",
  "diagnostics",
  "warnings",
];

/** Exact names, plus any `<prefix>_<name>` such as `relationship_coverage`. */
export const isLimitField = (key: string): boolean => {
  const name = key.toLowerCase();
  return NAMES.some((item) => name === item || name.endsWith(`_${item}`));
};

// Values walked per result before the sweep gives up and says so.
const SWEEP_BUDGET = 200_000;

const empty = (value: GraphJson): boolean =>
  value === null ||
  (Array.isArray(value) && value.length === 0) ||
  (typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0);

const isObject = (
  value: GraphJson | undefined,
): value is { [key: string]: GraphJson } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const pathKey = (path: string, key: string) =>
  /^[A-Za-z_$][\w$]*$/.test(key)
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`;

/** True when the value has the Evidence envelope shape the dashboard stores. */
export const isEvidenceEnvelope = (
  value: GraphJson,
): value is { [key: string]: GraphJson } =>
  isObject(value) &&
  typeof value.evidence_id === "string" &&
  "normalized_result" in value &&
  isObject(value.provider);

type Entry = { path: string; value: GraphJson };

/** A value's children to walk; limit fields are recorded instead of walked. */
function childrenOf(
  path: string,
  value: GraphJson,
  skip: ReadonlySet<string>,
  items: LimitItem[],
): Entry[] {
  if (Array.isArray(value))
    return value.map((item, i) => ({ path: `${path}[${i}]`, value: item }));
  if (!isObject(value)) return [];
  const children: Entry[] = [];
  for (const [key, item] of Object.entries(value)) {
    const at = pathKey(path, key);
    if (skip.has(at)) continue;
    if (!isLimitField(key)) children.push({ path: at, value: item });
    else if (!empty(item))
      items.push({ path: at, value: item, how: "field name" });
  }
  return children;
}

/** Every limit-like field in a result, envelope fields first. */
export function collectLimits(result: GraphJson): {
  items: LimitItem[];
  /** Set when the sweep stopped early; the rest was not searched. */
  stoppedAfter: number | null;
} {
  const items: LimitItem[] = [];
  const skip = new Set<string>();
  if (isEvidenceEnvelope(result)) {
    for (const key of ["limitations", "relationship_coverage"]) {
      const value = result[key];
      skip.add(`$.${key}`);
      if (value !== undefined && !empty(value))
        items.push({ path: `$.${key}`, value, how: "evidence" });
    }
  }
  let walked = 0;
  let stoppedAfter: number | null = null;
  const stack: Entry[] = [{ path: "$", value: result }];
  // Depth first, in source order: push children reversed.
  while (stack.length > 0) {
    const { path, value } = stack.pop()!;
    if (++walked > SWEEP_BUDGET) {
      stoppedAfter = SWEEP_BUDGET;
      break;
    }
    const children = childrenOf(path, value, skip, items);
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
  }
  return { items, stoppedAfter };
}
