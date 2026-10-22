import type { FacetCoverage } from "../domain/formatRegistry.js";
import type {
  InspectJvmClassInput,
  JvmClassReport,
  JvmMethodReport,
} from "../domain/jvm/jvm.js";
import { DecodeBudget, sha256Hex } from "../artifacts/zipMemberView.js";
import { decodeBytecode } from "./classfile/bytecode.js";
import {
  parseClass,
  type ClassFile,
  type MethodInfo,
} from "./classfile/parseClass.js";
import { TextBudget } from "./classfile/textBudget.js";
import {
  classDetail,
  methodSummary,
  versionOf,
  type ClassPlace,
} from "./classView.js";
import {
  classMembers,
  viewsOf,
  type ClassMember,
  type JvmSource,
} from "./source.js";

type Selector = Pick<
  InspectJvmClassInput,
  "class" | "entry" | "container" | "release"
>;
type Selection = JvmClassReport["selection"];

/** A caller choice that does not name exactly one class or method. */
export interface SelectionProblem {
  readonly field:
    | "class"
    | "entry"
    | "container"
    | "release"
    | "method"
    | "descriptor";
  readonly message: string;
}

export interface SelectedClass {
  readonly bytes: Uint8Array;
  readonly parsed: ClassFile;
  readonly place: ClassPlace;
  readonly selection: Selection;
}

const listed = (values: readonly string[]) =>
  values.length <= 10
    ? values.join(", ")
    : `${values.slice(0, 10).join(", ")} and ${String(values.length - 10)} more`;

const internalName = (name: string): string =>
  name.replace(/\.class$/u, "").replaceAll(".", "/");

const variantsOf = (candidates: readonly ClassMember[]) =>
  candidates
    .map((candidate) => ({
      entry: candidate.member.path,
      release: candidate.release,
    }))
    .sort((a, b) => (a.release ?? 0) - (b.release ?? 0));

/** Choose among one class's variants exactly as the caller asked; never from the host JDK. */
const chooseVariant = (
  candidates: readonly ClassMember[],
  release: number | undefined,
): { chosen: ClassMember; basis: Selection["basis"] } | SelectionProblem => {
  const base = candidates.find((candidate) => candidate.release === null);
  const versioned = candidates.filter(
    (candidate) => candidate.release !== null,
  );
  if (release !== undefined) {
    const honoured = candidates[0]?.view.multiRelease === true;
    const eligible = honoured
      ? versioned
          .filter((candidate) => (candidate.release ?? 0) <= release)
          .sort((a, b) => (b.release ?? 0) - (a.release ?? 0))[0]
      : undefined;
    const chosen = eligible ?? base;
    if (chosen === undefined)
      return {
        field: "release",
        message: `No variant of this class applies to release ${String(release)}; variants exist for ${listed(versioned.map((candidate) => String(candidate.release)))}.`,
      };
    return { chosen, basis: "release" };
  }
  if (base !== undefined)
    return { chosen: base, basis: candidates.length === 1 ? "only" : "base" };
  if (versioned.length === 1 && versioned[0] !== undefined)
    return { chosen: versioned[0], basis: "only" };
  return {
    field: "release",
    message: `This class exists only as multi-release variants (${listed(versioned.map((candidate) => String(candidate.release)))}); pass release to choose one.`,
  };
};

