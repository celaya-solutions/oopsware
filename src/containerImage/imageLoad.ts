import type {
  BlobCheck,
  ContainerImageReport,
  ImageDiagnostic,
  ImagePlatform,
  InspectContainerImageInput,
} from "../domain/containerImage/containerImage.js";
import type { BlobStore } from "./blobStore.js";
import { configPlatform, readConfig } from "./imageConfig.js";
import {
  loadDocker,
  loadOci,
  MAX_JSON_BYTES,
  parseJson,
  readBlob,
  type Candidate,
  type LoadedImage,
} from "./imageModel.js";
import { selectImage, type Selection } from "./imageSelect.js";
import { openImage, type OpenedImage } from "./imageSource.js";

interface ImageConfigs {
  readonly checks: ReadonlyMap<string, BlobCheck>;
  readonly documents: ReadonlyMap<string, unknown>;
  readonly platforms: ReadonlyMap<string, ImagePlatform | null>;
}

/** Read every image's configuration once: selection may need its platform. */
const readConfigs = async (
  store: BlobStore,
  loaded: LoadedImage,
  docker: boolean,
  diagnostics: ImageDiagnostic[],
  signal: AbortSignal | undefined,
): Promise<ImageConfigs> => {
  const checks = new Map<string, BlobCheck>();
  const documents = new Map<string, unknown>();
  const platforms = new Map<string, ImagePlatform | null>();
  for (const candidate of loaded.candidates) {
    if (candidate.kind !== "image") continue;
    const read = await readBlob(
      store,
      candidate.configPath,
      candidate.configDescriptor?.digest ?? null,
      candidate.configDescriptor?.size ?? null,
      MAX_JSON_BYTES,
      diagnostics,
      signal,
    );
    const document = read.bytes === null ? undefined : parseJson(read.bytes);
    if (read.bytes !== null && document === undefined)
      diagnostics.push({
        location: candidate.configPath,
        message: "The configuration is not valid JSON.",
      });
    // A Docker save archive names no config descriptor; its file name is the check.
    checks.set(candidate.id, docker ? candidate.blob : read.check);
    documents.set(candidate.id, document);
    platforms.set(candidate.id, configPlatform(document));
  }
  return { checks, documents, platforms };
};

export interface LoadedSelection {
  readonly opened: OpenedImage;
  readonly loaded: LoadedImage;
  readonly platforms: ReadonlyMap<string, ImagePlatform | null>;
  readonly selection: Selection;
  readonly chosen: Candidate | null;
  readonly config: ContainerImageReport["config"];
  readonly diagnostics: ImageDiagnostic[];
}

/** Open an image, read its index and configurations, and pick the image to compose. */
export const loadSelection = async (
  input: Pick<
    InspectContainerImageInput,
    "path" | "platform" | "manifest" | "max_file_bytes"
  >,
  signal: AbortSignal | undefined,
): Promise<LoadedSelection> => {
  const opened = await openImage(input, signal);
  const docker = opened.format === "docker-save-archive";
  const diagnostics: ImageDiagnostic[] = [...opened.diagnostics];
  const loaded = docker
    ? await loadDocker(opened.store, opened.hasOciIndex, signal)
    : await loadOci(opened.store, signal);
  diagnostics.push(...loaded.diagnostics);
  const configs = await readConfigs(
    opened.store,
    loaded,
    docker,
    diagnostics,
    signal,
  );
  const { selection, chosen } = selectImage(
    loaded.candidates,
    configs.platforms,
    input,
  );
  const config =
    chosen === null
      ? null
      : readConfig(
          configs.documents.get(chosen.id),
          configs.checks.get(chosen.id) ?? chosen.blob,
        );
  return {
    opened,
    loaded,
    platforms: configs.platforms,
    selection,
    chosen,
    config,
    diagnostics,
  };
};
