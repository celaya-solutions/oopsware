import type { ExecutionOptions } from "../application/AnalysisProvider.js";
import type { ContainerImagePort } from "../application/containerImage/ContainerImagePort.js";
import { CONTAINER_IMAGE_PROVIDER } from "../application/InvestigationProviders.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
  AnalysisUnsupportedTargetError,
} from "../domain/analysisErrorCore.js";
import { ArtifactOperationError } from "../domain/artifactOperationError.js";
import type {
  ContainerImageReport,
  InspectContainerImageInput,
} from "../domain/containerImage/containerImage.js";
import { err, ok, type Result } from "../domain/result.js";
import { PayloadDecodeFailure } from "../linuxPackage/decode.js";
import { BlobUnavailable } from "./blobStore.js";
import {
  coverageOf,
  pageComposed,
  pageLayer,
  type FilePage,
} from "./imagePage.js";
import { loadSelection } from "./imageLoad.js";
import { OPERATION } from "./imageSource.js";
import { composeLayers, trusted, type Composition } from "./layerCompose.js";
import type { DecodeBudget } from "./layerWalk.js";

const LIMITATIONS: readonly string[] = [
  "Environment, entrypoint, command, ports, user, volumes and labels are declarations in the image configuration, not observed runtime behavior.",
  "Nothing is pulled, started, mounted or run. Foreign layers are named with their URLs and never fetched.",
  "The composed view applies whiteouts, opaque directories and replacements in layer order. It does not resolve symbolic links in parent paths and does not track hard-link inode identity across layers.",
  "Layers are decoded in process when they are uncompressed tar, gzip or zstd; other compressions are listed but not read.",
];

const requireLayer = (
  layer: number | undefined,
  layerCount: number | null,
): void => {
  if (layer === undefined || layerCount === null || layer < layerCount) return;
  throw new AnalysisInputError(OPERATION, undefined, [
    {
      path: ["layer"],
      reason: "out_of_range",
      message: `The selected image has ${String(layerCount)} layers; the highest index is ${String(Math.max(0, layerCount - 1))}.`,
    },
  ]);
};

const pairs = (
  values: readonly (readonly [string, string])[],
): { key: string; value: string }[] =>
  values.map(([key, value]) => ({ key, value }));

const decoderRecords = (
  compressions: ReadonlySet<string>,
): ContainerImageReport["decoders"] =>
  [...compressions].sort().map((name) => ({
    tool: "node:zlib",
    version:
      name === "gzip"
        ? `gunzip, zlib ${process.versions.zlib ?? "unknown"}`
        : `zstd ${process.versions.zstd ?? "unknown"}`,
  }));

/** One layer's own entries are complete when it was read to its end and nothing contradicts its digests. */
const layerComplete = (
  layers: ContainerImageReport["layers"],
  index: number | undefined,
): boolean => {
  const layer = layers.find((candidate) => candidate.index === index);
  return (
    layer !== undefined &&
    layer.read === "complete" &&
    trusted(layer.blob) &&
    layer.diff_id.valid !== false
  );
};

/** Diagnostics kept in a report; a hostile image can make millions. */
const MAX_DIAGNOSTICS = 1000;

const boundedDiagnostics = (
  diagnostics: ContainerImageReport["diagnostics"],
): ContainerImageReport["diagnostics"] =>
  diagnostics.length <= MAX_DIAGNOSTICS
    ? diagnostics
    : [
        ...diagnostics.slice(0, MAX_DIAGNOSTICS),
        {
          location: null,
          message: `${String(diagnostics.length - MAX_DIAGNOSTICS)} more diagnostics were not listed.`,
        },
      ];

