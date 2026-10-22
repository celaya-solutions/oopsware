import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { inflate } from "node:zlib";

import { MemberReadFailure } from "../../artifacts/zipMemberView.js";
import type { ReaderCounters } from "../reader.js";
import type { LegacyReaderArgs } from "./legacy.js";
import {
  IdIndex,
  RT,
  at,
  type PersistDirectory,
  type PptRecord,
  type PptStream,
} from "./pptRecords.js";

/**
 * What the PowerPoint Document stream carries besides slides ([MS-PPT] 2.10):
 * the external object list (hyperlinks, embedded and linked OLE objects,
 * ActiveX controls, linked and embedded media) and the VBA project
 * (2.4.10). OLE and VBA storages are records of their own (ExOleObjStg,
 * VbaProjectStg), found through the persist directory, stored raw or
 * zlib-compressed; they are hashed inside the decoding budget, never parsed.
 * Hyperlinks are only located here; their strings are decoded when a slide
 * refers to them.
 */

const inflateAsync = promisify(inflate);

/** OLE and VBA storages hashed per read, as for the package's own storages. */
const MAX_HASHED = 64;
/** Largest storage inflated to hash it; a real embedded object or VBA project is far smaller. */
const MAX_INFLATED = 256 * 1024 ** 2;
/** ProgIDs and file paths are short; longer strings are cut when decoded. */
const MAX_NAME = 2_001;
const NOT_RUN =
  "Its presence is a declaration; nothing is extracted or run, and this is not a safety verdict.";
const MEDIA_NOTE = "Audio and video are counted, not described.";

/** ExOleObjTypeEnum ([MS-PPT] 2.13.12). */
const OLE_LINK = 1;

interface Storage {
  readonly bytes: number;
  readonly sha256: string | null;
  readonly detail: string;
}

export interface Parts {
  /** The first child record of the wanted type. */
  readonly atom: PptRecord | undefined;
  /** The first CString of each instance, decoded up to the given length. */
  readonly strings: ReadonlyMap<number, string>;
}

const NO_STRINGS: ReadonlyMap<number, string> = new Map();

/** One pass over a container's children: its first atom of `type` and its CStrings by instance. With `max` 0 only the atom is wanted, so the walk stops there. */
export const readParts = async (
  stream: PptStream,
  container: PptRecord,
  options: { type: number; max: number; counters: ReaderCounters },
): Promise<Parts> => {
  let atom: PptRecord | undefined;
  let strings: Map<number, string> | undefined;
  const cursor = stream.cursor(container, at(container.offset));
  for (let record = cursor.next(); record !== null; record = cursor.next()) {
    if (stream.due) await stream.pause();
    if (record.type === options.type) {
      atom ??= record;
      if (options.max === 0) return { atom, strings: NO_STRINGS };
    } else if (
      options.max > 0 &&
      record.type === RT.cString &&
      strings?.has(record.instance) !== true
    )
      (strings ??= new Map()).set(
        record.instance,
        stream.utf16(record, options.max),
      );
  }
  cursor.report(options.counters);
  return { atom, strings: strings ?? NO_STRINGS };
};

export class ObjectReader {
  /** ExHyperlinkId to the offset of its ExHyperlinkContainer; the first container with an id wins. */
  readonly hyperlinks = new IdIndex();
  readonly #stream: PptStream;
  readonly #directory: PersistDirectory;
  readonly #args: LegacyReaderArgs;
  readonly #storages = new Map<number, Storage>();
  #hashed = 0;

  constructor(
    stream: PptStream,
    directory: PersistDirectory,
    args: LegacyReaderArgs,
  ) {
    this.#stream = stream;
    this.#directory = directory;
    this.#args = args;
  }

