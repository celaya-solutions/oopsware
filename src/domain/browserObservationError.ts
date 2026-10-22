import type {
  BrowserObservationFailureReason,
  BrowserObservationOperation,
} from "./browserObservationErrors.js";
import {
  AnalysisError,
  type AnalysisErrorOptions,
} from "./analysisErrorBase.js";
import { AnalysisCancelledError } from "./analysisErrorCore.js";

/** A bounded passive browser observation failed at its CDP boundary. */
export class BrowserObservationError extends AnalysisError {
  readonly _tag = "BrowserObservationError";
  override cleanupIncomplete: boolean;
  override readonly userCategory: "cancelled" | undefined;
  override readonly userMessage: string | undefined;

  constructor(
    readonly operation: BrowserObservationOperation,
    readonly reason: BrowserObservationFailureReason,
    options?: AnalysisErrorOptions & { readonly detail?: string },
  ) {
    super(`Browser observation ${operation} failed: ${reason}`, options);
    this.userMessage =
      options?.detail ?? observationFailureMessage(operation, reason);
    this.cleanupIncomplete =
      this.cleanup !== undefined || reason === "cleanup_failed";
    this.setCleanupResources(
      this.cleanup?.resources ??
        (reason === "cleanup_failed" ? ["browser_transport"] : []),
    );
    this.userCategory =
      reason === "cancelled" ||
      options?.cause instanceof AnalysisCancelledError ||
      (options?.cause instanceof AnalysisError &&
        options.cause.userCategory === "cancelled")
        ? "cancelled"
        : undefined;
  }
}

const observationFailureMessage = (
  operation: BrowserObservationOperation,
  reason: BrowserObservationFailureReason,
): string | undefined => {
  if (reason === "cancelled")
    return `${operation} was cancelled. Collected observations and cleanup status are reported when available.`;
  if (reason === "timeout")
    return `${operation} exceeded its execution deadline. Review the target's responsiveness and retained observations before retrying.`;
  if (reason === "endpoint_unreachable")
    return `${operation} could not reach the selected loopback debugging endpoint. Verify that the target process is running with debugging enabled and that the endpoint's port matches it, then retry.`;
  if (reason === "target_not_found")
    return `${operation} could not find the selected target at the debugging endpoint. Refresh target discovery for that endpoint and retry with a returned target ID.`;
  if (reason === "service_worker_blocked")
    return `${operation} refused the selected page because it is controlled by or has a registered service worker while the service-worker policy is block. Set environment.service_workers to allow to permit observation, or remove the service worker registration through the browser.`;
  if (reason === "disconnected")
    return `${operation} lost its debugging connection. Verify that the target process is still running, refresh target discovery, and retry the observation.`;
  return undefined;
};
