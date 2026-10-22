import { decompressorFor } from "./compression.js";
import { FileData } from "./data.js";
import { DirectoryWalker } from "./directory.js";
import {
  hex,
  ImageSource,
  SquashfsFormatError,
  SquashfsUnsupportedError,
  type SquashfsRead,
  u32,
} from "./format.js";
import {
  type DirectoryInode,
  type Inode,
  INODE_KINDS,
  type InodeReference,
  readInode,
  type TableRange,
} from "./inode.js";
import { type LookupTable, MetadataReader } from "./metadata.js";
import { readImageTables } from "./tables.js";
import {
  parseSquashfsSuperblock,
  SUPERBLOCK_BYTES,
  SUPERBLOCK_FLAGS,
  type SquashfsSuperblock,
} from "./superblock.js";

export { SquashfsFormatError, SquashfsUnsupportedError, type SquashfsRead };
export { parseSquashfsSuperblock, SUPERBLOCK_BYTES, type SquashfsSuperblock };
export type { SquashfsCompression } from "./superblock.js";

/**
 * SquashFS 4.0 images read in process from positional reads, as the Linux
 * kernel and squashfs-tools lay them out. gzip (zlib), lz4 and zstd blocks
 * are decoded here; nothing is mounted, extracted or run.
 */

export interface SquashfsEntry {
  /** Relative, "/"-joined, no leading "/"; the root itself is not listed. */
  readonly path: string;
  readonly type:
    | "file"
    | "directory"
    | "symlink"
    | "block-device"
    | "char-device"
    | "fifo"
    | "socket";
  /** Permission bits plus setuid, setgid and sticky (mode & 07777). */
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly mtime: number;
  /** File bytes; the symlink target's length; 0 otherwise. */
  readonly size: number;
  readonly link_target: string | null;
  readonly inode_number: number;
  readonly hard_links: number;
  readonly device: { readonly major: number; readonly minor: number } | null;
  /** How many xattrs the inode has; names and values are not decoded. */
  readonly xattrs: number;
}

export interface SquashfsProblem {
  readonly offset: number | null;
  readonly message: string;
}

/** Entries one listing may produce, hard links included. */
const MAXIMUM_ENTRIES = 1 << 24;
/** Directory nesting below the root. */
const MAXIMUM_DEPTH = 256;
/** LZ4_LEGACY, the only LZ4 options version the kernel accepts. */
const LZ4_LEGACY = 1;

const utf8 = new TextDecoder("utf-8", { fatal: true });
const lenientUtf8 = new TextDecoder("utf-8");

/** Why a stored name cannot become a path step, or the decoded name. */
const usableName = (
  bytes: Uint8Array,
): string | { readonly reason: string } => {
  let name: string;
  try {
    name = utf8.decode(bytes);
  } catch {
    return { reason: "is not valid UTF-8" };
  }
  if (name === "" || name === "." || name === "..")
    return { reason: `is "${name}"` };
  if (name.includes("/")) return { reason: 'contains "/"' };
  if (name.includes("\0")) return { reason: "contains NUL" };
  return name;
};

const referenceKey = (reference: InodeReference): number =>
  reference.block * 0x1_0000 + reference.offset;

interface ImageParts {
  readonly superblock: SquashfsSuperblock;
  readonly metadata: MetadataReader;
  readonly root: InodeReference;
  readonly inodes: TableRange;
  readonly directories: TableRange;
  readonly ids: Uint32Array;
  readonly xattrs: (LookupTable & { readonly count: number }) | null;
  readonly data: FileData;
}

interface Frame {
  readonly walker: DirectoryWalker;
  readonly path: string;
  readonly key: number;
}

/** One SquashFS 4.0 image; `problems` grows as `entries` meets entries it omits. */
export class SquashfsImage {
  readonly superblock: SquashfsSuperblock;
  readonly #parts: ImageParts;
  readonly #problems: SquashfsProblem[] = [];
  readonly #references = new WeakMap<SquashfsEntry, InodeReference>();

  private constructor(parts: ImageParts) {
    this.superblock = parts.superblock;
    this.#parts = parts;
  }

  get problems(): readonly SquashfsProblem[] {
    return this.#problems;
  }

