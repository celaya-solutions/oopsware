import {
  ClassFormatError,
  ClassReader,
  decodeModifiedUtf8,
} from "./ClassReader.js";

/** Constant pool tags from JVMS 4.4, with the earliest class file version that admits each. */
export const CONSTANT_TAGS = {
  1: { name: "Utf8", since: 45 },
  3: { name: "Integer", since: 45 },
  4: { name: "Float", since: 45 },
  5: { name: "Long", since: 45 },
  6: { name: "Double", since: 45 },
  7: { name: "Class", since: 45 },
  8: { name: "String", since: 45 },
  9: { name: "Fieldref", since: 45 },
  10: { name: "Methodref", since: 45 },
  11: { name: "InterfaceMethodref", since: 45 },
  12: { name: "NameAndType", since: 45 },
  15: { name: "MethodHandle", since: 51 },
  16: { name: "MethodType", since: 51 },
  17: { name: "Dynamic", since: 55 },
  18: { name: "InvokeDynamic", since: 51 },
  19: { name: "Module", since: 53 },
  20: { name: "Package", since: 53 },
} as const;

export type ConstantTagName =
  (typeof CONSTANT_TAGS)[keyof typeof CONSTANT_TAGS]["name"];

export type Constant =
  | { tag: "Utf8"; offset: number; value: string | null }
  | { tag: "Integer"; offset: number; value: number }
  | { tag: "Float"; offset: number; value: number }
  | { tag: "Long"; offset: number; value: bigint }
  | { tag: "Double"; offset: number; value: number }
  | {
      tag: "Class" | "String" | "MethodType" | "Module" | "Package";
      offset: number;
      ref: number;
    }
  | {
      tag: "Fieldref" | "Methodref" | "InterfaceMethodref";
      offset: number;
      owner: number;
      nameAndType: number;
    }
  | { tag: "NameAndType"; offset: number; name: number; descriptor: number }
  | { tag: "MethodHandle"; offset: number; kind: number; ref: number }
  | {
      tag: "Dynamic" | "InvokeDynamic";
      offset: number;
      bootstrap: number;
      nameAndType: number;
    };

/** JVMS 4.4.8 reference kinds, named as javap prints them. */
export const METHOD_HANDLE_KINDS: Readonly<Record<number, string>> = {
  1: "REF_getField",
  2: "REF_getStatic",
  3: "REF_putField",
  4: "REF_putStatic",
  5: "REF_invokeVirtual",
  6: "REF_invokeStatic",
  7: "REF_invokeSpecial",
  8: "REF_newInvokeSpecial",
  9: "REF_invokeInterface",
};

export interface MemberRef {
  readonly kind: "Fieldref" | "Methodref" | "InterfaceMethodref";
  readonly owner: string | null;
  readonly name: string | null;
  readonly descriptor: string | null;
}

const float32 = (bits: number): number => {
  const view = new DataView(new ArrayBuffer(4));
  view.setUint32(0, bits);
  return view.getFloat32(0);
};

const float64 = (high: number, low: number): number => {
  const view = new DataView(new ArrayBuffer(8));
  view.setUint32(0, high);
  view.setUint32(4, low);
  return view.getFloat64(0);
};

const javaNumber = (value: number, suffix: "f" | "d"): string => {
  if (Number.isNaN(value)) return "NaN";
  if (value === Infinity) return "Infinity";
  if (value === -Infinity) return "-Infinity";
  const text = Object.is(value, -0) ? "-0.0" : String(value);
  return `${/[.e]/u.test(text) ? text : `${text}.0`}${suffix}`;
};

/**
 * One class file's constant pool. Index 0 and the slot after each Long or
 * Double are unusable, exactly as the JVM defines them. Lookups never throw:
 * a dangling or mistyped index answers null so callers can report it.
 */
export class ConstantPool {
  readonly #entries: (Constant | null)[];
  readonly problems: { offset: number; message: string }[] = [];

