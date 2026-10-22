import type {
  DecompileDexClassInput,
  DexDecompilation,
} from "../domain/android/androidArtifact.js";
import type { FacetCoverage } from "../domain/formatRegistry.js";
import type { JvmDecompilation } from "../domain/jvm/jvm.js";
import { decompileJarClass } from "../jvm/decompile.js";
import type { ResolvedVineflower } from "../jvm/vineflower.js";
import type { SelectedClass } from "./classReport.js";
import {
  DEX2JAR_OPTIONS,
  convertDex,
  type ResolvedDex2jar,
} from "./dex2jar.js";
import { binaryName } from "./dexInventory.js";

/** Listed items past this many are counted, not named. */
const MAX_LISTED = 200;

const ACC_BRIDGE = 0x40;
const ACC_SYNTHETIC = 0x1000;
const ACC_ENUM = 0x4000;

type Check = DexDecompilation["checks"][number];
type Untrusted = DexDecompilation["untrusted_methods"][number];

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** A Java identifier followed by an opening parenthesis, not part of a longer name. */
const called = (name: string) =>
  new RegExp(`(?<![\\w$])${escape(name)}\\s*\\(`, "u");

/**
 * Methods of the selected class, from the family's own DEX decoder, whose
 * names the text does not contain. Synthetic and bridge methods have no
 * source of their own; an enum's values/valueOf are implicit; constructors
 * are named after the class (an anonymous class has no name to show); a
 * lone no-argument constructor may be the implicit default one; the static
 * initializer is a `static {` block or folded into field initializers.
 */
