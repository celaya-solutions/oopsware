import type { WebPageInspection } from "../domain/browserObservationSchemas.js";
import {
  createCapturedWebScriptReconciler,
  stableWebScriptKey,
} from "../domain/webInventory.js";
import type { CapturedResource } from "./CdpCaptureDocuments.js";
import type { CdpCaptureEvents } from "./CdpCaptureEvents.js";
import type { CapturedScript } from "./CdpCaptureEventTypes.js";
import {
  requiredScriptSource,
  sourceExcluded,
  sourceResult,
} from "./CdpCaptureValues.js";
import type { CaptureContext } from "./CdpPageCapture.js";
import type { WebSourceMapRequest } from "./WebSourceMapFetcher.js";
import { compareUnicodeCodePoints } from "../domain/unicodeCodePointOrder.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import type { BrowserObservationOperation } from "../domain/browserObservationErrors.js";
import {
  CDP_SCRIPT_SOURCE_BYTES_OMISSION_REASON,
  CDP_SCRIPT_SOURCE_DEADLINE_OMISSION_REASON,
  CdpScriptSourceBudget,
} from "./CdpScriptSourceBudget.js";

export interface CapturedScripts {
  readonly inventory: WebPageInspection["scripts"];
  readonly sourceMapRequests: readonly WebSourceMapRequest[];
}

export interface CaptureScriptsOptions {
  readonly context: CaptureContext;
  readonly events: CdpCaptureEvents;
  readonly rawResources: readonly CapturedResource[];
  readonly resources: WebPageInspection["resources"];
  readonly frameIds: ReadonlySet<string>;
}

interface ScriptDraftState {
  readonly context: CaptureContext;
  readonly events: CdpCaptureEvents;
  readonly frameIds: ReadonlySet<string>;
  readonly reconcileResource: ReturnType<
    typeof createCapturedWebScriptReconciler
  >;
}

type ScriptDraftItem = Omit<
  WebPageInspection["scripts"]["items"][number],
  "script_key"
>;

export const captureScripts = async (
  options: CaptureScriptsOptions,
): Promise<CapturedScripts> => {
  const { context, events, rawResources, resources, frameIds } = options;
  let state: ScriptDraftState | undefined;
  const drafts: {
    readonly item: ScriptDraftItem;
    readonly sourceMapRawUrl: string | null;
  }[] = [];
  const scripts = [...events.scripts.values()];
  const sourceBudget =
    context.input.include_script_sources && scripts.length > 0
      ? new CdpScriptSourceBudget(context.signal)
      : undefined;
  try {
    for (const script of scripts) {
      state ??= {
        context,
        events,
        frameIds,
        reconcileResource: createCapturedWebScriptReconciler(
          rawResources,
          resources,
        ),
      };
      let source: WebPageInspection["scripts"]["items"][number]["source"] =
        context.input.include_script_sources
          ? sourceExcluded(CDP_SCRIPT_SOURCE_DEADLINE_OMISSION_REASON)
          : sourceExcluded("source capture was not selected");
      if (
        context.input.include_script_sources &&
        isSourceDeadlineExpired(sourceBudget)
      ) {
        events.completeness.exclude(
          "script_sources",
          "resource_budget_exhausted",
        );
      } else if (
        context.input.include_script_sources &&
        sourceBudget !== undefined
      ) {
        try {
          source = await captureScriptSource(script, state, sourceBudget);
        } catch (cause: unknown) {
          throwIfCallerCancelled(context.signal, context.operation);
          if (isSourceDeadlineExpired(sourceBudget))
            events.completeness.exclude(
              "script_sources",
              "resource_budget_exhausted",
            );
          else throw cause;
        }
      }
      drafts.push(buildScriptDraft(script, state, source));
    }
  } finally {
    sourceBudget?.dispose();
  }
  if (!context.input.include_script_sources)
    events.completeness.exclude(
      "script_sources",
      "not_approved",
      events.scripts.size,
    );
  return keyAndBuildInventory(drafts, events.scripts.size);
};

