import type { DexFile } from "./dexFile.js";
import { DexFormatError } from "./DexReader.js";
import {
  ARRAY_DATA_PAYLOAD,
  dalvikOpcode,
  PACKED_SWITCH_PAYLOAD,
  SPARSE_SWITCH_PAYLOAD,
  type DalvikFormat,
  type DalvikIndexKind,
  type DalvikOpcode,
} from "./opcodes.js";
import { printfG, quotedDexString } from "./valueText.js";

/**
 * Dalvik bytecode decoded in process, walked and printed as dexdump walks and
 * prints it (ART `dexdump.cc` `dumpInstruction`). Nothing is verified or run;
 * a truncated instruction or payload stops decoding at its address and keeps
 * every instruction before it.
 */

export interface DalvikReference {
  readonly kind:
    | "string"
    | "type"
    | "field"
    | "method"
    | "proto"
    | "call_site"
    | "method_handle";
  readonly index: number;
  /**
   * Resolved text: the string value, a type descriptor, "Lowner;.name:Type",
   * "Lowner;.name:(Args)Ret", a proto "(Args)Ret", a call site's
   * "name:(Args)Ret", or a method handle's "invoke-static Lowner;.name:(Args)Ret";
   * null when the index is out of range or its entry cannot be read.
   */
  readonly text: string | null;
}

export interface DalvikInstruction {
  /** Code-unit index in the method. */
  readonly address: number;
  /** Width in code units. */
  readonly units: number;
  /** 0x00-0xff; payloads 0x100 packed switch, 0x200 sparse switch, 0x300 array data. */
  readonly opcode: number;
  /** dexdump's name, e.g. "invoke-virtual", "packed-switch-data", "nop". */
  readonly mnemonic: string;
  /** "35c" ... or "payload". */
  readonly format: DalvikFormat | "payload";
  /** Exactly what dexdump prints after the mnemonic, without the leading space ("" when none). */
  readonly operands: string;
  readonly registers: readonly number[];
  /** Decimal text of a literal (exact for wide values). */
  readonly literal: string | null;
  /** Absolute branch, switch-payload or array-data address. */
  readonly target: number | null;
  readonly reference: DalvikReference | null;
  /** The proto (second index) of invoke-polymorphic(/range). */
  readonly proto: DalvikReference | null;
  /** Keys and absolute targets read from the switch's payload. */
  readonly switch_targets:
    | readonly { readonly key: number; readonly target: number }[]
    | null;
  readonly array_data: {
    readonly element_width: number;
    readonly count: number;
  } | null;
}

export interface DalvikProblem {
  readonly address: number;
  readonly message: string;
}

export interface DalvikReferences {
  readonly invocations: readonly {
    readonly address: number;
    readonly kind:
      | "virtual"
      | "super"
      | "direct"
      | "static"
      | "interface"
      | "polymorphic"
      | "custom";
    readonly reference: DalvikReference;
  }[];
  readonly field_accesses: readonly {
    readonly address: number;
    readonly access: "read" | "write";
    readonly static: boolean;
    readonly reference: DalvikReference;
  }[];
  readonly types: readonly {
    readonly address: number;
    readonly use:
      | "new-instance"
      | "new-array"
      | "filled-new-array"
      | "check-cast"
      | "instance-of"
      | "const-class";
    readonly reference: DalvikReference;
  }[];
  readonly strings: readonly {
    readonly address: number;
    readonly reference: DalvikReference;
  }[];
  /** Method handles, method types and invoke-polymorphic protos; call sites are listed with their invoke-custom. */
  readonly other: readonly {
    readonly address: number;
    readonly reference: DalvikReference;
  }[];
}

export interface DecodedDalvikCode {
  readonly instructions: readonly DalvikInstruction[];
  readonly problems: readonly DalvikProblem[];
  readonly references: DalvikReferences;
}

/** Method handle kinds by `method_handle_type`, with dexdump's names. */
export const METHOD_HANDLE_TYPES: readonly string[] = [
  "put-static",
  "get-static",
  "put-instance",
  "get-instance",
  "invoke-static",
  "invoke-instance",
  "invoke-constructor",
  "invoke-direct",
  "invoke-interface",
];

const hex = (value: number, width: number): string =>
  (value >>> 0).toString(16).padStart(width, "0");

/** "Lowner;.name:Type" of field `index`, or null when it is out of range. */
export const dexFieldText = (dex: DexFile, index: number): string | null => {
  const field = dex.field(index);
  return field === null
    ? null
    : `${field.class ?? "?"}.${field.name ?? "?"}:${field.type ?? "?"}`;
};

