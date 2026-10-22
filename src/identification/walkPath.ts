import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { basename, dirname } from "node:path";

import type { ArtifactEntry } from "../artifacts/ArtifactReader.js";
import { DirectoryArtifactReader } from "../artifacts/DirectoryArtifactReader.js";
import { formatEntry } from "../domain/formatRegistry.js";
import {
  DEFAULT_FILE_DEPTH,
  DEFAULT_FOLDER_DEPTH,
  type IdentificationWalk,
  type IdentifyArtifactInput,
} from "../domain/identification/identification.js";
import { examineHandle, type ExaminedBytes } from "./bytes.js";
import { EntryLimit, message, type Piece } from "./pieces.js";
import { Walk, type WalkOptions } from "./walk.js";

/** What a root walk adds to the shared walk state. */
type RootFacts = Pick<
  IdentificationWalk,
  "kind" | "path" | "bytes" | "sha256" | "detection"
>;

const withHandle = async <T>(
  path: string,
  inspect: (handle: Awaited<ReturnType<typeof open>>) => Promise<T>,
): Promise<T> => {
  const handle = await open(path, "r");
  try {
    return await inspect(handle);
  } finally {
    await handle.close();
  }
};

const walkFile = async (walk: Walk, path: string): Promise<RootFacts> => {
  const classified = await walk.classifyRoot(path);
  if (classified.sha256 === null)
    throw new Error(`No content digest was produced for ${path}.`);
  const examined = await withHandle(path, examineHandle);
  const root = walk.add({
    parent: null,
    depth: 0,
    path: "",
    name: basename(path),
    kind: "file",
    bytes: examined.size,
    onDisk: path,
  });
  const { choice, detection } = walk.detection(root, examined);
  const route = walk.chooseReader(root, choice);
  if (route !== undefined) walk.defer(root, route, path);
  const plan = walk.containerPlan(choice);
  const wantOpen = plan.openable && walk.depth > 0;
  walk.describeContainer(root, plan, wantOpen);
  try {
    if (wantOpen) await walk.openContainer(root, path, classified.format, 1);
  } catch (cause: unknown) {
    if (!(cause instanceof EntryLimit)) throw cause;
  }
  await walk.runDeferred();
  return {
    kind: "file",
    path,
    bytes: examined.size,
    sha256: classified.sha256,
    detection,
  };
};

/** Detect one regular file in a folder, queue its reader, and open it when asked. */
const folderFile = async (
  walk: Walk,
  reader: DirectoryArtifactReader,
  entry: ArtifactEntry,
  piece: Piece,
): Promise<void> => {
  let examined: ExaminedBytes;
  try {
    examined = await reader.inspectFile(entry, examineHandle, walk.signal);
  } catch (cause: unknown) {
    if (walk.signal?.aborted === true) throw cause;
    walk.unreadable(piece, `Not read: ${message(cause)}`);
    return;
  }
  const choice = walk.detect(piece, examined);
  const route = walk.chooseReader(piece, choice);
  if (route !== undefined) walk.defer(piece, route, entry.adapterKey);
  const plan = walk.containerPlan(choice);
  const wantOpen = plan.openable && walk.depth > 0;
  walk.describeContainer(piece, plan, wantOpen);
  if (wantOpen) await walk.openFile(piece, entry.adapterKey, 1);
};

/** The folder itself: a directory by the host's word, read by the app-folder reader. */
const folderRoot = (walk: Walk, canonical: string): Piece => {
  const root = walk.add({
    parent: null,
    depth: 0,
    path: "",
    name: basename(canonical) || canonical,
    kind: "directory",
    bytes: null,
    onDisk: canonical,
  });
  root.format = "directory";
  root.format_basis = "filesystem";
  root.label = formatEntry("directory").label;
  root.candidates = ["directory"];
  const route = walk.chooseReader(root, {
    format: "directory",
    basis: null,
    candidates: ["directory"],
    nameConflict: null,
    fallback: null,
  });
  if (route !== undefined) walk.defer(root, route, canonical);
  return root;
};

