import { MemberReadFailure } from "../artifacts/zipMemberView.js";
import { PdfDeadlineError, PdfEncryptedError, type PdfFile } from "./file.js";
import {
  asArray,
  asCount,
  asDict,
  asName,
  asStream,
  asString,
  END,
  isKeyword,
  isSpace,
  Lexer,
  PdfSyntaxError,
  type LexerLimits,
  type PdfDict,
  type PdfValue,
} from "./syntax.js";

/** A content stream is already bounded by the decoding budget, so its token count is not capped separately. */
const CONTENT_LIMITS: LexerLimits = {
  maxDepth: 64,
  maxNodes: Number.MAX_SAFE_INTEGER,
  maxStringBytes: 16 * 1024 ** 2,
};
const MAX_FORM_DEPTH = 4;
const SAVED_STATES = 256;

export const PAGE_KINDS = [
  "text",
  "text-and-images",
  "image-only",
  "image-with-hidden-text",
  "vector-only",
  "blank",
  "unreadable",
  "not-read",
] as const;
export type PageKind = (typeof PAGE_KINDS)[number];

export interface PageContent {
  readonly kind: PageKind;
  readonly content_streams: number;
  readonly text_operations: number;
  readonly hidden_text_operations: number;
  readonly images: number;
  readonly vector_operations: number;
  readonly note: string | null;
}

interface Tally {
  text: number;
  hidden: number;
  images: number;
  vector: number;
  unreadable: string | null;
}

const PAINT = new Set(["f", "F", "f*", "B", "B*", "b", "b*", "S", "s", "sh"]);

const hasText = (value: PdfValue | undefined): boolean => {
  const string = asString(value);
  if (string !== null) return string.bytes.length > 0;
  const array = asArray(value);
  return (
    array !== null &&
    array.items.some((item) => (asString(item)?.bytes.length ?? 0) > 0)
  );
};

/** Colour spaces an inline image can name, with their component counts. */
const COMPONENTS = new Map<string, number>([
  ["G", 1],
  ["DeviceGray", 1],
  ["CalGray", 1],
  ["RGB", 3],
  ["DeviceRGB", 3],
  ["CalRGB", 3],
  ["CMYK", 4],
  ["DeviceCMYK", 4],
  ["I", 1],
  ["Indexed", 1],
]);

const ABBREVIATED_KEYS = new Map<string, string>([
  ["W", "Width"],
  ["H", "Height"],
  ["BPC", "BitsPerComponent"],
  ["CS", "ColorSpace"],
  ["F", "Filter"],
  ["IM", "ImageMask"],
]);

/** Bytes that could start an operator stream: used to tell a real `EI` from one inside image data. */
const plausibleAfter = (bytes: Uint8Array, from: number): boolean => {
  for (let at = from; at < Math.min(bytes.length, from + 12); at += 1) {
    const code = bytes[at] as number;
    if (
      code !== 9 &&
      code !== 10 &&
      code !== 13 &&
      (code < 0x20 || code > 0x7e)
    )
      return false;
  }
  return true;
};

const eiAt = (bytes: Uint8Array, at: number): boolean =>
  bytes[at] === 0x45 &&
  bytes[at + 1] === 0x49 &&
  (at + 2 === bytes.length || isSpace(bytes[at + 2])) &&
  plausibleAfter(bytes, at + 2);

/**
 * Read an inline image after `BI` and return where the stream goes on. An
 * unfiltered image has a length its dictionary fixes, so that is used; a
 * filtered one ends at the first `EI` that follows white space or the filter's
 * own end marker (`>` or `~>`) and is followed by plausible operator text.
 */
const skipInlineImage = (lexer: Lexer, bytes: Uint8Array): void => {
  const entries = new Map<string, PdfValue>();
  for (;;) {
    const key = lexer.readValue();
    if (key === END || (isKeyword(key) && key.v === "ID")) break;
    const name = asName(key as PdfValue);
    if (name === null) continue;
    const value = lexer.readValue();
    if (value === END) break;
    if (isKeyword(value)) {
      if (value.v === "ID") break;
      continue;
    }
    entries.set(ABBREVIATED_KEYS.get(name) ?? name, value);
  }
  let start = lexer.pos;
  if (bytes[start] === 13 && bytes[start + 1] === 10) start += 2;
  else if (isSpace(bytes[start])) start += 1;
  if (!entries.has("Filter")) {
    const width = asCount(entries.get("Width"));
    const height = asCount(entries.get("Height"));
    const mask = entries.get("ImageMask") === true;
    const space = entries.get("ColorSpace");
    const spaceName = asName(space) ?? asName(asArray(space)?.items[0]);
    const components = mask ? 1 : COMPONENTS.get(spaceName ?? "");
    const bpc = mask ? 1 : (asCount(entries.get("BitsPerComponent")) ?? 8);
    if (width !== null && height !== null && components !== undefined) {
      const end = start + Math.ceil((width * components * bpc) / 8) * height;
      let at = end;
      while (at < bytes.length && isSpace(bytes[at])) at += 1;
      if (end <= bytes.length && eiAt(bytes, at)) {
        lexer.pos = at + 2;
        return;
      }
    }
  }
  for (let at = start; at + 2 <= bytes.length; at += 1) {
    const before = bytes[at - 1];
    if (
      eiAt(bytes, at) &&
      (at === start || isSpace(before) || before === 0x3e)
    ) {
      lexer.pos = at + 2;
      return;
    }
  }
  lexer.pos = bytes.length;
};

