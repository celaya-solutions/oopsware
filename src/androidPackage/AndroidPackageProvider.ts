import type { ExecutionOptions } from "../application/AnalysisProvider.js";
import type { AndroidPackagePort } from "../application/androidPackage/AndroidPackagePort.js";
import { ANDROID_PACKAGE_PROVIDER } from "../application/InvestigationProviders.js";
import { readStableArtifact } from "../artifacts/readStableArtifact.js";
import { stableReadFailure } from "../artifacts/stableReadFailure.js";
import { DecodeBudget, MemberReadFailure } from "../artifacts/zipMemberView.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
  AnalysisUnsupportedTargetError,
} from "../domain/analysisErrorCore.js";
import {
  MAX_ANDROID_MEMBER_BYTES,
  type AndroidArtifactReport,
  type DecompileDexClassInput,
  type DexDecompilation,
  type DexClassReport,
  type DexMethodReport,
  type InspectAndroidArtifactInput,
  type InspectDexClassInput,
  type InspectDexMethodInput,
} from "../domain/android/androidArtifact.js";
import { ArtifactOperationError } from "../domain/artifactOperationError.js";
import { err, ok, type Result } from "../domain/result.js";
import { decompilerCleanupFailure } from "../jvm/decompilerScratch.js";
import { vineflowerFailure } from "../jvm/decompile.js";
import { resolveVineflower } from "../jvm/vineflower.js";
import { readAndroidArtifact, scopedDex } from "./artifactReport.js";
import {
  AndroidSelectionError,
  dexClassReport,
  dexMethodReport,
  selectDexClass,
  selectDexMethod,
} from "./classReport.js";
import { decompileDexClass } from "./decompile.js";
import { DexFormatError } from "./dex/DexReader.js";
import {
  Dex2jarRunFailure,
  Dex2jarUnavailable,
  resolveDex2jar,
} from "./dex2jar.js";
import { AndroidPackageView } from "./package/view.js";

type Operation =
  | "inspect_android_artifact"
  | "inspect_dex_class"
  | "inspect_dex_method"
  | "decompile_dex_class";

