/**
 * A compound file writer for fixtures: version 3 (512-byte sectors), named
 * streams and storages, regular and mini streams, one FAT/DIFAT layout. It
 * writes what the tests need to hand-assemble legacy Office files (no producer
 * for .xls or .ppt is installed); it is not a general writer. Directory children
 * are chained through right siblings in the format's name order, all black.
 */

const SECTOR = 512;
const MINI_SECTOR = 64;
const MINI_CUTOFF = 4096;
const FREESECT = 0xffffffff;
const ENDOFCHAIN = 0xfffffffe;
const FATSECT = 0xfffffffd;
const FAT_PER_SECTOR = SECTOR / 4;
const HEADER_FAT_SLOTS = 109;

export interface CfbNode {
  /** Names from below the root; a storage ends with children, a stream with data. */
  readonly name: string;
  readonly data?: Uint8Array;
  readonly children?: readonly CfbNode[];
  /** 16 bytes, written on a storage or the root. */
  readonly clsid?: Uint8Array;
}

interface Placed {
  readonly node: CfbNode;
  readonly id: number;
  left: number;
  right: number;
  child: number;
  start: number;
  size: number;
}

/** [MS-CFB] 2.6.4: shorter names sort first, then by upper-cased UTF-16 code units. */
const compareNames = (a: string, b: string): number =>
  a.length !== b.length
    ? a.length - b.length
    : a.toUpperCase() < b.toUpperCase()
      ? -1
      : a.toUpperCase() > b.toUpperCase()
        ? 1
        : 0;

/** The directory sectors: one 128-byte entry per placed node, then free entries to the sector end. */
const directoryBytes = (placed: readonly Placed[]): Uint8Array => {
  const directory = new Uint8Array(Math.ceil(placed.length / 4) * SECTOR);
  const dir = new DataView(directory.buffer);
  for (const entry of placed) {
    const base = entry.id * 128;
    const name = entry.node.name;
    if (name.length > 31) throw new Error(`Stream name too long: ${name}`);
    for (let at = 0; at < name.length; at += 1)
      dir.setUint16(base + at * 2, name.charCodeAt(at), true);
    dir.setUint16(base + 64, (name.length + 1) * 2, true);
    dir.setUint8(base + 66, entry.id === 0 ? 5 : entry.node.data ? 2 : 1);
    dir.setUint8(base + 67, 1);
    dir.setUint32(base + 68, entry.left, true);
    dir.setUint32(base + 72, entry.right, true);
    dir.setUint32(base + 76, entry.child, true);
    if (entry.node.clsid !== undefined)
      directory.set(entry.node.clsid.subarray(0, 16), base + 80);
    dir.setUint32(base + 116, entry.start, true);
    dir.setUint32(base + 120, entry.size, true);
  }
  // Unused slots in the last directory sector are free entries.
  for (let id = placed.length; id < directory.length / 128; id += 1) {
    const base = id * 128;
    dir.setUint32(base + 68, FREESECT, true);
    dir.setUint32(base + 72, FREESECT, true);
    dir.setUint32(base + 76, FREESECT, true);
  }
  return directory;
};

