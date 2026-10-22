import { constants } from "node:fs";
import { mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";

import type { StreamHead } from "./bytes.js";

/** Longest file name most hosts accept, in UTF-8 bytes. */
const MAX_NAME_BYTES = 255;

/** Characters Windows refuses in a name, and its reserved device names. */
const UNSAFE_CHARACTERS = '<>:"|?*\\';
const DEVICE_NAME = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/iu;

const safeCharacter = (character: string): string =>
  character.charCodeAt(0) < 0x20 || UNSAFE_CHARACTERS.includes(character)
    ? "_"
    : character;

/** Keep the member's name (readers and detection use its suffix) inside one safe segment. */
const spoolName = (name: string): string => {
  const plain = [...basename(name)]
    .map(safeCharacter)
    .join("")
    .replace(/[. ]+$/u, "");
  const named =
    plain === "" || plain === "." || plain === ".." ? "member" : plain;
  const safe = DEVICE_NAME.test(named) ? `_${named}` : named;
  if (Buffer.byteLength(safe) <= MAX_NAME_BYTES) return safe;
  const suffix = extname(safe).slice(0, 32);
  let stem = safe.slice(0, safe.length - suffix.length);
  while (Buffer.byteLength(stem + suffix) > MAX_NAME_BYTES)
    stem = stem.slice(0, -1);
  return stem + suffix;
};

/** One copy outcome: the bytes now on disk, or the budget it would exceed. */
export type SpoolCopy =
  | { readonly kind: "copied"; readonly path: string; readonly bytes: number }
  | { readonly kind: "over-budget"; readonly needed: number | null };

/**
 * Private scratch for container members that must be files to be read: a
 * mode-0700 directory created on first use, one subdirectory per piece, and a
 * cumulative byte budget. `close` removes everything it created.
 */
export class IdentificationSpool {
  readonly #limit: number;
  readonly #parent: string;
  #root: string | undefined;
  #copied = 0;
  #limitReached = false;

  constructor(limit: number, parent: string = tmpdir()) {
    this.#limit = limit;
    this.#parent = parent;
  }

  get copiedBytes(): number {
    return this.#copied;
  }

  get limitReached(): boolean {
    return this.#limitReached;
  }

  /** Whether `bytes` more (when known) still fit the budget. */
  fits(bytes: number | null): boolean {
    return bytes === null
      ? this.#copied < this.#limit
      : this.#copied + bytes <= this.#limit;
  }

  /** Copy already-read leading chunks plus the rest of a member, within budget. */
  async copy(
    piece: string,
    name: string,
    member: Pick<StreamHead, "chunks" | "rest">,
    signal?: AbortSignal,
  ): Promise<SpoolCopy> {
    const { chunks: head, rest } = member;
    this.#root ??= await mkdtemp(join(this.#parent, "oopsware-identify-"));
    const directory = join(this.#root, piece);
    await mkdir(directory, { mode: 0o700 });
    const path = join(directory, spoolName(name));
    const file = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    let bytes = 0;
    let complete = false;
    try {
      const write = async (chunk: Buffer): Promise<boolean> => {
        if (this.#copied + chunk.length > this.#limit) return false;
        await file.write(chunk);
        this.#copied += chunk.length;
        bytes += chunk.length;
        return true;
      };
      for (const chunk of head) if (!(await write(chunk))) return this.#over();
      for (;;) {
        signal?.throwIfAborted();
        const next = await rest.next();
        if (next.done === true) break;
        if (!(await write(next.value))) return this.#over();
      }
      complete = true;
    } finally {
      await file.close();
      if (!complete) await rm(directory, { recursive: true, force: true });
    }
    return { kind: "copied", path, bytes };
  }

  /** Remove one copy as soon as nothing reads it, so the disk is not held. */
  async discard(path: string): Promise<void> {
    await rm(join(path, ".."), { recursive: true, force: true });
  }

  /** Remove the whole scratch directory; returns its path when removal failed. */
  async close(): Promise<string | null> {
    const root = this.#root;
    this.#root = undefined;
    if (root === undefined) return null;
    try {
      await rm(root, { recursive: true, force: true, maxRetries: 2 });
      return null;
    } catch {
      return root;
    }
  }

  #over(): SpoolCopy {
    this.#limitReached = true;
    return { kind: "over-budget", needed: null };
  }
}
