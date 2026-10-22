import { isAbsolute } from "node:path";
import type { z } from "zod";

import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { JvmPort } from "./JvmPort.js";
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
  decompileJvmClassInputSchema,
  inspectJvmArtifactInputSchema,
  inspectJvmClassInputSchema,
  inspectJvmMethodInputSchema,
  jvmArtifactReportSchema,
  jvmClassReportSchema,
  jvmDecompilationSchema,
  jvmMethodReportSchema,
  type JvmArtifactReport,
  type JvmClassReport,
  type JvmMethodReport,
} from "../../domain/jvm/jvm.js";

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

/** The provider must answer for the selected file and honour the requested page. */
const artifactConsistent = (
  report: JvmArtifactReport,
  input: { path: string; start: number; limit: number },
) =>
  report.artifact.path === input.path &&
  report.classes.length === report.page.returned &&
  pageConsistent(report.page, report.class_count, input.start, input.limit);

/** A named entry or container must be the one that was read. */
const selectionConsistent = (
  selection: JvmClassReport["selection"],
  input: { entry?: string | undefined; container?: string | undefined },
) =>
  (input.entry === undefined || selection.entry === input.entry) &&
  (input.container === undefined || selection.container === input.container);

const methodConsistent = (
  report: JvmMethodReport,
  input: {
    path: string;
    method: string;
    descriptor?: string | undefined;
    start: number;
    limit: number;
  },
) =>
  report.artifact.path === input.path &&
  report.method.name === input.method &&
  (input.descriptor === undefined ||
    report.method.descriptor === input.descriptor) &&
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
export class JvmService {
  constructor(readonly provider: JvmPort) {}

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
        // Members carry their own entry path and in-class byte offsets.
        locations: [{ kind: "artifact-path", path: artifact.path }],
      },
    );
  }

  #malformed(operation: string, what: string) {
    return err(
      new AnalysisOutputError(
        operation,
        `JVM reader returned malformed output or changed the selected ${what}.`,
      ),
    );
  }

  async inspectArtifact(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const operation = "inspect_jvm_artifact";
    const input = this.#parse(
      operation,
      inspectJvmArtifactInputSchema,
      rawInput,
      options,
    );
    if (!input.ok) return input;
    const read = await this.provider.inspectArtifact(input.value, options);
    if (!read.ok) return read;
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(operation));
    const report = jvmArtifactReportSchema.safeParse(read.value);
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

  async inspectClass(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const operation = "inspect_jvm_class";
    const input = this.#parse(
      operation,
      inspectJvmClassInputSchema,
      rawInput,
      options,
    );
    if (!input.ok) return input;
    const read = await this.provider.inspectClass(input.value, options);
    if (!read.ok) return read;
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(operation));
    const report = jvmClassReportSchema.safeParse(read.value);
    if (
      !report.success ||
      report.data.artifact.path !== input.value.path ||
      !selectionConsistent(report.data.selection, input.value)
    )
      return this.#malformed(operation, "class");
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

  async inspectMethod(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const operation = "inspect_jvm_method";
    const input = this.#parse(
      operation,
      inspectJvmMethodInputSchema,
      rawInput,
      options,
    );
    if (!input.ok) return input;
    const read = await this.provider.inspectMethod(input.value, options);
    if (!read.ok) return read;
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(operation));
    const report = jvmMethodReportSchema.safeParse(read.value);
    if (
      !report.success ||
      !methodConsistent(report.data, input.value) ||
      !selectionConsistent(report.data.selection, input.value)
    )
      return this.#malformed(operation, "method");
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

  async decompileClass(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const operation = "decompile_jvm_class";
    const input = this.#parse(
      operation,
      decompileJvmClassInputSchema,
      rawInput,
      options,
    );
    if (!input.ok) return input;
    const read = await this.provider.decompileClass(input.value, options);
    if (!read.ok) return read;
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(operation));
    const report = jvmDecompilationSchema.safeParse(read.value);
    if (
      !report.success ||
      report.data.artifact.path !== input.value.path ||
      !selectionConsistent(report.data.selection, input.value) ||
      !report.data.source.derived_from.includes(
        report.data.inputs.find((entry) => entry.role === "selected")?.sha256 ??
          "",
      )
    )
      return this.#malformed(operation, "class");
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