/** Resolve the caller's selector to one class's bytes. */
export const selectClass = async (
  source: JvmSource,
  selector: Selector,
  budget: DecodeBudget,
  signal?: AbortSignal,
): Promise<SelectedClass | SelectionProblem> => {
  if (source.kind === "class") {
    for (const field of ["entry", "container", "release"] as const)
      if (selector[field] !== undefined)
        return {
          field,
          message: `The file is a single class file; ${field} applies only to JAR and AAR archives.`,
        };
    const parsed = parseClass(source.bytes);
    if (parsed === null)
      return { field: "class", message: "The file is not a class file." };
    if (
      selector.class !== undefined &&
      internalName(selector.class) !== parsed.thisClass
    )
      return {
        field: "class",
        message: `The file holds ${parsed.thisClass ?? "an unnamed class"}, not ${selector.class}.`,
      };
    return {
      bytes: source.bytes,
      parsed,
      place: {
        container: null,
        entry: null,
        release: null,
        sha256: sha256Hex(source.bytes),
        bytes: source.bytes.length,
      },
      selection: {
        container: null,
        entry: null,
        release: null,
        basis: "file",
        variants: [],
      },
    };
  }
  let views = viewsOf(source);
  if (selector.container !== undefined) {
    const view = views.find(
      (candidate) => candidate.container === selector.container,
    );
    if (view === undefined) {
      const jar = source.embedded.find(
        (candidate) => candidate.entry === selector.container,
      );
      return {
        field: "container",
        message:
          jar === undefined
            ? `No embedded JAR is named ${selector.container}; embedded JARs: ${listed(source.embedded.map((candidate) => candidate.entry)) || "none"}.`
            : `${selector.container} could not be opened: ${jar.failure?.message ?? "unknown reason"}`,
      };
    }
    views = [view];
  }
  let candidates: ClassMember[];
  let chosen: { chosen: ClassMember; basis: Selection["basis"] };
  if (selector.entry !== undefined) {
    const matches = views.flatMap((view) =>
      classMembers(view).filter(
        (member) => member.member.path === selector.entry,
      ),
    );
    if (matches.length === 0)
      return {
        field: "entry",
        message: `No .class member is named ${selector.entry}${selector.container === undefined ? "" : ` in ${selector.container}`}.`,
      };
    if (matches.length > 1)
      return {
        field: "container",
        message: `${selector.entry} exists in several JARs (${listed(matches.map((match) => match.view.container ?? "the archive"))}); pass container.`,
      };
    const match = matches[0] as ClassMember;
    candidates = classMembers(match.view).filter(
      (member) => member.logical === match.logical,
    );
    chosen = { chosen: match, basis: "entry" };
  } else {
    let logical: string;
    if (selector.class !== undefined)
      logical = `${internalName(selector.class)}.class`;
    else {
      const all = views.flatMap((view) => classMembers(view));
      const distinct = new Set(
        all.map(
          (member) => `${member.view.container ?? ""}\u0000${member.logical}`,
        ),
      );
      if (distinct.size !== 1 || all[0] === undefined)
        return {
          field: "class",
          message: `The archive holds ${String(distinct.size)} classes; pass class or entry to choose one.`,
        };
      logical = all[0].logical;
    }
    const byView = views
      .map((view) =>
        classMembers(view).filter((member) => member.logical === logical),
      )
      .filter((list) => list.length > 0);
    if (byView.length === 0)
      return {
        field: "class",
        message: `No class ${selector.class ?? logical} is in the archive${selector.container === undefined ? "" : ` member ${selector.container}`}.`,
      };
    if (byView.length > 1)
      return {
        field: "container",
        message: `${selector.class ?? logical} is in several JARs (${listed(byView.map((list) => list[0]?.view.container ?? "the archive"))}); pass container.`,
      };
    candidates = byView[0] as ClassMember[];
    const variant = chooseVariant(candidates, selector.release);
    if ("field" in variant) return variant;
    chosen = variant;
  }
  const { member, view, release } = chosen.chosen;
  const bytes = await view.zip.read(member.path, budget, signal);
  const parsed = parseClass(bytes);
  if (parsed === null)
    return {
      field: "entry",
      message: `${member.path} has a .class name but is not a class file.`,
    };
  return {
    bytes,
    parsed,
    place: {
      container: view.container,
      entry: member.path,
      release,
      sha256: sha256Hex(bytes),
      bytes: bytes.length,
    },
    selection: {
      container: view.container,
      entry: member.path,
      release,
      basis: chosen.basis,
      variants: variantsOf(candidates),
    },
  };
};

