/**
 * Minimal protocol buffer wire reader for the Android build files this
 * family reads (aapt2's Resources.proto and bundletool's config, commands
 * and targeting messages). Field numbers live with each decoder; this reader
 * only walks the wire format, bounded by the bytes it was given.
 */

/** A malformed or over-deep message at an exact byte offset of its buffer. */
export class ProtobufFormatError extends Error {
  constructor(
    readonly offset: number,
    message: string,
  ) {
    super(message);
    this.name = "ProtobufFormatError";
  }
}

/** Wire types 0 (varint), 1 (64-bit), 2 (length-delimited) and 5 (32-bit); groups are refused. */
export type ProtobufField =
  | { readonly field: number; readonly wire: 0; readonly varint: bigint }
  | { readonly field: number; readonly wire: 1; readonly fixed64: bigint }
  | {
      readonly field: number;
      readonly wire: 2;
      readonly bytes: Uint8Array;
      /** Offset of the payload within the outermost buffer. */
      readonly offset: number;
    }
  | { readonly field: number; readonly wire: 5; readonly fixed32: number };

/** Nested messages deeper than this are refused; real Android files nest far less. */
export const MAX_PROTOBUF_DEPTH = 64;

const readVarint = (
  bytes: Uint8Array,
  at: number,
  base: number,
): [bigint, number] => {
  let value = 0n;
  let shift = 0n;
  for (let index = at; index < bytes.length && shift < 70n; index += 1) {
    const byte = bytes[index] ?? 0;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      if (value > 0xffff_ffff_ffff_ffffn)
        throw new ProtobufFormatError(base + at, "Varint exceeds 64 bits.");
      return [value, index + 1];
    }
    shift += 7n;
  }
  throw new ProtobufFormatError(base + at, "Varint is truncated.");
};

/**
 * Every field of one message in wire order. `base` is the message's offset in
 * the outermost buffer, so nested payloads report absolute offsets.
 */
export const protobufFields = (
  bytes: Uint8Array,
  base = 0,
): ProtobufField[] => {
  const fields: ProtobufField[] = [];
  let at = 0;
  while (at < bytes.length) {
    const [key, afterKey] = readVarint(bytes, at, base);
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (field === 0 || key >> 3n > 0x1fff_ffffn)
      throw new ProtobufFormatError(
        base + at,
        `Field number ${String(key >> 3n)} is not valid.`,
      );
    switch (wire) {
      case 0: {
        const [varint, next] = readVarint(bytes, afterKey, base);
        fields.push({ field, wire, varint });
        at = next;
        break;
      }
      case 1: {
        if (afterKey + 8 > bytes.length)
          throw new ProtobufFormatError(
            base + afterKey,
            "Fixed64 is truncated.",
          );
        const view = new DataView(bytes.buffer, bytes.byteOffset + afterKey, 8);
        fields.push({ field, wire, fixed64: view.getBigUint64(0, true) });
        at = afterKey + 8;
        break;
      }
      case 2: {
        const [length, start] = readVarint(bytes, afterKey, base);
        if (length > BigInt(bytes.length - start))
          throw new ProtobufFormatError(
            base + afterKey,
            `Field ${String(field)} declares ${String(length)} bytes but only ${String(bytes.length - start)} remain.`,
          );
        const end = start + Number(length);
        fields.push({
          field,
          wire,
          bytes: bytes.subarray(start, end),
          offset: base + start,
        });
        at = end;
        break;
      }
      case 5: {
        if (afterKey + 4 > bytes.length)
          throw new ProtobufFormatError(
            base + afterKey,
            "Fixed32 is truncated.",
          );
        const view = new DataView(bytes.buffer, bytes.byteOffset + afterKey, 4);
        fields.push({ field, wire, fixed32: view.getUint32(0, true) });
        at = afterKey + 4;
        break;
      }
      default:
        throw new ProtobufFormatError(
          base + at,
          `Wire type ${String(wire)} (field ${String(field)}) is not admitted.`,
        );
    }
  }
  return fields;
};

const textDecoder = new TextDecoder("utf-8", { fatal: true });

/** Typed accessors over one decoded message; the last value wins for singular fields, as protobuf specifies. */
export class ProtobufMessage {
  readonly fields: readonly ProtobufField[];

  constructor(
    readonly bytes: Uint8Array,
    readonly offset = 0,
    readonly depth = 0,
  ) {
    if (depth > MAX_PROTOBUF_DEPTH)
      throw new ProtobufFormatError(
        offset,
        `Messages nest deeper than ${String(MAX_PROTOBUF_DEPTH)} levels.`,
      );
    this.fields = protobufFields(bytes, offset);
  }

