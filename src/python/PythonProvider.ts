import type { ExecutionOptions } from "../application/AnalysisProvider.js";
import { PYTHON_PROVIDER } from "../application/InvestigationProviders.js";
import type { PythonPort } from "../application/python/PythonPort.js";
import {
  DecodeBudget,
  MemberReadFailure,
  sha256Hex,
} from "../artifacts/zipMemberView.js";
import { readStableArtifact } from "../artifacts/readStableArtifact.js";
import { stableReadFailure } from "../artifacts/stableReadFailure.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
  AnalysisUnsupportedTargetError,
} from "../domain/analysisErrorCore.js";
import { ArtifactOperationError } from "../domain/artifactOperationError.js";
import type { FacetCoverage } from "../domain/formatRegistry.js";
import {
  PYCDC_RELEASES,
  MAX_PYTHON_MEMBER_BYTES,
  type DecompilePythonCodeInput,
  type PythonDecompilation,
  MAX_PYTHON_SOURCE_BYTES,
  type InspectPythonArtifactInput,
  type InspectPythonCodeInput,
  type InspectPythonModuleInput,
  type PythonArtifactReport,
  type PythonCodeReport,
  type PythonModuleReport,
} from "../domain/python/python.js";
import { err, ok, type Result } from "../domain/result.js";
import { OwnedCommandFailure } from "../process/OwnedCommand.js";
import { artifactReport, NO_PYTHON_DECOMPILER } from "./artifactReport.js";
import {
  bytecodeFacts,
  codeReportBody,
  readBytecode,
  selectCode,
} from "./bytecodeReport.js";
import { readPycHeader } from "./bytecode/pyc.js";
import { decompilePyc, PythonDecompileFailure } from "./decompile.js";
import { discoverInterpreters, type Interpreter } from "./interpreters.js";
import { PycdcUnavailable, resolvePycdc } from "./pycdc.js";
import {
  closePythonSource,
  moduleKind,
  openPythonSource,
  type PythonSource,
} from "./source.js";
import { SourceParseFailure, sourceFacts } from "./sourceReport.js";

type Operation =
  | "inspect_python_artifact"
  | "inspect_python_module"
  | "inspect_python_code"
  | "decompile_python_code";

interface Opened {
  readonly artifact: PythonArtifactReport["artifact"];
  readonly source: PythonSource;
  readonly budget: DecodeBudget;
}

