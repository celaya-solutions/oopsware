import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";

import { sha256Hex } from "../artifacts/zipMemberView.js";
import type { FacetCoverage } from "../domain/formatRegistry.js";
import {
  MAX_PYTHON_MARSHAL_OBJECTS,
  MAX_PYTHON_CODE_OBJECTS,
  type DecompilePythonCodeInput,
  type PythonDecompilation,
} from "../domain/python/python.js";
import {
  OwnedCommandFailure,
  runOwnedCommand,
} from "../process/OwnedCommand.js";
import { codeEntries, loadPyc, type PycHeader } from "./bytecode/pyc.js";
import type { Interpreter } from "./interpreters.js";
import type { ResolvedPycdc } from "./pycdc.js";

/** Largest stderr kept from pycdc or the checker. */
const DIAGNOSTIC_BYTES = 4 * 1024 ** 2;
const MAX_MESSAGES = 200;
const MAX_NOTES = 1000;
/** Longest single message or note kept; pycdc can print whole expressions. */
const MAX_LINE_CHARS = 1000;
const MAX_NAMES_LISTED = 50;
const WARNING_MARKER = "# WARNING: Decompyle incomplete";

/** Why a reconstruction produced nothing usable. */
export class PythonDecompileFailure extends Error {
  readonly _tag = "PythonDecompileFailure";
  constructor(
    readonly reason: "no-output" | "too-large" | "crashed",
    message: string,
  ) {
    super(message);
  }
}

/**
 * Compiles the reconstructed text (never runs it) and prints the names of its
 * code objects. The target's own bytes never reach this interpreter.
 */
const CHECK_SCRIPT = `
import json, sys, types
try:
    code = compile(open(sys.argv[1], "rb").read(), sys.argv[2], "exec", dont_inherit=True)
except SyntaxError as error:
    print(json.dumps({"syntax_error": {"message": str(error.msg), "line": error.lineno, "offset": error.offset}}))
    sys.exit(0)
except (ValueError, RecursionError, MemoryError, OverflowError) as error:
    print(json.dumps({"syntax_error": {"message": type(error).__name__ + ": " + str(error), "line": None, "offset": None}}))
    sys.exit(0)
names = []
def nested(value, into):
    if isinstance(value, types.CodeType):
        into.append(value)
    elif isinstance(value, (tuple, list, set, frozenset)):
        for item in value:
            nested(item, into)
    elif isinstance(value, dict):
        for key, item in value.items():
            nested(key, into)
            nested(item, into)
stack = [code]
while stack:
    current = stack.pop()
    names.append(current.co_name)
    found = []
    nested(current.co_consts, found)
    stack.extend(found)
print(json.dumps({"names": names}))
`;

const checkOutputSchema = z.union([
  z.strictObject({
    syntax_error: z.strictObject({
      message: z.string(),
      line: z.number().int().nullable(),
      offset: z.number().int().nullable(),
    }),
  }),
  z.strictObject({ names: z.array(z.string()) }),
]);

type Check = PythonDecompilation["checks"][number];

export interface PythonDecompileRequest {
  readonly artifact: PythonDecompilation["artifact"];
  readonly selection: PythonDecompilation["selection"];
  readonly bytes: Uint8Array;
  readonly header: PycHeader & { readonly release: string };
  readonly input: DecompilePythonCodeInput;
  readonly tool: ResolvedPycdc;
  /** An installed interpreter of the same feature release, when there is one. */
  readonly checker: Interpreter | null;
  readonly signal?: AbortSignal | undefined;
}

/** A file name pycdc can print in its header line; never a path. */
const scratchName = (
  selection: PythonDecompileRequest["selection"],
  path: string,
) => {
  const name = basename(selection.entry ?? path).replace(
    /[^A-Za-z0-9._-]/gu,
    "_",
  );
  return name.length > 0 && name.length <= 128 ? name : "module.pyc";
};

