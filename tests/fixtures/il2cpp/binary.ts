/**
 * Synthetic thin arm64 Mach-O holding the IL2CPP registration tables for the
 * metadata fixture: image names, code-generation modules, their method
 * pointer arrays and the CodeRegistration module count and array pointer.
 */
export const FIXTURE_BINARY_BASE = 0x1_0000_0000n;

/** Method addresses by metadata method index; ToString has no body. */
export const FIXTURE_METHOD_ADDRESSES = [
  FIXTURE_BINARY_BASE + 0x200n,
  FIXTURE_BINARY_BASE + 0x210n,
  FIXTURE_BINARY_BASE + 0x220n,
  FIXTURE_BINARY_BASE + 0x230n,
  "no-body",
] as const;

export interface Il2cppBinaryFixtureOptions {
  /** methodPointerCount written for Assembly-CSharp.dll; 3 matches the metadata. */
  readonly firstModuleCount?: number;
  /** Exact module names, including names shared by different metadata images. */
  readonly imageNames?: readonly [string, string];
  /** Write a second record that also matches Assembly-CSharp.dll. */
  readonly duplicateModule?: boolean;
  /** Add an LC_DYLD_CHAINED_FIXUPS load command. */
  readonly chainedFixups?: boolean;
  /** Omit the CodeRegistration module count and array pointer. */
  readonly codeRegistration?: boolean;
  /** Write a RIP-relative `lea rax, [module array]`, as an inlined build loads it. */
  readonly codeReference?: boolean;
  /** Omit the MetadataRegistration type table. */
  readonly metadataRegistration?: boolean;
  /** Byte written before each image name instead of NUL (MSVC pads with 0xFF). */
  readonly namePadding?: number;
  /** Text written directly before mscorlib.dll, making it the tail of a longer name. */
  readonly namePrefix?: string;
}

/** Every fixture method returns type 0, an array of a generic instance. */
export const FIXTURE_RETURN_TYPE_NAME = "System.Größe<int>[]";

const SIZE = 0x1000;
const METADATA_REGISTRATION = 0x800;
const TYPE_POINTERS = 0x900;
const TYPE_RECORDS = 0x980;
const GENERIC_CLASS = 0xa00;
const GENERIC_INSTANCE = 0xa40;
const GENERIC_ARGUMENTS = 0xa60;
const STRINGS = 0x100;
const POINTERS = 0x300;
const MODULES = 0x400;
const MODULE_ARRAY = 0x500;
const REGISTRATION = 0x600;
const DUPLICATE = 0x700;

