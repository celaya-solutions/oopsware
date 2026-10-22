import {
  readAnnotations,
  readElementValue,
  type Annotation,
} from "./annotations.js";
import { ClassFormatError, ClassReader } from "./ClassReader.js";
import { ConstantPool } from "./constantPool.js";

export const CLASS_MAGIC = 0xcafebabe;
/** Newest class file major version this reader was checked against (Java 27). */
export const LATEST_MAJOR = 71;

/**
 * - `decoded`: the body was read completely.
 * - `skipped`: a standard attribute this reader deliberately does not decode.
 * - `unknown`: a name the JVM specification does not define (the JVM ignores it too).
 * - `malformed`: the body could not be read; the range is kept.
 */
export type AttributeState = "decoded" | "skipped" | "unknown" | "malformed";

export interface AttributeInfo {
  readonly name: string | null;
  readonly offset: number;
  readonly length: number;
  readonly state: AttributeState;
}

export interface ExceptionHandler {
  readonly startPc: number;
  readonly endPc: number;
  readonly handlerPc: number;
  /** Null catches everything (`finally` and `synchronized` exits). */
  readonly catchType: string | null;
}

export interface LocalVariable {
  readonly startPc: number;
  readonly length: number;
  readonly name: string | null;
  readonly descriptor: string | null;
  readonly signature: string | null;
  readonly slot: number;
}

export interface CodeInfo {
  readonly offset: number;
  readonly codeOffset: number;
  readonly codeLength: number;
  readonly maxStack: number;
  readonly maxLocals: number;
  readonly handlers: readonly ExceptionHandler[];
  readonly lineNumbers: readonly { pc: number; line: number }[];
  readonly localVariables: readonly LocalVariable[];
  readonly attributes: readonly AttributeInfo[];
}

interface MemberCommon {
  readonly index: number;
  readonly offset: number;
  readonly access: number;
  readonly name: string | null;
  readonly descriptor: string | null;
  readonly signature: string | null;
  readonly annotations: readonly Annotation[];
  readonly deprecated: boolean;
  readonly attributes: readonly AttributeInfo[];
}

export interface FieldInfo extends MemberCommon {
  readonly constantValue: { kind: string; value: string } | null;
}

export interface MethodInfo extends MemberCommon {
  readonly exceptions: readonly string[];
  readonly code: CodeInfo | null;
  readonly parameterAnnotations: readonly (readonly Annotation[])[];
  readonly parameters: readonly { name: string | null; access: number }[];
  readonly annotationDefault: string | null;
}

export interface ModuleInfo {
  readonly name: string | null;
  readonly flags: number;
  readonly version: string | null;
  readonly requires: readonly {
    module: string | null;
    flags: number;
    version: string | null;
  }[];
  readonly exports: readonly {
    package: string | null;
    flags: number;
    to: readonly (string | null)[];
  }[];
  readonly opens: readonly {
    package: string | null;
    flags: number;
    to: readonly (string | null)[];
  }[];
  readonly uses: readonly (string | null)[];
  readonly provides: readonly {
    service: string | null;
    with: readonly (string | null)[];
  }[];
}

export interface BootstrapMethod {
  readonly index: number;
  readonly handle: string | null;
  readonly arguments: readonly string[];
}

