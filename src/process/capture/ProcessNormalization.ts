import { isIP } from "node:net";

import type { ProcessScenario } from "../../domain/process/processScenario.js";

import type { ProcessSample } from "../../domain/process/processCapture.js";

export type BoundedProcessTextNormalization =
  | {
      readonly state: "normalized";
      readonly value: string;
      readonly utf8Bytes: number;
    }
  | { readonly state: "over_budget" };

type RegexReplacement = (match: string, ...groups: string[]) => string;

type BoundedStageResult =
  | {
      readonly state: "bounded";
      readonly value: string;
      readonly utf8Bytes: number;
    }
  | { readonly state: "unchanged"; readonly value: string }
  | { readonly state: "over_budget" };

const createUtf8ByteCounter = (maxBytes: number) => {
  let bytes = 0;
  let pendingHighSurrogate = false;
  const addBytes = (added: number): void => {
    if (bytes > maxBytes || added > maxBytes - bytes) {
      bytes = Number.POSITIVE_INFINITY;
      return;
    }
    bytes += added;
  };
  return {
    add: (value: string): void => {
      if (bytes > maxBytes || value.length === 0) return;
      let index = 0;
      if (pendingHighSurrogate) {
        if (value.length > 0 && isLowSurrogate(value.charCodeAt(0))) {
          addBytes(4);
          index = 1;
        } else {
          addBytes(3);
        }
        pendingHighSurrogate = false;
      }
      for (; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code <= 0x7f) addBytes(1);
        else if (code <= 0x7ff) addBytes(2);
        else if (isHighSurrogate(code)) {
          if (index + 1 === value.length) {
            pendingHighSurrogate = true;
          } else if (isLowSurrogate(value.charCodeAt(index + 1))) {
            addBytes(4);
            index += 1;
          } else addBytes(3);
        } else addBytes(3);
        if (bytes > maxBytes) return;
      }
    },
    finish: (): number => {
      if (pendingHighSurrogate) addBytes(3);
      return bytes;
    },
  };
};

const isHighSurrogate = (code: number): boolean =>
  code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean =>
  code >= 0xdc00 && code <= 0xdfff;

const boundedRegexReplace = (
  value: string,
  matcher: RegExp,
  replacement: RegexReplacement,
  maxBytes: number,
): BoundedStageResult => {
  const byteCounter = createUtf8ByteCounter(maxBytes);
  let cursor = 0;
  let changed = false;
  matcher.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(value)) !== null) {
    const index = match.index;
    const matched = match[0] ?? "";
    const nextCursor = index + matched.length;
    const replacementValue = replacement(matched, ...match.slice(1));
    changed ||= replacementValue !== matched;
    byteCounter.add(value.slice(cursor, index));
    byteCounter.add(replacementValue);
    cursor = nextCursor;
  }
  byteCounter.add(value.slice(cursor));
  const bytes = byteCounter.finish();
  if (bytes > maxBytes) {
    return changed ? { state: "over_budget" } : { state: "unchanged", value };
  }
  if (!changed) return { state: "unchanged", value };
  matcher.lastIndex = 0;
  const normalized = value.replace(matcher, replacement);
  return {
    state: "bounded",
    value: normalized,
    utf8Bytes: bytes,
  };
};

const boundedLiteralReplace = (
  value: string,
  pattern: string,
  replacement: string,
  maxBytes: number,
): BoundedStageResult => {
  const byteCounter = createUtf8ByteCounter(maxBytes);
  let cursor = 0;
  if (pattern === "") {
    if (replacement === "") return { state: "unchanged", value };
    for (let index = 0; index < value.length; index += 1) {
      byteCounter.add(replacement);
      byteCounter.add(value.slice(index, index + 1));
    }
    byteCounter.add(replacement);
    const bytes = byteCounter.finish();
    if (bytes > maxBytes) return { state: "over_budget" };
    return {
      state: "bounded",
      value: value.replaceAll(pattern, () => replacement),
      utf8Bytes: bytes,
    };
  }
  if (pattern === replacement) return { state: "unchanged", value };

  let index = value.indexOf(pattern, cursor);
  if (index === -1) return { state: "unchanged", value };
  while (index !== -1) {
    byteCounter.add(value.slice(cursor, index));
    byteCounter.add(replacement);
    cursor = index + pattern.length;
    index = value.indexOf(pattern, cursor);
  }
  byteCounter.add(value.slice(cursor));
  const bytes = byteCounter.finish();
  if (bytes > maxBytes) return { state: "over_budget" };
  return {
    state: "bounded",
    value: value.replaceAll(pattern, () => replacement),
    utf8Bytes: bytes,
  };
};

const boundedIdentity = (
  value: string,
  maxBytes: number,
): BoundedStageResult => {
  const utf8Bytes = Buffer.byteLength(value);
  return utf8Bytes <= maxBytes
    ? { state: "bounded", value, utf8Bytes }
    : { state: "unchanged", value };
};

