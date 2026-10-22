import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import type { BinaryTarget } from "../../domain/binaryTargetTypes.js";
import type { FacetCoverage } from "../../domain/formatRegistry.js";
import type { ManagedMemberInspection } from "../../domain/managed/managedArtifact.js";
import type {
  DecompileManagedTypeInput,
  ManagedDecompilation,
} from "../../domain/managed/managedDecompilation.js";
import {
  OwnedCommandFailure,
  runOwnedCommand,
} from "../../process/OwnedCommand.js";
import { inspectManagedMembersBytes } from "../ManagedMemberInspector.js";
import type { ManagedPeLayout } from "../ManagedPeReader.js";
import { dotnetDirectory, type ResolvedIlspy } from "./ilspycmd.js";

const DIAGNOSTIC_BYTES = 4 * 1024 ** 2;
const MAX_MESSAGES = 200;
const MAX_NOTES = 1000;
const MAX_LINE_CHARS = 1000;
const MAX_MISSING_LISTED = 200;
/** Never let ilspycmd ask NuGet for a newer version. */
const FIXED_OPTIONS = ["--disable-updatecheck"];

/**
 * Lines ILSpy writes where a body did not decompile cleanly: IL offsets it
 * could not type (`//IL_004b: Unknown result type ...`) and the comment block
 * it leaves when a method throws inside the decompiler.
 */
const NOTE_PATTERN =
  /^\s*\/\/IL_[0-9A-Fa-f]{4}:|An exception occurred when decompiling|might be due to invalid IL or missing references/u;

export class ManagedDecompileFailure extends Error {
  readonly _tag = "ManagedDecompileFailure";
  constructor(
    readonly reason: "type-not-found" | "no-output" | "too-large" | "crashed",
    message: string,
  ) {
    super(message);
  }
}

type Type = ManagedMemberInspection["types"][number];

export interface ManagedDecompileRequest {
  readonly artifact: ManagedDecompilation["artifact"];
  readonly bytes: Buffer;
  readonly layout: ManagedPeLayout;
  readonly input: DecompileManagedTypeInput;
  readonly tool: ResolvedIlspy;
  readonly signal?: AbortSignal | undefined;
}

const clip = (line: string) =>
  line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;

const distinct = (text: string, scratch: string): string[] => [
  ...new Set(
    text
      .split("\n")
      .map((line) => clip(line.trim().replaceAll(scratch, "<scratch>")))
      .filter((line) => line.length > 0),
  ),
];

/** The member inspector reads only the path and digest of its target. */
const targetOf = (
  artifact: ManagedDecompilation["artifact"],
  layout: ManagedPeLayout,
): BinaryTarget => ({
  path: artifact.path,
  sha256: artifact.sha256,
  kind: "executable",
  format: "pe",
  architecture: layout.architecture,
  availableArchitectures: [layout.architecture],
  executableRole: "application",
  managed: true,
});

/** Resolve `Outer+Inner` through the NestedClass table; nested TypeDefs keep bare names. */
const findType = (types: readonly Type[], wanted: string): Type[] | null => {
  const [top, ...nested] = wanted.split("+");
  let current = types.find(
    (type) => type.enclosing_type_token === null && type.full_name === top,
  );
  if (current === undefined) return null;
  const chain = [current];
  for (const name of nested) {
    const parent: Type = current;
    current = types.find(
      (type) =>
        type.enclosing_type_token === parent.token && type.name === name,
    );
    if (current === undefined) return null;
    chain.push(current);
  }
  return chain;
};

/** The type and every type nested in it, transitively. */
const subtree = (types: readonly Type[], root: Type): Type[] => {
  const out = [root];
  for (let index = 0; index < out.length; index += 1) {
    const parent = out[index];
    for (const type of types)
      if (parent !== undefined && type.enclosing_type_token === parent.token)
        out.push(type);
  }
  return out;
};

/** Members the C# compiler writes for a record and ILSpy folds back into `record`. */
const RECORD_MEMBERS = new Set([
  "EqualityContract",
  "get_EqualityContract",
  "PrintMembers",
  "Deconstruct",
  "op_Equality",
  "op_Inequality",
  "Equals",
  "GetHashCode",
  "ToString",
]);

