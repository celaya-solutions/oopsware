import { OfficeDocumentService } from "../application/officeDocument/OfficeDocumentService.js";
import { OfficeDocumentProvider } from "../officeDocument/OfficeDocumentProvider.js";

/** In-process Office Open XML reading; nothing is opened in an application, converted or fetched. */
export const createOfficeDocumentService = (): OfficeDocumentService =>
  new OfficeDocumentService(new OfficeDocumentProvider());
