import { createHash } from "node:crypto";

import { decodeModifiedUtf8 } from "../../jvm/classfile/ClassReader.js";
import { adler32, DexFormatError, DexReader } from "./DexReader.js";

/**
 * Dalvik executable (DEX) structure, read in process from its bytes as the
 * format reference defines it. Nothing is verified, optimized or run; index
 * tables are checked against the file before any entry is read.
 */

/** No index (0xffffffff), e.g. a class without a superclass or source file. */
export const NO_INDEX = 0xffff_ffff;

/** Versions with a published layout; d8 in build-tools 37 writes 035 to 039. */
export const KNOWN_DEX_VERSIONS = ["035", "037", "038", "039", "040", "041"];

const ENDIAN_CONSTANT = 0x1234_5678;
const REVERSE_ENDIAN_CONSTANT = 0x7856_3412;
const HEADER_SIZE = 0x70;
const CONTAINER_HEADER_SIZE = 0x78;

/** Map item type codes and the names the format reference gives them. */
export const MAP_ITEM_TYPES: Readonly<Record<number, string>> = {
  0x0000: "header_item",
  0x0001: "string_id_item",
  0x0002: "type_id_item",
  0x0003: "proto_id_item",
  0x0004: "field_id_item",
  0x0005: "method_id_item",
  0x0006: "class_def_item",
  0x0007: "call_site_id_item",
  0x0008: "method_handle_item",
  0x1000: "map_list",
  0x1001: "type_list",
  0x1002: "annotation_set_ref_list",
  0x1003: "annotation_set_item",
  0x2000: "class_data_item",
  0x2001: "code_item",
  0x2002: "string_data_item",
  0x2003: "debug_info_item",
  0x2004: "annotation_item",
  0x2005: "encoded_array_item",
  0x2006: "annotations_directory_item",
  0xf000: "hiddenapi_class_data_item",
};

export interface DexSection {
  readonly size: number;
  readonly offset: number;
}

export interface DexHeader {
  readonly magic_version: string;
  readonly checksum: number;
  readonly computed_checksum: number;
  readonly signature: string;
  readonly computed_signature: string;
  readonly file_size: number;
  readonly header_size: number;
  readonly endian_tag: number;
  readonly link: DexSection;
  readonly map_offset: number;
  readonly string_ids: DexSection;
  readonly type_ids: DexSection;
  readonly proto_ids: DexSection;
  readonly field_ids: DexSection;
  readonly method_ids: DexSection;
  readonly class_defs: DexSection;
  readonly data: DexSection;
  /** DEX 041 only: the whole container and this header's place in it. */
  readonly container_size: number | null;
  readonly header_offset: number | null;
}

export interface DexMapItem {
  readonly type: number;
  readonly name: string;
  readonly size: number;
  readonly offset: number;
}

export interface DexProblem {
  readonly offset: number | null;
  readonly message: string;
}

export interface DexProto {
  readonly shorty: string | null;
  readonly return_type: string | null;
  readonly parameters: readonly (string | null)[];
}

export interface DexFieldId {
  readonly class: string | null;
  readonly type: string | null;
  readonly name: string | null;
}

export interface DexMethodId {
  readonly class: string | null;
  readonly proto_index: number;
  readonly name: string | null;
}

export interface DexClassDef {
  readonly index: number;
  readonly offset: number;
  readonly class_idx: number;
  readonly access_flags: number;
  readonly superclass_idx: number;
  readonly interfaces_off: number;
  readonly source_file_idx: number;
  readonly annotations_off: number;
  readonly class_data_off: number;
  readonly static_values_off: number;
}

export interface DexEncodedField {
  readonly field_idx: number;
  readonly access_flags: number;
}

export interface DexEncodedMethod {
  readonly method_idx: number;
  readonly access_flags: number;
  readonly code_off: number;
}

export interface DexClassData {
  readonly offset: number;
  readonly static_fields: readonly DexEncodedField[];
  readonly instance_fields: readonly DexEncodedField[];
  readonly direct_methods: readonly DexEncodedMethod[];
  readonly virtual_methods: readonly DexEncodedMethod[];
}

export interface DexCatchHandler {
  /** Exception type index, or null for a catch-all handler. */
  readonly type_idx: number | null;
  readonly address: number;
}

export interface DexTry {
  readonly start: number;
  readonly count: number;
  readonly handler_offset: number;
  readonly handlers: readonly DexCatchHandler[];
}

export interface DexCodeItem {
  readonly offset: number;
  readonly registers: number;
  readonly ins: number;
  readonly outs: number;
  readonly debug_info_off: number;
  readonly insns_size: number;
  /** File offset of the first code unit. */
  readonly insns_offset: number;
  readonly tries: readonly DexTry[];
}

