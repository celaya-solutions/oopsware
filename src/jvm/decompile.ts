import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { readStableArtifact } from "../artifacts/readStableArtifact.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
  AnalysisUnsupportedTargetError,
} from "../domain/analysisErrorCore.js";
import type { FacetCoverage } from "../domain/formatRegistry.js";
import {
  MAX_JVM_MEMBER_BYTES,
  type DecompileJvmClassInput,
  type JvmDecompilation,
} from "../domain/jvm/jvm.js";
import { OwnedCommandFailure } from "../process/OwnedCommand.js";
import { DecodeBudget, sha256Hex } from "../artifacts/zipMemberView.js";
import { decodeBytecode } from "./classfile/bytecode.js";
import { parseClass, type ClassFile } from "./classfile/parseClass.js";
import {
  relatedClass,
  selectClass,
  type SelectedClass,
} from "./classReport.js";
import { closeSource, openJvmSource, type JvmSource } from "./source.js";
import {
  VineflowerUnavailable,
  stageVineflower,
  type ResolvedVineflower,
} from "./vineflower.js";

import {
  decompilerCleanupFailure,
  withDecompilerScratch,
} from "./decompilerScratch.js";

/** Nested classes past this many are reported missing rather than read. */
const MAX_CLASSES = 10_000;
/** Outer-class chains longer than this are malformed. */
const MAX_DEPTH = 64;
const OUTPUT_BYTES = 1024 ** 2;
const commandScratches = new WeakMap<OwnedCommandFailure, string>();

/** Options passed to every run, reported verbatim as provenance. */
const OPTIONS = ["--log-level=warn", "--thread-count=1", "--folder"];

type Input = JvmDecompilation["inputs"][number];

interface Loaded {
  readonly name: string;
  readonly role: Input["role"];
  readonly bytes: Uint8Array;
  readonly parsed: ClassFile;
  readonly identity: Omit<Input, "name" | "role">;
}

/** Where related classes come from: the same archive view, or sibling files next to a loose class. */
interface Lookup {
  find(internal: string): Promise<Loaded | null>;
}

const fromSelected = (
  selected: SelectedClass,
  role: Input["role"],
): Loaded => ({
  name: selected.parsed.thisClass ?? "",
  role,
  bytes: selected.bytes,
  parsed: selected.parsed,
  identity: {
    container: selected.place.container,
    entry: selected.place.entry,
    file: null,
    release: selected.place.release,
    sha256: sha256Hex(selected.bytes),
    bytes: selected.bytes.length,
  },
});

const archiveLookup = (
  source: JvmSource,
  selected: SelectedClass,
  budget: DecodeBudget,
  signal?: AbortSignal,
): Lookup => ({
  find: async (internal) => {
    const found = await relatedClass(
      source,
      selected,
      internal,
      budget,
      signal,
    );
    return found === null ? null : fromSelected(found, "nested");
  },
});

/** Sibling files are read only when the caller asked, with the same stable-read checks. */
const siblingLookup = (
  path: string,
  topName: string,
  maxBytes: number,
  signal?: AbortSignal,
): Lookup => {
  const directory = dirname(path);
  const own = basename(path, ".class");
  // The top-level simple name: nested classes are Top$..., by javac's naming.
  const ownPrefix = (topName.split("/").at(-1) ?? "").split("$")[0] ?? "";
  return {
    find: async (internal) => {
      const simple = internal.split("/").at(-1) ?? "";
      // Only Outer and Outer$... files of the same top-level class, never another class.
      if (
        simple === own ||
        !(simple === ownPrefix || simple.startsWith(`${ownPrefix}$`))
      )
        return null;
      const file = join(directory, `${simple}.class`);
      try {
        const snapshot = await readStableArtifact(file, maxBytes, signal);
        const parsed = parseClass(snapshot.bytes);
        if (parsed?.thisClass !== internal) return null;
        return {
          name: internal,
          role: "nested",
          bytes: snapshot.bytes,
          parsed,
          identity: {
            container: null,
            entry: null,
            file,
            release: null,
            sha256: snapshot.sha256,
            bytes: snapshot.bytes.length,
          },
        };
      } catch {
        return null;
      }
    },
  };
};

