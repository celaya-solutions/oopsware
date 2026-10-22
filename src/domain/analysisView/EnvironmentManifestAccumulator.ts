import { z } from "zod";
import type { AnalysisError } from "../analysisErrorBase.js";
import { jsonValueType, parseJsonObject } from "../jsonShape.js";
import { ok, type Result } from "../result.js";
import {
  compareUnicodeCodePoints as compare,
  compositeKey,
} from "../unicodeCodePointOrder.js";
import {
  WEB_NETWORK_CAPTURE_LIMITS,
  type WebNetworkCaptureRecord,
} from "../webNetworkCapture.js";
import { completeWithinViewCoverage } from "./analysisViewCoverage.js";
import type { UnsignedAnalysisView } from "./analysisView.js";
import { WebNetworkProjectionAccumulator } from "./WebNetworkProjectionAccumulator.js";
import {
  applyTemplateRules,
  compareTools,
  parameterNames,
  pathTemplate,
  SIBLING_VARIANCE_SEGMENT_LIMIT,
  toolName,
  toolNameRegistry,
  type BodyShape,
  type JsonTypeName,
  type LiteralPart,
  type ManifestRule,
  type TemplateRule,
  type ToolGroup,
} from "./environmentManifestRules.js";
import {
  ENTRY_BYTES,
  GROUP_BYTES,
  RECORD_SCRATCH_BYTES,
  SEGMENT_BYTES,
  mediaTypeEssence,
  readQueryParameterNames,
  readRecordedRequestLine,
  routePartCount,
  scanRouteTemplate,
  textBytes,
  type RecordedRequestLine,
  type RouteTemplate,
} from "./webNetworkRouteTemplates.js";

type Manifest = Extract<UnsignedAnalysisView, { kind: "environment-manifest" }>;
type ManifestFields = Pick<
  Manifest,
  | "origin"
  | "name"
  | "tools"
  | "records"
  | "excluded"
  | "unknowns"
  | "templated_groups"
  | "coverage"
  | "limitations"
>;
type Tool = Manifest["tools"][number];
type Exclusion = Manifest["excluded"][number];
type RequestLine = Extract<RecordedRequestLine, { kind: "line" }>;

interface RecordLine {
  readonly ordinal: number;
  readonly method: string;
  readonly path: string;
  readonly status: number | null;
  readonly contentType: string | null;
}

type MutablePart =
  | LiteralPart
  | {
      readonly kind: "param";
      readonly rule: ManifestRule;
      readonly values: Set<string>;
    };

interface GroupState extends ToolGroup {
  readonly parts: readonly MutablePart[];
  readonly positions: number[];
  readonly statuses: Set<number>;
  readonly contentTypes: Set<string>;
  readonly queryNames: Set<string>;
  readonly apiPath: boolean;
  jsonLike: boolean;
}

const postDataSchema = z.object({
  request: z.object({
    postData: z
      .object({
        mimeType: z.unknown().optional(),
        text: z.unknown().optional(),
      })
      .nullable()
      .optional(),
  }),
});
const JSON_LIKE_TEXT = new Set(["text/plain", "text/markdown"]);
const ASSET_ESSENCES = new Set([
  "text/html",
  "application/xhtml+xml",
  "text/css",
  "text/javascript",
  "application/javascript",
  "application/x-javascript",
  "application/wasm",
]);
const ASSET_PREFIXES = ["image/", "font/", "audio/", "video/"];
const ASSET_PATH =
  /\.(?:m?js|css|map|html?|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|otf)$/iu;
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH"]);
/** Quotes, separators and brackets a four-part composite key adds around its texts. */
const KEY_OVERHEAD_CHARS = 32;
const UNKNOWNS: Manifest["unknowns"] = [
  {
    kind: "authorization-model",
    statement:
      "Authorization headers and cookies are structurally excluded from captures; the manifest states no authorization model.",
  },
  {
    kind: "response-semantics",
    statement:
      "Recorded statuses and bodies are retained only as pointers to parent records; the manifest states no response semantics.",
  },
  {
    kind: "state-transition",
    statement:
      "Recorded exchanges are independent observations; the manifest states no ordering, side effects or state transitions between tools.",
  },
];

/** `application/json` or `application/*+json`; a `+json` suffix on another type is not JSON here. */
const isJson = (essence: string | null): boolean =>
  essence === "application/json" ||
  (essence !== null &&
    essence.startsWith("application/") &&
    essence.endsWith("+json"));

/** JSON, `+json`, `text/plain` or `text/markdown`: the content types a replay parses as JSON. */
export const isJsonLike = (essence: string | null): boolean =>
  isJson(essence) || (essence !== null && JSON_LIKE_TEXT.has(essence));

const isApiPath = (path: string): boolean =>
  path.startsWith("/api/") || path.startsWith("/apis/");

