import {
  createFileRegistry,
  fromBinary,
  ScalarType,
  type DescField,
  type DescEnum,
  type DescMessage,
} from "@bufbuild/protobuf";
import {
  FileDescriptorSetSchema,
  type FileDescriptorSet,
} from "@bufbuild/protobuf/wkt";
import { BinaryReader } from "@bufbuild/protobuf/wire";
import type { ProtobufField } from "../../../domain/protobufWire.js";
import { WEB_NETWORK_CAPTURE_LIMITS } from "../../../domain/webNetworkCapture.js";
import { CaptureFormatError } from "../CaptureFormatError.js";
import {
  decodeProtobufWire,
  readProtobufVarint,
  type ProtobufBudget,
  type WireSchema,
} from "./ProtobufWire.js";

const scalarWire = (scalar: ScalarType): ProtobufField["wire_type"] => {
  if (scalar === ScalarType.STRING || scalar === ScalarType.BYTES) return "len";
  if (
    [ScalarType.DOUBLE, ScalarType.FIXED64, ScalarType.SFIXED64].includes(
      scalar,
    )
  )
    return "i64";
  if (
    [ScalarType.FLOAT, ScalarType.FIXED32, ScalarType.SFIXED32].includes(scalar)
  )
    return "i32";
  return "varint";
};

const floatingValue = (value: number): string =>
  Object.is(value, -0) ? "-0" : String(value);

/** Qualified names can expand a small descriptor into a much larger registry. */
const chargeRegistryExpansion = async (
  descriptor: FileDescriptorSet,
  budget: ProtobufBudget,
): Promise<void> => {
  for (const file of descriptor.file) {
    budget.charge(file.name.length * 8 + 128);
    const stack = file.messageType.map((message) => ({
      message,
      prefix: file.package.length,
    }));
    const chargeQualifiedName = (name: string, prefix: number) =>
      budget.charge((prefix + 1 + name.length) * 8 + 128);
    for (const enumeration of file.enumType)
      chargeQualifiedName(enumeration.name, file.package.length);
    for (const extension of file.extension)
      chargeQualifiedName(extension.name, file.package.length);
    for (const service of file.service) {
      const length = file.package.length + 1 + service.name.length;
      budget.charge(length * 8 + 128);
      for (const method of service.method)
        chargeQualifiedName(method.name, length);
    }
    while (stack.length > 0) {
      await budget.checkpoint();
      const { message, prefix } = stack.pop()!;
      const length = prefix + 1 + message.name.length;
      budget.charge(length * 8 + 128);
      for (const field of message.field)
        chargeQualifiedName(field.name, length);
      for (const extension of message.extension)
        chargeQualifiedName(extension.name, length);
      for (const enumeration of message.enumType)
        chargeQualifiedName(enumeration.name, length);
      for (const nested of message.nestedType)
        stack.push({ message: nested, prefix: length });
    }
  }
};

const scalarValue = (reader: BinaryReader, scalar: ScalarType): string => {
  switch (scalar) {
    case ScalarType.DOUBLE:
      return floatingValue(reader.double());
    case ScalarType.FLOAT:
      return floatingValue(reader.float());
    case ScalarType.INT64:
      return String(reader.int64());
    case ScalarType.UINT64:
      return String(reader.uint64());
    case ScalarType.INT32:
      return String(reader.int32());
    case ScalarType.FIXED64:
      return String(reader.fixed64());
    case ScalarType.FIXED32:
      return String(reader.fixed32());
    case ScalarType.BOOL:
      return String(reader.bool());
    case ScalarType.UINT32:
      return String(reader.uint32());
    case ScalarType.SFIXED32:
      return String(reader.sfixed32());
    case ScalarType.SFIXED64:
      return String(reader.sfixed64());
    case ScalarType.SINT32:
      return String(reader.sint32());
    case ScalarType.SINT64:
      return String(reader.sint64());
    default:
      throw new Error("Not a numeric protobuf scalar");
  }
};

/** The supplied schema interprets occurrences; it never overwrites raw wire facts. */
export class ProtobufSchema implements WireSchema {
  readonly #fields = new Map<DescMessage, ReadonlyMap<number, DescField>>();
  readonly #messages = new Map<number, DescMessage>();
  readonly #enums = new WeakMap<
    DescEnum,
    ReadonlyMap<string, readonly string[]>
  >();
  constructor(
    readonly message: DescMessage,
    readonly budget: ProtobufBudget,
    readonly redact: (text: string) => string,
  ) {}

