import { z } from "incur";
import { resolve } from "node:path";
import type { Logger } from "pino";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { createSupplyChainService } from "../composition/supplyChain.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { generateSbomInputSchema } from "../domain/supplyChain/sbom.js";
import { verifyArtifactSignatureInputSchema } from "../domain/supplyChain/signatures.js";
import { withCommandCancellation } from "./commandCancellation.js";
import type { CliInstance } from "./types.js";

export const registerSupplyChainCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  const service = createSupplyChainService();
  const sbom = generateSbomInputSchema.shape;
  cli.command(CLI_COMMANDS.generateSbom, {
    description:
      "Build a CycloneDX SBOM with package and license evidence from local files",
    args: z.object({
      path: z.string().describe("Local file or application directory"),
    }),
    options: z.object({
      maxFiles: sbom.max_files,
      maxInputBytes: sbom.max_input_bytes,
      maxComponents: sbom.max_components,
      maxOutputBytes: sbom.max_output_bytes,
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.generateSbom, async () => {
          const result = await service.generateSbom(
            {
              path: resolve(args.path),
              max_files: options.maxFiles,
              max_input_bytes: options.maxInputBytes,
              max_components: options.maxComponents,
              max_output_bytes: options.maxOutputBytes,
            },
            { signal },
          );
          return result.ok ? result.value : projectAnalysisError(result.error);
        }),
      ),
  });
  cli.command(CLI_COMMANDS.checkVulnerabilities, {
    description:
      "Check a saved SBOM against an explicitly supplied offline OSV snapshot",
    args: z.object({
      path: z
        .string()
        .describe("CycloneDX JSON or saved generate-sbom Evidence"),
    }),
    options: z.object({
      database: z
        .string()
        .describe("Local OSV snapshot JSON file or directory"),
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.checkVulnerabilities, async () => {
          const result = await service.checkVulnerabilities(
            {
              path: resolve(args.path),
              database: resolve(options.database),
            },
            { signal },
          );
          return result.ok ? result.value : projectAnalysisError(result.error);
        }),
      ),
  });
  const signature = verifyArtifactSignatureInputSchema.shape;
  cli.command(CLI_COMMANDS.verifyArtifactSignature, {
    description:
      "Verify local artifact signatures offline, with integrity and trust reported separately",
    args: z.object({
      path: z
        .string()
        .describe("JAR, Authenticode file, Mach-O file, or wheel"),
    }),
    options: z.object({
      kind: signature.kind,
      trustedCertificate: signature.trusted_certificate,
      publicKey: signature.public_key,
      expectedSignerSha256: signature.expected_signer_sha256,
      maxArtifactBytes: signature.max_artifact_bytes,
      timeoutMs: signature.timeout_ms,
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(
          logger,
          CLI_COMMANDS.verifyArtifactSignature,
          async () => {
            const result = await service.verifySignature(
              {
                path: resolve(args.path),
                kind: options.kind,
                trusted_certificate:
                  options.trustedCertificate === undefined
                    ? undefined
                    : resolve(options.trustedCertificate),
                public_key:
                  options.publicKey === undefined
                    ? undefined
                    : resolve(options.publicKey),
                expected_signer_sha256: options.expectedSignerSha256,
                max_artifact_bytes: options.maxArtifactBytes,
                timeout_ms: options.timeoutMs,
              },
              { signal },
            );
            return result.ok
              ? result.value
              : projectAnalysisError(result.error);
          },
        ),
      ),
  });
};
