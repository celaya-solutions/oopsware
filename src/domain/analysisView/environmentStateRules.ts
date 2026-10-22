import { canonicalJson } from "../comparisonSemantics.js";
import type { JsonValue } from "../jsonValue.js";
import { ENTRY_BYTES, textBytes } from "./webNetworkRouteTemplates.js";

/** How records are ordered: by recorded start time, or by record order when any start time is missing. */
export type StateTimeline = "recorded-start-time" | "record-order";

/** What extraction reads of one primary-origin record; times are timeline coordinates. */
export interface StateRecordFacts {
  readonly ordinal: number;
  readonly method: string;
  readonly path: string;
  /** WHATWG query spelling including `?`, or undefined when the request had none. */
  readonly query: string | undefined;
  readonly status: number | null;
  readonly start: number;
  readonly end: number;
}

/** The manifest tool facts extraction uses. */
export interface StateToolFacts {
  readonly name: string;
  readonly method: string;
  readonly path_template: string;
  readonly record_ordinals: readonly number[];
}

/** A record's response body as JSON, or unusable when absent, cut, not JSON or not exactly representable. */
export type ParsedBody =
  | { readonly kind: "json"; readonly value: JsonValue }
  | { readonly kind: "unusable" };

/** Budgeted access the accumulator lends extraction; null and false mean the budget is exhausted. */
export interface StateBudget {
  readonly body: (ordinal: number) => ParsedBody | null;
  readonly retain: (bytes: number) => boolean;
  /** Drop the temporary work of the body just read. */
  readonly release: () => void;
}

export type RecordedViewReason =
  | "query-body"
  | "no-init-recording"
  | "body-unusable"
  | "not-entity"
  | "no-identity"
  | "query-varies"
  | "fields-differ"
  | "envelope-varies"
  | "list-differs";

export interface StateType {
  readonly collection_template: string;
  readonly id_field: string;
  readonly id_basis: "path-parameter" | "field-name";
  readonly init_before_ordinal: number | null;
  readonly volatile_fields: string[];
}

export type JsonObject = Record<string, JsonValue>;

export interface StateEntity {
  readonly type: string;
  readonly collection: string;
  readonly id: string;
  readonly fields: JsonObject;
  readonly view_fields: {
    readonly tool: string;
    readonly fields: JsonObject;
  }[];
  readonly record_ordinals: number[];
}

export interface StateDocument {
  readonly tool: string;
  readonly path: string;
  readonly value: JsonValue;
  readonly record_ordinal: number;
}

interface EntityViewPlan {
  readonly tool: string;
  readonly type: string;
  readonly pointer: string;
  readonly fields: string[];
  readonly required_fields: string[];
  readonly checked_record_ordinals: number[];
}

export type StateItemView = EntityViewPlan & {
  readonly shape: "item";
  readonly envelope_ordinal: number;
};

export type StateListView = EntityViewPlan & {
  readonly shape: "list";
  readonly membership: "all" | "recorded";
  readonly counters: string[];
};

export type StateView =
  | StateItemView
  | StateListView
  | {
      readonly tool: string;
      readonly shape: "document";
      readonly checked_record_ordinals: number[];
    }
  | {
      readonly tool: string;
      readonly shape: "recorded";
      readonly reason: RecordedViewReason;
    };

export interface ExtractedState {
  readonly types: StateType[];
  readonly entities: StateEntity[];
  readonly documents: StateDocument[];
  readonly views: StateView[];
}

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/** A POST whose path names one of these segments queries state rather than changing it. */
const QUERY_SEGMENTS = new Set([
  "search",
  "query",
  "list",
  "find",
  "fuzzy",
  "lookup",
  "count",
  "aggregate",
  "stats",
  "_search",
  "_count",
  "_msearch",
]);
/** Identity field names tried, in order, when no path parameter proves one. */
export const IDENTITY_NAMES = [
  "id",
  "uid",
  "uuid",
  "_id",
  "ID",
  "UID",
  "Id",
  "guid",
  "key",
  "slug",
  "name",
];
const VERSION_SEGMENT = /^v\d+(?:\.\d+)*$/u;

export const segmentsOf = (path: string): string[] =>
  path.split("/").filter((segment) => segment.length > 0);
export const isParam = (segment: string): boolean =>
  segment.startsWith("{") && segment.endsWith("}");
export const isObject = (value: JsonValue | undefined): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export const scalarText = (value: JsonValue | undefined): string | undefined =>
  typeof value === "string"
    ? value
    : typeof value === "number"
      ? String(value)
      : undefined;
