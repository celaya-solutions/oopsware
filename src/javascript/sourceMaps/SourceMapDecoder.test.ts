import { access } from "node:fs/promises";
import { expect, it } from "vitest";
import { SourceMapDecoder } from "./SourceMapDecoder.js";
import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";
import {
  SourceMapCleanupFailure,
  type SourceMapDecoderDependencies,
} from "./SourceMapCommand.js";
import { PrivateRuntimeRoot } from "../../process/PrivateRuntimeRoot.js";
import { spawnOwnedProviderProcess } from "../../process/ProviderProcess.js";
import {
  webSourceLocationArgs,
  webSourceLocationFixture,
} from "../../../tests/fixtures/webSourceLocation.js";

const fixture = webSourceLocationFixture();
const input = {
  text: fixture.sourceMap.text,
  url: fixture.sourceMap.url,
  path: fixture.sourceMap.file.path,
  position: webSourceLocationArgs.generated_position,
};

it("preserves the exact caller reason before source-map admission", async () => {
  const reason = { caller: "pre-aborted source-map decode" };
  const controller = new AbortController();
  controller.abort(reason);
  const response = await new SourceMapDecoder().trace(input, {
    signal: controller.signal,
  });
  expect(response.ok).toBe(false);
  if (response.ok) throw new Error("expected cancellation");
  expect(response.error).toBeInstanceOf(AnalysisCancelledError);
  expect(response.error.cause).toBe(reason);
});

it("retains failed cleanup ownership and retries it before another decode", async () => {
  const root = await PrivateRuntimeRoot.create({
    prefix: "rea-source-map-cleanup-retry-test-",
  });
  let cleanupAttempts = 0;
  const dependencies: SourceMapDecoderDependencies = {
    prepareOwnership: async () => {},
    createRuntime: async () => ({
      path: root.path,
      close: async () => {
        cleanupAttempts += 1;
        if (cleanupAttempts === 1)
          throw new Error("injected root cleanup failure");
        await root.close();
      },
    }),
    launcher: async (options) =>
      spawnOwnedProviderProcess({
        ...options,
        arguments: [
          "-e",
          'process.stderr.write("physical exit 7"); process.exit(7)',
        ],
      }),
  };
  const decoder = new SourceMapDecoder(dependencies);
  try {
    const failed = await decoder.trace(input);
    expect(failed.ok).toBe(false);
    if (failed.ok)
      throw new Error("expected physical failure with cleanup failure");
    expect(failed.error).toBeInstanceOf(SourceMapCleanupFailure);
    if (!(failed.error instanceof SourceMapCleanupFailure))
      throw new Error("expected source-map cleanup ownership");
    expect(failed.error.cleanupOwner).toBeDefined();
    expect(failed.error.diagnostics).toMatchObject({
      cleanup_failures: ["injected root cleanup failure"],
    });
    expect(failed.error.diagnostics).toMatchObject({
      previous_error: expect.stringContaining(
        "source-map-decoder adapter failed",
      ),
    });
    await expect(access(root.path)).resolves.toBeUndefined();

    const invalidInput = { ...input, text: null } as unknown as typeof input;
    const retried = await decoder.trace(invalidInput);
    expect(retried.ok).toBe(false);
    if (retried.ok)
      throw new Error("expected invalid input after cleanup retry");
    expect(retried.error._tag).toBe("AnalysisInputError");
    expect(cleanupAttempts).toBe(2);
    await expect(access(root.path)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await decoder.close();
  }
});
