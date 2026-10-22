import {
  OBJECT_TYPES,
  parseEntries,
  walkTree,
  type RawEntry,
} from "./cfbDirectory.js";
import {
  CFB_MAX_ENTRIES,
  CfbFormatError,
  describeSector,
  DIFSECT,
  ENDOFCHAIN,
  ENTRY_BYTES,
  FATSECT,
  FREESECT,
  HEADER_BYTES,
  HEADER_DIFAT,
  MAXREGSECT,
  MINI_CUTOFF,
  MINI_SECTOR,
  SIGNATURE,
  u16,
  u32,
  type CfbEntry,
  type CfbRead,
} from "./cfbFormat.js";

/** Where an entry's bytes live, or why they cannot be read. */
export type Location =
  | { readonly kind: "none" }
  | { readonly kind: "regular" | "mini"; readonly start: number }
  | {
      readonly kind: "broken";
      readonly offset: number;
      readonly reason: string;
    };

export interface ParsedCompoundFile {
  readonly version: 3 | 4;
  readonly sectorSize: number;
  readonly entries: readonly CfbEntry[];
  readonly problems: readonly string[];
  readonly fat: Uint32Array;
  readonly miniFat: Uint32Array;
  readonly miniStream: readonly number[];
  readonly locations: WeakMap<CfbEntry, Location>;
}

interface Header {
  readonly firstDirectory: number;
  readonly directorySectors: number;
  readonly fatSectors: number;
  readonly firstMiniFat: number;
  readonly miniFatSectors: number;
  readonly firstDifat: number;
  readonly difatSectors: number;
  readonly difat: readonly number[];
}

/** Owners in the sector maps besides entry IDs. */
const FREE = -1;
const DIRECTORY = -2;
const MINI_FAT = -3;
const METADATA = -4;

/**
 * Reads the header, DIFAT, FAT, directory and miniFAT, then checks every
 * stream's chain once: each sector may belong to one structure, so cycles
 * and cross-links are found in time linear in the file's sectors.
 */
export class CfbLayout {
  readonly problems: string[] = [];
  sectorSize = HEADER_BYTES;
  sectorCount = 0;
  version: 3 | 4 = 3;
  fat: Uint32Array = new Uint32Array(0);
  owner: Int32Array = new Int32Array(0);
  miniFat: Uint32Array = new Uint32Array(0);
  miniOwner: Int32Array = new Int32Array(0);
  miniSectors = 0;
  directorySectors: readonly number[] = [];

  constructor(
    readonly read: CfbRead,
    readonly size: number,
  ) {}

  async exactly(
    offset: number,
    length: number,
    what: string,
  ): Promise<Uint8Array> {
    const bytes =
      offset + length <= this.size
        ? await this.read(offset, length)
        : new Uint8Array(0);
    if (bytes.length < length)
      throw new CfbFormatError(
        offset,
        `${what} needs ${String(length)} bytes at offset ${String(offset)}, but the file is ${String(this.size)} bytes.`,
      );
    return bytes.length === length ? bytes : bytes.subarray(0, length);
  }

  checkSector(sector: number, what: string, at: number): void {
    if (sector > MAXREGSECT || sector >= this.sectorCount)
      throw new CfbFormatError(
        at,
        `${what} names ${describeSector(sector)}, but the file has ${String(this.sectorCount)} sectors.`,
      );
  }

  /** Whole sectors in order, adjacent ones merged into single reads. */
  async sectors(list: readonly number[], what: string): Promise<Uint8Array> {
    const out = new Uint8Array(list.length * this.sectorSize);
    let index = 0;
    while (index < list.length) {
      const first = list[index] ?? 0;
      let count = 1;
      while (
        index + count < list.length &&
        list[index + count] === first + count
      )
        count += 1;
      out.set(
        await this.exactly(
          (first + 1) * this.sectorSize,
          count * this.sectorSize,
          what,
        ),
        index * this.sectorSize,
      );
      index += count;
    }
    return out;
  }

  async parse(): Promise<ParsedCompoundFile> {
    const header = await this.header();
    this.fat = await this.readFat(header);
    this.owner = new Int32Array(this.fat.length).fill(FREE);
    this.fat.forEach((next, sector) => {
      if (next === FATSECT || next === DIFSECT) this.owner[sector] = METADATA;
    });
    const raw = await this.directory(header);
    const root = raw[0];
    if (root?.objectType !== 5)
      throw new CfbFormatError(
        this.entryOffset(0) + 66,
        `Directory entry 0 has object type ${String(root?.objectType)}, not the root (5).`,
      );
    await this.readMiniFat(header);
    const miniStream = this.streamChain(
      root.start,
      Math.ceil(root.size / this.sectorSize),
      0,
      "The mini stream",
    );
    if (typeof miniStream === "string")
      throw new CfbFormatError(this.entryOffset(0) + 116, miniStream);
    this.miniSectors = Math.ceil(root.size / MINI_SECTOR);
    const { entries, locations } = this.locate(raw);
    return {
      version: this.version,
      sectorSize: this.sectorSize,
      entries: Object.freeze(entries),
      problems: Object.freeze([...this.problems]),
      fat: this.fat,
      miniFat: this.miniFat,
      miniStream,
      locations,
    };
  }

