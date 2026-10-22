import type { ArchiveReadPolicy } from "../archives/StreamArchiveArtifactReader.js";

import type { ArtifactResourceScope } from "../ArtifactResourceScope.js";

/** Resolved integrity behavior admitted to the artifact scanner. */
export type ArtifactIntegrityPolicy =
  | { readonly mode: "fail" }
  | { readonly mode: "record-and-continue" };

export const STRICT_INTEGRITY_POLICY: ArtifactIntegrityPolicy = {
  mode: "fail",
};

/** Options shared by artifact inventory scans. */
export interface ArtifactInventoryOptions {
  readonly resourceScope: ArtifactResourceScope;
  readonly signal?: AbortSignal | undefined;
  readonly integrity?: ArtifactIntegrityPolicy | undefined;
  readonly environment?: Readonly<NodeJS.ProcessEnv> | undefined;
  /** Archive decoding policy; local scans allow installed decoders by default. */
  readonly archive?: ArchiveReadPolicy | undefined;
}
