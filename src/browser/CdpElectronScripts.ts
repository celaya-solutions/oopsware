import type {
  ElectronPageInspection,
  InspectElectronPageInput,
} from "../domain/javascript/electronObservation.js";
import { digestCanonicalValue } from "../domain/canonicalDigest.js";
import { createWebTextArtifact } from "../domain/webContentArtifact.js";
import type { CdpConnection } from "./CdpConnection.js";
import { CdpCaptureCompleteness } from "./CdpCaptureCompleteness.js";
import { requiredScriptSource } from "./CdpCaptureValues.js";
import type { ElectronScriptDraft } from "./CdpElectronScriptEvents.js";
import { authorizedElectronFile } from "./ElectronFileScope.js";
import { compareUnicodeCodePoints } from "../domain/unicodeCodePointOrder.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import {
  CDP_SCRIPT_SOURCE_BYTES_OMISSION_REASON,
  CDP_SCRIPT_SOURCE_DEADLINE_OMISSION_REASON,
  CdpScriptSourceBudget,
} from "./CdpScriptSourceBudget.js";

interface ElectronScriptCaptureInput {
  readonly connection: CdpConnection;
  readonly sessionId: string | undefined;
  readonly signal?: AbortSignal;
  readonly request: InspectElectronPageInput;
  readonly scripts: readonly ElectronScriptDraft[];
  readonly frameIds: ReadonlySet<string>;
  readonly completeness: CdpCaptureCompleteness;
}

/** Normalize local script metadata and optionally approved source. */
export const captureElectronScripts = async (
  input: ElectronScriptCaptureInput,
): Promise<ElectronPageInspection["scripts"]> => {
  let total = 0;
  const items: ElectronPageInspection["scripts"]["items"] = [];
  const seen = new Set<string>();
  const sourceBudget =
    input.request.include_script_sources && input.scripts.length > 0
      ? new CdpScriptSourceBudget(input.signal)
      : undefined;
  try {
    for (const script of input.scripts) {
      throwIfCallerCancelled(input.signal);
      const path = await authorizedElectronFile(
        script.rawUrl,
        input.signal,
        "inspect_electron_page",
      );
      if (path === undefined) {
        input.completeness.exclude("scripts", "out_of_target_scope");
        continue;
      }
      const identity = {
        frame_id:
          script.frameId !== null && input.frameIds.has(script.frameId)
            ? script.frameId
            : null,
        file_path: path,
        cdp_hash: script.hash,
        length: script.length,
        is_module: script.isModule,
        language: script.language,
      };
      const scriptKey = `electron_script_${digestCanonicalValue(identity, "CDP capture")}`;
      if (seen.has(scriptKey)) continue;
      seen.add(scriptKey);
      total += 1;
      let source: ElectronScriptSource = input.request.include_script_sources
        ? {
            included: false,
            reason: CDP_SCRIPT_SOURCE_DEADLINE_OMISSION_REASON,
          }
        : {
            included: false,
            reason: "source capture was not selected",
          };
      if (
        input.request.include_script_sources &&
        isSourceDeadlineExpired(sourceBudget)
      ) {
        excludeScriptSource(input.completeness);
      } else if (
        input.request.include_script_sources &&
        sourceBudget !== undefined
      ) {
        try {
          source = await captureScriptSource(input, script, sourceBudget);
        } catch (cause: unknown) {
          throwIfCallerCancelled(input.signal);
          if (isSourceDeadlineExpired(sourceBudget)) {
            excludeScriptSource(input.completeness);
          } else {
            throw cause;
          }
        }
      }
      items.push({ script_key: scriptKey, ...identity, source });
    }
  } finally {
    sourceBudget?.dispose();
  }
  if (!input.request.include_script_sources)
    input.completeness.exclude("script_sources", "not_approved", total);
  return {
    total,
    items: items.sort((left, right) =>
      compareUnicodeCodePoints(left.script_key, right.script_key),
    ),
  };
};

type ElectronScriptSource =
  ElectronPageInspection["scripts"]["items"][number]["source"];

const captureScriptSource = async (
  input: ElectronScriptCaptureInput,
  script: ElectronScriptDraft,
  sourceBudget: CdpScriptSourceBudget,
): Promise<ElectronScriptSource> => {
  const response = await input.connection.send(
    "Debugger.getScriptSource",
    { scriptId: script.scriptId },
    input.sessionId,
    sourceBudget.signal,
  );
  throwIfCallerCancelled(input.signal);
  const text = requiredScriptSource(response, "inspect_electron_page");
  if (sourceBudget.timedOut) {
    excludeScriptSource(input.completeness);
    return {
      included: false,
      reason: CDP_SCRIPT_SOURCE_DEADLINE_OMISSION_REASON,
    };
  }
  if (!sourceBudget.admit(text)) {
    excludeScriptSource(input.completeness);
    return { included: false, reason: CDP_SCRIPT_SOURCE_BYTES_OMISSION_REASON };
  }
  return {
    included: true,
    artifact: createWebTextArtifact(text, "text/javascript"),
  };
};

const excludeScriptSource = (completeness: CdpCaptureCompleteness): void => {
  completeness.exclude("script_sources", "resource_budget_exhausted");
};

const throwIfCallerCancelled = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted === true)
    throw new AnalysisCancelledError("inspect_electron_page", {
      cause: signal.reason,
    });
};

const isSourceDeadlineExpired = (
  sourceBudget: CdpScriptSourceBudget | undefined,
): boolean => sourceBudget?.timedOut === true;
