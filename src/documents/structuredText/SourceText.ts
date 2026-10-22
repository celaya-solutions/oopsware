import {
  MAX_LISTED_UNDECODABLE,
  type DocumentEncoding,
  type SourceLocation,
  type TextEncoding,
} from "../../domain/document/structuredText.js";

/** One undecodable byte run, replaced by a single U+FFFD in the decoded text. */
interface Undecodable {
  readonly offset: number;
  readonly bytes: number;
}

const CHECKPOINT = 64;

const BOMS: readonly (readonly [TextEncoding, readonly number[]])[] = [
  ["utf-8", [0xef, 0xbb, 0xbf]],
  ["utf-16le", [0xff, 0xfe]],
  ["utf-16be", [0xfe, 0xff]],
];

/** The byte-order mark at the start of `bytes`, if any. */
export const byteOrderMark = (
  bytes: Uint8Array,
): { readonly encoding: TextEncoding; readonly bytes: number } | null => {
  for (const [encoding, mark] of BOMS)
    if (mark.every((value, index) => bytes[index] === value))
      return { encoding, bytes: mark.length };
  return null;
};

/** Encoding label from an ASCII-compatible XML declaration, verbatim. */
export const xmlDeclaredEncoding = (bytes: Uint8Array): string | null => {
  const head = Buffer.from(bytes.subarray(0, 256)).toString("latin1");
  const declaration =
    /^<\?xml\s[^>]*?\bencoding\s*=\s*["']([A-Za-z0-9._-]+)["']/u.exec(head);
  return declaration?.[1] ?? null;
};

/** Encodings the reader decodes from an XML declaration label. */
export const encodingForXmlLabel = (label: string): TextEncoding | null => {
  const lower = label.toLowerCase();
  if (lower === "utf-8" || lower === "utf8" || lower === "us-ascii")
    return "utf-8";
  if (
    [
      "windows-1252",
      "cp1252",
      "iso-8859-1",
      "iso8859-1",
      "latin1",
      "l1",
    ].includes(lower)
  )
    return "windows-1252";
  return null;
};

/**
 * Locate invalid UTF-8 the way the WHATWG decoder does: each maximal invalid
 * subpart becomes one replacement character.
 */
const utf8Errors = (bytes: Uint8Array, start: number): Undecodable[] => {
  const errors: Undecodable[] = [];
  let index = start;
  while (index < bytes.length) {
    const lead = bytes[index] ?? 0;
    if (lead < 0x80) {
      index += 1;
      continue;
    }
    let needed = 0;
    let lower = 0x80;
    let upper = 0xbf;
    if (lead >= 0xc2 && lead <= 0xdf) needed = 1;
    else if (lead >= 0xe0 && lead <= 0xef) {
      needed = 2;
      if (lead === 0xe0) lower = 0xa0;
      if (lead === 0xed) upper = 0x9f;
    } else if (lead >= 0xf0 && lead <= 0xf4) {
      needed = 3;
      if (lead === 0xf0) lower = 0x90;
      if (lead === 0xf4) upper = 0x8f;
    } else {
      errors.push({ offset: index, bytes: 1 });
      index += 1;
      continue;
    }
    let seen = 0;
    let cursor = index + 1;
    while (seen < needed) {
      const next = bytes[cursor];
      if (next === undefined || next < lower || next > upper) break;
      lower = 0x80;
      upper = 0xbf;
      seen += 1;
      cursor += 1;
    }
    if (seen < needed) errors.push({ offset: index, bytes: cursor - index });
    index = cursor;
  }
  return errors;
};

/** UTF-16 unpaired surrogates and an odd trailing byte, as byte runs. */
const utf16Errors = (
  bytes: Uint8Array,
  start: number,
  littleEndian: boolean,
): Undecodable[] => {
  const errors: Undecodable[] = [];
  const unit = (at: number) =>
    littleEndian
      ? (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8)
      : ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
  let index = start;
  while (index + 1 < bytes.length) {
    const value = unit(index);
    if (value >= 0xd800 && value <= 0xdbff) {
      const next = index + 3 < bytes.length ? unit(index + 2) : -1;
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 4;
        continue;
      }
      errors.push({ offset: index, bytes: 2 });
    } else if (value >= 0xdc00 && value <= 0xdfff)
      errors.push({ offset: index, bytes: 2 });
    index += 2;
  }
  if (index < bytes.length) errors.push({ offset: index, bytes: 1 });
  return errors;
};

const decoderLabel = (encoding: TextEncoding) =>
  encoding === "utf-8" ? "utf-8" : encoding;

/**
 * Decoded document text with exact mapping from text positions back to the
 * original bytes, so every reported location names real byte offsets.
 */
export class SourceText {
  readonly lineStarts: number[];
  readonly newlines = { lf: 0, crlf: 0, cr: 0 };
  readonly #replacements: ReadonlyMap<number, number>;
  readonly #checkpoints: number[] = [];