export interface DexPosition {
  readonly address: number;
  readonly line: number;
}

export interface DexLocal {
  readonly register: number;
  readonly start: number;
  readonly end: number;
  readonly name: string | null;
  readonly type: string | null;
  readonly signature: string | null;
}

export interface DexDebugInfo {
  readonly line_start: number;
  readonly parameter_names: readonly (string | null)[];
  readonly positions: readonly DexPosition[];
  readonly locals: readonly DexLocal[];
  /** Source files named by DBG_SET_FILE, in order. */
  readonly files: readonly (string | null)[];
}

/** One decoded encoded_value (format reference "encoded_value encoding"). */
export type DexValue =
  | { readonly kind: "byte" | "short" | "char" | "int"; readonly value: number }
  | { readonly kind: "long"; readonly value: bigint }
  | { readonly kind: "float" | "double"; readonly value: number }
  | {
      readonly kind:
        | "method_type"
        | "method_handle"
        | "string"
        | "type"
        | "field"
        | "method"
        | "enum";
      readonly index: number;
    }
  | { readonly kind: "array"; readonly values: readonly DexValue[] }
  | { readonly kind: "annotation"; readonly annotation: DexAnnotationValue }
  | { readonly kind: "null" }
  | { readonly kind: "boolean"; readonly value: boolean };

export interface DexAnnotationValue {
  readonly type_idx: number;
  readonly elements: readonly {
    readonly name_idx: number;
    readonly value: DexValue;
  }[];
}

export interface DexAnnotation extends DexAnnotationValue {
  /** 0 build, 1 runtime, 2 system. */
  readonly visibility: number;
}

export interface DexAnnotationsDirectory {
  readonly class_annotations: readonly DexAnnotation[];
  readonly fields: ReadonlyMap<number, readonly DexAnnotation[]>;
  readonly methods: ReadonlyMap<number, readonly DexAnnotation[]>;
  readonly parameters: ReadonlyMap<
    number,
    readonly (readonly DexAnnotation[])[]
  >;
}

export interface DexMethodHandle {
  readonly type: number;
  readonly field_or_method_id: number;
}

/** Nested values deeper than this are refused; real files nest a few levels. */
const MAX_VALUE_DEPTH = 64;

const sectionOk = (
  section: DexSection,
  itemSize: number,
  fileSize: number,
): boolean =>
  section.size === 0 ||
  (section.offset >= HEADER_SIZE &&
    section.offset + section.size * itemSize <= fileSize);

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

/** True when `bytes` starts with the DEX magic "dex\n" + three digits + NUL. */
export const hasDexMagic = (bytes: Uint8Array): boolean =>
  bytes.length >= 8 &&
  bytes[0] === 0x64 &&
  bytes[1] === 0x65 &&
  bytes[2] === 0x78 &&
  bytes[3] === 0x0a &&
  bytes[7] === 0x00 &&
  [4, 5, 6].every((index) => {
    const byte = bytes[index] ?? 0;
    return byte >= 0x30 && byte <= 0x39;
  });

/** Parsed index tables of one DEX file with lazily decoded entries. */
export class DexFile {
  readonly problems: DexProblem[] = [];
  readonly map: readonly DexMapItem[];
  readonly call_site_ids: DexSection;
  readonly method_handles: DexSection;
  readonly #strings = new Map<number, string | null>();

  private constructor(
    readonly bytes: Uint8Array,
    readonly header: DexHeader,
  ) {
    this.map = this.#readMap();
    const mapped = (type: number): DexSection => {
      const item = this.map.find((entry) => entry.type === type);
      return item === undefined
        ? { size: 0, offset: 0 }
        : { size: item.size, offset: item.offset };
    };
    this.call_site_ids = mapped(0x0007);
    this.method_handles = mapped(0x0008);
    for (const [name, section, size] of [
      ["call_site_ids", this.call_site_ids, 4],
      ["method_handles", this.method_handles, 8],
    ] as const)
      if (!sectionOk(section, size, this.limit)) {
        this.problems.push({
          offset: section.offset,
          message: `${name} (${String(section.size)} items) does not fit in the file.`,
        });
        if (name === "call_site_ids")
          this.call_site_ids = { size: 0, offset: 0 };
        else this.method_handles = { size: 0, offset: 0 };
      }
  }

  /** End of the bytes this file's offsets may reach. */
  get limit(): number {
    return Math.min(
      this.bytes.length,
      this.header.container_size ?? this.header.file_size,
    );
  }

