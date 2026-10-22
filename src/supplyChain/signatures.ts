import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExecutionOptions } from "../application/AnalysisProvider.js";
import { SUPPLY_CHAIN_PROVIDER } from "../application/InvestigationProviders.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { readStableArtifact } from "../artifacts/readStableArtifact.js";
import { MemberReadFailure } from "../artifacts/zipMemberView.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import { ArtifactOperationError } from "../domain/artifactOperationError.js";
import { createEvidence, type Evidence } from "../domain/evidence.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  verifyArtifactSignatureInputSchema,
  type SignatureReport,
  type VerifyArtifactSignatureInput,
} from "../domain/supplyChain/signatures.js";
import {
  decompilerCleanupFailure,
  withDecompilerScratch,
} from "../jvm/decompilerScratch.js";
import { OwnedCommandFailure } from "../process/OwnedCommand.js";
import {
  stageMaterial,
  verifyApple,
  type SignatureContext,
} from "./signaturesTools.js";
import { verifyJar } from "./signaturesJar.js";
import { verifyAuthenticode } from "./signaturesAuthenticode.js";
import { verifyWheel } from "./signaturesWheel.js";

const OPERATION = "verify_artifact_signature";

const failure = (
  cause: unknown,
  input: VerifyArtifactSignatureInput,
  signal?: AbortSignal,
): AnalysisError => {
  const cleanup = decompilerCleanupFailure(cause, OPERATION, (primary) =>
    failure(primary, input, signal),
  );
  if (cleanup !== null) return cleanup;
  if (cause instanceof AnalysisError) return cause;
  if (
    signal?.aborted ||
    (cause instanceof OwnedCommandFailure && cause.reason === "cancelled")
  )
    return new AnalysisCancelledError(OPERATION, {
      cause: signal?.aborted ? signal.reason : cause,
    });
  if (cause instanceof OwnedCommandFailure && cause.reason === "timeout")
    return new AnalysisTimeoutError(OPERATION, input.timeout_ms, { cause });
  if (cause instanceof OwnedCommandFailure && cause.reason === "output-limit")
    return new AnalysisResourceConstraintError(
      OPERATION,
      "transport",
      "Verifier output exceeds 1 MiB.",
      null,
      { cause },
    );
  if (cause instanceof ArtifactReaderFailure)
    return new ArtifactOperationError(
      OPERATION,
      cause.reason,
      undefined,
      cause.message,
      { cause },
    );
  if (cause instanceof MemberReadFailure)
    return new ArtifactOperationError(
      OPERATION,
      cause.reason === "budget" || cause.reason === "size"
        ? "limit"
        : cause.reason === "cancelled"
          ? "cancelled"
          : "format",
      undefined,
      cause.message,
      { cause },
    );
  return new ArtifactOperationError(
    OPERATION,
    "io",
    undefined,
    cause instanceof Error ? cause.message : String(cause),
    { cause },
  );
};