export interface ClassFile {
  readonly minor: number;
  readonly major: number;
  readonly pool: ConstantPool | null;
  readonly access: number | null;
  readonly thisClass: string | null;
  readonly superClass: string | null;
  readonly interfaces: readonly (string | null)[];
  readonly fields: readonly FieldInfo[];
  readonly methods: readonly MethodInfo[];
  readonly attributes: readonly AttributeInfo[];
  readonly sourceFile: string | null;
  readonly signature: string | null;
  readonly annotations: readonly Annotation[];
  readonly deprecated: boolean;
  readonly innerClasses: readonly {
    inner: string | null;
    outer: string | null;
    name: string | null;
    access: number;
  }[];
  readonly enclosingMethod: {
    class: string | null;
    method: string | null;
    descriptor: string | null;
  } | null;
  readonly nestHost: string | null;
  readonly nestMembers: readonly (string | null)[];
  readonly permittedSubclasses: readonly (string | null)[];
  readonly recordComponents:
    | readonly {
        name: string | null;
        descriptor: string | null;
        signature: string | null;
        annotations: readonly Annotation[];
      }[]
    | null;
  readonly bootstrapMethods: readonly BootstrapMethod[];
  readonly module: ModuleInfo | null;
  readonly modulePackages: readonly (string | null)[];
  readonly moduleMainClass: string | null;
  /** Non-fatal problems: everything else was still read. */
  readonly problems: readonly { offset: number; message: string }[];
  /** A structural failure; facts after this offset were not read. */
  readonly stopped: { offset: number; message: string } | null;
  /** Bytes after the last attribute, which a valid class file never has. */
  readonly trailingBytes: number;
}

/** Standard attributes this reader knows but does not decode. */
const SKIPPED = new Set([
  "StackMapTable",
  "RuntimeVisibleTypeAnnotations",
  "RuntimeInvisibleTypeAnnotations",
  "SourceDebugExtension",
  "CharacterRangeTable",
  "SourceID",
  "CompilationID",
]);

const DECODED = new Set([
  "ConstantValue",
  "Code",
  "Exceptions",
  "InnerClasses",
  "EnclosingMethod",
  "Synthetic",
  "Signature",
  "SourceFile",
  "LineNumberTable",
  "LocalVariableTable",
  "LocalVariableTypeTable",
  "Deprecated",
  "RuntimeVisibleAnnotations",
  "RuntimeInvisibleAnnotations",
  "RuntimeVisibleParameterAnnotations",
  "RuntimeInvisibleParameterAnnotations",
  "AnnotationDefault",
  "BootstrapMethods",
  "MethodParameters",
  "Module",
  "ModulePackages",
  "ModuleMainClass",
  "NestHost",
  "NestMembers",
  "Record",
  "PermittedSubclasses",
]);

type Owner = "class" | "field" | "method" | "code" | "record";

/** Which structure each decoded attribute belongs to; elsewhere it is reported, not applied. */
const OWNERS: Readonly<Record<string, readonly Owner[]>> = {
  ConstantValue: ["field"],
  Code: ["method"],
  Exceptions: ["method"],
  InnerClasses: ["class"],
  EnclosingMethod: ["class"],
  Synthetic: ["class", "field", "method"],
  Signature: ["class", "field", "method", "record"],
  SourceFile: ["class"],
  LineNumberTable: ["code"],
  LocalVariableTable: ["code"],
  LocalVariableTypeTable: ["code"],
  Deprecated: ["class", "field", "method"],
  RuntimeVisibleAnnotations: ["class", "field", "method", "record"],
  RuntimeInvisibleAnnotations: ["class", "field", "method", "record"],
  RuntimeVisibleParameterAnnotations: ["method"],
  RuntimeInvisibleParameterAnnotations: ["method"],
  AnnotationDefault: ["method"],
  BootstrapMethods: ["class"],
  MethodParameters: ["method"],
  Module: ["class"],
  ModulePackages: ["class"],
  ModuleMainClass: ["class"],
  NestHost: ["class"],
  NestMembers: ["class"],
  Record: ["class"],
  PermittedSubclasses: ["class"],
};

type Problems = { offset: number; message: string }[];

const classList = (reader: ClassReader, pool: ConstantPool) => {
  const count = reader.u2();
  const names: (string | null)[] = [];
  for (let index = 0; index < count; index += 1)
    names.push(pool.className(reader.u2()));
  return names;
};

/**
 * Walk one attribute table. Each body is read inside its declared length, so a
 * body that fails to decode is recorded as malformed and the next attribute is
 * still read; only a length that runs past its container stops the walk.
 */
