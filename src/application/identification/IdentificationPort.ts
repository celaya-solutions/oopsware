import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { FormatId } from "../../domain/formatIdentifiers.js";
import type {
  Headline,
  IdentificationWalk,
  IdentifyArtifactInput,
} from "../../domain/identification/identification.js";
import type { ReaderRoute } from "../../domain/identification/readerRoutes.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import type { Result } from "../../domain/result.js";

/**
 * Runs one routed reader on a file and returns its headline or why not.
 * `refuted` is true only when the reader says the file is not its format,
 * never for a budget, an unavailable host program or an I/O failure.
 */
export type ReadPiece = (
  route: ReaderRoute,
  filePath: string,
  format: FormatId | null,
  signal?: AbortSignal,
) => Promise<
  | { readonly ok: true; readonly headline: Headline }
  | { readonly ok: false; readonly reason: string; readonly refuted: boolean }
>;

/** Walks one file or folder: detection, nested containers, folder entries. */
export interface IdentificationPort {
  readonly identity: ProviderIdentity;
  identify(
    input: IdentifyArtifactInput,
    options: ExecutionOptions & { readonly readPiece: ReadPiece },
  ): Promise<Result<IdentificationWalk, AnalysisError>>;
}

/**
 * Runs an existing reader tool through its own service, so its input checks,
 * output checks and limits still apply, and returns its typed report.
 */
export interface ReaderRunner {
  run(
    tool: string,
    input: { readonly [key: string]: JsonValue },
    options: ExecutionOptions,
  ): Promise<Result<unknown, AnalysisError>>;
}
