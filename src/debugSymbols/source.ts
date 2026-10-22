import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { join, sep } from "node:path";

import { readStableArtifact } from "../artifacts/readStableArtifact.js";
import { stableReadFailure } from "../artifacts/stableReadFailure.js";
import { readFatContainerHeader } from "../domain/apple/machoContainer.js";
import { AnalysisUnsupportedTargetError } from "../domain/analysisErrorCore.js";
import { ArtifactOperationError } from "../domain/artifactOperationError.js";
import { DebugFormatError } from "./byteReader.js";
import { isElf, readElf } from "./elf.js";
import type { DebugImage } from "./image.js";
import { hasThinMachoMagic, readMacho } from "./macho.js";

export const OPERATION = "inspect_debug_symbols";

/** Most DWARF files one .dSYM bundle may hold. */
const MAX_BUNDLE_FILES = 64;
const BUNDLE_DWARF_DIRECTORY = join("Contents", "Resources", "DWARF");
const PDB_MAGIC = "Microsoft C/C++ MSF 7.00\r\n\u001aDS";

export interface SymbolFile {
  /** The DWARF file name inside a .dSYM bundle, or null for a plain file. */
  readonly member: string | null;
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly images: readonly DebugImage[];
}

export interface SkippedMember {
  readonly member: string;
  readonly reason: string;
}

export interface OpenedSymbols {
  readonly artifact: {
    readonly path: string;
    readonly kind: "file" | "directory";
    readonly sha256: string;
    readonly sha256_of: "content" | "dwarf-files";
    readonly bytes: number;
  };
  readonly files: readonly SymbolFile[];
  /** Bundle members that were not DWARF files and were left out. */
  readonly skipped: readonly SkippedMember[];
}

const unsupported = (path: string, message: string) =>
  new AnalysisUnsupportedTargetError(OPERATION, path, message);

const looksLikeMacho = (bytes: Uint8Array): boolean =>
  hasThinMachoMagic(bytes) ||
  readFatContainerHeader(bytes, bytes.length).state === "parsed";

/** Decode a file into its ELF image or Mach-O slices; anything else is unsupported. */
export const parseImages = (
  path: string,
  bytes: Uint8Array,
): readonly DebugImage[] => {
  try {
    if (isElf(bytes)) return [readElf(bytes)];
    if (looksLikeMacho(bytes)) return readMacho(bytes);
  } catch (cause) {
    if (cause instanceof DebugFormatError)
      throw new ArtifactOperationError(
        OPERATION,
        "format",
        undefined,
        `The file could not be read as a debug image: ${cause.message}`,
        { cause },
      );
    throw cause;
  }
  if (
    Buffer.from(bytes.subarray(0, PDB_MAGIC.length)).toString("latin1") ===
    PDB_MAGIC
  )
    throw unsupported(
      path,
      "This is a PDB (Microsoft MSF 7.0) file. PDB files are not read yet; only ELF and Mach-O files carrying DWARF are.",
    );
  throw unsupported(
    path,
    "The file is neither an ELF file nor a Mach-O file (thin or universal).",
  );
};

const readFile = async (
  path: string,
  maxFileBytes: number,
  signal: AbortSignal | undefined,
) => {
  try {
    return await readStableArtifact(path, maxFileBytes, signal);
  } catch (cause) {
    throw stableReadFailure(OPERATION, path, cause, {
      cancelled: signal?.aborted === true,
      maxFileBytes,
      remediationAction:
        "Raise max_file_bytes (up to 1 GiB) or select a smaller file.",
    });
  }
};

/** Read one file the caller selected, as the debug file or as the binary to pair. */
export const openFile = async (
  path: string,
  maxFileBytes: number,
  signal: AbortSignal | undefined,
): Promise<SymbolFile & { readonly size: number }> => {
  const snapshot = await readFile(path, maxFileBytes, signal);
  return {
    member: null,
    path,
    bytes: snapshot.bytes,
    sha256: snapshot.sha256,
    images: parseImages(path, snapshot.bytes),
    size: snapshot.bytes.length,
  };
};

/** Open a debug file or a .dSYM bundle: nothing is followed through a symbolic link. */
export const openSymbols = async (
  path: string,
  maxFileBytes: number,
  signal: AbortSignal | undefined,
): Promise<OpenedSymbols> => {
  let stats;
  try {
    stats = await lstat(path);
  } catch (cause) {
    throw new ArtifactOperationError(
      OPERATION,
      "path",
      undefined,
      `The path could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
  if (!stats.isDirectory()) {
    const file = await openFile(path, maxFileBytes, signal);
    return {
      artifact: {
        path,
        kind: "file",
        sha256: file.sha256,
        sha256_of: "content",
        bytes: file.size,
      },
      files: [file],
      skipped: [],
    };
  }
  // Every folder on the way to the DWARF files must be a real folder: a link is not followed.
  let walked = path;
  for (const part of BUNDLE_DWARF_DIRECTORY.split(sep)) {
    walked = join(walked, part);
    let entry;
    try {
      entry = await lstat(walked);
    } catch {
      throw unsupported(
        path,
        `The directory is not a .dSYM bundle: it has no ${BUNDLE_DWARF_DIRECTORY} folder.`,
      );
    }
    if (entry.isSymbolicLink() || !entry.isDirectory())
      throw unsupported(
        path,
        `${part} in the .dSYM bundle is a link or not a folder; links are not followed.`,
      );
  }
  const directory = walked;
  const entries = await readdir(directory, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  if (names.length === 0)
    throw unsupported(path, "The .dSYM bundle holds no DWARF file.");
  if (names.length > MAX_BUNDLE_FILES)
    throw unsupported(
      path,
      `The .dSYM bundle holds ${names.length} DWARF files; at most ${MAX_BUNDLE_FILES} are read.`,
    );
  const files: SymbolFile[] = [];
  const skipped: SkippedMember[] = [];
  let total = 0;
  const digest = createHash("sha256");
  for (const name of names) {
    // Copies made by Finder, SMB or zip leave AppleDouble and .DS_Store files here.
    if (name.startsWith(".")) {
      skipped.push({
        member: name,
        reason: "a hidden file is not a DWARF file",
      });
      continue;
    }
    // One byte budget covers the whole bundle, not each file.
    let file;
    try {
      file = await openFile(
        join(directory, name),
        Math.max(1, maxFileBytes - total),
        signal,
      );
    } catch (cause) {
      if (
        cause instanceof AnalysisUnsupportedTargetError ||
        (cause instanceof ArtifactOperationError && cause.reason === "format")
      ) {
        skipped.push({ member: name, reason: cause.message });
        continue;
      }
      throw cause;
    }
    files.push({ ...file, member: name });
    total += file.size;
    digest.update(`${file.sha256}  ${name}\n`);
  }
  if (files.length === 0)
    throw unsupported(
      path,
      `The .dSYM bundle holds no readable DWARF file (${skipped.map((item) => `${item.member}: ${item.reason}`).join("; ")}).`,
    );
  return {
    artifact: {
      path,
      kind: "directory",
      sha256: digest.digest("hex"),
      sha256_of: "dwarf-files",
      bytes: total,
    },
    files,
    skipped,
  };
};
