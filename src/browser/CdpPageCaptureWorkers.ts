import type { WebPageInspection } from "../domain/browserObservationSchemas.js";
import type { CdpCaptureEvents } from "./CdpCaptureEvents.js";
import {
  admitRecords,
  allowedSanitizedUrl,
  isHttpUrl,
  recordValue,
  cdpStringValue,
} from "./CdpCaptureValues.js";
import type { CaptureContext } from "./CdpPageCapture.js";
import { optionalCdpCommand } from "./CdpOptionalCommand.js";

interface CaptureWorkersInput {
  readonly context: CaptureContext;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly limitations: string[];
  readonly events: CdpCaptureEvents;
}

export const captureWorkers = async (
  input: CaptureWorkersInput,
  frameIds: ReadonlySet<string>,
): Promise<WebPageInspection["workers"]> => {
  const { context, allowedOrigins, limitations, events } = input;
  const completeness = events.completeness;
  const result = await optionalCdpCommand(
    { ...context, sessionId: undefined },
    "Target.getTargets",
    {},
    limitations,
  );
  const items: WebPageInspection["workers"] = [];
  if (result === undefined) completeness.unavailable("workers");
  const targets = admitRecords(recordValue(result)?.targetInfos);
  if (result !== undefined && targets === undefined) {
    completeness.exclude("workers", "invalid_protocol_value", null);
    return items;
  }
  let malformedEntries = 0;
  for (const entry of targets ?? []) {
    const target = recordValue(entry);
    if (target === undefined) {
      malformedEntries += 1;
      continue;
    }
    const type = cdpStringValue(target.type);
    if (type === undefined || type.length === 0) {
      malformedEntries += 1;
      continue;
    }
    if (!type.includes("worker")) continue;
    const targetId = cdpStringValue(target.targetId);
    if (
      targetId === undefined ||
      targetId.length === 0 ||
      typeof target.attached !== "boolean" ||
      typeof target.url !== "string"
    ) {
      malformedEntries += 1;
      continue;
    }
    const openerId =
      target.openerId === undefined
        ? undefined
        : cdpStringValue(target.openerId);
    const parentFrameId =
      target.parentFrameId === undefined
        ? undefined
        : cdpStringValue(target.parentFrameId);
    if (
      (target.openerId !== undefined && openerId === undefined) ||
      (target.parentFrameId !== undefined && parentFrameId === undefined)
    ) {
      malformedEntries += 1;
      continue;
    }
    const url = allowedSanitizedUrl(target.url, allowedOrigins);
    const relatedToPage =
      openerId === context.target.id ||
      (parentFrameId !== undefined && frameIds.has(parentFrameId));
    if (!relatedToPage) {
      completeness.exclude("workers", "out_of_target_scope");
      continue;
    }
    if (url === undefined) {
      const rawUrl = cdpStringValue(target.url);
      completeness.exclude(
        "workers",
        rawUrl === undefined || rawUrl === ""
          ? "unattributed_origin"
          : isHttpUrl(rawUrl)
            ? "disallowed_origin"
            : "unsupported_url",
      );
      continue;
    }
    items.push({
      target_id: targetId,
      type,
      url: url.url,
      origin: url.origin,
      attached: target.attached,
      opener_target_id: openerId ?? null,
      parent_frame_id: parentFrameId ?? null,
    });
  }
  if (malformedEntries > 0)
    completeness.exclude("workers", "invalid_protocol_value", malformedEntries);
  return items;
};
