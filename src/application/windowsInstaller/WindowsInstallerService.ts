import { isAbsolute } from "node:path";
import type { z } from "zod";

import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { WindowsInstallerPort } from "./WindowsInstallerPort.js";
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
  inspectMsixPackageInputSchema,
  msixPackageReportSchema,
} from "../../domain/windowsInstaller/msixPackage.js";
import {
  inspectWindowsInstallerInputSchema,
  windowsInstallerReportSchema,
} from "../../domain/windowsInstaller/windowsInstaller.js";

/** Omitted optional choices stay absent rather than null. */
const parameters = (input: object) =>
  Object.fromEntries(
    Object.entries(input).filter((entry) => entry[1] !== undefined),
  ) as Record<string, JsonValue>;

const absolute = (operation: string, field: string, path: string) =>
  isAbsolute(path)
    ? null
    : new AnalysisInputError(operation, undefined, [
        {
          path: [field],
          reason: "invalid_format",
          message: `Expected an absolute filesystem path on this host: ${path}`,
        },
      ]);

/** Shared caller validation, output checks and Evidence provenance for CLI/MCP. */
export class WindowsInstallerService {
  constructor(readonly provider: WindowsInstallerPort) {}

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
    const data = input.data as { path: string; cabinets?: readonly string[] };
    const relative =
      absolute(operation, "path", data.path) ??
      (data.cabinets ?? [])
        .map((path) => absolute(operation, "cabinets", path))
        .find((issue) => issue !== null) ??
      null;
    return relative === null ? ok(input.data) : err(relative);
  }

  #evidence(
    operation: string,
    artifact: { path: string; sha256: string },
    input: object,
    result: JsonValue,
    limitations: readonly string[],
  ): Evidence {
    return createEvidence(
      { path: artifact.path, format: "file", sha256: artifact.sha256 },
      this.provider.identity,
      {
        operation,
        parameters: parameters(input),
        result,
        confidence: "observed",
        limitations: [...limitations],
        locations: [{ kind: "artifact-path", path: artifact.path }],
      },
    );
  }

  async inspectInstaller(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const operation = "inspect_windows_installer";
    const input = this.#parse(
      operation,
      inspectWindowsInstallerInputSchema,
      rawInput,
      options,
    );
    if (!input.ok) return input;
    const read = await this.provider.inspectInstaller(input.value, options);
    if (!read.ok) return read;
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(operation));
    const report = windowsInstallerReportSchema.safeParse(read.value);
    const page = report.success ? report.data.page : null;
    if (
      !report.success ||
      report.data.artifact.path !== input.value.path ||
      page === null ||
      page.start !== input.value.start ||
      page.limit !== input.value.limit ||
      report.data.files.length !== page.returned ||
      (page.next === null
        ? input.value.start + page.returned < report.data.file_count
        : page.next !== input.value.start + page.returned)
    )
      return err(
        new AnalysisOutputError(
          operation,
          "Windows Installer reader returned malformed output or changed the file identity or page.",
        ),
      );
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

  async inspectMsix(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const operation = "inspect_msix_package";
    const input = this.#parse(
      operation,
      inspectMsixPackageInputSchema,
      rawInput,
      options,
    );
    if (!input.ok) return input;
    const read = await this.provider.inspectMsix(input.value, options);
    if (!read.ok) return read;
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(operation));
    const report = msixPackageReportSchema.safeParse(read.value);
    if (
      !report.success ||
      report.data.artifact.path !== input.value.path ||
      (input.value.container !== undefined &&
        report.data.parts?.container !== input.value.container)
    )
      return err(
        new AnalysisOutputError(
          operation,
          "MSIX reader returned malformed output or changed the file identity or selected package.",
        ),
      );
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
}