/**
 * Another class from the same archive (or embedded JAR) as `selected`,
 * resolved for the same multi-release release. Null when it is absent or
 * cannot be read as a class.
 */
export const relatedClass = async (
  source: JvmSource,
  selected: SelectedClass,
  internal: string,
  budget: DecodeBudget,
  signal?: AbortSignal,
): Promise<SelectedClass | null> => {
  if (source.kind === "class") return null;
  const view = viewsOf(source).find(
    (candidate) => candidate.container === selected.selection.container,
  );
  if (view === undefined) return null;
  const candidates = classMembers(view).filter(
    (member) => member.logical === `${internal}.class`,
  );
  const variant = chooseVariant(
    candidates,
    selected.selection.release ?? undefined,
  );
  if ("field" in variant) return null;
  const { member, release } = variant.chosen;
  const bytes = await view.zip.read(member.path, budget, signal);
  const parsed = parseClass(bytes);
  if (parsed === null) return null;
  return {
    bytes,
    parsed,
    place: {
      container: view.container,
      entry: member.path,
      release,
      sha256: sha256Hex(bytes),
      bytes: bytes.length,
    },
    selection: {
      container: view.container,
      entry: member.path,
      release,
      basis: variant.basis,
      variants: variantsOf(candidates),
    },
  };
};

const diagnostics = (parsed: ClassFile, place: ClassPlace) => [
  ...parsed.problems.map((problem) => ({
    container: place.container,
    entry: place.entry,
    offset: problem.offset,
    message: problem.message,
  })),
  ...(parsed.stopped === null
    ? []
    : [
        {
          container: place.container,
          entry: place.entry,
          offset: parsed.stopped.offset,
          message: parsed.stopped.message,
        },
      ]),
];

const RECONSTRUCT: FacetCoverage = {
  facet: "reconstruct",
  state: "not_requested",
  examined: null,
  omitted: null,
  reason:
    "Bytecode is reported as observed; decompile_jvm_class reconstructs inferred source for this class.",
  continuation: null,
};

const skippedNames = (parsed: ClassFile): string[] => {
  const names = new Set<string>();
  const add = (list: readonly { name: string | null; state: string }[]) =>
    list.forEach((attribute) => {
      if (attribute.state === "skipped" && attribute.name !== null)
        names.add(attribute.name);
    });
  add(parsed.attributes);
  for (const field of parsed.fields) add(field.attributes);
  for (const method of parsed.methods) {
    add(method.attributes);
    if (method.code !== null) add(method.code.attributes);
  }
  return [...names].sort();
};

export const classReport = (
  artifact: JvmClassReport["artifact"],
  selected: SelectedClass,
): JvmClassReport => {
  const { parsed, place } = selected;
  const detail = classDetail(parsed, place);
  const skipped = skippedNames(parsed);
  const complete = detail.decode === "complete";
  return {
    artifact,
    selection: selected.selection,
    class: detail,
    diagnostics: diagnostics(parsed, place),
    coverage: [
      {
        facet: "identify",
        state: "complete",
        examined: "class file magic and version",
        omitted: null,
        reason: null,
        continuation: null,
      },
      complete
        ? {
            facet: "inspect",
            state: "complete",
            examined:
              "constant pool, fields, methods and every standard attribute this reader decodes",
            omitted: null,
            reason: null,
            continuation: null,
          }
        : {
            facet: "inspect",
            state: "partial",
            examined: "structures before the first damaged byte or attribute",
            omitted: "facts after the damage",
            reason: detail.error ?? "The class file is damaged.",
            continuation: null,
          },
      RECONSTRUCT,
    ],
    limitations: [
      "The class was parsed from bytes; it was not loaded, linked, verified or initialized.",
      ...(skipped.length === 0
        ? []
        : [
            `These attributes are located but not decoded: ${skipped.join(", ")}.`,
          ]),
      ...(selected.selection.variants.length > 1
        ? [
            `This class has ${String(selected.selection.variants.length)} multi-release variants; the one read is named in selection.`,
          ]
        : []),
    ],
  };
};