/** "Lowner;.name:(Args)Ret" of method `index`, or null when it is out of range. */
export const dexMethodText = (dex: DexFile, index: number): string | null => {
  const method = dex.method(index);
  return method === null
    ? null
    : `${method.class ?? "?"}.${method.name ?? "?"}:${dex.protoDescriptor(method.proto_index) ?? "?"}`;
};

const callSiteText = (dex: DexFile, index: number): string | null => {
  try {
    const values = dex.callSite(index);
    const name = values?.[1];
    const type = values?.[2];
    if (name?.kind !== "string" || type?.kind !== "method_type") return null;
    return `${dex.string(name.index) ?? "?"}:${dex.protoDescriptor(type.index) ?? "?"}`;
  } catch (cause) {
    if (cause instanceof DexFormatError) return null;
    throw cause;
  }
};

const methodHandleText = (dex: DexFile, index: number): string | null => {
  const handle = dex.methodHandle(index);
  if (handle === null) return null;
  const type = METHOD_HANDLE_TYPES[handle.type];
  if (type === undefined) return null;
  const member = type.startsWith("invoke-")
    ? dexMethodText(dex, handle.field_or_method_id)
    : dexFieldText(dex, handle.field_or_method_id);
  return `${type} ${member ?? "?"}`;
};

const REFERENCE_TEXT: Readonly<
  Record<
    DalvikReference["kind"],
    (dex: DexFile, index: number) => string | null
  >
> = {
  string: (dex, index) => dex.string(index),
  type: (dex, index) => dex.type(index),
  field: dexFieldText,
  method: dexMethodText,
  proto: (dex, index) => dex.protoDescriptor(index),
  call_site: callSiteText,
  method_handle: methodHandleText,
};

/** Resolve one index operand; `text` is null for an out-of-range index. */
export const resolveDalvikReference = (
  dex: DexFile,
  kind: DalvikReference["kind"],
  index: number,
): DalvikReference => {
  return { kind, index, text: REFERENCE_TEXT[kind](dex, index) };
};

/** dexdump's `indexString` for one instruction (width 4, or 8 for 31c). */
const indexText = (
  reference: DalvikReference,
  proto: DalvikReference | null,
  width: number,
): string => {
  const at = hex(reference.index, width);
  switch (reference.kind) {
    case "string":
      return reference.text === null
        ? `<string?> // string@${at}`
        : `${quotedDexString(reference.text)} // string@${at}`;
    case "type":
      return `${reference.text ?? "<type?>"} // type@${at}`;
    case "field":
      return `${reference.text ?? "<field?>"} // field@${at}`;
    case "method":
      return proto === null
        ? `${reference.text ?? "<method?>"} // method@${at}`
        : `${reference.text ?? "<method?>"}, ${proto.text ?? "<proto?>"} // method@${at}, proto@${hex(proto.index, width)}`;
    case "proto":
      return `${reference.text ?? "<?>"} // proto@${at}`;
    case "call_site":
      return `call_site@${at}`;
    case "method_handle":
      return `method_handle@${at}`;
  }
};

const REFERENCE_KIND: Readonly<
  Record<Exclude<DalvikIndexKind, "none">, DalvikReference["kind"]>
> = {
  string: "string",
  type: "type",
  field: "field",
  method: "method",
  proto: "proto",
  call_site: "call_site",
  method_handle: "method_handle",
  method_and_proto: "method",
};

interface Context {
  readonly op: DalvikOpcode;
  readonly address: number;
  readonly dex: DexFile;
  /** Code unit `index` of this instruction (already bounds-checked). */
  readonly unit: (index: number) => number;
}

interface Operands {
  readonly registers: readonly number[];
  readonly operands: string;
  readonly literal?: string;
  readonly target?: number;
  readonly reference?: DalvikReference;
  readonly proto?: DalvikReference;
  /** An encoding error that does not change the instruction's width. */
  readonly problem?: string;
}

const s16 = (value: number): number => (value << 16) >> 16;
const s32 = (context: Context, index: number): number =>
  context.unit(index) | (context.unit(index + 1) << 16);
const nibbleA = (context: Context): number => (context.unit(0) >> 8) & 0x0f;
const nibbleB = (context: Context): number => context.unit(0) >> 12;
const byteAA = (context: Context): number => context.unit(0) >> 8;
const v = (registers: readonly number[]): string =>
  registers.map((register) => `v${String(register)}`).join(", ");
