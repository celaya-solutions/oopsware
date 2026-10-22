import { createServer, type Socket } from "node:net";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { CdpConnection } from "../../../src/browser/CdpConnection.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { inspectWebPageInputSchema } from "../../../src/domain/browserObservation.js";
import { WEB_RUNTIME_LIMITS } from "../../../src/domain/webRuntime.js";
import { V8InspectorProvider } from "../../../src/inspector/V8InspectorProvider.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";
import { startFakeV8Inspector } from "../../fixtures/inspector/fakeV8Inspector.js";

// Keep real socket scheduling; expire only a timer whose owning phase is ready.
beforeEach(() => {
  vi.spyOn(globalThis, "setTimeout");
  vi.spyOn(globalThis, "clearTimeout");
});

afterEach(() => vi.restoreAllMocks());

const activeTimers = (milliseconds: number) => {
  const scheduled = vi.mocked(globalThis.setTimeout);
  const cleared = vi.mocked(globalThis.clearTimeout);
  return scheduled.mock.calls.flatMap(([callback, delay], index) => {
    const result = scheduled.mock.results[index];
    if (
      delay !== milliseconds ||
      result?.type !== "return" ||
      cleared.mock.calls.some(([timer]) => timer === result.value)
    )
      return [];
    return [{ callback, timer: result.value }];
  });
};

const expireTimer = (milliseconds: number): void => {
  const timers = activeTimers(milliseconds);
  expect(timers).toHaveLength(1);
  const timer = timers[0];
  if (timer === undefined) throw new Error("Expected one active timer");
  try {
    timer.callback();
    if (milliseconds === WEB_RUNTIME_LIMITS.commandTimeoutMs)
      expect(globalThis.clearTimeout).toHaveBeenCalledWith(timer.timer);
  } finally {
    // The observation callback resolves naturally without cancelling its timer.
    clearTimeout(timer.timer);
  }
};

