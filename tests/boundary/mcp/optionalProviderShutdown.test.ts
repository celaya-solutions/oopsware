import { afterAll, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createBrowserObservationProvider } from "../../../src/composition/browserObservation.js";
import { createJavaScriptRuntimeObservationProvider } from "../../../src/composition/javascriptRuntimeObservation.js";
import { run } from "../../../src/main.js";
import { MCP_SHUTDOWN_FAILED } from "../../../src/main/messages.js";
import { createServer } from "../../../src/server/createServer.js";

mkdirSync(".cache", { recursive: true });
const root = mkdtempSync(resolve(".cache/optional-provider-shutdown-"));
const environment = {
  HOME: `${root}/home`,
  XDG_CONFIG_HOME: `${root}/config`,
  XDG_CACHE_HOME: `${root}/cache`,
  REA_LOG_LEVEL: "silent",
};
for (const path of [
  environment.HOME,
  environment.XDG_CONFIG_HOME,
  environment.XDG_CACHE_HOME,
])
  mkdirSync(path);
afterAll(() => rmSync(root, { recursive: true, force: true }));

it("retries failed process-owned optional cleanup without reclosing completed peers", async () => {
  const runtime = createJavaScriptRuntimeObservationProvider();
  const browser = createBrowserObservationProvider();
  const closeRuntime = runtime.close?.bind(runtime);
  const runtimeClose = vi.spyOn(runtime, "close");
  const browserClose = vi.spyOn(browser, "close");
  if (closeRuntime === undefined) throw new Error("Runtime close hook missing");
  runtimeClose.mockImplementation(async () => {
    if (runtimeClose.mock.calls.length === 1)
      throw new Error("controlled runtime cleanup failure");
    await closeRuntime();
  });

  const callerOwnedSession = createTestBinarySession(() => {
    throw new Error("No analysis target is allowed in this lifecycle test");
  });
  const callerOwnedServer = createServer(
    { kind: "session", session: callerOwnedSession },
    {
      environment,
      javascriptRuntimeObservation: runtime,
      optionalObservationProviderOwner: "caller",
    },
  );
  try {
    await callerOwnedServer.close();
    expect(runtimeClose).not.toHaveBeenCalled();
  } finally {
    const closed = await callerOwnedSession.close();
    if (!closed.ok) throw closed.error;
  }

  let shutdown: (() => void) | undefined;
  let servers = 0;
  let transportCloses = 0;
  let unregisterCalls = 0;
  const stderr: string[] = [];
  const exitCodes: number[] = [];
  const optionalProviderLoadFailures = {
    browserScenarioCapture: {
      providerId: "playwright-browser-scenario",
      reason: "controlled optional provider load failure",
    },
  };

  try {
    const result = await run({
      env: environment,
      loadOptionalProviders: async () => ({
        browserObservation: browser,
        javascriptRuntimeObservation: runtime,
        optionalProviderLoadFailures,
      }),
      createServer: (source, options) => {
        expect(options?.optionalObservationProviderOwner).toBe("caller");
        expect(options?.javascriptRuntimeObservation).toBe(runtime);
        expect(options?.optionalProviderLoadFailures).toBe(
          optionalProviderLoadFailures,
        );
        servers += 1;
        return createServer(source, options);
      },
      serve: (factory) => {
        const server = factory({ era: "legacy" });
        return {
          close: async () => {
            transportCloses += 1;
            await (await server).close();
          },
        };
      },
      registerShutdown: (handler) => {
        shutdown = handler;
        return () => {
          unregisterCalls += 1;
        };
      },
      writeStderr: (text) => stderr.push(text),
      setExitCode: (code) => exitCodes.push(code),
    });
    expect(result).toBe(0);
    if (shutdown === undefined)
      throw new Error("Shutdown hook was not installed");

    shutdown();
    await vi.waitFor(() => expect(runtimeClose).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(exitCodes).toEqual([1]));
    expect(browserClose).toHaveBeenCalledTimes(1);
    expect(transportCloses).toBe(1);
    expect(servers).toBe(1);
    expect(unregisterCalls).toBe(0);

    shutdown();
    await vi.waitFor(() => expect(unregisterCalls).toBe(1));

    expect(runtimeClose).toHaveBeenCalledTimes(2);
    expect(browserClose).toHaveBeenCalledTimes(1);
    expect(transportCloses).toBe(1);
    expect(exitCodes).toEqual([1]);
    expect(stderr).toContain(`${MCP_SHUTDOWN_FAILED}\n`);
  } finally {
    runtimeClose.mockRestore();
    browserClose.mockRestore();
    await runtime.close?.();
    await browser.close?.();
  }
});