const clip = (line: string) =>
  line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;

/** Distinct non-empty lines, with the private scratch path replaced. */
const distinct = (text: string, scratch: string): string[] => [
  ...new Set(
    text
      .split("\n")
      .map((line) => clip(line.trim().replaceAll(scratch, "<scratch>")))
      .filter((line) => line.length > 0),
  ),
];

/** Code object names of the original, from this reader's own decoder, or why there are none. */
const originalNames = (
  bytes: Uint8Array,
  header: PycHeader & { readonly release: string },
): { names: string[] } | { reason: string } => {
  const loaded = loadPyc(bytes, header, MAX_PYTHON_MARSHAL_OBJECTS);
  if (loaded.kind === "not-admitted")
    return {
      reason: `This reader does not decode Python ${header.release} code objects, so there is nothing to compare against.`,
    };
  if (loaded.kind === "failed")
    return {
      reason: `This reader could not decode the original's code objects (${loaded.problem}), so there is nothing to compare against.`,
    };
  const entries = codeEntries(loaded.module, MAX_PYTHON_CODE_OBJECTS + 1);
  return entries.length > MAX_PYTHON_CODE_OBJECTS
    ? {
        reason: `The original has more than ${String(MAX_PYTHON_CODE_OBJECTS)} code objects, over this reader's limit.`,
      }
    : { names: entries.map((entry) => entry.code.name) };
};

/** Names present more often on the left than on the right, each repeated by the difference. */
const surplus = (left: readonly string[], right: readonly string[]) => {
  const counts = new Map<string, number>();
  for (const name of right) counts.set(name, (counts.get(name) ?? 0) + 1);
  const out: string[] = [];
  for (const name of left) {
    const remaining = counts.get(name) ?? 0;
    if (remaining > 0) counts.set(name, remaining - 1);
    else out.push(name);
  }
  return out;
};

