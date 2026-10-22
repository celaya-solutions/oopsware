import { decodeModifiedUtf8 } from "../../jvm/classfile/ClassReader.js";
import {
  AndroidXmlFormatError,
  MAX_XML_DEPTH,
  MAX_XML_NODES,
  resValue,
  type AndroidXmlAttribute,
  type AndroidXmlDocument,
  type AndroidXmlNode,
  type AndroidXmlProblem,
} from "./androidXml.js";

/**
 * Compiled binary XML (ResXMLTree) and the ResChunk / ResStringPool
 * primitives it shares with resources.arsc, per libandroidfw's
 * ResourceTypes.h. Every length is checked against its parent chunk before
 * anything is read or allocated.
 */

/** Chunk types this family reads (ResourceTypes.h). */
export const CHUNK = {
  stringPool: 0x0001,
  table: 0x0002,
  xml: 0x0003,
  xmlStartNamespace: 0x0100,
  xmlEndNamespace: 0x0101,
  xmlStartElement: 0x0102,
  xmlEndElement: 0x0103,
  xmlCdata: 0x0104,
  xmlResourceMap: 0x0180,
  tablePackage: 0x0200,
  tableType: 0x0201,
  tableTypeSpec: 0x0202,
  tableLibrary: 0x0203,
  tableOverlayable: 0x0204,
  tableOverlayablePolicy: 0x0205,
  tableStagedAlias: 0x0206,
} as const;

/** ResStringPool_ref's "no string". */
export const NO_INDEX = 0xffff_ffff;

export const u16 = (bytes: Uint8Array, at: number): number =>
  (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);

export const u32 = (bytes: Uint8Array, at: number): number =>
  ((bytes[at] ?? 0) |
    ((bytes[at + 1] ?? 0) << 8) |
    ((bytes[at + 2] ?? 0) << 16) |
    ((bytes[at + 3] ?? 0) << 24)) >>>
  0;

/** A validated ResChunk_header: `offset + size` lies within its parent. */
export interface ResChunk {
  readonly offset: number;
  readonly type: number;
  readonly headerSize: number;
  readonly size: number;
}

const typeHex = (type: number): string =>
  `0x${type.toString(16).padStart(4, "0")}`;

/** The chunk at `offset`, or a problem when its header does not fit inside `end`. */
export const readChunk = (
  bytes: Uint8Array,
  offset: number,
  end: number,
): ResChunk | AndroidXmlProblem => {
  if (end - offset < 8)
    return {
      offset,
      message: `Chunk header needs 8 bytes but only ${String(end - offset)} remain.`,
    };
  const type = u16(bytes, offset);
  const headerSize = u16(bytes, offset + 2);
  const size = u32(bytes, offset + 4);
  if (headerSize < 8 || headerSize > size)
    return {
      offset,
      message: `Chunk ${typeHex(type)} has header size ${String(headerSize)} for chunk size ${String(size)}.`,
    };
  if (size > end - offset)
    return {
      offset,
      message: `Chunk ${typeHex(type)} declares ${String(size)} bytes but its parent leaves ${String(end - offset)}.`,
    };
  return { offset, type, headerSize, size };
};

/** One style span of a pool string (ResStringPool_span). */
export interface StringSpan {
  readonly tag: string;
  readonly first: number;
  readonly last: number;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });
const lossyUtf8 = new TextDecoder("utf-8");

const utf16 = (bytes: Uint8Array, at: number, units: number): string => {
  const parts: string[] = [];
  for (let start = 0; start < units; start += 4096) {
    const codes: number[] = [];
    for (let index = start; index < Math.min(units, start + 4096); index += 1)
      codes.push(u16(bytes, at + index * 2));
    parts.push(String.fromCharCode(...codes));
  }
  return parts.join("");
};

/** Where a validated pool keeps its strings and styles (absolute offsets). */
interface PoolLayout {
  readonly count: number;
  readonly styleCount: number;
  readonly utf8: boolean;
  readonly stringsStart: number;
  readonly stringsEnd: number;
  readonly stylesStart: number;
}

