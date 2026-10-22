import { z } from "zod";
import type { AnalysisError } from "../analysisErrorBase.js";
import { parseExactJson } from "../exactJsonNumber.js";
import { ok, type Result } from "../result.js";
import {
  WEB_NETWORK_CAPTURE_LIMITS,
  type WebNetworkCaptureRecord,
} from "../webNetworkCapture.js";
import type { UnsignedAnalysisView } from "./analysisView.js";
import {
  EnvironmentManifestAccumulator,
  isJsonLike,
} from "./EnvironmentManifestAccumulator.js";
import { EnvironmentStateExtraction } from "./EnvironmentStateExtraction.js";
import type { TemplateRule } from "./environmentManifestRules.js";
import {
  isStateWrite,
  type ParsedBody,
  type StateRecordFacts,
  type StateTimeline,
} from "./environmentStateRules.js";
import {
  base64PrefixChars,
  readRecordedResponseBody,
} from "./recordedResponseBody.js";
import {
  ENTRY_BYTES,
  RECORD_SCRATCH_BYTES,
  mediaTypeEssence,
  readRecordedRequestLine,
  textBytes,
} from "./webNetworkRouteTemplates.js";

type StateView = Extract<UnsignedAnalysisView, { kind: "environment-state" }>;
type StateFields = Pick<
  StateView,
  | "origin"
  | "name"
  | "timeline"
  | "types"
  | "entities"
  | "documents"
  | "views"
  | "unknowns"
  | "coverage"
  | "limitations"
>;

/** Bodies beyond this many UTF-8 bytes are not parsed into state; their views stay recorded. */
export const STATE_BODY_LIMIT_BYTES = 256 * 1024;

const timingSchema = z.object({
  startedDateTime: z.string(),
  time: z.number().nonnegative(),
});
const redactedWriteSchema = z.object({
  request: z.object({ method: z.string() }),
  response: z.object({ status: z.number() }).optional(),
});
const contentSchema = z.object({
  response: z.object({ content: z.object({ text: z.string() }) }),
});

interface RecordEntry {
  readonly facts: StateRecordFacts;
  /** Null for a write whose URL was redacted: its target is unknown, so it bounds every type. */
  readonly origin: string | null;
  readonly contentType: string;
  readonly timed: boolean;
  readonly record: WebNetworkCaptureRecord;
}

const UNKNOWNS: StateView["unknowns"] = [
  {
    kind: "authorization-model",
    statement:
      "Authorization headers and cookies are structurally excluded from captures; the state states no authorization model.",
  },
  {
    kind: "response-semantics",
    statement:
      "Views reproduce their recorded responses from the state; they do not establish how the application computes responses, derived values or values copied outside entity objects.",
  },
  {
    kind: "state-transition",
    statement:
      "The state is one snapshot from before the first related recorded write; it states no effects of writes.",
  },
];

/** The manifest's grouping plus the record facts and bodies the init state is extracted from. */
export class EnvironmentStateAccumulator extends EnvironmentManifestAccumulator {
  readonly #entries = new Map<number, RecordEntry>();

  constructor(
    maximumBytes = WEB_NETWORK_CAPTURE_LIMITS.outputBytes,
    rules: readonly TemplateRule[] = [],
  ) {
    super(maximumBytes, true, rules, "Environment-state");
  }

  /** The state publishes no body shapes. */
  protected override get reportsBodyShapes(): boolean {
    return false;
  }

