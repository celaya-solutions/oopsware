import {
  isMap,
  isNode,
  isScalar,
  isSeq,
  parseDocument,
  Document,
  Schema,
  type ParsedNode,
  type Node,
  type ScalarTag,
  type Tags,
} from "yaml";

const SOURCE_SCALAR_TAGS = new Set([
  "tag:yaml.org,2002:int",
  "tag:yaml.org,2002:float",
  "tag:yaml.org,2002:timestamp",
]);

// Hermes's ruamel reader resolves dates even with an explicit YAML 1.2 directive.
const timestampTag = new Schema({ schema: "yaml-1.1" }).tags.find(
  (tag): tag is ScalarTag =>
    tag.tag === "tag:yaml.org,2002:timestamp" && tag.collection === undefined,
);
if (timestampTag === undefined)
  throw new Error("The YAML 1.1 schema must provide its timestamp tag");

type HermesKey =
  | { readonly kind: "numeric"; readonly value: bigint | number }
  | { readonly kind: "timestamp"; readonly value: string }
  | { readonly kind: "other"; readonly value: unknown };

const timestampSource =
  /^(\d{4})-(\d{1,2})-(\d{1,2})(?:(?:[Tt]|[ \t]+)(\d{1,2}):(\d{2}):(\d{2})(?:\.([0-9]*))?(?:[ \t]*(Z|([-+])(\d{1,2})(?::(\d{2}))?))?)?$/;

const hermesTimestampImplicit =
  /^(?:\d{4}-\d{2}-\d{2}|\d{4}-\d{1,2}-\d{1,2}(?:[Tt]|[ \t]+)\d{1,2}:\d{2}:\d{2}(?:\.[0-9]*)?(?:[ \t]*(?:Z|[-+]\d{1,2}(?::\d{2})?))?)$/;

interface HermesTimestampFacts {
  readonly key: string;
  readonly value: Date;
}

const floorDivide = (value: number, divisor: number): number =>
  Math.floor(value / divisor);

/** Days since 1970-01-01 using the proleptic Gregorian calendar. */
const civilDay = (year: number, month: number, day: number): number => {
  const adjustedYear = year - (month <= 2 ? 1 : 0);
  const era = floorDivide(adjustedYear, 400);
  const yearOfEra = adjustedYear - era * 400;
  const adjustedMonth = month + (month > 2 ? -3 : 9);
  const dayOfYear = floorDivide(153 * adjustedMonth + 2, 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 +
    floorDivide(yearOfEra, 4) -
    floorDivide(yearOfEra, 100) +
    dayOfYear;
  return era * 146097 + dayOfEra - 719468;
};

/** Parse the exact timestamp forms and values accepted by ruamel's safe loader. */
const parseHermesTimestamp = (
  source: string,
): HermesTimestampFacts | undefined => {
  const match = timestampSource.exec(source);
  if (match === null) return undefined;
  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    fraction,
    zone,
    sign,
    zoneHourText,
    zoneMinuteText,
  ] = match;
  if (
    yearText === undefined ||
    monthText === undefined ||
    dayText === undefined
  )
    return undefined;
  const year = Number(yearText);
  const month = Number(monthText);
  const dayOfMonth = Number(dayText);
  if (year < 1 || year > 9999 || month < 1 || month > 12) return undefined;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (dayOfMonth < 1 || dayOfMonth > (monthDays[month - 1] ?? 0))
    return undefined;
  const date = `${yearText}-${monthText.padStart(2, "0")}-${dayText.padStart(2, "0")}`;
  const day = civilDay(year, month, dayOfMonth);
  if (hourText === undefined) {
    const micros = BigInt(day) * 86_400_000_000n;
    return { key: `date:${date}`, value: new Date(Number(micros / 1000n)) };
  }

  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (hour > 23 || minute > 59 || second > 59) return undefined;
  const zoneHour = Number(zoneHourText ?? 0);
  const zoneMinute = Number(zoneMinuteText ?? 0);
  if (zoneHour > 23 || zoneMinute > 59) return undefined;

  let microseconds = 0;
  if (fraction !== undefined && fraction.length > 0) {
    microseconds = Number((fraction.slice(0, 6) + "000000").slice(0, 6));
    if (fraction.length > 6 && Number(fraction[6]) > 4) microseconds += 1;
  }
  const wholeSeconds = hour * 3600 + minute * 60 + second;
  if (
    year === 9999 &&
    month === 12 &&
    dayOfMonth === 31 &&
    wholeSeconds === 86_399 &&
    microseconds === 1_000_000
  )
    return undefined;
  let micros =
    BigInt(day) * 86_400_000_000n +
    BigInt(wholeSeconds) * 1_000_000n +
    BigInt(microseconds);
  if (zone !== undefined && zone !== "Z") {
    const offset = (zoneHour * 60 + zoneMinute) * (sign === "+" ? 1 : -1);
    micros -= BigInt(offset) * 60_000_000n;
  }
  return {
    key:
      zone === undefined
        ? `datetime-local:${micros}`
        : `datetime-utc:${micros}`,
    value: new Date(Number(micros / 1000n - (micros % 1000n < 0n ? 1n : 0n))),
  };
};