  /** Parse the header and index sections; throws DexFormatError when the file cannot be read as DEX at all. */
  static parse(bytes: Uint8Array): DexFile {
    if (!hasDexMagic(bytes))
      throw new DexFormatError(
        0,
        "The file does not start with the DEX magic.",
      );
    const reader = new DexReader(bytes);
    const magic = reader.take(8, "magic");
    const version = Buffer.from(magic.subarray(4, 7)).toString("latin1");
    const checksum = reader.u4("checksum");
    const signature = hex(reader.take(20, "signature"));
    const fileSize = reader.u4("file_size");
    const headerSize = reader.u4("header_size");
    const endian = reader.u4("endian_tag");
    if (endian === REVERSE_ENDIAN_CONSTANT)
      throw new DexFormatError(
        40,
        "The endian tag marks a big-endian DEX file; Android runtimes read only little-endian DEX.",
      );
    if (endian !== ENDIAN_CONSTANT)
      throw new DexFormatError(
        40,
        `The endian tag is 0x${endian.toString(16)}, not 0x12345678.`,
      );
    const section = (what: string): DexSection => {
      const size = reader.u4(`${what}_size`);
      return { size, offset: reader.u4(`${what}_off`) };
    };
    const link = section("link");
    const mapOffset = reader.u4("map_off");
    const stringIds = section("string_ids");
    const typeIds = section("type_ids");
    const protoIds = section("proto_ids");
    const fieldIds = section("field_ids");
    const methodIds = section("method_ids");
    const classDefs = section("class_defs");
    const data = section("data");
    const container = version >= "041";
    const containerSize = container ? reader.u4("container_size") : null;
    const headerOffset = container ? reader.u4("header_offset") : null;
    const expectedHeader = container ? CONTAINER_HEADER_SIZE : HEADER_SIZE;
    if (headerSize !== expectedHeader)
      throw new DexFormatError(
        36,
        `header_size is ${String(headerSize)}, not ${String(expectedHeader)} for DEX ${version}.`,
      );
    const start = headerOffset ?? 0;
    const covered = bytes.subarray(
      start,
      Math.min(bytes.length, start + fileSize),
    );
    const header: DexHeader = {
      magic_version: version,
      checksum,
      computed_checksum: adler32(covered.subarray(12)),
      signature,
      computed_signature: createHash("sha1")
        .update(covered.subarray(32))
        .digest("hex"),
      file_size: fileSize,
      header_size: headerSize,
      endian_tag: endian,
      link,
      map_offset: mapOffset,
      string_ids: stringIds,
      type_ids: typeIds,
      proto_ids: protoIds,
      field_ids: fieldIds,
      method_ids: methodIds,
      class_defs: classDefs,
      data,
      container_size: containerSize,
      header_offset: headerOffset,
    };
    const file = new DexFile(bytes, header);
    if (fileSize !== bytes.length && containerSize === null)
      file.problems.push({
        offset: 32,
        message: `file_size declares ${String(fileSize)} bytes; the file has ${String(bytes.length)}.`,
      });
    if (!KNOWN_DEX_VERSIONS.includes(version))
      file.problems.push({
        offset: 4,
        message: `DEX version ${version} has no published layout; the header is read as for the newest known version.`,
      });
    if (checksum !== header.computed_checksum)
      file.problems.push({
        offset: 8,
        message: `The Adler-32 checksum is 0x${checksum.toString(16).padStart(8, "0")}; the bytes give 0x${header.computed_checksum.toString(16).padStart(8, "0")}.`,
      });
    if (signature !== header.computed_signature)
      file.problems.push({
        offset: 12,
        message: "The SHA-1 signature does not match the bytes it covers.",
      });
    for (const [name, value, size] of [
      ["string_ids", stringIds, 4],
      ["type_ids", typeIds, 4],
      ["proto_ids", protoIds, 12],
      ["field_ids", fieldIds, 8],
      ["method_ids", methodIds, 8],
      ["class_defs", classDefs, 32],
    ] as const)
      if (!sectionOk(value, size, file.limit))
        throw new DexFormatError(
          value.offset,
          `${name} (${String(value.size)} items at 0x${value.offset.toString(16)}) does not fit in the file.`,
        );
    if (typeIds.size > 0xffff || protoIds.size > 0xffff)
      throw new DexFormatError(
        typeIds.size > 0xffff ? 64 : 72,
        "type_ids and proto_ids hold at most 65535 entries.",
      );
    return file;
  }

