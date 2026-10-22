import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { observeWebSessionInputSchema } from "../../../src/domain/browserSession.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";
import { trackBrowser } from "./cdpBrowserProvider.support.js";

afterEach(() => vi.restoreAllMocks());

it.each([2_147_483_648, 3_000_000_000])(
  "keeps a long observation pending with a representable timer: %i",
  async (duration) => {
    const browser = await startFakeCdpBrowser();
    trackBrowser(browser);
    const controller = new AbortController();
    const reason = { stop: "long observation" };
    const provider = new CdpBrowserProvider();
    const nativeTimeout = globalThis.setTimeout;
    let scheduled!: (delay: number) => void;
    const scheduledDelay = new Promise<number>((resolve) => {
      scheduled = resolve;
    });
    vi.spyOn(globalThis, "setTimeout").mockImplementation(
      (callback, delay, ...args) => {
        if (delay === duration || delay === 2_147_483_647) scheduled(delay);
        return nativeTimeout(callback, delay, ...args);
      },
    );
    const pending = provider.observeSession(
      observeWebSessionInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        observation_ms: duration,
      }),
      { signal: controller.signal },
    );
    const observedDelay = await scheduledDelay;
    controller.abort(reason);
    const result = await pending;
    await provider.close();
    expect(observedDelay).toBe(2_147_483_647);
    if (result.ok) throw new Error("Long window completed before cancellation");
    expect(result.error).toMatchObject({ _tag: "AnalysisCancelledError" });
    expect(result.error.cause).toBe(reason);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    await expect.poll(() => browser.activeConnectionCount()).toBe(0);
  },
);

it("does not retain a caller listener when the target ends before the wait starts", async () => {
  const browser = await startFakeCdpBrowser({
    eventsBeforeReply: ["Page.setLifecycleEventsEnabled"],
    commandEvents: ({ method, sessionId }) =>
      method === "Page.setLifecycleEventsEnabled"
        ? [
            {
              method: "Page.frameNavigated",
              ...(sessionId === undefined ? {} : { sessionId }),
              params: {
                frame: { id: "frame-main", url: "https://outside.test/" },
              },
            },
          ]
        : undefined,
  });
  trackBrowser(browser);
  const controller = new AbortController();
  const provider = new CdpBrowserProvider();
  const result = await provider.observeSession(
    observeWebSessionInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      allowed_origins: [browser.allowedOrigin],
      target_id: "allowed-page",
      observation_ms: 3_000_000_000,
    }),
    { signal: controller.signal },
  );
  if (!result.ok) throw result.error;
  expect(result.value.window).toMatchObject({
    requested_ms: 3_000_000_000,
    end_reason: "target_left_scope",
  });
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  await expect.poll(() => browser.activeConnectionCount()).toBe(0);
  await provider.close();
});

it("preserves cancellation at the armed handshake without starting a window timer", async () => {
  const browser = await startFakeCdpBrowser();
  trackBrowser(browser);
  const controller = new AbortController();
  const reason = { stop: "at armed handshake" };
  const provider = new CdpBrowserProvider();
  const timers = vi.spyOn(globalThis, "setTimeout");
  const result = await provider.observeSession(
    observeWebSessionInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      allowed_origins: [browser.allowedOrigin],
      target_id: "allowed-page",
      observation_ms: 3_000_000_000,
    }),
    {
      signal: controller.signal,
      progress: {
        async report(update) {
          if (update.phase === "browser_observation" && update.completed === 1)
            controller.abort(reason);
        },
      },
    },
  );
  if (result.ok) throw new Error("Expected armed cancellation");
  expect(result.error.cause).toBe(reason);
  expect(
    timers.mock.calls.filter(
      ([, delay]) => delay === 3_000_000_000 || delay === 2_147_483_647,
    ),
  ).toHaveLength(0);
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  await expect.poll(() => browser.activeConnectionCount()).toBe(0);
  await provider.close();
});

describe("CdpBrowserProvider navigation timeline", () => {
  it("returns every event beyond the former default collection cap", async () => {
    const additionalEvents = 2_001;
    const browser = await startFakeCdpBrowser({
      pageScopedVersionWebSocket: true,
      omitTargetWebSocket: true,
      sessionTimeline: "same_origin",
      sessionTimelineEventCount: additionalEvents,
    });
    trackBrowser(browser);

    const result = await new CdpBrowserProvider().observeSession(
      observeWebSessionInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        observation_ms: 1,
      }),
    );

    if (!result.ok) throw result.error;
    expect(result.value.timeline).toHaveLength(additionalEvents + 6);
    expect(result.value.completeness.truncated_sections).not.toContain(
      "timeline",
    );
  });
});