const numericValue = (value: unknown): bigint | number | undefined => {
  if (typeof value === "boolean") return value ? 1n : 0n;
  if (typeof value === "bigint" || typeof value === "number") return value;
  return undefined;
};

const numericValuesEqual = (
  left: bigint | number,
  right: bigint | number,
): boolean => {
  if (typeof left === "bigint" && typeof right === "bigint")
    return left === right;
  if (typeof left === "number" && typeof right === "number")
    return left === right || (Number.isNaN(left) && Number.isNaN(right));
  const integer = typeof left === "bigint" ? left : right;
  const number = typeof left === "number" ? left : right;
  return (
    Number.isFinite(number) &&
    Number.isInteger(number) &&
    BigInt(number) === integer
  );
};

const sameResolvedScalarValue = (left: unknown, right: unknown): boolean =>
  Object.is(left, right) ||
  (left instanceof Date &&
    right instanceof Date &&
    left.getTime() === right.getTime());

/**
 * Write a parsed scalar with its source spelling while that spelling still
 * reads as the node's value. Hermes reads config.yaml as YAML 1.1 with exact
 * integers, so re-printing a JavaScript number changes what it reads: a
 * Discord channel ID loses its low digits, `0600` (octal) becomes `600`, and
 * `0.0000001` becomes `1e-7`, which YAML 1.1 does not define as a float.
 * Timestamp source also retains precision and offsets absent from JS Dates.
 */
const keepScalarSource = (tag: Tags[number]): Tags[number] => {
  if (typeof tag === "string" || tag.collection !== undefined) return tag;
  const { stringify } = tag;
  if (!SOURCE_SCALAR_TAGS.has(tag.tag) || stringify === undefined) return tag;
  return {
    ...tag,
    stringify: (item, context, ...rest) => {
      const { source } = item;
      if (source === undefined) return stringify(item, context, ...rest);
      const reader = context.doc.schema.tags.find(
        (candidate): candidate is ScalarTag =>
          candidate.default === true && candidate.test?.test(source) === true,
      );
      const read = reader?.resolve(
        source,
        () => undefined,
        context.doc.options,
      );
      return sameResolvedScalarValue(
        isScalar(read) ? read.value : read,
        item.value,
      )
        ? source
        : stringify(item, context, ...rest);
    },
  };
};

const createHermesYamlOptions = () => {
  const timestamps = new Map<string, HermesTimestampFacts | undefined>();
  const timestampFacts = (source: string): HermesTimestampFacts | undefined => {
    if (timestamps.has(source)) return timestamps.get(source);
    const facts = parseHermesTimestamp(source);
    timestamps.set(source, facts);
    return facts;
  };
  const hermesTimestampTag: ScalarTag = {
    ...timestampTag,
    test: hermesTimestampImplicit,
    resolve: (source) => {
      const facts = timestampFacts(source);
      if (facts === undefined)
        throw new Error(`Invalid Hermes YAML timestamp: ${source}`);
      return facts.value;
    },
  };
  const keyFacts = new WeakMap<object, HermesKey>();
  const hermesKey = (node: ParsedNode): HermesKey => {
    const cached = keyFacts.get(node);
    if (cached !== undefined) return cached;
    if (!isScalar(node)) return { kind: "other", value: node };
    const numeric = numericValue(node.value);
    const key =
      numeric !== undefined
        ? { kind: "numeric" as const, value: numeric }
        : node.value instanceof Date
          ? {
              kind: "timestamp" as const,
              value:
                timestampFacts(node.source ?? "")?.key ??
                `invalid:${node.source ?? ""}`,
            }
          : { kind: "other" as const, value: node.value };
    keyFacts.set(node, key);
    return key;
  };
  /** Python dict key equality is Hermes' duplicate-key behavior (bool is int). */
  const hermesKeysEqual = (
    leftNode: ParsedNode,
    rightNode: ParsedNode,
  ): boolean => {
    const left = hermesKey(leftNode);
    const right = hermesKey(rightNode);
    if (left.kind !== right.kind) return false;
    if (left.kind === "numeric" && right.kind === "numeric")
      return numericValuesEqual(left.value, right.value);
    return left.value === right.value;
  };
  return {
    // Hermes defaults to YAML 1.1; an explicit document directive still wins.
    // Use the same schema to interpret existing values and quote new strings.
    version: "1.1" as const,
    // Keep integer key identity exact; parseHermesConfigurationYaml's reviver
    // restores the existing number-valued consumer contract.
    intAsBigInt: true,
    customTags: (tags: Tags) => {
      const hasTimestamp = tags.some(
        (tag) => typeof tag !== "string" && tag.tag === timestampTag.tag,
      );
      const withHermesTimestamp = hasTimestamp
        ? tags.map((tag) =>
            typeof tag !== "string" && tag.tag === timestampTag.tag
              ? hermesTimestampTag
              : tag,
          )
        : [...tags, hermesTimestampTag];
      return withHermesTimestamp.map(keepScalarSource);
    },
    uniqueKeys: hermesKeysEqual,
  };
};