/** One module's bytes: the loose file or an archive member. */
interface Selected {
  readonly entry: string | null;
  readonly kind: "source" | "bytecode";
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

const aborted = (signal?: AbortSignal): boolean => signal?.aborted === true;

const inputError = (operation: Operation, field: string, message: string) =>
  new AnalysisInputError(operation, undefined, [
    { path: [field], reason: "invalid_value", message },
  ]);

const memberFailure = (
  operation: Operation,
  path: string,
  cause: MemberReadFailure,
  limit: number,
): AnalysisError => {
  switch (cause.reason) {
    case "cancelled":
      return new AnalysisCancelledError(operation, { cause });
    case "budget":
      return new AnalysisResourceConstraintError(
        operation,
        "memory",
        cause.message,
        { max_decoded_bytes: limit },
        { cause, remediationAction: "Raise max_decoded_bytes (up to 2 GiB)." },
      );
    case "encrypted":
    case "size":
      return new AnalysisUnsupportedTargetError(
        operation,
        path,
        cause.message,
        {
          cause,
        },
      );
    case "format":
      return new ArtifactOperationError(
        operation,
        "format",
        undefined,
        cause.message,
        { cause },
      );
  }
};

/** Read one file, open it, run `use`, and always release the archive reader. */
const withSource = async <T>(
  operation: Operation,
  input: { path: string; max_file_bytes: number; max_decoded_bytes: number },
  options: ExecutionOptions | undefined,
  use: (opened: Opened) => Promise<Result<T, AnalysisError>>,
): Promise<Result<T, AnalysisError>> => {
  const signal = options?.signal;
  let snapshot: Awaited<ReturnType<typeof readStableArtifact>>;
  try {
    snapshot = await readStableArtifact(
      input.path,
      input.max_file_bytes,
      signal,
    );
  } catch (cause) {
    return err(
      stableReadFailure(operation, input.path, cause, {
        cancelled: signal?.aborted === true,
        maxFileBytes: input.max_file_bytes,
        remediationAction:
          "Raise max_file_bytes (up to 512 MiB) or select a smaller file.",
      }),
    );
  }
  if (aborted(signal)) return err(new AnalysisCancelledError(operation));
  const artifact = {
    path: input.path,
    sha256: snapshot.sha256,
    bytes: snapshot.bytes.length,
  };
  const budget = new DecodeBudget(
    input.max_decoded_bytes,
    MAX_PYTHON_MEMBER_BYTES,
  );
  let source: PythonSource | null = null;
  try {
    source = await openPythonSource(snapshot.bytes, input.path);
    if (source === null)
      return err(
        new AnalysisUnsupportedTargetError(
          operation,
          input.path,
          "The file is neither a .pyc with a CPython header, a ZIP-based wheel or zip application, nor .py text.",
        ),
      );
    const result = await use({ artifact, source, budget });
    if (aborted(signal)) return err(new AnalysisCancelledError(operation));
    return result;
  } catch (cause) {
    if (cause instanceof MemberReadFailure)
      return err(
        memberFailure(operation, input.path, cause, input.max_decoded_bytes),
      );
    if (aborted(signal))
      return err(new AnalysisCancelledError(operation, { cause }));
    return err(
      new ArtifactOperationError(
        operation,
        "format",
        undefined,
        `The archive could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      ),
    );
  } finally {
    await closePythonSource(source);
  }
};

const selectModule = async (
  operation: Operation,
  opened: Opened,
  entry: string | undefined,
  signal?: AbortSignal,
): Promise<Result<Selected, AnalysisError>> => {
  const { source, artifact } = opened;
  if (!("zip" in source)) {
    if (entry !== undefined)
      return err(
        inputError(
          operation,
          "entry",
          "The file is not an archive; omit entry.",
        ),
      );
    return ok({
      entry: null,
      kind: source.kind,
      bytes: source.bytes,
      sha256: artifact.sha256,
    });
  }
  if (entry === undefined)
    return err(
      inputError(
        operation,
        "entry",
        "Choose a .py or .pyc member with entry; inspect_python_artifact lists them.",
      ),
    );
  const kind = moduleKind(entry);
  if (kind === null || !source.zip.has(entry))
    return err(
      inputError(
        operation,
        "entry",
        `${entry} is not a .py or .pyc member of the archive.`,
      ),
    );
  const bytes = await source.zip.read(entry, opened.budget, signal);
  return ok({ entry, kind, bytes, sha256: sha256Hex(bytes) });
};

const chooseInterpreter = async (
  wanted: string | undefined,
): Promise<Interpreter | string> => {
  const found = await discoverInterpreters();
  if (found.length === 0)
    return "No CPython interpreter was found at the standard install locations.";
  if (wanted === undefined) return found[0] ?? "";
  return (
    found.find((interpreter) => interpreter.version === wanted) ??
    `Python ${wanted} is not installed; found ${found.map((interpreter) => interpreter.version).join(", ")}.`
  );
};

const parseFailure = (
  path: string,
  timeoutMs: number,
  cause: unknown,
): AnalysisError | null => {
  const operation = "inspect_python_module";
  if (cause instanceof SourceParseFailure)
    return new AnalysisUnsupportedTargetError(operation, path, cause.message, {
      cause,
    });
  if (!(cause instanceof OwnedCommandFailure)) return null;
  switch (cause.reason) {
    case "cancelled":
      return new AnalysisCancelledError(operation, { cause });
    case "timeout":
      return new AnalysisTimeoutError(operation, timeoutMs, { cause });
    case "output-limit":
      return new AnalysisResourceConstraintError(
        operation,
        "memory",
        "The parser printed more than its output budget.",
        null,
        { cause, remediationAction: "Lower max_listed." },
      );
    case "process": {
      const stderr =
        cause.snapshot?.stderr.text.trim().split("\n").slice(-2).join(" ") ??
        "";
      return new AnalysisUnsupportedTargetError(
        operation,
        path,
        `The parser process exited with code ${String(cause.snapshot?.exitCode ?? "unknown")}${stderr === "" ? "" : `: ${stderr}`}`,
        { cause },
      );
    }
  }
};

const decompileFailure = (
  path: string,
  input: DecompilePythonCodeInput,
  cause: unknown,
): AnalysisError | null => {
  const operation = "decompile_python_code";
  if (cause instanceof PycdcUnavailable)
    return new AnalysisCapabilityUnavailableError(
      "pycdc",
      operation,
      cause.message,
      {
        cause,
      },
    );
  if (cause instanceof PythonDecompileFailure)
    return cause.reason === "too-large"
      ? new AnalysisResourceConstraintError(
          operation,
          "memory",
          cause.message,
          { max_source_bytes: input.max_source_bytes },
          {
            cause,
            remediationAction: "Raise max_source_bytes (up to 32 MiB).",
          },
        )
      : new AnalysisUnsupportedTargetError(operation, path, cause.message, {
          cause,
        });
  if (!(cause instanceof OwnedCommandFailure)) return null;
  switch (cause.reason) {
    case "cancelled":
      return new AnalysisCancelledError(operation, { cause });
    case "timeout":
      return new AnalysisTimeoutError(operation, input.timeout_ms, { cause });
    case "output-limit":
      return new AnalysisResourceConstraintError(
        operation,
        "memory",
        "The decompiler or checker printed more diagnostics than the capture budget.",
        null,
        { cause },
      );
    case "process":
      // pycdc's own exit is mapped in decompile.ts; this is any other child.
      return new AnalysisUnsupportedTargetError(
        operation,
        path,
        `A decompiler process exited with code ${String(cause.snapshot?.exitCode ?? "unknown")}.`,
        { cause },
      );
  }
};

const RECONSTRUCT: FacetCoverage = {
  facet: "reconstruct",
  state: "not_requested",
  examined: null,
  omitted: null,
  reason: NO_PYTHON_DECOMPILER,
  continuation: null,
};

const SOURCE_RECONSTRUCT: FacetCoverage = {
  facet: "reconstruct",
  state: "unsupported",
  examined: null,
  omitted: null,
  reason: "Source is already source; there is nothing to reconstruct.",
  continuation: null,
};

const sourceCoverage = (
  facts: NonNullable<PythonModuleReport["source"]>,
): FacetCoverage[] => {
  const truncated = [
    facts.imports,
    facts.definitions,
    facts.calls,
    facts.dynamic,
    facts.assignments,
    facts.scope_declarations,
  ].some((list) => list.items.length < list.total);
  const inspect: FacetCoverage =
    facts.status === "parsed" && facts.problem === null && !truncated
      ? {
          facet: "inspect",
          state: "complete",
          examined: `the syntax tree of the whole file as Python ${facts.parser.release} parses it`,
          omitted: null,
          reason: null,
          continuation: null,
        }
      : facts.status === "parsed"
        ? {
            facet: "inspect",
            state: "partial",
            examined: `the syntax tree as Python ${facts.parser.release} parses it`,
            omitted: truncated
              ? "facts past max_listed"
              : "the part of the tree past the walk limit",
            reason: truncated
              ? "Each list stops at max_listed; totals still count every fact."
              : (facts.problem ?? "The tree is too deep."),
            continuation: truncated ? "Raise max_listed." : null,
          }
        : {
            facet: "inspect",
            state: "unsupported",
            examined: null,
            omitted: null,
            reason:
              facts.status === "syntax-error"
                ? `Python ${facts.parser.release} cannot parse the file: ${facts.syntax_error?.message ?? "syntax error"}.`
                : (facts.problem ?? "The file could not be decoded."),
            continuation:
              facts.status === "syntax-error"
                ? "Another release's grammar may accept it; choose one with python."
                : null,
          };
  return [
    {
      facet: "identify",
      state: "complete",
      examined: "the name and text bytes",
      omitted: null,
      reason: null,
      continuation: null,
    },
    inspect,
    SOURCE_RECONSTRUCT,
  ];
};

const bytecodeCoverage = (
  facts: NonNullable<PythonModuleReport["bytecode"]>,
): FacetCoverage[] => [
  {
    facet: "identify",
    state: "complete",
    examined: "the .pyc magic number and header",
    omitted: null,
    reason: null,
    continuation: null,
  },
  facts.decode === "complete"
    ? {
        facet: "inspect",
        state: "complete",
        examined: `${String(facts.code_count)} code objects and every instruction`,
        omitted: null,
        reason: null,
        continuation: null,
      }
    : facts.decode === "partial"
      ? {
          facet: "inspect",
          state: "partial",
          examined: `${String(facts.code_count)} code objects`,
          omitted: "instructions or tables that did not decode",
          reason:
            facts.problem ?? "Some instructions or tables did not decode.",
          continuation: null,
        }
      : {
          facet: "inspect",
          state: "unsupported",
          examined: null,
          omitted: null,
          reason: facts.problem ?? "The code object did not decode.",
          continuation: null,
        },
  RECONSTRUCT,
];

/** In-process CPython bytecode, wheel and zip application reading; source is parsed by an installed interpreter's ast module. */
export class PythonProvider implements PythonPort {
  readonly identity = PYTHON_PROVIDER;

  inspectArtifact(
    input: InspectPythonArtifactInput,
    options?: ExecutionOptions,
  ) {
    return withSource(
      "inspect_python_artifact",
      input,
      options,
      async (opened) =>
        ok(
          await artifactReport(
            opened.artifact,
            opened.source,
            input,
            opened.budget,
            options?.signal,
          ),
        ),
    );
  }

  inspectModule(
    input: InspectPythonModuleInput,
    options?: ExecutionOptions,
  ): Promise<Result<PythonModuleReport, AnalysisError>> {
    const operation = "inspect_python_module";
    return withSource<PythonModuleReport>(
      operation,
      input,
      options,
      async (opened) => {
        const selected = await selectModule(
          operation,
          opened,
          input.entry,
          options?.signal,
        );
        if (!selected.ok) return selected;
        const module = selected.value;
        const selection = {
          entry: module.entry,
          sha256: module.sha256,
          bytes: module.bytes.length,
        };
        if (module.kind === "bytecode") {
          const read = readBytecode(module.bytes);
          if (read.kind === "not-pyc")
            return err(
              new AnalysisUnsupportedTargetError(
                operation,
                input.path,
                "The selected member has no CPython .pyc header.",
              ),
            );
          const facts = bytecodeFacts(read);
          return ok({
            artifact: opened.artifact,
            selection,
            kind: "bytecode",
            source: null,
            bytecode: facts,
            coverage: bytecodeCoverage(facts),
            limitations: [
              "Bytecode is decoded in process; nothing is unmarshalled by an interpreter, imported or run.",
              "Before Python 3.11 there is no co_qualname; qualified names are joined from code object names.",
            ],
          });
        }
        if (module.bytes.length > MAX_PYTHON_SOURCE_BYTES)
          return err(
            new AnalysisResourceConstraintError(
              operation,
              "memory",
              `The source is ${String(module.bytes.length)} bytes, over the ${String(MAX_PYTHON_SOURCE_BYTES)}-byte parser limit.`,
              { max_source_bytes: MAX_PYTHON_SOURCE_BYTES },
            ),
          );
        const interpreter = await chooseInterpreter(input.python);
        if (typeof interpreter === "string")
          return err(
            new AnalysisCapabilityUnavailableError(
              "python",
              operation,
              interpreter,
            ),
          );
        try {
          const facts = await sourceFacts(
            module.bytes,
            interpreter,
            { maxListed: input.max_listed, timeoutMs: input.timeout_ms },
            options?.signal,
          );
          return ok({
            artifact: opened.artifact,
            selection,
            kind: "source",
            source: facts,
            bytecode: null,
            coverage: sourceCoverage(facts),
            limitations: [
              "Source is parsed by the interpreter's ast module in a separate isolated process; it is never compiled, imported or run.",
              "Calls are listed by the dotted name written at the call site; what a name refers to at run time is not resolved.",
              "Dynamic imports, exec/eval/compile and reflection are listed as unknowns; their targets are not followed.",
            ],
          });
        } catch (cause) {
          const mapped = parseFailure(input.path, input.timeout_ms, cause);
          if (mapped === null) throw cause;
          return err(mapped);
        }
      },
    );
  }

  inspectCode(
    input: InspectPythonCodeInput,
    options?: ExecutionOptions,
  ): Promise<Result<PythonCodeReport, AnalysisError>> {
    const operation = "inspect_python_code";
    return withSource<PythonCodeReport>(
      operation,
      input,
      options,
      async (opened) => {
        const selected = await selectModule(
          operation,
          opened,
          input.entry,
          options?.signal,
        );
        if (!selected.ok) return selected;
        const module = selected.value;
        if (module.kind !== "bytecode")
          return err(
            inputError(
              operation,
              input.entry === undefined ? "path" : "entry",
              "inspect_python_code decodes .pyc bytecode; use inspect_python_module for source.",
            ),
          );
        const read = readBytecode(module.bytes);
        if (read.kind !== "decoded") {
          const facts = read.kind === "not-pyc" ? null : bytecodeFacts(read);
          return err(
            new AnalysisUnsupportedTargetError(
              operation,
              input.path,
              facts?.problem ?? "The selected file has no CPython .pyc header.",
            ),
          );
        }
        const found = selectCode(read.module, input);
        if (found.kind !== "found")
          return err(
            inputError(
              operation,
              input.code_index === undefined ? "code" : "code_index",
              found.message,
            ),
          );
        const body = codeReportBody(read.module, found.code, input);
        return ok({
          artifact: opened.artifact,
          selection: {
            entry: module.entry,
            sha256: module.sha256,
            code_index: found.code.entry.index,
            qualname: found.code.entry.qualname,
          },
          ...body,
          coverage: [
            {
              facet: "identify",
              state: "complete",
              examined: "the .pyc magic number and header",
              omitted: null,
              reason: null,
              continuation: null,
            },
            body.problems.length === 0
              ? {
                  facet: "inspect",
                  state: "complete",
                  examined: `all ${String(body.instruction_count)} instructions of ${body.code.qualname}`,
                  omitted: null,
                  reason: null,
                  continuation: null,
                }
              : {
                  facet: "inspect",
                  state: "partial",
                  examined: `${String(body.instruction_count)} instructions of ${body.code.qualname}`,
                  omitted: "arguments or tables that did not decode",
                  reason:
                    body.problems[0] ?? "Some instructions did not decode.",
                  continuation: null,
                },
            RECONSTRUCT,
          ],
          limitations: [
            `Instructions are rendered as Python ${read.module.profile.data.release}'s dis renders them; code object constants show no memory address and sets keep their stored order.`,
          ],
        });
      },
    );
  }

  decompileCode(
    input: DecompilePythonCodeInput,
    options?: ExecutionOptions,
  ): Promise<Result<PythonDecompilation, AnalysisError>> {
    const operation = "decompile_python_code";
    return withSource<PythonDecompilation>(
      operation,
      input,
      options,
      async (opened) => {
        const selected = await selectModule(
          operation,
          opened,
          input.entry,
          options?.signal,
        );
        if (!selected.ok) return selected;
        const module = selected.value;
        if (module.kind !== "bytecode")
          return err(
            new AnalysisUnsupportedTargetError(
              operation,
              input.path,
              "The selected module is source, not bytecode; inspect_python_module reads it.",
            ),
          );
        const header = readPycHeader(module.bytes);
        if (
          header === null ||
          (header.problem !== null && header.invalidation === null)
        )
          return err(
            new AnalysisUnsupportedTargetError(
              operation,
              input.path,
              header === null
                ? "The selected member has no CPython .pyc header."
                : `The .pyc header cannot be read: ${header.problem ?? "unknown problem"}`,
            ),
          );
        const release = header.release;
        if (
          release === null ||
          !(PYCDC_RELEASES as readonly string[]).includes(release)
        )
          return err(
            new AnalysisUnsupportedTargetError(
              operation,
              input.path,
              release === null
                ? `Magic number ${String(header.magic)} is not a final CPython release, so no decompiler is admitted for it.`
                : `The admitted pycdc does not read Python ${release} bytecode (it reads 2.7 and 3.5-3.13); inspect_python_code gives the decoded bytecode.`,
            ),
          );
        try {
          const tool = await resolvePycdc();
          const checker = input.check
            ? ((await discoverInterpreters()).find(
                (interpreter) => interpreter.version === release,
              ) ?? null)
            : null;
          return ok(
            await decompilePyc({
              artifact: opened.artifact,
              selection: {
                entry: module.entry,
                sha256: module.sha256,
                bytes: module.bytes.length,
              },
              bytes: module.bytes,
              header: { ...header, release },
              input,
              tool,
              checker,
              signal: options?.signal,
            }),
          );
        } catch (cause) {
          const mapped = decompileFailure(input.path, input, cause);
          if (mapped === null) throw cause;
          return err(mapped);
        }
      },
    );
  }
}