const readAttributes = (
  reader: ClassReader,
  pool: ConstantPool,
  owner: Owner,
  problems: Problems,
  decode: (name: string, body: ClassReader) => void,
): AttributeInfo[] => {
  const count = reader.u2("attributes_count");
  const attributes: AttributeInfo[] = [];
  for (let index = 0; index < count; index += 1) {
    const offset = reader.offset;
    const name = pool.utf8(reader.u2("attribute_name_index"));
    const length = reader.u4("attribute_length");
    const body = reader.slice(length, `${name ?? "attribute"} body`);
    let state: AttributeState;
    if (name === null) {
      state = "malformed";
      problems.push({
        offset,
        message: "An attribute name is not a Utf8 constant.",
      });
    } else if (SKIPPED.has(name)) state = "skipped";
    else if (!DECODED.has(name)) state = "unknown";
    else if (!(OWNERS[name] ?? []).includes(owner)) {
      state = "unknown";
      problems.push({
        offset,
        message: `${name} is not defined on a ${owner}; it was not applied.`,
      });
    } else
      try {
        decode(name, body);
        state = "decoded";
        if (body.remaining > 0)
          problems.push({
            offset,
            message: `${name} declares ${String(body.remaining)} more bytes than its contents use.`,
          });
      } catch (cause) {
        if (!(cause instanceof ClassFormatError)) throw cause;
        state = "malformed";
        problems.push({
          offset: cause.offset,
          message: `${name}: ${cause.message}`,
        });
      }
    attributes.push({ name, offset, length, state });
  }
  return attributes;
};

const readCode = (
  body: ClassReader,
  pool: ConstantPool,
  problems: Problems,
): CodeInfo => {
  const offset = body.offset - 6;
  const maxStack = body.u2("max_stack");
  const maxLocals = body.u2("max_locals");
  const codeLength = body.u4("code_length");
  if (codeLength === 0 || codeLength > 65535)
    problems.push({
      offset: body.offset - 4,
      message: `code_length ${String(codeLength)} is outside 1 to 65535.`,
    });
  const codeOffset = body.offset;
  body.take(codeLength, "code");
  const handlers: ExceptionHandler[] = [];
  const handlerCount = body.u2("exception_table_length");
  for (let index = 0; index < handlerCount; index += 1) {
    const startPc = body.u2();
    const endPc = body.u2();
    const handlerPc = body.u2();
    const catchIndex = body.u2();
    handlers.push({
      startPc,
      endPc,
      handlerPc,
      catchType: catchIndex === 0 ? null : (pool.className(catchIndex) ?? "?"),
    });
  }
  const lineNumbers: { pc: number; line: number }[] = [];
  const locals: LocalVariable[] = [];
  const types = new Map<string, string | null>();
  const attributes = readAttributes(
    body,
    pool,
    "code",
    problems,
    (name, inner) => {
      if (name === "LineNumberTable") {
        const count = inner.u2();
        for (let index = 0; index < count; index += 1)
          lineNumbers.push({ pc: inner.u2(), line: inner.u2() });
        return;
      }
      const count = inner.u2();
      for (let index = 0; index < count; index += 1) {
        const startPc = inner.u2();
        const length = inner.u2();
        const variable = pool.utf8(inner.u2());
        const descriptor = pool.utf8(inner.u2());
        const slot = inner.u2();
        if (name === "LocalVariableTable")
          locals.push({
            startPc,
            length,
            name: variable,
            descriptor,
            signature: null,
            slot,
          });
        else
          types.set(
            `${String(slot)}:${String(startPc)}:${String(length)}`,
            descriptor,
          );
      }
    },
  );
  return {
    offset,
    codeOffset,
    codeLength,
    maxStack,
    maxLocals,
    handlers,
    lineNumbers,
    localVariables: locals.map((local) => ({
      ...local,
      signature:
        types.get(
          `${String(local.slot)}:${String(local.startPc)}:${String(local.length)}`,
        ) ?? null,
    })),
    attributes,
  };
};

