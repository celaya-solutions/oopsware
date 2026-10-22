import type { ExecutionOptions } from "../application/AnalysisProvider.js";
import { JVM_PROVIDER } from "../application/InvestigationProviders.js";
import type { JvmPort } from "../application/jvm/JvmPort.js";
import { readStableArtifact } from "../artifacts/readStableArtifact.js";
import { stableReadFailure } from "../artifacts/stableReadFailure.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
  AnalysisUnsupportedTargetError,
} from "../domain/analysisErrorCore.js";
import { ArtifactOperationError } from "../domain/artifactOperationError.js";
import {
  MAX_JVM_MEMBER_BYTES,
  type DecompileJvmClassInput,
  type InspectJvmArtifactInput,
  type InspectJvmClassInput,
  type InspectJvmMethodInput,
  type JvmArtifactReport,
} from "../domain/jvm/jvm.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  DecodeBudget,
  MemberReadFailure,
  sha256Hex,
} from "../artifacts/zipMemberView.js";
import { readArtifactReport } from "./artifactReport.js";
import {
  classReport,
  methodReport,
  selectClass,
  selectMethod,
  type SelectionProblem,
} from "./classReport.js";
import { decompileClass, vineflowerFailure } from "./decompile.js";
import { closeSource, openJvmSource, type JvmSource } from "./source.js";
import { resolveVineflower } from "./vineflower.js";

type Operation =
  | "inspect_jvm_artifact"
  | "inspect_jvm_class"
  | "inspect_jvm_method"
  | "decompile_jvm_class";

interface Opened {
  readonly artifact: JvmArtifactReport["artifact"];
  /** The stable bytes read for the artifact, reused as decompiler type context. */
  readonly bytes: Uint8Array;
  readonly source: JvmSource;
  readonly budget: DecodeBudget;
}

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
        { cause },
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

/** Read freshly: the signal can abort while the archive is read. */
const aborted = (signal?: AbortSignal): boolean => signal?.aborted === true;

const selectionError = (operation: Operation, problem: SelectionProblem) =>
  new AnalysisInputError(operation, undefined, [
    {
      path: [problem.field],
      reason: "invalid_value",
      message: problem.message,
    },
  ]);

/** Read one file, open it as a class or archive, run `use`, and always release the archive readers. */
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
  if (signal?.aborted === true)
    return err(new AnalysisCancelledError(operation));
  const artifact = {
    path: input.path,
    sha256: snapshot.sha256,
    bytes: snapshot.bytes.length,
  };
  const budget = new DecodeBudget(
    input.max_decoded_bytes,
    MAX_JVM_MEMBER_BYTES,
  );
  let source: JvmSource | null = null;
  try {
    source = await openJvmSource(
      snapshot.bytes,
      input.path,
      budget,
      sha256Hex,
      signal,
    );
    if (source === null)
      return err(
        new AnalysisUnsupportedTargetError(
          operation,
          input.path,
          "The file is neither a class file (0xCAFEBABE with a JVM version) nor a ZIP-based JAR or AAR.",
        ),
      );
    const result = await use({
      artifact,
      bytes: snapshot.bytes,
      source,
      budget,
    });
    if (result.ok && aborted(signal))
      return err(new AnalysisCancelledError(operation));
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
    await closeSource(source);
  }
};

/** In-process JVM class file, JAR and AAR reading; nothing runs in a JVM. */
export class JvmProvider implements JvmPort {
  readonly identity = JVM_PROVIDER;

  inspectArtifact(input: InspectJvmArtifactInput, options?: ExecutionOptions) {
    return withSource(
      "inspect_jvm_artifact",
      input,
      options,
      async ({ artifact, source, budget }) =>
        ok(
          await readArtifactReport({
            artifact,
            source,
            budget,
            start: input.start,
            limit: input.limit,
            signal: options?.signal,
          }),
        ),
    );
  }

  inspectClass(input: InspectJvmClassInput, options?: ExecutionOptions) {
    const operation = "inspect_jvm_class";
    return withSource(
      operation,
      input,
      options,
      async ({ artifact, source, budget }) => {
        const selected = await selectClass(
          source,
          input,
          budget,
          options?.signal,
        );
        if ("field" in selected)
          return err(selectionError(operation, selected));
        return ok(classReport(artifact, selected));
      },
    );
  }

  inspectMethod(input: InspectJvmMethodInput, options?: ExecutionOptions) {
    const operation = "inspect_jvm_method";
    return withSource(
      operation,
      input,
      options,
      async ({ artifact, source, budget }) => {
        const selected = await selectClass(
          source,
          input,
          budget,
          options?.signal,
        );
        if ("field" in selected)
          return err(selectionError(operation, selected));
        const method = selectMethod(
          selected.parsed,
          input.method,
          input.descriptor,
        );
        if ("field" in method) return err(selectionError(operation, method));
        return ok(
          methodReport(artifact, selected, method, input.start, input.limit),
        );
      },
    );
  }

  decompileClass(input: DecompileJvmClassInput, options?: ExecutionOptions) {
    const operation = "decompile_jvm_class";
    return withSource(
      operation,
      input,
      options,
      async ({ artifact, bytes, source, budget }) => {
        const selected = await selectClass(
          source,
          input,
          budget,
          options?.signal,
        );
        if ("field" in selected)
          return err(selectionError(operation, selected));
        try {
          const tool = await resolveVineflower(options?.signal);
          return ok(
            await decompileClass({
              artifact,
              artifactBytes: bytes,
              source,
              selected,
              budget,
              input,
              tool,
              signal: options?.signal,
            }),
          );
        } catch (cause) {
          const mapped = vineflowerFailure(operation, input.path, input, cause);
          if (mapped === null) throw cause;
          return err(mapped);
        }
      },
    );
  }
}