/** The class that encloses `parsed`, from InnerClasses, EnclosingMethod or NestHost. */
const outerOf = (parsed: ClassFile): string | null => {
  const self = parsed.thisClass;
  const member = parsed.innerClasses.find(
    (entry) => entry.inner === self && entry.outer !== null,
  );
  if (member?.outer != null) return member.outer;
  if (parsed.enclosingMethod?.class != null)
    return parsed.enclosingMethod.class;
  return parsed.nestHost;
};

/** Classes `parsed` declares as nested in it (member, local and anonymous). */
const nestedOf = (parsed: ClassFile): string[] => {
  const self = parsed.thisClass ?? "";
  const names = new Set<string>();
  for (const entry of parsed.innerClasses)
    if (
      entry.inner !== null &&
      entry.inner !== self &&
      (entry.outer === self ||
        (entry.outer === null && entry.inner.startsWith(`${self}$`)))
    )
      names.add(entry.inner);
  for (const member of parsed.nestMembers)
    if (member !== null) names.add(member);
  return [...names];
};

/** A class name is used as a scratch path only when every segment is an ordinary name. */
export const safeInternalName = (name: string): boolean =>
  name.length > 0 &&
  name.length <= 1024 &&
  name
    .split("/")
    .every(
      (segment) =>
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        !/[\\\0:]/u.test(segment),
    );

/** Walk to the outermost class, then gather every nested class it names. */
const gatherClasses = async (selected: SelectedClass, lookup: Lookup) => {
  const loaded = new Map<string, Loaded>();
  const missing = new Set<string>();
  let top = fromSelected(selected, "selected");
  loaded.set(top.name, top);
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    const outer = outerOf(top.parsed);
    if (outer === null || outer === top.name || loaded.has(outer)) break;
    const found = await lookup.find(outer);
    if (found === null) {
      missing.add(outer);
      break;
    }
    top = { ...found, role: "outer" };
    loaded.set(top.name, top);
  }
  const queue = [top.name, ...loaded.keys()];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const name = queue.shift() ?? "";
    if (seen.has(name)) continue;
    seen.add(name);
    const current = loaded.get(name);
    if (current === undefined) continue;
    for (const nested of nestedOf(current.parsed)) {
      if (loaded.has(nested) || missing.has(nested)) continue;
      if (loaded.size >= MAX_CLASSES) {
        missing.add(nested);
        continue;
      }
      const found = await lookup.find(nested);
      if (found === null) missing.add(nested);
      else {
        loaded.set(nested, found);
        queue.push(nested);
      }
    }
  }
  return {
    top: top.name,
    loaded: [...loaded.values()],
    missing: [...missing].sort(),
  };
};

/** Methods whose bytes this reader could not decode cleanly, so their decompiled bodies are suspect. */
const untrustedMethods = (
  classes: readonly Loaded[],
): JvmDecompilation["untrusted_methods"] => {
  const found: JvmDecompilation["untrusted_methods"] = [];
  for (const { parsed, bytes } of classes) {
    if (parsed.stopped !== null)
      found.push({
        class: parsed.thisClass,
        method: null,
        descriptor: null,
        reason: `The class stops at byte ${String(parsed.stopped.offset)}: ${parsed.stopped.message}`,
      });
    for (const method of parsed.methods) {
      if (method.code === null || parsed.pool === null) continue;
      const decoded = decodeBytecode(
        bytes,
        method.code.codeOffset,
        method.code.codeLength,
        parsed.pool,
      );
      const problem = decoded.stopped ?? decoded.problems[0];
      if (problem !== undefined)
        found.push({
          class: parsed.thisClass,
          method: method.name,
          descriptor: method.descriptor,
          reason: problem.message,
        });
    }
  }
  return found;
};

/**
 * Vineflower prints an invokedynamic call it could not turn back into Java as
 * `Owner.name<"bootstrap", ...>(...)` (Java 21 pattern switches, for one). That
 * is not valid Java and it adds no `$VF:` comment, so such lines are found here.
 */
const UNRESOLVED_DYNAMIC = /\b[\w$]+(?:\.[\w$]+)*<"[^"]*"/u;

const notesOf = (text: string): JvmDecompilation["decompiler_notes"] =>
  text
    .split("\n")
    .flatMap((line, index) => {
      if (line.includes("$VF:"))
        return [{ line: index + 1, text: line.trim() }];
      if (UNRESOLVED_DYNAMIC.test(line))
        return [
          {
            line: index + 1,
            text: `Unresolved invokedynamic left as pseudo-Java (not valid source): ${line.trim()}`,
          },
        ];
      return [];
    })
    .slice(0, 1000);

