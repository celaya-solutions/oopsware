import { isJsonLike } from "../../domain/analysisView/EnvironmentManifestAccumulator.js";
import { mediaTypeEssence } from "../../domain/analysisView/webNetworkRouteTemplates.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import { parseExactJson } from "../../domain/exactJsonNumber.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import {
  iterateUrlQueryParameters,
  recordedPathSegments,
} from "../../domain/recordedTransportUrl.js";
import { err, ok, type Result } from "../../domain/result.js";
import { environmentToolArguments } from "./environmentTools.js";
import {
  REPLAY_BODY_LIMIT_BYTES,
  ENVIRONMENT_SERVE_OPERATION,
  type EnvironmentManifestTool,
  type EnvironmentSource,
  type RecordedExchange,
} from "./environmentSource.js";

export { REPLAY_BODY_LIMIT_BYTES } from "./environmentSource.js";

/** Caller arguments as the MCP tool receives them. */
export type ReplayArguments = Readonly<Record<string, unknown>>;

/** What one tool call returns: the recorded response and where it came from. */
export interface ReplayResult {
  readonly status: number | null;
  readonly content_type: string | null;
  readonly body: JsonValue;
  readonly replay: {
    readonly record_ordinal: number;
    readonly evidence_id: string;
    readonly exact_match: boolean;
    readonly recorded_path: string;
    readonly recorded_query: string | null;
    /** Set when the recorded path or query was cut to REPLAY_METADATA_LIMIT_BYTES; the Evidence record keeps it whole. */
    readonly recorded_line_truncated: boolean;
    readonly content_type_truncated: boolean;
    readonly body_recorded: boolean;
    readonly body_encoding: "utf-8" | "base64";
    readonly truncated: boolean;
  };
}

interface MatchScore {
  readonly pathMatches: number;
  /** Path matches whose recorded segment equals the value as given, not only after decoding. */
  readonly verbatimMatches: number;
  readonly queryMatches: number;
  readonly exact: boolean;
}

const decoded = (segment: string): string => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

/** Count how many supplied path and query values the recorded request line satisfies. */
const scoreExchange = (
  tool: EnvironmentManifestTool,
  pathArguments: ReadonlyMap<string, string>,
  queryArguments: ReadonlyMap<string, string>,
  exchange: RecordedExchange,
  args: ReplayArguments,
): MatchScore => {
  const providedPaths: { index: number; value: string }[] = [];
  for (const param of tool.params) {
    const value = args[pathArguments.get(param.name) ?? param.name];
    if (typeof value === "string")
      providedPaths.push({ index: param.index, value });
  }
  const segments =
    providedPaths.length === 0
      ? new Map<number, string>()
      : recordedPathSegments(
          exchange.path,
          providedPaths.map((param) => param.index),
        );
  const pathProvided = providedPaths.length;
  let pathMatches = 0;
  let verbatimMatches = 0;
  for (const { index, value } of providedPaths) {
    const segment = segments.get(index);
    if (segment === value) verbatimMatches += 1;
    if (
      segment !== undefined &&
      (segment === value || decoded(segment) === value)
    )
      pathMatches += 1;
  }
  const supplied = new Map<string, string>();
  for (const [name, argument] of queryArguments) {
    const value = args[argument];
    if (typeof value === "string") supplied.set(name, value);
  }
  const matched = new Set<string>();
  if (supplied.size > 0)
    for (const [name, value] of iterateUrlQueryParameters(
      exchange.query ?? "",
    )) {
      if (supplied.get(name) === value) matched.add(name);
      if (matched.size === supplied.size) break;
    }
  const queryProvided = supplied.size;
  const queryMatches = matched.size;
  return {
    pathMatches,
    verbatimMatches,
    queryMatches,
    exact: pathMatches === pathProvided && queryMatches === queryProvided,
  };
};

const outranks = (score: MatchScore, best: MatchScore): boolean =>
  score.pathMatches !== best.pathMatches
    ? score.pathMatches > best.pathMatches
    : score.verbatimMatches !== best.verbatimMatches
      ? score.verbatimMatches > best.verbatimMatches
      : score.queryMatches > best.queryMatches;

