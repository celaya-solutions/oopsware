import {
  type ImageSource,
  METADATA_BYTES,
  SquashfsFormatError,
  u32,
  u64,
} from "./format.js";
import type { LookupTable, MetadataReader } from "./metadata.js";
import type { SquashfsSuperblock } from "./superblock.js";

/** The lookup tables an image needs after open, and where its directory table ends. */
export interface ImageTables {
  readonly directoryEnd: number;
  readonly ids: Uint32Array;
  readonly fragments: LookupTable | null;
  readonly xattrs: (LookupTable & { readonly count: number }) | null;
}

interface TableIndex {
  readonly index: number;
  /** The first metadata block the index points at. */
  readonly first: number;
  /** Where the table's metadata blocks must end. */
  readonly end: number;
}

interface IndexRequest {
  readonly at: number | null;
  readonly entries: number;
  readonly entryBytes: number;
  readonly name: string;
  /** Defaults to `at`: the index follows its blocks directly. */
  readonly blocksEnd?: number;
}

/** Check that a table's u64 index fits the filesystem and read its first block pointer. */
const tableIndex = async (
  source: ImageSource,
  superblock: SquashfsSuperblock,
  request: IndexRequest,
): Promise<TableIndex | null> => {
  const { at, name } = request;
  if (at === null) return null;
  const blocksEnd = request.blocksEnd ?? at;
  const length =
    8 * Math.ceil((request.entries * request.entryBytes) / METADATA_BYTES);
  if (at + length > superblock.bytes_used)
    throw new SquashfsFormatError(
      at,
      `The ${name} index needs ${String(length)} bytes from ${String(at)} but the filesystem ends at ${String(superblock.bytes_used)}.`,
    );
  const first =
    length === 0
      ? blocksEnd
      : u64(await source.bytes(at, 8, `${name} index`), 0);
  const { directory } = superblock.tables;
  if (first < directory || first > blocksEnd)
    throw new SquashfsFormatError(
      at,
      `The ${name} index points at ${String(first)}, outside [${String(directory)}, ${String(blocksEnd)}].`,
    );
  return { index: at, first, end: blocksEnd };
};

/** The xattr id table: a 16-byte header (key/value table start, id count) followed by its index. */
const xattrIndex = async (
  source: ImageSource,
  superblock: SquashfsSuperblock,
): Promise<{ readonly table: TableIndex | null; readonly count: number }> => {
  const { xattr, directory } = superblock.tables;
  if (xattr === null) return { table: null, count: 0 };
  const header = await source.bytes(xattr, 16, "xattr id table header");
  const keyValues = u64(header, 0);
  if (keyValues < directory || keyValues > xattr)
    throw new SquashfsFormatError(
      xattr,
      `The xattr table start ${String(keyValues)} is outside [${String(directory)}, ${String(xattr)}].`,
    );
  const count = u32(header, 8);
  const table = await tableIndex(source, superblock, {
    at: xattr + 16,
    entries: count,
    entryBytes: 16,
    name: "xattr id",
    blocksEnd: xattr,
  });
  return { table, count };
};

/**
 * Locate the fragment, export, id and xattr id tables, bound the directory
 * table by the first of their blocks, and read every id.
 */
export const readImageTables = async (
  source: ImageSource,
  metadata: MetadataReader,
  superblock: SquashfsSuperblock,
): Promise<ImageTables> => {
  const { tables } = superblock;
  if (superblock.fragment_count > 0 && tables.fragment === null)
    throw new SquashfsFormatError(
      16,
      `${String(superblock.fragment_count)} fragments are declared but the fragment table is absent.`,
    );
  if (superblock.id_count === 0)
    throw new SquashfsFormatError(
      26,
      "The id table is empty; every image has at least one id.",
    );
  const fragments = await tableIndex(source, superblock, {
    at: tables.fragment,
    entries: superblock.fragment_count,
    entryBytes: 16,
    name: "fragment",
  });
  const exports = await tableIndex(source, superblock, {
    at: tables.export,
    entries: superblock.inode_count,
    entryBytes: 8,
    name: "export",
  });
  const ids = await tableIndex(source, superblock, {
    at: tables.id,
    entries: superblock.id_count,
    entryBytes: 4,
    name: "id",
  });
  const xattrs = await xattrIndex(source, superblock);
  if (ids === null)
    throw new SquashfsFormatError(48, "The id table is absent.");
  // The directory table ends where the first later table's first block begins.
  const directoryEnd = Math.min(
    ...[fragments, exports, ids, xattrs.table].flatMap((table) =>
      table === null ? [] : [table.first],
    ),
  );
  const lookup = (table: TableIndex): LookupTable => ({
    index: table.index,
    start: directoryEnd,
    end: table.end,
  });
  const idTable = lookup(ids);
  const values = new Uint32Array(superblock.id_count);
  for (let entry = 0; entry < values.length; entry += 1)
    values[entry] = u32(await metadata.lookup(idTable, 4, entry, "id"), 0);
  return {
    directoryEnd,
    ids: values,
    fragments: fragments === null ? null : lookup(fragments),
    xattrs:
      xattrs.table === null
        ? null
        : { ...lookup(xattrs.table), count: xattrs.count },
  };
};