/** Create a Hermes config using the same scalar rules as edits and readback. */
export const stringifyHermesConfigurationYaml = (
  document: Record<string, unknown>,
): string =>
  new Document(document, createHermesYamlOptions()).toString({ lineWidth: 0 });

// A comment-only document has no root; a bare marker has an unwritten null
// scalar. Explicit null values, tags and anchors remain actual values.
const isEmptyYamlRoot = (root: Document["contents"]): boolean =>
  root === null ||
  (isScalar(root) &&
    root.value === null &&
    root.source === "" &&
    root.tag === undefined &&
    root.anchor === undefined);

const parseHermesDocument = (text: string) => {
  const document = parseDocument(text, createHermesYamlOptions());
  const error = document.errors[0];
  if (error !== undefined) throw error;
  return document;
};

/** Parse a Hermes `config.yaml`, preserving the distinction between no root and explicit null. */
export const parseHermesConfigurationYaml = (text: string): unknown => {
  const document = parseHermesDocument(text);
  return isEmptyYamlRoot(document.contents)
    ? {}
    : document.toJS({
        reviver: (_key, value) =>
          typeof value === "bigint" ? Number(value) : value,
      });
};

/** Keep unchanged scalar nodes, including their quoting and explicit tags. */
const retainHermesScalarSource = (previous: unknown, next: Node): Node => {
  if (isScalar(previous) && isScalar(next) && previous.value === next.value)
    return previous;
  if (isMap(previous) && isMap(next)) {
    const entries = new Map(
      previous.items.flatMap((pair) =>
        isScalar(pair.key) && typeof pair.key.value === "string"
          ? [[pair.key.value, pair] as const]
          : [],
      ),
    );
    for (const pair of next.items) {
      const key = isScalar(pair.key) ? pair.key.value : undefined;
      const prior = typeof key === "string" ? entries.get(key) : undefined;
      if (prior === undefined) continue;
      pair.key = prior.key;
      if (isNode(pair.value))
        pair.value = retainHermesScalarSource(prior.value, pair.value);
    }
  } else if (isSeq(previous) && isSeq(next)) {
    next.items = next.items.map((item, index) =>
      isNode(item)
        ? retainHermesScalarSource(previous.items[index], item)
        : item,
    );
  }
  return next;
};

/** Set or delete one value in a Hermes `config.yaml`, keeping the rest as written. */
export const editHermesConfigurationYaml = (
  text: string,
  path: readonly string[],
  value: unknown,
): string => {
  // A plain Document, so a bare `---` root can be replaced by a new map.
  const document: Document = parseHermesDocument(text);
  const root = document.contents;
  if (isEmptyYamlRoot(root)) {
    const map = document.createNode({});
    if (isScalar(root))
      map.commentBefore = [root.commentBefore, root.comment]
        .filter((comment) => comment !== undefined)
        .join("\n");
    document.contents = map;
  }
  if (value === undefined) document.deleteIn(path);
  else {
    // setIn's implicit JS Map parents serialize as !!omap in YAML 1.1.
    // Config settings are ordinary mappings, including absent server tables.
    for (let length = 1; length < path.length; length++) {
      const parent = path.slice(0, length);
      if (!document.hasIn(parent))
        document.setIn(parent, document.createNode({}));
    }
    const previous = document.getIn(path, true);
    // Let YAML's scalar update preserve numeric formats for a direct edit.
    // Replacing containers needs explicit retention of unchanged child nodes.
    document.setIn(
      path,
      isMap(previous) || isSeq(previous)
        ? retainHermesScalarSource(previous, document.createNode(value))
        : value,
    );
  }
  // Editing REA must not reflow unrelated user prompts or other YAML scalars.
  return document.toString({
    lineWidth: 0,
    // Hermes tries the YAML 1.1 C loader before its directive-aware pure
    // fallback. Quote new strings to avoid introducing YAML 1.1 coercions.
    ...(document.directives?.yaml.version === "1.2"
      ? {
          defaultStringType: "QUOTE_DOUBLE" as const,
          defaultKeyType: "QUOTE_DOUBLE" as const,
        }
      : {}),
  });
};