/** Equal JSON values; object member order carries no meaning. */
export const same = (
  left: JsonValue | undefined,
  right: JsonValue | undefined,
): boolean =>
  left === undefined || right === undefined
    ? left === right
    : canonicalJson(left, "Environment state") ===
      canonicalJson(right, "Environment state");

/** The decoded final path segment, which an item request names its entity by. */
export const lastSegmentValue = (path: string): string => {
  const segment = segmentsOf(path).at(-1) ?? "";
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

/** A path's non-empty segments, so a trailing slash names the same collection. */
export const normalizedPath = (path: string): string =>
  `/${segmentsOf(path).join("/")}`;

/** An item record's collection is its path without the identity segment; a list record's is its path. */
export const collectionPathOf = (
  record: StateRecordFacts,
  item: boolean,
): string =>
  item
    ? `/${segmentsOf(record.path).slice(0, -1).join("/")}`
    : normalizedPath(record.path);

/** A POST whose path names a query segment observes state rather than changing it. */
export const isQueryPost = (method: string, path: string): boolean =>
  method === "POST" &&
  segmentsOf(path).some((segment) => QUERY_SEGMENTS.has(segment.toLowerCase()));

/** Whether a record may change state: a successful or unanswered write that is not a query POST. */
export const isStateWrite = (record: StateRecordFacts): boolean =>
  WRITE_METHODS.has(record.method) &&
  !isQueryPost(record.method, record.path) &&
  (record.status === null || (record.status >= 200 && record.status < 400));

/** Whether any write overlaps the span from one record's start to a later record's end; writes come in timeline order. */
export const writeSpanCheck = (
  writes: readonly StateRecordFacts[],
): ((earlier: StateRecordFacts, later: StateRecordFacts) => boolean) => {
  // The latest end among each prefix of writes, so one search answers a span.
  const reach: number[] = [];
  for (const write of writes)
    reach.push(Math.max(reach.at(-1) ?? Number.NEGATIVE_INFINITY, write.end));
  return (earlier, later) => {
    let low = 0;
    let high = writes.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (writes[middle]!.start < later.end) low = middle + 1;
      else high = middle;
    }
    return low > 0 && reach[low - 1]! > earlier.start;
  };
};

/** Literal leading segments shared by every template with the same first segment: each path's API base. */
export const apiBaseLengths = (
  templates: readonly string[],
): ReadonlyMap<string, number> => {
  const groups = new Map<string, string[][]>();
  for (const template of templates) {
    const segments = segmentsOf(template);
    const first = segments[0] ?? "";
    const group = groups.get(first);
    if (group === undefined) groups.set(first, [segments]);
    else group.push(segments);
  }
  return new Map(
    [...groups.entries()].map(([first, members]) => {
      const head = members[0] ?? [];
      let length = 0;
      while (
        length < head.length &&
        !isParam(head[length]!) &&
        members.every((segments) => segments[length] === head[length])
      )
        length += 1;
      return [first, length];
    }),
  );
};

/** The path's API base, then any version segments, then one segment: the scope a write may affect. */
export const rootOf = (
  path: string,
  bases: ReadonlyMap<string, number>,
): string[] => {
  const segments = segmentsOf(path);
  let end = Math.min(bases.get(segments[0] ?? "") ?? 0, segments.length);
  while (end < segments.length && VERSION_SEGMENT.test(segments[end]!))
    end += 1;
  return segments.slice(0, end + 1);
};

/** Value bytes as retained state, charged before a value is kept. */
export const jsonBytes = (value: JsonValue): number => {
  if (typeof value === "string") return textBytes(value.length);
  if (Array.isArray(value))
    return value.reduce<number>(
      (sum, item) => sum + jsonBytes(item),
      ENTRY_BYTES,
    );
  if (isObject(value))
    return Object.entries(value).reduce<number>(
      (sum, [name, item]) => sum + textBytes(name.length) + jsonBytes(item),
      ENTRY_BYTES,
    );
  return ENTRY_BYTES;
};

/** JSON parsers keep a `__proto__` member that plain object construction would turn into a prototype. */
export const hasPrototypeKey = (value: JsonValue): boolean =>
  Array.isArray(value)
    ? value.some(hasPrototypeKey)
    : isObject(value) &&
      Object.entries(value).some(
        ([name, item]) => name === "__proto__" || hasPrototypeKey(item),
      );

export const pointerTo = (name: string): string =>
  `/${name.replaceAll("~", "~0").replaceAll("/", "~1")}`;