  /**
   * Check the superblock (magic "hsqs", version 4.0 only) and that every
   * table lies inside `size`; read the id table. lzma, lzo, xz and unknown
   * compressors are SquashfsUnsupportedError naming the compressor.
   */
  static async open(read: SquashfsRead, size: number): Promise<SquashfsImage> {
    if (!Number.isSafeInteger(size) || size < 0)
      throw new RangeError(`Image size ${String(size)} is not a byte count.`);
    const parsed = parseSquashfsSuperblock(
      await read(0, Math.min(size, SUPERBLOCK_BYTES)),
      size,
    );
    const { superblock } = parsed;
    const { tables } = superblock;
    const decompress = decompressorFor(superblock.compression);
    const source = new ImageSource(read, superblock.bytes_used);
    const metadata = new MetadataReader(source, decompress);
    if ((parsed.flagBits & SUPERBLOCK_FLAGS["compressor-options"]) !== 0) {
      // The options block follows the superblock; only LZ4's version changes how blocks decode.
      const options = await metadata.block(
        SUPERBLOCK_BYTES,
        tables.inode,
        "compressor options",
      );
      if (
        superblock.compression === "lz4" &&
        u32(options.data, 0) !== LZ4_LEGACY
      )
        throw new SquashfsUnsupportedError(
          "compression lz4",
          `LZ4 options version ${String(u32(options.data, 0))} is not the legacy format the kernel reads.`,
        );
    }
    const found = await readImageTables(source, metadata, superblock);
    const inodes = { start: tables.inode, end: tables.directory };
    return new SquashfsImage({
      superblock,
      metadata,
      root: parsed.rootInode,
      inodes,
      directories: { start: tables.directory, end: found.directoryEnd },
      ids: found.ids,
      xattrs: found.xattrs,
      data: new FileData({
        source,
        metadata,
        decompress,
        inodes,
        blockSize: superblock.block_size,
        fragments: found.fragments,
        fragmentCount: superblock.fragment_count,
      }),
    });
  }

