import { basename } from "node:path";

import type { ExecutionOptions } from "../application/AnalysisProvider.js";
import { STRUCTURED_TEXT_PROVIDER } from "../application/InvestigationProviders.js";
import type { StructuredTextPort } from "../application/document/StructuredTextPort.js";
import { readStableArtifact } from "../artifacts/readStableArtifact.js";
import { stableReadFailure } from "../artifacts/stableReadFailure.js";
import {
  AnalysisCancelledError,
  AnalysisUnsupportedTargetError,
} from "../domain/analysisErrorCore.js";
import type { InspectDocumentInput } from "../domain/document/structuredText.js";
import { err, ok } from "../domain/result.js";
import { readStructuredText } from "./structuredText/readStructuredText.js";

const OPERATION = "inspect_document";

/** In-process structured-text reading over one bounded, identity-checked regular file. */
export class StructuredTextProvider implements StructuredTextPort {
  readonly identity = STRUCTURED_TEXT_PROVIDER;

  async read(input: InspectDocumentInput, options?: ExecutionOptions) {
    let snapshot: Awaited<ReturnType<typeof readStableArtifact>>;
    try {
      snapshot = await readStableArtifact(
        input.path,
        input.max_file_bytes,
        options?.signal,
      );
    } catch (cause) {
      return err(
        stableReadFailure(OPERATION, input.path, cause, {
          cancelled: options?.signal?.aborted === true,
          maxFileBytes: input.max_file_bytes,
          remediationAction:
            "Raise max_file_bytes (up to 256 MiB) or read a smaller document.",
        }),
      );
    }
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(OPERATION));
    const read = readStructuredText({
      bytes: snapshot.bytes,
      name: basename(input.path),
      format: input.format,
      encoding: input.encoding,
      delimiter: input.delimiter,
      start: input.start,
      limit: input.limit,
    });
    if (!read.ok)
      return err(
        new AnalysisUnsupportedTargetError(
          OPERATION,
          input.path,
          read.error.message,
          {
            cause: read.error,
            remediationAction:
              "Pass format (markdown, json, jsonl, yaml, toml, xml, csv, tsv or plain-text) to choose how to parse this file.",
          },
        ),
      );
    return ok({
      artifact: {
        path: input.path,
        sha256: snapshot.sha256,
        bytes: snapshot.bytes.length,
      },
      ...read.value.reading,
    });
  }
}