const pointerName = (pointer: string): string =>
  pointer.slice(1).replaceAll("~1", "/").replaceAll("~0", "~");

/** The value at a pointer of depth at most one. */
export const at = (body: JsonValue, pointer: string): JsonValue | undefined => {
  if (pointer === "") return body;
  if (!isObject(body)) return undefined;
  const name = pointerName(pointer);
  return Object.hasOwn(body, name) ? body[name] : undefined;
};

/** A copy of `body` with the value at a pointer of depth at most one replaced. */
export const replaceAt = (
  body: JsonValue,
  pointer: string,
  value: JsonValue,
): JsonValue => {
  if (pointer === "" || !isObject(body)) return value;
  const name = pointerName(pointer);
  return Object.fromEntries(
    Object.entries(body).map(([key, item]) => [
      key,
      key === name ? value : item,
    ]),
  );
};

const matchingKeys = (object: JsonObject, value: string): string[] =>
  Object.keys(object).filter((key) => scalarText(object[key]) === value);

/** The entity object an item response carries, at the root or in one wrapper property, with the keys repeating its path value. */
export const locateItem = (
  body: JsonValue,
  value: string,
): { readonly pointer: string; readonly keys: string[] } | undefined => {
  if (!isObject(body)) return undefined;
  const root = matchingKeys(body, value);
  if (root.length > 0) return { pointer: "", keys: root };
  const wrapped = Object.entries(body).flatMap(([name, item]) => {
    if (!isObject(item)) return [];
    const keys = matchingKeys(item, value);
    return keys.length > 0 ? [{ pointer: pointerTo(name), keys }] : [];
  });
  return wrapped.length === 1 ? wrapped[0] : undefined;
};

/** Whether every item carries `name` as a distinct string or number. */
export const identifies = (
  items: readonly JsonObject[],
  name: string,
): boolean => {
  const values = items.map((item) => scalarText(item[name]));
  return (
    values.every((value) => value !== undefined) &&
    new Set(values).size === values.length
  );
};

/** The array of entity objects a list response carries, at the root or in one property of an envelope that is not itself an entity. */
export const locateList = (
  body: JsonValue,
  idField: string | undefined,
): string | undefined => {
  if (Array.isArray(body)) return body.every(isObject) ? "" : undefined;
  if (
    !isObject(body) ||
    IDENTITY_NAMES.some((name) => scalarText(body[name]) !== undefined)
  )
    return undefined;
  const arrays = Object.entries(body).filter(
    (entry): entry is [string, JsonObject[]] =>
      Array.isArray(entry[1]) && entry[1].every(isObject),
  );
  const carrying = arrays.filter(
    ([, items]) =>
      items.length > 0 &&
      (idField === undefined
        ? IDENTITY_NAMES.some((name) => identifies(items, name))
        : identifies(items, idField)),
  );
  const chosen =
    carrying.length === 1
      ? carrying[0]
      : carrying.length === 0 && arrays.length === 1
        ? arrays[0]
        : undefined;
  return chosen === undefined ? undefined : pointerTo(chosen[0]);
};

export const listItems = (
  body: JsonValue,
  pointer: string,
): JsonObject[] | undefined => {
  const items = at(body, pointer);
  return Array.isArray(items) && items.every(isObject) ? items : undefined;
};

/** One entity as a view shows it: the view's fields it has, view-specific values first; volatile fields take `observed` values when given. */
export const renderStateEntity = (
  entity: StateEntity,
  view: Pick<EntityViewPlan, "tool" | "fields">,
  volatileFields: ReadonlySet<string>,
  observed?: JsonObject,
): JsonObject => {
  const own =
    entity.view_fields.find((candidate) => candidate.tool === view.tool)
      ?.fields ?? {};
  return Object.fromEntries(
    view.fields.flatMap((name): [string, JsonValue][] => {
      const source =
        observed !== undefined && volatileFields.has(name)
          ? observed
          : Object.hasOwn(own, name)
            ? own
            : entity.fields;
      return Object.hasOwn(source, name) ? [[name, source[name]!]] : [];
    }),
  );
};

/** A list response rendered from `base`: its array replaced by `items` and its counters set to their number. */
export const renderStateList = (
  view: Pick<StateListView, "pointer" | "counters">,
  base: JsonValue,
  items: readonly JsonObject[],
): JsonValue =>
  view.counters.reduce(
    (body, name) => replaceAt(body, pointerTo(name), items.length),
    replaceAt(base, view.pointer, [...items]),
  );