const runCheck = async (
  checker: Interpreter,
  file: string,
  name: string,
  scratch: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<z.infer<typeof checkOutputSchema> | { failed: string }> => {
  let snapshot: Awaited<ReturnType<typeof runOwnedCommand>>;
  try {
    snapshot = await runOwnedCommand(
      {
        command: checker.path,
        arguments: [
          "-I",
          "-S",
          "-B",
          "-X",
          "utf8",
          "-c",
          CHECK_SCRIPT,
          file,
          name,
        ],
        runId: randomUUID(),
        cwd: scratch,
        hostEnvironment: {},
        ...(signal === undefined ? {} : { signal }),
      },
      { timeoutMs, diagnosticBytes: DIAGNOSTIC_BYTES },
      signal === undefined ? {} : { signal },
    );
  } catch (cause) {
    // A checker that fails never hides pycdc's text; cancellation still ends the call.
    if (!(cause instanceof OwnedCommandFailure) || cause.reason === "cancelled")
      throw cause;
    return {
      failed:
        cause.reason === "timeout"
          ? `Python ${checker.release} did not finish compiling the text within ${String(timeoutMs)} ms.`
          : cause.reason === "output-limit"
            ? `Python ${checker.release} printed more than the check's output budget.`
            : `Python ${checker.release} stopped while compiling the text (${cause.snapshot?.signal ?? `exit code ${String(cause.snapshot?.exitCode ?? "unknown")}`}).`,
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(snapshot.stdout.text);
  } catch {
    return {
      failed: `Python ${checker.release} printed no readable check result.`,
    };
  }
  const parsed = checkOutputSchema.safeParse(raw);
  return parsed.success
    ? parsed.data
    : {
        failed: `Python ${checker.release} printed a check result in an unexpected shape.`,
      };
};

/**
 * Run the admitted pycdc on a scratch copy of one .pyc, with an empty
 * environment, then check its text with an installed interpreter of the same
 * release. The scratch tree is removed afterwards.
 */
export const decompilePyc = async (
  request: PythonDecompileRequest,
): Promise<PythonDecompilation> => {
  const { artifact, selection, bytes, header, input, tool, checker, signal } =
    request;
  const name = scratchName(selection, artifact.path);
  const scratch = await mkdtemp(join(tmpdir(), "oopsware-pycdc-"));
  try {
    await mkdir(join(scratch, "in"));
    await mkdir(join(scratch, "out"));
    const target = join(scratch, "in", name);
    const output = join(scratch, "out", "reconstructed.py");
    await writeFile(target, bytes, { flag: "wx" });
    let snapshot: Awaited<ReturnType<typeof runOwnedCommand>>;
    try {
      snapshot = await runOwnedCommand(
        {
          command: tool.path,
          arguments: ["-o", output, target],
          runId: randomUUID(),
          cwd: scratch,
          hostEnvironment: {},
          ...(signal === undefined ? {} : { signal }),
        },
        { timeoutMs: input.timeout_ms, diagnosticBytes: DIAGNOSTIC_BYTES },
        signal === undefined ? {} : { signal },
      );
    } catch (cause) {
      if (!(cause instanceof OwnedCommandFailure) || cause.reason !== "process")
        throw cause;
      const last = distinct(cause.snapshot?.stderr.text ?? "", scratch).slice(
        -3,
      );
      const stop = cause.snapshot?.signal ?? null;
      throw new PythonDecompileFailure(
        "crashed",
        `${stop === null ? `pycdc exited with code ${String(cause.snapshot?.exitCode ?? "unknown")}` : `pycdc crashed (${stop}) on this bytecode`}, so there is no text${last.length === 0 ? "." : `; its last distinct messages: ${last.join(" ")}`}`,
      );
    }
    const allMessages = distinct(
      `${snapshot.stderr.text}\n${snapshot.stdout.text}`,
      scratch,
    );
    let size: number;
    try {
      size = (await stat(output)).size;
    } catch {
      throw new PythonDecompileFailure(
        "no-output",
        `pycdc wrote no source.${allMessages.length > 0 ? ` ${allMessages.slice(0, 3).join(" ")}` : ""}`,
      );
    }
    if (size > input.max_source_bytes)
      throw new PythonDecompileFailure(
        "too-large",
        `The reconstructed source is ${String(size)} bytes, over max_source_bytes (${String(input.max_source_bytes)}).`,
      );
    const raw = await readFile(output);
    let text: string;
    let replaced = false;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    } catch {
      text = new TextDecoder("utf-8").decode(raw);
      replaced = true;
    }
    const lines = text.split("\n");
    const lineCount =
      text.length === 0 ? 0 : lines.length - (text.endsWith("\n") ? 1 : 0);
    const allNotes = lines.flatMap((line, index) =>
      line.includes(WARNING_MARKER)
        ? [{ line: index + 1, text: clip(line.trim()) }]
        : [],
    );
    const notes = allNotes.slice(0, MAX_NOTES);
    const messages = allMessages.slice(0, MAX_MESSAGES);

    const checks: Check[] = [
      allNotes.length === 0 && allMessages.length === 0
        ? {
            id: "decompiler_warnings",
            state: "passed",
            detail: "pycdc printed no warnings and left no incomplete markers.",
          }
        : {
            id: "decompiler_warnings",
            state: "failed",
            detail: `pycdc printed ${String(allMessages.length)} distinct warnings and left ${String(allNotes.length)} incomplete markers in the text.`,
          },
    ];
    let syntaxError: PythonDecompilation["syntax_error"] = null;
    let codeObjects: PythonDecompilation["code_objects"] = null;
    let checkerReport: PythonDecompilation["checker"] = null;
    const notChecked = (detail: string) => {
      checks.push(
        { id: "recompiles", state: "not_checked", detail },
        { id: "code_objects_match", state: "not_checked", detail },
      );
    };
    if (!input.check) notChecked("Checks were not requested (check: false).");
    else if (checker === null)
      notChecked(
        `No CPython ${header.release} is installed at the standard locations, so the text was not compiled.`,
      );
    else {
      checkerReport = { path: checker.path, release: checker.release };
      const result = await runCheck(
        checker,
        output,
        name.replace(/\.pyc$/u, ".py"),
        scratch,
        input.timeout_ms,
        signal,
      );
      if ("failed" in result) notChecked(result.failed);
      else if ("syntax_error" in result) {
        syntaxError = result.syntax_error;
        checks.push(
          {
            id: "recompiles",
            state: "failed",
            detail: `Python ${checker.release} rejects the text: ${result.syntax_error.message}${result.syntax_error.line === null ? "" : ` (line ${String(result.syntax_error.line)})`}.`,
          },
          {
            id: "code_objects_match",
            state: "not_checked",
            detail:
              "The text does not compile, so its code objects cannot be compared.",
          },
        );
      } else {
        checks.push({
          id: "recompiles",
          state: "passed",
          detail: `Python ${checker.release} compiles the text (it was not run).`,
        });
        const original = originalNames(bytes, header);
        if ("reason" in original)
          checks.push({
            id: "code_objects_match",
            state: "not_checked",
            detail: original.reason,
          });
        else {
          const missing = surplus(original.names, result.names);
          const extra = surplus(result.names, original.names);
          codeObjects = {
            original: original.names.length,
            reconstructed: result.names.length,
            missing: missing.slice(0, MAX_NAMES_LISTED),
            extra: extra.slice(0, MAX_NAMES_LISTED),
          };
          checks.push(
            missing.length === 0 && extra.length === 0
              ? {
                  id: "code_objects_match",
                  state: "passed",
                  detail: `The recompiled text has the same ${String(original.names.length)} code objects by name as the original.`,
                }
              : {
                  id: "code_objects_match",
                  state: "failed",
                  detail: `${String(missing.length)} code objects of the original are missing from the recompiled text and ${String(extra.length)} are extra.`,
                },
          );
        }
      }
    }

    const unpassed = checks.filter((check) => check.state !== "passed");
    const examined = `1 code module (Python ${header.release}) decompiled into ${String(lineCount)} lines`;
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
              "inspect_python_code gives the decoded bytecode of every code object.",
          };
    return {
      artifact,
      selection,
      bytecode: { magic: header.magic, release: header.release },
      decompiler: {
        id: "pycdc",
        version: tool.version,
        build: tool.build,
        executable: { path: tool.path, sha256: tool.sha256 },
        arguments: ["-o", "<output>", "<input>"],
      },
      source: {
        text,
        bytes: raw.length,
        sha256: sha256Hex(raw),
        lines: lineCount,
        media_type: "text/x-python; charset=utf-8",
        confidence: "inferred",
        replaced_invalid_utf8: replaced,
        derived_from: [selection.sha256],
      },
      decompiler_notes: notes,
      messages,
      checks,
      checker: checkerReport,
      syntax_error: syntaxError,
      code_objects: codeObjects,
      coverage: [reconstruct],
      limitations: [
        "This Python source is reconstructed by pycdc from bytecode. It is inferred, not the original: comments, formatting and some constructs are lost, and pycdc is weak on Python 3.9 and later.",
        "pycdc read a copy of the .pyc as data in its own process with an empty environment; nothing was imported, unmarshalled by an interpreter or run.",
        "A check that passed means the text compiles and has code objects of the same names; it does not prove the bodies behave like the original.",
        ...(allMessages.length > MAX_MESSAGES
          ? [
              `pycdc printed ${String(allMessages.length)} distinct warnings; the first ${String(MAX_MESSAGES)} are listed.`,
            ]
          : []),
        ...(allNotes.length > MAX_NOTES
          ? [
              `pycdc left ${String(allNotes.length)} incomplete markers; the first ${String(MAX_NOTES)} are listed.`,
            ]
          : []),
      ],
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
};
