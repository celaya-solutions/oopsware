import { stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import type { FileHandle } from "node:fs/promises";
import type { z } from "zod";
import type { inspectPlistSchema } from "../domain/native/nativeInspection.js";
import type {
  AnalysisError,
  AnalysisErrorOptions,
  AnalysisCapturedOutput,
} from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
} from "../domain/analysisErrorCore.js";
import { BinaryTargetError } from "../domain/configurationErrors.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { err, ok, type Result } from "../domain/result.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import {
  ArtifactFileCleanupFailure,
  artifactFilePrimaryFailure,
  artifactFileCancellationCause,
  bindArtifactFileCleanup,
  withArtifactRegularFile,
} from "../artifacts/ArtifactFileOperation.js";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { NATIVE_MACOS_PROVIDER_IDENTITY as IDENTITY } from "./NativeMacOSProviderMetadata.js";

/** Resolved lookup identity and selection intent, independent of file readiness. */
export interface NativePlistSelection {
  readonly path: string;
  readonly origin: "selected" | "default";
}

/** Resolve intent once; consumers never infer it from an omitted tool argument. */
export const resolveNativePlistSelection = async (
  target: BinaryTarget,
  requested: string | undefined,
): Promise<Result<NativePlistSelection, AnalysisError>> => {
  try {
    if (requested !== undefined && isAbsolute(requested))
      return ok({ path: resolve(requested), origin: "selected" });
    if (
      requested === undefined &&
      target.kind === "artifact" &&
      target.format === "plist"
    )
      return ok({ path: target.path, origin: "selected" });
    const source = target.sourcePath ?? target.path;
    const sourceMetadata = await stat(source);
    const root = sourceMetadata.isDirectory()
      ? source
      : (macOSBundleRoot(target.path) ?? dirname(target.path));
    if (requested !== undefined)
      return ok({ path: resolve(root, requested), origin: "selected" });
    return ok({
      path: target.bundleInfoPlist ?? resolve(root, "Contents/Info.plist"),
      origin: "default",
    });
  } catch (cause: unknown) {
    return err(
      new ProviderAdapterError(IDENTITY.id, "inspect_plist", { cause }),
    );
  }
};

/** The bundle whose Contents/MacOS directory directly holds the program. */
const macOSBundleRoot = (path: string): string | undefined => {
  const programs = dirname(path);
  const contents = dirname(programs);
  return basename(programs) === "MacOS" && basename(contents) === "Contents"
    ? dirname(contents)
    : undefined;
};

/**
 * Report a plist that cannot be decoded as the caller's selection, or as the
 * target's missing default, rather than as a failed tool run.
 */
export const unreadablePlist = (
  selection: NativePlistSelection,
  reason: string,
  options?: AnalysisErrorOptions,
): AnalysisError => {
  const { path } = selection;
  const sentence = reason.endsWith(".") ? reason : `${reason}.`;
  // Name the default that is missing and the selection that still works.
  const missingDefault = `The target has no readable default plist at ${path}: ${sentence} Select another plist in the target with the path input (CLI: --relative-path).`;
  return selection.origin === "default"
    ? new AnalysisCapabilityUnavailableError(
        IDENTITY.id,
        "inspect_plist",
        missingDefault,
        { ...options, userMessage: missingDefault },
      )
    : new AnalysisInputError("inspect_plist", options, [
        {
          path: ["path"],
          reason: "invalid_value",
          message: `Cannot inspect ${path}: ${sentence}`,
        },
      ]);
};

interface PlistFileInput {
  readonly selection: NativePlistSelection;
  readonly resources: ArtifactResourceScope;
  readonly signal: AbortSignal | undefined;
  readonly capturedOutput?: AnalysisCapturedOutput;
}

