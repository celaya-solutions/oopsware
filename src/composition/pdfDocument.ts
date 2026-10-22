import { PdfDocumentService } from "../application/pdfDocument/PdfDocumentService.js";
import { PdfDocumentProvider } from "../pdfDocument/PdfDocumentProvider.js";

/** PDF structure in process; page text through an admitted Poppler pdftotext on a private copy. */
export const createPdfDocumentService = (): PdfDocumentService =>
  new PdfDocumentService(new PdfDocumentProvider());