const messagesOf = (...streams: string[]): string[] =>
  streams
    .flatMap((stream) => stream.split("\n"))
    .map((line) => line.trim())
    .filter((line) => /^(WARN|ERROR)\b/u.test(line))
    .slice(0, 200);

export interface DecompileRequest {
  readonly artifact: JvmDecompilation["artifact"];
  readonly artifactBytes: Uint8Array;
  readonly source: JvmSource;
  readonly selected: SelectedClass;
  readonly budget: DecodeBudget;
  readonly input: DecompileJvmClassInput;
  readonly tool: ResolvedVineflower;
  readonly signal?: AbortSignal | undefined;
}

/** A failure the provider maps to a typed error; `snapshot` keeps the decompiler's output. */
export class DecompileFailure extends Error {
  constructor(
    readonly reason:
      | "unsafe-name"
      | "no-output"
      | "too-large"
      | "missing-class",
    message: string,
  ) {
    super(message);
    this.name = "DecompileFailure";
  }
}

const library = async (
  request: DecompileRequest,
): Promise<{ bytes: Uint8Array; container: string | null } | null> => {
  const { source, selected, budget, signal } = request;
  if (source.kind === "class") return null;
  const container = selected.selection.container;
  if (container === null)
    return source.kind === "jar"
      ? { bytes: request.artifactBytes, container: null }
      : null;
  return {
    bytes: await source.outer.zip.read(container, budget, signal),
    container,
  };
};

