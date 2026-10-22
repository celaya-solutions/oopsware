import { TextDecoder } from "node:util";
import { setImmediate } from "node:timers/promises";
import type { JsonValue } from "../domain/jsonValue.js";
import type {
  ModelMetadata,
  ModelTensor,
} from "../domain/model/modelArtifact.js";
import { ModelHeaderReader } from "./ModelHeaderReader.js";
import {
  MODEL_ARRAY_PREVIEW,
  ModelFormatFailure,
  ModelReportBudget,
  rejectModel,
} from "./ModelFormat.js";
import { ggmlType } from "./ModelTensorTypes.js";

const NAMES = [
  "UINT8",
  "INT8",
  "UINT16",
  "INT16",
  "UINT32",
  "INT32",
  "FLOAT32",
  "BOOL",
  "STRING",
  "ARRAY",
  "UINT64",
  "INT64",
  "FLOAT64",
] as const;
const WIDTHS = [1, 1, 2, 2, 4, 4, 4, 1, 8, 12, 8, 8, 8];

/** Explicit-endian GGUF v2/v3 metadata and tensor-directory parser. */
export class GgufHeader {
  #little = true;
  readonly #budget = new ModelReportBudget();
  constructor(readonly reader: ModelHeaderReader) {}

  async #unsigned(width: 4 | 8): Promise<number> {
    const b = await this.reader.take(width);
    const value =
      width === 4
        ? BigInt(this.#little ? b.readUInt32LE() : b.readUInt32BE())
        : this.#little
          ? b.readBigUInt64LE()
          : b.readBigUInt64BE();
    if (value > BigInt(Number.MAX_SAFE_INTEGER))
      throw new ModelFormatFailure(
        "capacity",
        "Header length/count exceeds exact host offset precision",
      );
    return Number(value);
  }

