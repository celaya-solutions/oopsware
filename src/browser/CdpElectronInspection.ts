import { digestCanonicalValue } from "../domain/canonicalDigest.js";
import type { ProgressReporter } from "../application/ProgressReporter.js";
import type {
  ElectronPageInspection,
  InspectElectronPageInput,
} from "../domain/javascript/electronObservation.js";
import { BrowserObservationError } from "../domain/browserObservationError.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import type { CdpConnection, CdpEvent } from "./CdpConnection.js";
import type { CdpEndpointDiscovery, CdpEndpointTarget } from "./CdpEndpoint.js";
import { CdpCaptureCompleteness } from "./CdpCaptureCompleteness.js";
import {
  delayWithCancellation,
  resourceContentSize,
  recordValue,
  requiredRecord,
  cdpStringValue,
} from "./CdpCaptureValues.js";
import {
  frameTreeResources,
  snapshotDocuments,
  walkFrameTrees,
} from "./CdpCaptureDocuments.js";
import { snapshotDocumentNodes, snapshotNodeAt } from "./CdpSnapshotNodes.js";
import { cdpSnapshotString } from "./CdpSnapshotStrings.js";
import {
  ingestElectronScriptEvent,
  type ElectronScriptDraft,
} from "./CdpElectronScriptEvents.js";
import { captureElectronScripts } from "./CdpElectronScripts.js";
import { captureElectronWorkers } from "./CdpElectronWorkers.js";
import { authorizedElectronFile } from "./ElectronFileScope.js";
import { compareUnicodeCodePoints } from "../domain/unicodeCodePointOrder.js";

interface ElectronContext {
  readonly connection: CdpConnection;
  readonly sessionId: string | undefined;
  readonly discovery: CdpEndpointDiscovery;
  readonly target: CdpEndpointTarget;
  readonly input: InspectElectronPageInput;
  readonly signal?: AbortSignal;
  readonly progress?: ProgressReporter;
}

interface ElectronInspectionState {
  readonly completeness: CdpCaptureCompleteness;
  readonly scripts: ElectronScriptDraft[];
  readonly executionContextFrames: Map<string, string>;
  readonly limitations: string[];
  mainFrameId: string | undefined;
  navigationDuringCapture: boolean;
}

/** Passively inspect one Electron file page from the selected CDP endpoint. */
export const inspectCdpElectronPage = async (
  context: ElectronContext,
): Promise<ElectronPageInspection> => {
  const state: ElectronInspectionState = {
    completeness: new CdpCaptureCompleteness(),
    scripts: [],
    executionContextFrames: new Map(),
    limitations: [
      "Local file paths exposed by the selected CDP target are retained in the observation.",
      "Oopsware does not evaluate renderer JavaScript, invoke Electron APIs, navigate, click, or close the page.",
      "Select include_script_sources to retain script contents.",
      ...(context.target.attached === null
        ? [
            "CDP discovery omitted the target attachment state; attached is reported as unknown.",
          ]
        : []),
    ],
    mainFrameId: undefined,
    navigationDuringCapture: false,
  };
  const removeListener = context.connection.onEvent((event) => {
    if (event.sessionId !== context.sessionId) return;
    ingestElectronScriptEvent({
      event,
      scripts: state.scripts,
      executionContextFrames: state.executionContextFrames,
      completeness: state.completeness,
    });
    if (
      state.mainFrameId !== undefined &&
      navigatedFrameId(event) === state.mainFrameId
    )
      state.navigationDuringCapture = true;
  });
  try {
    return await runElectronInspection(
      context,
      state,
      new Date().toISOString(),
    );
  } finally {
    removeListener();
  }
};

const runElectronInspection = async (
  context: ElectronContext,
  state: ElectronInspectionState,
  startedAt: string,
): Promise<ElectronPageInspection> => {
  const frames = await authorizeInitialFrames(context, state);
  const main = frames.at(0);
  if (main === undefined)
    throw new BrowserObservationError("inspect_web_page", "target_not_allowed");
  state.mainFrameId = main.frame_id;
  await enableElectronCapture(context);
  await delayWithCancellation(
    context.input.observation_ms,
    "inspect_electron_page",
    context.signal,
  );
  const captured = await captureElectronContent(context, state, frames);
  await assertStableMainFrame(context, state, main.file_path);
  await report(context.progress, 3, "Electron inspection complete");
  return {
    browser: context.discovery.version,
    target: {
      target_id: context.target.id,
      type: context.target.type,
      title: context.target.title,
      file_path: main.file_path,
      attached: context.target.attached,
    },
    capture_window: {
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      observation_ms: context.input.observation_ms,
    },
    completeness: state.completeness.snapshot(),
    frames,
    ...captured,
    limitations: state.limitations,
  };
};

