import { hashStableFile } from "../../dist/filesystem/StableFileHash.js";
import { ArtifactResourceScope } from "../../dist/artifacts/ArtifactResourceScope.js";
import { AnalysisCleanupLease } from "../../dist/artifacts/AnalysisCleanupLease.js";
import { closeVerifierResources } from "./verifier-cleanup.mjs";

/** Finish a prerequisite probe and release its exact retained cleanup owners. */
export async function withVerifierResourceOwner(operation) {
  const resources = new ArtifactResourceScope();
  const resourceOwner = {
    retain(owner, resource) {
      resources.retain({
        kind: "lease",
        resource,
        lease: AnalysisCleanupLease.forCloseOwner(owner, resource),
      });
    },
    run: (work) => resources.run(work),
  };
  let primaryError;
  try {
    return await operation(resourceOwner);
  } catch (cause) {
    primaryError = cause;
    throw cause;
  } finally {
    await closeVerifierResources([() => resources.close()], primaryError);
  }
}

/** Hash one verifier input while retaining any descriptor whose close fails. */
export function hashVerifierFile(path, resources) {
  return hashStableFile(path, {
    retainFailedClose(owner) {
      resources.retain({ kind: "file-handle", resource: path, handle: owner });
    },
  });
}