it("bounds a stalled WebSocket handshake and releases its socket", async () => {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.resume();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Expected a TCP address");
  try {
    const rejection = expect(
      CdpConnection.connect(
        `ws://127.0.0.1:${String(address.port)}/target`,
        "inspect_web_page",
        AbortSignal.timeout(10_000),
      ),
    ).rejects.toMatchObject({ reason: "timeout" });
    await vi.waitFor(() => expect(sockets.size).toBe(1), { timeout: 5_000 });
    expireTimer(WEB_RUNTIME_LIMITS.commandTimeoutMs);
    await rejection;
    await vi.waitFor(() => expect(sockets.size).toBe(0));
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it.each(["Target.attachToTarget", "Page.enable", "Runtime.enable"])(
  "times out %s after HTTP discovery and closes the target session",
  async (hangOnMethod) => {
    const browser = await startFakeCdpBrowser({ hangOnMethod });
    try {
      const pending = new CdpBrowserProvider().inspectPage(
        inspectWebPageInputSchema.parse({
          cdp_endpoint: browser.endpoint,
          target_id: "allowed-page",
          observation_ms: 0,
        }),
        { signal: AbortSignal.timeout(10_000) },
      );
      await vi.waitFor(
        () =>
          expect(browser.commands.map(({ method }) => method)).toContain(
            hangOnMethod,
          ),
        { timeout: 5_000 },
      );
      expireTimer(WEB_RUNTIME_LIMITS.commandTimeoutMs);
      const result = await pending;
      if (result.ok) throw new Error("Expected a target command timeout");
      expect(projectAnalysisError(result.error)).toMatchObject({
        code: "provider_timeout",
        category: "timeout",
      });
      expect(browser.commands.map(({ method }) => method)).toContain(
        hangOnMethod,
      );
      await vi.waitFor(() => expect(browser.activeConnectionCount()).toBe(0));
    } finally {
      await browser.close();
    }
  },
);

it("ignores a late timed-out reply and keeps following commands correlated", async () => {
  const browser = await startFakeCdpBrowser({ hangOnMethod: "Page.enable" });
  const connection = await CdpConnection.connect(
    browser.browserWebSocketUrl,
    "inspect_web_page",
  );
  try {
    const rejection = expect(
      connection.send(
        "Page.enable",
        {},
        undefined,
        AbortSignal.timeout(10_000),
      ),
    ).rejects.toMatchObject({ reason: "timeout" });
    await vi.waitFor(() => expect(browser.commands).toHaveLength(1), {
      timeout: 5_000,
    });
    expireTimer(WEB_RUNTIME_LIMITS.commandTimeoutMs);
    await rejection;
    const command = browser.commands[0];
    if (command === undefined)
      throw new Error("Expected the timed-out command");
    browser.emitRawMessage(JSON.stringify({ id: command.id, result: {} }));
    await expect(connection.send("Runtime.enable")).resolves.toEqual({});
  } finally {
    await connection.close();
    await browser.close();
  }
});

it.each(["success", "rejection", "abort", "disconnect"])(
  "releases handshake and command timers on %s",
  async (outcome) => {
    const cleared = vi.mocked(globalThis.clearTimeout);
    const browser = await startFakeCdpBrowser({
      ...(outcome === "abort" || outcome === "success"
        ? { hangOnMethod: "Runtime.enable" }
        : {}),
      ...(outcome === "disconnect" ? { closeOnMethod: "Runtime.enable" } : {}),
    });
    const controller = new AbortController();
    const removeAbort = vi.spyOn(controller.signal, "removeEventListener");
    const connection = await CdpConnection.connect(
      browser.browserWebSocketUrl,
      "inspect_web_page",
      controller.signal,
    );
    try {
      const pending = connection.send(
        outcome === "rejection" ? "Fixture.unmodeledMethod" : "Runtime.enable",
        {},
        undefined,
        controller.signal,
      );
      const assertion =
        outcome === "success"
          ? expect(pending).resolves.toEqual({})
          : expect(pending).rejects.toMatchObject({
              _tag:
                outcome === "abort"
                  ? "AnalysisCancelledError"
                  : "BrowserObservationError",
            });
      if (outcome === "success") {
        await vi.waitFor(() => expect(browser.commands).toHaveLength(1), {
          timeout: 5_000,
        });
        // A healthy reply may take longer than the former 100 ms test budget.
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
        const command = browser.commands[0];
        if (command === undefined)
          throw new Error("Expected a pending command");
        browser.emitRawMessage(JSON.stringify({ id: command.id, result: {} }));
      }
      if (outcome === "abort") controller.abort();
      await assertion;
      const scheduled = vi.mocked(globalThis.setTimeout);
      const deadlines = scheduled.mock.calls.flatMap((call, index) =>
        call[1] === WEB_RUNTIME_LIMITS.commandTimeoutMs
          ? [scheduled.mock.results[index]?.value]
          : [],
      );
      expect(deadlines).toHaveLength(2);
      for (const timer of deadlines)
        expect(cleared).toHaveBeenCalledWith(timer);
      expect(removeAbort).toHaveBeenCalledTimes(2);
    } finally {
      await connection.close();
      await browser.close();
    }
  },
);

it.each(["Runtime.enable", "Debugger.enable"])(
  "times out Inspector %s and preserves observations received before expiry",
  async (hangOnMethod) => {
    const inspector = await startFakeV8Inspector({
      targetUrl: "https://fixture.example/app.js",
      hangOnMethod,
    });
    try {
      const pending = new V8InspectorProvider().observe(
        {
          inspector_endpoint: inspector.endpoint,
          target_id: inspector.targetId,
          observation_ms: 0,
        },
        { signal: AbortSignal.timeout(10_000) },
      );
      await vi.waitFor(
        () =>
          expect(inspector.commands.map(({ method }) => method)).toContain(
            hangOnMethod,
          ),
        { timeout: 5_000 },
      );
      expireTimer(WEB_RUNTIME_LIMITS.commandTimeoutMs);
      const result = await pending;
      if (result.ok) throw new Error("Expected an Inspector command timeout");
      expect(projectAnalysisError(result.error)).toMatchObject({
        code: "provider_timeout",
        category: "timeout",
      });
      expect(result.error.partialObservation).toMatchObject({
        capture: {
          events_observed: hangOnMethod === "Debugger.enable" ? 1 : 0,
        },
      });
    } finally {
      await inspector.close();
    }
  },
);

it("keeps the chosen observation window independent of command deadlines", async () => {
  const browser = await startFakeCdpBrowser();
  const observationMs = WEB_RUNTIME_LIMITS.commandTimeoutMs + 250;
  try {
    const pending = new CdpBrowserProvider().inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        target_id: "allowed-page",
        observation_ms: observationMs,
      }),
    );
    await vi.waitFor(
      () => expect(activeTimers(observationMs)).toHaveLength(1),
      {
        timeout: 5_000,
      },
    );
    expect(activeTimers(WEB_RUNTIME_LIMITS.commandTimeoutMs)).toHaveLength(0);
    expireTimer(observationMs);
    const result = await pending;
    expect(result.ok).toBe(true);
  } finally {
    await browser.close();
  }
});
