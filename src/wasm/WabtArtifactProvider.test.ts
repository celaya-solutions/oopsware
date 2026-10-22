import { createHash } from "node:crypto";
import { access, chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { WabtArtifactProvider } from "./WabtArtifactProvider.js";
import { wasmArtifactSchema } from "../domain/wasm/wasmArtifact.js";
import { PrivateRuntimeRoot } from "../process/PrivateRuntimeRoot.js";
import { PrivateRuntimeRootUnavailableError } from "../process/PrivateRuntimeRootUnavailableError.js";
import { spawnOwnedProviderProcess } from "../process/ProviderProcess.js";
import { OwnedCommandFailure } from "../process/OwnedCommand.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { WABT_LIMITS } from "./WabtRelease.js";
import { wabtFailure } from "./WabtFailures.js";

const fileCloseFailure = vi.hoisted(() => ({
  selectedPath: "",
  attempts: 0,
  failFirst: false,
  failRead: undefined as (() => Error) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (String(args[0]) !== fileCloseFailure.selectedPath) return handle;
      const close = handle.close.bind(handle);
      const failure = fileCloseFailure.failRead;
      if (failure !== undefined) {
        fileCloseFailure.failRead = undefined;
        vi.spyOn(handle, "stat").mockImplementationOnce(() => {
          throw failure();
        });
      }
      handle.close = async () => {
        fileCloseFailure.attempts += 1;
        if (fileCloseFailure.failFirst) {
          fileCloseFailure.failFirst = false;
          throw new Error("injected WABT input close failure");
        }
        return close();
      };
      return handle;
    },
  };
});

const outcomeModes = [
  "success",
  "invalid",
  "invalid-close",
  "invalid-close-failure",
  "snapshot-close-failure",
  "snapshot-read-failure-late-abort",
  "malformed",
  "timeout",
  "cancelled",
  "cancelled-close",
  "cancelled-close-failure",
  "cleanup",
  "changed-snapshot",
  "malformed-wat",
  "wat-warning",
] as const;
type OutcomeMode = (typeof outcomeModes)[number];

const failureTags: Readonly<Record<Exclude<OutcomeMode, "success">, string>> = {
  invalid: "AnalysisInputError",
  "invalid-close": "AnalysisInputError",
  "invalid-close-failure": "ProviderAdapterError",
  "snapshot-close-failure": "AnalysisOutputError",
  "snapshot-read-failure-late-abort": "AnalysisOutputError",
  timeout: "AnalysisTimeoutError",
  cancelled: "AnalysisCancelledError",
  "cancelled-close": "AnalysisCancelledError",
  "cancelled-close-failure": "ProviderAdapterError",
  "changed-snapshot": "AnalysisArtifactChangedError",
  cleanup: "ProviderAdapterError",
  malformed: "AnalysisOutputError",
  "malformed-wat": "AnalysisOutputError",
  "wat-warning": "AnalysisOutputError",
};

const assertCleanupRecovery = async (options: {
  readonly provider: WabtArtifactProvider;
  readonly result: Awaited<ReturnType<WabtArtifactProvider["inspect"]>>;
  readonly path: string;
  readonly runtimePath: string;
  readonly cleanupAttempts: () => number;
  readonly runtimeCreations: () => number;
}): Promise<void> => {
  expect(options.result).toMatchObject({
    error: {
      cleanupIncomplete: true,
      cleanupResources: [options.runtimePath],
      partialObservation: { normalized_result: { validation: "valid" } },
    },
  });
  await expect(access(options.runtimePath)).resolves.toBeUndefined();
  const blocked = await options.provider.inspect({
    path: options.path,
    glue_paths: [],
    candidate_paths: [],
  });
  expect(blocked).toMatchObject({
    ok: false,
    error: {
      cleanupIncomplete: true,
      cleanupResources: [options.runtimePath],
    },
  });
  expect(options.cleanupAttempts()).toBe(2);
  expect(options.runtimeCreations()).toBe(1);
  await options.provider.close();
  expect(options.cleanupAttempts()).toBe(3);
  await expect(access(options.runtimePath)).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(options.result).toMatchObject({
    error: { cleanupIncomplete: false, cleanupResources: [] },
  });
  expect(blocked).toMatchObject({
    error: { cleanupIncomplete: false, cleanupResources: [] },
  });
};