/** A string pool chunk; strings are decoded on first use and cached. */
export class ResStringPool {
  readonly #cache = new Map<number, string | null>();
  readonly #budget: number;
  #decoded = 0;
  readonly count: number;
  readonly styleCount: number;
  readonly utf8: boolean;
  readonly stringsStart: number;
  readonly stringsEnd: number;
  readonly stylesStart: number;

  private constructor(
    readonly bytes: Uint8Array,
    readonly chunk: ResChunk,
    layout: PoolLayout,
  ) {
    this.count = layout.count;
    this.styleCount = layout.styleCount;
    this.utf8 = layout.utf8;
    this.stringsStart = layout.stringsStart;
    this.stringsEnd = layout.stringsEnd;
    this.stylesStart = layout.stylesStart;
    this.#budget = 2 * chunk.size + 4096;
  }

  /** Validate the pool header, offset arrays and string region. */
  static read(
    bytes: Uint8Array,
    chunk: ResChunk,
  ): ResStringPool | AndroidXmlProblem {
    const at = chunk.offset;
    if (chunk.type !== CHUNK.stringPool || chunk.headerSize < 28)
      return { offset: at, message: "String pool header is not valid." };
    const count = u32(bytes, at + 8);
    const styleCount = u32(bytes, at + 12);
    const flags = u32(bytes, at + 16);
    const stringsStart = u32(bytes, at + 20);
    const stylesStart = u32(bytes, at + 24);
    const room = (chunk.size - chunk.headerSize) / 4;
    if (count > room || styleCount > room - count)
      return {
        offset: at + 8,
        message: `String pool declares ${String(count)} strings and ${String(styleCount)} styles but holds room for ${String(Math.floor(room))} offsets.`,
      };
    const tables = chunk.headerSize + (count + styleCount) * 4;
    const stringsEnd = styleCount > 0 ? stylesStart : chunk.size;
    if (
      count > 0 &&
      (stringsStart < tables ||
        stringsStart > stringsEnd ||
        stringsEnd > chunk.size)
    )
      return {
        offset: at + 20,
        message: `String data at ${String(stringsStart)}..${String(stringsEnd)} lies outside the ${String(chunk.size)}-byte pool.`,
      };
    if (styleCount > 0 && (stylesStart < tables || stylesStart > chunk.size))
      return {
        offset: at + 24,
        message: `Style data at ${String(stylesStart)} lies outside the ${String(chunk.size)}-byte pool.`,
      };
    return new ResStringPool(bytes, chunk, {
      count,
      styleCount,
      utf8: (flags & 0x100) !== 0,
      stringsStart: at + stringsStart,
      stringsEnd: at + stringsEnd,
      stylesStart: at + stylesStart,
    });
  }

  /**
   * The string at `index`, or null when the index or its bytes are invalid.
   * Strings are cached by byte offset, and the characters decoded across
   * distinct offsets are capped at twice the pool's size, so offsets that
   * point into one another cannot multiply a small pool into a large tree.
   */
  get(index: number): string | null {
    if (index >= this.count) return null;
    const offset =
      this.stringsStart +
      u32(this.bytes, this.chunk.offset + this.chunk.headerSize + index * 4);
    const cached = this.#cache.get(offset);
    if (cached !== undefined) return cached;
    const value =
      offset >= this.stringsEnd
        ? null
        : this.utf8
          ? this.#utf8At(offset)
          : this.#utf16At(offset);
    this.#cache.set(offset, value);
    return value;
  }

  /** True once a string was refused because the decode budget is spent. */
  exhausted = false;

