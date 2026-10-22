import { setImmediate } from "node:timers/promises";
import type { ProtobufField } from "../../../domain/protobufWire.js";
import { CaptureFormatError } from "../CaptureFormatError.js";
import { WEB_NETWORK_CAPTURE_LIMITS } from "../../../domain/webNetworkCapture.js";

/** One charge covers all selected records, including temporary interpretation strings. */
export class ProtobufBudget {
  #remaining = WEB_NETWORK_CAPTURE_LIMITS.outputBytes;
  #work = 0;
  constructor(readonly signal?: AbortSignal) {}
  charge(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.#remaining)
      throw new CaptureFormatError(
        "limit",
        "Protobuf decoding exceeds the shared 96 MiB encoded-result and working-set budget.",
      );
    this.#remaining -= bytes;
  }
  async checkpoint(): Promise<void> {
    this.signal?.throwIfAborted();
    if (++this.#work % 256 === 0) {
      await setImmediate();
      this.signal?.throwIfAborted();
    }
  }
}

/** Reject overflowing uint64s before conversion; never wrap malformed bytes. */
export const readProtobufVarint = (
  bytes: Uint8Array,
  start: number,
  end = bytes.length,
): { value: bigint; end: number } | undefined => {
  let value = 0n;
  for (let index = 0; index < 10 && start + index < end; index++) {
    const byte = bytes[start + index]!;
    if (index === 9 && byte > 1) return undefined;
    value |= BigInt(byte & 127) << BigInt(index * 7);
    if (byte < 128) return { value, end: start + index + 1 };
  }
  return undefined;
};

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const textOf = (bytes: Uint8Array): string | undefined => {
  try {
    return utf8.decode(bytes);
  } catch {
    return undefined;
  }
};

/** An allocation-free syntactic candidate check, not a claim about the payload's type. */
const messageCandidate = async (
  bytes: Uint8Array,
  start: number,
  end: number,
  budget: ProtobufBudget,
): Promise<boolean> => {
  if (start === end) return true;
  while (start < end) {
    await budget.checkpoint();
    const tag = readProtobufVarint(bytes, start, end);
    if (
      tag === undefined ||
      tag.value >> 3n === 0n ||
      tag.value >> 3n > 0x1fffffffn
    )
      return false;
    const type = Number(tag.value & 7n);
    start = tag.end;
    if (type === 0) {
      const value = readProtobufVarint(bytes, start, end);
      if (value === undefined) return false;
      start = value.end;
    } else if (type === 1 || type === 5) start += type === 1 ? 8 : 4;
    else if (type === 2) {
      const size = readProtobufVarint(bytes, start, end);
      if (size === undefined || size.value > BigInt(end - size.end))
        return false;
      start = size.end + Number(size.value);
    } else return false;
  }
  return start === end;
};

const packedVarintCandidate = async (
  bytes: Uint8Array,
  start: number,
  end: number,
  budget: ProtobufBudget,
): Promise<boolean> => {
  while (start < end) {
    await budget.checkpoint();
    const value = readProtobufVarint(bytes, start, end);
    if (value === undefined) return false;
    start = value.end;
  }
  return true;
};

export interface WireSchema {
  annotate(
    field: ProtobufField,
    bytes: Uint8Array,
    parent: ProtobufField | undefined,
  ): void | Promise<void>;
  nested(field: ProtobufField): boolean;
}