const assertCancellationDuringRootRelease = async (options: {
  readonly mode: "cancelled-close" | "cancelled-close-failure";
  readonly result: Awaited<ReturnType<WabtArtifactProvider["inspect"]>>;
  readonly provider: WabtArtifactProvider;
  readonly runtimePath: string;
  readonly cleanupAttempts: () => number;
  readonly cancellationReason: unknown;
}): Promise<void> => {
  if (options.mode === "cancelled-close") {
    expect(options.result).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisCancelledError",
        partialObservation: { normalized_result: { validation: "valid" } },
        cleanupIncomplete: false,
      },
    });
    if (!options.result.ok)
      expect(options.result.error.cause).toBe(options.cancellationReason);
    return;
  }
  expect(options.result).toMatchObject({
    ok: false,
    error: {
      _tag: "ProviderAdapterError",
      cleanupIncomplete: true,
      cleanupResources: [options.runtimePath],
      partialObservation: { normalized_result: { validation: "valid" } },
      diagnostics: { primary_error: { code: "cancelled" } },
    },
  });
  expect(options.cleanupAttempts()).toBe(1);
  if (!options.result.ok)
    expect(options.result.error.cleanupPrimary?.cause).toBe(
      options.cancellationReason,
    );
  await expect(access(options.runtimePath)).resolves.toBeUndefined();
  await options.provider.close();
  expect(options.cleanupAttempts()).toBe(2);
  expect(options.result).toMatchObject({
    error: { cleanupIncomplete: false, cleanupResources: [] },
  });
};

const createWabtArtifactFixture = async () => {
  const selectedRoot = await createTestTempDirectory("rea-wabt-seam-");
  const path = join(selectedRoot, "selected.wasm");
  const bytes = Buffer.alloc(76, 1);
  await writeFile(path, bytes);
  for (const tool of ["wasm-validate", "wasm-objdump", "wasm2wat"])
    await writeFile(
      join(selectedRoot, tool + (process.platform === "win32" ? ".exe" : "")),
      "source-owned executable seam",
      { mode: 0o700 },
    );
  const dump = await readFile(
    new URL("../../tests/fixtures/wasm/objdump.txt", import.meta.url),
    "utf8",
  );
  return { selectedRoot, path, bytes, dump };
};

const assertModeOutcome = (
  mode: OutcomeMode,
  result: Awaited<ReturnType<WabtArtifactProvider["inspect"]>>,
  path: string,
): void => {
  if (mode === "success")
    expect(result).toMatchObject({
      ok: true,
      value: {
        result: {
          artifact: { path, bytes: 76 },
          validation: "valid",
          runtime_execution: "not-performed",
        },
      },
    });
  else
    expect(result).toMatchObject({
      ok: false,
      error: { _tag: failureTags[mode] },
    });
  if (mode === "invalid" || mode === "invalid-close")
    expect(result).toMatchObject({
      error: { capturedOutput: { stderr: "module.wasm: invalid bytes\n" } },
    });
  if (mode === "malformed-wat" || mode === "wat-warning")
    expect(result).toMatchObject({
      error: {
        capturedOutput: {
          stdout:
            mode === "malformed-wat"
              ? "unexpected decoder output\n"
              : '(module (@custom "test" "payload"))\n',
          stderr: mode === "wat-warning" ? "decoder warning\n" : "",
        },
      },
    });
};

it("returns actionable unavailable without creating a workspace when tools are absent", async () => {
  const provider = new WabtArtifactProvider({}, undefined, () => {
    throw new Error("Must not allocate");
  });
  expect(
    await provider.inspect({
      path: "/module.wasm",
      glue_paths: [],
      candidate_paths: [],
    }),
  ).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisCapabilityUnavailableError",
      userMessage: expect.stringContaining("REA_WABT_BIN_DIRECTORY"),
    },
  });
});