  /** Charge `cost` decoded units against the pool's budget before decoding them. */
  #spend(cost: number): boolean {
    if (this.#decoded + cost > this.#budget) {
      this.exhausted = true;
      return false;
    }
    this.#decoded += cost;
    return true;
  }

  #utf8At(offset: number): string | null {
    const bytes = this.bytes;
    let at = offset;
    const length = (): number => {
      const first = bytes[at] ?? 0;
      at += 1;
      if ((first & 0x80) === 0) return first;
      const second = bytes[at] ?? 0;
      at += 1;
      return ((first & 0x7f) << 8) | second;
    };
    length();
    const byteLength = length();
    if (at + byteLength > this.stringsEnd || !this.#spend(byteLength))
      return null;
    const slice = bytes.subarray(at, at + byteLength);
    try {
      return utf8.decode(slice);
    } catch {
      return decodeModifiedUtf8(slice) ?? lossyUtf8.decode(slice);
    }
  }

  #utf16At(offset: number): string | null {
    let at = offset;
    let units = u16(this.bytes, at);
    at += 2;
    if ((units & 0x8000) !== 0) {
      units = ((units & 0x7fff) << 16) | u16(this.bytes, at);
      at += 2;
    }
    if (at + units * 2 > this.stringsEnd || !this.#spend(units)) return null;
    return utf16(this.bytes, at, units);
  }

  /** Style spans of string `index`; empty when it has none or they are invalid. */
  spans(index: number): StringSpan[] {
    if (index >= this.styleCount) return [];
    const end = this.chunk.offset + this.chunk.size;
    let at =
      this.stylesStart +
      u32(
        this.bytes,
        this.chunk.offset + this.chunk.headerSize + (this.count + index) * 4,
      );
    const spans: StringSpan[] = [];
    while (at + 4 <= end && u32(this.bytes, at) !== NO_INDEX) {
      if (at + 12 > end) return [];
      spans.push({
        tag: this.get(u32(this.bytes, at)) ?? "",
        first: u32(this.bytes, at + 4),
        last: u32(this.bytes, at + 8),
      });
      at += 12;
    }
    return spans;
  }
}

interface MutableElement {
  kind: "element";
  namespace: string | null;
  name: string;
  line: number | null;
  namespaces: { prefix: string; uri: string }[];
  attributes: AndroidXmlAttribute[];
  children: AndroidXmlNode[];
}

class TreeBuilder {
  readonly problems: AndroidXmlProblem[] = [];
  readonly stack: MutableElement[] = [];
  root: MutableElement | null = null;
  pending: { prefix: string; uri: string }[] = [];
  nodes = 0;
  pool: ResStringPool | null = null;
  ids: Uint32Array = new Uint32Array(0);

  constructor(readonly bytes: Uint8Array) {}

  string(index: number): string | null {
    return index === NO_INDEX ? null : (this.pool?.get(index) ?? null);
  }

  /** Strings a node must name; a missing one is recorded and kept as "". */
  required(index: number, offset: number, what: string): string {
    const value = this.string(index);
    if (value === null)
      this.problems.push({
        offset,
        message:
          this.pool?.exhausted === true
            ? `${what} string ${String(index)} was not decoded: the pool's decode budget is spent.`
            : `${what} string ${String(index)} is not in the string pool.`,
      });
    return value ?? "";
  }

  /** Count one more node; false (with a problem) when the node limit stops decoding. */
  count(offset: number): boolean {
    if (this.nodes < MAX_XML_NODES) {
      this.nodes += 1;
      return true;
    }
    this.problems.push({
      offset,
      message: `Document holds more than ${String(MAX_XML_NODES)} nodes; decoding stopped.`,
    });
    return false;
  }
}

const RES_VALUE_SIZE = 8;
const ATTRIBUTE_SIZE = 12 + RES_VALUE_SIZE;

const readAttributes = (
  builder: TreeBuilder,
  chunk: ResChunk,
  ext: number,
): AndroidXmlAttribute[] | AndroidXmlProblem => {
  const bytes = builder.bytes;
  const start = u16(bytes, ext + 8);
  const stride = u16(bytes, ext + 10);
  const count = u16(bytes, ext + 12);
  const end = chunk.offset + chunk.size;
  if (
    count > 0 &&
    (stride < ATTRIBUTE_SIZE || ext + start + count * stride > end)
  )
    return {
      offset: ext + 8,
      message: `${String(count)} attributes of ${String(stride)} bytes at ${String(start)} do not fit in the element chunk.`,
    };
  const attributes: AndroidXmlAttribute[] = [];
  for (let index = 0; index < count; index += 1) {
    const at = ext + start + index * stride;
    const nameIndex = u32(bytes, at + 4);
    const id =
      nameIndex < builder.ids.length ? (builder.ids[nameIndex] ?? 0) : 0;
    attributes.push({
      namespace: builder.string(u32(bytes, at)),
      name: builder.required(nameIndex, at + 4, "Attribute name"),
      resource_id: id === 0 ? null : id,
      raw: builder.string(u32(bytes, at + 8)),
      value: resValue(bytes[at + 15] ?? 0, u32(bytes, at + 16), (string) =>
        builder.string(string),
      ),
    });
  }
  return attributes;
};

