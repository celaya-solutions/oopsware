import { DocumentService } from "../application/document/DocumentService.js";
import { StructuredTextProvider } from "../documents/StructuredTextProvider.js";

/** In-process structured-text reading; no engine, installation or network. */
export const createDocumentService = (): DocumentService =>
  new DocumentService(new StructuredTextProvider());