/** Run the admitted Vineflower over one class and its nested classes in an owned scratch tree. */
export const decompileClass = async (
  request: DecompileRequest,
): Promise<JvmDecompilation> => {
  const { selected, input, tool, signal } = request;
  const lookup =
    request.source.kind === "class"
      ? input.siblings
        ? siblingLookup(
            input.path,
            selected.parsed.thisClass ?? "",
            input.max_file_bytes,
            signal,
          )
        : { find: () => Promise.resolve(null) }
      : archiveLookup(request.source, selected, request.budget, signal);
  const gathered = await gatherClasses(selected, lookup);
  const unsafe = gathered.loaded.find((entry) => !safeInternalName(entry.name));
  if (unsafe !== undefined)
    throw new DecompileFailure(
      "unsafe-name",
      `The class name ${JSON.stringify(unsafe.name)} cannot be used as a file name, so it is not decompiled.`,
    );
  const lib = await library(request);
  return withDecompilerScratch("vineflower", async (scratch, run) => {
    const jar = join(scratch, "vineflower.jar");
    await stageVineflower(tool, jar);
    const inputs = join(scratch, "in");
    const outputs = join(scratch, "out");
    await mkdir(outputs, { recursive: true });
    await mkdir(join(scratch, "home"));
    await mkdir(join(scratch, "tmp"));
    for (const entry of gathered.loaded) {
      const file = join(inputs, `${entry.name}.class`);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, entry.bytes, { flag: "wx" });
    }
    const libraryArguments: string[] = [];
    if (lib !== null) {
      const path = join(scratch, "library.jar");
      await writeFile(path, lib.bytes, { flag: "wx" });
      libraryArguments.push(`-e=${path}`);
    }
    const snapshot = await run(
      {
        command: tool.java,
        arguments: [
          `-Xmx${String(input.max_heap_mib)}m`,
          "-Xss16m",
          "-XX:+UseSerialGC",
          "-Djava.awt.headless=true",
          `-Duser.home=${join(scratch, "home")}`,
          `-Djava.io.tmpdir=${join(scratch, "tmp")}`,
          "-jar",
          jar,
          ...OPTIONS,
          ...libraryArguments,
          inputs,
          outputs,
        ],
        runId: randomUUID(),
        cwd: scratch,
        // No inherited JAVA_TOOL_OPTIONS, classpath or agent settings reach the decompiler.
        hostEnvironment: {},
        ...(signal === undefined ? {} : { signal }),
      },
      { timeoutMs: input.timeout_ms, diagnosticBytes: OUTPUT_BYTES },
      signal === undefined ? {} : { signal },
    ).catch((cause: unknown) => {
      if (
        !(cause instanceof OwnedCommandFailure) ||
        cause.processError !== undefined
      )
        throw new VineflowerUnavailable(
          `Cannot start Vineflower with ${tool.java}: ${cause instanceof Error ? cause.message.replaceAll(scratch, "<scratch>") : String(cause)}`,
          { cause },
        );
      commandScratches.set(cause, scratch);
      throw cause;
    });
    const messages = messagesOf(snapshot.stdout.text, snapshot.stderr.text).map(
      (line) => line.replaceAll(scratch, "<scratch>"),
    );
    const file = `${gathered.top}.java`;
    let bytes: Buffer;
    try {
      bytes = await readFile(join(outputs, file));
    } catch {
      const written = (await readdir(outputs, { recursive: true })).filter(
        (name) => String(name).endsWith(".java"),
      );
      throw new DecompileFailure(
        "no-output",
        `Vineflower wrote no ${file}${written.length > 0 ? ` (it wrote ${written.slice(0, 5).join(", ")})` : ""}.${messages.length > 0 ? ` ${messages.slice(0, 3).join(" ")}` : ""}`,
      );
    }
    if (bytes.length > input.max_source_bytes)
      throw new DecompileFailure(
        "too-large",
        `The reconstructed source is ${String(bytes.length)} bytes, over max_source_bytes (${String(input.max_source_bytes)}).`,
      );
    const text = bytes.toString("utf8");
    const notes = notesOf(text);
    const untrusted = untrustedMethods(gathered.loaded);
    const inputsReport: Input[] = gathered.loaded.map((entry) => ({
      name: entry.name,
      role: entry.role,
      ...entry.identity,
    }));
    const omitted = [
      ...(gathered.missing.length > 0
        ? [
            `${String(gathered.missing.length)} nested classes that were not available`,
          ]
        : []),
      ...(untrusted.length > 0
        ? [
            `${String(untrusted.length)} methods whose bytecode did not decode cleanly`,
          ]
        : []),
      ...(notes.length > 0
        ? [`${String(notes.length)} places the decompiler marked as uncertain`]
        : []),
    ];
    const reconstruct: FacetCoverage =
      omitted.length === 0
        ? {
            facet: "reconstruct",
            state: "complete",
            examined: `${String(inputsReport.length)} class files decompiled into ${file}`,
            omitted: null,
            reason: null,
            continuation: null,
          }
        : {
            facet: "reconstruct",
            state: "partial",
            examined: `${String(inputsReport.length)} class files decompiled into ${file}`,
            omitted: omitted.join("; "),
            reason:
              "The decompiled text is incomplete or uncertain in the places listed.",
            continuation:
              gathered.missing.length > 0 &&
              request.source.kind === "class" &&
              !input.siblings
                ? "Pass siblings: true, or read the class from its JAR."
                : null,
          };
    return {
      artifact: request.artifact,
      selection: selected.selection,
      top_level: gathered.top,
      inputs: inputsReport,
      missing_nested: gathered.missing,
      library:
        lib === null
          ? null
          : { container: lib.container, sha256: sha256Hex(lib.bytes) },
      decompiler: {
        id: "vineflower",
        version: tool.version,
        build: tool.build,
        jar: { path: tool.jar, sha256: tool.jarSha256 },
        java: { path: tool.java, version: tool.javaVersion },
        options: [...OPTIONS, ...(lib === null ? [] : ["-e=<library.jar>"])],
      },
      source: {
        file,
        text,
        bytes: bytes.length,
        sha256: sha256Hex(bytes),
        lines:
          text.length === 0
            ? 0
            : text.split("\n").length - (text.endsWith("\n") ? 1 : 0),
        media_type: "text/x-java; charset=utf-8",
        confidence: "inferred",
        derived_from: inputsReport.map((entry) => entry.sha256),
      },
      decompiler_notes: notes,
      untrusted_methods: untrusted,
      messages,
      coverage: [reconstruct],
      limitations: [
        "This Java source is reconstructed by Vineflower from bytecode. It is inferred, not the original source: names of locals come only from debug tables, comments and formatting are lost, and it may not compile.",
        "Vineflower read the class files and library as data in its own Java process; no target class was loaded or run.",
        ...(untrusted.length > 0
          ? [
              "Vineflower can print a body for bytecode this reader rejects; bodies of the untrusted methods are not evidence of behavior.",
            ]
          : []),
        ...(gathered.missing.length > 0
          ? [
              `Nested classes missing from the input are not in the text: ${gathered.missing.slice(0, 10).join(", ")}${gathered.missing.length > 10 ? " and more" : ""}.`,
            ]
          : []),
      ],
    };
  });
};