  private constructor(
    readonly text: string,
    readonly encoding: TextEncoding,
    readonly bomBytes: number,
    readonly undecodable: readonly Undecodable[],
    replacements: ReadonlyMap<number, number>,
  ) {
    this.#replacements = replacements;
    this.lineStarts = [0];
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (code === 0x0a) {
        this.newlines.lf += 1;
        this.lineStarts.push(index + 1);
      } else if (code === 0x0d) {
        if (text.charCodeAt(index + 1) === 0x0a) {
          this.newlines.crlf += 1;
          index += 1;
        } else this.newlines.cr += 1;
        this.lineStarts.push(index + 1);
      }
    }
    if (encoding === "utf-8") {
      let bytes = bomBytes;
      for (let index = 0; index < text.length; index += 1) {
        if (index % CHECKPOINT === 0) this.#checkpoints.push(bytes);
        bytes += this.#utf8Width(index);
      }
    }
  }

  /** Decode bytes with an explicit encoding, recording every undecodable run. */
  static decode(
    bytes: Uint8Array,
    encoding: TextEncoding,
    bomBytes: number,
  ): SourceText {
    const body = bytes.subarray(bomBytes);
    const decoder = new TextDecoder(decoderLabel(encoding), {
      ignoreBOM: true,
    });
    if (encoding === "windows-1252")
      return new SourceText(
        decoder.decode(body),
        encoding,
        bomBytes,
        [],
        new Map(),
      );
    if (encoding === "utf-16le" || encoding === "utf-16be") {
      // One code unit per two bytes; replacement keeps that ratio, so offsets stay linear.
      return new SourceText(
        decoder.decode(body),
        encoding,
        bomBytes,
        utf16Errors(bytes, bomBytes, encoding === "utf-16le"),
        new Map(),
      );
    }
    const errors = utf8Errors(bytes, bomBytes);
    if (errors.length === 0)
      return new SourceText(
        decoder.decode(body),
        encoding,
        bomBytes,
        [],
        new Map(),
      );
    const parts: string[] = [];
    const replacements = new Map<number, number>();
    let length = 0;
    let cursor = bomBytes;
    for (const error of errors) {
      const valid = decoder.decode(bytes.subarray(cursor, error.offset));
      parts.push(valid, "�");
      length += valid.length;
      replacements.set(length, error.bytes);
      length += 1;
      cursor = error.offset + error.bytes;
    }
    parts.push(decoder.decode(bytes.subarray(cursor)));
    return new SourceText(
      parts.join(""),
      encoding,
      bomBytes,
      errors,
      replacements,
    );
  }

  #utf8Width(index: number): number {
    const replaced = this.#replacements.get(index);
    if (replaced !== undefined) return replaced;
    const code = this.text.charCodeAt(index);
    if (code < 0x80) return 1;
    if (code < 0x800) return 2;
    if (code >= 0xd800 && code <= 0xdbff) return 4;
    if (code >= 0xdc00 && code <= 0xdfff) {
      const previous = this.text.charCodeAt(index - 1);
      return previous >= 0xd800 && previous <= 0xdbff ? 0 : 3;
    }
    return 3;
  }

  /** Byte offset in the original file of a decoded text position. */
  byteOffset(index: number): number {
    const position = Math.max(0, Math.min(index, this.text.length));
    switch (this.encoding) {
      case "windows-1252":
        return this.bomBytes + position;
      case "utf-16le":
      case "utf-16be":
        return this.bomBytes + position * 2;
      case "utf-8": {
        const block = Math.floor(position / CHECKPOINT);
        let bytes = this.#checkpoints[block] ?? this.bomBytes;
        for (let at = block * CHECKPOINT; at < position; at += 1)
          bytes += this.#utf8Width(at);
        return bytes;
      }
    }
  }

  /** 0-based line index containing a text position. */
  lineIndex(index: number): number {
    let low = 0;
    let high = this.lineStarts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if ((this.lineStarts[middle] ?? 0) <= index) low = middle;
      else high = middle - 1;
    }
    return low;
  }

  /** Line, column and original byte offset of a decoded text position. */
  locate(index: number): SourceLocation {
    const line = this.lineIndex(index);
    return {
      line: line + 1,
      column: index - (this.lineStarts[line] ?? 0) + 1,
      offset: this.byteOffset(index),
    };
  }

  /** Text position of a 1-based line and column, clamped to the text. */
  indexOf(line: number, column: number): number {
    const start =
      this.lineStarts[
        Math.max(0, Math.min(line - 1, this.lineStarts.length - 1))
      ] ?? 0;
    return Math.min(this.text.length, start + Math.max(0, column - 1));
  }

  /** Decoding facts for reports. */
  describe(
    basis: DocumentEncoding["basis"],
    declared: string | null,
  ): DocumentEncoding {
    let nul = 0;
    for (let index = 0; index < this.text.length; index += 1)
      if (this.text.charCodeAt(index) === 0) nul += 1;
    const last = this.text.charCodeAt(this.text.length - 1);
    const finalNewline = last === 0x0a || last === 0x0d;
    return {
      name: this.encoding,
      basis,
      declared,
      bom_bytes: this.bomBytes,
      undecodable: this.undecodable
        .slice(0, MAX_LISTED_UNDECODABLE)
        .map(({ offset, bytes }) => ({ offset, bytes })),
      undecodable_count: this.undecodable.length,
      nul_characters: nul,
      newlines: { ...this.newlines },
      lines:
        this.text.length === 0
          ? 0
          : this.lineStarts.length - (finalNewline ? 1 : 0),
      final_newline: finalNewline,
    };
  }
}