const walkFolder = async (walk: Walk, path: string): Promise<RootFacts> => {
  const reader = new DirectoryArtifactReader(path);
  const canonical = (await reader.rootObservation()).canonicalPath;
  const root = folderRoot(walk, canonical);
  const folders = new Map<string, Piece>([["", root]]);
  try {
    for await (const entry of reader.entries(walk.signal, {
      onOmission: (omission) => {
        walk.omitted(null, omission.path, omission.kind);
      },
      onUnreadable: (entry, cause) => {
        walk.counters.unreadable += 1;
        walk.diagnose(null, `${entry}: not readable (${message(cause)}).`);
      },
    })) {
      walk.examine();
      const parentPath = dirname(entry.path) === "." ? "" : dirname(entry.path);
      const kind =
        entry.kind === "directory"
          ? "directory"
          : entry.kind === "symlink"
            ? "symlink"
            : "file";
      const piece = walk.add({
        parent: folders.get(parentPath) ?? root,
        depth: 0,
        path: entry.path,
        name: basename(entry.path),
        kind,
        bytes: entry.declaredSize,
        onDisk: entry.adapterKey,
      });
      if (kind === "directory") {
        folders.set(entry.path, piece);
        continue;
      }
      if (kind === "symlink") {
        walk.counters.symlinks += 1;
        continue;
      }
      await folderFile(walk, reader, entry, piece);
    }
  } catch (cause: unknown) {
    if (walk.signal?.aborted === true) throw cause;
    // Keep what was walked: a folder that changes or fails midway still has an answer.
    if (!(cause instanceof EntryLimit)) {
      const reason = `The folder walk stopped early: ${message(cause)}`;
      walk.diagnose(null, reason);
      walk.limitations.add(reason);
    }
  } finally {
    await reader.close().catch((cause: unknown) => {
      walk.diagnose(
        null,
        `Closing the folder reader failed: ${message(cause)}`,
      );
    });
  }
  await walk.runDeferred();
  const listing = walk.pieces
    .filter((piece) => piece.depth === 0 && piece.id !== root.id)
    .map(
      (piece) => `${piece.kind}\t${String(piece.bytes ?? "")}\t${piece.path}\n`,
    )
    .sort();
  const digest = createHash("sha256");
  for (const line of listing) digest.update(line);
  return {
    kind: "directory",
    path: canonical,
    bytes: walk.pieces.reduce(
      (total, piece) =>
        piece.depth === 0 && piece.kind === "file"
          ? total + (piece.bytes ?? 0)
          : total,
      0,
    ),
    sha256: digest.digest("hex"),
    detection: null,
  };
};

/** Walk one file or folder; the caller has already made `path` canonical. */
export const walkPath = async (
  input: IdentifyArtifactInput,
  path: string,
  directory: boolean,
  options: WalkOptions,
): Promise<IdentificationWalk> => {
  const depth =
    input.depth ?? (directory ? DEFAULT_FOLDER_DEPTH : DEFAULT_FILE_DEPTH);
  const walk = new Walk(input, depth, {
    ...options,
    archive: options.archive ?? {
      externalDecoders: "allow",
      maximumDecodedBytes: input.max_decoded_bytes,
    },
  });
  let left: string | null = null;
  let root: RootFacts;
  try {
    root = directory
      ? await walkFolder(walk, path)
      : await walkFile(walk, path);
  } finally {
    left = await walk.close();
  }
  if (left !== null)
    walk.limitations.add(
      `The private scratch directory ${left} could not be removed; delete it by hand.`,
    );
  return {
    ...root,
    pieces: walk.pieces,
    depth,
    counters: walk.counters,
    diagnostics: walk.diagnostics,
    limitations: [...walk.limitations],
  };
};
