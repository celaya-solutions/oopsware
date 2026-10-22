import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Result } from "../../domain/result.js";
import type {
  InspectOfficeDocumentInput,
  OfficeDocumentReport,
} from "../../domain/officeDocument/officeDocument.js";

/** Stable read and in-process parsing of one caller-selected Office document (Open XML or legacy 97-2003). */
export interface OfficeDocumentPort {
  readonly identity: ProviderIdentity;
  inspectDocument(
    input: InspectOfficeDocumentInput,
    options?: ExecutionOptions,
  ): Promise<Result<OfficeDocumentReport, AnalysisError>>;
}