export const createIl2cppBinaryFixture = (
  options: Il2cppBinaryFixtureOptions = {},
): Buffer => {
  const bytes = Buffer.alloc(SIZE);
  const address = (offset: number) => FIXTURE_BINARY_BASE + BigInt(offset);
  const chained = options.chainedFixups === true;
  // Mach-O 64-bit header: arm64 dylib with one or two load commands.
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(0x0100000c, 4);
  bytes.writeUInt32LE(6, 12);
  bytes.writeUInt32LE(chained ? 2 : 1, 16);
  bytes.writeUInt32LE(chained ? 72 + 16 : 72, 20);
  // LC_SEGMENT_64 __TEXT mapping the whole file read-execute.
  bytes.writeUInt32LE(0x19, 32);
  bytes.writeUInt32LE(72, 36);
  bytes.write("__TEXT", 40, "latin1");
  bytes.writeBigUInt64LE(FIXTURE_BINARY_BASE, 56);
  bytes.writeBigUInt64LE(BigInt(SIZE), 64);
  bytes.writeBigUInt64LE(0n, 72);
  bytes.writeBigUInt64LE(BigInt(SIZE), 80);
  bytes.writeUInt32LE(5, 88);
  bytes.writeUInt32LE(5, 92);
  if (chained) {
    // linkedit_data_command pointing at an empty range.
    bytes.writeUInt32LE(0x80000034, 104);
    bytes.writeUInt32LE(16, 108);
  }
  const names = options.imageNames ?? ["Assembly-CSharp.dll", "mscorlib.dll"];
  const nameAt: number[] = [];
  let cursor = STRINGS;
  for (const name of names) {
    bytes[cursor++] = options.namePadding ?? 0;
    if (name === "mscorlib.dll" && options.namePrefix !== undefined)
      cursor += bytes.write(options.namePrefix, cursor, "utf8");
    nameAt.push(cursor);
    cursor += bytes.write(`${name}\0`, cursor, "utf8");
  }
  // Slots are indexed by token row id - 1 (see FIXTURE_METHOD_TOKENS).
  const tables = [
    [0x210n, 0x200n, 0x220n],
    [0x230n, null],
  ];
  const tableAt: number[] = [];
  let pointer = POINTERS;
  for (const table of tables) {
    tableAt.push(pointer);
    for (const slot of table) {
      bytes.writeBigUInt64LE(
        slot === null ? 0n : FIXTURE_BINARY_BASE + slot,
        pointer,
      );
      pointer += 8;
    }
  }
  const writeModule = (at: number, image: number, count: number) => {
    bytes.writeBigUInt64LE(address(nameAt[image]!), at);
    bytes.writeUInt32LE(count, at + 8);
    bytes.writeBigUInt64LE(address(tableAt[image]!), at + 16);
  };
  writeModule(MODULES, 0, options.firstModuleCount ?? 3);
  writeModule(MODULES + 0x40, 1, 2);
  if (options.duplicateModule === true) writeModule(DUPLICATE, 0, 3);
  bytes.writeBigUInt64LE(address(MODULES), MODULE_ARRAY);
  bytes.writeBigUInt64LE(address(MODULES + 0x40), MODULE_ARRAY + 8);
  if (options.codeReference === true) {
    // lea rax, [rip + disp32]; disp is relative to the next instruction.
    const at = 0xc00;
    bytes.set([0x48, 0x8d, 0x05], at);
    bytes.writeInt32LE(MODULE_ARRAY - (at + 7), at + 3);
  }
  if (options.codeRegistration !== false) {
    bytes.writeBigUInt64LE(2n, REGISTRATION);
    bytes.writeBigUInt64LE(address(MODULE_ARRAY), REGISTRATION + 8);
  }
  // Il2CppType records: 8-byte data, then attrs:16 and type:8 bits.
  const types: readonly [kind: number, data: bigint][] = [
    [0x1d, address(TYPE_RECORDS + 16)],
    [0x15, address(GENERIC_CLASS)],
    [0x12, 3n],
    [0x08, 0n],
  ];
  types.forEach(([kind, data], index) => {
    const at = TYPE_RECORDS + index * 16;
    bytes.writeBigUInt64LE(data, at);
    bytes.writeUInt32LE(kind << 16, at + 8);
    bytes.writeBigUInt64LE(address(at), TYPE_POINTERS + index * 8);
  });
  // Version 29+ Il2CppGenericClass: definition type, then class_inst.
  bytes.writeBigUInt64LE(address(TYPE_RECORDS + 32), GENERIC_CLASS);
  bytes.writeBigUInt64LE(address(GENERIC_INSTANCE), GENERIC_CLASS + 8);
  bytes.writeUInt32LE(1, GENERIC_INSTANCE);
  bytes.writeBigUInt64LE(address(GENERIC_ARGUMENTS), GENERIC_INSTANCE + 8);
  bytes.writeBigUInt64LE(address(TYPE_RECORDS + 48), GENERIC_ARGUMENTS);
  if (options.metadataRegistration !== false) {
    // typesCount and types, then fieldOffsets and typeDefinitionsSizes,
    // whose counts equal the 4 metadata type definitions.
    const word = (slot: number, value: bigint) =>
      bytes.writeBigUInt64LE(value, METADATA_REGISTRATION + slot * 8);
    word(6, BigInt(types.length));
    word(7, address(TYPE_POINTERS));
    word(10, 4n);
    word(11, address(TYPE_POINTERS));
    word(12, 4n);
    word(13, address(TYPE_POINTERS));
  }
  return bytes;
};