export const verifyArtifactSignature = async (
  input: VerifyArtifactSignatureInput,
  options: ExecutionOptions = {},
): Promise<Result<SignatureReport, AnalysisError>> => {
  const parsed = verifyArtifactSignatureInputSchema.safeParse(input);
  if (!parsed.success)
    return err(
      new AnalysisInputError(OPERATION, { userMessage: parsed.error.message }),
    );
  input = parsed.data;
  if (
    (input.kind !== "wheel" && input.public_key !== undefined) ||
    (input.kind === "apple" && input.trusted_certificate !== undefined)
  )
    return err(
      new AnalysisInputError(OPERATION, {
        userMessage:
          "public_key is supported only for wheel JWS; Apple verification does not accept a trust certificate.",
      }),
    );
  let completed: Evidence | undefined;
  try {
    const snapshot = await readStableArtifact(
      input.path,
      input.max_artifact_bytes,
      options.signal,
    );
    const report = initialReport(input, snapshot);
    await withDecompilerScratch("signature", async (scratch, run) => {
      const target = join(
        scratch,
        `artifact${input.kind === "jar" ? ".jar" : input.kind === "wheel" ? ".whl" : ""}`,
      );
      await writeFile(target, snapshot.bytes, { flag: "wx", mode: 0o600 });
      const context: SignatureContext = {
        input,
        report,
        scratch,
        target,
        bytes: snapshot.bytes,
        run,
        signal: options.signal,
        certificate: await stageMaterial(
          input.trusted_certificate,
          "certificate",
          { scratch, report, signal: options.signal },
        ),
        publicKey: await stageMaterial(input.public_key, "public_key", {
          scratch,
          report,
          signal: options.signal,
        }),
      };
      if (input.kind === "jar") await verifyJar(context);
      else if (input.kind === "apple") await verifyApple(context);
      else if (input.kind === "authenticode") await verifyAuthenticode(context);
      else await verifyWheel(context);
      finishReport(report, input);
      if (Buffer.byteLength(JSON.stringify(report)) > 4 * 1024 ** 2)
        throw new AnalysisResourceConstraintError(
          OPERATION,
          "transport",
          "The complete signature report exceeds 4 MiB.",
          { max_report_bytes: 4 * 1024 ** 2 },
        );
      completed = createEvidence(
        { path: input.path, format: "file", sha256: snapshot.sha256 },
        SUPPLY_CHAIN_PROVIDER,
        {
          operation: OPERATION,
          parameters: Object.fromEntries(
            Object.entries(input).filter(
              (entry): entry is [string, string | number] =>
                entry[1] !== undefined,
            ),
          ),
          result: report,
          confidence: "derived",
          limitations: report.limitations,
          locations: [{ kind: "artifact-path", path: input.path }],
        },
      );
      options.signal?.throwIfAborted();
    });
    options.signal?.throwIfAborted();
    return ok(report);
  } catch (cause) {
    const error = failure(cause, input, options.signal);
    if (completed !== undefined) error.retainPartialObservation(completed);
    return err(error);
  }
};

const finishReport = (
  report: SignatureReport,
  input: VerifyArtifactSignatureInput,
) => {
  const states = report.checks.map((entry) => entry.status);
  const status = states.includes("failed")
    ? "failed"
    : states.includes("unsigned")
      ? "unsigned"
      : states.includes("unavailable")
        ? "unavailable"
        : states.includes("unknown") || states.length === 0
          ? "unknown"
          : "passed";
  report.integrity = {
    status,
    reason:
      status === "passed"
        ? "All applicable cryptographic and content-coverage checks passed; signer identity and trust are reported separately."
        : "See individual checks; the entire selected artifact has not been established as authentic.",
  };
  if (input.expected_signer_sha256 !== undefined) {
    const expected = input.expected_signer_sha256.toLowerCase();
    report.signer_identity = {
      status:
        report.signers.length === 0
          ? "unknown"
          : report.signers.every(
                (signer) =>
                  (signer.certificate_sha256 ?? signer.public_key_sha256) ===
                  expected,
              )
            ? "passed"
            : "failed",
      reason:
        "Every observed signer must match expected_signer_sha256 (certificate DER, or public-key SPKI DER for JWS).",
    };
  }
};

const initialReport = (
  input: VerifyArtifactSignatureInput,
  snapshot: { sha256: string; bytes: Uint8Array },
): SignatureReport => {
  return {
    kind: input.kind,
    artifact: {
      path: input.path,
      sha256: snapshot.sha256,
      bytes: snapshot.bytes.length,
    },
    integrity: {
      status: "unknown",
      reason: "Verification has not completed.",
    },
    checks: [],
    signers: [],
    signer_identity: {
      status: "not_checked",
      reason: "No expected signer fingerprint was supplied.",
    },
    trust:
      input.trusted_certificate !== undefined || input.public_key !== undefined
        ? {
            status: "unknown",
            reason: "Caller-supplied trust material has not been validated.",
          }
        : {
            status: "not_checked",
            reason: "No caller trust material was supplied.",
          },
    trust_material: [],
    timestamp: {
      status: "not_checked",
      present: null,
      reason: "Timestamp authentication was not checked.",
    },
    revocation: {
      status: "not_checked",
      reason: "Offline verification does not query revocation services.",
    },
    notarization: {
      status: "not_checked",
      reason: "No notarization or Gatekeeper service was queried.",
    },
    unsigned_members: [],
    providers: [],
    limitations: [
      "Source inputs are read only; verification uses private scratch copies. No online trust, revocation, or notarization is established.",
      "Verifier executable digests identify the installed tools observed before execution; they are provenance, not admitted executable pins.",
    ],
  };
};
