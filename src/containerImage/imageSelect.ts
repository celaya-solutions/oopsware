import type {
  ContainerImageReport,
  ImagePlatform,
  InspectContainerImageInput,
} from "../domain/containerImage/containerImage.js";
import type { Candidate } from "./imageModel.js";

export type Selection = ContainerImageReport["selection"];

interface Choice {
  readonly selection: Selection;
  readonly chosen: Candidate | null;
}

const parsePlatform = (value: string): ImagePlatform => {
  const [os, architecture, variant] = value.split("/");
  return {
    os: os ?? null,
    architecture: architecture ?? null,
    variant: variant ?? null,
    os_version: null,
  };
};

const platformLabel = (platform: ImagePlatform | null): string =>
  platform === null
    ? "unknown platform"
    : [platform.os, platform.architecture, platform.variant]
        .filter((part): part is string => part !== null)
        .join("/") || "unknown platform";

const matches = (have: ImagePlatform | null, want: ImagePlatform): boolean =>
  have !== null &&
  have.os === want.os &&
  have.architecture === want.architecture &&
  (want.variant === null || have.variant === want.variant);

const pick = (chosen: Candidate, by: NonNullable<Selection["by"]>): Choice => ({
  selection: { state: "selected", by, id: chosen.id, reason: null },
  chosen,
});

const none = (reason: string): Choice => ({
  selection: { state: "none", by: null, id: null, reason },
  chosen: null,
});

/** Pick the image to compose, or say why none was picked. */
export const selectImage = (
  candidates: readonly Candidate[],
  platforms: ReadonlyMap<string, ImagePlatform | null>,
  input: Pick<InspectContainerImageInput, "manifest" | "platform">,
): Choice => {
  const platformOf = (candidate: Candidate): ImagePlatform | null =>
    candidate.platform ?? platforms.get(candidate.id) ?? null;
  const images = candidates.filter((candidate) => candidate.kind === "image");
  if (input.manifest !== undefined) {
    const found = candidates.find(
      (candidate) => candidate.id === input.manifest,
    );
    return found === undefined
      ? none(`No image has the id ${input.manifest}.`)
      : pick(found, "manifest");
  }
  const want =
    input.platform === undefined ? null : parsePlatform(input.platform);
  const pool =
    want === null
      ? images
      : images.filter((candidate) => matches(platformOf(candidate), want));
  const only = pool[0];
  if (pool.length === 1 && only !== undefined)
    return pick(only, want === null ? "only" : "platform");
  if (pool.length === 0)
    return none(
      want === null
        ? "The image lists no image manifest."
        : `No image matches ${input.platform}. Available: ${
            images
              .map((candidate) => platformLabel(platformOf(candidate)))
              .join(", ") || "none"
          }.`,
    );
  const ids = pool.map((candidate) => candidate.id).join(", ");
  return {
    selection: {
      state: "ambiguous",
      by: null,
      id: null,
      reason: `${String(pool.length)} images ${
        want === null ? "are listed" : `match ${input.platform}`
      }; choose one with platform or manifest. Ids: ${ids}.`,
    },
    chosen: null,
  };
};
