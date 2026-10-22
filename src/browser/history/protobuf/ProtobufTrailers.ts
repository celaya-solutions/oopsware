import { err, ok, type Result } from "../../../domain/result.js";
import type { ProtobufBudget } from "./ProtobufWire.js";

interface TrailerFacts {
  readonly trailers: { name: string; value: string }[];
  readonly examined_bytes: number;
}

type TrailerFailure = TrailerFacts & {
  readonly kind: "invalid-utf8" | "invalid-name" | "invalid-value";
  readonly reason: string;
};

/** Parse the gRPC-Web HTTP/1 field block without discarding its valid prefix. */
export const parseGrpcWebTrailers = (
  bytes: Uint8Array,
  budget: ProtobufBudget,
): Result<TrailerFacts, TrailerFailure> => {
  let text: string;
  try {
    text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
  } catch (cause) {
    if (!(cause instanceof TypeError)) throw cause;
    return err({
      kind: "invalid-utf8",
      reason: "gRPC-web trailer header block is not valid UTF-8",
      trailers: [],
      examined_bytes: 0,
    });
  }
  // The whole UTF-8 block has been examined even when field validation stops.
  const facts: TrailerFacts = { trailers: [], examined_bytes: bytes.length };
  for (const line of text.split("\r\n")) {
    if (line === "") continue;
    const colon = line.indexOf(":");
    // Unlike ordinary HTTP/1 headers, in-body gRPC-Web names must be lower-case.
    if (colon <= 0 || !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(line.slice(0, colon)))
      return err({
        ...facts,
        kind: "invalid-name",
        reason:
          "gRPC-web trailer header names must be lower-case HTTP field names",
      });
    const value = line.slice(colon + 1).replace(/^[ \t]+/, "");
    // RFC 9110 permits HTAB but excludes other C0 controls and DEL.
    if (/[\u0000-\u0008\u000a-\u001f\u007f]/u.test(value))
      return err({
        ...facts,
        kind: "invalid-value",
        reason:
          "gRPC-web trailer field value contains a forbidden control character",
      });
    budget.charge(512);
    facts.trailers.push({ name: line.slice(0, colon), value });
  }
  return ok(facts);
};
