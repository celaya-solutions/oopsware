import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll } from "vitest";

import {
  inspectPdfDocumentInputSchema,
  pdfDocumentReportSchema,
  type PdfDocumentReport,
} from "../../src/domain/pdfDocument/pdfDocument.js";
import { PdfDocumentProvider } from "../../src/pdfDocument/PdfDocumentProvider.js";

/** A scratch folder per test file and the calls every PDF test makes. Call at the top of a test file. */
export const usePdfHarness = () => {
  const provider = new PdfDocumentProvider();
  const state = { root: "", counter: 0 };
  beforeAll(async () => {
    state.root = await mkdtemp(join(tmpdir(), "rea-pdf-test-"));
  });
  afterAll(async () => {
    await rm(state.root, { recursive: true, force: true });
  });
  const write = async (
    name: string,
    bytes: Uint8Array | string,
  ): Promise<string> => {
    state.counter += 1;
    const path = join(state.root, `${String(state.counter)}-${name}`);
    await writeFile(path, bytes);
    return path;
  };
  const call = (path: string, input: object, signal?: AbortSignal) =>
    provider.inspectDocument(
      inspectPdfDocumentInputSchema.parse({ path, ...input }),
      signal === undefined ? undefined : { signal },
    );
  const inspect = async (
    path: string,
    input: object = {},
  ): Promise<PdfDocumentReport> => {
    const result = await call(path, input);
    if (!result.ok) throw result.error;
    return pdfDocumentReportSchema.parse(result.value);
  };
  const failure = async (
    path: string,
    input: object = {},
    signal?: AbortSignal,
  ) => {
    const result = await call(path, input, signal);
    if (result.ok) throw new Error("expected a failure");
    return result.error;
  };
  return { write, inspect, failure, root: () => state.root };
};