const readModule = (body: ClassReader, pool: ConstantPool): ModuleInfo => {
  const name = pool.named(body.u2(), "Module");
  const flags = body.u2();
  const versionIndex = body.u2();
  const requires = [];
  for (let count = body.u2(), index = 0; index < count; index += 1) {
    const module = pool.named(body.u2(), "Module");
    const requireFlags = body.u2();
    const version = body.u2();
    requires.push({
      module,
      flags: requireFlags,
      version: version === 0 ? null : pool.utf8(version),
    });
  }
  const targets = () => {
    const list = [];
    for (let count = body.u2(), index = 0; index < count; index += 1) {
      const pkg = pool.named(body.u2(), "Package");
      const packageFlags = body.u2();
      const to = [];
      for (
        let toCount = body.u2(), toIndex = 0;
        toIndex < toCount;
        toIndex += 1
      )
        to.push(pool.named(body.u2(), "Module"));
      list.push({ package: pkg, flags: packageFlags, to });
    }
    return list;
  };
  const exports = targets();
  const opens = targets();
  const uses = classList(body, pool);
  const provides = [];
  for (let count = body.u2(), index = 0; index < count; index += 1) {
    const service = pool.className(body.u2());
    provides.push({ service, with: classList(body, pool) });
  }
  return {
    name,
    flags,
    version: versionIndex === 0 ? null : pool.utf8(versionIndex),
    requires,
    exports,
    opens,
    uses,
    provides,
  };
};

const readParameterAnnotations = (
  body: ClassReader,
  pool: ConstantPool,
  visible: boolean,
): Annotation[][] => {
  const count = body.u1("num_parameters");
  const parameters: Annotation[][] = [];
  for (let index = 0; index < count; index += 1)
    parameters.push(readAnnotations(body, pool, visible));
  return parameters;
};

/** Parameter annotations from the visible and invisible tables, merged by position. */
const mergeParameters = (
  first: readonly Annotation[][],
  second: readonly Annotation[][],
): Annotation[][] =>
  Array.from({ length: Math.max(first.length, second.length) }, (_, index) => [
    ...(first[index] ?? []),
    ...(second[index] ?? []),
  ]);

const readMember = (
  reader: ClassReader,
  pool: ConstantPool,
  kind: "field" | "method",
  index: number,
  problems: Problems,
): FieldInfo & MethodInfo => {
  const offset = reader.offset;
  const access = reader.u2(`${kind} access_flags`);
  const name = pool.utf8(reader.u2(`${kind} name_index`));
  const descriptor = pool.utf8(reader.u2(`${kind} descriptor_index`));
  if (name === null || descriptor === null)
    problems.push({
      offset,
      message: `${kind} #${String(index)} has a name or descriptor that is not a Utf8 constant.`,
    });
  let signature: string | null = null;
  const annotations: Annotation[] = [];
  let deprecated = false;
  let constantValue: FieldInfo["constantValue"] = null;
  let exceptions: string[] = [];
  let code: CodeInfo | null = null;
  let visibleParameters: Annotation[][] = [];
  let invisibleParameters: Annotation[][] = [];
  let parameters: { name: string | null; access: number }[] = [];
  let annotationDefault: string | null = null;
  const attributes = readAttributes(
    reader,
    pool,
    kind,
    problems,
    (attribute, body) => {
      switch (attribute) {
        case "Signature":
          signature = pool.utf8(body.u2());
          break;
        case "ConstantValue":
          constantValue = pool.constantText(body.u2());
          break;
        case "Deprecated":
          deprecated = true;
          break;
        case "Synthetic":
          break;
        case "RuntimeVisibleAnnotations":
        case "RuntimeInvisibleAnnotations":
          annotations.push(
            ...readAnnotations(
              body,
              pool,
              attribute === "RuntimeVisibleAnnotations",
            ),
          );
          break;
        case "Exceptions":
          exceptions = classList(body, pool).map((value) => value ?? "?");
          break;
        case "Code":
          code = readCode(body, pool, problems);
          break;
        case "RuntimeVisibleParameterAnnotations":
          visibleParameters = readParameterAnnotations(body, pool, true);
          break;
        case "RuntimeInvisibleParameterAnnotations":
          invisibleParameters = readParameterAnnotations(body, pool, false);
          break;
        case "MethodParameters": {
          const count = body.u1();
          parameters = [];
          for (let parameter = 0; parameter < count; parameter += 1) {
            const nameIndex = body.u2();
            parameters.push({
              name: nameIndex === 0 ? null : pool.utf8(nameIndex),
              access: body.u2(),
            });
          }
          break;
        }
        case "AnnotationDefault":
          annotationDefault = readElementValue(body, pool);
          break;
      }
    },
  );
  return {
    index,
    offset,
    access,
    name,
    descriptor,
    signature,
    annotations,
    deprecated,
    attributes,
    constantValue,
    exceptions,
    code,
    parameterAnnotations: mergeParameters(
      visibleParameters,
      invisibleParameters,
    ),
    parameters,
    annotationDefault,
  };
};