it("retries a retained input descriptor before admitting the next WABT operation", async () => {
  const root = await createTestTempDirectory("rea-wabt-read-cleanup-");
  const path = join(root, "selected.wasm");
  await writeFile(path, Buffer.alloc(76, 1));
  for (const tool of ["wasm-validate", "wasm-objdump", "wasm2wat"])
    await writeFile(join(root, tool), "source-owned executable seam", {
      mode: 0o700,
    });
  const dump = await readFile(
    new URL("../../tests/fixtures/wasm/objdump.txt", import.meta.url),
    "utf8",
  );
  const provider = new WabtArtifactProvider(
    { REA_WABT_BIN_DIRECTORY: root },
    async (input) => {
      const version = input.arguments[0] === "--version";
      const stdout = version
        ? "1.0.42\n"
        : input.command.includes("wasm-objdump")
          ? dump
          : input.command.includes("wasm2wat")
            ? '(module (@custom "test" "payload"))\n'
            : "";
      const launched = await spawnOwnedProviderProcess({
        ...input,
        command: process.execPath,
        arguments: [
          "-e",
          `process.stdout.write(${JSON.stringify(stdout)}); process.exit(0);`,
        ],
        expectedCommand: null,
      });
      return launched;
    },
  );
  fileCloseFailure.selectedPath = path;
  fileCloseFailure.attempts = 0;
  fileCloseFailure.failFirst = true;
  try {
    const first = await provider.inspect({
      path,
      candidate_paths: [],
      glue_paths: [],
    });
    expect(first).toMatchObject({
      ok: false,
      error: {
        cleanupIncomplete: true,
        cleanupResources: [path],
        cause: { message: "injected WABT input close failure" },
      },
    });
    expect(fileCloseFailure.attempts).toBe(1);

    const retried = await provider.inspect({
      path,
      candidate_paths: [],
      glue_paths: [],
    });
    expect(retried.ok).toBe(true);
    expect(fileCloseFailure.attempts).toBeGreaterThan(1);
    expect(first).toMatchObject({
      error: { cleanupIncomplete: false, cleanupResources: [] },
    });

    fileCloseFailure.failFirst = true;
    const closeRetry = await provider.inspect({
      path,
      candidate_paths: [],
      glue_paths: [],
    });
    expect(closeRetry).toMatchObject({
      ok: false,
      error: { cleanupIncomplete: true, cleanupResources: [path] },
    });
    const beforeClose = fileCloseFailure.attempts;
    await provider.close();
    expect(fileCloseFailure.attempts).toBeGreaterThan(beforeClose);
    expect(closeRetry).toMatchObject({
      error: { cleanupIncomplete: false, cleanupResources: [] },
    });
  } finally {
    fileCloseFailure.selectedPath = "";
    fileCloseFailure.failFirst = false;
    await provider.close();
  }
});

