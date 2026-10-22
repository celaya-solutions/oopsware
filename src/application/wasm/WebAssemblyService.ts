import { isAbsolute } from "node:path";
import type { z } from "zod";

import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { WebAssemblyPort } from "./WebAssemblyPort.js";
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
  convertWasmToCInputSchema,
  convertWasmToTextInputSchema,
  inspectWasmFunctionInputSchema,
  inspectWasmModuleInputSchema,
  wasmFunctionReportSchema,
  wasmModuleReportSchema,
  wasmCConversionSchema,
  wasmTextConversionSchema,
  type WasmCConversion,
  type WasmFunctionReport,
  type WasmModuleReport,
  type WasmTextConversion,
} from "../../domain/wasm/webAssembly.js";

const notAbsolute = (operation: string, field: string) =>
  new AnalysisInputError(operation, undefined, [
    {
      path: [field],
      reason: "invalid_format",
      message: "Expected an absolute filesystem path on this host.",
    },
  ]);

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

const moduleConsistent = (
  report: WasmModuleReport,
  path: string,
  start: number,
  limit: number,
) =>
  report.artifact.path === path &&
  report.functions.length === report.page.returned &&
  report.functions.every((entry, index) => entry.index === start + index) &&
  pageConsistent(report.page, report.function_count, start, limit);

const functionConsistent = (
  report: WasmFunctionReport,
  path: string,
  index: number,
  start: number,
  limit: number,
) =>
  report.artifact.path === path &&
  report.function.index === index &&
  report.instructions.length === report.page.returned &&
  report.instructions.every(
    (entry, offset) => entry.index === start + offset,
  ) &&
  pageConsistent(report.page, report.instruction_count, start, limit);

/** Shared caller validation, output checks and Evidence provenance for CLI/MCP. */
export class WebAssemblyService {
  constructor(readonly provider: WebAssemblyPort) {}

  #parse<T extends z.ZodType>(
    operation: string,
    schema: T,
    rawInput: unknown,
    paths: readonly string[],
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
    const data = input.data as Record<string, unknown>;
    for (const field of paths)
      if (!isAbsolute(String(data[field])))
        return err(notAbsolute(operation, field));
    return ok(input.data);
  }

  #evidence(
    operation: string,
    artifact: { path: string; sha256: string },
    input: object,
    result: JsonValue,
    confidence: "observed" | "derived",
    limitations: readonly string[],
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
        // Every fact carries its own byte offset in the module.
        locations: [{ kind: "artifact-path", path: artifact.path }],
      },
    );
  }

  async inspectModule(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const operation = "inspect_wasm_module";
    const input = this.#parse(
      operation,
      inspectWasmModuleInputSchema,
      rawInput,
      ["path"],
      options,
    );
    if (!input.ok) return input;
    const read = await this.provider.inspectModule(input.value, options);
    if (!read.ok) return read;
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(operation));
    const report = wasmModuleReportSchema.safeParse(read.value);
    if (
      !report.success ||
      !moduleConsistent(
        report.data,
        input.value.path,
        input.value.start,
        input.value.limit,
      )
    )
      return err(
        new AnalysisOutputError(
          operation,
          "WebAssembly reader returned malformed output or changed the selected module identity.",
        ),
      );
    return ok(
      this.#evidence(
        operation,
        report.data.artifact,
        input.value,
        report.data,
        "observed",
        report.data.limitations,
      ),
    );
  }

  async inspectFunction(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const operation = "inspect_wasm_function";
    const input = this.#parse(
      operation,
      inspectWasmFunctionInputSchema,
      rawInput,
      ["path"],
      options,
    );
    if (!input.ok) return input;
    const read = await this.provider.inspectFunction(input.value, options);
    if (!read.ok) return read;
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(operation));
    const report = wasmFunctionReportSchema.safeParse(read.value);
    if (
      !report.success ||
      !functionConsistent(
        report.data,
        input.value.path,
        input.value.function_index,
        input.value.start,
        input.value.limit,
      )
    )
      return err(
        new AnalysisOutputError(
          operation,
          "WebAssembly reader returned malformed output or changed the selected function identity.",
        ),
      );
    return ok(
      this.#evidence(
        operation,
        report.data.artifact,
        input.value,
        report.data,
        "observed",
        report.data.limitations,
      ),
    );
  }

  async convertToText(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const operation = "convert_wasm_to_text";
    const input = this.#parse(
      operation,
      convertWasmToTextInputSchema,
      rawInput,
      ["path", "output_path"],
      options,
    );
    if (!input.ok) return input;
    const read = await this.provider.convertToText(input.value, options);
    if (!read.ok) return read;
    const conversion = wasmTextConversionSchema.safeParse(read.value);
    const consistent = (value: WasmTextConversion) =>
      value.artifact.path === input.value.path &&
      value.output.path === input.value.output_path &&
      value.output.derived_from === value.artifact.sha256;
    if (!conversion.success || !consistent(conversion.data))
      return err(
        new AnalysisOutputError(
          operation,
          "WebAssembly text conversion returned malformed output or changed the selected paths.",
        ),
      );
    return ok(
      this.#evidence(
        operation,
        conversion.data.artifact,
        input.value,
        conversion.data,
        "derived",
        conversion.data.limitations,
      ),
    );
  }

  async convertToC(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const operation = "convert_wasm_to_c";
    const input = this.#parse(
      operation,
      convertWasmToCInputSchema,
      rawInput,
      ["path"],
      options,
    );
    if (!input.ok) return input;
    const read = await this.provider.convertToC(input.value, options);
    if (!read.ok) return read;
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(operation));
    const conversion = wasmCConversionSchema.safeParse(read.value);
    const consistent = (value: WasmCConversion) => {
      const module =
        value.source.derived_binary?.sha256 ?? value.artifact.sha256;
      return (
        value.artifact.path === input.value.path &&
        (input.value.module_name === undefined ||
          value.module_name === input.value.module_name) &&
        [value.c, value.header].every(
          (file) =>
            file.derived_from.length === 1 && file.derived_from[0] === module,
        )
      );
    };
    if (!conversion.success || !consistent(conversion.data))
      return err(
        new AnalysisOutputError(
          operation,
          "WebAssembly C translation returned malformed output or changed the selected module identity.",
        ),
      );
    return ok(
      this.#evidence(
        operation,
        conversion.data.artifact,
        input.value,
        conversion.data,
        "derived",
        conversion.data.limitations,
      ),
    );
  }
}
