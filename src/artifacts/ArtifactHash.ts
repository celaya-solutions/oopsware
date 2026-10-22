import { createHash } from "node:crypto";
import type { Readable } from "node:stream";

import { ArtifactReaderFailure } from "./ArtifactReader.js";
import { streamChunkToBuffer } from "./StreamBytes.js";
import { FORMAT_SIGNATURE_PREFIX_BYTES } from "../domain/formatSignatures.js";
import {
  createArtifactClassificationProbe,
  type ArtifactClassificationEvidence,
} from "./ArtifactClassificationProbe.js";

/** Full stream digest and byte count with bounded classification evidence. */
export type HashResult = ArtifactClassificationEvidence & {
  readonly sha256: string;
  readonly bytes: number;
  readonly md5?: string;
};

/** Preserve the inventory cancellation reason at a stream boundary. */
export const abortIfNeeded = (signal?: AbortSignal): void => {
  if (signal?.aborted === true)
    throw new ArtifactReaderFailure(
      "cancelled",
      "Artifact inventory cancelled",
      { cause: signal.reason },
    );
};

/** Hash every stream byte and retain its bounded classification prefix. */
export const hashReadable = async (
  stream: Readable,
  signal?: AbortSignal,
  integrityAlgorithm?: "sha256" | "md5",
): Promise<HashResult> => {
  const hash = createHash("sha256");
  const md5 = integrityAlgorithm === "md5" ? createHash("md5") : undefined;
  const probe = createArtifactClassificationProbe();
  let bytes = 0;
  for await (const raw of stream) {
    abortIfNeeded(signal);
    const chunk = streamChunkToBuffer(raw);
    bytes += chunk.length;
    hash.update(chunk);
    md5?.update(chunk);
    probe.write(chunk);
  }
  abortIfNeeded(signal);
  return {
    sha256: hash.digest("hex"),
    ...(md5 === undefined ? {} : { md5: md5.digest("hex") }),
    bytes,
    ...probe.finish(bytes),
  };
};