const isAsset = (group: GroupState): boolean =>
  [...group.contentTypes].some(
    (essence) =>
      ASSET_ESSENCES.has(essence) ||
      ASSET_PREFIXES.some((prefix) => essence.startsWith(prefix)),
  ) || ASSET_PATH.test(group.api_surface_template);

/** Kebab-case name from the origin host; dots and ports become hyphens. */
const environmentName = (origin: string): string =>
  new URL(origin).host
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replace(/^-/u, "")
    .replace(/-$/u, "");

const routeParts = (route: RouteTemplate): MutablePart[] => {
  const byIndex = new Map(
    route.segments.map((segment) => [segment.segment_index, segment]),
  );
  return route.template
    .slice(1)
    .split("/")
    .map((text, index): MutablePart => {
      const segment = byIndex.get(index);
      return segment === undefined
        ? { kind: "literal", value: text }
        : {
            kind: "param",
            rule: segment.rule,
            values: new Set([segment.value]),
          };
    });
};

const hasParam = (parts: readonly MutablePart[]): boolean =>
  parts.some((part) => part.kind === "param");

/** Own tool grouping, record pointers and admission for the entire manifest. */
export class EnvironmentManifestAccumulator extends WebNetworkProjectionAccumulator {
  readonly #groups = new Map<string, GroupState>();
  readonly #records: RecordLine[] = [];
  readonly #origins = new Map<string, { records: number; jsonLike: number }>();
  readonly #rules: ReadonlySet<TemplateRule>;
  #unrepresented = 0;
  #unrepresentableBodyKey = false;

  constructor(
    maximumBytes = WEB_NETWORK_CAPTURE_LIMITS.outputBytes,
    readonly includeQueryParameterNames = true,
    rules: readonly TemplateRule[] = [],
    budgetSubject = "Environment-manifest",
  ) {
    super(maximumBytes, budgetSubject);
    this.#rules = new Set(rules);
  }

  /** Whether the finished projection publishes body shapes, and so states their limitation. */
  protected get reportsBodyShapes(): boolean {
    return true;
  }