/** Wrap thin Mach-O slices in a 32-bit universal header, page aligned. */
export const createUniversalFixture = (
  slices: readonly { readonly cpu: number; readonly bytes: Buffer }[],
): Buffer => {
  const align = 0x1000;
  const header = Buffer.alloc(align);
  header.writeUInt32BE(0xcafebabe, 0);
  header.writeUInt32BE(slices.length, 4);
  const parts: Buffer[] = [header];
  let offset = align;
  slices.forEach((slice, index) => {
    const at = 8 + index * 20;
    header.writeUInt32BE(slice.cpu, at);
    header.writeUInt32BE(0, at + 4);
    header.writeUInt32BE(offset, at + 8);
    header.writeUInt32BE(slice.bytes.length, at + 12);
    header.writeUInt32BE(12, at + 16);
    const padded = Buffer.alloc(Math.ceil(slice.bytes.length / align) * align);
    slice.bytes.copy(padded);
    parts.push(padded);
    offset += padded.length;
  });
  return Buffer.concat(parts);
};

/** PE section with a method array ending across its file/zero-fill boundary. */
export const createSplitPointerPeFixture = (zeroTail = true): Buffer => {
  const payload = createIl2cppBinaryFixture();
  payload.writeBigUInt64LE(FIXTURE_BINARY_BASE + 0xff8n, 0x450);
  payload.writeBigUInt64LE(FIXTURE_BINARY_BASE + 0x230n, 0xff8);
  const header = Buffer.alloc(0x200);
  header.writeUInt16LE(0x5a4d);
  header.writeUInt32LE(0x40, 60);
  header.writeUInt32LE(0x4550, 0x40);
  header.writeUInt16LE(0x8664, 0x44);
  header.writeUInt16LE(1, 0x46);
  header.writeUInt16LE(240, 0x54);
  const optional = 0x58;
  header.writeUInt16LE(0x20b, optional);
  header.writeBigUInt64LE(FIXTURE_BINARY_BASE, optional + 24);
  header.writeUInt32LE(0x1000, optional + 32);
  header.writeUInt32LE(0x200, optional + 36);
  header.writeUInt32LE(0x2000, optional + 56);
  header.writeUInt32LE(0x200, optional + 60);
  const section = optional + 240;
  header.write(".text", section);
  header.writeUInt32LE(zeroTail ? 0x1008 : 0x1000, section + 8);
  header.writeUInt32LE(0x1000, section + 16);
  header.writeUInt32LE(0x200, section + 20);
  header.writeUInt32LE(0x60000020, section + 36);
  return Buffer.concat([header, payload]);
};

/** Android ELF relocation tables appended after the fixture image. */
export interface ElfFixtureOptions {
  /** e_machine; 183 is AArch64. */
  readonly machine?: number;
  /** Add DT_ANDROID_RELA, the packed APS2 encoding. */
  readonly androidPacked?: boolean;
  /** Omit PT_DYNAMIC. */
  readonly dynamic?: boolean;
  /** Give every relocation a symbol index, so none is RELATIVE-only. */
  readonly symbolRelocations?: boolean;
  /** Write DT_RELA twice. */
  readonly duplicateRela?: boolean;
  /** Override DT_RELASZ or DT_RELAENT. */
  readonly relaSize?: bigint;
  readonly relaEntry?: bigint;
  /** Move mscorlib.dll's method pointers into zero-fill past the file end. */
  readonly zeroFilledTable?: boolean;
}

/**
 * Rewrap a fixture image as a 64-bit ELF shared object loaded at the same
 * base: every pointer slot into the image is zeroed on disk and restored by
 * an R_AARCH64_RELATIVE entry, as a position-independent libil2cpp.so stores it.
 */