/** Mutable accumulator for the class-level facts. */
const emptyClass = (minor: number, major: number) => ({
  minor,
  major,
  pool: null as ConstantPool | null,
  access: null as number | null,
  thisClass: null as string | null,
  superClass: null as string | null,
  interfaces: [] as (string | null)[],
  fields: [] as FieldInfo[],
  methods: [] as MethodInfo[],
  attributes: [] as AttributeInfo[],
  sourceFile: null as string | null,
  signature: null as string | null,
  annotations: [] as Annotation[],
  deprecated: false,
  innerClasses: [] as ClassFile["innerClasses"][number][],
  enclosingMethod: null as ClassFile["enclosingMethod"],
  nestHost: null as string | null,
  nestMembers: [] as (string | null)[],
  permittedSubclasses: [] as (string | null)[],
  recordComponents: null as ClassFile["recordComponents"] | null,
  bootstrapMethods: [] as BootstrapMethod[],
  module: null as ModuleInfo | null,
  modulePackages: [] as (string | null)[],
  moduleMainClass: null as string | null,
  problems: [] as Problems,
  stopped: null as ClassFile["stopped"],
  trailingBytes: 0,
});

/** True when the bytes start with the class file magic and a JVM major version (not a fat Mach-O count). */
export const looksLikeClassFile = (bytes: Uint8Array): boolean =>
  bytes.length >= 10 &&
  bytes[0] === 0xca &&
  bytes[1] === 0xfe &&
  bytes[2] === 0xba &&
  bytes[3] === 0xbe &&
  (((bytes[6] ?? 0) << 8) | (bytes[7] ?? 0)) >= 45;

/**
 * Parse one class file from its bytes. Nothing is loaded, linked, verified
 * or initialized. Returns null only when the bytes are not a class file at
 * all; a damaged class keeps every fact read before the damage.
 */
