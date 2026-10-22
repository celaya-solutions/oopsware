import { DecodeBudget, MemberReadFailure } from "../artifacts/zipMemberView.js";
import { decodeFilters, type DecodedStream } from "./filters.js";
import {
  asArray,
  asCount,
  asDict,
  asName,
  asRef,
  asStream,
  END,
  isKeyword,
  isSpace,
  latin1,
  Lexer,
  PdfSyntaxError,
  readIndirectObject,
  type IndirectObject,
  type PdfDict,
  type PdfStream,
  type PdfValue,
} from "./syntax.js";

/** Largest cross-reference table kept; entries beyond it are not read. */
export const MAX_XREF_ENTRIES = 4_000_000;
const MAX_XREF_SECTIONS = 10_000;
const MAX_PROBLEMS = 50;
const MAX_CACHED_OBJECTS = 50_000;
const MAX_CACHED_STREAMS = 4;
/** Decoded streams kept for reuse: a script or attachment many actions share is decoded once. */
const MAX_CACHED_DECODED_BYTES = 64 * 1024 ** 2;
const MAX_CACHED_DECODED_EACH = 8 * 1024 ** 2;
const MAX_REFERENCE_HOPS = 32;
const HEADER_WINDOW = 1024;
const TAIL_WINDOW = 4096;
/** Object headers noted by the rebuild scan before it stops. */
const MAX_SCANNED_OBJECTS = 2_000_000;

export type XrefEntry =
  | { readonly kind: "offset"; readonly offset: number; readonly gen: number }
  | {
      readonly kind: "compressed";
      readonly stream: number;
      readonly index: number;
    }
  | { readonly kind: "free" };

export type XrefState = "table" | "stream" | "hybrid" | "rebuilt" | "none";

/** The document is encrypted; no password is tried and nothing is decrypted. */
export class PdfEncryptedError extends Error {
  readonly _tag = "PdfEncryptedError";
}

/** The in-process read ran past its deadline. */
export class PdfDeadlineError extends Error {
  readonly _tag = "PdfDeadlineError";
}

interface ObjectStream {
  readonly bytes: Uint8Array;
  readonly first: number;
  readonly pairs: readonly (readonly [number, number])[];
}

export interface PdfFileOptions {
  readonly signal?: AbortSignal | undefined;
  /** Epoch milliseconds after which the read stops between steps. */
  readonly deadline?: number | undefined;
}

const view = (bytes: Uint8Array): Buffer =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