const scan = (
  file: PdfFile,
  bytes: Uint8Array,
  resources: PdfDict | null,
  tally: Tally,
  state: { depth: number; mode: number; visited: Set<string> },
): void => {
  const lexer = new Lexer(bytes, 0, bytes.length, CONTENT_LIMITS);
  const xobjects = asDict(file.resolve(resources?.map.get("XObject")));
  let last: PdfValue | undefined;
  let mode = state.mode;
  const saved: number[] = [];
  let steps = 0;
  for (;;) {
    steps += 1;
    if (steps % 256 === 0) file.tick();
    const token = lexer.readValue();
    if (token === END) return;
    if (!isKeyword(token)) {
      last = token;
      continue;
    }
    switch (token.v) {
      case "q":
        if (saved.length < SAVED_STATES) saved.push(mode);
        break;
      case "Q":
        mode = saved.pop() ?? mode;
        break;
      case "Tr":
        mode = typeof last === "number" ? last : mode;
        break;
      case "Tj":
      case "TJ":
      case "'":
      case '"':
        if (hasText(last)) {
          tally.text += 1;
          if (mode === 3 || mode === 7) tally.hidden += 1;
        }
        break;
      case "BI":
        skipInlineImage(lexer, bytes);
        tally.images += 1;
        break;
      case "Do":
        paintObject(file, asName(last), xobjects, resources, tally, {
          ...state,
          mode,
        });
        break;
      default:
        if (PAINT.has(token.v)) tally.vector += 1;
    }
    last = undefined;
  }
};

/** `Do`: an image counts, a form is scanned with the text state it was invoked under. */
const paintObject = (
  file: PdfFile,
  target: string | null,
  xobjects: PdfDict | null,
  resources: PdfDict | null,
  tally: Tally,
  state: { depth: number; mode: number; visited: Set<string> },
): void => {
  const object = target === null ? undefined : xobjects?.map.get(target);
  const stream = asStream(file.resolve(object));
  if (stream === null) return;
  const subtype = asName(file.resolve(stream.dict.map.get("Subtype")));
  if (subtype === "Image") {
    tally.images += 1;
    return;
  }
  if (subtype !== "Form") return;
  const key = `${String(stream.num)}:${String(state.mode)}`;
  if (state.visited.has(key)) return;
  if (state.depth >= MAX_FORM_DEPTH) {
    tally.unreadable = `A form XObject is nested more than ${String(MAX_FORM_DEPTH)} levels deep; its content is not scanned.`;
    return;
  }
  state.visited.add(key);
  const decoded = file.decoded(stream);
  if (decoded.state !== "complete" && decoded.state !== "truncated") {
    tally.unreadable = decoded.note ?? "A form XObject could not be decoded.";
    return;
  }
  if (decoded.note !== null) tally.unreadable = decoded.note;
  const own = asDict(file.resolve(stream.dict.map.get("Resources")));
  scan(file, decoded.bytes, own ?? resources, tally, {
    depth: state.depth + 1,
    mode: state.mode,
    visited: state.visited,
  });
};

const NOT_READ: PageContent = {
  kind: "not-read",
  content_streams: 0,
  text_operations: 0,
  hidden_text_operations: 0,
  images: 0,
  vector_operations: 0,
  note: "The document is encrypted; page content is not decoded.",
};

/** What one page draws: visible text, hidden text, images and vector paint, from its content streams. */
export const readPageContent = (
  file: PdfFile,
  page: PdfDict,
  resources: PdfDict | null,
): PageContent => {
  if (file.encrypted) return NOT_READ;
  const contents = file.resolve(page.map.get("Contents"));
  const list = asArray(contents)?.items.map((item) => file.resolve(item)) ?? [
    contents,
  ];
  const streams = list
    .map((item) => asStream(item))
    .filter((item) => item !== null);
  const tally: Tally = {
    text: 0,
    hidden: 0,
    images: 0,
    vector: 0,
    unreadable: null,
  };
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (const stream of streams) {
      const decoded = file.decoded(stream);
      if (decoded.state !== "complete" && decoded.state !== "truncated") {
        tally.unreadable =
          decoded.note ??
          `A content stream uses ${decoded.filters.join(", ")}, which is not decoded.`;
        continue;
      }
      if (decoded.note !== null) tally.unreadable = decoded.note;
      parts.push(decoded.bytes);
      size += decoded.bytes.length + 1;
    }
    const joined = new Uint8Array(size);
    let at = 0;
    for (const part of parts) {
      joined.set(part, at);
      at += part.length;
      joined[at] = 0x0a;
      at += 1;
    }
    scan(file, joined, resources, tally, {
      depth: 0,
      mode: 0,
      visited: new Set(),
    });
  } catch (cause) {
    if (
      cause instanceof PdfEncryptedError ||
      cause instanceof PdfDeadlineError ||
      cause instanceof MemberReadFailure ||
      file.signal?.aborted === true
    )
      throw cause;
    tally.unreadable =
      cause instanceof PdfSyntaxError
        ? cause.message
        : `The content could not be scanned (${cause instanceof Error ? cause.message : String(cause)}).`;
  }
  const visible = tally.text - tally.hidden;
  const kind: PageKind =
    tally.unreadable !== null && tally.text + tally.images + tally.vector === 0
      ? "unreadable"
      : tally.images > 0 && visible === 0
        ? tally.hidden > 0
          ? "image-with-hidden-text"
          : "image-only"
        : visible > 0
          ? tally.images > 0
            ? "text-and-images"
            : "text"
          : tally.vector > 0
            ? "vector-only"
            : "blank";
  return {
    kind,
    content_streams: streams.length,
    text_operations: tally.text,
    hidden_text_operations: tally.hidden,
    images: tally.images,
    vector_operations: tally.vector,
    note: tally.unreadable,
  };
};