/** dexdump's `%04x // %c%04x` branch text. */
const branch = (address: number, offset: number): string =>
  `${hex(address + offset, 4)} // ${offset < 0 ? "-" : "+"}${hex(Math.abs(offset), 4)}`;

const reference = (context: Context, index: number): DalvikReference => {
  const kind = context.op.index;
  if (kind === "none")
    throw new RangeError(`${context.op.name} takes no index operand.`);
  return resolveDalvikReference(context.dex, REFERENCE_KIND[kind], index);
};

/** An index operand after `prefix`; dexdump pads 31c indices to 8 digits, others to 4. */
const indexed = (
  context: Context,
  registers: readonly number[],
  index: number,
  prefix: string,
): Operands => {
  const resolved = reference(context, index);
  const width = context.op.format === "31c" ? 8 : 4;
  return {
    registers,
    operands: `${prefix}${indexText(resolved, null, width)}`,
    reference: resolved,
  };
};

const variadic = (context: Context, proto: number | null): Operands => {
  const count = nibbleB(context);
  const list = context.unit(2);
  const all = [
    list & 0x0f,
    (list >> 4) & 0x0f,
    (list >> 8) & 0x0f,
    list >> 12,
    nibbleA(context),
  ];
  const registers = all.slice(0, count);
  const resolved = reference(context, context.unit(1));
  const second =
    proto === null ? null : resolveDalvikReference(context.dex, "proto", proto);
  return {
    registers,
    operands: `{${v(registers)}}, ${indexText(resolved, second, 4)}`,
    reference: resolved,
    ...(second === null ? {} : { proto: second }),
    ...(count > 5
      ? {
          problem: `${context.op.name} names ${String(count)} argument registers; at most 5 fit.`,
        }
      : {}),
  };
};

const ranged = (context: Context, proto: number | null): Operands => {
  const count = byteAA(context);
  const first = context.unit(2);
  const registers = Array.from({ length: count }, (_, index) => first + index);
  const resolved = reference(context, context.unit(1));
  const second =
    proto === null ? null : resolveDalvikReference(context.dex, "proto", proto);
  return {
    registers,
    operands: `{${v(registers)}}, ${indexText(resolved, second, 4)}`,
    reference: resolved,
    ...(second === null ? {} : { proto: second }),
  };
};

const twoRegisters = (a: number, b: number): Operands => ({
  registers: [a, b],
  operands: v([a, b]),
});

