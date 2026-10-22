import { createHash } from "node:crypto";

import { MemberReadFailure } from "../artifacts/zipMemberView.js";
import type {
  PdfDocumentFacts,
  PdfEncryption,
  PdfMetadata,
  PdfObjectRow,
  PdfPageRow,
} from "../domain/pdfDocument/pdfDocument.js";
import { readPageContent, type PageContent } from "./content.js";
import type { PdfFile } from "./file.js";
import {
  asArray,
  asCount,
  asDict,
  asInt,
  asName,
  asNumber,
  asRef,
  asStream,
  asString,
  readIndirectObject,
  PdfSyntaxError,
  type PdfDict,
  type PdfRef,
  type PdfValue,
} from "./syntax.js";
import { clip, printable, textString } from "./text.js";

const MAX_PAGES = 200_000;
/** Page tree nodes visited or queued; a shared Kids array cannot multiply past it. */
export const MAX_TREE_NODES = 400_000;
export const MAX_ANNOTATIONS_PER_PAGE = 10_000;
const MAX_LINKS_PER_PAGE = 20;
const MAX_INFO_KEYS = 200;
const MAX_INFO_CHARS = 4_096;
const MAX_KEY_CHARS = 256;
const MAX_NAME_CHARS = 128;
export const MAX_TEXT_CHARS = 2_048;
const MAX_ID_BYTES = 64;
export const CONTENT_SAMPLE_PAGES = 25;

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const sha = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
export const label = (ref: PdfRef | null): string | null =>
  ref === null ? null : `${String(ref.num)} ${String(ref.gen)}`;

export interface PageEntry {
  readonly index: number;
  readonly ref: PdfRef | null;
  readonly dict: PdfDict;
  readonly mediaBox: PdfValue;
  readonly cropBox: PdfValue;
  readonly rotate: PdfValue;
  readonly resources: PdfDict | null;
}

export interface PageTree {
  readonly entries: PageEntry[];
  readonly declared: number | null;
  readonly truncated: boolean;
  /** A node was reached twice (or a Count lies): Poppler follows the declared tree, this reader the distinct pages. */
  readonly irregular: boolean;
}

type Box = [number, number, number, number];

