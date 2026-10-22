import type { ReaderCounters } from "../reader.js";
import { LegacyEncryptedError, LegacyFormatError } from "./legacy.js";
import {
  OffsetList,
  PersistDirectory,
  RT,
  type PptRecord,
  type PptStream,
} from "./pptRecords.js";

/**
 * The edit history of a PowerPoint 97-2003 file ([MS-PPT] 2.1.1, 2.3): the
 * Current User stream names the newest UserEditAtom; each edit points to the
 * previous one and to its PersistDirectoryAtom, which maps persist object ids
 * to offsets in the PowerPoint Document stream. The newest edit's entry wins
 * for each id; older versions of a slide are never read. When the chain cannot
 * be followed the stream is scanned record by record instead.
 */

/** Real files are saved incrementally a few dozen times at most. */
const MAX_EDITS = 10_000;
export const MAX_CURRENT_USER = 64 * 1024;
/** CurrentUserAtom.headerToken ([MS-PPT] 2.3.2): 0xF3D1C4DF marks an encrypted file. */
const TOKEN_PLAIN = 0xe391c05f;
const TOKEN_ENCRYPTED = 0xf3d1c4df;
/** CurrentUserAtom.docFileVersion: PowerPoint 97-2003 writes 0x03F4. */
const DOC_FILE_VERSION = 0x03f4;

const ENCRYPTED =
  "The presentation is password-protected (RC4 CryptoAPI encryption of the PowerPoint Document stream). No password is tried and nothing is decrypted.";
const OLD_FORMAT =
  "is a PowerPoint 4.0/95 binary file (or older); only PowerPoint 97-2003 files are read.";

export interface PptLayout {
  /** Persist object id to stream offset, newest edit first. */
  readonly directory: PersistDirectory;
  /** The DocumentContainer, or null when only a flat scan found slides. */
  readonly document: PptRecord | null;
  readonly edits: number;
  /** Set when there is no usable document: offsets of the slide and notes containers in stream order. */
  readonly scanned: {
    readonly slides: OffsetList;
    readonly notes: OffsetList;
  } | null;
}

/** offsetToCurrentEdit from the Current User stream; throws for an encrypted or pre-97 file. */
const currentEdit = (
  bytes: Uint8Array,
  counters: ReaderCounters,
): number | string => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const atom =
    bytes.length >= 4 && view.getUint16(2, true) === RT.currentUserAtom;
  // PowerPoint 95 writes a 4-byte size followed by that many bytes, not a CurrentUserAtom.
  if (
    !atom &&
    bytes.length >= 4 &&
    view.getUint32(0, true) + 4 === bytes.length
  )
    throw new LegacyFormatError(
      `The Current User stream is size-prefixed, not a CurrentUserAtom: the file ${OLD_FORMAT}`,
    );
  if (!atom)
    return "The Current User stream does not start with a CurrentUserAtom.";
  if (bytes.length < 24) return "The Current User stream is too short.";
  const token = view.getUint32(12, true);
  if (token === TOKEN_ENCRYPTED) throw new LegacyEncryptedError(ENCRYPTED);
  if (token !== TOKEN_PLAIN)
    counters.diagnose(
      "Current User",
      `The CurrentUserAtom header token is 0x${token.toString(16)}, not one the format defines; the file is read as unencrypted.`,
    );
  const version = view.getUint16(22, true);
  if (version !== DOC_FILE_VERSION)
    throw new LegacyFormatError(
      `The Current User stream names document file version 0x${version.toString(16)}, not 0x3f4: the file ${OLD_FORMAT}`,
    );
  return view.getUint32(16, true);
};

/** Add one PersistDirectoryAtom's entries; ids already set by a newer edit are kept unless `overwrite`. */
const addDirectory = async (
  stream: PptStream,
  record: PptRecord,
  directory: PersistDirectory,
  overwrite: boolean,
): Promise<string | null> => {
  let offset = 0;
  while (offset + 4 <= record.length) {
    if (stream.due) await stream.pause();
    stream.tick();
    const entry = stream.u32(record, offset) ?? 0;
    const first = entry & 0xfffff;
    const count = entry >>> 20;
    if (offset + 4 + count * 4 > record.length)
      return `A persist directory entry at offset ${String(record.start + offset)} lists ${String(count)} offsets, past the end of its record.`;
    stream.tick(count);
    for (let index = 0; index < count; index += 1)
      if (overwrite || !directory.has(first + index))
        directory.set(
          first + index,
          stream.u32(record, offset + 4 + index * 4) ?? 0,
        );
    offset += 4 + count * 4;
  }
  return null;
};

/** The UserEditAtom at `offset`; throws when it names an encryption session. */
const userEdit = (stream: PptStream, offset: number): PptRecord | null => {
  const record = stream.recordAt(offset);
  if (record?.type !== RT.userEditAtom || record.length < 0x1c) return null;
  const session = stream.u32(record, 0x1c);
  if (session !== null && session !== 0)
    throw new LegacyEncryptedError(ENCRYPTED);
  return record;
};

interface Chain {
  readonly directory: PersistDirectory;
  readonly edits: number;
  readonly documentRef: number;
}