  /** ExObjListContainer ([MS-PPT] 2.10.1): every external object it lists. */
  async readObjectList(list: PptRecord): Promise<void> {
    const stream = this.#stream;
    const cursor = stream.cursor(list, at(list.offset));
    for (let record = cursor.next(); record !== null; record = cursor.next()) {
      if (stream.due) await stream.pause();
      switch (record.type) {
        case RT.externalHyperlink:
          await this.#hyperlink(record);
          break;
        case RT.externalOleEmbed:
        case RT.externalOleLink:
        case RT.externalOleControl:
          await this.#oleObject(record);
          break;
        case RT.externalAviMovie:
        case RT.externalMciMovie:
        case RT.externalWavAudioLink:
        case RT.externalMidiAudio:
          await this.#media(record);
          break;
        case RT.externalCdAudio:
        case RT.externalWavAudioEmbedded:
          this.#args.counters.omit("media", MEDIA_NOTE);
          break;
        default:
          break;
      }
    }
    cursor.report(this.#args.counters);
  }

  /** DocInfoListContainer: a VBAInfoContainer names the VBA project storage by persist id. */
  async readDocInfo(list: PptRecord): Promise<void> {
    const stream = this.#stream;
    const cursor = stream.cursor(list, at(list.offset));
    for (let info = cursor.next(); info !== null; info = cursor.next()) {
      if (stream.due) await stream.pause();
      if (info.type === RT.vbaInfo && info.version === 0xf)
        await this.#vba(info);
    }
    cursor.report(this.#args.counters);
  }

  async #vba(info: PptRecord): Promise<void> {
    const { atom } = await readParts(this.#stream, info, {
      type: RT.vbaInfoAtom,
      max: 0,
      counters: this.#args.counters,
    });
    const persistId = atom === undefined ? null : this.#stream.u32(atom, 0);
    if (atom === undefined || persistId === null) {
      this.#args.counters.diagnose(
        at(info.offset),
        "A VBAInfoContainer has no readable VBAInfoAtom.",
      );
      return;
    }
    const storage = await this.#storage(persistId, "VBA project");
    const empty = this.#stream.u32(atom, 4) === 0;
    this.#args.notable({
      kind: "macro-project",
      part: "PowerPoint Document (VBA project)",
      content_type: null,
      bytes: storage.bytes,
      sha256: storage.sha256,
      note: `A VBA project storage held in the PowerPoint Document stream${empty ? "; it declares that the storage holds no macros" : ""}. ${NOT_RUN} ${storage.detail}`,
    });
  }

  /** ExHyperlinkContainer (2.10.16): only its id is read now, from its first record when that is the atom. */
  async #hyperlink(container: PptRecord): Promise<void> {
    const first = this.#stream.recordAt(
      container.start,
      container.start + container.length,
    );
    const { atom } =
      first?.type === RT.externalHyperlinkAtom
        ? { atom: first }
        : await readParts(this.#stream, container, {
            type: RT.externalHyperlinkAtom,
            max: 0,
            counters: this.#args.counters,
          });
    const id = atom === undefined ? null : this.#stream.u32(atom, 0);
    if (id === null)
      this.#args.counters.diagnose(
        at(container.offset),
        "A hyperlink has no ExHyperlinkAtom, so no slide can refer to it.",
      );
    else this.hyperlinks.add(id, container.offset);
  }

  /** ExOleEmbed, ExOleLink and ExControl containers: an ExOleObjAtom names the storage; ProgID is CString 2. */
  async #oleObject(container: PptRecord): Promise<void> {
    const { atom, strings } = await readParts(this.#stream, container, {
      type: RT.externalOleObjectAtom,
      max: MAX_NAME,
      counters: this.#args.counters,
    });
    const control = container.type === RT.externalOleControl;
    const label = control ? "ActiveX control" : "OLE object";
    if (atom === undefined || atom.length < 20) {
      this.#args.counters.diagnose(
        at(container.offset),
        `An ${label} entry has no readable ExOleObjAtom.`,
      );
      return;
    }
    const id = this.#stream.u32(atom, 8) ?? 0;
    const linked =
      container.type === RT.externalOleLink ||
      this.#stream.u32(atom, 4) === OLE_LINK;
    const progId = strings.get(2) ?? "";
    const storage = await this.#storage(
      this.#stream.u32(atom, 16) ?? 0,
      `${label} ${String(id)}`,
    );
    this.#args.notable({
      kind: control ? "activex" : "ole-object",
      part: `PowerPoint Document (${label} ${String(id)})`,
      content_type: null,
      bytes: storage.bytes,
      sha256: storage.sha256,
      note: [
        control
          ? "An ActiveX control; its storage is not read."
          : linked
            ? "A linked OLE object; its link target is inside its storage and is not read."
            : "An embedded OLE object; its storage is not read.",
        progId === "" ? null : `Declared as ProgID ${progId}.`,
        NOT_RUN,
        storage.detail,
      ]
        .filter((part): part is string => part !== null)
        .join(" "),
    });
  }

  /** Linked movies and sounds name a file path (UncOrLocalPathAtom, CString 0); listed, never opened. */
  async #media(container: PptRecord): Promise<void> {
    this.#args.counters.omit("media", MEDIA_NOTE);
    const counters = this.#args.counters;
    const movie =
      container.type === RT.externalAviMovie ||
      container.type === RT.externalMciMovie;
    const video = movie
      ? (
          await readParts(this.#stream, container, {
            type: RT.externalVideo,
            max: 0,
            counters,
          })
        ).atom
      : container;
    if (video === undefined) return;
    const { atom, strings } = await readParts(this.#stream, video, {
      type: RT.externalMediaAtom,
      max: MAX_NAME,
      counters,
    });
    const path = strings.get(0) ?? "";
    if (path !== "")
      this.#args.external({
        source: "PowerPoint Document",
        kind: "linked-media",
        target: path,
        id: String(atom === undefined ? 0 : (this.#stream.u32(atom, 0) ?? 0)),
      });
  }

  /** Hash the ExOleObjStg / VbaProjectStg record a persist id names, decompressed when stored compressed. */
  async #storage(persistId: number, name: string): Promise<Storage> {
    const offset = this.#directory.get(persistId);
    if (offset === undefined)
      return {
        bytes: 0,
        sha256: null,
        detail: `Its storage (persist id ${String(persistId)}) is not in the persist directory, so it is not hashed.`,
      };
    const known = this.#storages.get(offset);
    if (known !== undefined) return known;
    const storage = await this.#hash(offset, name);
    this.#storages.set(offset, storage);
    return storage;
  }

  async #hash(offset: number, name: string): Promise<Storage> {
    const record = this.#stream.recordAt(offset);
    if (record?.type !== RT.externalOleObjectStg)
      return {
        bytes: 0,
        sha256: null,
        detail: `The persist directory points to offset ${String(offset)}, which holds no storage record; not hashed.`,
      };
    const compressed = record.instance === 1;
    const declared = compressed ? (this.#stream.u32(record, 0) ?? 0) : 0;
    const bytes = compressed ? declared : record.length;
    if (!compressed && record.instance !== 0)
      return {
        bytes,
        sha256: null,
        detail: `Its storage record has form ${String(record.instance)}, which the format does not define; not hashed.`,
      };
    if (this.#hashed >= MAX_HASHED)
      return {
        bytes,
        sha256: null,
        detail: `Not hashed: more than ${String(MAX_HASHED)} items.`,
      };
    this.#hashed += 1;
    if (!compressed)
      return {
        bytes,
        sha256: sha256(
          this.#stream.bytes.subarray(
            record.start,
            record.start + record.length,
          ),
        ),
        detail: "SHA-256 is of its stored storage bytes.",
      };
    return await this.#inflate(record, declared, name);
  }

  /** Inflate a compressed storage, charged to the budget first and never past its declared size. */
  async #inflate(
    record: PptRecord,
    declared: number,
    name: string,
  ): Promise<Storage> {
    const failed = (reason: string): Storage => ({
      bytes: declared,
      sha256: null,
      detail: `Not hashed: ${reason}`,
    });
    if (declared > MAX_INFLATED)
      return failed(
        `it declares ${String(declared)} bytes after decompression, over the ${String(MAX_INFLATED)}-byte limit.`,
      );
    try {
      this.#args.streams.claim(declared, `PowerPoint Document (${name})`);
    } catch (cause) {
      if (cause instanceof MemberReadFailure && cause.reason === "cancelled")
        throw cause;
      const message = cause instanceof Error ? cause.message : String(cause);
      this.#args.counters.diagnose(at(record.offset), message);
      return failed(message);
    }
    await this.#stream.pause();
    let inflated: Uint8Array;
    try {
      inflated = await inflateAsync(
        this.#stream.bytes.subarray(
          record.start + 4,
          record.start + record.length,
        ),
        { maxOutputLength: Math.max(1, declared) },
      );
    } catch (cause) {
      return failed(
        `it does not inflate within its declared ${String(declared)} bytes (${cause instanceof Error ? cause.message : String(cause)}).`,
      );
    }
    this.#args.signal?.throwIfAborted();
    return {
      bytes: inflated.length,
      sha256: sha256(inflated),
      detail:
        inflated.length === declared
          ? "SHA-256 is of the decompressed storage."
          : `SHA-256 is of the decompressed storage, which is ${String(inflated.length)} bytes where ${String(declared)} were declared.`,
    };
  }
}

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
