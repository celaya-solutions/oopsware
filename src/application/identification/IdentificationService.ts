import { isAbsolute } from "node:path";

import type { ExecutionOptions } from "../AnalysisProvider.js";
import type {
  IdentificationPort,
  ReaderRunner,
  ReadPiece,
} from "./IdentificationPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisUnsupportedTargetError,
} from "../../domain/analysisErrorCore.js";
import { ArtifactOperationError } from "../../domain/artifactOperationError.js";
import { analysisErrorUserMessage } from "../../domain/analysisErrorPresentation.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import { assembleIdentification } from "../../domain/identification/assemble.js";
import { headlineFromReport } from "../../domain/identification/headlines.js";
import {
  artifactIdentificationSchema,
  identifyArtifactInputSchema,
  type ArtifactIdentification,
  type IdentifyArtifactInput,
} from "../../domain/identification/identification.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import { err, ok, type Result } from "../../domain/result.js";

const OPERATION = "identify_artifact";

/** The reader looked and found another format; budgets and missing programs do not refute. */
const refutes = (error: AnalysisError): boolean =>
  error instanceof AnalysisUnsupportedTargetError ||
  (error instanceof ArtifactOperationError && error.reason === "format");

/** Read freshly: the signal can abort while the walk runs. */
const aborted = (signal?: AbortSignal): boolean => signal?.aborted === true;

/** Omitted optional choices stay absent rather than null. */
const parameters = (input: IdentifyArtifactInput) =>
  Object.fromEntries(
    Object.entries(input).filter(
      (entry): entry is [string, string | number] => entry[1] !== undefined,
    ),
  );

/** The walk must answer for the selected root and honour the requested page. */
const consistent = (
  report: ArtifactIdentification,
  input: IdentifyArtifactInput,
): boolean =>
  report.page.start === input.start &&
  report.page.limit === input.limit &&
  report.pieces.length === report.page.returned &&
  report.page.returned <= input.limit &&
  report.pieces.every(
    (piece, index) => piece.id === `p${String(input.start + index)}`,
  ) &&
  (report.page.next === null
    ? input.start + report.page.returned >= report.piece_count
    : report.page.next === input.start + report.page.returned);

/** Shared caller validation, reader routing and Evidence provenance for CLI/MCP. */
export class IdentificationService {
  constructor(
    readonly provider: IdentificationPort,
    readonly readers: ReaderRunner,
  ) {}

  async identify(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    if (aborted(options?.signal))
      return err(new AnalysisCancelledError(OPERATION));
    const parsed = identifyArtifactInputSchema.safeParse(rawInput);
    if (!parsed.success)
      return err(
        analysisInputErrorFromIssues(OPERATION, parsed.error.issues, rawInput, {
          cause: parsed.error,
        }),
      );
    const input = parsed.data;
    if (!isAbsolute(input.path))
      return err(
        new AnalysisInputError(OPERATION, undefined, [
          {
            path: ["path"],
            reason: "invalid_format",
            message: "Expected an absolute filesystem path on this host.",
          },
        ]),
      );
    const readPiece: ReadPiece = async (route, filePath, format, signal) => {
      const ran = await this.readers.run(
        route.tool,
        route.summary(filePath, format),
        signal === undefined ? {} : { signal },
      );
      return ran.ok
        ? headlineFromReport(route.tool, ran.value)
        : {
            ok: false,
            reason: analysisErrorUserMessage(ran.error),
            refuted: refutes(ran.error),
          };
    };
    const walked = await this.provider.identify(input, {
      ...options,
      readPiece,
    });
    if (!walked.ok) return walked;
    if (aborted(options?.signal))
      return err(new AnalysisCancelledError(OPERATION));
    let report: ArtifactIdentification;
    try {
      report = assembleIdentification(input, walked.value);
    } catch (cause: unknown) {
      return err(
        new AnalysisOutputError(
          OPERATION,
          "Identification produced an answer that does not match its schema.",
          { cause },
        ),
      );
    }
    if (
      !artifactIdentificationSchema.safeParse(report).success ||
      !consistent(report, input)
    )
      return err(
        new AnalysisOutputError(
          OPERATION,
          "Identification returned a page that does not match the request.",
        ),
      );
    return ok(
      createEvidence(
        {
          path: report.subject.path,
          format: report.subject.kind === "file" ? "file" : "directory",
          sha256: report.subject.sha256,
        },
        this.provider.identity,
        {
          operation: OPERATION,
          parameters: parameters(input),
          result: report,
          confidence: "observed",
          limitations: [...report.limitations],
          locations: [{ kind: "artifact-path", path: report.subject.path }],
        },
      ),
    );
  }
}