/** Follow offsetLastEdit from the newest edit; offsets must fall strictly, so the chain ends. */
const followChain = async (
  stream: PptStream,
  start: number,
  counters: ReaderCounters,
): Promise<Chain | string> => {
  const directory = new PersistDirectory();
  const directories = new Set<number>();
  let directoryBytes = 0;
  let offset = start;
  let edits = 0;
  let documentRef = 1;
  while (edits < MAX_EDITS) {
    const record = userEdit(stream, offset);
    if (record === null)
      return edits === 0
        ? `The newest edit offset ${String(offset)} does not hold a UserEditAtom.`
        : `Edit ${String(edits + 1)} at offset ${String(offset)} is not a UserEditAtom; older edits are not read.`;
    edits += 1;
    // UserEditAtom: offsetLastEdit at 8, offsetPersistDirectory at 12, docPersistIdRef at 16.
    if (edits === 1) documentRef = stream.u32(record, 16) ?? 1;
    const last = stream.u32(record, 8) ?? 0;
    const persist = stream.u32(record, 12) ?? 0;
    const atom = stream.recordAt(persist);
    if (atom?.type !== RT.persistDirectoryAtom)
      counters.diagnose(
        "PowerPoint Document",
        `Edit ${String(edits)} points to offset ${String(persist)} for its persist directory, which holds no PersistDirectoryAtom.`,
      );
    else if (directories.has(persist))
      counters.diagnose(
        "PowerPoint Document",
        `Edit ${String(edits)} reuses the persist directory at offset ${String(persist)}; it is read once.`,
      );
    else {
      directories.add(persist);
      // Real directories are disjoint, so together they are never larger than the stream.
      directoryBytes += atom.length;
      if (directoryBytes > stream.bytes.length)
        return "The persist directories overlap; the chain is not followed further.";
      const problem = await addDirectory(stream, atom, directory, false);
      if (problem !== null) counters.diagnose("PowerPoint Document", problem);
    }
    if (last === 0) return { directory, edits, documentRef };
    if (last >= offset)
      return `Edit ${String(edits)} points forward to offset ${String(last)} for the previous edit; the chain is not followed.`;
    offset = last;
  }
  return `The edit chain is longer than ${String(MAX_EDITS)} edits.`;
};

const documentAt = (
  stream: PptStream,
  offset: number | undefined,
): PptRecord | null => {
  const record = offset === undefined ? null : stream.recordAt(offset);
  return record?.type === RT.document && record.version === 0xf ? record : null;
};

/** Read the whole stream as a flat list of top-level records: directories, edits, documents, slides, notes. */
const scan = async (
  stream: PptStream,
  counters: ReaderCounters,
): Promise<PptLayout> => {
  const directory = new PersistDirectory();
  const slides = new OffsetList();
  const notes = new OffsetList();
  let edits = 0;
  let lastDocument: PptRecord | null = null;
  const cursor = stream.cursor({ start: 0, length: stream.bytes.length });
  for (let record = cursor.next(); record !== null; record = cursor.next()) {
    if (stream.due) await stream.pause();
    const container = record.version === 0xf;
    if (record.type === RT.userEditAtom) {
      edits += 1;
      userEdit(stream, record.offset);
    } else if (record.type === RT.persistDirectoryAtom) {
      // Incremental saves append, so a later directory is a newer edit.
      const failed = await addDirectory(stream, record, directory, true);
      if (failed !== null) counters.diagnose("PowerPoint Document", failed);
    } else if (record.type === RT.document && container) lastDocument = record;
    else if (record.type === RT.slide && container) slides.push(record.offset);
    else if (record.type === RT.notes && container) notes.push(record.offset);
  }
  if (cursor.problem !== null)
    counters.diagnose(
      "PowerPoint Document",
      `The record scan stopped: ${cursor.problem}`,
    );
  const document = documentAt(stream, directory.get(1)) ?? lastDocument;
  if (document !== null) {
    counters.diagnose(
      "PowerPoint Document",
      "The persist directory was rebuilt from the directory records found by scanning the stream (later records win).",
    );
    return { directory, document, edits, scanned: null };
  }
  if (slides.length === 0 && notes.length === 0)
    throw new LegacyFormatError(
      "The PowerPoint Document stream holds no document, slide or notes record that can be read.",
    );
  counters.diagnose(
    "PowerPoint Document",
    "No document record was found, so slides are listed in stream order: older saved versions of a slide may appear, notes are not linked to slides and outline text is not available.",
  );
  return { directory, document: null, edits, scanned: { slides, notes } };
};

/** The persist directory and document of the newest edit, or a flat scan when the history is unreadable. */
export const readLayout = async (
  stream: PptStream,
  currentUser: Uint8Array | string,
  counters: ReaderCounters,
): Promise<PptLayout> => {
  const offset =
    typeof currentUser === "string"
      ? currentUser
      : currentUser.length > MAX_CURRENT_USER
        ? "The Current User stream is larger than a CurrentUserAtom can be."
        : currentEdit(currentUser, counters);
  if (stream.bytes.length < 8)
    throw new LegacyFormatError(
      "The PowerPoint Document stream is too short to hold a record.",
    );
  const chain =
    typeof offset === "string"
      ? offset
      : await followChain(stream, offset, counters);
  if (typeof chain !== "string") {
    const document = documentAt(stream, chain.directory.get(chain.documentRef));
    if (document !== null)
      return {
        directory: chain.directory,
        document,
        edits: chain.edits,
        scanned: null,
      };
    counters.diagnose(
      "PowerPoint Document",
      `The persist directory does not lead to a document record (persist id ${String(chain.documentRef)}); the stream is scanned instead.`,
    );
  } else
    counters.diagnose(
      "PowerPoint Document",
      `The edit history cannot be followed: ${chain} The stream is scanned instead.`,
    );
  return await scan(stream, counters);
};