it.each([false, true])(
  "reports an unavailable private runtime root with retryable=%s without a misleading WABT remediation",
  async (retryable) => {
    const toolRoot = await createTestTempDirectory("rea-wabt-tool-root-");
    for (const tool of ["wasm-validate", "wasm-objdump", "wasm2wat"])
      await writeFile(
        join(toolRoot, tool + (process.platform === "win32" ? ".exe" : "")),
        "source-owned executable seam",
        { mode: 0o700 },
      );
    const provider = new WabtArtifactProvider(
      { REA_WABT_BIN_DIRECTORY: toolRoot },
      undefined,
      () => {
        throw new PrivateRuntimeRootUnavailableError(
          "REA Windows native controls are unavailable: probe failure",
          { retryable },
        );
      },
    );
    const result = await provider.inspect({
      path: "/module.wasm",
      glue_paths: [],
      candidate_paths: [],
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisCapabilityUnavailableError",
        retryable,
        userMessage: undefined,
        message: expect.stringContaining(
          "REA Windows native controls are unavailable",
        ),
      },
    });
    if (result.ok)
      throw new Error("Unavailable runtime must refuse inspection");
    expect(projectAnalysisError(result.error)).toMatchObject({
      code: "capability_unavailable",
      retryable,
      category: retryable ? "unavailable" : "unsupported_provider",
    });
  },
);
const assertGlueObservations = (
  value: unknown,
  inputs: readonly {
    readonly path: string;
    readonly source: string;
    readonly line: number;
    readonly column: number;
  }[],
  selectedPath: string,
): void => {
  const glue = wasmArtifactSchema.parse(value).glue;
  expect(glue).toHaveLength(inputs.length);
  for (const [index, { path, source, line, column }] of inputs.entries()) {
    expect(glue[index]).toMatchObject({
      artifact: {
        path,
        sha256: createHash("sha256").update(source).digest("hex"),
        bytes: Buffer.byteLength(source),
      },
      parse_status: "complete",
      references: [
        {
          value: "./selected.wasm",
          line,
          column,
          candidate_paths: [selectedPath],
          association: "local-path-candidate",
          evidence_kind: "static-literal",
        },
      ],
    });
  }
};

const launchWabtOutcome = async (
  input: Parameters<typeof spawnOwnedProviderProcess>[0],
  mode: OutcomeMode,
  fixture: { bytes: Buffer; dump: string; controller: AbortController },
) => {
  const { bytes, dump, controller } = fixture;
  const version = input.arguments[0] === "--version";
  if (!version) {
    expect(await readFile(join(input.cwd ?? "", "module.wasm"))).toEqual(bytes);
    if (mode === "changed-snapshot") {
      const snapshot = join(input.cwd ?? "", "module.wasm");
      await chmod(snapshot, 0o600);
      await writeFile(snapshot, Buffer.alloc(76, 2));
    }
    if (mode === "timeout")
      throw new OwnedCommandFailure("timeout", "Source-owned deadline seam");
  }
  const stdout = version
    ? "1.0.42\n"
    : input.command.includes("objdump")
      ? mode === "malformed"
        ? "unexpected producer output"
        : dump
      : input.command.includes("wasm2wat")
        ? mode === "malformed-wat"
          ? "unexpected decoder output\n"
          : '(module (@custom "test" "payload"))\n'
        : "";
  const invalid =
    !version &&
    (mode === "invalid" ||
      mode === "invalid-close" ||
      mode === "invalid-close-failure");
  const stderr = invalid
    ? "module.wasm: invalid bytes\n"
    : !version && input.command.includes("wasm2wat") && mode === "wat-warning"
      ? "decoder warning\n"
      : "";
  const script =
    !version && mode === "cancelled"
      ? "setInterval(() => undefined, 1000)"
      : `process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)}); process.exit(${invalid ? 1 : 0});`;
  const launched = await spawnOwnedProviderProcess({
    ...input,
    command: process.execPath,
    arguments: ["-e", script],
    expectedCommand: null,
  });
  if (!version && mode === "cancelled") {
    setImmediate(() => controller.abort());
  }
  return launched;
};

const glueSourcesForOutcome = (mode: OutcomeMode) => {
  const literal = 'fetch("./selected.wasm");';
  return mode === "success"
    ? [
        { source: literal, line: 1, column: 6 },
        { source: `\uFEFF${literal}`, line: 1, column: 7 },
        { source: `\uFEFF\n${literal}`, line: 2, column: 6 },
        { source: `#!/usr/bin/env node\n${literal}`, line: 2, column: 6 },
        {
          source: `\uFEFF#!/usr/bin/env node\n${literal}`,
          line: 2,
          column: 6,
        },
        {
          source: String.raw`"./selected\u002ewasm";`,
          line: 1,
          column: 0,
        },
      ]
    : [];
};

