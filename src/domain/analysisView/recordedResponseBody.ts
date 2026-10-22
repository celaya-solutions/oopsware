import { z } from "zod";
import type { WebNetworkCaptureRecord } from "../webNetworkCapture.js";

/** One record's retained response text, as replay and state extraction both read it. */
export interface RecordedResponseBody {
  /** Producer-decoded response text, or null when the record retained none. */
  readonly bodyText: string | null;
  /** Set when the retained bytes are not UTF-8, so `bodyText` holds their base64 rather than a lossy decoding. */
  readonly bodyEncoding?: "base64";
  /** Set when only a prefix of a large base64 body was decoded. */
  readonly bodyCut?: true;
}

const contentTextSchema = z.object({
  response: z.object({
    content: z.object({
      text: z.unknown().optional(),
      encoding: z.unknown().optional(),
    }),
  }),
});

/** Strict, and keeping a leading byte-order mark, so callers see the recorded text unchanged. */
const strictUtf8 = (): TextDecoder =>
  new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Base64 characters that decode to just over `limitBytes`, so a cut prefix still fills it. */
export const base64PrefixChars = (limitBytes: number): number =>
  Math.ceil((limitBytes + 4) / 3) * 4;

/** The retained response text of one record, decoding HAR base64 content when the decoder kept it as valid UTF-8; base64 beyond `limitBytes` is decoded only that far. */
export const readRecordedResponseBody = (
  record: WebNetworkCaptureRecord,
  limitBytes: number,
): RecordedResponseBody => {
  const content = contentTextSchema.safeParse(record.reported);
  if (!content.success) return { bodyText: null };
  const { text, encoding } = content.data.response.content;
  if (typeof text !== "string") return { bodyText: null };
  if (encoding !== "base64") return { bodyText: text };
  const binary = record.binary_fields.find(
    (field) =>
      field.pointer === "/response/content/text" && field.state === "retained",
  );
  if (binary === undefined || binary.content_base64 === null)
    return { bodyText: null };
  const prefixChars = base64PrefixChars(limitBytes);
  const cut = binary.content_base64.length > prefixChars;
  const encoded = cut
    ? binary.content_base64.slice(0, prefixChars)
    : binary.content_base64;
  const flags = cut ? { bodyCut: true as const } : {};
  try {
    // A cut prefix may end inside a character; streaming leaves that tail undecoded.
    const text = strictUtf8().decode(Buffer.from(encoded, "base64"), {
      stream: cut,
    });
    return { bodyText: text, ...flags };
  } catch {
    // Binary or non-UTF-8 bytes: keep them exactly, as base64, instead of inventing replacement characters.
    return { bodyText: encoded, bodyEncoding: "base64", ...flags };
  }
};
