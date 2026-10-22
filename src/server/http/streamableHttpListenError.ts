import { err, ok, type Result } from "../../domain/result.js";

/** Parsed system failure facts for listener recovery guidance. */
export type StreamableHttpListenFailure =
  | {
      readonly kind: "host_lookup";
      readonly systemCode:
        | "ENOTFOUND"
        | "EAI_AGAIN"
        | "EAI_FAIL"
        | "EAI_NONAME"
        | "ENODATA"
        | "EAI_NODATA";
    }
  | { readonly kind: "host_unavailable"; readonly systemCode: "EADDRNOTAVAIL" }
  | { readonly kind: "port_in_use"; readonly systemCode: "EADDRINUSE" }
  | {
      readonly kind: "permission_denied";
      readonly systemCode: "EACCES" | "EPERM";
    };

export interface UnclassifiedStreamableHttpListenFailure {
  readonly kind: "unclassified";
  readonly systemCode?: string;
}

export type StreamableHttpListenClassification = Result<
  StreamableHttpListenFailure,
  UnclassifiedStreamableHttpListenFailure
>;

const systemCode = (cause: unknown): string | undefined => {
  if (typeof cause !== "object" || cause === null || !("code" in cause))
    return undefined;
  const code: unknown = cause.code;
  return typeof code === "string" ? code : undefined;
};

/** Normalize recognized Node listener system codes once, at the listener boundary. */
const classify = (cause: unknown): StreamableHttpListenClassification => {
  const code = systemCode(cause);
  switch (code) {
    case "ENOTFOUND":
    case "EAI_AGAIN":
    case "EAI_FAIL":
    case "EAI_NONAME":
    case "ENODATA":
    case "EAI_NODATA":
      return ok({ kind: "host_lookup", systemCode: code });
    case "EADDRNOTAVAIL":
      return ok({ kind: "host_unavailable", systemCode: "EADDRNOTAVAIL" });
    case "EADDRINUSE":
      return ok({ kind: "port_in_use", systemCode: "EADDRINUSE" });
    case "EACCES":
    case "EPERM":
      return ok({ kind: "permission_denied", systemCode: code });
    default:
      return err({
        kind: "unclassified",
        ...(code === undefined ? {} : { systemCode: code }),
      });
  }
};

export type StreamableHttpListenPhase = "startup" | "serving";

/** Listener failure retaining its native cause, phase, and parsed recovery facts. */
export class StreamableHttpListenError extends Error {
  override readonly name = "StreamableHttpListenError";
  readonly classification: StreamableHttpListenClassification;
  readonly phase: StreamableHttpListenPhase;

  constructor(cause: unknown, phase: StreamableHttpListenPhase = "startup") {
    super(
      phase === "startup"
        ? `MCP HTTP listener startup failed: ${cause instanceof Error ? cause.message : String(cause)}`
        : `MCP HTTP listener failed after binding: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.phase = phase;
    this.classification = classify(cause);
  }
}