  entryOffset(id: number): number {
    const perSector = this.sectorSize / ENTRY_BYTES;
    const sector = this.directorySectors[Math.floor(id / perSector)] ?? 0;
    return (sector + 1) * this.sectorSize + (id % perSector) * ENTRY_BYTES;
  }

  async header(): Promise<Header> {
    if (this.size < HEADER_BYTES)
      throw new CfbFormatError(
        0,
        `File is ${String(this.size)} bytes, shorter than the 512-byte compound file header.`,
      );
    const header = await this.exactly(0, HEADER_BYTES, "The header");
    if (!SIGNATURE.every((byte, index) => header[index] === byte))
      throw new CfbFormatError(
        0,
        "File does not start with the compound file signature D0CF11E0A1B11AE1.",
      );
    const major = u16(header, 26);
    if (major !== 3 && major !== 4)
      throw new CfbFormatError(
        26,
        `Major version ${String(major)}; compound files are version 3 or 4.`,
      );
    this.version = major;
    if (u16(header, 28) !== 0xfffe)
      throw new CfbFormatError(
        28,
        `Byte order mark is 0x${u16(header, 28).toString(16)}, not 0xfffe.`,
      );
    const shift = u16(header, 30);
    if (shift !== (major === 3 ? 9 : 12))
      throw new CfbFormatError(
        30,
        `Version ${String(major)} needs sector shift ${major === 3 ? "9" : "12"}; the header says ${String(shift)}.`,
      );
    if (u16(header, 32) !== 6)
      throw new CfbFormatError(
        32,
        `Mini sector shift is ${String(u16(header, 32))}, not 6.`,
      );
    if (u32(header, 56) !== MINI_CUTOFF)
      throw new CfbFormatError(
        56,
        `Mini stream cutoff is ${String(u32(header, 56))}, not 4096.`,
      );
    this.sectorSize = 1 << shift;
    this.sectorCount = Math.max(0, Math.ceil(this.size / this.sectorSize) - 1);
    this.headerProblems(header);
    const fatSectors = u32(header, 44);
    if (fatSectors > this.sectorCount)
      throw new CfbFormatError(
        44,
        `Header declares ${String(fatSectors)} FAT sectors; the file has ${String(this.sectorCount)} sectors.`,
      );
    return {
      firstDirectory: u32(header, 48),
      directorySectors: u32(header, 40),
      fatSectors,
      firstMiniFat: u32(header, 60),
      miniFatSectors: u32(header, 64),
      firstDifat: u32(header, 68),
      difatSectors: u32(header, 72),
      difat: Array.from({ length: HEADER_DIFAT }, (_, index) =>
        u32(header, 76 + index * 4),
      ),
    };
  }

  /** Fields [MS-CFB] fixes whose wrong values leave the file readable. */
  headerProblems(header: Uint8Array): void {
    if (header.subarray(8, 24).some((byte) => byte !== 0))
      this.problems.push("Header CLSID is not zero.");
    if (u16(header, 24) !== 0x3e)
      this.problems.push(
        `Minor version is 0x${u16(header, 24).toString(16)}, not 0x3e.`,
      );
    if (header.subarray(34, 40).some((byte) => byte !== 0))
      this.problems.push("Header reserved bytes are not zero.");
    if (this.version === 3 && u32(header, 40) !== 0)
      this.problems.push(
        `Version 3 header declares ${String(u32(header, 40))} directory sectors; it must be 0.`,
      );
  }