/** Build a version 3 compound file whose root holds the given nodes. */
export const writeCompoundFile = (
  root: readonly CfbNode[],
  rootClsid?: Uint8Array,
): Uint8Array => {
  const placed: Placed[] = [];
  const place = (node: CfbNode): Placed => {
    const entry: Placed = {
      node,
      id: placed.length,
      left: FREESECT,
      right: FREESECT,
      child: FREESECT,
      start: ENDOFCHAIN,
      size: node.data?.length ?? 0,
    };
    placed.push(entry);
    return entry;
  };
  const rootEntry = place({
    name: "Root Entry",
    children: root,
    ...(rootClsid === undefined ? {} : { clsid: rootClsid }),
  });
  // Children are placed after their parent, so ids follow a breadth-first walk.
  const queue: Placed[] = [rootEntry];
  for (let at = 0; at < queue.length; at += 1) {
    const parent = queue[at];
    if (parent === undefined) break;
    const children = [...(parent.node.children ?? [])].sort((a, b) =>
      compareNames(a.name, b.name),
    );
    let previous: Placed | undefined;
    for (const child of children) {
      const entry = place(child);
      queue.push(entry);
      if (previous === undefined) parent.child = entry.id;
      else previous.right = entry.id;
      previous = entry;
    }
  }

  // Streams below the cutoff go to the mini stream, the rest to regular sectors.
  const mini: Uint8Array[] = [];
  let miniSectors = 0;
  const miniFat: number[] = [];
  const fat: number[] = [];
  const claim = (count: number): number => {
    const first = fat.length;
    for (let at = 0; at < count; at += 1)
      fat.push(at === count - 1 ? ENDOFCHAIN : first + at + 1);
    return first;
  };

  const streams = placed.filter(
    (entry) => entry.node.data !== undefined && entry.id !== 0,
  );
  for (const entry of streams) {
    const data = entry.node.data ?? new Uint8Array(0);
    if (data.length === 0) continue;
    if (data.length < MINI_CUTOFF) {
      const count = Math.ceil(data.length / MINI_SECTOR);
      entry.start = miniSectors;
      for (let at = 0; at < count; at += 1)
        miniFat.push(at === count - 1 ? ENDOFCHAIN : miniSectors + at + 1);
      const padded = new Uint8Array(count * MINI_SECTOR);
      padded.set(data);
      mini.push(padded);
      miniSectors += count;
    }
  }

  const sectors: Uint8Array[] = [];
  const add = (bytes: Uint8Array): void => {
    for (let at = 0; at < bytes.length; at += SECTOR) {
      const sector = new Uint8Array(SECTOR);
      sector.set(bytes.subarray(at, at + SECTOR));
      sectors.push(sector);
    }
  };

  for (const entry of streams) {
    const data = entry.node.data ?? new Uint8Array(0);
    if (data.length >= MINI_CUTOFF) {
      const count = Math.ceil(data.length / SECTOR);
      entry.start = claim(count);
      add(data);
    }
  }
  const miniStream = new Uint8Array(mini.reduce((n, m) => n + m.length, 0));
  let offset = 0;
  for (const part of mini) {
    miniStream.set(part, offset);
    offset += part.length;
  }
  if (miniStream.length > 0) {
    rootEntry.start = claim(Math.ceil(miniStream.length / SECTOR));
    add(miniStream);
  }
  rootEntry.size = miniStream.length;

  const miniFatBytes = new Uint8Array(
    Math.max(1, Math.ceil(miniFat.length / FAT_PER_SECTOR)) * SECTOR,
  ).fill(0xff);
  const miniView = new DataView(miniFatBytes.buffer);
  miniFat.forEach((value, at) => miniView.setUint32(at * 4, value, true));
  let miniFatStart = ENDOFCHAIN;
  let miniFatCount = 0;
  if (miniFat.length > 0) {
    miniFatCount = miniFatBytes.length / SECTOR;
    miniFatStart = claim(miniFatCount);
    add(miniFatBytes);
  }

  const directory = directoryBytes(placed);
  const directoryStart = claim(directory.length / SECTOR);
  add(directory);

  // The FAT describes itself: add FAT sectors until they cover every sector.
  let fatSectors = 0;
  while (fat.length + fatSectors > fatSectors * FAT_PER_SECTOR) fatSectors += 1;
  if (fatSectors > HEADER_FAT_SLOTS)
    throw new Error("Fixture too large for the header FAT slots.");
  const fatStart = fat.length;
  for (let at = 0; at < fatSectors; at += 1) fat.push(FATSECT);
  const fatBytes = new Uint8Array(fatSectors * SECTOR).fill(0xff);
  const fatView = new DataView(fatBytes.buffer);
  fat.forEach((value, at) => fatView.setUint32(at * 4, value, true));
  add(fatBytes);

  const header = new Uint8Array(SECTOR);
  const view = new DataView(header.buffer);
  header.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  view.setUint16(24, 0x3e, true);
  view.setUint16(26, 3, true);
  view.setUint16(28, 0xfffe, true);
  view.setUint16(30, 9, true);
  view.setUint16(32, 6, true);
  view.setUint32(44, fatSectors, true);
  view.setUint32(48, directoryStart, true);
  view.setUint32(56, MINI_CUTOFF, true);
  view.setUint32(60, miniFatStart, true);
  view.setUint32(64, miniFatCount, true);
  view.setUint32(68, ENDOFCHAIN, true);
  view.setUint32(72, 0, true);
  for (let at = 0; at < HEADER_FAT_SLOTS; at += 1)
    view.setUint32(
      76 + at * 4,
      at < fatSectors ? fatStart + at : FREESECT,
      true,
    );

  const out = new Uint8Array(SECTOR + sectors.length * SECTOR);
  out.set(header);
  sectors.forEach((sector, at) => out.set(sector, SECTOR + at * SECTOR));
  return out;
};

/** A UTF-16LE string as bytes (no terminator). */
export const utf16 = (text: string): Uint8Array =>
  new Uint8Array(Buffer.from(text, "utf16le"));