/** A rectangle from any two opposite corners, as lower-left then upper-right; null when it is not four finite numbers. */
const normalizeBox = (numbers: (number | null)[]): Box | null => {
  if (numbers.length < 4 || numbers.slice(0, 4).some((item) => item === null))
    return null;
  const [a, b, c, d] = numbers as [number, number, number, number];
  return [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
};

export class PdfStructure {
  #flat: PageTree | undefined;
  /** A decoding budget failure was hit while reading content; the report names it. */
  budgetHit = false;

  constructor(readonly file: PdfFile) {}

  /** Text of a PDF string cut to `limit`, or null when the document is encrypted (the bytes are ciphertext). */
  text(value: PdfValue | undefined, limit = MAX_TEXT_CHARS): string | null {
    const string = asString(this.file.resolve(value));
    if (string === null || this.file.encrypted) return null;
    return clip(printable(textString(string)), limit).text;
  }

  catalog(): PdfDict | null {
    return asDict(this.file.resolve(this.file.trailer?.map.get("Root")));
  }

  dict(value: PdfValue | undefined): PdfDict | null {
    return asDict(this.file.resolve(value));
  }

  // ---- pages -------------------------------------------------------------

  pages(): PageTree {
    if (this.#flat !== undefined) return this.#flat;
    const file = this.file;
    const entries: PageEntry[] = [];
    const catalog = this.catalog();
    const root = this.dict(catalog?.map.get("Pages"));
    let declared: number | null = null;
    let truncated = false;
    let irregular = false;
    if (root === null)
      file.problem(
        catalog === null
          ? "The document has no readable catalog, so there is no page tree."
          : "The document catalog has no readable Pages tree.",
      );
    else {
      declared = asCount(file.resolve(root.map.get("Count")));
      const seen = new Set<number>();
      interface Frame {
        node: PdfDict;
        ref: PdfRef | null;
        media: PdfValue;
        crop: PdfValue;
        rotate: PdfValue;
        resources: PdfValue;
      }
      const stack: Frame[] = [
        {
          node: root,
          ref: asRef(catalog?.map.get("Pages")),
          media: null,
          crop: null,
          rotate: null,
          resources: null,
        },
      ];
      let nodes = 1;
      while (stack.length > 0 && !truncated) {
        file.tick();
        const frame = stack.pop() as Frame;
        if (frame.ref !== null) {
          if (seen.has(frame.ref.num)) {
            irregular = true;
            file.problem(
              "The page tree visits the same node twice; the repeat is skipped.",
            );
            continue;
          }
          seen.add(frame.ref.num);
        }
        const map = frame.node.map;
        const media = map.get("MediaBox") ?? frame.media;
        const crop = map.get("CropBox") ?? frame.crop;
        const rotate = map.get("Rotate") ?? frame.rotate;
        const resources = map.get("Resources") ?? frame.resources;
        const kids = asArray(file.resolve(map.get("Kids")));
        const type = asName(file.resolve(map.get("Type")));
        if (kids !== null && type !== "Page") {
          for (let at = kids.items.length - 1; at >= 0; at -= 1) {
            const item = kids.items[at] as PdfValue;
            const child = asDict(file.resolve(item));
            if (child === null) {
              file.problem("A page tree entry is not a dictionary.");
              continue;
            }
            // Counting what is queued, not only what is visited, keeps shared Kids arrays from multiplying.
            nodes += 1;
            if (nodes > MAX_TREE_NODES) {
              truncated = true;
              break;
            }
            stack.push({
              node: child,
              ref: asRef(item),
              media,
              crop,
              rotate,
              resources,
            });
          }
        } else if (entries.length >= MAX_PAGES) truncated = true;
        else
          entries.push({
            index: entries.length,
            ref: frame.ref,
            dict: frame.node,
            mediaBox: media,
            cropBox: crop,
            rotate,
            resources: asDict(file.resolve(resources)),
          });
      }
      if (truncated)
        file.problem(
          `The page tree has more than ${String(MAX_PAGES)} pages or ${String(MAX_TREE_NODES)} nodes; the rest are not read.`,
        );
      else if (declared !== null && declared !== entries.length) {
        irregular = true;
        file.problem(
          `The page tree declares ${String(declared)} pages but holds ${String(entries.length)}.`,
        );
      }
    }
    this.#flat = { entries, declared, truncated, irregular };
    return this.#flat;
  }

  // ---- document facts ----------------------------------------------------

  encryption(): PdfEncryption | null {
    const raw = this.file.trailer?.map.get("Encrypt");
    if (raw === undefined) return null;
    const dict = this.dict(raw);
    if (dict === null)
      return {
        handler: null,
        sub_filter: null,
        version: null,
        revision: null,
        key_bits: null,
        method: null,
        public_key: false,
        encrypt_metadata: null,
        permissions: null,
        note: "The trailer names an Encrypt entry that is not a readable dictionary. The document is treated as encrypted; no password is tried and nothing is decrypted.",
      };
    const number = (key: string): number | null =>
      asInt(this.file.resolve(dict.map.get(key)));
    const nameOf = (key: string): string | null => {
      const name = asName(this.file.resolve(dict.map.get(key)));
      return name === null ? null : clip(name, MAX_NAME_CHARS).text;
    };
    const version = number("V");
    const revision = number("R");
    const handler = nameOf("Filter");
    const subFilter = nameOf("SubFilter");
    const publicKey =
      handler === "Adobe.PubSec" ||
      (subFilter?.startsWith("adbe.pkcs7") ?? false);
    const filters = this.dict(dict.map.get("CF"));
    // ISO 32000-1 table 20: an absent StmF is the identity filter.
    const stdName = nameOf("StmF") ?? "Identity";
    const std = this.dict(filters?.map.get(stdName));
    const cfm =
      std === null ? null : asName(this.file.resolve(std.map.get("CFM")));
    let method: PdfEncryption["method"];
    let bits: number | null = number("Length");
    if (version === null) method = null;
    else if (version < 4) method = "rc4";
    else if (cfm === "V2") method = "rc4";
    else if (cfm === "AESV2") {
      method = "aes-128";
      bits = 128;
    } else if (cfm === "AESV3") {
      method = "aes-256";
      bits = 256;
    } else if (cfm === "None" || stdName === "Identity") method = "identity";
    else method = "unknown";
    if (version === 1) bits = 40;
    else if (version === 5) bits = 256;
    else if (version !== null && version < 4 && bits === null) bits = 40;
    const stored = asNumber(this.file.resolve(dict.map.get("P")));
    const flags = stored === null ? null : stored | 0;
    const bit = (n: number): boolean | null =>
      flags === null ? null : ((flags >> (n - 1)) & 1) === 1;
    const metadata = this.file.resolve(dict.map.get("EncryptMetadata"));
    return {
      handler,
      sub_filter: subFilter,
      version,
      revision,
      key_bits: bits,
      method,
      public_key: publicKey,
      encrypt_metadata:
        typeof metadata === "boolean"
          ? metadata
          : revision !== null && revision >= 4
            ? true
            : null,
      permissions: {
        raw: flags,
        print: bit(3),
        print_high_quality: bit(12),
        modify: bit(4),
        copy: bit(5),
        annotate: bit(6),
        fill_forms: bit(9),
        accessibility_extract: bit(10),
        assemble: bit(11),
      },
      note: "Strings and streams are enciphered. No password is tried and nothing is decrypted, so metadata, text and attachments are not read. The permissions are what the file declares; a viewer enforces them, the data does not.",
    };
  }

  /** The first object after the header, when it is a linearization dictionary. */
  linearized(): boolean {
    const bytes = this.file.bytes;
    const start = Math.max(0, this.file.headerOffset);
    const window = Buffer.from(
      bytes.buffer,
      bytes.byteOffset,
      Math.min(bytes.length, start + 2048),
    ).subarray(start);
    const at = window.indexOf("obj");
    if (at < 0) return false;
    let from = start + at;
    while (
      from > start &&
      /[\d\s]/u.test(String.fromCharCode(bytes[from - 1] as number))
    )
      from -= 1;
    try {
      const parsed = readIndirectObject(bytes, from);
      return (
        parsed !== null && asDict(parsed.value)?.map.has("Linearized") === true
      );
    } catch (cause) {
      // A first object this reader cannot parse is not a linearization dictionary.
      if (cause instanceof PdfSyntaxError) return false;
      throw cause;
    }
  }

  eof(): { markers: number; trailing: number } {
    const bytes = this.file.bytes;
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let markers = 0;
    let last = -1;
    for (let from = 0; ;) {
      const at = buf.indexOf("%%EOF", from);
      if (at < 0) break;
      markers += 1;
      last = at;
      from = at + 5;
    }
    if (last < 0) return { markers, trailing: 0 };
    const blank = (at: number): boolean =>
      [0, 9, 10, 12, 13, 32].includes(bytes[at] as number);
    let start = last + 5;
    while (start < bytes.length && blank(start)) start += 1;
    let end = bytes.length;
    while (end > start && blank(end - 1)) end -= 1;
    return { markers, trailing: end - start };
  }

  facts(decodedBytes: number): PdfDocumentFacts {
    const file = this.file;
    const catalog = this.catalog();
    const pages = file.encrypted && catalog === null ? null : this.pages();
    const eof = this.eof();
    const ids =
      asArray(file.resolve(file.trailer?.map.get("ID")))
        ?.items.map((item) => asString(file.resolve(item)))
        .filter((item) => item !== null)
        .slice(0, 2)
        .map((item) => hex(item.bytes.subarray(0, MAX_ID_BYTES))) ?? [];
    const markInfo = this.dict(catalog?.map.get("MarkInfo"));
    const marked = file.resolve(markInfo?.map.get("Marked"));
    const ocg = asArray(
      file.resolve(
        this.dict(catalog?.map.get("OCProperties"))?.map.get("OCGs"),
      ),
    );
    const catalogVersion = asName(file.resolve(catalog?.map.get("Version")));
    const pageName = (key: string): string | null => {
      const name = asName(file.resolve(catalog?.map.get(key)));
      return name === null ? null : clip(name, MAX_NAME_CHARS).text;
    };
    return {
      header_version: file.version,
      header_offset: file.headerOffset >= 0 ? file.headerOffset : null,
      catalog_version:
        catalogVersion === null
          ? null
          : clip(catalogVersion, MAX_NAME_CHARS).text,
      linearized: this.linearized(),
      xref: {
        state: file.state,
        sections: file.sections,
        entries: file.xref.size,
        startxref_markers: file.startxrefs,
      },
      eof_markers: eof.markers,
      trailing_bytes: eof.trailing,
      ids,
      encryption: this.encryption(),
      page_count:
        pages === null || catalog === null ? null : pages.entries.length,
      declared_page_count: pages?.declared ?? null,
      tagged:
        catalog === null
          ? null
          : typeof marked === "boolean"
            ? marked
            : this.dict(catalog.map.get("StructTreeRoot")) !== null,
      language: this.text(catalog?.map.get("Lang"), MAX_NAME_CHARS),
      page_layout: pageName("PageLayout"),
      page_mode: pageName("PageMode"),
      outlines:
        catalog === null
          ? null
          : this.dict(catalog.map.get("Outlines")) !== null,
      optional_content_groups: ocg?.items.length ?? null,
      portfolio:
        catalog === null
          ? null
          : this.dict(catalog.map.get("Collection")) !== null,
      form: null,
      decoded_bytes: decodedBytes,
      problems: [
        ...file.problems,
        ...(file.problemsDropped > 0
          ? [`${String(file.problemsDropped)} more problems were not listed.`]
          : []),
        ...(file.xrefTruncated
          ? [
              "The cross-reference data has more entries than this reader keeps; the rest are not read.",
            ]
          : []),
      ],
    };
  }

  // ---- metadata ----------------------------------------------------------

  metadata(): PdfMetadata | null {
    if (this.file.encrypted) return null;
    const info: { key: string; value: string }[] = [];
    let total = 0;
    const dict = this.dict(this.file.trailer?.map.get("Info"));
    if (dict !== null)
      for (const [key, raw] of dict.map) {
        this.file.tick();
        const value = this.file.resolve(raw);
        const string = asString(value);
        const text =
          string !== null
            ? printable(textString(string))
            : asName(value) !== null
              ? `/${asName(value) as string}`
              : typeof value === "number" || typeof value === "boolean"
                ? String(value)
                : null;
        if (text === null) continue;
        total += 1;
        if (info.length < MAX_INFO_KEYS)
          info.push({
            key: clip(key, MAX_KEY_CHARS).text,
            value: clip(text, MAX_INFO_CHARS).text,
          });
      }
    const stream = asStream(
      this.file.resolve(this.catalog()?.map.get("Metadata")),
    );
    let xmp: PdfMetadata["xmp"] = null;
    if (stream !== null) {
      try {
        const decoded = this.file.decoded(stream);
        xmp = {
          bytes: decoded.bytes.length,
          sha256: decoded.state === "complete" ? sha(decoded.bytes) : null,
        };
      } catch (cause) {
        if (cause instanceof MemberReadFailure) {
          this.budgetHit = true;
          xmp = { bytes: 0, sha256: null };
        } else throw cause;
      }
    }
    return { info, info_total: total, xmp };
  }

  // ---- pages view --------------------------------------------------------

  pageRow(entry: PageEntry, classify: boolean): PdfPageRow {
    const file = this.file;
    const box = (value: PdfValue): Box | null => {
      const array = asArray(file.resolve(value));
      return array === null
        ? null
        : normalizeBox(
            array.items.slice(0, 4).map((item) => asNumber(file.resolve(item))),
          );
    };
    const rotate = asInt(file.resolve(entry.rotate)) ?? 0;
    const subtypes = new Map<string, number>();
    const links: string[] = [];
    const annots = asArray(file.resolve(entry.dict.map.get("Annots")));
    const total = annots?.items.length ?? 0;
    if (annots !== null && !file.encrypted)
      for (const item of annots.items.slice(0, MAX_ANNOTATIONS_PER_PAGE)) {
        file.tick();
        const annot = this.dict(item);
        if (annot === null) continue;
        const subtype = clip(
          asName(file.resolve(annot.map.get("Subtype"))) ?? "unknown",
          MAX_NAME_CHARS,
        ).text;
        subtypes.set(subtype, (subtypes.get(subtype) ?? 0) + 1);
        if (subtype === "Link" && links.length < MAX_LINKS_PER_PAGE) {
          const uri = this.text(this.dict(annot.map.get("A"))?.map.get("URI"));
          if (uri !== null) links.push(uri);
        }
      }
    const fonts = this.dict(entry.resources?.map.get("Font"));
    const unit = asNumber(file.resolve(entry.dict.map.get("UserUnit")));
    let content: PageContent | null = null;
    const notes: string[] = [];
    if (classify) {
      try {
        content = readPageContent(file, entry.dict, entry.resources);
      } catch (cause) {
        if (cause instanceof MemberReadFailure) {
          this.budgetHit = true;
          notes.push(cause.message);
        } else throw cause;
      }
    }
    if (content?.note != null) notes.push(content.note);
    if (total > MAX_ANNOTATIONS_PER_PAGE)
      notes.push(
        `Only the first ${String(MAX_ANNOTATIONS_PER_PAGE)} of ${String(total)} annotations were classified.`,
      );
    return {
      index: entry.index,
      object: label(entry.ref),
      media_box: box(entry.mediaBox),
      crop_box: box(entry.cropBox),
      rotate: ((rotate % 360) + 360) % 360,
      user_unit: unit !== null && unit > 0 ? unit : 1,
      kind: content?.kind ?? "not-read",
      content_streams: content?.content_streams ?? 0,
      text_operations: content?.text_operations ?? 0,
      hidden_text_operations: content?.hidden_text_operations ?? 0,
      images: content?.images ?? 0,
      vector_operations: content?.vector_operations ?? 0,
      fonts: fonts?.map.size ?? 0,
      annotations: {
        total,
        subtypes: [...subtypes].map(([subtype, count]) => ({ subtype, count })),
      },
      links,
      note: notes.length === 0 ? null : notes.join(" "),
    };
  }

  // ---- objects view ------------------------------------------------------

  objectRow(num: number): PdfObjectRow {
    const file = this.file;
    const entry = file.xref.get(num);
    const location =
      entry?.kind === "offset"
        ? `offset ${String(entry.offset)}`
        : entry?.kind === "compressed"
          ? `object stream ${String(entry.stream)}, index ${String(entry.index)}`
          : "free";
    const generation = entry?.kind === "offset" ? entry.gen : 0;
    const base = {
      number: num,
      generation,
      location,
      type: null,
      subtype: null,
      filters: [] as string[],
      stream_bytes: null,
    } as const;
    const value = file.object(num);
    if (value === undefined) return { ...base, kind: "unreadable" };
    const stream = asStream(value);
    const dict = asDict(value);
    if (dict !== null) {
      const name = (key: string): string | null => {
        const found = asName(file.resolve(dict.map.get(key)));
        return found === null ? null : clip(found, MAX_NAME_CHARS).text;
      };
      const type = name("Type");
      const subtype = name("Subtype") ?? name("S");
      if (stream === null)
        return { ...base, kind: "dictionary", type, subtype };
      return {
        ...base,
        kind: "stream",
        type,
        subtype,
        filters: file
          .filters(stream)
          .names.map((filter) => clip(filter, MAX_NAME_CHARS).text),
        stream_bytes: asCount(file.resolve(dict.map.get("Length"))),
      };
    }
    const kind =
      asArray(value) !== null
        ? "array"
        : asString(value) !== null
          ? "string"
          : asName(value) !== null
            ? "name"
            : typeof value === "number"
              ? "number"
              : typeof value === "boolean"
                ? "boolean"
                : asRef(value) !== null
                  ? "reference"
                  : "null";
    return { ...base, kind };
  }
}