const FORMATS: Readonly<Record<DalvikFormat, (context: Context) => Operands>> =
  {
    "10x": () => ({ registers: [], operands: "" }),
    "12x": (c) => twoRegisters(nibbleA(c), nibbleB(c)),
    "11n": (c) => {
      const value = (c.unit(0) << 16) >> 28;
      return {
        registers: [nibbleA(c)],
        operands: `v${String(nibbleA(c))}, #int ${String(value)} // #${(value & 0xff).toString(16)}`,
        literal: String(value),
      };
    },
    "11x": (c) => ({
      registers: [byteAA(c)],
      operands: `v${String(byteAA(c))}`,
    }),
    "10t": (c) => {
      const offset = (c.unit(0) << 16) >> 24;
      return {
        registers: [],
        operands: branch(c.address, offset),
        target: c.address + offset,
      };
    },
    "20t": (c) => {
      const offset = s16(c.unit(1));
      return {
        registers: [],
        operands: branch(c.address, offset),
        target: c.address + offset,
      };
    },
    "22x": (c) => twoRegisters(byteAA(c), c.unit(1)),
    "21t": (c) => {
      const offset = s16(c.unit(1));
      return {
        registers: [byteAA(c)],
        operands: `v${String(byteAA(c))}, ${branch(c.address, offset)}`,
        target: c.address + offset,
      };
    },
    "21s": (c) => {
      const value = s16(c.unit(1));
      return {
        registers: [byteAA(c)],
        operands: `v${String(byteAA(c))}, #int ${String(value)} // #${(value & 0xffff).toString(16)}`,
        literal: String(value),
      };
    },
    "21h": (c) => {
      const raw = c.unit(1);
      const wide = c.op.code === 0x19;
      const value = wide
        ? BigInt.asIntN(64, BigInt(raw) << 48n).toString()
        : String((raw << 16) | 0);
      return {
        registers: [byteAA(c)],
        operands: `v${String(byteAA(c))}, #${wide ? "long" : "int"} ${value} // #${raw.toString(16)}`,
        literal: value,
      };
    },
    "21c": (c) => indexed(c, [byteAA(c)], c.unit(1), `v${String(byteAA(c))}, `),
    "23x": (c) => {
      const registers = [byteAA(c), c.unit(1) & 0xff, c.unit(1) >> 8];
      return { registers, operands: v(registers) };
    },
    "22b": (c) => {
      const registers = [byteAA(c), c.unit(1) & 0xff];
      const value = (c.unit(1) << 16) >> 24;
      return {
        registers,
        operands: `${v(registers)}, #int ${String(value)} // #${hex(value & 0xff, 2)}`,
        literal: String(value),
      };
    },
    "22t": (c) => {
      const registers = [nibbleA(c), nibbleB(c)];
      const offset = s16(c.unit(1));
      return {
        registers,
        operands: `${v(registers)}, ${branch(c.address, offset)}`,
        target: c.address + offset,
      };
    },
    "22s": (c) => {
      const registers = [nibbleA(c), nibbleB(c)];
      const value = s16(c.unit(1));
      return {
        registers,
        operands: `${v(registers)}, #int ${String(value)} // #${hex(value & 0xffff, 4)}`,
        literal: String(value),
      };
    },
    "22c": (c) => {
      const registers = [nibbleA(c), nibbleB(c)];
      return indexed(c, registers, c.unit(1), `${v(registers)}, `);
    },
    "30t": (c) => {
      const offset = s32(c, 1);
      return {
        registers: [],
        operands: `#${hex(offset, 8)}`,
        target: c.address + offset,
      };
    },
    "32x": (c) => twoRegisters(c.unit(1), c.unit(2)),
    "31i": (c) => {
      const bits = s32(c, 1);
      const view = new DataView(new ArrayBuffer(4));
      view.setInt32(0, bits);
      // dexdump prints the bits as a float for const and const-wide/32 alike.
      return {
        registers: [byteAA(c)],
        operands: `v${String(byteAA(c))}, #float ${printfG(view.getFloat32(0))} // #${hex(bits, 8)}`,
        literal: String(bits),
      };
    },
    "31t": (c) => {
      const offset = s32(c, 1);
      return {
        registers: [byteAA(c)],
        operands: `v${String(byteAA(c))}, ${hex(c.address + offset, 8)} // +${hex(offset, 8)}`,
        target: c.address + offset,
      };
    },
    "31c": (c) =>
      indexed(c, [byteAA(c)], s32(c, 1) >>> 0, `v${String(byteAA(c))}, `),
    "35c": (c) => variadic(c, null),
    "3rc": (c) => ranged(c, null),
    "45cc": (c) => variadic(c, c.unit(3)),
    "4rcc": (c) => ranged(c, c.unit(3)),
    "51l": (c) => {
      let bits = 0n;
      for (let index = 4; index >= 1; index -= 1)
        bits = (bits << 16n) | BigInt(c.unit(index));
      const view = new DataView(new ArrayBuffer(8));
      view.setBigUint64(0, bits);
      return {
        registers: [byteAA(c)],
        operands: `v${String(byteAA(c))}, #double ${printfG(view.getFloat64(0))} // #${bits.toString(16).padStart(16, "0")}`,
        literal: BigInt.asIntN(64, bits).toString(),
      };
    },
  };

interface Payload {
  readonly opcode: number;
  readonly mnemonic: string;
  readonly units: number;
  readonly array_data: DalvikInstruction["array_data"];
}

const PAYLOAD_NAMES: Readonly<Record<number, string>> = {
  [PACKED_SWITCH_PAYLOAD]: "packed-switch-data",
  [SPARSE_SWITCH_PAYLOAD]: "sparse-switch-data",
  [ARRAY_DATA_PAYLOAD]: "array-data",
};

const HEADER_UNITS: Readonly<Record<number, number>> = {
  [PACKED_SWITCH_PAYLOAD]: 2,
  [SPARSE_SWITCH_PAYLOAD]: 2,
  [ARRAY_DATA_PAYLOAD]: 4,
};