  private constructor(
    entries: (Constant | null)[],
    readonly count: number,
  ) {
    this.#entries = entries;
  }

  static read(reader: ClassReader, major: number): ConstantPool {
    const count = reader.u2("constant_pool_count");
    if (count === 0)
      throw new ClassFormatError(
        reader.offset - 2,
        "constant_pool_count is 0.",
      );
    const entries: (Constant | null)[] = [null];
    const pool = new ConstantPool(entries, count);
    for (let index = 1; index < count; index += 1) {
      const offset = reader.offset;
      const tag = reader.u1("constant tag");
      const known = CONSTANT_TAGS[tag as keyof typeof CONSTANT_TAGS] as
        | (typeof CONSTANT_TAGS)[keyof typeof CONSTANT_TAGS]
        | undefined;
      if (known === undefined)
        throw new ClassFormatError(
          offset,
          `Constant pool entry #${String(index)} has unknown tag ${String(tag)}.`,
        );
      if (major < known.since)
        pool.problems.push({
          offset,
          message: `Constant #${String(index)} is ${known.name}, which class file version ${String(major)} does not admit (needs ${String(known.since)}).`,
        });
      switch (known.name) {
        case "Utf8": {
          const length = reader.u2("Utf8 length");
          const value = decodeModifiedUtf8(reader.take(length, "Utf8 bytes"));
          if (value === null)
            pool.problems.push({
              offset,
              message: `Constant #${String(index)} is not valid modified UTF-8.`,
            });
          entries.push({ tag: "Utf8", offset, value });
          break;
        }
        case "Integer":
          entries.push({ tag: "Integer", offset, value: reader.s4() });
          break;
        case "Float":
          entries.push({ tag: "Float", offset, value: float32(reader.u4()) });
          break;
        case "Long": {
          const high = reader.u4();
          const low = reader.u4();
          entries.push({
            tag: "Long",
            offset,
            value: BigInt.asIntN(64, (BigInt(high) << 32n) | BigInt(low)),
          });
          entries.push(null);
          index += 1;
          break;
        }
        case "Double": {
          const high = reader.u4();
          const low = reader.u4();
          entries.push({ tag: "Double", offset, value: float64(high, low) });
          entries.push(null);
          index += 1;
          break;
        }
        case "Class":
        case "String":
        case "MethodType":
        case "Module":
        case "Package":
          entries.push({ tag: known.name, offset, ref: reader.u2() });
          break;
        case "Fieldref":
        case "Methodref":
        case "InterfaceMethodref":
          entries.push({
            tag: known.name,
            offset,
            owner: reader.u2(),
            nameAndType: reader.u2(),
          });
          break;
        case "NameAndType":
          entries.push({
            tag: "NameAndType",
            offset,
            name: reader.u2(),
            descriptor: reader.u2(),
          });
          break;
        case "MethodHandle":
          entries.push({
            tag: "MethodHandle",
            offset,
            kind: reader.u1(),
            ref: reader.u2(),
          });
          break;
        case "Dynamic":
        case "InvokeDynamic":
          entries.push({
            tag: known.name,
            offset,
            bootstrap: reader.u2(),
            nameAndType: reader.u2(),
          });
          break;
      }
    }
    if (entries.length > count) {
      pool.problems.push({
        offset: reader.offset,
        message:
          "The last constant is a Long or Double whose second slot lies past constant_pool_count.",
      });
      entries.length = count;
    }
    return pool;
  }

  get(index: number): Constant | null {
    return this.#entries[index] ?? null;
  }