/** Translate only physical file outcomes, never a later signal or arbitrary abort value. */
export const nativePlistFailure = (
  cause: unknown,
  selection: NativePlistSelection | undefined,
  capturedOutput?: AnalysisCapturedOutput,
): AnalysisError => {
  if (cause instanceof ArtifactReaderFailure && cause.cleanup !== undefined) {
    const physical =
      cause instanceof ArtifactFileCleanupFailure
        ? cause.fileCleanupFailure
        : undefined;
    const previous =
      physical?.outcome.kind === "failed"
        ? nativePlistFailure(
            artifactFilePrimaryFailure(cause),
            selection,
            capturedOutput,
          )
        : physical?.completionCancellation === undefined
          ? undefined
          : new AnalysisCancelledError("inspect_plist", {
              cause: physical.completionCancellation.reason,
              capturedOutput,
            });
    const previousProjection =
      previous === undefined ? null : projectAnalysisError(previous);
    // The top-level capture owns the output once; this snapshot keeps the primary reason.
    const previousDetails = previousProjection?.details;
    const { captured_output: _capture, ...reasonDetails } =
      previousDetails ?? {};
    const previousError =
      previousProjection === null
        ? null
        : {
            ...previousProjection,
            ...(previousDetails === undefined
              ? {}
              : { details: reasonDetails }),
          };
    const failure = new ProviderCleanupError(
      IDENTITY.id,
      cause.cleanup.resources,
      {
        reason: cause.cleanup.reason,
        previous_error: previousError,
      },
      {
        operation: "inspect_plist",
        cause,
        cleanupPrimary: previous,
        capturedOutput,
      },
    );
    bindArtifactFileCleanup(cause, failure);
    return failure;
  }
  if (cause instanceof ArtifactReaderFailure && cause.reason === "cancelled")
    return new AnalysisCancelledError("inspect_plist", {
      cause: artifactFileCancellationCause(cause),
      capturedOutput,
    });
  if (cause instanceof ArtifactReaderFailure && cause.reason === "unavailable")
    return new AnalysisCapabilityUnavailableError(
      IDENTITY.id,
      "inspect_plist",
      cause.message,
      { cause, capturedOutput },
    );
  if (selection === undefined)
    return new ProviderAdapterError(IDENTITY.id, "inspect_plist", {
      cause,
      capturedOutput,
      diagnostics: {
        phase: "plist-scope",
        reason: cause instanceof Error ? cause.message : String(cause),
      },
    });
  const { path } = selection;
  const code =
    cause instanceof Error && "code" in cause ? cause.code : undefined;
  if (code === "ENOENT" || code === "ENOTDIR")
    return unreadablePlist(selection, "no file exists there", {
      cause,
      capturedOutput,
    });
  if (code === "EISDIR" || code === "ENOTFILE")
    return unreadablePlist(selection, "it is not a regular file", {
      cause,
      capturedOutput,
    });
  if (code === "EACCES" || code === "EPERM")
    return new BinaryTargetError(
      path,
      `permission denied while reading plist (${code})`,
      { cause, capturedOutput },
    );
  return new ProviderAdapterError(IDENTITY.id, "inspect_plist", {
    cause,
    capturedOutput,
    diagnostics: {
      path,
      phase: "plist-file",
      reason: cause instanceof Error ? cause.message : String(cause),
    },
  });
};

const readPlistFile = async <Value>(
  input: PlistFileInput,
  read: (file: FileHandle) => Promise<Value>,
): Promise<Result<Value, AnalysisError>> => {
  try {
    return ok(
      await withArtifactRegularFile(
        input.selection.path,
        input.resources,
        input.signal,
        read,
        "follow",
      ),
    );
  } catch (cause: unknown) {
    return err(
      nativePlistFailure(cause, input.selection, input.capturedOutput),
    );
  }
};

/** Shared admission verifies one readable regular descriptor without blocking on pipes. */
export const requireRegularPlist = (
  input: PlistFileInput,
): Promise<Result<null, AnalysisError>> =>
  readPlistFile(input, async () => null);

/** Bytes examined for leading markup when `file` reports only text. */
const PLIST_MARKUP_PROBE_BYTES = 4096;

/** Source classification remains independent of plutil's converted value format. */
export const plistSourceFormat = async (
  description: string,
  input: PlistFileInput,
): Promise<
  Result<z.infer<typeof inspectPlistSchema>["format"], AnalysisError>
> => {
  if (/binary property list/iu.test(description)) return ok("binary");
  if (/\bXML\b/iu.test(description)) return ok("xml");
  if (/\bJSON\b/iu.test(description)) return ok("json");
  if (!/\btext\b/iu.test(description)) return ok("unknown");
  return readPlistFile(input, async (file) => {
    const head = Buffer.alloc(PLIST_MARKUP_PROBE_BYTES);
    const { bytesRead } = await file.read(head, 0, head.length, 0);
    const encoding =
      head[0] === 0xff && head[1] === 0xfe
        ? "utf-16le"
        : head[0] === 0xfe && head[1] === 0xff
          ? "utf-16be"
          : "utf-8";
    const text = new TextDecoder(encoding)
      .decode(head.subarray(0, bytesRead))
      .trimStart();
    return /^<(?:[!?]|(?:plist|dict|array|string|integer|real|data|date|true|false)[\s/>])/u.test(
      text,
    )
      ? "xml"
      : "unknown";
  });
};