export const createElfFixture = (
  image: Buffer,
  options: ElfFixtureOptions = {},
): Buffer => {
  const body = Buffer.from(image);
  body.fill(0, 0, 0x100);
  const relocations: [slot: bigint, value: bigint][] = [];
  for (let at = 0x100; at + 8 <= SIZE; at += 8) {
    const value = body.readBigUInt64LE(at);
    if (
      value < FIXTURE_BINARY_BASE ||
      value >= FIXTURE_BINARY_BASE + BigInt(SIZE)
    )
      continue;
    relocations.push([FIXTURE_BINARY_BASE + BigInt(at), value]);
    body.writeBigUInt64LE(0n, at);
  }
  const tagCount =
    4 +
    (options.duplicateRela === true ? 1 : 0) +
    (options.androidPacked === true ? 1 : 0);
  const fileSize = SIZE + relocations.length * 24 + tagCount * 16;
  if (options.zeroFilledTable === true) {
    // The second module record's methodPointers field (MODULES + 0x40 + 16).
    const slot = FIXTURE_BINARY_BASE + BigInt(0x400 + 0x40 + 16);
    const entry = relocations.find(([at]) => at === slot)!;
    entry[1] = FIXTURE_BINARY_BASE + BigInt(fileSize);
  }
  const rela = Buffer.alloc(relocations.length * 24);
  relocations.forEach(([slot, value], index) => {
    rela.writeBigUInt64LE(slot, index * 24);
    rela.writeBigUInt64LE(
      (options.symbolRelocations === true ? 1n << 32n : 0n) |
        (options.machine === 62 ? 8n : 1027n),
      index * 24 + 8,
    );
    rela.writeBigInt64LE(value, index * 24 + 16);
  });
  const tags: [bigint, bigint][] = [
    [7n, FIXTURE_BINARY_BASE + BigInt(SIZE)],
    ...(options.duplicateRela === true
      ? [[7n, FIXTURE_BINARY_BASE + BigInt(SIZE)] as [bigint, bigint]]
      : []),
    [8n, options.relaSize ?? BigInt(rela.length)],
    [9n, options.relaEntry ?? 24n],
    ...(options.androidPacked === true
      ? [[0x60000011n, 0n] as [bigint, bigint]]
      : []),
    [0n, 0n],
  ];
  const dynamic = Buffer.alloc(tags.length * 16);
  tags.forEach(([tag, value], index) => {
    dynamic.writeBigInt64LE(tag, index * 16);
    dynamic.writeBigUInt64LE(value, index * 16 + 8);
  });
  const file = Buffer.concat([body, rela, dynamic]);
  if (file.length !== fileSize) throw new Error("ELF fixture size drifted");
  const withDynamic = options.dynamic !== false;
  // ELF64 header: little-endian shared object, no section headers.
  file.write("\x7fELF", 0, "latin1");
  file.writeUInt8(2, 4);
  file.writeUInt8(1, 5);
  file.writeUInt8(1, 6);
  file.writeUInt16LE(3, 16);
  file.writeUInt16LE(options.machine ?? 183, 18);
  file.writeUInt32LE(1, 20);
  file.writeBigUInt64LE(64n, 32);
  file.writeUInt16LE(64, 52);
  file.writeUInt16LE(56, 54);
  file.writeUInt16LE(withDynamic ? 2 : 1, 56);
  // Synthetic PT_LOAD maps code and relocation data read-write-execute.
  file.writeUInt32LE(1, 64);
  file.writeUInt32LE(7, 68);
  file.writeBigUInt64LE(FIXTURE_BINARY_BASE, 80);
  file.writeBigUInt64LE(FIXTURE_BINARY_BASE, 88);
  file.writeBigUInt64LE(BigInt(file.length), 96);
  file.writeBigUInt64LE(
    BigInt(file.length) + (options.zeroFilledTable === true ? 0x100n : 0n),
    104,
  );
  if (withDynamic) {
    const at = SIZE + rela.length;
    file.writeUInt32LE(2, 120);
    file.writeUInt32LE(6, 124);
    file.writeBigUInt64LE(BigInt(at), 128);
    file.writeBigUInt64LE(FIXTURE_BINARY_BASE + BigInt(at), 136);
    file.writeBigUInt64LE(FIXTURE_BINARY_BASE + BigInt(at), 144);
    file.writeBigUInt64LE(BigInt(dynamic.length), 152);
    file.writeBigUInt64LE(BigInt(dynamic.length), 160);
  }
  return file;
};
