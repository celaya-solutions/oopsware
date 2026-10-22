import { readFatContainerHeader } from "../domain/apple/machoContainer.js";
import { ByteReader, DebugFormatError } from "./byteReader.js";
import type { DebugImage, DebugSection } from "./image.js";

const MH_MAGIC = 0xfeedface;
const MH_CIGAM = 0xcefaedfe;
const MH_MAGIC_64 = 0xfeedfacf;
const MH_CIGAM_64 = 0xcffaedfe;
const LC_SEGMENT = 0x1;
const LC_SEGMENT_64 = 0x19;
const LC_UUID = 0x1b;
const LC_SYMTAB = 0x2;
const MAX_LOAD_COMMANDS = 65_536;
const MAX_SECTIONS = 65_536;

const CPU_ARCH_ABI64 = 0x01000000;
const CPU_ARCH_ABI64_32 = 0x02000000;

const FILE_TYPES: Readonly<Record<number, string>> = {
  1: "object",
  2: "executable",
  3: "fixed-vm-library",
  4: "core",
  5: "preloaded",
  6: "dynamic-library",
  7: "dynamic-linker",
  8: "bundle",
  9: "dynamic-library-stub",
  10: "dsym",
  11: "kext",
  12: "fileset",
};

export const machoArchitecture = (
  cpuType: number,
  cpuSubtype: number,
): string => {
  const sub = cpuSubtype & 0x00ffffff;
  switch (cpuType) {
    case 7:
      return "i386";
    case 7 | CPU_ARCH_ABI64:
      return sub === 8 ? "x86_64h" : "x86_64";
    case 12:
      return sub === 9
        ? "armv7"
        : sub === 11
          ? "armv7s"
          : sub === 12
            ? "armv7k"
            : "arm";
    case 12 | CPU_ARCH_ABI64:
      return sub === 2 ? "arm64e" : "arm64";
    case 12 | CPU_ARCH_ABI64_32:
      return "arm64_32";
    case 18:
      return "ppc";
    case 18 | CPU_ARCH_ABI64:
      return "ppc64";
    default:
      return `cpu-${cpuType}-${cpuSubtype}`;
  }
};

const isMachoMagic = (magic: number): boolean =>
  magic === MH_MAGIC ||
  magic === MH_CIGAM ||
  magic === MH_MAGIC_64 ||
  magic === MH_CIGAM_64;

/** The first four bytes of a thin Mach-O image. */
export const hasThinMachoMagic = (bytes: Uint8Array): boolean =>
  bytes.length >= 4 &&
  isMachoMagic(
    new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false),
  );

const trimName = (bytes: Uint8Array): string => {
  const stop = bytes.indexOf(0);
  return Buffer.from(stop < 0 ? bytes : bytes.subarray(0, stop)).toString(
    "latin1",
  );
};

const formatUuid = (bytes: Uint8Array): string => {
  const text = Buffer.from(bytes).toString("hex").toUpperCase();
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
};

/** "__debug_info" becomes ".debug_info"; Apple's 16-byte limit shortens a few names. */
const dwarfName = (sectionName: string): string => {
  const base = sectionName.replace(/^__/u, ".");
  if (base === ".debug_str_offs") return ".debug_str_offsets";
  return base;
};