/** Names a C# reader would write for a metadata member, or null when C# hides it. */
const spelledAs = (
  name: string,
  owner: Type,
  kind: "method" | "field",
  record: boolean,
): string | null => {
  if (name.includes("<") || owner.name.includes("<")) return null;
  if (record && RECORD_MEMBERS.has(name)) return null;
  const simple = owner.name.replace(/`\d+$/u, "");
  if (kind === "field") return name === "value__" ? null : name;
  if (name === ".ctor" || name === ".cctor") return simple;
  if (name === "Finalize") return simple;
  if (name.startsWith("op_")) return "operator";
  // An explicit interface implementation is named Interface.get_Member.
  const last = name.split(".").at(-1) ?? name;
  const accessor = /^(?:get_|set_|add_|remove_|init_)(.+)$/u.exec(last);
  const member = accessor?.[1] ?? last;
  return member === "Item" && accessor !== null ? "this" : member;
};

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** Metadata members the text never names, by this reader's own decoder. */
const missingMembers = (
  members: ManagedMemberInspection,
  tokens: ReadonlySet<string>,
  types: ReadonlyMap<string, Type>,
  text: string,
): { checked: number; missing: ManagedDecompilation["missing_members"] } => {
  const missing: ManagedDecompilation["missing_members"] = [];
  let checked = 0;
  const rows = [
    ...members.methods.map((row) => ({ ...row, kind: "method" as const })),
    ...members.fields.map((row) => ({ ...row, kind: "field" as const })),
  ];
  const records = new Set(
    members.methods
      .filter((row) => row.name === "<Clone>$")
      .flatMap((row) =>
        row.declaring_type_token === null ? [] : [row.declaring_type_token],
      ),
  );
  for (const row of rows) {
    if (
      row.declaring_type_token === null ||
      !tokens.has(row.declaring_type_token)
    )
      continue;
    const owner = types.get(row.declaring_type_token);
    if (owner === undefined) continue;
    // Delegate Invoke/BeginInvoke/EndInvoke are supplied by the runtime (CodeTypeRuntime), never written in C#.
    if ("impl_flags" in row && (row.impl_flags & 0x3) === 0x3) continue;
    const spelled = spelledAs(
      row.name,
      owner,
      row.kind,
      records.has(row.declaring_type_token),
    );
    if (spelled === null) continue;
    checked += 1;
    if (
      !new RegExp(
        `(?<![A-Za-z0-9_])${escapeRegExp(spelled)}(?![A-Za-z0-9_])`,
        "u",
      ).test(text)
    )
      missing.push({ type: owner.full_name, member: row.name, kind: row.kind });
  }
  return { checked, missing };
};

const scratchName = (path: string) => {
  const name = basename(path).replace(/[^A-Za-z0-9._-]/gu, "_");
  return /\.(?:dll|exe)$/iu.test(name) && name.length <= 128
    ? name
    : "assembly.dll";
};

/**
 * Run the admitted ilspycmd on a scratch copy of one assembly with a near-empty
 * environment (only HOME in the scratch and PATH naming the .NET host, which
 * ILSpy needs to find framework references), then check the text against the
 * members this reader decodes from metadata. The scratch is removed afterwards.
 */
export const decompileManagedType = async (
  request: ManagedDecompileRequest,
): Promise<ManagedDecompilation> => {
  const { artifact, bytes, layout, input, tool, signal } = request;
  const target = targetOf(artifact, layout);

  // Types first, without method bodies, to resolve the selection.
  let types: Type[] | null = null;
  let typeProblem: string | null = null;
  try {
    const listed = inspectManagedMembersBytes(bytes, target, {
      methodLimit: 0,
      userStrings: false,
    });
    // An unreadable or partial table returns no types rather than throwing.
    if (listed.metadata.status === "complete") types = listed.types;
    else typeProblem = `its metadata is ${listed.metadata.status}`;
  } catch (cause) {
    typeProblem = cause instanceof Error ? cause.message : String(cause);
  }
  let chosen: Type[] | null = null;
  if (input.type !== undefined) {
    if (types === null)
      throw new ManagedDecompileFailure(
        "type-not-found",
        `The assembly's type table could not be read to find ${input.type}: ${typeProblem ?? "unknown problem"}`,
      );
    const chain = findType(types, input.type);
    if (chain === null)
      throw new ManagedDecompileFailure(
        "type-not-found",
        `${input.type} is not a type of this assembly. Name a nested type as Outer+Inner; inspect_managed_members lists the types.`,
      );
    chosen = chain;
  }
  const top = chosen?.[0] ?? null;
  const tree =
    top === null || types === null ? (types ?? []) : subtree(types, top);

  const scratch = await mkdtemp(join(tmpdir(), "oopsware-ilspy-"));
  try {
    const home = join(scratch, "home");
    const output = join(scratch, "out");
    await mkdir(join(scratch, "in"));
    await mkdir(home);
    await mkdir(output);
    const assembly = join(scratch, "in", scratchName(artifact.path));
    await writeFile(assembly, bytes, { flag: "wx" });
    const args = [
      ...FIXED_OPTIONS,
      // One argument, so a type named like an option stays a value.
      ...(top === null ? [] : [`--type=${top.full_name}`]),
      ...input.reference_paths.flatMap((path) => ["-r", path]),
      "-o",
      output,
      assembly,
    ];
    let snapshot: Awaited<ReturnType<typeof runOwnedCommand>>;
    try {
      snapshot = await runOwnedCommand(
        {
          command: tool.dotnet,
          arguments: [tool.dll, ...args],
          runId: randomUUID(),
          cwd: scratch,
          hostEnvironment: {
            HOME: home,
            PATH: dotnetDirectory(tool),
            // The tool asks for server GC; one heap per core is not needed here.
            DOTNET_gcServer: "0",
            DOTNET_CLI_TELEMETRY_OPTOUT: "1",
          },
          ...(signal === undefined ? {} : { signal }),
        },
        { timeoutMs: input.timeout_ms, diagnosticBytes: DIAGNOSTIC_BYTES },
        signal === undefined ? {} : { signal },
      );
    } catch (cause) {
      if (!(cause instanceof OwnedCommandFailure) || cause.reason !== "process")
        throw cause;
      const last = distinct(
        `${cause.snapshot?.stderr.text ?? ""}\n${cause.snapshot?.stdout.text ?? ""}`,
        scratch,
      ).slice(0, 3);
      const stop = cause.snapshot?.signal ?? null;
      throw new ManagedDecompileFailure(
        "crashed",
        `${stop === null ? `ilspycmd exited with code ${String(cause.snapshot?.exitCode ?? "unknown")}` : `ilspycmd crashed (${stop})`}, so there is no text${last.length === 0 ? "." : `: ${last.join(" ")}`}`,
      );
    }
    const allMessages = distinct(
      `${snapshot.stderr.text}\n${snapshot.stdout.text}`,
      scratch,
    );
    const written = (await readdir(output)).filter((name) =>
      name.endsWith(".cs"),
    );
    const file = written[0];
    if (file === undefined || written.length > 1)
      throw new ManagedDecompileFailure(
        "no-output",
        `ilspycmd wrote ${written.length === 0 ? "no C# file" : `${String(written.length)} C# files`}.${allMessages.length > 0 ? ` ${allMessages.slice(0, 3).join(" ")}` : ""}`,
      );
    const size = (await stat(join(output, file))).size;
    if (size > input.max_source_bytes)
      throw new ManagedDecompileFailure(
        "too-large",
        `The reconstructed source is ${String(size)} bytes, over max_source_bytes (${String(input.max_source_bytes)}).`,
      );
    const raw = await readFile(join(output, file));
    const text = raw.toString("utf8");
    const lines = text.split("\n");
    const lineCount =
      text.length === 0 ? 0 : lines.length - (text.endsWith("\n") ? 1 : 0);
    const allNotes = lines.flatMap((line, index) =>
      NOTE_PATTERN.test(line)
        ? [{ line: index + 1, text: clip(line.trim()) }]
        : [],
    );

    const checks: ManagedDecompilation["checks"] = [
      allNotes.length === 0 && allMessages.length === 0
        ? {
            id: "decompiler_clean",
            state: "passed",
            detail:
              "ILSpy printed no messages and marked no instruction as untyped or failed.",
          }
        : {
            id: "decompiler_clean",
            state: "failed",
            detail: `ILSpy printed ${String(allMessages.length)} distinct messages and marked ${String(allNotes.length)} lines as untyped or failed${input.reference_paths.length === 0 ? "; missing references are a common cause (pass reference_paths)" : ""}.`,
          },
    ];
    let missing: ManagedDecompilation["missing_members"] = [];
    if (types === null)
      checks.push({
        id: "members_present",
        state: "not_checked",
        detail: `This reader could not read the type table: ${typeProblem ?? "unknown problem"}`,
      });
    else {
      try {
        const members = inspectManagedMembersBytes(bytes, target, {
          ...(top === null
            ? {}
            : {
                typeNames: [...new Set(tree.map((type) => type.full_name))],
              }),
          userStrings: false,
        });
        const tokens = new Set(tree.map((type) => type.token));
        const result = missingMembers(
          members,
          tokens,
          new Map(tree.map((type) => [type.token, type])),
          text,
        );
        missing = result.missing.slice(0, MAX_MISSING_LISTED);
        const unmatched = members.selection?.unmatched_type_names ?? [];
        // A comparison of nothing is not a pass.
        const incomplete =
          members.metadata.status !== "complete"
            ? `this reader's member decode is ${members.metadata.status}`
            : unmatched.length > 0
              ? `this reader could not select ${unmatched.slice(0, 5).join(", ")}`
              : result.checked === 0 &&
                  members.methods.some(
                    (row) =>
                      row.declaring_type_token !== null &&
                      tokens.has(row.declaring_type_token),
                  ) === false &&
                  tree.some((type) => type.method_list.count > 0)
                ? "this reader decoded no members for types that have some"
                : null;
        checks.push(
          incomplete !== null
            ? {
                id: "members_present",
                state: "not_checked",
                detail: `The members were not compared: ${incomplete}.`,
              }
            : result.missing.length === 0
              ? {
                  id: "members_present",
                  state: "passed",
                  detail: `The text names all ${String(result.checked)} methods and fields this reader decodes for ${top === null ? "the assembly" : top.full_name}. Constructors and operators are checked only by kind, and compiler-generated members are not counted.`,
                }
              : {
                  id: "members_present",
                  state: "failed",
                  detail: `${String(result.missing.length)} of ${String(result.checked)} methods and fields this reader decodes are not named in the text.`,
                },
        );
      } catch (cause) {
        checks.push({
          id: "members_present",
          state: "not_checked",
          detail: `This reader could not decode the members to compare: ${cause instanceof Error ? cause.message : String(cause)}`,
        });
      }
    }

    const unpassed = checks.filter((check) => check.state !== "passed");
    const examined = `${top === null ? "the whole assembly" : `${top.full_name} and ${String(tree.length - 1)} nested types`} decompiled into ${String(lineCount)} lines`;
    const reconstruct: FacetCoverage =
      unpassed.length === 0
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
            omitted: unpassed
              .map((check) => `${check.id} ${check.state.replace("_", " ")}`)
              .join("; "),
            reason:
              "The decompiled text is incomplete, uncertain or unchecked in the ways the checks list.",
            continuation:
              "inspect_managed_members gives the metadata, signatures and IL hashes of every member.",
          };
    return {
      artifact,
      selection: {
        type: input.type ?? null,
        decompiled: top?.full_name ?? null,
        nested: top === null ? [] : tree.slice(1).map((type) => type.name),
      },
      references: [...input.reference_paths],
      decompiler: {
        id: "ilspycmd",
        version: tool.version,
        build: tool.build,
        tool: {
          directory: tool.directory,
          files: tool.files,
          sha256: tool.sha256,
        },
        runtime: { host: tool.dotnet, version: tool.runtimeVersion },
        arguments: [
          ...FIXED_OPTIONS,
          ...(top === null ? [] : [`--type=${top.full_name}`]),
          ...input.reference_paths.flatMap(() => ["-r", "<reference>"]),
          "-o",
          "<output>",
          "<assembly>",
        ],
      },
      source: {
        text,
        bytes: raw.length,
        sha256: createHash("sha256").update(raw).digest("hex"),
        lines: lineCount,
        media_type: "text/x-csharp; charset=utf-8",
        confidence: "inferred",
        derived_from: [artifact.sha256],
      },
      decompiler_notes: allNotes.slice(0, MAX_NOTES),
      messages: allMessages.slice(0, MAX_MESSAGES),
      checks,
      missing_members: missing,
      coverage: [reconstruct],
      limitations: [
        "This C# is reconstructed by ILSpy from IL and metadata. It is inferred, not the original source: local names come only from debug data, comments and formatting are lost, and it may not compile.",
        "ILSpy read a copy of the assembly as data in its own .NET process; no target code was loaded for execution. Framework types are resolved from the installed .NET runtime, other references only from reference_paths.",
        "A members check that passed means every decoded method and field is named in the text; it does not prove the bodies match the IL.",
        ...(allNotes.length > MAX_NOTES
          ? [
              `ILSpy marked ${String(allNotes.length)} lines; the first ${String(MAX_NOTES)} are listed.`,
            ]
          : []),
        ...(allMessages.length > MAX_MESSAGES
          ? [
              `ILSpy printed ${String(allMessages.length)} distinct messages; the first ${String(MAX_MESSAGES)} are listed.`,
            ]
          : []),
      ],
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
};