const MIN_EXTENSION: Readonly<Record<number, number>> = {
  [CHUNK.xmlStartNamespace]: 8,
  [CHUNK.xmlEndNamespace]: 8,
  [CHUNK.xmlStartElement]: 20,
  [CHUNK.xmlEndElement]: 8,
  [CHUNK.xmlCdata]: 4 + RES_VALUE_SIZE,
};

const startElement = (
  builder: TreeBuilder,
  chunk: ResChunk,
  ext: number,
): boolean => {
  const bytes = builder.bytes;
  if (builder.stack.length >= MAX_XML_DEPTH) {
    builder.problems.push({
      offset: chunk.offset,
      message: `Elements nest deeper than ${String(MAX_XML_DEPTH)} levels; decoding stopped.`,
    });
    return false;
  }
  if (builder.root !== null && builder.stack.length === 0) {
    builder.problems.push({
      offset: chunk.offset,
      message: "A second root element follows the first; decoding stopped.",
    });
    return false;
  }
  if (!builder.count(chunk.offset)) return false;
  const attributes = readAttributes(builder, chunk, ext);
  if ("message" in attributes) {
    builder.problems.push(attributes);
    return false;
  }
  const element: MutableElement = {
    kind: "element",
    namespace: builder.string(u32(bytes, ext)),
    name: builder.required(u32(bytes, ext + 4), ext + 4, "Element name"),
    line: u32(bytes, chunk.offset + 8),
    namespaces: builder.pending,
    attributes,
    children: [],
  };
  builder.pending = [];
  const parent = builder.stack.at(-1);
  if (parent === undefined) builder.root = element;
  else parent.children.push(element);
  builder.stack.push(element);
  return true;
};

const endElement = (
  builder: TreeBuilder,
  chunk: ResChunk,
  ext: number,
): boolean => {
  const open = builder.stack.pop();
  if (open === undefined) {
    builder.problems.push({
      offset: chunk.offset,
      message: "An element ends that was never started; decoding stopped.",
    });
    return false;
  }
  const name = builder.string(u32(builder.bytes, ext + 4));
  if (name !== open.name)
    builder.problems.push({
      offset: chunk.offset,
      message: `End element "${name ?? ""}" closes "${open.name}".`,
    });
  return true;
};

const cdata = (builder: TreeBuilder, chunk: ResChunk, ext: number): boolean => {
  const parent = builder.stack.at(-1);
  const text = builder.required(u32(builder.bytes, ext), ext, "Text");
  if (parent === undefined) {
    if (text.trim() !== "")
      builder.problems.push({
        offset: chunk.offset,
        message: "Text outside the root element was skipped.",
      });
    return true;
  }
  if (!builder.count(chunk.offset)) return false;
  parent.children.push({
    kind: "text",
    text,
    line: u32(builder.bytes, chunk.offset + 8),
  });
  return true;
};

/** Handle one XML node chunk; false stops decoding. */
const node = (builder: TreeBuilder, chunk: ResChunk): boolean => {
  const bytes = builder.bytes;
  const ext = chunk.offset + chunk.headerSize;
  if (
    chunk.headerSize < 16 ||
    chunk.size - chunk.headerSize < (MIN_EXTENSION[chunk.type] ?? 0)
  ) {
    builder.problems.push({
      offset: chunk.offset,
      message: `XML node ${typeHex(chunk.type)} is too small for its header and extension.`,
    });
    return false;
  }
  if (builder.pool === null) {
    builder.problems.push({
      offset: chunk.offset,
      message: "XML nodes appear before any string pool; decoding stopped.",
    });
    return false;
  }
  switch (chunk.type) {
    case CHUNK.xmlStartNamespace:
      builder.pending.push({
        prefix: builder.required(u32(bytes, ext), ext, "Namespace prefix"),
        uri: builder.required(u32(bytes, ext + 4), ext + 4, "Namespace URI"),
      });
      return true;
    case CHUNK.xmlEndNamespace:
      return true;
    case CHUNK.xmlStartElement:
      return startElement(builder, chunk, ext);
    case CHUNK.xmlEndElement:
      return endElement(builder, chunk, ext);
    default:
      return cdata(builder, chunk, ext);
  }
};

