import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Result } from "../../domain/result.js";
import type {
  InspectPdfDocumentInput,
  PdfDocumentReport,
} from "../../domain/pdfDocument/pdfDocument.js";

/** Stable read of one caller-selected PDF: structure in process, page text through an admitted Poppler. */
export interface PdfDocumentPort {
  readonly identity: ProviderIdentity;
  inspectDocument(
    input: InspectPdfDocumentInput,
    options?: ExecutionOptions,
  ): Promise<Result<PdfDocumentReport, AnalysisError>>;
}