/** Choose the record whose path segments, then verbatim spellings, then query values best match the call; ties keep manifest order. */
export const selectReplayExchange = (
  tool: EnvironmentManifestTool,
  exchanges: ReadonlyMap<number, RecordedExchange>,
  args: ReplayArguments,
):
  | { readonly exchange: RecordedExchange; readonly exact: boolean }
  | undefined => {
  let best: { exchange: RecordedExchange; score: MatchScore } | undefined;
  const argumentsMap = environmentToolArguments(tool);
  for (const ordinal of tool.record_ordinals) {
    const exchange = exchanges.get(ordinal);
    if (exchange === undefined) continue;
    const score = scoreExchange(
      tool,
      argumentsMap.path,
      argumentsMap.query,
      exchange,
      args,
    );
    if (best === undefined || outranks(score, best.score))
      best = { exchange, score };
  }
  return best === undefined
    ? undefined
    : { exchange: best.exchange, exact: best.score.exact };
};

/** The longest prefix of text whose UTF-8 encoding fits the byte limit, encoding only that prefix. */
const utf8Prefix = (text: string, maxBytes: number): string => {
  // encodeInto stops before the first character that does not fit, so `read` ends on a boundary.
  const { read } = new TextEncoder().encodeInto(text, new Uint8Array(maxBytes));
  return text.slice(0, read);
};

/** Bytes a padded base64 string decodes to. */
const decodedBase64Bytes = (encoded: string): number =>
  Math.floor((encoded.length * 3) / 4) -
  (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0);

/** Base64 characters, in whole groups, whose bytes fit the replay limit. */
const BASE64_LIMIT_CHARS = Math.floor(REPLAY_BODY_LIMIT_BYTES / 3) * 4;

/** The limit applies to the recorded bytes, not to their base64 spelling. */
const replayBase64Body = (
  encoded: string,
  cut: boolean,
): { readonly body: JsonValue; readonly truncated: boolean } =>
  !cut && decodedBase64Bytes(encoded) <= REPLAY_BODY_LIMIT_BYTES
    ? { body: encoded, truncated: false }
    : { body: encoded.slice(0, BASE64_LIMIT_CHARS), truncated: true };

/** Parse a retained body as JSON when its content type is JSON-like; otherwise return the text. */
const replayBody = (
  exchange: RecordedExchange,
): { readonly body: JsonValue; readonly truncated: boolean } => {
  const text = exchange.bodyText;
  if (text === null) return { body: null, truncated: false };
  if (exchange.bodyEncoding === "base64")
    return replayBase64Body(text, exchange.bodyCut === true);
  const prefix = utf8Prefix(text, REPLAY_BODY_LIMIT_BYTES);
  if (prefix.length < text.length || exchange.bodyCut === true)
    return { body: prefix, truncated: true };
  if (
    exchange.contentType !== null &&
    isJsonLike(mediaTypeEssence(exchange.contentType))
  ) {
    const value = parseExactJson(text);
    if (value !== undefined) return { body: value, truncated: false };
  }
  return { body: text, truncated: false };
};

/** Recorded paths and queries are cut to this many UTF-8 bytes in replies. */
export const REPLAY_METADATA_LIMIT_BYTES = 1024;

/** Replay one tool call from the retained record that best matches its arguments. */
export const replayEnvironmentTool = (
  source: EnvironmentSource,
  tool: EnvironmentManifestTool,
  args: ReplayArguments,
): Result<ReplayResult, AnalysisError> => {
  const selected = selectReplayExchange(tool, source.exchanges, args);
  if (selected === undefined)
    return err(
      new AnalysisInputError(
        ENVIRONMENT_SERVE_OPERATION,
        {
          userMessage: `Tool ${tool.name} cites no retained record to replay.`,
        },
        [{ path: ["tool"], reason: "invalid_value", expected: tool.name }],
      ),
    );
  const { exchange, exact } = selected;
  const { body, truncated } = replayBody(exchange);
  const recordedPath = utf8Prefix(exchange.path, REPLAY_METADATA_LIMIT_BYTES);
  const recordedQuery =
    exchange.query === null
      ? null
      : utf8Prefix(exchange.query, REPLAY_METADATA_LIMIT_BYTES);
  const contentType =
    exchange.contentType === null
      ? null
      : utf8Prefix(exchange.contentType, REPLAY_METADATA_LIMIT_BYTES);
  return ok({
    status: exchange.status,
    content_type: contentType,
    body,
    replay: {
      record_ordinal: exchange.ordinal,
      evidence_id: source.evidenceId,
      exact_match: exact,
      recorded_path: recordedPath,
      recorded_query: recordedQuery,
      recorded_line_truncated:
        recordedPath.length < exchange.path.length ||
        (recordedQuery?.length ?? 0) < (exchange.query?.length ?? 0),
      content_type_truncated: contentType !== exchange.contentType,
      body_recorded: exchange.bodyText !== null,
      body_encoding: exchange.bodyEncoding ?? "utf-8",
      truncated,
    },
  });
};
