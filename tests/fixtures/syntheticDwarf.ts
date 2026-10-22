/**
 * Hand-assembled ELF and DWARF bytes for cases no installed producer writes:
 * 64-bit DWARF, big-endian 32-bit images, GNU and zstd compressed sections, range
 * lists, VLIW-free and odd line programs. Tests say so; nothing here is a producer.
 */

export class Writer {
  readonly bytes: number[] = [];

  constructor(readonly little = true) {}

  get length(): number {
    return this.bytes.length;
  }

  u8(value: number): this {
    this.bytes.push(value & 0xff);
    return this;
  }

  u16(value: number): this {
    return this.int(BigInt(value), 2);
  }

  u32(value: number): this {
    return this.int(BigInt(value), 4);
  }

  u64(value: bigint | number): this {
    return this.int(BigInt(value), 8);
  }

  int(value: bigint, width: number): this {
    const out: number[] = [];
    for (let at = 0; at < width; at += 1)
      out.push(Number((value >> BigInt(8 * at)) & 0xffn));
    this.bytes.push(...(this.little ? out : out.reverse()));
    return this;
  }

  uleb(value: bigint | number): this {
    let rest = BigInt(value);
    do {
      let byte = Number(rest & 0x7fn);
      rest >>= 7n;
      if (rest !== 0n) byte |= 0x80;
      this.bytes.push(byte);
    } while (rest !== 0n);
    return this;
  }

  sleb(value: number): this {
    let rest = BigInt(value);
    for (;;) {
      const byte = Number(rest & 0x7fn);
      rest >>= 7n;
      const done =
        (rest === 0n && (byte & 0x40) === 0) ||
        (rest === -1n && (byte & 0x40) !== 0);
      this.bytes.push(done ? byte : byte | 0x80);
      if (done) return this;
    }
  }

  cstr(value: string): this {
    this.bytes.push(...Buffer.from(value, "utf8"), 0);
    return this;
  }

  raw(data: Uint8Array | readonly number[]): this {
    // Spreading a large array into push() overflows the call stack.
    for (let at = 0; at < data.length; at += 1) this.bytes.push(data[at]!);
    return this;
  }

  pad(alignment: number): this {
    while (this.bytes.length % alignment !== 0) this.bytes.push(0);
    return this;
  }

  toBytes(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

export interface ElfSection {
  readonly name: string;
  readonly data: Uint8Array;
  readonly type?: number;
  readonly flags?: number;
}

export interface ElfOptions {
  readonly wide?: boolean;
  readonly little?: boolean;
  readonly machine?: number;
  readonly type?: number;
  readonly sections: readonly ElfSection[];
}

/** An ELF file holding exactly the given sections (plus a null section and .shstrtab). */
export const buildElf = (options: ElfOptions): Uint8Array => {
  const wide = options.wide ?? true;
  const little = options.little ?? true;
  const headerSize = wide ? 64 : 52;
  const names = new Writer(little).u8(0);
  const nameOffsets = options.sections.map((section) => {
    const at = names.length;
    names.cstr(section.name);
    return at;
  });
  const strtabName = names.length;
  names.cstr(".shstrtab");
  const body = new Writer(little);
  const placed = options.sections.map((section) => {
    body.pad(8);
    const offset = headerSize + body.length;
    body.raw(section.data);
    return offset;
  });
  body.pad(8);
  const strtabOffset = headerSize + body.length;
  body.raw(names.toBytes());
  body.pad(8);
  const tableOffset = headerSize + body.length;
  const count = options.sections.length + 2;
  const out = new Writer(little);
  out.raw([0x7f, 0x45, 0x4c, 0x46, wide ? 2 : 1, little ? 1 : 2, 1, 0]);
  out.raw(new Array<number>(8).fill(0));
  out
    .u16(options.type ?? 2)
    .u16(options.machine ?? 62)
    .u32(1);
  if (wide) out.u64(0).u64(0).u64(tableOffset);
  else out.u32(0).u32(0).u32(tableOffset);
  out.u32(0).u16(headerSize).u16(0).u16(0);
  out
    .u16(wide ? 64 : 40)
    .u16(count)
    .u16(count - 1);
  out.raw(body.toBytes());
  const header = (
    nameOffset: number,
    type: number,
    flags: number,
    offset: number,
    size: number,
  ) => {
    out.u32(nameOffset).u32(type);
    if (wide)
      out.u64(flags).u64(0).u64(offset).u64(size).u32(0).u32(0).u64(1).u64(0);
    else
      out.u32(flags).u32(0).u32(offset).u32(size).u32(0).u32(0).u32(1).u32(0);
  };
  header(0, 0, 0, 0, 0);
  options.sections.forEach((section, index) =>
    header(
      nameOffsets[index]!,
      section.type ?? 1,
      section.flags ?? 0,
      placed[index]!,
      section.data.length,
    ),
  );
  header(strtabName, 3, 0, strtabOffset, names.length);
  return out.toBytes();
};

export interface AbbrevSpec {
  readonly code: number;
  readonly tag: number;
  readonly children: boolean;
  readonly attrs: readonly (readonly [
    at: number,
    form: number,
    implicit?: number,
  ])[];
}

export const abbrevTable = (
  specs: readonly AbbrevSpec[],
  little = true,
): Uint8Array => {
  const out = new Writer(little);
  for (const spec of specs) {
    out
      .uleb(spec.code)
      .uleb(spec.tag)
      .u8(spec.children ? 1 : 0);
    for (const [at, form, implicit] of spec.attrs) {
      out.uleb(at).uleb(form);
      if (implicit !== undefined) out.sleb(implicit);
    }
    out.uleb(0).uleb(0);
  }
  out.uleb(0);
  return out.toBytes();
};

/** A DWARF unit header (versions 2 to 5, 32- or 64-bit format) around its DIE bytes. */
export const unit = (options: {
  readonly version: number;
  readonly dies: Uint8Array;
  readonly addressSize?: number;
  readonly dwarf64?: boolean | undefined;
  readonly unitType?: number;
  readonly abbrevOffset?: number;
  readonly little?: boolean;
}): Uint8Array => {
  const little = options.little ?? true;
  const offsetSize = options.dwarf64 === true ? 8 : 4;
  const body = new Writer(little).u16(options.version);
  const addressSize = options.addressSize ?? 8;
  if (options.version >= 5) {
    body.u8(options.unitType ?? 1).u8(addressSize);
    body.int(BigInt(options.abbrevOffset ?? 0), offsetSize);
  } else {
    body.int(BigInt(options.abbrevOffset ?? 0), offsetSize).u8(addressSize);
  }
  body.raw(options.dies);
  const out = new Writer(little);
  if (options.dwarf64 === true) out.u32(0xffffffff).u64(body.length);
  else out.u32(body.length);
  return out.raw(body.toBytes()).toBytes();
};