const runOwnedArtifactOutcome = async (
  mode: OutcomeMode,
  cancellationReason: unknown = "authored finalization cancellation",
): Promise<void> => {
  const { selectedRoot, path, bytes, dump } = await createWabtArtifactFixture();
  let runtimePath = "";
  let runtimeCreations = 0;
  let acquiredPid: number | undefined;
  let cleanupAttempts = 0;
  const controller = new AbortController();
  const provider = new WabtArtifactProvider(
    { REA_WABT_BIN_DIRECTORY: selectedRoot },
    async (input) => {
      const launched = await launchWabtOutcome(input, mode, {
        bytes,
        dump,
        controller,
      });
      if (mode === "cancelled" && input.arguments[0] !== "--version")
        acquiredPid = launched.process.pid;
      return launched;
    },
    async () => {
      runtimeCreations += 1;
      const root = await PrivateRuntimeRoot.create({
        prefix: "rea-wabt-owned-test-",
      });
      runtimePath = root.path;
      if (
        mode === "snapshot-close-failure" ||
        mode === "snapshot-read-failure-late-abort"
      ) {
        fileCloseFailure.selectedPath = join(root.path, "module.wasm");
        fileCloseFailure.failFirst = true;
        fileCloseFailure.attempts = 0;
        if (mode === "snapshot-read-failure-late-abort")
          fileCloseFailure.failRead = () => {
            controller.abort("late abort after physical read failure");
            return Object.assign(new Error("Authored snapshot read failure"), {
              code: "EACCES",
            });
          };
      }
      return {
        path: root.path,
        close: async () => {
          if (mode === "cancelled-close-failure") {
            controller.abort(cancellationReason);
            if (++cleanupAttempts === 1)
              throw new Error("Source-owned cleanup uncertainty");
          }
          if (mode === "invalid-close-failure" && ++cleanupAttempts === 1)
            throw new Error("Source-owned cleanup uncertainty");
          if (mode === "cleanup" && ++cleanupAttempts <= 2)
            throw new Error("Source-owned cleanup uncertainty");
          await root.close();
          if (mode === "cancelled-close" || mode === "invalid-close")
            controller.abort(cancellationReason);
        },
      };
    },
  );
  const glueSources = glueSourcesForOutcome(mode);
  const glueInputs = glueSources.map(({ source, line, column }, index) => ({
    path: join(selectedRoot, `glue-${index}.js`),
    source,
    line,
    column,
  }));
  await Promise.all(
    glueInputs.map(({ path, source }) => writeFile(path, source)),
  );
  const result = await provider.inspect(
    {
      path,
      glue_paths: glueInputs.map(({ path }) => path),
      candidate_paths: [],
    },
    { signal: controller.signal },
  );
  if (mode === "success" && result.ok)
    assertGlueObservations(result.value.result, glueInputs, path);
  assertModeOutcome(mode, result, path);
  if (mode === "cleanup") {
    await assertCleanupRecovery({
      provider,
      result,
      path,
      runtimePath,
      cleanupAttempts: () => cleanupAttempts,
      runtimeCreations: () => runtimeCreations,
    });
  }
  if (mode === "cancelled-close" || mode === "cancelled-close-failure")
    await assertCancellationDuringRootRelease({
      mode,
      result,
      provider,
      runtimePath,
      cleanupAttempts: () => cleanupAttempts,
      cancellationReason: controller.signal.reason,
    });
  if (mode === "invalid-close-failure") {
    expect(result).toMatchObject({ error: { cleanupIncomplete: true } });
    await provider.close();
    expect(cleanupAttempts).toBe(2);
    if (!result.ok) {
      expect(result.error.cleanupIncomplete).toBe(false);
      expect(projectAnalysisError(result.error)).toMatchObject({
        code: "invalid_request",
        details: {
          captured_output: { stderr: "module.wasm: invalid bytes\n" },
          cleanup_history: expect.any(Object),
        },
      });
    }
  }
  if (
    mode === "snapshot-close-failure" ||
    mode === "snapshot-read-failure-late-abort"
  ) {
    try {
      expect(result).toMatchObject({
        error: {
          cleanupIncomplete: true,
          cleanupResources: [join(runtimePath, "module.wasm")],
        },
      });
    } finally {
      fileCloseFailure.failFirst = false;
      fileCloseFailure.failRead = undefined;
      await provider.close();
      fileCloseFailure.selectedPath = "";
    }
    expect(result).toMatchObject({
      error: { cleanupIncomplete: false, cleanupResources: [] },
    });
    if (!result.ok && mode === "snapshot-read-failure-late-abort")
      expect(result.error).toMatchObject({
        _tag: "AnalysisOutputError",
        reason: expect.stringContaining("Authored snapshot read failure"),
      });
  }
  await expect(access(runtimePath)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(path)).toEqual(bytes);
  if (acquiredPid !== undefined) {
    const pid = acquiredPid;
    expect(() => process.kill(pid, 0)).toThrow();
  }
};