  static async read(
    bytes: Uint8Array,
    typeName: string,
    budget: ProtobufBudget,
    redact: (text: string) => string,
  ): Promise<ProtobufSchema> {
    // Bound the object expansion of the descriptor before the SDK allocates its message tree.
    const checked = await decodeProtobufWire(
      bytes,
      0,
      bytes.length,
      0,
      budget,
      redact,
      new ProtobufSchema(FileDescriptorSetSchema, budget, redact),
    );
    if (
      checked.error !== undefined ||
      checked.fields.some((field) => field.schema_status === "invalid-message")
    )
      throw new Error("Malformed FileDescriptorSet wire format");
    const descriptor = fromBinary(FileDescriptorSetSchema, bytes, {
      readUnknownFields: false,
      recursionLimit: WEB_NETWORK_CAPTURE_LIMITS.depth,
    });
    await chargeRegistryExpansion(descriptor, budget);
    const message = createFileRegistry(descriptor).getMessage(
      typeName.replace(/^\./, ""),
    );
    if (message === undefined)
      throw new Error(
        "The supplied descriptor set does not define the selected message type",
      );
    return new ProtobufSchema(message, budget, redact);
  }

  reset(): void {
    this.#messages.clear();
  }

  nested(field: ProtobufField): boolean {
    return this.#messages.has(field.index);
  }

  async annotate(
    field: ProtobufField,
    bytes: Uint8Array,
    parent: ProtobufField | undefined,
  ): Promise<void> {
    const message =
      parent === undefined ? this.message : this.#messages.get(parent.index);
    if (message === undefined) return;
    let fields = this.#fields.get(message);
    if (fields === undefined) {
      fields = new Map(message.fields.map((item) => [item.number, item]));
      this.#fields.set(message, fields);
    }
    const desc = fields.get(field.number);
    if (desc === undefined) {
      field.schema_status = "unknown-field";
      return;
    }
    this.budget.charge(
      8 *
        (desc.name.length +
          (desc.message?.typeName.length ?? 0) +
          (desc.enum?.typeName.length ?? 0)),
    );
    field.schema_name = this.redact(desc.name);
    field.schema_status = "decoded";
    if (desc.fieldKind === "map") {
      field.schema_type = "map";
      field.schema_status = "unsupported";
      return;
    }
    if (desc.message !== undefined) {
      field.schema_type = this.redact(desc.message.typeName);
      const expected = desc.delimitedEncoding ? "group" : "len";
      if (field.wire_type !== expected)
        field.schema_status = "wire-type-mismatch";
      else this.#messages.set(field.index, desc.message);
      return;
    }
    const scalar = desc.enum === undefined ? desc.scalar : ScalarType.INT32;
    if (scalar === undefined) {
      field.schema_status = "unsupported";
      return;
    }
    field.schema_type =
      desc.enum === undefined
        ? ScalarType[scalar].toLowerCase()
        : this.redact(desc.enum.typeName);
    const packed =
      desc.fieldKind === "list" &&
      field.wire_type === "len" &&
      scalar !== ScalarType.STRING &&
      scalar !== ScalarType.BYTES;
    if (!packed && field.wire_type !== scalarWire(scalar)) {
      field.schema_status = "wire-type-mismatch";
      return;
    }
    const payload = bytes.subarray(
      field.payload_offset,
      field.payload_offset + field.payload_bytes,
    );
    try {
      if (scalar === ScalarType.BYTES) return; // Exact bytes already have an accessible source range.
      if (scalar === ScalarType.STRING) {
        // Wire decoding owns UTF-8 (including BOM) and literal exclusions.
        // Reuse that fact; charge only its additional serialized representation.
        this.budget.charge(payload.length * 6);
        if (field.text === undefined)
          field.schema_status = "wire-type-mismatch";
        else field.schema_value = field.text;
        return;
      }
      const reader = new BinaryReader(payload);
      const enumValues = new Map<string, readonly string[]>();
      const read = () => {
        if (
          scalarWire(scalar) === "varint" &&
          readProtobufVarint(payload, reader.pos) === undefined
        )
          throw new Error("Invalid packed varint");
        const value = scalarValue(reader, scalar);
        if (desc.enum !== undefined) {
          let names = this.#enums.get(desc.enum);
          if (names === undefined) {
            this.budget.charge(desc.enum.values.length * 256);
            const indexed = new Map<string, string[]>();
            for (const item of desc.enum.values) {
              const number = String(item.number);
              const aliases = indexed.get(number) ?? [];
              aliases.push(item.name);
              indexed.set(number, aliases);
            }
            names = indexed;
            this.#enums.set(desc.enum, names);
          }
          const aliases = names.get(value);
          if (aliases !== undefined && !enumValues.has(value)) {
            this.budget.charge(
              256 + aliases.reduce((sum, name) => sum + name.length * 8, 0),
            );
            enumValues.set(value, aliases.map(this.redact));
          }
        }
        return value;
      };
      if (packed) {
        const values: string[] = [];
        while (reader.pos < reader.len) {
          await this.budget.checkpoint();
          this.budget.charge(192);
          values.push(this.redact(read()));
        }
        field.schema_value = JSON.stringify(values);
      } else field.schema_value = this.redact(read());
      if (enumValues.size > 0)
        field.schema_enum_values = [...enumValues].map(([number, names]) => ({
          number: this.redact(number),
          names: [...names],
        }));
    } catch (cause) {
      if (cause instanceof CaptureFormatError) throw cause;
      if (this.budget.signal?.aborted && cause === this.budget.signal.reason)
        throw cause;
      field.schema_status = "wire-type-mismatch";
    }
  }
}