/** Size a payload at `address` as ART's `SizeInCodeUnitsComplexOpcode` does; a string is the reason it does not fit. */
const payloadAt = (units: Uint16Array, address: number): Payload | string => {
  const identifier = units[address] ?? 0;
  const mnemonic = PAYLOAD_NAMES[identifier] ?? "?";
  const remaining = units.length - address;
  const header = HEADER_UNITS[identifier] ?? 1;
  if (remaining < header)
    return `${mnemonic} at 0x${hex(address, 4)} needs a ${String(header)}-unit header; only ${String(remaining)} remain.`;
  const size = units[address + 1] ?? 0;
  let width: number;
  let arrayData: Payload["array_data"] = null;
  if (identifier === PACKED_SWITCH_PAYLOAD) width = 4 + size * 2;
  else if (identifier === SPARSE_SWITCH_PAYLOAD) width = 2 + size * 4;
  else {
    const count =
      ((units[address + 2] ?? 0) | ((units[address + 3] ?? 0) << 16)) >>> 0;
    arrayData = { element_width: size, count };
    width = 4 + Math.floor((size * count + 1) / 2);
  }
  if (width > remaining)
    return `${mnemonic} at 0x${hex(address, 4)} declares ${String(width)} code units; only ${String(remaining)} remain.`;
  return { opcode: identifier, mnemonic, units: width, array_data: arrayData };
};

const isPayload = (unit: number): boolean =>
  unit === PACKED_SWITCH_PAYLOAD ||
  unit === SPARSE_SWITCH_PAYLOAD ||
  unit === ARRAY_DATA_PAYLOAD;

type SwitchArms = readonly { readonly key: number; readonly target: number }[];

/** The arms of the switch at `address` read from its payload at `payload`, or why they cannot be. */
const switchArms = (
  units: Uint16Array,
  address: number,
  payload: number,
  sparse: boolean,
): SwitchArms | string => {
  const expected = sparse ? SPARSE_SWITCH_PAYLOAD : PACKED_SWITCH_PAYLOAD;
  const name = sparse ? "sparse-switch" : "packed-switch";
  if (payload < 0 || payload >= units.length || units[payload] !== expected)
    return `${name} at 0x${hex(address, 4)} points to 0x${hex(payload, 4)}, which holds no ${name}-data.`;
  const sized = payloadAt(units, payload);
  if (typeof sized === "string") return sized;
  const word = (index: number) =>
    (units[payload + index] ?? 0) | ((units[payload + index + 1] ?? 0) << 16);
  const size = units[payload + 1] ?? 0;
  if (!sparse) {
    const first = word(2);
    return Array.from({ length: size }, (_, index) => ({
      key: (first + index) | 0,
      target: address + word(4 + index * 2),
    }));
  }
  return Array.from({ length: size }, (_, index) => ({
    key: word(2 + index * 2),
    target: address + word(2 + size * 2 + index * 2),
  }));
};

const arrayDataAt = (
  units: Uint16Array,
  address: number,
  payload: number,
): DalvikInstruction["array_data"] | string => {
  if (
    payload < 0 ||
    payload >= units.length ||
    units[payload] !== ARRAY_DATA_PAYLOAD
  )
    return `fill-array-data at 0x${hex(address, 4)} points to 0x${hex(payload, 4)}, which holds no array-data.`;
  const sized = payloadAt(units, payload);
  return typeof sized === "string" ? sized : sized.array_data;
};

const payloadInstruction = (
  address: number,
  payload: Payload,
): DalvikInstruction => ({
  address,
  units: payload.units,
  opcode: payload.opcode,
  mnemonic: payload.mnemonic,
  format: "payload",
  operands: `(${String(payload.units)} units)`,
  registers: [],
  literal: null,
  target: null,
  reference: null,
  proto: null,
  switch_targets: null,
  array_data: payload.array_data,
});

type PayloadFacts = Pick<DalvikInstruction, "switch_targets" | "array_data"> & {
  readonly problem: string | null;
};

/** Switch arms or array-data facts of a 31t instruction at `address`, with the reason when its payload at `target` is missing or malformed. */
const payloadFacts = (
  units: Uint16Array,
  op: DalvikOpcode,
  address: number,
  target: number,
): PayloadFacts => {
  const none = { switch_targets: null, array_data: null };
  if (op.format !== "31t") return { ...none, problem: null };
  if (op.code === 0x26) {
    const data = arrayDataAt(units, address, target);
    return typeof data === "string"
      ? { ...none, problem: data }
      : { ...none, array_data: data, problem: null };
  }
  const arms = switchArms(units, address, target, op.code === 0x2c);
  return typeof arms === "string"
    ? { ...none, problem: arms }
    : { ...none, switch_targets: arms, problem: null };
};