export const missingMethods = (
  selected: SelectedClass,
  text: string,
): { checked: number; missing: DexDecompilation["missing_methods"] } => {
  const { dex, def } = selected;
  const descriptor = dex.type(def.class_idx) ?? "";
  const simple =
    (binaryName(descriptor) ?? "").split(".").at(-1)?.split("$").at(-1) ?? "";
  const anonymous = /^\d+$/u.test(simple);
  const isEnum = (def.access_flags & ACC_ENUM) !== 0;
  const data = dex.classData(def);
  const methods = [
    ...(data?.direct_methods ?? []),
    ...(data?.virtual_methods ?? []),
  ].map((entry) => {
    const id = dex.method(entry.method_idx);
    return {
      flags: entry.access_flags,
      name: id?.name ?? null,
      descriptor: id === null ? null : dex.protoDescriptor(id.proto_index),
    };
  });
  const constructors = methods.filter((method) => method.name === "<init>");
  const missing: DexDecompilation["missing_methods"] = [];
  let checked = 0;
  for (const method of methods) {
    const { name } = method;
    if (name === null) continue;
    if ((method.flags & (ACC_SYNTHETIC | ACC_BRIDGE)) !== 0) continue;
    if (isEnum && (name === "values" || name === "valueOf")) continue;
    if (name === "<init>" && anonymous) continue;
    checked += 1;
    const present =
      name === "<clinit>"
        ? /\bstatic\s*\{/u.test(text) || /\bstatic\b[^;{}()]*=/u.test(text)
        : name === "<init>"
          ? called(simple).test(text) ||
            (constructors.length === 1 && method.descriptor === "()V")
          : called(name).test(text);
    if (!present) missing.push({ name, descriptor: method.descriptor });
  }
  return { checked, missing };
};

const internal = (descriptor: string) =>
  descriptor.startsWith("L") && descriptor.endsWith(";")
    ? descriptor.slice(1, -1)
    : descriptor;

const listed = (values: readonly string[]) =>
  values.length <= 10
    ? values.join(", ")
    : `${values.slice(0, 10).join(", ")} and ${String(values.length - 10)} more`;

const translatedCheck = (
  conversion: Awaited<ReturnType<typeof convertDex>>,
  decompiled: ReadonlySet<string>,
): { check: Check; untrusted: Untrusted[] } => {
  const id = "dex2jar_translated";
  if (conversion.errorsUnread !== null)
    return {
      check: { id, state: "not_checked", detail: conversion.errorsUnread },
      untrusted: [],
    };
  const errors = conversion.errors;
  if (errors === null)
    return {
      check: {
        id,
        state: "passed",
        detail: "dex2jar wrote no error report: every method was translated.",
      },
      untrusted: [],
    };
  const ours = errors.methods.filter((failure) =>
    decompiled.has(internal(failure.owner)),
  );
  const untrusted = ours.map((failure) => ({
    source: "dex2jar" as const,
    class: internal(failure.owner),
    method: failure.name,
    descriptor: failure.descriptor,
    reason:
      "dex2jar could not translate this method; its converted body only throws, so the decompiled body is not the method's code.",
  }));
  if (errors.fileFailures > 0)
    return {
      check: {
        id,
        state: "failed",
        detail: `dex2jar counted ${String(errors.fileFailures)} whole-file failures, so classes may be missing or incomplete${ours.length > 0 ? `; ${String(ours.length)} methods of these classes failed` : ""}.`,
      },
      untrusted,
    };
  return ours.length > 0
    ? {
        check: {
          id,
          state: "failed",
          detail: `dex2jar could not translate ${String(ours.length)} methods of these classes: ${listed(ours.map((failure) => `${failure.name}${failure.descriptor}`))}.`,
        },
        untrusted,
      }
    : {
        check: {
          id,
          state: "passed",
          detail: `dex2jar failed on ${String(errors.methods.length)} methods elsewhere in the DEX file and none of these classes.`,
        },
        untrusted,
      };
};

const cleanCheck = (jvm: JvmDecompilation): Check => {
  const notes = jvm.decompiler_notes.length;
  const untrusted = jvm.untrusted_methods.length;
  return notes === 0 && untrusted === 0
    ? {
        id: "vineflower_clean",
        state: "passed",
        detail:
          "Vineflower left no uncertainty notes or unresolved calls, and every converted method decoded cleanly.",
      }
    : {
        id: "vineflower_clean",
        state: "failed",
        detail: [
          notes > 0
            ? `${String(notes)} places Vineflower marked uncertain or left unresolved`
            : null,
          untrusted > 0
            ? `${String(untrusted)} converted methods whose bytecode did not decode cleanly`
            : null,
        ]
          .filter((part) => part !== null)
          .join("; "),
      };
};

const presentCheck = (checked: number, missing: number): Check =>
  missing === 0
    ? {
        id: "methods_present",
        state: "not_checked",
        detail: `The name scan found no missing names among ${String(checked)} methods, but it cannot distinguish declarations from calls, overloads or other classes, or verify implicit constructors and static initializers. Method coverage is not established.`,
      }
    : {
        id: "methods_present",
        state: "failed",
        detail: `${String(missing)} of ${String(checked)} source-level methods the DEX declares for the class are not named in the text.`,
      };

const LIMITATIONS = [
  "This Java source is reconstructed from DEX bytecode in two steps: dex2jar converts the DEX file to class files, then Vineflower decompiles them. It is inferred, not the original source: register allocation, desugaring and optimization by d8/R8 show through, names of locals come only from debug information, and it may not compile.",
  "dex2jar and Vineflower read the bytes as data in their own Java processes, on scratch copies with an empty environment; nothing was installed, loaded or run.",
  "methods_present is a name scan, not a Java declaration parser. Missing names fail the check; otherwise it stays not_checked because calls, overloads, nested classes, implicit constructors and folded static initializers do not establish method coverage.",
];

export interface DexDecompileRequest {
  readonly artifact: DexDecompilation["artifact"];
  readonly selected: SelectedClass;
  readonly input: DecompileDexClassInput;
  readonly dex2jar: ResolvedDex2jar;
  readonly vineflower: ResolvedVineflower;
  readonly signal?: AbortSignal | undefined;
}

/** Convert the DEX file that holds the class, decompile the class, and check the text against the DEX. */
export const decompileDexClass = async (
  request: DexDecompileRequest,
): Promise<DexDecompilation> => {
  const { selected, input, dex2jar, vineflower, signal } = request;
  const descriptor = selected.dex.type(selected.def.class_idx) ?? "";
  const conversion = await convertDex({
    dex: selected.dex.bytes,
    tool: dex2jar,
    java: vineflower.java,
    heapMib: input.max_heap_mib,
    timeoutMs: input.timeout_ms,
    signal,
  });
  const jvm = await decompileJarClass({
    jar: conversion.jar,
    name: "classes.jar",
    className: internal(descriptor),
    limits: input,
    tool: vineflower,
    signal,
  });
  const decompiled = new Set(jvm.inputs.map((entry) => entry.name));
  const translated = translatedCheck(conversion, decompiled);
  const methods = missingMethods(selected, jvm.source.text);
  const checks = [
    translated.check,
    cleanCheck(jvm),
    presentCheck(methods.checked, methods.missing.length),
  ];
  const failed = checks.filter((check) => check.state !== "passed");
  const examined = `${String(jvm.inputs.length)} converted class files decompiled into ${jvm.source.file}`;
  const omitted = [
    ...failed.map((check) => `${check.id}: ${check.detail}`),
    ...(jvm.missing_nested.length > 0
      ? [
          `${String(jvm.missing_nested.length)} nested classes the DEX file does not define`,
        ]
      : []),
  ];
  const reconstruct: FacetCoverage =
    omitted.length === 0
      ? {
          facet: "reconstruct",
          state: "complete",
          examined,
          omitted: null,
          reason: null,
          continuation: null,
        }
      : {
          facet: "reconstruct",
          state: "partial",
          examined,
          omitted: omitted.join("; "),
          reason:
            "The decompiled text is incomplete or uncertain in the places listed.",
          continuation:
            jvm.missing_nested.length > 0
              ? "Nested classes in another DEX file of a multi-DEX package are not gathered; decompile them by name."
              : null,
        };
  const untrusted: Untrusted[] = [
    ...translated.untrusted,
    ...jvm.untrusted_methods.map((entry) => ({
      source: "class_file" as const,
      ...entry,
    })),
  ];
  return {
    artifact: request.artifact,
    selection: selected.selection,
    class: { descriptor, name: binaryName(descriptor) ?? descriptor },
    top_level: jvm.top_level,
    classes: jvm.inputs.map((entry) => ({
      name: entry.name,
      role: entry.role,
      sha256: entry.sha256,
      bytes: entry.bytes,
    })),
    missing_nested: jvm.missing_nested,
    converter: {
      id: "dex2jar",
      version: dex2jar.version,
      build: dex2jar.build,
      lib: {
        path: dex2jar.lib,
        set_sha256: dex2jar.setSha256,
        jars: dex2jar.jars.length,
      },
      java: { path: vineflower.java, version: vineflower.javaVersion },
      options: [...DEX2JAR_OPTIONS],
    },
    decompiler: jvm.decompiler,
    source: { ...jvm.source, derived_from: [selected.selection.dex_sha256] },
    decompiler_notes: jvm.decompiler_notes,
    untrusted_methods: untrusted.slice(0, MAX_LISTED),
    missing_methods: methods.missing.slice(0, MAX_LISTED),
    messages: [...conversion.messages, ...jvm.messages].slice(0, MAX_LISTED),
    checks,
    coverage: [reconstruct],
    limitations: [
      ...LIMITATIONS,
      ...(untrusted.length > 0
        ? [
            "Bodies of the untrusted methods are not evidence of behavior; read them with inspect_dex_method.",
          ]
        : []),
    ],
  };
};