  #last(field: number): ProtobufField | undefined {
    for (let index = this.fields.length - 1; index >= 0; index -= 1) {
      const entry = this.fields[index];
      if (entry?.field === field) return entry;
    }
    return undefined;
  }

  has(field: number): boolean {
    return this.#last(field) !== undefined;
  }

  /** An unsigned varint (uint32/uint64/enum/bool) as a bigint, or null when absent. */
  varint(field: number): bigint | null {
    const entry = this.#last(field);
    if (entry === undefined) return null;
    if (entry.wire !== 0)
      throw new ProtobufFormatError(
        this.offset,
        `Field ${String(field)} is not a varint.`,
      );
    return entry.varint;
  }

  /** uint32/enum as a number; absent fields take the proto3 default 0. */
  uint32(field: number): number {
    return Number(BigInt.asUintN(32, this.varint(field) ?? 0n));
  }

  /** int32 (two's complement, sign-extended to 64 bits on the wire). */
  int32(field: number): number {
    return Number(BigInt.asIntN(32, this.varint(field) ?? 0n));
  }

  int64(field: number): bigint {
    return BigInt.asIntN(64, this.varint(field) ?? 0n);
  }

  bool(field: number): boolean {
    return (this.varint(field) ?? 0n) !== 0n;
  }

  fixed32(field: number): number | null {
    const entry = this.#last(field);
    if (entry === undefined) return null;
    if (entry.wire !== 5)
      throw new ProtobufFormatError(
        this.offset,
        `Field ${String(field)} is not 32-bit.`,
      );
    return entry.fixed32;
  }

  /** A string field; absent fields take the proto3 default "". Invalid UTF-8 is refused. */
  string(field: number): string {
    const entry = this.#last(field);
    if (entry === undefined) return "";
    if (entry.wire !== 2)
      throw new ProtobufFormatError(
        this.offset,
        `Field ${String(field)} is not length-delimited.`,
      );
    try {
      return textDecoder.decode(entry.bytes);
    } catch {
      throw new ProtobufFormatError(
        entry.offset,
        `Field ${String(field)} is not valid UTF-8.`,
      );
    }
  }

  /** Repeated string values in wire order. */
  strings(field: number): string[] {
    return this.fields
      .filter((entry) => entry.field === field)
      .map((entry) => {
        if (entry.wire !== 2)
          throw new ProtobufFormatError(
            this.offset,
            `Field ${String(field)} is not length-delimited.`,
          );
        try {
          return textDecoder.decode(entry.bytes);
        } catch {
          throw new ProtobufFormatError(
            entry.offset,
            `Field ${String(field)} is not valid UTF-8.`,
          );
        }
      });
  }

  /** Raw bytes of a length-delimited field, or null when absent. */
  rawBytes(field: number): Uint8Array | null {
    const entry = this.#last(field);
    if (entry === undefined) return null;
    if (entry.wire !== 2)
      throw new ProtobufFormatError(
        this.offset,
        `Field ${String(field)} is not length-delimited.`,
      );
    return entry.bytes;
  }

  /** A singular embedded message, or null when absent. */
  message(field: number): ProtobufMessage | null {
    const entry = this.#last(field);
    if (entry === undefined) return null;
    if (entry.wire !== 2)
      throw new ProtobufFormatError(
        this.offset,
        `Field ${String(field)} is not a message.`,
      );
    return new ProtobufMessage(entry.bytes, entry.offset, this.depth + 1);
  }

  /** Repeated embedded messages in wire order. */
  messages(field: number): ProtobufMessage[] {
    return this.fields
      .filter((entry) => entry.field === field)
      .map((entry) => {
        if (entry.wire !== 2)
          throw new ProtobufFormatError(
            this.offset,
            `Field ${String(field)} is not a message.`,
          );
        return new ProtobufMessage(entry.bytes, entry.offset, this.depth + 1);
      });
  }

  /** Repeated varints, accepting both packed and unpacked encodings. */
  varints(field: number): bigint[] {
    const values: bigint[] = [];
    for (const entry of this.fields) {
      if (entry.field !== field) continue;
      if (entry.wire === 0) values.push(entry.varint);
      else if (entry.wire === 2) {
        let at = 0;
        while (at < entry.bytes.length) {
          const [value, next] = readVarint(entry.bytes, at, entry.offset);
          values.push(value);
          at = next;
        }
      } else
        throw new ProtobufFormatError(
          this.offset,
          `Field ${String(field)} is not a varint.`,
        );
    }
    return values;
  }
}