  async #text(retain: boolean, maximum?: number): Promise<string> {
    const length = await this.#unsigned(8);
    if (maximum !== undefined && length > maximum)
      rejectModel("GGUF name exceeds its format byte limit");
    if (retain) this.#budget.charge(6 * length + 2);
    this.reader.guarantee(length);
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    let result = "";
    try {
      for (let left = length; left > 0;) {
        const n = Math.min(left, 65536);
        const text = decoder.decode(await this.reader.take(n), {
          stream: true,
        });
        if (retain) result += text;
        left -= n;
      }
      const tail = decoder.decode();
      if (retain) result += tail;
    } catch (cause) {
      if (cause instanceof TypeError)
        rejectModel("GGUF string is not valid UTF-8");
      throw cause;
    }
    return result;
  }

  async #value(
    type: number,
    retain: boolean,
    depth = 0,
  ): Promise<{
    value: JsonValue;
    element_type: string | null;
    element_count: number | null;
    complete: boolean;
  }> {
    if (NAMES[type] === undefined)
      rejectModel(`Unknown GGUF metadata type ${String(type)}`);
    if (depth > 32)
      throw new ModelFormatFailure(
        "capacity",
        "GGUF metadata nesting exceeds 32 array frames",
      );
    if (type === 8)
      return {
        value: await this.#text(retain),
        element_type: null,
        element_count: null,
        complete: true,
      };
    if (type === 9) {
      const element = await this.#unsigned(4);
      const count = await this.#unsigned(8);
      const minimum = WIDTHS[element];
      if (minimum === undefined)
        rejectModel(`Unknown GGUF array element type ${String(element)}`);
      this.reader.guarantee(count * minimum);
      const preview: JsonValue[] = [];
      if (retain)
        this.#budget.charge(128 + Math.min(count, MODEL_ARRAY_PREVIEW) * 64);
      let complete = count <= MODEL_ARRAY_PREVIEW;
      for (let index = 0; index < count; index++) {
        if (index % 4096 === 4095) await setImmediate();
        this.reader.guarantee((count - index) * minimum);
        if (
          element !== 8 &&
          element !== 9 &&
          (!retain || index >= MODEL_ARRAY_PREVIEW)
        ) {
          let left = (count - index) * minimum;
          while (left > 0) {
            const size = Math.min(left, 65536);
            const bytes = await this.reader.take(size);
            if (element === 7 && bytes.some((byte) => byte !== 0 && byte !== 1))
              rejectModel("GGUF boolean must be 0 or 1");
            left -= size;
          }
          break;
        }
        const keep = retain && index < MODEL_ARRAY_PREVIEW;
        const value = await this.#value(element, keep, depth + 1);
        if (keep)
          preview.push(
            element === 9
              ? {
                  type: "ARRAY",
                  element_type: value.element_type,
                  element_count: value.element_count,
                  preview: value.value,
                  preview_complete: value.complete,
                }
              : value.value,
          );
        complete &&= value.complete;
      }
      return {
        value: preview,
        element_type: NAMES[element] ?? null,
        element_count: count,
        complete,
      };
    }
    const b = await this.reader.take(WIDTHS[type] ?? 0);
    let value: JsonValue;
    switch (type) {
      case 0:
        value = b.readUInt8();
        break;
      case 1:
        value = b.readInt8();
        break;
      case 2:
        value = this.#little ? b.readUInt16LE() : b.readUInt16BE();
        break;
      case 3:
        value = this.#little ? b.readInt16LE() : b.readInt16BE();
        break;
      case 4:
        value = this.#little ? b.readUInt32LE() : b.readUInt32BE();
        break;
      case 5:
        value = this.#little ? b.readInt32LE() : b.readInt32BE();
        break;
      case 6:
        value = this.#little ? b.readFloatLE() : b.readFloatBE();
        break;
      case 7:
        if (b[0] !== 0 && b[0] !== 1)
          rejectModel("GGUF boolean must be 0 or 1");
        value = b[0] === 1;
        break;
      case 10:
        value = (
          this.#little ? b.readBigUInt64LE() : b.readBigUInt64BE()
        ).toString();
        break;
      case 11:
        value = (
          this.#little ? b.readBigInt64LE() : b.readBigInt64BE()
        ).toString();
        break;
      case 12:
        value = this.#little ? b.readDoubleLE() : b.readDoubleBE();
        break;
      default:
        return rejectModel("Unsupported GGUF scalar");
    }
    if (Object.is(value, -0)) value = "-0";
    if (typeof value === "number" && !Number.isFinite(value))
      value = Number.isNaN(value)
        ? "NaN"
        : value > 0
          ? "+Infinity"
          : "-Infinity";
    return {
      value: retain ? value : null,
      element_type: null,
      element_count: null,
      complete: true,
    };
  }

  async read(): Promise<{
    version: number;
    byte_order: "little" | "big";
    alignment: number;
    tensor_data_offset: number;
    metadata: ModelMetadata[];
    tensors: ModelTensor[];
  }> {
    const versionBytes = await this.reader.take(4);
    this.#little =
      versionBytes.readUInt32LE() === 2 || versionBytes.readUInt32LE() === 3;
    const version = this.#little
      ? versionBytes.readUInt32LE()
      : versionBytes.readUInt32BE();
    if (version !== 2 && version !== 3)
      throw new ModelFormatFailure(
        "unsupported",
        `GGUF version ${String(version)} is unsupported; supported versions are 2 and 3`,
      );
    if (!this.#little && version !== 3)
      rejectModel("Big-endian GGUF requires version 3");
    const tensorCount = await this.#unsigned(8);
    const metadataCount = await this.#unsigned(8);
    this.#budget.charge((tensorCount + metadataCount) * 512);
    this.reader.guarantee(tensorCount * 20 + metadataCount * 13);
    const metadata: ModelMetadata[] = [];
    const keys = new Set<string>();
    let alignment = 32;
    for (let index = 0; index < metadataCount; index++) {
      this.reader.guarantee((metadataCount - index) * 13 + tensorCount * 20);
      const start = this.reader.position;
      const key = await this.#text(true, 65535);
      // Numeric hierarchy components occur in standardized base_model.{id} keys.
      if (
        !/^[a-z0-9]+(?:_[a-z0-9]+)*(?:\.[a-z0-9]+(?:_[a-z0-9]+)*)*$/u.test(key)
      )
        rejectModel(
          "GGUF metadata keys require ASCII lower-snake-case hierarchy components",
        );
      if (keys.has(key)) rejectModel(`Duplicate GGUF metadata key ${key}`);
      keys.add(key);
      const type = await this.#unsigned(4);
      const parsed = await this.#value(type, true);
      metadata.push({
        index,
        key,
        type: NAMES[type] ?? String(type),
        value: parsed.value,
        element_type: parsed.element_type,
        element_count: parsed.element_count,
        preview_complete: parsed.complete,
        source_offset: start,
        source_length: this.reader.position - start,
        json_pointer: null,
      });
      if (key === "general.alignment") {
        if (
          type !== 4 ||
          typeof parsed.value !== "number" ||
          parsed.value === 0 ||
          parsed.value % 8 !== 0
        )
          rejectModel(
            "GGUF general.alignment must be a positive UINT32 multiple of eight",
          );
        alignment = parsed.value;
      }
    }
    const tensors: ModelTensor[] = [];
    const names = new Set<string>();
    for (let index = 0; index < tensorCount; index++) {
      this.reader.guarantee((tensorCount - index) * 20);
      const start = this.reader.position;
      const name = await this.#text(true, 64);
      if (names.has(name)) rejectModel(`Duplicate GGUF tensor name ${name}`);
      names.add(name);
      const dimensions = await this.#unsigned(4);
      if (dimensions > 4)
        rejectModel("GGUF tensor dimension count must be at most 4");
      const shape: string[] = [];
      let parameters = 1n;
      for (let d = 0; d < dimensions; d++) {
        const b = await this.reader.take(8);
        const value = this.#little ? b.readBigUInt64LE() : b.readBigUInt64BE();
        shape.push(value.toString());
        parameters *= value;
      }
      const id = await this.#unsigned(4);
      const offset = await this.#unsigned(8);
      if (offset % alignment !== 0)
        rejectModel(`GGUF tensor ${name} offset is not aligned`);
      const type = ggmlType(id);
      let length: number | null = null;
      if (type !== undefined) {
        if (BigInt(shape[0] ?? "1") % BigInt(type[1]) !== 0n)
          rejectModel(
            `GGUF tensor ${name} first dimension is not divisible by the quantization block size`,
          );
        const bytes = (parameters / BigInt(type[1])) * BigInt(type[2]);
        if (bytes > BigInt(this.reader.size))
          rejectModel(
            `GGUF tensor ${name} declared byte length exceeds the file`,
          );
        length = Number(bytes);
      }
      tensors.push({
        index,
        name,
        type: type?.[0] ?? `UNKNOWN_${String(id)}`,
        type_id: id,
        shape,
        data_offset: offset,
        file_offset: 0,
        byte_length: length,
        parameter_count: parameters.toString(),
        byte_length_state: length === null ? "unknown" : "derived",
        storage_validation: length === null ? "unknown" : "consistent",
        source_offset: start,
        source_length: this.reader.position - start,
        json_pointer: null,
      });
    }
    const tensor_data_offset =
      tensorCount === 0
        ? this.reader.position
        : Math.ceil(this.reader.position / alignment) * alignment;
    for (const tensor of tensors) {
      const offset = BigInt(tensor_data_offset) + BigInt(tensor.data_offset);
      if (
        offset > BigInt(this.reader.size) ||
        offset + BigInt(tensor.byte_length ?? 0) > BigInt(this.reader.size)
      )
        rejectModel(`GGUF tensor ${tensor.name} range is outside the file`);
      tensor.file_offset = Number(offset);
    }
    return {
      version,
      byte_order: this.#little ? "little" : "big",
      alignment,
      tensor_data_offset,
      metadata,
      tensors,
    };
  }
}
