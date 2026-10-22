import type { JvmClassReport, JvmClassSummary } from "../domain/jvm/jvm.js";
import { accessFlagNames, sourceModifiers } from "./classfile/accessFlags.js";
import type { Annotation } from "./classfile/annotations.js";
import { fieldTypeText, methodDeclaration } from "./classfile/descriptors.js";
import type {
  AttributeInfo,
  ClassFile,
  MethodInfo,
  ModuleInfo,
} from "./classfile/parseClass.js";

/** Where one class's bytes sit, plus their identity. */
export interface ClassPlace {
  readonly container: string | null;
  readonly entry: string | null;
  readonly release: number | null;
  readonly sha256: string | null;
  readonly bytes: number;
}

/** The Java release that introduced a class file major version (JVMS 4.1). */
export const javaRelease = (major: number, minor: number): string | null => {
  if (major === 45) return minor >= 3 ? "1.1" : "1.0.2";
  if (major >= 46 && major <= 48) return `1.${String(major - 44)}`;
  if (major >= 49) return String(major - 44);
  return null;
};

export const versionOf = (parsed: { major: number; minor: number }) => ({
  major: parsed.major,
  minor: parsed.minor,
  java: javaRelease(parsed.major, parsed.minor),
  preview: parsed.major >= 56 && parsed.minor === 0xffff,
});

const kindOf = (parsed: ClassFile): JvmClassSummary["kind"] => {
  const access = parsed.access ?? 0;
  if ((access & 0x8000) !== 0) return "module";
  if ((access & 0x2000) !== 0) return "annotation";
  if ((access & 0x0200) !== 0) return "interface";
  if ((access & 0x4000) !== 0) return "enum";
  if (
    parsed.recordComponents !== null ||
    parsed.superClass === "java/lang/Record"
  )
    return "record";
  return "class";
};

const malformed = (attributes: readonly AttributeInfo[]) =>
  attributes.some((attribute) => attribute.state === "malformed");

/** `complete` only when every structure and decoded attribute was read. */
export const decodeStateOf = (
  parsed: ClassFile,
): { decode: JvmClassSummary["decode"]; error: string | null } => {
  if (parsed.stopped !== null)
    return {
      decode: parsed.thisClass === null ? "failed" : "partial",
      error: `At byte ${String(parsed.stopped.offset)}: ${parsed.stopped.message}`,
    };
  const damaged =
    malformed(parsed.attributes) ||
    parsed.fields.some((field) => malformed(field.attributes)) ||
    parsed.methods.some(
      (method) =>
        malformed(method.attributes) ||
        (method.code !== null && malformed(method.code.attributes)),
    );
  if (damaged)
    return {
      decode: "partial",
      error: parsed.problems[0]?.message ?? "An attribute could not be read.",
    };
  return { decode: "complete", error: null };
};

export const classSummary = (
  parsed: ClassFile,
  place: ClassPlace,
): JvmClassSummary => ({
  container: place.container,
  entry: place.entry,
  release: place.release,
  sha256: place.sha256,
  bytes: place.bytes,
  name: parsed.thisClass,
  kind: kindOf(parsed),
  access: parsed.access === null ? [] : accessFlagNames(parsed.access, "class"),
  super: parsed.superClass,
  interfaces: [...parsed.interfaces],
  version: versionOf(parsed),
  fields: parsed.fields.length,
  methods: parsed.methods.length,
  source_file: parsed.sourceFile,
  ...decodeStateOf(parsed),
});

/** A summary for bytes that are not a class file at all. */
export const unreadableSummary = (
  place: ClassPlace,
  error: string,
): JvmClassSummary => ({
  container: place.container,
  entry: place.entry,
  release: place.release,
  sha256: place.sha256,
  bytes: place.bytes,
  name: null,
  kind: "class",
  access: [],
  super: null,
  interfaces: [],
  version: { major: 0, minor: 0, java: null, preview: false },
  fields: 0,
  methods: 0,
  source_file: null,
  decode: "failed",
  error,
});

const annotations = (list: readonly Annotation[]) =>
  list.map((annotation) => ({
    text: annotation.text,
    visible: annotation.visible,
  }));

const attributes = (list: readonly AttributeInfo[]) =>
  list.map((attribute) => ({ ...attribute }));