/** A typed error for a failure that leaves no report. */
const failure = (
  cause: unknown,
  input: InspectContainerImageInput,
  signal: AbortSignal | undefined,
): AnalysisError => {
  if (
    signal?.aborted === true ||
    (cause instanceof PayloadDecodeFailure && cause.reason === "cancelled")
  )
    return new AnalysisCancelledError(OPERATION, { cause });
  if (cause instanceof PayloadDecodeFailure && cause.reason === "budget")
    return new AnalysisResourceConstraintError(
      OPERATION,
      "memory",
      cause.message,
      { max_decoded_bytes: input.max_decoded_bytes },
      {
        cause,
        remediationAction:
          "Raise max_decoded_bytes (up to 2 GiB), or select a smaller image if the entry limit was reached.",
      },
    );
  if (
    cause instanceof AnalysisUnsupportedTargetError ||
    cause instanceof AnalysisInputError ||
    cause instanceof ArtifactOperationError ||
    cause instanceof AnalysisResourceConstraintError
  )
    return cause;
  if (cause instanceof Error && "_tag" in cause) return cause as AnalysisError;
  return new ArtifactOperationError(
    OPERATION,
    "format",
    undefined,
    `The image could not be read: ${
      cause instanceof BlobUnavailable || cause instanceof Error
        ? cause.message
        : String(cause)
    }`,
    { cause },
  );
};

/** In-process OCI and Docker image reading for the shared service. */
export class ContainerImageProvider implements ContainerImagePort {
  readonly identity = CONTAINER_IMAGE_PROVIDER;

  async inspectImage(
    input: InspectContainerImageInput,
    options?: ExecutionOptions,
  ): Promise<Result<ContainerImageReport, AnalysisError>> {
    const signal = options?.signal;
    try {
      return ok(await this.#inspect(input, signal));
    } catch (cause) {
      return err(failure(cause, input, signal));
    }
  }

  async #inspect(
    input: InspectContainerImageInput,
    signal: AbortSignal | undefined,
  ): Promise<ContainerImageReport> {
    const {
      opened,
      loaded,
      platforms,
      selection,
      chosen,
      config,
      diagnostics,
    } = await loadSelection(input, signal);
    requireLayer(input.layer, chosen?.layers?.length ?? null);

    const budget: DecodeBudget = {
      remaining: input.max_decoded_bytes,
      limit: input.max_decoded_bytes,
    };
    const composition: Composition | null =
      chosen === null
        ? null
        : await composeLayers({
            store: opened.store,
            chosen,
            config,
            keepLayer: input.layer,
            budget,
            maxFileBytes: input.max_file_bytes,
            signal,
            diagnostics,
          });
    const composed = composition !== null && input.layer === undefined;
    const window = { start: input.start, limit: input.limit };
    const listing: FilePage =
      composition === null
        ? { fileCount: 0, files: [], next: null }
        : composed
          ? pageComposed(composition.view, window)
          : pageLayer(composition.kept, window);
    const layers = composition?.layers ?? [];
    const verified = [
      ...(config === null ? [] : [config.blob]),
      ...(chosen === null ? [] : [chosen.blob]),
      ...layers.map((layer) => layer.blob),
    ].every(trusted);

    return {
      artifact: opened.artifact,
      image: {
        format: opened.format,
        layout_version: loaded.layoutVersion,
        has_oci_index: loaded.hasOciIndex,
        index_annotations: pairs(loaded.indexAnnotations),
      },
      manifests: loaded.candidates.map((candidate) => ({
        id: candidate.id,
        kind: candidate.kind,
        media_type: candidate.mediaType,
        platform: candidate.platform ?? platforms.get(candidate.id) ?? null,
        ref_names: [...candidate.refNames],
        annotations: pairs(candidate.annotations),
        layer_count: candidate.layers?.length ?? null,
        blob: candidate.blob,
        selected: candidate.id === chosen?.id,
      })),
      selection,
      config,
      layers,
      view: composition === null ? "none" : composed ? "composed" : "layer",
      file_count: listing.fileCount,
      page: { ...window, returned: listing.files.length, next: listing.next },
      files: listing.files,
      decoders: decoderRecords(composition?.compressions ?? new Set()),
      diagnostics: boundedDiagnostics(diagnostics),
      coverage: coverageOf({
        selected: chosen !== null,
        selection,
        composed,
        inventoryComplete: composed
          ? composition.complete
          : layerComplete(layers, input.layer),
        inspectComplete: diagnostics.length === 0 && verified,
      }),
      limitations: [...LIMITATIONS],
    };
  }
}