/** Bucket one elapsed process-capture timestamp under scenario normalization. */
export const normalizeProcessElapsedTime = (
  elapsedMs: number,
  timeBucketMs: number,
): number => Math.floor(elapsedMs / timeBucketMs) * timeBucketMs;

/** Prepare capture-local matchers while retaining a live terminal PID lookup. */
export const createProcessTextNormalizer = (
  scenario: ProcessScenario,
  temporaryRoot: string,
  pid: number | (() => number),
): ((value: string) => string) => {
  const normalizePaths = scenario.normalization.paths
    ? createPathNormalizer(scenario, temporaryRoot)
    : (value: string): string => value;
  let previousPid: number | undefined;
  let normalizePids = (value: string): string => value;
  return (value) => {
    let normalized = normalizePaths(value);
    if (scenario.normalization.ports)
      normalized = normalizePortTokens(normalized);
    if (scenario.normalization.pids) {
      const currentPid = typeof pid === "number" ? pid : pid();
      if (currentPid !== previousPid) {
        previousPid = currentPid;
        normalizePids = createPidNormalizer([currentPid]);
      }
      normalized = normalizePids(normalized);
    }
    for (const pattern of scenario.normalization.patterns)
      normalized = normalized.replaceAll(
        pattern.pattern,
        () => pattern.replacement,
      );
    return normalized;
  };
};

/** Normalize terminal text without materializing an intermediate over its byte budget. */
export const createBoundedProcessTextNormalizer = (
  scenario: ProcessScenario,
  temporaryRoot: string,
  pid: number | (() => number),
): ((value: string, maxBytes: number) => BoundedProcessTextNormalization) => {
  const pathRule = scenario.normalization.paths
    ? createPathRule(scenario, temporaryRoot)
    : undefined;
  let previousPid: number | undefined;
  let pidMatcher: RegExp | undefined;
  return (value, maxBytes) => {
    let normalized = value;
    const apply = (result: BoundedStageResult): boolean => {
      if (result.state === "over_budget") return false;
      if (result.state === "bounded") normalized = result.value;
      return true;
    };
    if (pathRule !== undefined) {
      if (
        !apply(
          boundedRegexReplace(
            normalized,
            pathRule.matcher,
            pathRule.replace,
            maxBytes,
          ),
        )
      )
        return { state: "over_budget" };
    }
    if (scenario.normalization.ports) {
      if (!apply(normalizePortsBounded(normalized, maxBytes)))
        return { state: "over_budget" };
    }
    if (scenario.normalization.pids) {
      const currentPid = typeof pid === "number" ? pid : pid();
      if (currentPid !== previousPid) {
        previousPid = currentPid;
        pidMatcher = createPidMatcher([currentPid]);
      }
      if (pidMatcher !== undefined) {
        if (
          !apply(
            boundedRegexReplace(
              normalized,
              pidMatcher,
              () => "<pid>",
              maxBytes,
            ),
          )
        )
          return { state: "over_budget" };
      }
    }
    for (const pattern of scenario.normalization.patterns) {
      if (
        !apply(
          boundedLiteralReplace(
            normalized,
            pattern.pattern,
            pattern.replacement,
            maxBytes,
          ),
        )
      )
        return { state: "over_budget" };
    }
    return boundedIdentity(normalized, maxBytes).state === "bounded"
      ? {
          state: "normalized",
          value: normalized,
          utf8Bytes: Buffer.byteLength(normalized),
        }
      : { state: "over_budget" };
  };
};

/** Normalize one payload when its caller does not retain a capture-local matcher. */
export const normalizeProcessText = (
  value: string,
  scenario: ProcessScenario,
  temporaryRoot: string,
  pid: number,
): string => createProcessTextNormalizer(scenario, temporaryRoot, pid)(value);