  #readMap(): DexMapItem[] {
    const offset = this.header.map_offset;
    if (offset === 0) {
      this.problems.push({ offset: 52, message: "The file has no map list." });
      return [];
    }
    try {
      const reader = new DexReader(this.bytes, offset, this.limit);
      if (offset % 4 !== 0)
        this.problems.push({
          offset,
          message: "The map list is not 4-byte aligned.",
        });
      const size = reader.u4("map size");
      if (size * 12 > reader.remaining)
        throw new DexFormatError(
          offset,
          `The map list declares ${String(size)} items, more than fit in the file.`,
        );
      const items: DexMapItem[] = [];
      for (let index = 0; index < size; index += 1) {
        const type = reader.u2("map item type");
        reader.u2("map item unused");
        const count = reader.u4("map item size");
        const at = reader.u4("map item offset");
        items.push({
          type,
          name:
            MAP_ITEM_TYPES[type] ??
            `unknown_0x${type.toString(16).padStart(4, "0")}`,
          size: count,
          offset: at,
        });
        if (at > this.limit)
          this.problems.push({
            offset: reader.offset - 4,
            message: `Map item ${MAP_ITEM_TYPES[type] ?? type.toString(16)} points past the end of the file.`,
          });
      }
      for (let index = 1; index < items.length; index += 1)
        if ((items[index]?.offset ?? 0) < (items[index - 1]?.offset ?? 0)) {
          this.problems.push({
            offset,
            message: "Map list items are not in offset order.",
          });
          break;
        }
      return items;
    } catch (cause) {
      if (!(cause instanceof DexFormatError)) throw cause;
      this.problems.push({
        offset: cause.offset,
        message: `The map list could not be read: ${cause.message}`,
      });
      return [];
    }
  }

  /** Offset of string `index`'s data, or null when the index or its offset is out of range. */
  stringDataOffset(index: number): number | null {
    if (index < 0 || index >= this.header.string_ids.size) return null;
    const at = this.header.string_ids.offset + index * 4;
    const reader = new DexReader(this.bytes, at, this.limit);
    const offset = reader.u4("string_data_off");
    return offset < this.limit ? offset : null;
  }

  /** String `index` decoded from MUTF-8; null when absent, out of range or malformed. */
  string(index: number): string | null {
    if (index === NO_INDEX || index < 0) return null;
    const cached = this.#strings.get(index);
    if (cached !== undefined || this.#strings.has(index)) return cached ?? null;
    let value: string | null = null;
    const offset = this.stringDataOffset(index);
    if (offset !== null)
      try {
        const reader = new DexReader(this.bytes, offset, this.limit);
        const utf16Size = reader.uleb128("utf16_size");
        const start = reader.offset;
        const end = this.bytes.indexOf(0, start);
        if (end >= 0 && end < this.limit) {
          value = decodeModifiedUtf8(this.bytes.subarray(start, end));
          if (value !== null && value.length !== utf16Size) value = null;
        }
      } catch (cause) {
        if (!(cause instanceof DexFormatError)) throw cause;
      }
    this.#strings.set(index, value);
    return value;
  }

  /** Type descriptor of type `index`. */
  type(index: number): string | null {
    if (index < 0 || index >= this.header.type_ids.size) return null;
    const reader = new DexReader(
      this.bytes,
      this.header.type_ids.offset + index * 4,
      this.limit,
    );
    return this.string(reader.u4("descriptor_idx"));
  }

  /** Type indices of a type_list, or null when its offset is malformed. */
  typeList(offset: number): number[] | null {
    if (offset === 0) return [];
    try {
      const reader = new DexReader(this.bytes, offset, this.limit);
      const size = reader.u4("type_list size");
      if (size * 2 > reader.remaining) return null;
      const indices: number[] = [];
      for (let index = 0; index < size; index += 1)
        indices.push(reader.u2("type_list entry"));
      return indices;
    } catch (cause) {
      if (cause instanceof DexFormatError) return null;
      throw cause;
    }
  }

  proto(index: number): DexProto | null {
    if (index < 0 || index >= this.header.proto_ids.size) return null;
    const reader = new DexReader(
      this.bytes,
      this.header.proto_ids.offset + index * 12,
      this.limit,
    );
    const shorty = reader.u4("shorty_idx");
    const returnType = reader.u4("return_type_idx");
    const parameters = this.typeList(reader.u4("parameters_off"));
    return {
      shorty: this.string(shorty),
      return_type: this.type(returnType),
      parameters: (parameters ?? []).map((entry) => this.type(entry)),
    };
  }

  /** "(II)V"-style descriptor of proto `index`, with "?" for unreadable types. */
  protoDescriptor(index: number): string | null {
    const proto = this.proto(index);
    if (proto === null) return null;
    return `(${proto.parameters.map((entry) => entry ?? "?").join("")})${proto.return_type ?? "?"}`;
  }

  field(index: number): DexFieldId | null {
    if (index < 0 || index >= this.header.field_ids.size) return null;
    const reader = new DexReader(
      this.bytes,
      this.header.field_ids.offset + index * 8,
      this.limit,
    );
    const owner = reader.u2("class_idx");
    const type = reader.u2("type_idx");
    return {
      class: this.type(owner),
      type: this.type(type),
      name: this.string(reader.u4("name_idx")),
    };
  }

  method(index: number): DexMethodId | null {
    if (index < 0 || index >= this.header.method_ids.size) return null;
    const reader = new DexReader(
      this.bytes,
      this.header.method_ids.offset + index * 8,
      this.limit,
    );
    const owner = reader.u2("class_idx");
    const proto = reader.u2("proto_idx");
    return {
      class: this.type(owner),
      proto_index: proto,
      name: this.string(reader.u4("name_idx")),
    };
  }

  classDef(index: number): DexClassDef {
    const offset = this.header.class_defs.offset + index * 32;
    const reader = new DexReader(this.bytes, offset, this.limit);
    return {
      index,
      offset,
      class_idx: reader.u4("class_idx"),
      access_flags: reader.u4("access_flags"),
      superclass_idx: reader.u4("superclass_idx"),
      interfaces_off: reader.u4("interfaces_off"),
      source_file_idx: reader.u4("source_file_idx"),
      annotations_off: reader.u4("annotations_off"),
      class_data_off: reader.u4("class_data_off"),
      static_values_off: reader.u4("static_values_off"),
    };
  }

  get classCount(): number {
    return this.header.class_defs.size;
  }

  /** Fields and methods of a class; index differences are resolved to absolute indices. */
  classData(def: DexClassDef): DexClassData | null {
    if (def.class_data_off === 0) return null;
    const reader = new DexReader(this.bytes, def.class_data_off, this.limit);
    const staticCount = reader.uleb128("static_fields_size");
    const instanceCount = reader.uleb128("instance_fields_size");
    const directCount = reader.uleb128("direct_methods_size");
    const virtualCount = reader.uleb128("virtual_methods_size");
    // Each encoded member needs at least two bytes; refuse counts the bytes cannot hold.
    if (
      (staticCount + instanceCount) * 2 + (directCount + virtualCount) * 3 >
      reader.remaining
    )
      throw new DexFormatError(
        def.class_data_off,
        "class_data_item declares more members than its bytes can hold.",
      );
    const fields = (count: number): DexEncodedField[] => {
      const result: DexEncodedField[] = [];
      let index = 0;
      for (let item = 0; item < count; item += 1) {
        index += reader.uleb128("field_idx_diff");
        result.push({
          field_idx: index,
          access_flags: reader.uleb128("access_flags"),
        });
      }
      return result;
    };
    const methods = (count: number): DexEncodedMethod[] => {
      const result: DexEncodedMethod[] = [];
      let index = 0;
      for (let item = 0; item < count; item += 1) {
        index += reader.uleb128("method_idx_diff");
        result.push({
          method_idx: index,
          access_flags: reader.uleb128("access_flags"),
          code_off: reader.uleb128("code_off"),
        });
      }
      return result;
    };
    return {
      offset: def.class_data_off,
      static_fields: fields(staticCount),
      instance_fields: fields(instanceCount),
      direct_methods: methods(directCount),
      virtual_methods: methods(virtualCount),
    };
  }

  /** The code_item at `offset` with its try blocks and resolved catch handlers. */
  codeItem(offset: number): DexCodeItem {
    if (offset % 4 !== 0)
      throw new DexFormatError(offset, "code_item is not 4-byte aligned.");
    const reader = new DexReader(this.bytes, offset, this.limit);
    const registers = reader.u2("registers_size");
    const ins = reader.u2("ins_size");
    const outs = reader.u2("outs_size");
    const triesSize = reader.u2("tries_size");
    const debugInfo = reader.u4("debug_info_off");
    const insnsSize = reader.u4("insns_size");
    const insnsOffset = reader.offset;
    if (insnsSize * 2 > reader.remaining)
      throw new DexFormatError(
        offset + 12,
        `insns_size ${String(insnsSize)} runs past the end of the file.`,
      );
    reader.seek(insnsOffset + insnsSize * 2, "insns end");
    const tries: DexTry[] = [];
    if (triesSize > 0) {
      if (insnsSize % 2 === 1) reader.u2("padding");
      if (triesSize * 8 > reader.remaining)
        throw new DexFormatError(
          reader.offset,
          "try_item table runs past the end of the file.",
        );
      const raw: { start: number; count: number; handler: number }[] = [];
      for (let index = 0; index < triesSize; index += 1)
        raw.push({
          start: reader.u4("start_addr"),
          count: reader.u2("insn_count"),
          handler: reader.u2("handler_off"),
        });
      const listOffset = reader.offset;
      for (const entry of raw) {
        const handlers: DexCatchHandler[] = [];
        const handler = new DexReader(
          this.bytes,
          listOffset + entry.handler,
          this.limit,
        );
        const size = handler.sleb128("encoded_catch_handler size");
        if (Math.abs(size) * 2 > handler.remaining)
          throw new DexFormatError(
            listOffset + entry.handler,
            "encoded_catch_handler declares more handlers than its bytes can hold.",
          );
        for (let index = 0; index < Math.abs(size); index += 1)
          handlers.push({
            type_idx: handler.uleb128("type_idx"),
            address: handler.uleb128("addr"),
          });
        if (size <= 0)
          handlers.push({
            type_idx: null,
            address: handler.uleb128("catch_all_addr"),
          });
        tries.push({
          start: entry.start,
          count: entry.count,
          handler_offset: entry.handler,
          handlers,
        });
      }
    }
    return {
      offset,
      registers,
      ins,
      outs,
      debug_info_off: debugInfo,
      insns_size: insnsSize,
      insns_offset: insnsOffset,
      tries,
    };
  }

  /** The code units of a code item, copied out of the file. */
  codeUnits(code: DexCodeItem): Uint16Array {
    const units = new Uint16Array(code.insns_size);
    for (let index = 0; index < code.insns_size; index += 1) {
      const at = code.insns_offset + index * 2;
      units[index] = (this.bytes[at] ?? 0) | ((this.bytes[at + 1] ?? 0) << 8);
    }
    return units;
  }

  /**
   * Decode a debug_info_item as ART does: positions from the line state
   * machine, and locals including `this` and named parameters live from 0.
   */
  debugInfo(
    code: DexCodeItem,
    method: {
      readonly class_descriptor: string | null;
      readonly is_static: boolean;
      readonly proto_index: number;
    },
  ): DexDebugInfo | null {
    if (code.debug_info_off === 0) return null;
    const reader = new DexReader(this.bytes, code.debug_info_off, this.limit);
    const lineStart = reader.uleb128("line_start");
    const parameterCount = reader.uleb128("parameters_size");
    if (parameterCount > reader.remaining)
      throw new DexFormatError(
        code.debug_info_off,
        "debug_info_item declares more parameter names than its bytes can hold.",
      );
    const parameterNames: (string | null)[] = [];
    for (let index = 0; index < parameterCount; index += 1)
      parameterNames.push(this.string(reader.uleb128p1("parameter_name")));
    const registers = code.registers;
    type Live = {
      name: string | null;
      type: string | null;
      signature: string | null;
      start: number;
      live: boolean;
    };
    const live: (Live | undefined)[] = new Array<Live | undefined>(registers);
    const locals: DexLocal[] = [];
    const emit = (register: number, entry: Live, end: number) =>
      locals.push({
        register,
        start: entry.start,
        end,
        name: entry.name,
        type: entry.type,
        signature: entry.signature,
      });
    let argument = registers - code.ins;
    if (!method.is_static && argument >= 0 && argument < registers) {
      live[argument] = {
        name: "this",
        type: method.class_descriptor,
        signature: null,
        start: 0,
        live: true,
      };
      argument += 1;
    }
    const parameters = this.proto(method.proto_index)?.parameters ?? [];
    for (let index = 0; index < parameterNames.length; index += 1) {
      const type = parameters[index];
      if (type === undefined || argument >= registers) break;
      live[argument] = {
        name: parameterNames[index] ?? null,
        type,
        signature: null,
        start: 0,
        live: true,
      };
      argument += type === "J" || type === "D" ? 2 : 1;
    }
    const positions: DexPosition[] = [];
    const files: (string | null)[] = [];
    let address = 0;
    let line = lineStart;
    const register = (what: string): number => {
      const value = reader.uleb128(what);
      if (value >= registers)
        throw new DexFormatError(
          reader.offset,
          `Debug info names register ${String(value)} of ${String(registers)}.`,
        );
      return value;
    };
    for (;;) {
      const opcode = reader.u1("debug opcode");
      switch (opcode) {
        case 0x00:
          for (let index = 0; index < registers; index += 1) {
            const entry = live[index];
            if (entry?.live === true) emit(index, entry, code.insns_size);
          }
          return {
            line_start: lineStart,
            parameter_names: parameterNames,
            positions,
            locals,
            files,
          };
        case 0x01:
          address += reader.uleb128("addr_diff");
          break;
        case 0x02:
          line = (line + reader.sleb128("line_diff")) >>> 0;
          break;
        case 0x03:
        case 0x04: {
          const index = register("register_num");
          const previous = live[index];
          // d8 writes generic parameters as an empty range; ART does not report those.
          if (previous?.live === true && address !== 0)
            emit(index, previous, address);
          const name = this.string(reader.uleb128p1("name_idx"));
          const type = this.type(reader.uleb128p1("type_idx"));
          const signature =
            opcode === 0x04 ? this.string(reader.uleb128p1("sig_idx")) : null;
          live[index] = { name, type, signature, start: address, live: true };
          break;
        }
        case 0x05: {
          const index = register("register_num");
          const entry = live[index];
          if (entry?.live === true) {
            emit(index, entry, address);
            entry.live = false;
          }
          break;
        }
        case 0x06: {
          const index = register("register_num");
          const entry = live[index];
          if (entry !== undefined && !entry.live) {
            entry.start = address;
            entry.live = true;
          }
          break;
        }
        case 0x07:
        case 0x08:
          break;
        case 0x09:
          files.push(this.string(reader.uleb128p1("name_idx")));
          break;
        default: {
          const adjusted = opcode - 0x0a;
          address += Math.floor(adjusted / 15);
          line = (line + (adjusted % 15) - 4) >>> 0;
          positions.push({ address, line: line | 0 });
        }
      }
    }
  }

  /** One encoded_value at the reader's position. */
  #value(reader: DexReader, depth: number): DexValue {
    if (depth > MAX_VALUE_DEPTH)
      throw new DexFormatError(
        reader.offset,
        "Encoded values nest too deeply.",
      );
    const header = reader.u1("value header");
    const type = header & 0x1f;
    const argument = header >> 5;
    const unsigned = (size: number): number => {
      let value = 0;
      for (let index = 0; index < size; index += 1)
        value += reader.u1("value byte") * 2 ** (8 * index);
      return value;
    };
    const signed = (size: number): number => {
      const value = unsigned(size);
      const bits = size * 8;
      return value >= 2 ** (bits - 1) ? value - 2 ** bits : value;
    };
    const wide = (size: number, fromRight: boolean): bigint => {
      let value = 0n;
      for (let index = 0; index < size; index += 1)
        value |= BigInt(reader.u1("value byte")) << BigInt(8 * index);
      // Floats and doubles are zero-extended to the right (the low bytes are dropped).
      return fromRight ? value << BigInt(8 * (8 - size)) : value;
    };
    switch (type) {
      case 0x00:
        return { kind: "byte", value: signed(argument + 1) };
      case 0x02:
        return { kind: "short", value: signed(argument + 1) };
      case 0x03:
        return { kind: "char", value: unsigned(argument + 1) };
      case 0x04:
        return { kind: "int", value: signed(argument + 1) | 0 };
      case 0x06:
        return {
          kind: "long",
          value: BigInt.asIntN(
            64,
            BigInt.asIntN((argument + 1) * 8, wide(argument + 1, false)),
          ),
        };
      case 0x10: {
        const bits = Number(wide(argument + 1, true) >> 32n);
        const view = new DataView(new ArrayBuffer(4));
        view.setUint32(0, bits);
        return { kind: "float", value: view.getFloat32(0) };
      }
      case 0x11: {
        const view = new DataView(new ArrayBuffer(8));
        view.setBigUint64(0, wide(argument + 1, true));
        return { kind: "double", value: view.getFloat64(0) };
      }
      case 0x15:
        return { kind: "method_type", index: unsigned(argument + 1) };
      case 0x16:
        return { kind: "method_handle", index: unsigned(argument + 1) };
      case 0x17:
        return { kind: "string", index: unsigned(argument + 1) };
      case 0x18:
        return { kind: "type", index: unsigned(argument + 1) };
      case 0x19:
        return { kind: "field", index: unsigned(argument + 1) };
      case 0x1a:
        return { kind: "method", index: unsigned(argument + 1) };
      case 0x1b:
        return { kind: "enum", index: unsigned(argument + 1) };
      case 0x1c:
        return { kind: "array", values: this.#array(reader, depth + 1) };
      case 0x1d:
        return {
          kind: "annotation",
          annotation: this.#annotation(reader, depth + 1),
        };
      case 0x1e:
        return { kind: "null" };
      case 0x1f:
        return { kind: "boolean", value: argument !== 0 };
      default:
        throw new DexFormatError(
          reader.offset - 1,
          `Encoded value type 0x${type.toString(16)} is not defined.`,
        );
    }
  }

  #array(reader: DexReader, depth: number): DexValue[] {
    const size = reader.uleb128("encoded_array size");
    if (size > reader.remaining)
      throw new DexFormatError(
        reader.offset,
        "encoded_array declares more values than its bytes can hold.",
      );
    const values: DexValue[] = [];
    for (let index = 0; index < size; index += 1)
      values.push(this.#value(reader, depth));
    return values;
  }

  #annotation(reader: DexReader, depth: number): DexAnnotationValue {
    const typeIdx = reader.uleb128("annotation type_idx");
    const size = reader.uleb128("annotation size");
    if (size * 2 > reader.remaining)
      throw new DexFormatError(
        reader.offset,
        "encoded_annotation declares more elements than its bytes can hold.",
      );
    const elements: { name_idx: number; value: DexValue }[] = [];
    for (let index = 0; index < size; index += 1)
      elements.push({
        name_idx: reader.uleb128("element name_idx"),
        value: this.#value(reader, depth),
      });
    return { type_idx: typeIdx, elements };
  }

  /** An encoded_array_item (static values, call sites). */
  encodedArray(offset: number): DexValue[] {
    if (offset === 0) return [];
    return this.#array(new DexReader(this.bytes, offset, this.limit), 0);
  }

  #annotationSet(offset: number): DexAnnotation[] {
    if (offset === 0) return [];
    const reader = new DexReader(this.bytes, offset, this.limit);
    const size = reader.u4("annotation_set size");
    if (size * 4 > reader.remaining)
      throw new DexFormatError(
        offset,
        "annotation_set_item declares more entries than fit in the file.",
      );
    const annotations: DexAnnotation[] = [];
    for (let index = 0; index < size; index += 1) {
      const at = reader.u4("annotation_off");
      const item = new DexReader(this.bytes, at, this.limit);
      const visibility = item.u1("visibility");
      annotations.push({ visibility, ...this.#annotation(item, 0) });
    }
    return annotations;
  }

  /** The annotations_directory_item of a class. */
  annotations(offset: number): DexAnnotationsDirectory | null {
    if (offset === 0) return null;
    const reader = new DexReader(this.bytes, offset, this.limit);
    const classAnnotations = reader.u4("class_annotations_off");
    const fieldCount = reader.u4("fields_size");
    const methodCount = reader.u4("annotated_methods_size");
    const parameterCount = reader.u4("annotated_parameters_size");
    if ((fieldCount + methodCount + parameterCount) * 8 > reader.remaining)
      throw new DexFormatError(
        offset,
        "annotations_directory_item declares more entries than fit in the file.",
      );
    const pairs = (count: number) => {
      const result: [number, number][] = [];
      for (let index = 0; index < count; index += 1)
        result.push([reader.u4("member idx"), reader.u4("annotations_off")]);
      return result;
    };
    const fields = pairs(fieldCount);
    const methods = pairs(methodCount);
    const parameters = pairs(parameterCount);
    return {
      class_annotations: this.#annotationSet(classAnnotations),
      fields: new Map(
        fields.map(([index, at]) => [index, this.#annotationSet(at)]),
      ),
      methods: new Map(
        methods.map(([index, at]) => [index, this.#annotationSet(at)]),
      ),
      parameters: new Map(
        parameters.map(([index, at]) => {
          const list = new DexReader(this.bytes, at, this.limit);
          const size = list.u4("annotation_set_ref_list size");
          if (size * 4 > list.remaining)
            throw new DexFormatError(
              at,
              "annotation_set_ref_list declares more entries than fit in the file.",
            );
          const sets: DexAnnotation[][] = [];
          for (let entry = 0; entry < size; entry += 1)
            sets.push(this.#annotationSet(list.u4("annotations_off")));
          return [index, sets];
        }),
      ),
    };
  }

  /** The encoded array of call site `index` (bootstrap method handle, name, method type, extra arguments). */
  callSite(index: number): DexValue[] | null {
    if (index < 0 || index >= this.call_site_ids.size) return null;
    const reader = new DexReader(
      this.bytes,
      this.call_site_ids.offset + index * 4,
      this.limit,
    );
    return this.encodedArray(reader.u4("call_site_off"));
  }

  methodHandle(index: number): DexMethodHandle | null {
    if (index < 0 || index >= this.method_handles.size) return null;
    const reader = new DexReader(
      this.bytes,
      this.method_handles.offset + index * 8,
      this.limit,
    );
    const type = reader.u2("method_handle_type");
    reader.u2("unused");
    return { type, field_or_method_id: reader.u2("field_or_method_id") };
  }
}
