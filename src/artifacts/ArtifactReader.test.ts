import { expect, it } from "vitest";
import { ArtifactReaderFailure } from "./ArtifactReader.js";

it.each([
  undefined,
  null,
  "caller reason",
  new ArtifactReaderFailure("cancelled", "caller-provided error"),
])(
  "preserves explicit cancellation through repeated cleanup composition: %s",
  (reason) => {
    const primary = new ArtifactReaderFailure("cancelled", "Read cancelled", {
      cause: reason,
    });
    const first = ArtifactReaderFailure.withCleanup(primary, {
      reason: "first close failed",
      resources: ["first"],
    });
    const second = ArtifactReaderFailure.withCleanup(first, {
      reason: "second close failed",
      resources: ["second"],
    });
    expect(second.cancellation).toBe(primary.cancellation);
    expect(second.cancellation?.reason).toBe(reason);
    expect(second.cleanup?.resources).toEqual(["first", "second"]);
    expect(second.cause).toBe(first);
  },
);