  override add(record: WebNetworkCaptureRecord): Result<void, AnalysisError> {
    const grouped = super.add(record);
    if (!grouped.ok) return grouped;
    try {
      const line = readRecordedRequestLine(record.reported, true, this.scratch);
      if (line === null) return this.overBudget();
      const timing = timingSchema.safeParse(record.reported);
      const start = timing.success
        ? Date.parse(timing.data.startedDateTime)
        : Number.NaN;
      const timed = timing.success && Number.isFinite(start);
      if (line.kind === "excluded")
        return line.reason === "url-redacted"
          ? this.#redactedWrite(
              record,
              timing.success && timed
                ? { start, end: start + timing.data.time }
                : undefined,
            )
          : ok(undefined);
      // The entry keeps the line's strings and a reference to the already admitted record.
      if (
        !this.retain(
          ENTRY_BYTES * 8 +
            textBytes(
              line.method.length +
                line.origin.length +
                line.path.length +
                (line.query?.length ?? 0) +
                line.rawMime.length,
            ),
        )
      )
        return this.overBudget();
      this.#entries.set(record.ordinal, {
        facts: {
          ordinal: record.ordinal,
          method: line.method,
          path: line.path,
          query: line.query === "" ? undefined : line.query,
          status: line.status,
          start: timed ? start : record.ordinal,
          end: timed ? start + timing.data.time : record.ordinal,
        },
        origin: line.origin,
        contentType: line.rawMime,
        timed,
        record,
      });
      return ok(undefined);
    } finally {
      this.releaseTemporary();
    }
  }

  /** Keep a successful write whose URL was redacted, with an empty path whose root relates to every type. */
  #redactedWrite(
    record: WebNetworkCaptureRecord,
    timing: { readonly start: number; readonly end: number } | undefined,
  ): Result<void, AnalysisError> {
    const parsed = redactedWriteSchema.safeParse(record.reported);
    if (!parsed.success) return ok(undefined);
    const status = parsed.data.response?.status ?? 0;
    const facts: StateRecordFacts = {
      ordinal: record.ordinal,
      method: parsed.data.request.method,
      path: "",
      query: undefined,
      status: status > 0 ? status : null,
      start: timing?.start ?? record.ordinal,
      end: timing?.end ?? record.ordinal,
    };
    if (!isStateWrite(facts)) return ok(undefined);
    if (!this.retain(ENTRY_BYTES * 8 + textBytes(facts.method.length)))
      return this.overBudget();
    this.#entries.set(record.ordinal, {
      facts,
      origin: null,
      contentType: "",
      timed: timing !== undefined,
      record,
    });
    return ok(undefined);
  }

  /** Parse one retained response body as exact JSON, charging its decoding and tree as temporary work. */
  #body(ordinal: number): ParsedBody | null {
    const entry = this.#entries.get(ordinal);
    if (entry === undefined || !isJsonLike(mediaTypeEssence(entry.contentType)))
      return { kind: "unusable" };
    const content = contentSchema.safeParse(entry.record.reported);
    if (!content.success) return { kind: "unusable" };
    // Larger bodies are never parsed; within the limit, decoding copies at most the retained text and the tree is linear in it.
    const length = content.data.response.content.text.length;
    if (length > base64PrefixChars(STATE_BODY_LIMIT_BYTES))
      return { kind: "unusable" };
    if (!this.temporary(RECORD_SCRATCH_BYTES + textBytes(length) * 4))
      return null;
    const body = readRecordedResponseBody(entry.record, STATE_BODY_LIMIT_BYTES);
    if (
      body.bodyText === null ||
      body.bodyEncoding === "base64" ||
      body.bodyCut === true ||
      Buffer.byteLength(body.bodyText, "utf8") > STATE_BODY_LIMIT_BYTES
    )
      return { kind: "unusable" };
    const value = parseExactJson(body.bodyText);
    return value === undefined ? { kind: "unusable" } : { kind: "json", value };
  }

  /** Project the init state of the manifest's primary origin; records keep timeline order. */
  finishState(): Result<StateFields, AnalysisError> {
    const manifest = this.finish();
    if (!manifest.ok) return manifest;
    const entries = [...this.#entries.values()].filter(
      (entry) =>
        entry.origin === manifest.value.origin || entry.origin === null,
    );
    const redactedWrites = entries.filter(
      (entry) => entry.origin === null,
    ).length;
    const timeline: StateTimeline =
      entries.length > 0 && entries.every((entry) => entry.timed)
        ? "recorded-start-time"
        : "record-order";
    const records = entries
      .map((entry) => entry.facts)
      .sort((left, right) =>
        timeline === "record-order"
          ? left.ordinal - right.ordinal
          : left.start - right.start || left.ordinal - right.ordinal,
      )
      .map((facts) =>
        timeline === "record-order"
          ? { ...facts, start: facts.ordinal, end: facts.ordinal }
          : facts,
      );
    const state = new EnvironmentStateExtraction({
      tools: manifest.value.tools,
      records,
      timeline,
      budget: {
        body: (ordinal) => this.#body(ordinal),
        retain: (bytes) => this.retain(bytes),
        release: () => this.releaseTemporary(),
      },
    }).run();
    if (state === null) return this.overBudget();
    const limitations = this.addLimitations([
      ...(redactedWrites > 0
        ? [
            `${String(redactedWrites)} of the recorded writes had a redacted URL; each ends the initial state of every type, since its target is unknown.`,
          ]
        : []),
      ...(timeline === "record-order"
        ? [
            "Some records carry no start time, so the state's timeline is record order and overlapping requests are not detected.",
          ]
        : []),
      ...(state.views.some((view) => view.shape === "recorded")
        ? [
            "Tools whose recordings do not reproduce from the extracted state are listed as recorded views with the reason; they replay their recordings.",
          ]
        : []),
    ]);
    if (!limitations.ok) return limitations;
    return ok({
      origin: manifest.value.origin,
      name: manifest.value.name,
      timeline,
      ...state,
      unknowns: UNKNOWNS.map((unknown) => ({ ...unknown })),
      coverage: manifest.value.coverage,
      limitations: this.sortedLimitations(),
    });
  }
}