/** Decode one message into flat occurrence facts with offsets in the decoded body. */
export const decodeProtobufWire = async (
  bytes: Uint8Array,
  start: number,
  end: number,
  frameIndex: number,
  budget: ProtobufBudget,
  redact: (text: string) => string,
  schema?: WireSchema,
  baseIndex = 0,
): Promise<{
  fields: ProtobufField[];
  examined_bytes: number;
  error?: { offset: number; reason: string };
}> => {
  const fields: ProtobufField[] = [];
  const walk = async (
    from: number,
    until: number,
    parent: ProtobufField | undefined,
    depth: number,
    group?: number,
  ): Promise<{
    end: number;
    payloadEnd?: number;
    error?: { offset: number; reason: string };
  }> => {
    let at = from;
    const fail = (reason: string) => ({
      end: at,
      error: { offset: at, reason },
    });
    while (at < until) {
      await budget.checkpoint();
      const tag = readProtobufVarint(bytes, at, until);
      if (tag === undefined) return fail("Truncated or overflowing field tag");
      const number = Number(tag.value >> 3n);
      const type = Number(tag.value & 7n);
      if (number === 0 || tag.value >> 3n > 0x1fffffffn)
        return fail("Invalid field number");
      if (type === 4)
        return group === number
          ? { end: tag.end, payloadEnd: at }
          : fail("Unexpected or mismatched end-group tag");
      let payloadOffset = tag.end;
      let next: number;
      let value: string | undefined;
      if (type === 0) {
        const parsed = readProtobufVarint(bytes, tag.end, until);
        if (parsed === undefined)
          return fail("Truncated or overflowing uint64 varint");
        next = parsed.end;
        value = parsed.value.toString();
      } else if (type === 1 || type === 5) {
        next = tag.end + (type === 1 ? 8 : 4);
        if (next > until) return fail("Truncated fixed-width field");
        let integer = 0n;
        for (let p = next - 1; p >= tag.end; p--)
          integer = (integer << 8n) | BigInt(bytes[p]!);
        value = integer.toString();
      } else if (type === 2) {
        const length = readProtobufVarint(bytes, tag.end, until);
        if (length === undefined)
          return fail("Truncated or overflowing length prefix");
        if (length.value > BigInt(until - length.end))
          return fail("Length-delimited field exceeds its message");
        payloadOffset = length.end;
        next = payloadOffset + Number(length.value);
      } else if (type === 3) {
        if (depth >= WEB_NETWORK_CAPTURE_LIMITS.depth)
          return fail("Group nesting exceeds the 64-level decoder budget");
        next = tag.end;
      } else return fail(`Invalid wire type ${type}`);
      budget.charge(1024);
      const field: ProtobufField = {
        index: baseIndex + fields.length,
        frame_index: frameIndex,
        parent_index: parent?.index ?? null,
        field_id: `offset:${at}`,
        parent_field_id:
          parent === undefined ? null : `offset:${parent.offset}`,
        number,
        wire_type:
          type === 0
            ? "varint"
            : type === 1
              ? "i64"
              : type === 2
                ? "len"
                : type === 3
                  ? "group"
                  : "i32",
        offset: at,
        bytes: next - at,
        payload_offset: payloadOffset,
        payload_bytes: next - payloadOffset,
        ...(value === undefined ? {} : { value: redact(value) }),
      };
      fields.push(field);
      if (type === 2) {
        // Account for UTF-16 allocation and JSON escaping before decoding any string.
        budget.charge(field.payload_bytes * 8);
        const text = textOf(bytes.subarray(payloadOffset, next));
        const candidate = await messageCandidate(
          bytes,
          payloadOffset,
          next,
          budget,
        );
        const packed = await packedVarintCandidate(
          bytes,
          payloadOffset,
          next,
          budget,
        );
        field.interpretations = [
          ...(text === undefined ? [] : ["utf8-string" as const]),
          ...(candidate ? ["nested-message" as const] : []),
          ...(packed ? ["packed-varint" as const] : []),
          ...(field.payload_bytes % 4 === 0 ? ["packed-fixed32" as const] : []),
          ...(field.payload_bytes % 8 === 0 ? ["packed-fixed64" as const] : []),
          "bytes",
        ];
        if (text !== undefined) field.text = redact(text);
      }
      if (schema !== undefined) await schema.annotate(field, bytes, parent);
      if (type === 3) {
        const nested = await walk(tag.end, until, field, depth + 1, number);
        field.bytes = nested.end - at;
        field.payload_bytes = (nested.payloadEnd ?? nested.end) - payloadOffset;
        if (nested.error !== undefined) return nested;
        next = nested.end;
      } else if (type === 2 && schema?.nested(field)) {
        const error =
          depth >= WEB_NETWORK_CAPTURE_LIMITS.depth
            ? {
                offset: payloadOffset,
                reason:
                  "Schema message nesting exceeds the 64-level decoder budget",
              }
            : (await walk(payloadOffset, next, field, depth + 1)).error;
        // The outer length is an observed boundary. A bad interpretation of its
        // payload must never hide valid fields following that boundary.
        if (error !== undefined) {
          field.schema_status = "invalid-message";
          field.schema_error = error;
        }
      }
      at = next;
    }
    return group === undefined ? { end: at } : fail("Missing end-group tag");
  };
  const result = await walk(start, end, undefined, 0);
  return {
    fields,
    examined_bytes: result.end - start,
    ...(result.error === undefined ? {} : { error: result.error }),
  };
};
