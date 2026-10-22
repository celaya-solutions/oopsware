import { isAbsolute } from "node:path";
import type { z } from "zod";
import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { SupplyChainPort } from "./SupplyChainPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import { jsonValueSchema } from "../../domain/jsonValue.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import { err, ok, type Result } from "../../domain/result.js";
import {
  generateSbomInputSchema,
  sbomReportSchema,
} from "../../domain/supplyChain/sbom.js";
import {
  checkVulnerabilitiesInputSchema,
  vulnerabilityReportSchema,
} from "../../domain/supplyChain/vulnerabilities.js";
import {
  verifyArtifactSignatureInputSchema,
  signatureReportSchema,
} from "../../domain/supplyChain/signatures.js";

type LocalInputs = {
  path: string;
  database?: string | undefined;
  trusted_certificate?: string | undefined;
  public_key?: string | undefined;
};

/** CLI and MCP share validation and the same source-bound Evidence. */
export class SupplyChainService {
  constructor(readonly provider: SupplyChainPort) {}

  #parse<T extends z.ZodType<LocalInputs>>(
    operation: string,
    schema: T,
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Result<z.infer<T>, AnalysisError> {
    if (options?.signal?.aborted)
      return err(
        new AnalysisCancelledError(operation, { cause: options.signal.reason }),
      );
    const parsed = schema.safeParse(rawInput);
    if (!parsed.success)
      return err(
        analysisInputErrorFromIssues(operation, parsed.error.issues, rawInput, {
          cause: parsed.error,
        }),
      );
    const paths = {
      path: parsed.data.path,
      database: parsed.data.database,
      trusted_certificate: parsed.data.trusted_certificate,
      public_key: parsed.data.public_key,
    };
    const relative = Object.entries(paths).filter(
      ([, path]) => path !== undefined && !isAbsolute(path),
    );
    if (relative.length > 0)
      return err(
        new AnalysisInputError(
          operation,
          undefined,
          relative.map(([name]) => ({
            path: [name],
            reason: "invalid_format" as const,
            message: "Expected an absolute filesystem path on this host.",
          })),
        ),
      );
    return ok(parsed.data);
  }

  #evidence(
    operation: string,
    input: object,
    report: {
      artifact: { path: string; sha256: string | null };
      limitations: string[];
    },
    result: unknown,
    options?: ExecutionOptions,
  ): Result<Evidence, AnalysisError> {
    const json = jsonValueSchema.safeParse(result);
    if (!json.success)
      return err(
        new AnalysisOutputError(
          operation,
          "Supply-chain provider returned a value that cannot be retained as JSON Evidence.",
        ),
      );
    const evidence = createEvidence(
      report.artifact.sha256 === null
        ? undefined
        : {
            path: report.artifact.path,
            format: "file",
            sha256: report.artifact.sha256,
          },
      this.provider.identity,
      {
        operation,
        parameters: Object.fromEntries(
          Object.entries(input).filter(([, value]) => value !== undefined),
        ),
        result: json.data,
        confidence: "derived",
        limitations: report.limitations,
        locations: [{ kind: "artifact-path", path: report.artifact.path }],
      },
    );
    if (options?.signal?.aborted)
      return err(
        new AnalysisCancelledError(operation, {
          cause: options.signal.reason,
          partialObservation: evidence,
        }),
      );
    return ok(evidence);
  }

  async generateSbom(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const operation = "generate_sbom";
    const input = this.#parse(
      operation,
      generateSbomInputSchema,
      rawInput,
      options,
    );
    if (!input.ok) return input;
    const read = await this.provider.generateSbom(input.value, options);
    if (!read.ok) return read;
    const report = sbomReportSchema.safeParse(read.value);
    if (!report.success || report.data.artifact.path !== input.value.path)
      return err(
        new AnalysisOutputError(
          operation,
          "SBOM provider returned malformed output or changed the selected artifact.",
        ),
      );
    return this.#evidence(
      operation,
      input.value,
      report.data,
      report.data,
      options,
    );
  }

  async checkVulnerabilities(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const operation = "check_vulnerabilities";
    const input = this.#parse(
      operation,
      checkVulnerabilitiesInputSchema,
      rawInput,
      options,
    );
    if (!input.ok) return input;
    const read = await this.provider.checkVulnerabilities(input.value, options);
    if (!read.ok) return read;
    const report = vulnerabilityReportSchema.safeParse(read.value);
    if (
      !report.success ||
      report.data.artifact.path !== input.value.path ||
      report.data.database.path !== input.value.database
    )
      return err(
        new AnalysisOutputError(
          operation,
          "Vulnerability provider returned malformed output or changed the selected SBOM or database.",
        ),
      );
    return this.#evidence(
      operation,
      input.value,
      report.data,
      report.data,
      options,
    );
  }

  async verifySignature(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const operation = "verify_artifact_signature";
    const input = this.#parse(
      operation,
      verifyArtifactSignatureInputSchema,
      rawInput,
      options,
    );
    if (!input.ok) return input;
    const read = await this.provider.verifySignature(input.value, options);
    if (!read.ok) return read;
    const report = signatureReportSchema.safeParse(read.value);
    const selectedTrust = [
      { kind: "certificate", path: input.value.trusted_certificate },
      { kind: "public_key", path: input.value.public_key },
    ].filter((material) => material.path !== undefined);
    if (
      !report.success ||
      report.data.artifact.path !== input.value.path ||
      report.data.kind !== input.value.kind ||
      report.data.trust_material.length !== selectedTrust.length ||
      selectedTrust.some(
        (selected) =>
          !report.data.trust_material.some(
            (actual) =>
              actual.kind === selected.kind && actual.path === selected.path,
          ),
      )
    )
      return err(
        new AnalysisOutputError(
          operation,
          "Signature provider returned malformed output or changed the selected artifact or signature kind.",
        ),
      );
    return this.#evidence(
      operation,
      input.value,
      report.data,
      report.data,
      options,
    );
  }
}