const authorizeInitialFrames = async (
  context: ElectronContext,
  state: ElectronInspectionState,
): Promise<ElectronPageInspection["frames"]> => {
  await report(context.progress, 1, "Authorizing Electron file frames");
  await context.connection.send(
    "Page.enable",
    {},
    context.sessionId,
    context.signal,
  );
  const result = await context.connection.send(
    "Page.getFrameTree",
    {},
    context.sessionId,
    context.signal,
  );
  const frames = await captureFrames(
    result,
    state.completeness,
    context.signal,
  );
  if (frames[0] === undefined)
    throw new BrowserObservationError("inspect_web_page", "target_not_allowed");
  return frames;
};

const enableElectronCapture = async (
  context: ElectronContext,
): Promise<void> => {
  await context.connection.send(
    "Runtime.enable",
    {},
    context.sessionId,
    context.signal,
  );
  await context.connection.send(
    "Debugger.enable",
    {},
    context.sessionId,
    context.signal,
  );
};

const captureElectronContent = async (
  context: ElectronContext,
  state: ElectronInspectionState,
  frames: ElectronPageInspection["frames"],
): Promise<
  Pick<ElectronPageInspection, "dom" | "scripts" | "resources" | "workers">
> => {
  await report(context.progress, 2, "Capturing Electron structure");
  const frameIds = new Set(frames.map((frame) => frame.frame_id));
  const resources = await captureResources(context, state.completeness);
  const dom = await captureDom(context, state.completeness);
  const scripts = await captureElectronScripts({
    connection: context.connection,
    sessionId: context.sessionId,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
    request: context.input,
    scripts: state.scripts,
    frameIds,
    completeness: state.completeness,
  });
  const workers = await captureElectronWorkers({
    connection: context.connection,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
    target: context.target,
    request: context.input,
    frameIds,
    completeness: state.completeness,
    limitations: state.limitations,
  });
  return { dom, scripts, resources, workers };
};

const assertStableMainFrame = async (
  context: ElectronContext,
  state: ElectronInspectionState,
  expectedPath: string,
): Promise<void> => {
  const result = await context.connection.send(
    "Page.getFrameTree",
    {},
    context.sessionId,
    context.signal,
  );
  const afterPath = await mainFilePath(result, context.signal);
  if (afterPath === undefined)
    throw new BrowserObservationError("inspect_web_page", "target_not_allowed");
  if (state.navigationDuringCapture || afterPath !== expectedPath)
    throw new BrowserObservationError("inspect_web_page", "target_changed");
};

const navigatedFrameId = (event: CdpEvent): string | undefined => {
  const params = recordValue(event.params);
  if (params === undefined) return undefined;
  if (event.method === "Page.frameNavigated")
    return cdpStringValue(recordValue(params.frame)?.id);
  if (event.method === "Page.navigatedWithinDocument")
    return cdpStringValue(params.frameId);
  return undefined;
};

export const captureFrames = async (
  result: unknown,
  completeness: CdpCaptureCompleteness,
  signal?: AbortSignal,
): Promise<ElectronPageInspection["frames"]> => {
  const frameTree = recordValue(requiredRecord(result).frameTree);
  if (frameTree === undefined)
    throw new BrowserObservationError("inspect_web_page", "protocol_error");
  const frames: ElectronPageInspection["frames"] = [];
  for (const tree of walkFrameTrees(frameTree, () =>
    completeness.exclude("frames", "invalid_protocol_value"),
  )) {
    throwIfElectronInspectionCancelled(signal);
    const frame = recordValue(tree.frame);
    const frameId = cdpStringValue(frame?.id);
    if (frame === undefined || frameId === undefined) {
      completeness.exclude("frames", "invalid_protocol_value");
      continue;
    }
    const path = await authorizedElectronFile(
      cdpStringValue(frame.url) ?? "",
      signal,
      "inspect_electron_page",
    );
    if (path === undefined) {
      completeness.exclude("frames", "out_of_target_scope");
      continue;
    }
    frames.push({
      frame_id: frameId,
      parent_frame_id: cdpStringValue(frame?.parentId) ?? null,
      file_path: path,
    });
  }
  return frames;
};

