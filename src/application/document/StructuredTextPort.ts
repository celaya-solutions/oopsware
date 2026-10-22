import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type {
  InspectDocumentInput,
  StructuredTextDocument,
} from "../../domain/document/structuredText.js";
import type { Result } from "../../domain/result.js";

/** Stable read and structured-text parsing of one caller-selected local file. */
export interface StructuredTextPort {
  readonly identity: ProviderIdentity;
  read(
    input: InspectDocumentInput,
    options?: ExecutionOptions,
  ): Promise<Result<StructuredTextDocument, AnalysisError>>;
}
