import { isAbsolute } from "node:path";
import type { z } from "zod";

import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { PythonPort } from "./PythonPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import { err, ok, type Result } from "../../domain/result.js";
import {
  decompilePythonCodeInputSchema,
  inspectPythonArtifactInputSchema,
  inspectPythonCodeInputSchema,
  inspectPythonModuleInputSchema,
  pythonArtifactReportSchema,
  pythonCodeReportSchema,
  pythonDecompilationSchema,
  pythonModuleReportSchema,
  type PythonArtifactReport,
  type PythonCodeReport,
} from "../../domain/python/python.js";

/** Omitted optional choices stay absent rather than null. */
const parameters = (input: object) =>
  Object.fromEntries(
    Object.entries(input).filter(
      (entry): entry is [string, string | number] => entry[1] !== undefined,
    ),
  );

const pageConsistent = (
  page: { start: number; limit: number; returned: number; next: number | null },
  total: number,
  start: number,
  limit: number,
): boolean =>
  page.start === start &&
  page.limit === limit &&
  page.returned <= limit &&
  (page.next === null
    ? start + page.returned >= total
    : page.next === start + page.returned && page.next < total);

const artifactConsistent = (
  report: PythonArtifactReport,
  input: { path: string; start: number; limit: number },
) =>
  report.artifact.path === input.path &&
  report.modules.length === report.page.returned &&
  pageConsistent(report.page, report.module_count, input.start, input.limit);

const codeConsistent = (
  report: PythonCodeReport,
  input: {
    path: string;
    entry?: string | undefined;
    code?: string | undefined;
    code_index?: number | undefined;
    start: number;
    limit: number;
  },
) =>
  report.artifact.path === input.path &&
  (input.entry === undefined || report.selection.entry === input.entry) &&
  (input.code === undefined || report.selection.qualname === input.code) &&
  (input.code_index === undefined ||
    report.selection.code_index === input.code_index) &&
  report.instructions.length === report.page.returned &&
  report.instructions.every(
    (entry, offset) => entry.index === input.start + offset,
  ) &&
  pageConsistent(
    report.page,
    report.instruction_count,
    input.start,
    input.limit,
  );

/** Shared caller validation, output checks and Evidence provenance for CLI/MCP. */
export class PythonService {
  constructor(readonly provider: PythonPort) {}

  #parse<T extends z.ZodType>(
    operation: string,
    schema: T,
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Result<z.infer<T>, AnalysisError> {
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(operation));
    const input = schema.safeParse(rawInput);
    if (!input.success)
      return err(
        analysisInputErrorFromIssues(operation, input.error.issues, rawInput, {
          cause: input.error,
        }),
      );
    const path = (input.data as { path: string }).path;
    if (!isAbsolute(path))
      return err(
        new AnalysisInputError(operation, undefined, [
          {
            path: ["path"],
            reason: "invalid_format",
            message: "Expected an absolute filesystem path on this host.",
          },
        ]),
      );
    return ok(input.data);
  }

  #evidence(
    operation: string,
    artifact: { path: string; sha256: string },
    input: object,
    result: JsonValue,
    limitations: readonly string[],
    confidence: "observed" | "inferred" = "observed",
  ): Evidence {
    return createEvidence(
      { path: artifact.path, format: "file", sha256: artifact.sha256 },
      this.provider.identity,
      {
        operation,
        parameters: parameters(input),
        result,
        confidence,
        limitations: [...limitations],
        // Members carry their own entry path and in-file offsets.
        locations: [{ kind: "artifact-path", path: artifact.path }],
      },
    );
  }

  #malformed(operation: string, what: string) {
    return err(
      new AnalysisOutputError(
        operation,
        `Python reader returned malformed output or changed the selected ${what}.`,
      ),
    );
  }

  async inspectArtifact(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const operation = "inspect_python_artifact";
    const input = this.#parse(
      operation,
      inspectPythonArtifactInputSchema,
      rawInput,
      options,
    );
    if (!input.ok) return input;
    const read = await this.provider.inspectArtifact(input.value, options);
    if (!read.ok) return read;
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(operation));
    const report = pythonArtifactReportSchema.safeParse(read.value);
    if (!report.success || !artifactConsistent(report.data, input.value))
      return this.#malformed(operation, "file identity or page");
    return ok(
      this.#evidence(
        operation,
        report.data.artifact,
        input.value,
        report.data,
        report.data.limitations,
      ),
    );
  }

  async inspectModule(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const operation = "inspect_python_module";
    const input = this.#parse(
      operation,
      inspectPythonModuleInputSchema,
      rawInput,
      options,
    );
    if (!input.ok) return input;
    const read = await this.provider.inspectModule(input.value, options);
    if (!read.ok) return read;
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(operation));
    const report = pythonModuleReportSchema.safeParse(read.value);
    if (
      !report.success ||
      report.data.artifact.path !== input.value.path ||
      (input.value.entry !== undefined &&
        report.data.selection.entry !== input.value.entry) ||
      (report.data.kind === "source") !== (report.data.source !== null) ||
      (report.data.kind === "bytecode") !== (report.data.bytecode !== null)
    )
      return this.#malformed(operation, "module");
    return ok(
      this.#evidence(
        operation,
        report.data.artifact,
        input.value,
        report.data,
        report.data.limitations,
      ),
    );
  }

  async inspectCode(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const operation = "inspect_python_code";
    const input = this.#parse(
      operation,
      inspectPythonCodeInputSchema,
      rawInput,
      options,
    );
    if (!input.ok) return input;
    const read = await this.provider.inspectCode(input.value, options);
    if (!read.ok) return read;
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(operation));
    const report = pythonCodeReportSchema.safeParse(read.value);
    if (!report.success || !codeConsistent(report.data, input.value))
      return this.#malformed(operation, "code object");
    return ok(
      this.#evidence(
        operation,
        report.data.artifact,
        input.value,
        report.data,
        report.data.limitations,
      ),
    );
  }

  async decompileCode(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const operation = "decompile_python_code";
    const input = this.#parse(
      operation,
      decompilePythonCodeInputSchema,
      rawInput,
      options,
    );
    if (!input.ok) return input;
    const read = await this.provider.decompileCode(input.value, options);
    if (!read.ok) return read;
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(operation));
    const report = pythonDecompilationSchema.safeParse(read.value);
    if (
      !report.success ||
      report.data.artifact.path !== input.value.path ||
      (input.value.entry !== undefined &&
        report.data.selection.entry !== input.value.entry) ||
      !report.data.source.derived_from.includes(report.data.selection.sha256)
    )
      return this.#malformed(operation, "module");
    return ok(
      this.#evidence(
        operation,
        report.data.artifact,
        input.value,
        report.data,
        report.data.limitations,
        "inferred",
      ),
    );
  }
}