  /** Counts per tag, for a compact summary of the whole pool. */
  tagCounts(): Partial<Record<ConstantTagName, number>> {
    const counts: Partial<Record<ConstantTagName, number>> = {};
    for (const entry of this.#entries)
      if (entry !== null) counts[entry.tag] = (counts[entry.tag] ?? 0) + 1;
    return counts;
  }

  /** Every class the pool names, sorted and without repeats. */
  classNames(): string[] {
    const names = new Set<string>();
    this.#entries.forEach((entry, index) => {
      if (entry?.tag !== "Class") return;
      const name = this.className(index);
      if (name !== null) names.add(name);
    });
    return [...names].sort();
  }

  utf8(index: number): string | null {
    const entry = this.get(index);
    return entry?.tag === "Utf8" ? entry.value : null;
  }

  /** Internal name of a CONSTANT_Class (`java/lang/String`, or an array descriptor). */
  className(index: number): string | null {
    const entry = this.get(index);
    return entry?.tag === "Class" ? this.utf8(entry.ref) : null;
  }

  /** Name of a CONSTANT_Module or CONSTANT_Package. */
  named(index: number, tag: "Module" | "Package"): string | null {
    const entry = this.get(index);
    return entry?.tag === tag ? this.utf8(entry.ref) : null;
  }

  nameAndType(
    index: number,
  ): { name: string | null; descriptor: string | null } | null {
    const entry = this.get(index);
    return entry?.tag === "NameAndType"
      ? { name: this.utf8(entry.name), descriptor: this.utf8(entry.descriptor) }
      : null;
  }

  member(index: number): MemberRef | null {
    const entry = this.get(index);
    if (
      entry?.tag !== "Fieldref" &&
      entry?.tag !== "Methodref" &&
      entry?.tag !== "InterfaceMethodref"
    )
      return null;
    const nat = this.nameAndType(entry.nameAndType);
    return {
      kind: entry.tag,
      owner: this.className(entry.owner),
      name: nat?.name ?? null,
      descriptor: nat?.descriptor ?? null,
    };
  }

  /** `owner.name:descriptor`, the way javap prints a member reference. */
  memberText(ref: MemberRef | null): string {
    if (ref === null) return "?";
    return `${ref.owner ?? "?"}.${ref.name ?? "?"}:${ref.descriptor ?? "?"}`;
  }

  /** A method handle such as `REF_invokeStatic java/lang/invoke/LambdaMetafactory.metafactory:(...)`. */
  methodHandle(index: number): {
    kind: string;
    member: MemberRef | null;
    text: string;
  } | null {
    const entry = this.get(index);
    if (entry?.tag !== "MethodHandle") return null;
    const kind = METHOD_HANDLE_KINDS[entry.kind] ?? `REF_${String(entry.kind)}`;
    const member = this.member(entry.ref);
    return { kind, member, text: `${kind} ${this.memberText(member)}` };
  }

  /** Readable text of a loadable constant (ldc operand or bootstrap argument). */
  constantText(index: number): { kind: string; value: string } | null {
    const entry = this.get(index);
    if (entry === null) return null;
    switch (entry.tag) {
      case "Integer":
        return { kind: "int", value: String(entry.value) };
      case "Float":
        return { kind: "float", value: javaNumber(entry.value, "f") };
      case "Long":
        return { kind: "long", value: `${entry.value.toString()}l` };
      case "Double":
        return { kind: "double", value: javaNumber(entry.value, "d") };
      case "String": {
        const value = this.utf8(entry.ref);
        return {
          kind: "String",
          value: value === null ? "?" : JSON.stringify(value),
        };
      }
      case "Class":
        return { kind: "class", value: this.utf8(entry.ref) ?? "?" };
      case "MethodType":
        return { kind: "MethodType", value: this.utf8(entry.ref) ?? "?" };
      case "MethodHandle":
        return {
          kind: "MethodHandle",
          value: this.methodHandle(index)?.text ?? "?",
        };
      case "Dynamic": {
        const nat = this.nameAndType(entry.nameAndType);
        return {
          kind: "Dynamic",
          value: `#${String(entry.bootstrap)}:${nat?.name ?? "?"}:${nat?.descriptor ?? "?"}`,
        };
      }
      default:
        return null;
    }
  }
}
