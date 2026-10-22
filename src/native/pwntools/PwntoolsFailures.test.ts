import { expect, it } from "vitest";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import { OwnedCommandFailure } from "../../process/OwnedCommand.js";
import { pwntoolsDecoderFailure } from "./PwntoolsFailures.js";

it.each([undefined, null, false, 0, "stop", { stop: true }, new Error("stop")])(
  "preserves opaque cancellation from command and artifact owners: %s",
  (reason) => {
    for (const failure of [
      new OwnedCommandFailure("cancelled", "cancelled", null, null, {
        cause: new Error("transport wrapper"),
        cancellation: { reason },
      }),
      new ArtifactReaderFailure("cancelled", "cancelled", {
        cause: new Error("file wrapper"),
        cancellation: { reason },
      }),
    ]) {
      const result = pwntoolsDecoderFailure(failure, "decoder", "/selected");
      expect(result._tag).toBe("AnalysisCancelledError");
      expect(result.cause).toBe(reason);
      expect(Object.hasOwn(result, "cause")).toBe(true);
    }
  },
);

it("retains legacy owner causes without guessing cancellation from error text", () => {
  const reason = { stop: "legacy" };
  const result = pwntoolsDecoderFailure(
    new OwnedCommandFailure("cancelled", "cancelled", null, null, {
      cause: reason,
    }),
    "decoder",
    "/selected",
  );
  expect(result.cause).toBe(reason);
  const physical = Object.assign(new Error("physical failure"), {
    name: "AbortError",
  });
  expect(pwntoolsDecoderFailure(physical, "decoder", "/selected")._tag).toBe(
    "ProviderAdapterError",
  );
});