/** Handle one child chunk of the XML root; false stops decoding. */
const child = (builder: TreeBuilder, chunk: ResChunk): boolean => {
  if (chunk.type === CHUNK.stringPool) {
    if (builder.pool !== null) {
      builder.problems.push({
        offset: chunk.offset,
        message: "A second string pool was skipped.",
      });
      return true;
    }
    const pool = ResStringPool.read(builder.bytes, chunk);
    if ("message" in pool) {
      builder.problems.push(pool);
      return false;
    }
    builder.pool = pool;
    return true;
  }
  if (chunk.type === CHUNK.xmlResourceMap) {
    const count = Math.floor((chunk.size - chunk.headerSize) / 4);
    builder.ids = new Uint32Array(count);
    for (let index = 0; index < count; index += 1)
      builder.ids[index] = u32(
        builder.bytes,
        chunk.offset + chunk.headerSize + index * 4,
      );
    return true;
  }
  if (chunk.type >= CHUNK.xmlStartNamespace && chunk.type <= CHUNK.xmlCdata)
    return node(builder, chunk);
  builder.problems.push({
    offset: chunk.offset,
    message: `Unknown chunk type ${typeHex(chunk.type)} (${String(chunk.size)} bytes) was skipped.`,
  });
  return true;
};

/** The document's byte range after validating the root RES_XML_TYPE header. */
const documentEnd = (
  bytes: Uint8Array,
  problems: AndroidXmlProblem[],
): number => {
  if (bytes.length < 8)
    throw new AndroidXmlFormatError(
      0,
      `Document needs 8 header bytes but has ${String(bytes.length)}.`,
    );
  const type = u16(bytes, 0);
  const headerSize = u16(bytes, 2);
  const size = u32(bytes, 4);
  if (type !== CHUNK.xml)
    throw new AndroidXmlFormatError(
      0,
      `Chunk type ${typeHex(type)} is not a compiled XML document.`,
    );
  if (headerSize < 8 || headerSize > size || headerSize > bytes.length)
    throw new AndroidXmlFormatError(
      2,
      `Document header size ${String(headerSize)} does not fit its size ${String(size)}.`,
    );
  if (size > bytes.length) {
    problems.push({
      offset: 4,
      message: `Document declares ${String(size)} bytes but only ${String(bytes.length)} are present.`,
    });
    return bytes.length;
  }
  if (size < bytes.length)
    problems.push({
      offset: size,
      message: `${String(bytes.length - size)} bytes follow the document and were not read.`,
    });
  return size;
};

/**
 * Decode a compiled binary XML document. A damaged chunk after a readable
 * root element is recorded in `problems` and ends decoding with what was
 * read; a document without a readable root throws AndroidXmlFormatError.
 */
export const decodeBinaryXml = (bytes: Uint8Array): AndroidXmlDocument => {
  const builder = new TreeBuilder(bytes);
  const end = documentEnd(bytes, builder.problems);
  let at = u16(bytes, 2);
  while (at < end) {
    const chunk = readChunk(bytes, at, end);
    if ("message" in chunk) {
      builder.problems.push(chunk);
      break;
    }
    if (!child(builder, chunk)) break;
    at += chunk.size;
  }
  if (builder.root === null) {
    const problem = builder.problems.at(-1);
    throw new AndroidXmlFormatError(
      problem?.offset ?? at,
      problem?.message ?? "Document has no root element.",
    );
  }
  if (builder.stack.length > 0)
    builder.problems.push({
      offset: Math.min(at, end),
      message: `${String(builder.stack.length)} elements were still open where decoding ended.`,
    });
  return {
    encoding: "binary-xml",
    root: builder.root,
    node_count: builder.nodes,
    problems: builder.problems,
  };
};