const digitsBefore = (bytes: Uint8Array, end: number): number => {
  let at = end;
  while (
    at > 0 &&
    (bytes[at - 1] as number) >= 0x30 &&
    (bytes[at - 1] as number) <= 0x39
  )
    at -= 1;
  return at;
};

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export class PdfFile {
  readonly xref = new Map<number, XrefEntry>();
  readonly problems: string[] = [];
  problemsDropped = 0;
  headerOffset = -1;
  version: string | null = null;
  trailer: PdfDict | null = null;
  state: XrefState = "none";
  sections = 0;
  /** `startxref` markers in the file, one per revision that wrote a table. */
  startxrefs = 0;
  xrefTruncated = false;

  readonly #cache = new Map<number, PdfValue>();
  readonly #objectStreams = new Map<number, ObjectStream>();
  readonly #decodedCache = new Map<number, DecodedStream>();
  #decodedCacheBytes = 0;
  #rebuilt = false;
  #ticks = 0;

  private constructor(
    readonly bytes: Uint8Array,
    readonly budget: DecodeBudget,
    readonly signal: AbortSignal | undefined,
    readonly deadline: number | undefined,
  ) {}

  static open(
    bytes: Uint8Array,
    budget: DecodeBudget,
    options: PdfFileOptions = {},
  ): PdfFile {
    const file = new PdfFile(bytes, budget, options.signal, options.deadline);
    file.#readHeader();
    file.#readStructure();
    return file;
  }

  /** Call inside any loop whose length the file decides: stops on cancellation or past the deadline. */
  tick(): void {
    this.signal?.throwIfAborted();
    this.#ticks += 1;
    if (
      this.deadline !== undefined &&
      this.#ticks % 256 === 0 &&
      Date.now() > this.deadline
    )
      throw new PdfDeadlineError("The in-process read passed its deadline.");
  }

  problem(message: string): void {
    if (this.problems.includes(message)) return;
    if (this.problems.length >= MAX_PROBLEMS) this.problemsDropped += 1;
    else this.problems.push(message);
  }

  get encrypted(): boolean {
    return this.trailer?.map.has("Encrypt") === true;
  }

  #readHeader(): void {
    const window = view(this.bytes).subarray(0, HEADER_WINDOW);
    const at = window.indexOf("%PDF-");
    if (at < 0) return;
    this.headerOffset = at;
    const match = /^\d\.\d/u.exec(latin1(this.bytes, at + 5, at + 10));
    this.version = match?.[0] ?? null;
    if (at > 0)
      this.problem(
        `${String(at)} bytes precede the %PDF- header; offsets in the file may count from the header.`,
      );
  }

  /** The file's cross-reference chain, or a scan of the objects when the chain cannot be trusted. */
  #readStructure(): void {
    try {
      this.#readChain();
    } catch (cause) {
      if (
        this.signal?.aborted === true ||
        cause instanceof PdfDeadlineError ||
        cause instanceof MemberReadFailure
      )
        throw cause;
      this.problem(
        `The cross-reference chain could not be read (${cause instanceof Error ? cause.message : String(cause)}).`,
      );
      this.state = "none";
    }
    if (this.trailer === null || this.#root() === null) {
      if (this.state !== "none")
        this.problem("The trailer's Root does not lead to a document catalog.");
      this.#rebuild();
    }
  }

  #root(): PdfDict | null {
    return asDict(this.resolve(this.trailer?.map.get("Root")));
  }

  #startOffset(): number | null {
    const tail = view(this.bytes).subarray(
      Math.max(0, this.bytes.length - TAIL_WINDOW),
    );
    const at = tail.lastIndexOf("startxref");
    if (at < 0) return null;
    const lexer = new Lexer(
      this.bytes,
      this.bytes.length - tail.length + at + 9,
    );
    const value = lexer.readValue();
    return isNumber(value) ? value : null;
  }

  #readChain(): void {
    const buf = view(this.bytes);
    let from = 0;
    for (;;) {
      const at = buf.indexOf("startxref", from);
      if (at < 0) break;
      this.startxrefs += 1;
      from = at + 9;
    }
    let offset = this.#startOffset();
    if (offset === null)
      throw new PdfSyntaxError(
        "There is no startxref marker near the end of the file.",
      );
    const seen = new Set<number>();
    const trailers: PdfDict[] = [];
    let hybrid = false;
    let sawStream = false;
    let sawTable = false;
    while (offset !== null) {
      this.tick();
      if (seen.has(offset)) {
        this.problem("The cross-reference chain loops back on itself.");
        break;
      }
      if (this.sections >= MAX_XREF_SECTIONS) {
        this.problem(
          `The cross-reference chain has more than ${String(MAX_XREF_SECTIONS)} sections; the rest are not read.`,
        );
        break;
      }
      seen.add(offset);
      const section = this.#readSection(offset);
      if (section === null) {
        this.problem(
          `No cross-reference section starts at offset ${String(offset)}.`,
        );
        break;
      }
      this.sections += 1;
      trailers.push(section.trailer);
      if (section.kind === "table") sawTable = true;
      else sawStream = true;
      if (section.hybrid) hybrid = true;
      offset = asCount(section.trailer.map.get("Prev"));
    }
    if (trailers.length === 0) {
      this.state = "none";
      return;
    }
    const merged = new Map<string, PdfValue>();
    for (const trailer of trailers)
      for (const [key, value] of trailer.map)
        if (!merged.has(key)) merged.set(key, value);
    this.trailer = { t: "dict", map: merged };
    this.state = hybrid
      ? "hybrid"
      : sawStream && !sawTable
        ? "stream"
        : "table";
  }

  /** Make an offset from the file absolute: some files count from the %PDF- header, not the first byte. */
  #absolute(offset: number): number {
    const verify = (at: number): boolean => {
      if (at < 0 || at >= this.bytes.length) return false;
      const lexer = new Lexer(
        this.bytes,
        at,
        Math.min(this.bytes.length, at + 64),
      );
      lexer.skipSpace();
      const next = lexer.pos;
      if (latin1(this.bytes, next, next + 4) === "xref") return true;
      return /^\d+\s+\d+\s+obj/u.test(
        latin1(this.bytes, next, Math.min(this.bytes.length, next + 40)),
      );
    };
    if (verify(offset)) return offset;
    if (this.headerOffset > 0 && verify(offset + this.headerOffset))
      return offset + this.headerOffset;
    return offset;
  }

  #readSection(
    offset: number,
  ): { trailer: PdfDict; kind: "table" | "stream"; hybrid: boolean } | null {
    const at = this.#absolute(offset);
    const lexer = new Lexer(this.bytes, at);
    lexer.skipSpace();
    if (latin1(this.bytes, lexer.pos, lexer.pos + 4) === "xref") {
      lexer.pos += 4;
      const freed = this.#readTable(lexer);
      const keyword = lexer.readValue();
      if (!(isKeyword(keyword) && keyword.v === "trailer")) return null;
      const dict = asDict(lexer.readValue() as PdfValue);
      if (dict === null) return null;
      let hybrid = false;
      const stm = asCount(dict.map.get("XRefStm"));
      if (stm !== null) hybrid = this.#readStreamSection(stm, freed) !== null;
      return { trailer: dict, kind: "table", hybrid };
    }
    const section = this.#readStreamSection(offset, null);
    return section === null
      ? null
      : { trailer: section, kind: "stream", hybrid: false };
  }

  /**
   * The first definition of an object wins, because newer sections are read
   * first. A hybrid file's stream may fill only the numbers its own table
   * marked free; it can never bring back what a newer section freed.
   */
  #setEntry(
    num: number,
    entry: XrefEntry,
    overridable: ReadonlyMap<number, XrefEntry> | null,
  ): boolean {
    if (!isNumber(num)) return false;
    if (
      (entry.kind === "offset" &&
        !(isNumber(entry.offset) && isNumber(entry.gen))) ||
      (entry.kind === "compressed" &&
        !(isNumber(entry.stream) && isNumber(entry.index)))
    )
      return false;
    const existing = this.xref.get(num);
    // Only the free entry this very table wrote may be replaced, never one a newer section wrote.
    if (
      existing !== undefined &&
      !(existing.kind === "free" && overridable?.get(num) === existing)
    )
      return false;
    if (existing === undefined && this.xref.size >= MAX_XREF_ENTRIES) {
      this.xrefTruncated = true;
      return false;
    }
    this.xref.set(num, entry);
    return true;
  }

  /** Read the subsections of a classic table; returns the numbers it marks free. */
  #readTable(lexer: Lexer): Map<number, XrefEntry> {
    const freed = new Map<number, XrefEntry>();
    for (;;) {
      this.tick();
      lexer.skipSpace();
      const save = lexer.pos;
      const start = lexer.readValue();
      if (!isNumber(start)) {
        lexer.pos = save;
        return freed;
      }
      const count = lexer.readValue();
      if (!isNumber(count)) {
        lexer.pos = save;
        return freed;
      }
      for (let index = 0; index < count; index += 1) {
        this.tick();
        // A table is many small tokens, so the per-object token limit applies to each entry, not the table.
        lexer.nodes = 0;
        const position = lexer.readValue();
        const gen = lexer.readValue();
        const flag = lexer.readValue();
        if (!isNumber(position) || !isNumber(gen) || !isKeyword(flag)) {
          this.problem(
            "A cross-reference table ends before the entries it declares.",
          );
          return freed;
        }
        const num = start + index;
        if (flag.v === "n")
          this.#setEntry(
            num,
            { kind: "offset", offset: this.#absolute(position), gen },
            null,
          );
        else if (flag.v === "f") {
          const entry: XrefEntry = { kind: "free" };
          if (this.#setEntry(num, entry, null)) freed.set(num, entry);
        } else {
          this.problem(
            "A cross-reference table entry is neither in use nor free.",
          );
          return freed;
        }
        if (this.xrefTruncated) return freed;
      }
    }
  }

  #readStreamSection(
    offset: number,
    overridable: ReadonlyMap<number, XrefEntry> | null,
  ): PdfDict | null {
    const at = this.#absolute(offset);
    const parsed = this.#parseFull(at);
    const stream = asStream(parsed?.value);
    if (stream === null) return null;
    const dict = stream.dict;
    const widths = asArray(dict.map.get("W"));
    if (widths === null || widths.items.length < 3) return null;
    const w = widths.items.slice(0, 3).map((item) => asCount(item) ?? -1);
    if (w.some((width) => width < 0 || width > 8)) return null;
    const decoded = this.#decode(stream, true);
    const size = asCount(dict.map.get("Size")) ?? 0;
    const index = asArray(dict.map.get("Index"))?.items.map(
      (item) => asCount(item) ?? 0,
    ) ?? [0, size];
    const row = (w[0] as number) + (w[1] as number) + (w[2] as number);
    if (row === 0) return dict;
    const field = (from: number, width: number, fallback: number): number => {
      if (width === 0) return fallback;
      let value = 0;
      for (let at2 = 0; at2 < width; at2 += 1)
        value = value * 256 + (decoded.bytes[from + at2] as number);
      return value;
    };
    let cursor = 0;
    for (let pair = 0; pair + 1 < index.length; pair += 2) {
      const first = index[pair] as number;
      const count = index[pair + 1] as number;
      for (let n = 0; n < count; n += 1) {
        this.tick();
        if (cursor + row > decoded.bytes.length) return dict;
        const kind = field(cursor, w[0] as number, 1);
        const one = field(cursor + (w[0] as number), w[1] as number, 0);
        const two = field(
          cursor + (w[0] as number) + (w[1] as number),
          w[2] as number,
          0,
        );
        cursor += row;
        if (kind === 0)
          this.#setEntry(first + n, { kind: "free" }, overridable);
        else if (kind === 1)
          this.#setEntry(
            first + n,
            { kind: "offset", offset: this.#absolute(one), gen: two },
            overridable,
          );
        else if (kind === 2)
          this.#setEntry(
            first + n,
            { kind: "compressed", stream: one, index: two },
            overridable,
          );
        if (this.xrefTruncated) return dict;
      }
    }
    return dict;
  }

  /** Where an `N G obj` header starts, for each `obj` keyword in the file, in file order. */
  #objectHeaders(): { num: number; gen: number; offset: number }[] {
    const buf = view(this.bytes);
    const headers: { num: number; gen: number; offset: number }[] = [];
    let from = 0;
    for (;;) {
      const hit = buf.indexOf("obj", from);
      if (hit < 0) break;
      from = hit + 3;
      if (hit > 0 && buf[hit - 1] === 0x64) continue;
      const after = buf[hit + 3];
      if (
        after !== undefined &&
        !isSpace(after) &&
        after !== 0x3c &&
        after !== 0x5b &&
        after !== 0x2f &&
        after !== 0x28
      )
        continue;
      let at = hit;
      while (at > 0 && isSpace(buf[at - 1])) at -= 1;
      if (at === hit) continue;
      const genStart = digitsBefore(buf, at);
      if (genStart === at || at - genStart > 5) continue;
      let numEnd = genStart;
      while (numEnd > 0 && isSpace(buf[numEnd - 1])) numEnd -= 1;
      if (numEnd === genStart) continue;
      const numStart = digitsBefore(buf, numEnd);
      if (numStart === numEnd || numEnd - numStart > 10) continue;
      headers.push({
        num: Number(latin1(buf, numStart, numEnd)),
        gen: Number(latin1(buf, genStart, at)),
        offset: numStart,
      });
      this.tick();
      if (headers.length >= MAX_SCANNED_OBJECTS) {
        this.xrefTruncated = true;
        break;
      }
    }
    return headers;
  }

  /**
   * Find every top-level `N G obj` when the chain is missing or leads nowhere.
   * Bytes inside a stream are skipped, so an uncompressed file embedded in an
   * attachment cannot add objects or a trailer of its own. A later definition
   * of an object number wins.
   */
  #rebuild(): void {
    if (this.#rebuilt) return;
    this.#rebuilt = true;
    this.xref.clear();
    this.#cache.clear();
    this.#objectStreams.clear();
    this.#decodedCache.clear();
    this.#decodedCacheBytes = 0;
    this.xrefTruncated = false;
    const trailers = new Map<string, PdfValue>();
    const streamRanges: [number, number][] = [];
    const objectStreams: number[] = [];
    let rootNum: number | null = null;
    let cursor = 0;
    for (const header of this.#objectHeaders()) {
      this.tick();
      if (header.offset < cursor) continue;
      const parsed = this.#parseFull(header.offset);
      if (parsed === null || parsed.num !== header.num) continue;
      this.xref.set(header.num, {
        kind: "offset",
        offset: header.offset,
        gen: header.gen,
      });
      const stream = asStream(parsed.value);
      if (stream !== null) {
        const data = this.raw(stream);
        const end = data.byteOffset - this.bytes.byteOffset + data.length;
        streamRanges.push([stream.start, end]);
        cursor = end;
      }
      const dict = asDict(parsed.value);
      const type = dict === null ? null : asName(dict.map.get("Type"));
      if (dict !== null && type === "Catalog") rootNum = header.num;
      else if (dict !== null && type === "XRef")
        for (const key of ["Root", "Info", "Encrypt", "ID"]) {
          const value = dict.map.get(key);
          if (value !== undefined) trailers.set(key, value);
        }
      else if (stream !== null && type === "ObjStm")
        objectStreams.push(header.num);
    }
    const buf = view(this.bytes);
    let range = 0;
    for (let at = 0; ;) {
      const hit = buf.indexOf("trailer", at);
      if (hit < 0) break;
      at = hit + 7;
      this.tick();
      while (
        range < streamRanges.length &&
        (streamRanges[range] as [number, number])[1] <= hit
      )
        range += 1;
      const inside = streamRanges[range];
      if (inside !== undefined && inside[0] <= hit) continue;
      try {
        const dict = asDict(new Lexer(this.bytes, at).readValue() as PdfValue);
        if (dict !== null)
          for (const [key, value] of dict.map) trailers.set(key, value);
      } catch (cause) {
        if (!(cause instanceof PdfSyntaxError)) throw cause;
      }
    }
    this.trailer = { t: "dict", map: trailers };
    if (!trailers.has("Root") && rootNum !== null)
      trailers.set("Root", { t: "ref", num: rootNum, gen: 0 });
    if (!this.encrypted) {
      for (const stream of objectStreams) {
        try {
          const loaded = this.#loadObjectStream(stream);
          loaded.pairs.forEach(([num], index) => {
            if (isNumber(num) && !this.xref.has(num))
              this.xref.set(num, { kind: "compressed", stream, index });
          });
        } catch (cause) {
          if (
            this.signal?.aborted === true ||
            cause instanceof PdfDeadlineError ||
            cause instanceof MemberReadFailure
          )
            throw cause;
        }
      }
      if (!trailers.has("Root"))
        for (const [num, entry] of this.xref)
          if (entry.kind === "compressed") {
            this.tick();
            const dict = asDict(this.object(num) ?? undefined);
            if (dict !== null && asName(dict.map.get("Type")) === "Catalog") {
              trailers.set("Root", { t: "ref", num, gen: 0 });
              break;
            }
          }
    }
    this.state = "rebuilt";
    this.problem(
      "The cross-reference data was missing or wrong, so the objects were found by scanning the file.",
    );
  }

  /** An indirect object at `offset`, or null when none starts there or it is too malformed to read. */
  #parseFull(offset: number): IndirectObject | null {
    try {
      return readIndirectObject(this.bytes, offset);
    } catch (cause) {
      if (cause instanceof PdfSyntaxError) return null;
      throw cause;
    }
  }

  #parseAt(offset: number, num: number): PdfValue | undefined {
    const parsed = this.#parseFull(offset);
    return parsed === null || parsed.num !== num ? undefined : parsed.value;
  }

  /** The parsed value of an object, or undefined when it is free, absent or unreadable. */
  object(num: number): PdfValue | undefined {
    const cached = this.#cache.get(num);
    if (cached !== undefined) return cached;
    const entry = this.xref.get(num);
    if (entry === undefined || entry.kind === "free") return undefined;
    let value: PdfValue | undefined;
    if (entry.kind === "offset") {
      value = this.#parseAt(entry.offset, num);
      if (value === undefined && !this.#rebuilt) {
        this.problem(
          `Object ${String(num)} is not where the cross-reference data says; the file was rescanned.`,
        );
        this.#rebuild();
        return this.object(num);
      }
    } else {
      try {
        value = this.#compressed(num, entry);
      } catch (cause) {
        if (
          cause instanceof MemberReadFailure ||
          cause instanceof PdfDeadlineError ||
          this.signal?.aborted === true
        )
          throw cause;
        this.problem(
          cause instanceof PdfEncryptedError
            ? `Object ${String(num)} lies in an object stream, which is encrypted and not read.`
            : `Object ${String(num)} lies in an object stream that could not be read.`,
        );
      }
    }
    if (value !== undefined && this.#cache.size < MAX_CACHED_OBJECTS)
      this.#cache.set(num, value);
    return value;
  }

  #compressed(
    num: number,
    entry: Extract<XrefEntry, { kind: "compressed" }>,
  ): PdfValue | undefined {
    const stream = this.#loadObjectStream(entry.stream);
    let slot = stream.pairs[entry.index];
    if (slot === undefined || slot[0] !== num)
      slot = stream.pairs.find((pair) => pair[0] === num);
    if (slot === undefined) return undefined;
    const lexer = new Lexer(stream.bytes, stream.first + slot[1]);
    const value = lexer.readValue();
    return value === END || isKeyword(value) ? undefined : value;
  }

  #loadObjectStream(num: number): ObjectStream {
    const cached = this.#objectStreams.get(num);
    if (cached !== undefined) return cached;
    const stream = asStream(this.#plainObject(num));
    if (stream === null)
      throw new PdfSyntaxError(
        `Object ${String(num)} is not an object stream.`,
      );
    const decoded = this.decoded(stream);
    if (decoded.state !== "complete")
      throw new PdfSyntaxError(
        decoded.note ?? "The object stream could not be decoded.",
      );
    const count = asCount(this.resolve(stream.dict.map.get("N"))) ?? 0;
    const first = asCount(this.resolve(stream.dict.map.get("First"))) ?? 0;
    if (count > 1_000_000 || first > decoded.bytes.length)
      throw new PdfSyntaxError("An object stream declares an impossible size.");
    const lexer = new Lexer(decoded.bytes, 0, first);
    const pairs: [number, number][] = [];
    for (let index = 0; index < count; index += 1) {
      lexer.nodes = 0;
      const a = lexer.readValue();
      const b = lexer.readValue();
      if (!isNumber(a) || !isNumber(b)) break;
      pairs.push([a, b]);
    }
    const loaded: ObjectStream = { bytes: decoded.bytes, first, pairs };
    if (this.#objectStreams.size >= MAX_CACHED_STREAMS) {
      const oldest = this.#objectStreams.keys().next();
      if (oldest.done !== true) this.#objectStreams.delete(oldest.value);
    }
    this.#objectStreams.set(num, loaded);
    return loaded;
  }

  /** An object that is stored at a file offset, never inside an object stream. */
  #plainObject(num: number): PdfValue | undefined {
    const entry = this.xref.get(num);
    return entry?.kind === "offset"
      ? this.#parseAt(entry.offset, num)
      : undefined;
  }

  /** Follow references until a direct value; an unresolvable one is null. */
  resolve(value: PdfValue | undefined): PdfValue {
    let current: PdfValue | undefined = value;
    for (let hop = 0; hop < MAX_REFERENCE_HOPS; hop += 1) {
      const ref = asRef(current);
      if (ref === null) return current ?? null;
      current = this.object(ref.num);
    }
    return null;
  }

  /** The bytes as stored, between `stream` and `endstream`. */
  raw(stream: PdfStream): Uint8Array {
    const declared = asCount(this.resolve(stream.dict.map.get("Length")));
    const buf = view(this.bytes);
    if (declared !== null && stream.start + declared <= this.bytes.length) {
      let at = stream.start + declared;
      while (at < this.bytes.length && isSpace(this.bytes[at])) at += 1;
      if (latin1(this.bytes, at, at + 9) === "endstream")
        return this.bytes.subarray(stream.start, stream.start + declared);
    }
    const stop = buf.indexOf("endstream", stream.start);
    if (stop < 0) return this.bytes.subarray(stream.start);
    let end = stop;
    if (this.bytes[end - 1] === 10) end -= 1;
    if (this.bytes[end - 1] === 13) end -= 1;
    return this.bytes.subarray(stream.start, Math.max(stream.start, end));
  }

  /** The stream's filter names, resolved. */
  filters(stream: PdfStream): { names: string[]; parms: (PdfDict | null)[] } {
    const filter = this.resolve(stream.dict.map.get("Filter"));
    const parms = this.resolve(stream.dict.map.get("DecodeParms"));
    const names: string[] = [];
    const list = asArray(filter);
    if (list !== null) {
      for (const item of list.items) {
        const filterName = asName(this.resolve(item));
        if (filterName !== null) names.push(filterName);
      }
    } else {
      const only = asName(filter);
      if (only !== null) names.push(only);
    }
    const options: (PdfDict | null)[] = [];
    const many = asArray(parms);
    if (many !== null)
      for (const item of many.items) options.push(asDict(this.resolve(item)));
    else options.push(asDict(parms));
    return { names, parms: options };
  }

  /**
   * The stream's decoded bytes. Encrypted documents refuse anything but
   * cross-reference streams. A result is kept for reuse (within a size cap) and
   * charged to the decoding budget once.
   */
  decoded(stream: PdfStream): DecodedStream {
    return this.#decode(stream, false);
  }

  #decode(stream: PdfStream, structural: boolean): DecodedStream {
    if (
      !structural &&
      this.encrypted &&
      asName(stream.dict.map.get("Type")) !== "XRef"
    )
      throw new PdfEncryptedError(
        "This document is encrypted; its streams are not decoded.",
      );
    if (stream.dict.map.has("F"))
      return {
        bytes: new Uint8Array(0),
        filters: [],
        state: "unsupported",
        note: "The stream's data lies in an external file, which is never opened.",
      };
    const kept = this.#decodedCache.get(stream.num);
    if (kept !== undefined) return kept;
    const { names, parms } = this.filters(stream);
    const decoded = decodeFilters(
      this.raw(stream),
      names,
      parms,
      this.budget,
      `object ${String(stream.num)}`,
    );
    this.#keep(stream.num, decoded);
    return decoded;
  }

  #keep(num: number, decoded: DecodedStream): void {
    if (decoded.bytes.length > MAX_CACHED_DECODED_EACH) return;
    while (
      this.#decodedCacheBytes + decoded.bytes.length >
      MAX_CACHED_DECODED_BYTES
    ) {
      const oldest = this.#decodedCache.entries().next();
      if (oldest.done === true) return;
      this.#decodedCache.delete(oldest.value[0]);
      this.#decodedCacheBytes -= oldest.value[1].bytes.length;
    }
    this.#decodedCache.set(num, decoded);
    this.#decodedCacheBytes += decoded.bytes.length;
  }

  /** Object numbers in order, for the objects view. */
  numbers(): number[] {
    return [...this.xref]
      .filter(([, entry]) => entry.kind !== "free")
      .map(([num]) => num)
      .sort((a, b) => a - b);
  }
}
