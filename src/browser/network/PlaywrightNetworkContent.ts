import { createHash } from "node:crypto";

import {
  AnalysisCancelledError,
  AnalysisTimeoutError,
} from "../../domain/analysisErrorCore.js";
import type {
  BrowserNetworkBody,
  BrowserNetworkHeaders,
} from "../../domain/browserNetworkEvidence.js";
import type {
  BrowserScenarioEventAdmission,
  BrowserScenarioEventBudgetReason,
} from "../../domain/browserScenarioCaptureValues.js";
import type { BrowserScenarioSecrets } from "../BrowserScenarioSecrets.js";
import { withPlaywrightExecutionBoundary } from "../PlaywrightExecutionBoundary.js";

/** The producer seam for ordered, duplicate-preserving HTTP headers. */
export interface NetworkHeadersSource {
  headers(): Record<string, string>;
  headersArray(): Promise<{ name: string; value: string }[]>;
}

/** A bounded read cannot delay browser cleanup indefinitely. */
export interface NetworkReadOptions {
  readonly timeoutMs: number;
  readonly maxBodyBytes: number;
  readonly maxBodyAllocationBytes: number;
  readonly maxHeaderAllocationBytes: number;
  readonly maxMetadataAllocationBytes: number;
  readonly signal?: AbortSignal;
}

export type NetworkBodyCapture =
  | BrowserNetworkBody
  | {
      readonly state: "omitted";
      readonly reason: BrowserScenarioEventBudgetReason;
    };

export type NetworkBodyPreflight = (input: {
  readonly observedBytes: number;
  readonly allocationBytes: number;
  readonly mediaType: string | undefined;
}) => BrowserScenarioEventAdmission;

const credentialHeaders = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
]);

const errorMessage = (
  cause: unknown,
  secrets: BrowserScenarioSecrets,
  maxMetadataAllocationBytes: number,
): string => {
  const message =
    cause instanceof Error && cause.message !== ""
      ? cause.message
      : "Network read failed";
  return secrets.redactionAllocationCost(message.length) <=
    maxMetadataAllocationBytes
    ? secrets.redact(message)
    : "Network read failed; diagnostic exceeds the allocation budget.";
};

/** Read actual producer headers without flattening duplicates or exposing credentials. */
export const captureNetworkHeaders = async (
  source: NetworkHeadersSource,
  secrets: BrowserScenarioSecrets,
  options: NetworkReadOptions,
): Promise<BrowserNetworkHeaders> => {
  try {
    const headers = await withPlaywrightExecutionBoundary(
      () => source.headersArray(),
      options.timeoutMs,
      options.signal,
    );
    let cost = 0;
    for (const { name, value } of headers) {
      cost += secrets.redactionAllocationCost(name.length + value.length) + 128;
      if (cost > options.maxHeaderAllocationBytes)
        return {
          state: "unavailable",
          message: `Headers exceed the ${String(options.maxHeaderAllocationBytes)}-byte allocation budget.`,
        };
    }
    return {
      state: "captured",
      items: headers.map(({ name, value }) => {
        const safeName = secrets.redact(name);
        const credential = credentialHeaders.has(name.toLowerCase());
        const safeValue = credential
          ? null
          : secrets.redactBytes(Buffer.from(value)).toString("utf8");
        return {
          name: safeName,
          value: safeValue,
          redacted: credential || safeName !== name || safeValue !== value,
        };
      }),
    };
  } catch (cause: unknown) {
    return {
      state: "unavailable",
      message: errorMessage(cause, secrets, options.maxMetadataAllocationBytes),
    };
  }
};

/** Retain bytes returned by Playwright's body API, after declared-secret redaction. */
export const captureNetworkBody = async (
  read: () => Promise<Buffer | null>,
  phase: "request" | "response",
  source: NetworkHeadersSource,
  secrets: BrowserScenarioSecrets,
  options: NetworkReadOptions,
  preflight?: NetworkBodyPreflight,
): Promise<NetworkBodyCapture> => {
  try {
    const observed = await withPlaywrightExecutionBoundary(
      read,
      options.timeoutMs,
      options.signal,
    );
    if (observed === null) return { state: "not_exposed" };
    // This bounds subsequent redaction, base64 and validation copies, but the
    // Playwright API itself has already materialized the body (see PR limits).
    const maxBodyBytes = options.maxBodyBytes;
    if (observed.length > maxBodyBytes)
      return {
        state: "unavailable",
        reason: "body-size-limit",
        message: `Playwright materialized the body before its ${String(maxBodyBytes)}-byte retained-body budget was checked.`,
        limit_bytes: maxBodyBytes,
        observed_bytes: observed.length,
      };
    const bodyAllocationCost = secrets.redactionAllocationCost(observed.length);
    const base64AllocationCost = Math.ceil(observed.length / 3) * 4 * 8 + 2;
    const maxBodyAllocationBytes = options.maxBodyAllocationBytes;
    const observedBodyAllocationBytes = Math.max(
      bodyAllocationCost,
      base64AllocationCost,
    );
    if (observedBodyAllocationBytes > maxBodyAllocationBytes)
      return {
        state: "unavailable",
        reason: "body-allocation-limit",
        message:
          "Body redaction exceeds the selected network body allocation budget.",
        limit_allocation_bytes: maxBodyAllocationBytes,
        observed_allocation_bytes: observedBodyAllocationBytes,
      };
    const contentType = source.headers()["content-type"];
    if (
      contentType !== undefined &&
      secrets.redactionAllocationCost(contentType.length) >
        options.maxHeaderAllocationBytes
    )
      return {
        state: "unavailable",
        reason: "body-allocation-limit",
        message:
          "Content type exceeds the selected network header allocation budget.",
        limit_allocation_bytes: options.maxHeaderAllocationBytes,
        observed_allocation_bytes: secrets.redactionAllocationCost(
          contentType.length,
        ),
      };
    const admission = preflight?.({
      observedBytes: observed.length,
      allocationBytes: observedBodyAllocationBytes,
      mediaType: contentType,
    });
    if (admission?.status === "omitted")
      return { state: "omitted", reason: admission.reason };
    const retained = secrets.redactBytes(observed);
    return {
      state: "captured",
      representation:
        phase === "request"
          ? "browser-exposed-request-bytes"
          : "playwright-response-body-bytes",
      encoding: "base64",
      content: retained.toString("base64"),
      bytes: retained.length,
      sha256: createHash("sha256").update(retained).digest("hex"),
      media_type:
        contentType === undefined
          ? null
          : secrets.redactBytes(Buffer.from(contentType)).toString("utf8"),
      redacted: !retained.equals(observed),
    };
  } catch (cause: unknown) {
    return {
      state: "unavailable",
      reason:
        cause instanceof AnalysisCancelledError
          ? "cancelled"
          : cause instanceof AnalysisTimeoutError
            ? "body-read-timeout"
            : "body-read-failed",
      message: errorMessage(cause, secrets, options.maxMetadataAllocationBytes),
    };
  }
};