it.each(outcomeModes)(
  "owns private artifact bytes and retains %s outcome",
  (mode) => runOwnedArtifactOutcome(mode),
);
it.each([null, { reason: "caller-owned object" }, undefined])(
  "preserves finalization abort reason %j through cleanup recovery",
  (reason) => runOwnedArtifactOutcome("cancelled-close-failure", reason),
);
const outputLimitFailure = ({
  stdout = "(module",
  stderr = "",
  cleanupFailure = null,
}: {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly cleanupFailure?: string | null;
} = {}) =>
  new OwnedCommandFailure(
    "output-limit",
    "Command diagnostic output exceeded its complete-output budget.",
    {
      diagnosticTruncated: true,
      // Observed sizes differ from retained sizes, as after a real overflow.
      stdout: {
        text: stdout,
        bytes: Buffer.byteLength(stdout),
        observedBytes: Buffer.byteLength(stdout) + 1000,
      },
      stderr: {
        text: stderr,
        bytes: Buffer.byteLength(stderr),
        observedBytes: Buffer.byteLength(stderr) + 1000,
      },
      exitCode: null,
      signal: "SIGKILL",
    },
    cleanupFailure,
    undefined,
    cleanupFailure === null ? [] : ["/owned/runtime"],
  );
it("reports WABT output beyond the budget as a resource constraint with a bounded excerpt", async () => {
  const selectedRoot = await createTestTempDirectory("rea-wabt-budget-");
  const path = join(selectedRoot, "selected.wasm");
  await writeFile(path, Buffer.alloc(76, 1));
  for (const tool of ["wasm-validate", "wasm-objdump", "wasm2wat"])
    await writeFile(
      join(selectedRoot, tool + (process.platform === "win32" ? ".exe" : "")),
      "source-owned executable seam",
      { mode: 0o700 },
    );
  const dump = await readFile(
    new URL("../../tests/fixtures/wasm/objdump.txt", import.meta.url),
    "utf8",
  );
  const provider = new WabtArtifactProvider(
    { REA_WABT_BIN_DIRECTORY: selectedRoot },
    (input) => {
      const version = input.arguments[0] === "--version";
      if (!version && input.command.includes("wasm2wat"))
        throw outputLimitFailure({ stdout: "(module" + "a".repeat(5000) });
      const script = version
        ? 'process.stdout.write("1.0.42\\n")'
        : input.command.includes("objdump")
          ? `process.stdout.write(${JSON.stringify(dump)})`
          : "";
      return spawnOwnedProviderProcess({
        ...input,
        command: process.execPath,
        arguments: ["-e", script],
        expectedCommand: null,
      });
    },
  );
  const result = await provider.inspect({
    path,
    glue_paths: [],
    candidate_paths: [],
  });
  if (result.ok) throw new Error("Expected the output budget to fail");
  expect(result.error).toMatchObject({
    _tag: "AnalysisResourceConstraintError",
    resource: "memory",
    reportedLimits: { max_output_bytes: WABT_LIMITS.outputBytes },
  });
  const projection = projectAnalysisError(result.error);
  expect(projection).toMatchObject({
    code: "resource_constraint",
    message: expect.stringContaining(
      `${String(WABT_LIMITS.outputBytes)}-byte output budget`,
    ),
    remediation: {
      action: expect.stringContaining("retrying with the same input"),
    },
  });
  expect(projection.details?.captured_output).toEqual({
    stdout: "(module" + "a".repeat(4089),
    stderr: "",
    truncated: true,
    stdout_bytes: 5007,
    stderr_bytes: 0,
    exit_code: null,
    signal: "SIGKILL",
  });
});
it("does not attribute wasm-objdump output to a wasm2wat launch failure", async () => {
  const selectedRoot = await createTestTempDirectory("rea-wabt-launch-");
  const path = join(selectedRoot, "selected.wasm");
  await writeFile(path, Buffer.alloc(76, 1));
  for (const tool of ["wasm-validate", "wasm-objdump", "wasm2wat"])
    await writeFile(
      join(selectedRoot, tool + (process.platform === "win32" ? ".exe" : "")),
      "source-owned executable seam",
      { mode: 0o700 },
    );
  const dump = await readFile(
    new URL("../../tests/fixtures/wasm/objdump.txt", import.meta.url),
    "utf8",
  );
  const provider = new WabtArtifactProvider(
    { REA_WABT_BIN_DIRECTORY: selectedRoot },
    (input) => {
      const version = input.arguments[0] === "--version";
      if (!version && input.command.includes("wasm2wat"))
        throw Object.assign(new Error("spawn E2BIG"), { code: "E2BIG" });
      const script = version
        ? 'process.stdout.write("1.0.42\\n")'
        : input.command.includes("objdump")
          ? `process.stdout.write(${JSON.stringify(dump)})`
          : "";
      return spawnOwnedProviderProcess({
        ...input,
        command: process.execPath,
        arguments: ["-e", script],
        expectedCommand: null,
      });
    },
  );
  const result = await provider.inspect({
    path,
    glue_paths: [],
    candidate_paths: [],
  });
  if (result.ok) throw new Error("Expected the wasm2wat launch to fail");
  expect(result.error.message).toContain("spawn E2BIG");
  expect(result.error.capturedOutput).toBeUndefined();
});