/** Match original paths once, preferring the most specific selected identity. */
const createPathRule = (
  scenario: ProcessScenario,
  temporaryRoot: string,
):
  | { readonly matcher: RegExp; readonly replace: RegexReplacement }
  | undefined => {
  const aliases = new Map<string, string>();
  const selected: readonly (readonly [string, string])[] = [
    [temporaryRoot, "<temporary-root>"],
    [scenario.working_directory, "<working-directory>"],
    [scenario.executable, "<executable>"],
    ...scenario.filesystem_observation_paths.map(
      (root, index): readonly [string, string] => [
        root,
        `<filesystem-root-${String(index)}>`,
      ],
    ),
  ];
  for (const [path, alias] of selected)
    if (path !== "" && !aliases.has(path)) aliases.set(path, alias);
  const paths = [...aliases.keys()].sort(
    (left, right) => right.length - left.length,
  );
  if (paths.length === 0) return undefined;
  const pattern = paths
    .map((path) => path.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join("|");
  const matcher = new RegExp(pattern, "gu");
  return {
    matcher,
    replace: (path) => aliases.get(path) ?? path,
  };
};

const createPathNormalizer = (
  scenario: ProcessScenario,
  temporaryRoot: string,
): ((value: string) => string) => {
  const rule = createPathRule(scenario, temporaryRoot);
  if (rule === undefined) return (value) => value;
  return (value) => value.replace(rule.matcher, rule.replace);
};

// A port may end a sentence, but a period followed by a letter, digit, or
// underscore in any script continues a decimal, version, or host name and is
// not a port boundary.
// PTY chunks are normalized independently, so a period that ends the chunk
// stays unnormalized: its continuation may arrive in the next chunk.
const normalizePortTokens = (value: string): string => {
  return value
    .replaceAll(PORT_ENDPOINT_MATCHER, portEndpointReplacement)
    .replaceAll(PORT_FIELD_MATCHER, portFieldReplacement);
};

const PORT_ENDPOINT_MATCHER =
  /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/?#"'<>]+|\blocalhost|\b(?:\d{1,3}\.){3}\d{1,3}|\[[\da-f:.%]+\]):(\d{1,5})(?![\p{L}\p{N}_@:]|\.(?:[\p{L}\p{N}_]|$))/giu;
const PORT_FIELD_MATCHER =
  /(\b(?:port|tcp_port|udp_port|listen)\b["']?\s*[:=]\s*)(\d{1,5})(?![\p{L}\p{N}_]|\.(?:[\p{L}\p{N}_]|$))/giu;

const portEndpointReplacement: RegexReplacement = (match, endpoint, port) => {
  if (Number(port) > 65_535) return match;
  const isEndpoint = endpoint.includes("://")
    ? URL.canParse(`${endpoint}:${port}`)
    : endpoint.toLowerCase() === "localhost" ||
      isIP(endpoint.replace(/^\[|\]$/gu, "")) !== 0;
  return isEndpoint ? `${endpoint}:<port>` : match;
};

const portFieldReplacement: RegexReplacement = (match, prefix, port) =>
  Number(port) <= 65_535 ? `${prefix}<port>` : match;

const normalizePortsBounded = (
  value: string,
  maxBytes: number,
): BoundedStageResult => {
  const endpoint = boundedRegexReplace(
    value,
    PORT_ENDPOINT_MATCHER,
    portEndpointReplacement,
    maxBytes,
  );
  if (endpoint.state === "over_budget") return endpoint;
  const afterEndpoint = endpoint.state === "bounded" ? endpoint.value : value;
  return boundedRegexReplace(
    afterEndpoint,
    PORT_FIELD_MATCHER,
    portFieldReplacement,
    maxBytes,
  );
};

/** Project sampled observations under the caller-selected normalization rules. */
export const normalizeProcessSamples = (
  samples: readonly ProcessSample[],
  scenario: ProcessScenario,
  rootPid: number,
): readonly ProcessSample[] => {
  const identifiers = [
    rootPid,
    ...samples.flatMap((sample) => [
      sample.pid,
      sample.parent_pid,
      sample.process_group_id ?? 0,
      sample.session_id ?? 0,
    ]),
  ];
  const mapping = new Map<number, number>();
  for (const identifier of identifiers)
    if (identifier > 0 && !mapping.has(identifier))
      mapping.set(identifier, mapping.size + 1);
  const normalizeText = createProcessTextNormalizer(
    scenario,
    "<no-temporary-root>",
    rootPid,
  );
  const normalizeSamplePids = scenario.normalization.pids
    ? createPidNormalizer(identifiers)
    : undefined;
  const normalizeCommand = (command: string): string => {
    const normalized = normalizeText(command);
    const withNormalizedPids = normalizeSamplePids?.(normalized) ?? normalized;
    return withNormalizedPids.trim();
  };
  return samples.map((sample) => ({
    at_ms: normalizeProcessElapsedTime(
      sample.at_ms,
      scenario.normalization.time_bucket_ms,
    ),
    pid: scenario.normalization.pids
      ? (mapping.get(sample.pid) ?? 1)
      : sample.pid,
    parent_pid: scenario.normalization.pids
      ? (mapping.get(sample.parent_pid) ?? 0)
      : sample.parent_pid,
    process_group_id:
      !scenario.normalization.pids || sample.process_group_id === null
        ? sample.process_group_id
        : (mapping.get(sample.process_group_id) ?? 0),
    session_id:
      !scenario.normalization.pids || sample.session_id === null
        ? sample.session_id
        : (mapping.get(sample.session_id) ?? 0),
    command: normalizeCommand(sample.command),
  }));
};

const createPidNormalizer = (
  identifiers: readonly number[],
): ((value: string) => string) => {
  const matcher = createPidMatcher(identifiers);
  if (matcher === undefined) return (value) => value;
  return (value) => value.replace(matcher, "<pid>");
};

const createPidMatcher = (
  identifiers: readonly number[],
): RegExp | undefined => {
  const tokens = [...new Set(identifiers)]
    .filter((identifier) => Number.isSafeInteger(identifier) && identifier > 0)
    .sort((left, right) => right - left)
    .map(String);
  if (tokens.length === 0) return undefined;
  return new RegExp(`(?<!\\d)(?:${tokens.join("|")})(?!\\d)`, "gu");
};