interface Opened {
  readonly artifact: AndroidArtifactReport["artifact"];
  readonly bytes: Uint8Array;
  readonly view: AndroidPackageView;
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

const selectionError = (operation: Operation, cause: AndroidSelectionError) =>
  new AnalysisInputError(operation, { cause }, [
    { path: [cause.field], reason: "invalid_value", message: cause.message },
  ]);

/** Typed errors for a conversion or decompiler run that produced no usable source; null for anything else. */
const decompileFailure = (
  path: string,
  input: DecompileDexClassInput,
  cause: unknown,
): AnalysisError | null => {
  const operation = "decompile_dex_class";
  const cleanup = decompilerCleanupFailure(cause, operation, (primary) =>
    decompileFailure(path, input, primary),
  );
  if (cleanup !== null) return cleanup;
  if (cause instanceof Dex2jarUnavailable)
    return new AnalysisCapabilityUnavailableError(
      "dex2jar",
      operation,
      cause.message,
      { cause },
    );
  if (!(cause instanceof Dex2jarRunFailure))
    return vineflowerFailure(operation, path, input, cause);
  switch (cause.reason) {
    case "cancelled":
      return new AnalysisCancelledError(operation, { cause });
    case "timeout":
      return new AnalysisTimeoutError(operation, input.timeout_ms, { cause });
    case "output-limit":
      return new AnalysisResourceConstraintError(
        operation,
        "memory",
        "dex2jar printed more diagnostics than the capture budget.",
        null,
        { cause },
      );
    case "process":
    case "no-output":
      return new AnalysisUnsupportedTargetError(
        operation,
        path,
        cause.message,
        {
          cause,
        },
      );
  }
};

/** Read freshly: the signal can abort while members are read. */
const aborted = (signal?: AbortSignal): boolean => signal?.aborted === true;

/** Read one file, open it as DEX or an Android package, run `use`, and always release the ZIP readers. */
const withPackage = async <T>(
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
        cancelled: aborted(signal),
        maxFileBytes: input.max_file_bytes,
        remediationAction:
          "Raise max_file_bytes (up to 1 GiB) or select a smaller file.",
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
    MAX_ANDROID_MEMBER_BYTES,
  );
  let view: AndroidPackageView | null = null;
  try {
    view = await AndroidPackageView.open(
      snapshot.bytes,
      input.path,
      budget,
      signal,
    );
    if (view === null)
      return err(
        new AnalysisUnsupportedTargetError(
          operation,
          input.path,
          "The file is neither a DEX file (dex\\n magic) nor a ZIP-based Android package.",
        ),
      );
    const result = await use({ artifact, bytes: snapshot.bytes, view });
    if (result.ok && aborted(signal))
      return err(new AnalysisCancelledError(operation));
    return result;
  } catch (cause) {
    if (cause instanceof AndroidSelectionError)
      return err(selectionError(operation, cause));
    if (cause instanceof MemberReadFailure)
      return err(
        memberFailure(operation, input.path, cause, input.max_decoded_bytes),
      );
    if (aborted(signal))
      return err(new AnalysisCancelledError(operation, { cause }));
    if (cause instanceof DexFormatError)
      return err(
        new ArtifactOperationError(
          operation,
          "format",
          undefined,
          `The DEX file is malformed at byte ${String(cause.offset)}: ${cause.message}`,
          { cause },
        ),
      );
    return err(
      new ArtifactOperationError(
        operation,
        "format",
        undefined,
        `The package could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      ),
    );
  } finally {
    await view?.close();
  }
};

/** In-process Android package reading for the shared service. */
export class AndroidPackageProvider implements AndroidPackagePort {
  readonly identity = ANDROID_PACKAGE_PROVIDER;

  inspectArtifact(
    input: InspectAndroidArtifactInput,
    options?: ExecutionOptions,
  ): Promise<Result<AndroidArtifactReport, AnalysisError>> {
    return withPackage(
      "inspect_android_artifact",
      input,
      options,
      async (opened) =>
        ok(
          await readAndroidArtifact(
            opened.view,
            opened.artifact,
            opened.bytes,
            input,
          ),
        ),
    );
  }

  inspectClass(
    input: InspectDexClassInput,
    options?: ExecutionOptions,
  ): Promise<Result<DexClassReport, AnalysisError>> {
    return withPackage("inspect_dex_class", input, options, async (opened) => {
      const loaded = await scopedDex(opened.view, input);
      const selected = selectDexClass(
        loaded,
        input,
        opened.view.kind === "dex",
      );
      return ok(dexClassReport(opened.artifact, selected));
    });
  }

  inspectMethod(
    input: InspectDexMethodInput,
    options?: ExecutionOptions,
  ): Promise<Result<DexMethodReport, AnalysisError>> {
    return withPackage("inspect_dex_method", input, options, async (opened) => {
      const loaded = await scopedDex(opened.view, input);
      const selected = selectDexClass(
        loaded,
        input,
        opened.view.kind === "dex",
      );
      const method = selectDexMethod(selected, input);
      return ok(dexMethodReport(opened.artifact, selected, method, input));
    });
  }

  async decompileClass(
    input: DecompileDexClassInput,
    options?: ExecutionOptions,
  ): Promise<Result<DexDecompilation, AnalysisError>> {
    const signal = options?.signal;
    return withPackage(
      "decompile_dex_class",
      input,
      options,
      async (opened): Promise<Result<DexDecompilation, AnalysisError>> => {
        const loaded = await scopedDex(opened.view, input);
        const selected = selectDexClass(
          loaded,
          input,
          opened.view.kind === "dex",
        );
        try {
          const vineflower = await resolveVineflower(signal);
          const dex2jar = await resolveDex2jar();
          return ok(
            await decompileDexClass({
              artifact: opened.artifact,
              selected,
              input,
              dex2jar,
              vineflower,
              signal,
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
