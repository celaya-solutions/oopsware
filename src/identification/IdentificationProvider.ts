import { realpath, stat } from "node:fs/promises";

import type { ExecutionOptions } from "../application/AnalysisProvider.js";
import { IDENTIFICATION_PROVIDER } from "../application/InvestigationProviders.js";
import type {
  IdentificationPort,
  ReadPiece,
} from "../application/identification/IdentificationPort.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisAccessDeniedError,
  AnalysisCancelledError,
  AnalysisUnsupportedTargetError,
} from "../domain/analysisErrorCore.js";
import { ArtifactOperationError } from "../domain/artifactOperationError.js";
import type {
  IdentificationWalk,
  IdentifyArtifactInput,
} from "../domain/identification/identification.js";
import { err, ok, type Result } from "../domain/result.js";
import { walkPath } from "./walkPath.js";

const OPERATION = "identify_artifact";

/** Typed errors for a walk that produced no answer at all. */
const failure = (path: string, cause: unknown): AnalysisError => {
  const code =
    cause instanceof Error && "code" in cause ? String(cause.code) : undefined;
  if (code === "EACCES" || code === "EPERM")
    return new AnalysisAccessDeniedError(OPERATION, path, code, { cause });
  return new ArtifactOperationError(
    OPERATION,
    cause instanceof ArtifactReaderFailure
      ? cause.reason
      : code === "ENOENT" || code === "ENOTDIR"
        ? "path"
        : "io",
    undefined,
    cause instanceof Error ? cause.message : "Identification failed.",
    { cause },
  );
};

/** Walks a caller-selected file or folder in process; nothing is executed. */
export class IdentificationProvider implements IdentificationPort {
  readonly identity = IDENTIFICATION_PROVIDER;

  constructor(
    readonly environment: Readonly<NodeJS.ProcessEnv> = process.env,
    readonly platform: NodeJS.Platform = process.platform,
    /** Where private scratch directories go; the host temp folder by default. */
    readonly scratchParent?: string,
  ) {}

  async identify(
    input: IdentifyArtifactInput,
    options: ExecutionOptions & { readonly readPiece: ReadPiece },
  ): Promise<Result<IdentificationWalk, AnalysisError>> {
    const { signal } = options;
    try {
      const path = await realpath(input.path);
      const metadata = await stat(path);
      if (!metadata.isFile() && !metadata.isDirectory())
        return err(
          new AnalysisUnsupportedTargetError(
            OPERATION,
            input.path,
            "The path is neither a regular file nor a folder.",
          ),
        );
      return ok(
        await walkPath(input, path, metadata.isDirectory(), {
          signal,
          readPiece: options.readPiece,
          environment: this.environment,
          platform: this.platform,
          scratchParent: this.scratchParent,
        }),
      );
    } catch (cause: unknown) {
      if (signal?.aborted === true)
        return err(new AnalysisCancelledError(OPERATION, { cause }));
      return err(failure(input.path, cause));
    }
  }
}