export const moduleView = (
  module: ModuleInfo,
  parsed: ClassFile,
  place: Pick<ClassPlace, "container" | "entry" | "release">,
) => ({
  container: place.container,
  entry: place.entry,
  release: place.release,
  name: module.name,
  version: module.version,
  flags: accessFlagNames(module.flags, "module"),
  requires: module.requires.map((require) => ({
    module: require.module,
    flags: accessFlagNames(require.flags, "requires"),
    version: require.version,
  })),
  exports: module.exports.map((item) => ({
    package: item.package,
    flags: accessFlagNames(item.flags, "exports"),
    to: [...item.to],
  })),
  opens: module.opens.map((item) => ({
    package: item.package,
    flags: accessFlagNames(item.flags, "exports"),
    to: [...item.to],
  })),
  uses: [...module.uses],
  provides: module.provides.map((item) => ({
    service: item.service,
    with: [...item.with],
  })),
  packages: [...parsed.modulePackages],
  main_class: parsed.moduleMainClass,
});

export const methodSummary = (method: MethodInfo, owner: string | null) => ({
  index: method.index,
  name: method.name,
  descriptor: method.descriptor,
  declaration:
    method.name === null || method.descriptor === null
      ? null
      : methodDeclaration(
          sourceModifiers(method.access, "method"),
          owner,
          method.name,
          method.descriptor,
        ),
  access: accessFlagNames(method.access, "method"),
  signature: method.signature,
  throws: [...method.exceptions],
  code:
    method.code === null
      ? null
      : {
          offset: method.code.codeOffset,
          length: method.code.codeLength,
          max_stack: method.code.maxStack,
          max_locals: method.code.maxLocals,
          handlers: method.code.handlers.length,
          line_numbers: method.code.lineNumbers.length > 0,
          local_variables: method.code.localVariables.length > 0,
        },
  annotations: annotations(method.annotations),
  parameter_annotations: method.parameterAnnotations.map(annotations),
  parameters: method.parameters.map((parameter) => ({
    name: parameter.name,
    access: accessFlagNames(parameter.access, "parameter"),
  })),
  annotation_default: method.annotationDefault,
  deprecated: method.deprecated,
  attributes: attributes(method.attributes),
});

export const classDetail = (
  parsed: ClassFile,
  place: ClassPlace,
): JvmClassReport["class"] => ({
  ...classSummary(parsed, place),
  access_flags: parsed.access,
  signature: parsed.signature,
  deprecated: parsed.deprecated,
  constant_pool: {
    count: parsed.pool?.count ?? 0,
    by_tag: parsed.pool?.tagCounts() ?? {},
  },
  annotations: annotations(parsed.annotations),
  fields: parsed.fields.map((field) => ({
    index: field.index,
    name: field.name,
    descriptor: field.descriptor,
    type: field.descriptor === null ? null : fieldTypeText(field.descriptor),
    access: accessFlagNames(field.access, "field"),
    signature: field.signature,
    constant_value:
      field.constantValue === null ? null : field.constantValue.value,
    annotations: annotations(field.annotations),
    deprecated: field.deprecated,
    attributes: attributes(field.attributes),
  })),
  methods: parsed.methods.map((method) =>
    methodSummary(method, parsed.thisClass),
  ),
  inner_classes: parsed.innerClasses.map((inner) => ({
    inner: inner.inner,
    outer: inner.outer,
    name: inner.name,
    access: accessFlagNames(inner.access, "innerClass"),
  })),
  enclosing_method: parsed.enclosingMethod,
  nest_host: parsed.nestHost,
  nest_members: [...parsed.nestMembers],
  permitted_subclasses: [...parsed.permittedSubclasses],
  record_components:
    parsed.recordComponents === null
      ? null
      : parsed.recordComponents.map((component) => ({
          name: component.name,
          descriptor: component.descriptor,
          type:
            component.descriptor === null
              ? null
              : fieldTypeText(component.descriptor),
          signature: component.signature,
          annotations: annotations(component.annotations),
        })),
  bootstrap_methods: parsed.bootstrapMethods.map((method) => ({
    index: method.index,
    handle: method.handle,
    arguments: [...method.arguments],
  })),
  module:
    parsed.module === null ? null : moduleView(parsed.module, parsed, place),
  attributes: attributes(parsed.attributes),
  referenced_classes: parsed.pool?.classNames() ?? [],
});