/** Limits of one decompiler run, as decompile_jvm_class and decompile_dex_class take them. */
export type DecompileLimits = Pick<
  DecompileJvmClassInput,
  "timeout_ms" | "max_heap_mib" | "max_source_bytes" | "max_decoded_bytes"
>;

/**
 * Decompile one class of a JAR held in memory (dex2jar's output, for one)
 * exactly as decompile_jvm_class does: the class, its outer and nested
 * classes from the same JAR, and the JAR itself as type context.
 */
export const decompileJarClass = async (request: {
  /** JAR bytes; `name` is the label reported for them and must end in .jar. */
  readonly jar: Uint8Array;
  readonly name: string;
  /** Internal name, e.g. com/example/Main$Inner. */
  readonly className: string;
  readonly limits: DecompileLimits;
  readonly tool: ResolvedVineflower;
  readonly signal?: AbortSignal | undefined;
}): Promise<JvmDecompilation> => {
  const { jar, name, className, limits, tool, signal } = request;
  const budget = new DecodeBudget(
    limits.max_decoded_bytes,
    MAX_JVM_MEMBER_BYTES,
  );
  const source = await openJvmSource(jar, name, budget, sha256Hex, signal);
  try {
    if (source === null || source.kind === "class")
      throw new DecompileFailure("no-output", `${name} is not a JAR.`);
    const selected = await selectClass(
      source,
      { class: className },
      budget,
      signal,
    );
    if ("field" in selected)
      throw new DecompileFailure("missing-class", selected.message);
    return await decompileClass({
      artifact: { path: name, sha256: sha256Hex(jar), bytes: jar.length },
      artifactBytes: jar,
      source,
      selected,
      budget,
      input: {
        path: name,
        class: className,
        siblings: false,
        ...limits,
        max_file_bytes: Math.max(1, jar.length),
      },
      tool,
      signal,
    });
  } finally {
    await closeSource(source);
  }
};

/** Typed errors for a Vineflower run that produced no usable source; null for anything else. */
export const vineflowerFailure = (
  operation: string,
  path: string,
  limits: Pick<DecompileLimits, "timeout_ms" | "max_source_bytes">,
  cause: unknown,
): AnalysisError | null => {
  const cleanup = decompilerCleanupFailure(cause, operation, (primary) =>
    vineflowerFailure(operation, path, limits, primary),
  );
  if (cleanup !== null) return cleanup;
  if (cause instanceof VineflowerUnavailable)
    return new AnalysisCapabilityUnavailableError(
      "vineflower",
      operation,
      cause.message,
      { cause },
    );
  if (cause instanceof DecompileFailure)
    return cause.reason === "too-large"
      ? new AnalysisResourceConstraintError(
          operation,
          "memory",
          cause.message,
          { max_source_bytes: limits.max_source_bytes },
          {
            cause,
            remediationAction: "Raise max_source_bytes (up to 32 MiB).",
          },
        )
      : new AnalysisUnsupportedTargetError(operation, path, cause.message, {
          cause,
        });
  if (!(cause instanceof OwnedCommandFailure)) return null;
  const scratch = commandScratches.get(cause);
  const output = cause.snapshot?.stderr.text ?? "";
  const stderr = (
    scratch === undefined ? output : output.replaceAll(scratch, "<scratch>")
  )
    .trim()
    .split("\n")
    .slice(-3)
    .join(" ");
  switch (cause.reason) {
    case "cancelled":
      return new AnalysisCancelledError(operation, { cause });
    case "timeout":
      return new AnalysisTimeoutError(operation, limits.timeout_ms, { cause });
    case "output-limit":
      return new AnalysisResourceConstraintError(
        operation,
        "memory",
        "Vineflower printed more diagnostics than the capture budget.",
        null,
        { cause },
      );
    case "process":
      return new AnalysisUnsupportedTargetError(
        operation,
        path,
        `Vineflower exited with code ${String(cause.snapshot?.exitCode ?? "unknown")}${stderr === "" ? "" : `: ${stderr}`}`,
        { cause },
      );
  }
};