export const parseClass = (bytes: Uint8Array): ClassFile | null => {
  if (!looksLikeClassFile(bytes)) return null;
  const reader = new ClassReader(bytes, 4);
  const minor = reader.u2();
  const major = reader.u2();
  const result = emptyClass(minor, major);
  if (major > LATEST_MAJOR)
    result.problems.push({
      offset: 6,
      message: `Major version ${String(major)} is newer than ${String(LATEST_MAJOR)} (Java 27), the newest this reader knows; it is read with the structures it knows.`,
    });
  try {
    const pool = ConstantPool.read(reader, major);
    result.pool = pool;
    result.problems.push(...pool.problems);
    result.access = reader.u2("access_flags");
    const thisIndex = reader.u2("this_class");
    result.thisClass = pool.className(thisIndex);
    if (result.thisClass === null)
      result.problems.push({
        offset: reader.offset - 2,
        message: "this_class is not a Class constant.",
      });
    const superIndex = reader.u2("super_class");
    result.superClass = superIndex === 0 ? null : pool.className(superIndex);
    result.interfaces = classList(reader, pool);
    const fieldCount = reader.u2("fields_count");
    for (let index = 0; index < fieldCount; index += 1)
      result.fields.push(
        readMember(reader, pool, "field", index, result.problems),
      );
    const methodCount = reader.u2("methods_count");
    for (let index = 0; index < methodCount; index += 1)
      result.methods.push(
        readMember(reader, pool, "method", index, result.problems),
      );
    result.attributes = readAttributes(
      reader,
      pool,
      "class",
      result.problems,
      (name, body) => {
        switch (name) {
          case "SourceFile":
            result.sourceFile = pool.utf8(body.u2());
            break;
          case "Signature":
            result.signature = pool.utf8(body.u2());
            break;
          case "Deprecated":
            result.deprecated = true;
            break;
          case "Synthetic":
            break;
          case "RuntimeVisibleAnnotations":
          case "RuntimeInvisibleAnnotations":
            result.annotations.push(
              ...readAnnotations(
                body,
                pool,
                name === "RuntimeVisibleAnnotations",
              ),
            );
            break;
          case "InnerClasses":
            for (let count = body.u2(), index = 0; index < count; index += 1) {
              const inner = pool.className(body.u2());
              const outerIndex = body.u2();
              const nameIndex = body.u2();
              result.innerClasses.push({
                inner,
                outer: outerIndex === 0 ? null : pool.className(outerIndex),
                name: nameIndex === 0 ? null : pool.utf8(nameIndex),
                access: body.u2(),
              });
            }
            break;
          case "EnclosingMethod": {
            const owner = pool.className(body.u2());
            const methodIndex = body.u2();
            const nat =
              methodIndex === 0 ? null : pool.nameAndType(methodIndex);
            result.enclosingMethod = {
              class: owner,
              method: nat?.name ?? null,
              descriptor: nat?.descriptor ?? null,
            };
            break;
          }
          case "NestHost":
            result.nestHost = pool.className(body.u2());
            break;
          case "NestMembers":
            result.nestMembers = classList(body, pool);
            break;
          case "PermittedSubclasses":
            result.permittedSubclasses = classList(body, pool);
            break;
          case "Record": {
            const components = [];
            for (let count = body.u2(), index = 0; index < count; index += 1) {
              const componentName = pool.utf8(body.u2());
              const descriptor = pool.utf8(body.u2());
              let signature: string | null = null;
              const annotations: Annotation[] = [];
              readAttributes(
                body,
                pool,
                "record",
                result.problems,
                (attribute, inner) => {
                  if (attribute === "Signature")
                    signature = pool.utf8(inner.u2());
                  else
                    annotations.push(
                      ...readAnnotations(
                        inner,
                        pool,
                        attribute === "RuntimeVisibleAnnotations",
                      ),
                    );
                },
              );
              components.push({
                name: componentName,
                descriptor,
                signature,
                annotations,
              });
            }
            result.recordComponents = components;
            break;
          }
          case "BootstrapMethods":
            for (let count = body.u2(), index = 0; index < count; index += 1) {
              const handle = pool.methodHandle(body.u2());
              const args: string[] = [];
              for (
                let argCount = body.u2(), arg = 0;
                arg < argCount;
                arg += 1
              ) {
                const value = pool.constantText(body.u2());
                args.push(
                  value === null ? "?" : `${value.kind} ${value.value}`,
                );
              }
              result.bootstrapMethods.push({
                index,
                handle: handle?.text ?? null,
                arguments: args,
              });
            }
            break;
          case "Module":
            result.module = readModule(body, pool);
            break;
          case "ModulePackages":
            for (let count = body.u2(), index = 0; index < count; index += 1)
              result.modulePackages.push(pool.named(body.u2(), "Package"));
            break;
          case "ModuleMainClass":
            result.moduleMainClass = pool.className(body.u2());
            break;
        }
      },
    );
    result.trailingBytes = reader.remaining;
    if (reader.remaining > 0)
      result.problems.push({
        offset: reader.offset,
        message: `${String(reader.remaining)} bytes follow the last class attribute.`,
      });
  } catch (cause) {
    if (!(cause instanceof ClassFormatError)) throw cause;
    result.stopped = { offset: cause.offset, message: cause.message };
  }
  return result;
};
