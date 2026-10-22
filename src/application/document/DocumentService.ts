import { isAbsolute } from "node:path";

import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { StructuredTextPort } from "./StructuredTextPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import {
  inspectDocumentInputSchema,
  structuredTextDocumentSchema,
  type StructuredTextDocument,
} from "../../domain/document/structuredText.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import { err, ok, type Result } from "../../domain/result.js";

const OPERATION = "inspect_document";

/** Cross-field invariants a reading must hold before it becomes Evidence. */
const consistent = (
  document: StructuredTextDocument,
  path: string,
  start: number,
  limit: number,
): boolean =>
  document.artifact.path === path &&
  document.page.start === start &&
  document.page.limit === limit &&
  document.page.returned === document.nodes.length &&
  document.nodes.length <= limit &&
  document.nodes.every(
    (node, index) =>
      node.index === start + index &&
      (node.location === null ||
        node.location.offset <= document.artifact.bytes) &&
      (node.end_offset === null || node.end_offset <= document.artifact.bytes),
  ) &&
  (document.page.next === null
    ? start + document.nodes.length >= document.node_count
    : document.page.next === start + document.nodes.length &&
      document.page.next < document.node_count);

/** Shared caller validation, output checks and Evidence provenance for CLI/MCP. */
export class DocumentService {
  constructor(readonly provider: StructuredTextPort) {}

  async inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(OPERATION));
    const input = inspectDocumentInputSchema.safeParse(rawInput);
    if (!input.success)
      return err(
        analysisInputErrorFromIssues(OPERATION, input.error.issues, rawInput, {
          cause: input.error,
        }),
      );
    if (!isAbsolute(input.data.path))
      return err(
        new AnalysisInputError(OPERATION, undefined, [
          {
            path: ["path"],
            reason: "invalid_format",
            message: "Expected an absolute filesystem path on this host.",
          },
        ]),
      );
    const read = await this.provider.read(input.data, options);
    if (!read.ok) return read;
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(OPERATION));
    const report = structuredTextDocumentSchema.safeParse(read.value);
    if (
      !report.success ||
      !consistent(
        report.data,
        input.data.path,
        input.data.start,
        input.data.limit,
      )
    )
      return err(
        new AnalysisOutputError(
          OPERATION,
          "Structured-text reader returned malformed output or changed the selected document identity.",
        ),
      );
    const document = report.data;
    return ok(
      createEvidence(
        {
          path: document.artifact.path,
          format: "file",
          sha256: document.artifact.sha256,
        },
        this.provider.identity,
        {
          operation: OPERATION,
          // Omitted optional choices stay absent rather than null.
          parameters: Object.fromEntries(
            Object.entries(input.data).filter(
              (entry): entry is [string, string | number] =>
                entry[1] !== undefined,
            ),
          ),
          result: document,
          confidence: "observed",
          limitations: document.limitations,
          // Each node carries its own line, column and byte offset.
          locations: [{ kind: "artifact-path", path: document.artifact.path }],
        },
      ),
    );
  }
}