const buildScriptDraft = (
  script: CapturedScript,
  state: ScriptDraftState,
  source: WebPageInspection["scripts"]["items"][number]["source"],
): {
  readonly item: ScriptDraftItem;
  readonly sourceMapRawUrl: string | null;
} => {
  const inventoryScript = {
    frame_id: state.events.frameForScript(script, state.frameIds),
    url: script.url,
    cdp_hash: script.hash,
    length: script.length,
    is_module: script.isModule,
    language: script.language,
    source_map_url: script.sourceMapUrl,
  };
  return {
    item: {
      ...inventoryScript,
      origin: script.origin,
      resource_reconciliation: state.reconcileResource({
        ...inventoryScript,
        rawUrl: script.rawUrl,
      }),
      source,
    },
    sourceMapRawUrl: script.sourceMapRawUrl,
  };
};

const captureScriptSource = async (
  script: CapturedScript,
  state: ScriptDraftState,
  sourceBudget: CdpScriptSourceBudget,
): Promise<WebPageInspection["scripts"]["items"][number]["source"]> => {
  const { context } = state;
  const response = await context.connection.send(
    "Debugger.getScriptSource",
    { scriptId: script.scriptId },
    context.sessionId,
    sourceBudget.signal,
  );
  throwIfCallerCancelled(context.signal, context.operation);
  const content = requiredScriptSource(response, context.operation);
  if (sourceBudget.timedOut) {
    state.events.completeness.exclude(
      "script_sources",
      "resource_budget_exhausted",
    );
    return sourceExcluded(CDP_SCRIPT_SOURCE_DEADLINE_OMISSION_REASON);
  }
  if (!sourceBudget.admit(content)) {
    state.events.completeness.exclude(
      "script_sources",
      "resource_budget_exhausted",
    );
    return sourceExcluded(CDP_SCRIPT_SOURCE_BYTES_OMISSION_REASON);
  }
  return sourceResult(content);
};

const throwIfCallerCancelled = (
  signal: AbortSignal | undefined,
  operation: BrowserObservationOperation,
): void => {
  if (signal?.aborted === true)
    throw new AnalysisCancelledError(operation, { cause: signal.reason });
};

const isSourceDeadlineExpired = (
  sourceBudget: CdpScriptSourceBudget | undefined,
): boolean => sourceBudget?.timedOut === true;

const keyAndBuildInventory = (
  drafts: readonly {
    readonly item: ScriptDraftItem;
    readonly sourceMapRawUrl: string | null;
  }[],
  scriptCount: number,
): CapturedScripts => {
  const keyed = drafts.map((draft) => ({
    ...draft,
    base: stableWebScriptKey(draft.item),
  }));
  keyed.sort(
    (left, right) =>
      compareUnicodeCodePoints(left.base, right.base) ||
      compareUnicodeCodePoints(
        sourceDigest(left.item.source),
        sourceDigest(right.item.source),
      ) ||
      compareUnicodeCodePoints(
        left.item.frame_id ?? "",
        right.item.frame_id ?? "",
      ),
  );
  const totals = new Map<string, number>();
  for (const { base } of keyed) totals.set(base, (totals.get(base) ?? 0) + 1);
  const seen = new Map<string, number>();
  const sourceMapRequests: WebSourceMapRequest[] = [];
  const items = keyed.map(({ base, item, sourceMapRawUrl }) => {
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    const scriptKey =
      totals.get(base) === 1 ? base : `${base}_${String(occurrence)}`;
    if (item.source_map_url !== null && sourceMapRawUrl !== null)
      sourceMapRequests.push({
        scriptKey,
        declaredUrl: item.source_map_url,
        fetchUrl: sourceMapRawUrl,
      });
    return { script_key: scriptKey, ...item };
  });
  return {
    inventory: { total: scriptCount, items },
    sourceMapRequests,
  };
};

const sourceDigest = (
  source: WebPageInspection["scripts"]["items"][number]["source"],
): string => (source.included ? source.artifact.sha256 : source.reason);