  /** The DIFAT (header array plus its sector chain) and the FAT sectors it lists. */
  async readFat(header: Header): Promise<Uint32Array> {
    const fatSectors = header.difat.slice(
      0,
      Math.min(HEADER_DIFAT, header.fatSectors),
    );
    if (
      header.difat
        .slice(fatSectors.length)
        .some((sector) => sector !== FREESECT)
    )
      this.problems.push(
        "Header DIFAT entries past the declared FAT sectors are not FREESECT.",
      );
    if (header.difatSectors > this.sectorCount)
      throw new CfbFormatError(
        72,
        `Header declares ${String(header.difatSectors)} DIFAT sectors; the file has ${String(this.sectorCount)} sectors.`,
      );
    const perDifat = this.sectorSize / 4 - 1;
    const visited = new Set<number>();
    let next = header.firstDifat;
    let pointer = 68;
    for (let count = 0; fatSectors.length < header.fatSectors; count += 1) {
      if (count >= header.difatSectors)
        throw new CfbFormatError(
          72,
          `The DIFAT lists ${String(fatSectors.length)} FAT sectors; the header declares ${String(header.fatSectors)}.`,
        );
      this.checkSector(next, `DIFAT sector ${String(count)}`, pointer);
      if (visited.has(next))
        throw new CfbFormatError(
          pointer,
          `The DIFAT chain returns to sector ${String(next)}.`,
        );
      visited.add(next);
      const base = (next + 1) * this.sectorSize;
      const sector = await this.exactly(
        base,
        this.sectorSize,
        "A DIFAT sector",
      );
      for (
        let index = 0;
        index < perDifat && fatSectors.length < header.fatSectors;
        index += 1
      )
        fatSectors.push(u32(sector, index * 4));
      pointer = base + perDifat * 4;
      next = u32(sector, perDifat * 4);
    }
    fatSectors.forEach((sector, index) =>
      this.checkSector(
        sector,
        `FAT sector ${String(index)}`,
        index < HEADER_DIFAT ? 76 + index * 4 : 0,
      ),
    );
    if (new Set(fatSectors).size !== fatSectors.length)
      throw new CfbFormatError(76, "The DIFAT lists one FAT sector twice.");
    const bytes = await this.sectors(fatSectors, "The FAT");
    const fat = new Uint32Array(bytes.length / 4);
    for (let index = 0; index < fat.length; index += 1)
      fat[index] = u32(bytes, index * 4);
    const misMarked = fatSectors.filter(
      (sector) => fat[sector] !== FATSECT,
    ).length;
    if (misMarked > 0)
      this.problems.push(
        `${String(misMarked)} FAT sectors are not marked FATSECT in the FAT.`,
      );
    return fat;
  }

  async directory(header: Header): Promise<RawEntry[]> {
    this.directorySectors = this.chain(
      header.firstDirectory,
      DIRECTORY,
      "The directory chain",
      48,
    );
    const count =
      this.directorySectors.length * (this.sectorSize / ENTRY_BYTES);
    if (count === 0)
      throw new CfbFormatError(
        48,
        "The directory chain is empty; there is no root entry.",
      );
    if (count > CFB_MAX_ENTRIES)
      throw new CfbFormatError(
        48,
        `The directory chain holds ${String(count)} entries; at most ${String(CFB_MAX_ENTRIES)} are read.`,
      );
    if (
      this.version === 4 &&
      header.directorySectors !== this.directorySectors.length
    )
      this.problems.push(
        `Header declares ${String(header.directorySectors)} directory sectors; the chain has ${String(this.directorySectors.length)}.`,
      );
    return parseEntries(
      await this.sectors(this.directorySectors, "The directory"),
      this.version,
      this.problems,
    );
  }

  async readMiniFat(header: Header): Promise<void> {
    const sectors =
      header.firstMiniFat === FREESECT
        ? []
        : this.chain(header.firstMiniFat, MINI_FAT, "The miniFAT chain", 60);
    if (sectors.length !== header.miniFatSectors)
      this.problems.push(
        `Header declares ${String(header.miniFatSectors)} miniFAT sectors; the chain has ${String(sectors.length)}.`,
      );
    const bytes = await this.sectors(sectors, "The miniFAT");
    this.miniFat = new Uint32Array(bytes.length / 4);
    for (let index = 0; index < this.miniFat.length; index += 1)
      this.miniFat[index] = u32(bytes, index * 4);
    this.miniOwner = new Int32Array(this.miniFat.length).fill(FREE);
  }

  /** Public entries in tree order and where each one's bytes are. */
  locate(raw: readonly RawEntry[]): {
    entries: CfbEntry[];
    locations: WeakMap<CfbEntry, Location>;
  } {
    const entries: CfbEntry[] = [];
    const locations = new WeakMap<CfbEntry, Location>();
    for (const { id, path } of walkTree(raw, this.problems)) {
      const stored = raw[id];
      const type =
        stored === undefined ? undefined : OBJECT_TYPES[stored.objectType];
      if (stored === undefined || type === undefined) continue;
      const entry: CfbEntry = Object.freeze({
        path: Object.freeze(path),
        name: stored.name,
        type,
        size: type === "storage" ? 0 : stored.size,
        clsid: stored.clsid,
        id,
      });
      entries.push(entry);
      locations.set(entry, this.location(id, stored, type));
    }
    return { entries, locations };
  }

