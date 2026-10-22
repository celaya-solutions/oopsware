import { ClassFormatError, type ClassReader } from "./ClassReader.js";
import type { ConstantPool } from "./constantPool.js";
import { binaryName, fieldTypeText } from "./descriptors.js";

/** One annotation as written in the class file, rendered Java-like. */
export interface Annotation {
  /** Field descriptor of the annotation interface, e.g. `Ljava/lang/Deprecated;`. */
  readonly type: string | null;
  /** `RuntimeVisible*` (true) or `RuntimeInvisible*` (false). */
  readonly visible: boolean;
  readonly text: string;
}

/** Nesting this deep is far past real annotations and is refused, not recursed. */
const MAX_DEPTH = 64;

const typeText = (descriptor: string | null): string =>
  descriptor === null ? "?" : (fieldTypeText(descriptor) ?? descriptor);

const constantValue = (
  pool: ConstantPool,
  tag: string,
  index: number,
): string => {
  if (tag === "s") {
    const value = pool.utf8(index);
    return value === null ? "?" : JSON.stringify(value);
  }
  const loaded = pool.constantText(index);
  if (loaded === null) return "?";
  if (tag === "Z") return loaded.value === "0" ? "false" : "true";
  if (tag === "C") {
    const code = Number(loaded.value);
    return Number.isInteger(code) ? `'${String.fromCharCode(code)}'` : "?";
  }
  if (tag === "J") return loaded.value.replace(/l$/u, "L");
  return loaded.value;
};

/** Read one element_value (JVMS 4.7.16.1) and render it. */
export const readElementValue = (
  reader: ClassReader,
  pool: ConstantPool,
  depth = 0,
): string => {
  if (depth > MAX_DEPTH)
    throw new ClassFormatError(
      reader.offset,
      "Annotation values nest too deeply.",
    );
  const offset = reader.offset;
  const tag = String.fromCharCode(reader.u1("element_value tag"));
  switch (tag) {
    case "B":
    case "C":
    case "D":
    case "F":
    case "I":
    case "J":
    case "S":
    case "Z":
    case "s":
      return constantValue(pool, tag, reader.u2());
    case "e": {
      const type = pool.utf8(reader.u2());
      const name = pool.utf8(reader.u2());
      return `${typeText(type)}.${name ?? "?"}`;
    }
    case "c": {
      const descriptor = pool.utf8(reader.u2());
      return `${descriptor === "V" ? "void" : typeText(descriptor)}.class`;
    }
    case "@":
      return readAnnotation(reader, pool, true, depth + 1).text;
    case "[": {
      const count = reader.u2();
      const values: string[] = [];
      for (let index = 0; index < count; index += 1)
        values.push(readElementValue(reader, pool, depth + 1));
      return `{${values.join(", ")}}`;
    }
    default:
      throw new ClassFormatError(
        offset,
        `Unknown annotation element tag '${tag}'.`,
      );
  }
};

export const readAnnotation = (
  reader: ClassReader,
  pool: ConstantPool,
  visible: boolean,
  depth = 0,
): Annotation => {
  const type = pool.utf8(reader.u2("annotation type"));
  const pairs = reader.u2("element_value_pairs");
  const values: string[] = [];
  for (let index = 0; index < pairs; index += 1) {
    const name = pool.utf8(reader.u2());
    values.push(`${name ?? "?"}=${readElementValue(reader, pool, depth)}`);
  }
  const name = type === null ? "?" : typeText(type);
  return {
    type,
    visible,
    text: `@${name}${values.length === 0 ? "" : `(${values.join(", ")})`}`,
  };
};

export const readAnnotations = (
  reader: ClassReader,
  pool: ConstantPool,
  visible: boolean,
): Annotation[] => {
  const count = reader.u2("num_annotations");
  const annotations: Annotation[] = [];
  for (let index = 0; index < count; index += 1)
    annotations.push(readAnnotation(reader, pool, visible));
  return annotations;
};

/** `com/example/Thing` as it reads in source. */
export const sourceName = (internal: string | null): string | null =>
  internal === null ? null : binaryName(internal);