const decodeOne = (
  units: Uint16Array,
  address: number,
  dex: DexFile,
  problems: DalvikProblem[],
): DalvikInstruction | null => {
  const first = units[address] ?? 0;
  if (isPayload(first)) {
    const payload = payloadAt(units, address);
    if (typeof payload === "string") {
      problems.push({ address, message: payload });
      return null;
    }
    const width = payload.array_data?.element_width;
    if (width !== undefined && ![1, 2, 4, 8].includes(width))
      problems.push({
        address,
        message: `array-data at 0x${hex(address, 4)} has element width ${String(width)}; the format allows 1, 2, 4 or 8.`,
      });
    return payloadInstruction(address, payload);
  }
  const op = dalvikOpcode(first & 0xff);
  if (address + op.units > units.length) {
    problems.push({
      address,
      message: `${op.name} at 0x${hex(address, 4)} needs ${String(op.units)} code units; only ${String(units.length - address)} remain.`,
    });
    return null;
  }
  const decoded = FORMATS[op.format]({
    op,
    address,
    dex,
    unit: (index) => units[address + index] ?? 0,
  });
  if (decoded.problem !== undefined)
    problems.push({ address, message: decoded.problem });
  const target = decoded.target ?? null;
  const { problem, ...facts } =
    target === null
      ? { switch_targets: null, array_data: null, problem: null }
      : payloadFacts(units, op, address, target);
  if (problem !== null) problems.push({ address, message: problem });
  return {
    address,
    units: op.units,
    opcode: op.code,
    mnemonic: op.name,
    format: op.format,
    operands: op.code === 0x00 ? "// spacer" : decoded.operands,
    registers: decoded.registers,
    literal: decoded.literal ?? null,
    target,
    reference: decoded.reference ?? null,
    proto: decoded.proto ?? null,
    ...facts,
  };
};

/** Branch and switch-arm targets that are not instruction starts. */
const checkTargets = (
  instructions: readonly DalvikInstruction[],
  length: number,
  problems: DalvikProblem[],
) => {
  const starts = new Set(
    instructions.map((instruction) => instruction.address),
  );
  for (const instruction of instructions) {
    const targets =
      instruction.format === "31t"
        ? (instruction.switch_targets ?? []).map((arm) => arm.target)
        : instruction.target === null
          ? []
          : [instruction.target];
    for (const target of targets)
      if (!starts.has(target))
        problems.push({
          address: instruction.address,
          message: `${instruction.mnemonic} at 0x${hex(instruction.address, 4)} jumps to 0x${hex(target, 4)}, which is ${target < 0 || target >= length ? "outside the code" : "not an instruction start"}.`,
        });
  }
};

const collectReferences = (
  instructions: readonly DalvikInstruction[],
): DalvikReferences => {
  const references = {
    invocations: [] as DalvikReferences["invocations"][number][],
    field_accesses: [] as DalvikReferences["field_accesses"][number][],
    types: [] as DalvikReferences["types"][number][],
    strings: [] as DalvikReferences["strings"][number][],
    other: [] as DalvikReferences["other"][number][],
  };
  for (const instruction of instructions) {
    const { address, reference } = instruction;
    if (reference === null || instruction.format === "payload") continue;
    const op = dalvikOpcode(instruction.opcode);
    if (op.invoke !== null)
      references.invocations.push({ address, kind: op.invoke, reference });
    else if (op.field !== null)
      references.field_accesses.push({ address, ...op.field, reference });
    else if (op.type_use !== null)
      references.types.push({ address, use: op.type_use, reference });
    else if (op.index === "string")
      references.strings.push({ address, reference });
    else references.other.push({ address, reference });
    if (instruction.proto !== null)
      references.other.push({ address, reference: instruction.proto });
  }
  return references;
};

/**
 * Decode one method's code units in address order, exactly as dexdump walks
 * them: payloads are sized from their headers and every nop that is not a
 * payload prints as "nop // spacer".
 */
export const decodeDalvik = (
  units: Uint16Array,
  dex: DexFile,
): DecodedDalvikCode => {
  const instructions: DalvikInstruction[] = [];
  const problems: DalvikProblem[] = [];
  let address = 0;
  let stopped = false;
  while (address < units.length) {
    const instruction = decodeOne(units, address, dex, problems);
    if (instruction === null) {
      stopped = true;
      break;
    }
    instructions.push(instruction);
    address += instruction.units;
  }
  if (!stopped) checkTargets(instructions, units.length, problems);
  return {
    instructions,
    problems,
    references: collectReferences(instructions),
  };
};