  location(id: number, stored: RawEntry, type: CfbEntry["type"]): Location {
    if (type === "root") return { kind: "regular", start: stored.start };
    if (type === "storage" || stored.size === 0) return { kind: "none" };
    const mini = stored.size < MINI_CUTOFF;
    const what = `Stream ${String(id)} ${JSON.stringify(stored.name)}`;
    const failure = mini
      ? this.miniChain(stored, id, what)
      : this.streamChain(
          stored.start,
          Math.ceil(stored.size / this.sectorSize),
          id,
          what,
        );
    if (typeof failure !== "string")
      return { kind: mini ? "mini" : "regular", start: stored.start };
    this.problems.push(failure);
    return {
      kind: "broken",
      offset: this.entryOffset(id) + 116,
      reason: failure,
    };
  }

  /** A metadata chain (directory, miniFAT) to ENDOFCHAIN; cycles and shared sectors throw. */
  chain(start: number, id: number, what: string, at: number): number[] {
    const sectors: number[] = [];
    for (
      let sector = start;
      sector !== ENDOFCHAIN;
      sector = this.fat[sector] ?? FREESECT
    ) {
      this.checkSector(sector, what, at);
      if (sector >= this.fat.length)
        throw new CfbFormatError(
          at,
          `${what} reaches sector ${String(sector)}, which has no FAT entry.`,
        );
      if (this.owner[sector] !== FREE)
        throw new CfbFormatError(
          (sector + 1) * this.sectorSize,
          this.owner[sector] === id
            ? `${what} returns to sector ${String(sector)} (a cycle).`
            : `${what} runs into sector ${String(sector)}, which another structure uses.`,
        );
      this.owner[sector] = id;
      sectors.push(sector);
    }
    return sectors;
  }

  /** A stream's FAT chain: its `needed` sectors, or why they cannot be read; a longer chain is a problem only. */
  streamChain(
    start: number,
    needed: number,
    id: number,
    what: string,
  ): string | number[] {
    if (needed > this.sectorCount)
      return `${what} needs ${String(needed)} sectors; the file has ${String(this.sectorCount)}.`;
    const sectors: number[] = [];
    if (needed === 0) return sectors;
    for (
      let sector = start;
      sector !== ENDOFCHAIN;
      sector = this.fat[sector] ?? FREESECT
    ) {
      if (sectors.length === needed) {
        const cycle = this.owner[sector] === id ? " (a cycle)" : "";
        this.problems.push(
          `${what} chain continues past its ${String(needed)} sectors to ${describeSector(sector)}${cycle}; the extra sectors are not read.`,
        );
        return sectors;
      }
      if (
        sector > MAXREGSECT ||
        sector >= this.sectorCount ||
        sector >= this.fat.length
      )
        return `${what} chain reaches ${describeSector(sector)} after ${String(sectors.length)} sectors; the file has ${String(this.sectorCount)}.`;
      const owner = this.owner[sector] ?? FREE;
      if (owner !== FREE)
        return owner === id
          ? `${what} chain returns to sector ${String(sector)} (a cycle).`
          : `${what} chain runs into sector ${String(sector)}, which ${owner >= 0 ? `entry ${String(owner)}` : "the file's metadata"} uses.`;
      this.owner[sector] = id;
      sectors.push(sector);
    }
    return sectors.length < needed
      ? `${what} chain ends after ${String(sectors.length)} of its ${String(needed)} sectors.`
      : sectors;
  }

  /** A mini stream's miniFAT chain inside the root's mini stream, or why it cannot be read. */
  miniChain(stored: RawEntry, id: number, what: string): string | null {
    const needed = Math.ceil(stored.size / MINI_SECTOR);
    let sector = stored.start;
    for (let count = 0; count < needed; count += 1) {
      if (sector >= this.miniFat.length || sector >= this.miniSectors)
        return `${what} mini chain reaches ${describeSector(sector)} after ${String(count)} mini sectors; the mini stream has ${String(this.miniSectors)}.`;
      const owner = this.miniOwner[sector] ?? FREE;
      if (owner !== FREE)
        return owner === id
          ? `${what} mini chain returns to mini sector ${String(sector)} (a cycle).`
          : `${what} mini chain runs into mini sector ${String(sector)}, which entry ${String(owner)} uses.`;
      this.miniOwner[sector] = id;
      sector = this.miniFat[sector] ?? FREESECT;
    }
    if (sector !== ENDOFCHAIN)
      this.problems.push(
        `${what} mini chain continues past its ${String(needed)} mini sectors to ${describeSector(sector)}; the extra sectors are not read.`,
      );
    return null;
  }
}