it("bounds an oversized stderr to an excerpt", () => {
  expect(
    projectAnalysisError(
      wabtFailure(
        outputLimitFailure({ stderr: "w".repeat(5000) }),
        "producer",
        "/module.wasm",
      ),
    ).details?.captured_output,
  ).toEqual({
    stdout: "(module",
    stderr: "w".repeat(4096),
    truncated: true,
    stdout_bytes: 7,
    stderr_bytes: 5000,
    exit_code: null,
    signal: "SIGKILL",
  });
});
it("cuts the excerpt on a code point boundary", () => {
  const failure = wabtFailure(
    outputLimitFailure({ stdout: "a".repeat(4095) + "\u{1F600}b" }),
    "producer",
    "/module.wasm",
  );
  expect(failure.capturedOutput?.stdout).toBe("a".repeat(4095));
});
it("bounds the excerpt when cleanup also fails after the output budget", () => {
  expect(
    projectAnalysisError(
      wabtFailure(
        outputLimitFailure({
          stderr: "w".repeat(5000),
          cleanupFailure: "Source-owned cleanup uncertainty",
        }),
        "producer",
        "/module.wasm",
      ),
    ),
  ).toMatchObject({
    code: "cleanup_incomplete",
    details: {
      diagnostics: {
        previous_error: {
          failure_kind: "output-limit",
          message: `WABT output exceeded the ${String(WABT_LIMITS.outputBytes)}-byte output budget`,
          max_output_bytes: WABT_LIMITS.outputBytes,
        },
        captured_output: { stdout: "(module", stderr: "w".repeat(4096) },
      },
    },
  });
});
it("does not blame the input when a version probe exceeds the budget", () => {
  expect(
    wabtFailure(outputLimitFailure(), "configuration", "/module.wasm"),
  ).toMatchObject({ _tag: "AnalysisOutputError" });
});