const captureResources = async (
  context: ElectronContext,
  completeness: CdpCaptureCompleteness,
): Promise<ElectronPageInspection["resources"]> => {
  const result = await context.connection.send(
    "Page.getResourceTree",
    {},
    context.sessionId,
    context.signal,
  );
  const root = recordValue(requiredRecord(result).frameTree);
  if (root === undefined)
    throw new BrowserObservationError("inspect_web_page", "protocol_error");
  const resources: ElectronPageInspection["resources"] = [];
  const seen = new Set<string>();
  for (const resource of frameTreeResources(root, (count) =>
    completeness.exclude("resources", "invalid_protocol_value", count),
  )) {
    throwIfElectronInspectionCancelled(context.signal);
    const path = await authorizedElectronFile(
      cdpStringValue(resource.url) ?? "",
      context.signal,
      "inspect_electron_page",
    );
    if (path === undefined) {
      completeness.exclude("resources", "out_of_target_scope");
      continue;
    }
    const contentSize = resourceContentSize(resource.contentSize);
    if (!contentSize.ok)
      completeness.exclude("resources", "invalid_protocol_value");
    const item = {
      file_path: path,
      type: cdpStringValue(resource.type) ?? "Other",
      mime_type: cdpStringValue(resource.mimeType) ?? "",
      content_size: contentSize.ok ? contentSize.value : null,
    };
    const resourceKey = `electron_resource_${digestCanonicalValue(item, "CDP capture")}`;
    if (seen.has(resourceKey)) continue;
    seen.add(resourceKey);
    resources.push({
      resource_key: resourceKey,
      ...item,
    });
  }
  return resources.sort((left, right) =>
    compareUnicodeCodePoints(left.resource_key, right.resource_key),
  );
};

const captureDom = async (
  context: ElectronContext,
  completeness: CdpCaptureCompleteness,
): Promise<ElectronPageInspection["dom"]> => {
  const result = requiredRecord(
    await context.connection.send(
      "DOMSnapshot.captureSnapshot",
      { computedStyles: [], includePaintOrder: false, includeDOMRects: false },
      context.sessionId,
      context.signal,
    ),
  );
  const invalid = (count: number | null) =>
    completeness.exclude("dom", "invalid_protocol_value", count);
  if (!Array.isArray(result.strings)) {
    invalid(null);
    return { total_nodes: 0, nodes: [] };
  }
  const strings = result.strings.map(cdpStringValue);
  const nodes: ElectronPageInspection["dom"]["nodes"] = [];
  let total = 0;
  for (const document of snapshotDocuments(result.documents, invalid)) {
    throwIfElectronInspectionCancelled(context.signal);
    const documentUrl = cdpSnapshotString(strings, document.documentURL);
    if (documentUrl === undefined) {
      invalid(1);
      continue;
    }
    if (
      (await authorizedElectronFile(
        documentUrl,
        context.signal,
        "inspect_electron_page",
      )) === undefined
    ) {
      completeness.exclude("dom", "out_of_target_scope");
      continue;
    }
    // The shared snapshot owner validates the parallel node arrays.
    const documentNodes = snapshotDocumentNodes(document.nodes, strings);
    if (documentNodes === undefined) {
      invalid(1);
      continue;
    }
    if (documentNodes.excessAttributes > 0)
      invalid(documentNodes.excessAttributes);
    const baseIndex = total;
    total += documentNodes.nodeTypes.length;
    for (let index = 0; index < documentNodes.nodeTypes.length; index += 1) {
      const admitted = snapshotNodeAt(documentNodes, index);
      if (!admitted.ok) {
        invalid(1);
        continue;
      }
      const { nodeType, nodeName, nodeValue, parent, attributes } =
        admitted.value;
      nodes.push({
        index: baseIndex + index,
        parent_index: parent < 0 ? -1 : baseIndex + parent,
        node_type: nodeType,
        node_name: nodeName,
        node_value_length: Buffer.byteLength(nodeValue),
        attribute_names: attributes.map(([name]) => name),
      });
    }
  }
  return { total_nodes: total, nodes };
};

const mainFilePath = async (
  result: unknown,
  signal?: AbortSignal,
): Promise<string | undefined> => {
  const frameTree = recordValue(requiredRecord(result).frameTree);
  const frame = recordValue(frameTree?.frame);
  return await authorizedElectronFile(
    cdpStringValue(frame?.url) ?? "",
    signal,
    "inspect_electron_page",
  );
};

const throwIfElectronInspectionCancelled = (signal?: AbortSignal): void => {
  if (signal?.aborted === true)
    throw new AnalysisCancelledError("inspect_electron_page", {
      cause: signal.reason,
    });
};

const report = async (
  progress: ProgressReporter | undefined,
  completed: number,
  message: string,
): Promise<void> =>
  await progress?.report({
    phase: "browser_observation",
    completed,
    total: 3,
    message,
    ...(completed === 3 ? { terminal: true } : {}),
  });