  async #inode(reference: InodeReference): Promise<Inode> {
    return readInode(
      this.#parts.metadata,
      this.#parts.inodes,
      reference,
      this.superblock.block_size,
    );
  }

  async #root(): Promise<DirectoryInode> {
    const root = await this.#inode(this.#parts.root);
    if (root.kind !== "directory")
      throw new SquashfsFormatError(
        root.position,
        `The root inode is a ${root.kind}, not a directory.`,
      );
    return root;
  }

  #walker(directory: DirectoryInode): DirectoryWalker {
    return new DirectoryWalker(
      this.#parts.metadata,
      this.#parts.directories,
      directory.listing,
    );
  }

  #id(index: number, inode: Inode): number {
    const id = this.#parts.ids[index];
    if (id === undefined)
      throw new SquashfsFormatError(
        inode.position,
        `Inode ${String(inode.number)} names id ${String(index)}; the id table has ${String(this.#parts.ids.length)}.`,
      );
    return id;
  }

  async #xattrs(inode: Inode): Promise<number> {
    if (inode.xattr === null) return 0;
    const table = this.#parts.xattrs;
    if (table === null || inode.xattr >= table.count)
      throw new SquashfsFormatError(
        inode.position,
        `Inode ${String(inode.number)} names xattr id ${String(inode.xattr)}; the image has ${String(table?.count ?? 0)}.`,
      );
    return u32(
      await this.#parts.metadata.lookup(table, 16, inode.xattr, "xattr id"),
      8,
    );
  }

  async #entry(path: string, inode: Inode): Promise<SquashfsEntry> {
    let linkTarget: string | null = null;
    if (inode.kind === "symlink") {
      try {
        linkTarget = utf8.decode(inode.target);
      } catch {
        linkTarget = lenientUtf8.decode(inode.target);
        this.#problems.push({
          offset: inode.position,
          message: `The symlink target of "${path}" (0x${hex(inode.target)}) is not valid UTF-8; it is shown with replacement characters.`,
        });
      }
    }
    return {
      path,
      type: inode.kind,
      mode: inode.mode,
      uid: this.#id(inode.uid_index, inode),
      gid: this.#id(inode.gid_index, inode),
      mtime: inode.mtime,
      size:
        inode.kind === "file"
          ? inode.size
          : inode.kind === "symlink"
            ? inode.target.length
            : 0,
      link_target: linkTarget,
      inode_number: inode.number,
      hard_links: inode.nlink,
      device:
        inode.kind === "block-device" || inode.kind === "char-device"
          ? { major: inode.major, minor: inode.minor }
          : null,
      xattrs: await this.#xattrs(inode),
    };
  }

  /** Every entry depth-first, each directory before its children, children in stored order. */
  async *entries(signal?: AbortSignal): AsyncGenerator<SquashfsEntry> {
    const rootKey = referenceKey(this.#parts.root);
    const stack: Frame[] = [
      { walker: this.#walker(await this.#root()), path: "", key: rootKey },
    ];
    const open = new Set([rootKey]);
    const visited = new Set([rootKey]);
    let count = 0;
    for (let frame = stack.at(-1); frame !== undefined; frame = stack.at(-1)) {
      signal?.throwIfAborted();
      const raw = await frame.walker.next();
      if (raw === null) {
        stack.pop();
        open.delete(frame.key);
        continue;
      }
      const name = usableName(raw.name);
      if (typeof name !== "string") {
        this.#problems.push({
          offset: raw.position,
          message: `An entry of ${frame.path === "" ? "the root directory" : `"${frame.path}"`} has the name 0x${hex(raw.name)}, which ${name.reason}; it and anything below it are omitted.`,
        });
        continue;
      }
      const path = frame.path === "" ? name : `${frame.path}/${name}`;
      const inode = await this.#inode(raw.inode);
      if (INODE_KINDS[raw.type - 1] !== inode.kind)
        throw new SquashfsFormatError(
          raw.position,
          `The entry "${path}" says type ${String(raw.type)} but its inode is a ${inode.kind}.`,
        );
      if (
        raw.inode_number !== inode.number ||
        inode.number === 0 ||
        inode.number > this.superblock.inode_count
      )
        this.#problems.push({
          offset: inode.position,
          message: `The entry "${path}" names inode ${String(raw.inode_number)}; the inode says ${String(inode.number)} of ${String(this.superblock.inode_count)}.`,
        });
      count += 1;
      if (count > MAXIMUM_ENTRIES)
        throw new SquashfsFormatError(
          raw.position,
          `The image lists more than ${String(MAXIMUM_ENTRIES)} entries.`,
        );
      const key = referenceKey(raw.inode);
      if (inode.kind === "directory") {
        if (open.has(key))
          throw new SquashfsFormatError(
            raw.position,
            `The directory "${path}" is its own ancestor; the listing loops.`,
          );
        if (visited.has(key))
          throw new SquashfsFormatError(
            raw.position,
            `The directory "${path}" is listed a second time; directories cannot be hard links.`,
          );
        if (stack.length > MAXIMUM_DEPTH)
          throw new SquashfsFormatError(
            raw.position,
            `"${path}" is nested deeper than ${String(MAXIMUM_DEPTH)} directories.`,
          );
      }
      const entry = await this.#entry(path, inode);
      this.#references.set(entry, raw.inode);
      yield entry;
      if (inode.kind === "directory") {
        visited.add(key);
        open.add(key);
        stack.push({ walker: this.#walker(inode), path, key });
      }
    }
  }

  /** The entry at a relative path, found by walking its directories, or null. */
  async find(
    path: string,
    signal?: AbortSignal,
  ): Promise<SquashfsEntry | null> {
    const steps = path.split("/");
    let directory = await this.#root();
    for (const [depth, step] of steps.entries()) {
      const walker = this.#walker(directory);
      let found: { reference: InodeReference; inode: Inode } | null = null;
      for (
        let raw = await walker.next();
        raw !== null;
        raw = await walker.next()
      ) {
        signal?.throwIfAborted();
        if (usableName(raw.name) === step) {
          found = { reference: raw.inode, inode: await this.#inode(raw.inode) };
          break;
        }
      }
      if (found === null) return null;
      if (depth === steps.length - 1) {
        const entry = await this.#entry(path, found.inode);
        this.#references.set(entry, found.reference);
        return entry;
      }
      if (found.inode.kind !== "directory") return null;
      directory = found.inode;
    }
    return null;
  }

  /**
   * A regular file's bytes: its data blocks in order (each compressed or
   * stored, a zero-size block being a sparse run of zeros), then the tail
   * from its fragment block. The caller bounds how much it reads.
   */
  async *read(
    entry: SquashfsEntry,
    signal?: AbortSignal,
  ): AsyncGenerator<Uint8Array> {
    if (entry.type !== "file")
      throw new TypeError(
        `"${entry.path}" is a ${entry.type}; only regular files have bytes.`,
      );
    let reference = this.#references.get(entry);
    if (reference === undefined) {
      const found = await this.find(entry.path, signal);
      reference = found === null ? undefined : this.#references.get(found);
    }
    const inode = reference === undefined ? null : await this.#inode(reference);
    if (inode?.kind !== "file" || inode.number !== entry.inode_number)
      throw new TypeError(
        `"${entry.path}" is not regular file inode ${String(entry.inode_number)} of this image.`,
      );
    yield* this.#parts.data.read(inode, signal);
  }
}