  add(record: WebNetworkCaptureRecord): Result<void, AnalysisError> {
    const limitations = this.addLimitations(record.limitations);
    if (!limitations.ok) return limitations;
    try {
      const line = readRecordedRequestLine(
        record.reported,
        this.includeQueryParameterNames,
        this.scratch,
      );
      if (line === null) return this.overBudget();
      if (line.kind === "excluded") {
        this.#unrepresented += 1;
        return ok(undefined);
      }
      const route = scanRouteTemplate(line.path, this.scratch);
      if (route === null) return this.overBudget();
      const queryNames = readQueryParameterNames(line.query, this.scratch);
      if (queryNames === null) return this.overBudget();
      // The key copies the method, origin, template and rules; charge that copy before it exists.
      if (
        !this.scratch(
          textBytes(
            line.method.length +
              line.origin.length +
              route.template.length +
              route.rules.length +
              KEY_OVERHEAD_CHARS,
          ),
        )
      )
        return this.overBudget();
      const key = compositeKey([
        line.method,
        line.origin,
        route.template,
        route.rules,
      ]);
      const group = this.#groups.get(key);
      const bodyShape =
        group === undefined && WRITE_METHODS.has(line.method)
          ? this.#bodyShape(record.reported)
          : ok(null);
      if (!bodyShape.ok) return bodyShape;
      return this.#append(
        record.ordinal,
        line,
        route,
        queryNames,
        { key, group },
        bodyShape.value,
      );
    } finally {
      this.releaseTemporary();
    }
  }

  /** Read the top-level key types of the group's first recorded JSON-typed request body; nested values are never walked. */
  #bodyShape(reported: unknown): Result<BodyShape | null, AnalysisError> {
    const parsed = postDataSchema.safeParse(reported);
    const body = parsed.success ? parsed.data.request.postData : undefined;
    if (
      body === undefined ||
      body === null ||
      typeof body.text !== "string" ||
      typeof body.mimeType !== "string"
    )
      return ok(null);
    // The media type is scanned and lowercased before it is known to be JSON; charge it first.
    if (!this.scratch(textBytes(body.mimeType.length)))
      return this.overBudget();
    if (!isJson(mediaTypeEssence(body.mimeType))) return ok(null);
    // The parsed tree is linear in the text and coexists with it and the key entries.
    if (!this.scratch(RECORD_SCRATCH_BYTES + textBytes(body.text.length) * 3))
      return this.overBudget();
    const root = parseJsonObject(body.text);
    if (root === null) return ok(null);
    const entries: [string, JsonTypeName][] = [];
    for (const [name, value] of Object.entries(root)) {
      // JSON parsers and schema clones drop a __proto__ own property; omit it explicitly.
      if (name === "__proto__") this.#unrepresentableBodyKey = true;
      else entries.push([name, jsonValueType(value)]);
    }
    return ok({ type: "object", properties: Object.fromEntries(entries) });
  }

  #append(
    ordinal: number,
    line: RequestLine,
    route: RouteTemplate,
    queryNames: ReadonlySet<string> | undefined,
    bucket: { readonly key: string; readonly group: GroupState | undefined },
    bodyShape: BodyShape | null,
  ): Result<void, AnalysisError> {
    const mime = mediaTypeEssence(line.rawMime);
    let group = bucket.group;
    // One retained record pointer, including its projected output.
    let bytes =
      ENTRY_BYTES * 2 +
      textBytes(line.path.length) +
      textBytes(line.method.length);
    const origin = this.#origins.get(line.origin);
    if (origin === undefined)
      bytes += ENTRY_BYTES * 2 + textBytes(line.origin.length);
    if (group === undefined) {
      bytes +=
        GROUP_BYTES +
        textBytes(bucket.key.length) +
        textBytes(line.method.length) +
        textBytes(line.origin.length) +
        textBytes(route.template.length) * 2 +
        textBytes(route.rules.length);
      // Every part, literal or templated, is one object in the group and in each rule, template and name pass.
      bytes += ENTRY_BYTES * 4 * routePartCount(route.template);
      for (const segment of route.segments)
        bytes += SEGMENT_BYTES + ENTRY_BYTES + textBytes(segment.value.length);
      if (bodyShape !== null)
        for (const name of Object.keys(bodyShape.properties))
          bytes += ENTRY_BYTES + textBytes(name.length);
    } else {
      for (const segment of route.segments) {
        const part = group.parts[segment.segment_index];
        if (part?.kind === "param" && !part.values.has(segment.value))
          bytes += ENTRY_BYTES + textBytes(segment.value.length);
      }
    }
    if (line.status !== null && !group?.statuses.has(line.status))
      bytes += ENTRY_BYTES;
    if (mime !== null && !group?.contentTypes.has(mime))
      bytes += ENTRY_BYTES + textBytes(mime.length);
    for (const name of queryNames ?? [])
      if (!group?.queryNames.has(name))
        bytes += ENTRY_BYTES + textBytes(name.length);
    // Reserve the whole mutation while route scratch is still live.
    if (!this.retain(bytes)) return this.overBudget();
    const position = this.#records.length;
    this.#records.push({
      ordinal,
      method: line.method,
      path: line.path,
      status: line.status,
      contentType: mime,
    });
    const jsonLike = isJsonLike(mime);
    const stats = origin ?? { records: 0, jsonLike: 0 };
    stats.records += 1;
    if (jsonLike) stats.jsonLike += 1;
    this.#origins.set(line.origin, stats);
    if (group === undefined) {
      group = {
        method: line.method,
        origin: line.origin,
        api_surface_template: route.template,
        parts: routeParts(route),
        positions: [],
        statuses: new Set(),
        contentTypes: new Set(),
        queryNames: new Set(),
        bodyShape,
        apiPath: isApiPath(route.template),
        jsonLike: false,
      };
      this.#groups.set(bucket.key, group);
    } else {
      for (const segment of route.segments) {
        const part = group.parts[segment.segment_index];
        if (part?.kind === "param") part.values.add(segment.value);
      }
    }
    group.positions.push(position);
    group.jsonLike ||= jsonLike;
    if (line.status !== null) group.statuses.add(line.status);
    if (mime !== null) group.contentTypes.add(mime);
    for (const name of queryNames ?? []) group.queryNames.add(name);
    return ok(undefined);
  }

  /** The origin with the most JSON-like records, then most records, then lowest code points. */
  #primaryOrigin(): string | null {
    let best: { origin: string; records: number; jsonLike: number } | null =
      null;
    for (const [origin, stats] of this.#origins) {
      if (
        best === null ||
        stats.jsonLike > best.jsonLike ||
        (stats.jsonLike === best.jsonLike &&
          (stats.records > best.records ||
            (stats.records === best.records &&
              compare(origin, best.origin) < 0)))
      )
        best = { origin, ...stats };
    }
    return best?.origin ?? null;
  }

  #tools(groups: readonly ToolGroup[]): Tool[] {
    const registry = toolNameRegistry();
    return applyTemplateRules(groups, this.#rules)
      .map((group) => {
        const names = parameterNames(group.parts);
        return { group, names, template: pathTemplate(group.parts, names) };
      })
      .sort((left, right) =>
        compareTools(
          { template: left.template, method: left.group.method },
          { template: right.template, method: right.group.method },
        ),
      )
      .map(({ group, names, template }): Tool => {
        let next = 0;
        return {
          name: toolName(group.method, group.parts, names, registry),
          method: group.method,
          path_template: template,
          api_surface_template: group.api_surface_template,
          params: group.parts.flatMap((part, index) => {
            if (part.kind !== "param") return [];
            const name = names[next] ?? "";
            next += 1;
            return [
              {
                index,
                name,
                rule: part.rule,
                basis: "inferred" as const,
                observed_values: [...part.values].sort(compare),
              },
            ];
          }),
          query_parameter_names: [...group.queryNames].sort(compare),
          body_shape: group.bodyShape,
          statuses: [...group.statuses].sort((left, right) => left - right),
          content_types: [...group.contentTypes].sort(compare),
          record_ordinals: group.positions.map(
            (position) => this.#records[position]!.ordinal,
          ),
        };
      });
  }

  /** One limitation per selected sibling rule when a route is too long for it to compare. */
  #segmentLimitLimitations(toolGroups: readonly ToolGroup[]): string[] {
    if (
      !toolGroups.some(
        (group) => group.parts.length > SIBLING_VARIANCE_SEGMENT_LIMIT,
      )
    )
      return [];
    return (["sibling-variance", "sibling-pair-variance"] as const)
      .filter((rule) => this.#rules.has(rule))
      .map(
        (rule) =>
          `Routes with more than ${String(SIBLING_VARIANCE_SEGMENT_LIMIT)} segments are not compared by ${rule}; they keep their grouped templates.`,
      );
  }

  /** Project the complete manifest; tools, records and exclusions are sorted deterministically. */
  finish(): Result<ManifestFields, AnalysisError> {
    const primary = this.#primaryOrigin();
    const toolGroups: GroupState[] = [];
    const exclusions = new Map<string, Exclusion & { templated: boolean }>();
    for (const group of this.#groups.values()) {
      const reason: Exclusion["reason"] | null =
        group.origin !== primary
          ? "other-origin"
          : group.apiPath || group.jsonLike
            ? null
            : isAsset(group)
              ? "ui-page-or-asset"
              : "non-json";
      if (reason === null) {
        toolGroups.push(group);
        continue;
      }
      const exclusion = {
        method: group.method,
        origin: group.origin,
        path_template: group.api_surface_template,
        reason,
      };
      // Distinct groups can print the same exclusion row; a templated one keeps the row inferred.
      const key = compositeKey(Object.values(exclusion));
      exclusions.set(key, {
        ...exclusion,
        templated:
          (exclusions.get(key)?.templated ?? false) || hasParam(group.parts),
      });
    }
    const tools = this.#tools(toolGroups);
    const cited = [...new Set(tools.flatMap((tool) => tool.record_ordinals))];
    const positions = new Map(
      this.#records.map((record, position) => [record.ordinal, position]),
    );
    const excluded = [...exclusions.values()].sort(
      (left, right) =>
        compare(left.origin, right.origin) ||
        compare(left.path_template, right.path_template) ||
        compare(left.method, right.method) ||
        compare(left.reason, right.reason),
    );
    const limitations = this.addLimitations([
      ...(this.reportsBodyShapes &&
      tools.some((tool) => tool.body_shape !== null)
        ? [
            "Body shapes list top-level JSON key types from one recorded request each; they do not establish required fields or a complete schema.",
          ]
        : []),
      ...(this.#unrepresentableBodyKey
        ? [
            "A top-level __proto__ key in a recorded JSON body is omitted from body_shape; it cannot be an own property of the published object.",
          ]
        : []),
      ...this.#segmentLimitLimitations(toolGroups),
      ...(this.#unrepresented > 0
        ? [
            `${String(this.#unrepresented)} retained records without a usable request line are not represented in the manifest.`,
          ]
        : []),
      ...(primary === null
        ? [
            "No retained record had a parseable origin; the manifest names no primary origin.",
          ]
        : []),
    ]);
    if (!limitations.ok) return limitations;
    return ok({
      origin: primary ?? "",
      name: primary === null ? "" : environmentName(primary),
      tools,
      records: cited
        .sort((left, right) => positions.get(left)! - positions.get(right)!)
        .map((ordinal) => {
          const record = this.#records[positions.get(ordinal)!]!;
          return {
            ordinal: record.ordinal,
            method: record.method,
            path: record.path,
            status: record.status,
            content_type: record.contentType,
          };
        }),
      excluded: excluded.map(
        ({ templated: _templated, ...exclusion }) => exclusion,
      ),
      unknowns: UNKNOWNS.map((unknown) => ({ ...unknown })),
      templated_groups:
        tools.filter((tool) => tool.params.length > 0).length +
        excluded.filter((exclusion) => exclusion.templated).length,
      coverage: completeWithinViewCoverage(tools.length, tools.length),
      limitations: this.sortedLimitations(),
    });
  }
}