const readThin = (
  bytes: Uint8Array,
  fileOffset: number,
  declaredCpu: { readonly type: number; readonly subtype: number } | null,
): DebugImage => {
  const magicReader = new ByteReader(bytes, false);
  const magic = magicReader.u32();
  if (!isMachoMagic(magic))
    throw new DebugFormatError(
      "The slice does not start with a Mach-O header.",
    );
  const littleEndian = magic === MH_CIGAM || magic === MH_CIGAM_64;
  const wide = magic === MH_MAGIC_64 || magic === MH_CIGAM_64;
  const reader = new ByteReader(bytes, littleEndian, 4);
  const cpuType = reader.u32();
  const cpuSubtype = reader.u32();
  const fileType = reader.u32();
  const commandCount = reader.u32();
  const commandBytes = reader.u32();
  reader.skip(wide ? 8 : 4);
  if (commandCount > MAX_LOAD_COMMANDS)
    throw new DebugFormatError(
      `The image declares ${commandCount} load commands.`,
    );
  if (commandBytes > reader.remaining)
    throw new DebugFormatError(
      "The load commands extend past the end of the slice.",
    );

  const problems: string[] = [];
  const sections: DebugSection[] = [];
  const uuids = new Set<string>();
  let hasSymbolTable = false;
  const commandsEnd = reader.pos + commandBytes;
  for (let index = 0; index < commandCount; index += 1) {
    if (commandsEnd - reader.pos < 8) {
      problems.push(
        "The load command table ends before its declared command count.",
      );
      break;
    }
    const start = reader.pos;
    const command = reader.u32();
    const size = reader.u32();
    if (size < 8 || start + size > commandsEnd) {
      problems.push(`Load command ${index} has an invalid size ${size}.`);
      break;
    }
    reader.pos = start + size;
    const body = new ByteReader(bytes, littleEndian, start + 8, start + size);
    if (command === LC_UUID && size >= 24) {
      const uuid = formatUuid(body.block(16));
      // An all-zero UUID is a placeholder, not an identity two files can share.
      if (/^[0-]+$/u.test(uuid))
        problems.push("LC_UUID is all zeros and is ignored.");
      else uuids.add(uuid);
    } else if (command === LC_SYMTAB) {
      hasSymbolTable = true;
    } else if (command === LC_SEGMENT || command === LC_SEGMENT_64) {
      const segmentWide = command === LC_SEGMENT_64;
      const segment = trimName(body.block(16));
      body.skip(segmentWide ? 32 : 16);
      body.skip(8);
      const count = body.u32();
      body.skip(4);
      if (count > MAX_SECTIONS || sections.length + count > MAX_SECTIONS) {
        problems.push(`Segment ${segment} declares ${count} sections.`);
        continue;
      }
      for (let item = 0; item < count; item += 1) {
        const name = trimName(body.block(16));
        const owner = trimName(body.block(16));
        body.skip(segmentWide ? 8 : 4);
        const sectionSize = segmentWide ? Number(body.u64()) : body.u32();
        const offset = body.u32();
        body.skip(segmentWide ? 28 : 24);
        if (owner !== "__DWARF") continue;
        // Mach-O DWARF sections occupy file bytes; a zero offset with a size means none.
        const noBits = offset === 0 && sectionSize > 0;
        sections.push({
          name: dwarfName(name),
          storedName: name,
          offset,
          size: sectionSize,
          compression: "none",
          declaredSize: null,
          noBits,
          streamOffset: 0,
          problem: null,
        });
      }
    }
  }
  if (uuids.size > 1)
    problems.push(
      `Two different LC_UUID commands are present (${[...uuids].join(", ")}); the UUID is unknown.`,
    );
  const type = FILE_TYPES[fileType] ?? `type-${fileType}`;
  if (
    declaredCpu !== null &&
    (declaredCpu.type !== cpuType ||
      (declaredCpu.subtype & 0x00ffffff) !== (cpuSubtype & 0x00ffffff))
  )
    problems.push(
      "The fat table's CPU for this slice differs from the slice's own header; the slice header is used.",
    );
  return {
    format: "mach-o",
    bytes,
    fileOffset,
    architecture: machoArchitecture(cpuType, cpuSubtype),
    bits: wide ? 64 : 32,
    littleEndian,
    fileType: type,
    relocatable: fileType === 1,
    identity: {
      buildId: null,
      uuid: uuids.size === 1 ? [...uuids][0]! : null,
      debugLink: null,
      debugAltLink: null,
    },
    sections: sections.filter((section) => {
      const outside = section.offset + section.size > bytes.length;
      if (outside)
        problems.push(
          `Section ${section.storedName} extends past the end of the slice.`,
        );
      return !outside;
    }),
    hasSymbolTable,
    problems,
  };
};

/** Read a thin Mach-O file or every slice of a fat file. Throws DebugFormatError. */
export const readMacho = (bytes: Uint8Array): DebugImage[] => {
  const fat = readFatContainerHeader(bytes, bytes.length);
  if (fat.state === "malformed") throw new DebugFormatError(fat.reason);
  if (fat.state === "needs-data")
    throw new DebugFormatError("The fat header is truncated.");
  if (fat.state === "not-fat") return [readThin(bytes, 0, null)];
  return fat.slices.map((slice, index) => {
    const issue = fat.rangeIssues[index];
    if (issue !== null && issue !== undefined)
      throw new DebugFormatError(`Slice ${index}: ${issue.reason}`);
    return readThin(
      bytes.subarray(slice.offset, slice.offset + slice.size),
      slice.offset,
      { type: slice.cpuType, subtype: slice.cpuSubtype },
    );
  });
};