/** Choose one method by name and, when overloaded, descriptor. */
export const selectMethod = (
  parsed: ClassFile,
  name: string,
  descriptor: string | undefined,
): MethodInfo | SelectionProblem => {
  const named = parsed.methods.filter((method) => method.name === name);
  if (named.length === 0)
    return {
      field: "method",
      message: `${parsed.thisClass ?? "The class"} has no method named ${name}.`,
    };
  if (descriptor !== undefined) {
    const exact = named.find((method) => method.descriptor === descriptor);
    return (
      exact ?? {
        field: "descriptor",
        message: `${name} has no overload ${descriptor}; it has ${listed(named.map((method) => method.descriptor ?? "?"))}.`,
      }
    );
  }
  if (named.length > 1)
    return {
      field: "descriptor",
      message: `${name} is overloaded (${listed(named.map((method) => method.descriptor ?? "?"))}); pass descriptor.`,
    };
  return named[0] as MethodInfo;
};

export const methodReport = (
  artifact: JvmMethodReport["artifact"],
  selected: SelectedClass,
  method: MethodInfo,
  start: number,
  limit: number,
): JvmMethodReport => {
  const { parsed, place, bytes } = selected;
  const pool = parsed.pool;
  const code = method.code;
  const base = {
    artifact,
    selection: selected.selection,
    class: { name: parsed.thisClass, version: versionOf(parsed) },
    method: methodSummary(method, parsed.thisClass),
  };
  const empty = {
    invocations: [],
    dynamic: [],
    fields: [],
    types: [],
    constants: [],
  };
  if (code === null || pool === null) {
    const why =
      (method.access & 0x0100) !== 0
        ? "native"
        : (method.access & 0x0400) !== 0
          ? "abstract"
          : "without a Code attribute";
    return {
      ...base,
      instruction_count: 0,
      page: { start, limit, returned: 0, next: null },
      instructions: [],
      exception_table: [],
      line_numbers: [],
      local_variables: [],
      references: empty,
      diagnostics: diagnostics(parsed, place),
      coverage: [
        {
          facet: "inspect",
          state: "unavailable",
          examined: null,
          omitted: null,
          reason: `The method is ${why}, so it has no bytecode.`,
          continuation: null,
        },
        RECONSTRUCT,
      ],
      limitations: [],
    };
  }
  const budget = new TextBudget();
  const decoded = decodeBytecode(
    bytes,
    code.codeOffset,
    code.codeLength,
    pool,
    budget,
  );
  const lines = [...code.lineNumbers].sort((a, b) => a.pc - b.pc);
  const lineAt = (pc: number): number | null => {
    let line: number | null = null;
    for (const entry of lines) {
      if (entry.pc > pc) break;
      line = entry.line;
    }
    return line;
  };
  const references: JvmMethodReport["references"] = {
    invocations: [],
    dynamic: [],
    fields: [],
    types: [],
    constants: [],
  };
  for (const instruction of decoded.instructions) {
    const cp = instruction.cp;
    if (cp === null) continue;
    const at = { instruction: instruction.index, pc: instruction.pc };
    const op = instruction.opcode.name;
    switch (instruction.opcode.role) {
      case "method": {
        const member = pool.member(cp);
        references.invocations.push({
          ...at,
          op,
          interface: member?.kind === "InterfaceMethodref",
          target: {
            owner: budget.takeOrNull(member?.owner ?? null),
            name: budget.takeOrNull(member?.name ?? null),
            descriptor: budget.takeOrNull(member?.descriptor ?? null),
          },
        });
        break;
      }
      case "field": {
        const member = pool.member(cp);
        references.fields.push({
          ...at,
          op,
          target: {
            owner: budget.takeOrNull(member?.owner ?? null),
            name: budget.takeOrNull(member?.name ?? null),
            descriptor: budget.takeOrNull(member?.descriptor ?? null),
          },
        });
        break;
      }
      case "class":
        references.types.push({
          ...at,
          op,
          type: budget.takeOrNull(pool.className(cp)),
        });
        break;
      case "constant": {
        const constant = pool.constantText(cp);
        if (constant !== null)
          references.constants.push({
            ...at,
            op,
            ...constant,
            value: budget.take(constant.value),
          });
        break;
      }
      case "dynamic": {
        const entry = pool.get(cp);
        const nat =
          entry?.tag === "InvokeDynamic"
            ? pool.nameAndType(entry.nameAndType)
            : null;
        const bootstrap =
          entry?.tag === "InvokeDynamic"
            ? parsed.bootstrapMethods[entry.bootstrap]
            : undefined;
        references.dynamic.push({
          ...at,
          name: budget.takeOrNull(nat?.name ?? null),
          descriptor: budget.takeOrNull(nat?.descriptor ?? null),
          bootstrap:
            bootstrap === undefined
              ? null
              : {
                  index: bootstrap.index,
                  handle: budget.takeOrNull(bootstrap.handle),
                  arguments: bootstrap.arguments.map((text) =>
                    budget.take(text),
                  ),
                },
        });
        break;
      }
      case null:
        break;
    }
  }
  const page = decoded.instructions.slice(start, start + limit);
  const total = decoded.instructions.length;
  return {
    ...base,
    instruction_count: total,
    page: {
      start,
      limit,
      returned: page.length,
      next: start + page.length < total ? start + page.length : null,
    },
    instructions: page.map((instruction) => ({
      index: instruction.index,
      pc: instruction.pc,
      offset: instruction.offset,
      size: instruction.size,
      op: `${instruction.opcode.name}${instruction.wide ? "_w" : ""}`,
      operands: instruction.operands,
      line: lineAt(instruction.pc),
    })),
    exception_table: code.handlers.map((handler) => ({
      start_pc: handler.startPc,
      end_pc: handler.endPc,
      handler_pc: handler.handlerPc,
      catch_type: handler.catchType,
    })),
    line_numbers: lines.map((entry) => ({ ...entry })),
    local_variables: code.localVariables.map((local) => ({
      slot: local.slot,
      name: local.name,
      descriptor: local.descriptor,
      signature: local.signature,
      start_pc: local.startPc,
      length: local.length,
    })),
    references,
    diagnostics: [
      ...diagnostics(parsed, place),
      ...decoded.problems.map((problem) => ({
        container: place.container,
        entry: place.entry,
        offset: problem.offset,
        message: problem.message,
      })),
      ...(decoded.stopped === null
        ? []
        : [
            {
              container: place.container,
              entry: place.entry,
              offset: decoded.stopped.offset,
              message: decoded.stopped.message,
            },
          ]),
    ],
    coverage: [
      decoded.stopped === null
        ? {
            facet: "inspect",
            state: "complete",
            examined: `all ${String(code.codeLength)} bytes of the code array`,
            omitted: null,
            reason: null,
            continuation: null,
          }
        : {
            facet: "inspect",
            state: "partial",
            examined: `code bytes before pc ${String(decoded.stopped.offset - code.codeOffset)}`,
            omitted: "the rest of the code array",
            reason: decoded.stopped.message,
            continuation: null,
          },
      RECONSTRUCT,
    ],
    limitations: [
      "Instructions are decoded, not executed or verified; the line for each instruction comes from the LineNumberTable.",
      ...(budget.shortened
        ? [
            "Long text repeated across this method is shown in full for its first 4 MiB and shortened to its start and length after that.",
          ]
        : []),
      ...(code.lineNumbers.length === 0
        ? [
            "The class has no line numbers for this method (compiled without -g:lines).",
          ]
        : []),
      ...(code.localVariables.length === 0
        ? [
            "The class has no local variable names for this method (compiled without -g:vars).",
          ]
        : []),
    ],
  };
};
