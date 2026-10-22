import { describe, expect, it, vi } from "vitest";
import type { BrowserContext, Page, Request, Response } from "playwright-core";

import { browserScenarioSchema } from "../domain/browserScenario.js";
import { BrowserScenarioSecrets } from "./BrowserScenarioSecrets.js";
import { PlaywrightScenarioEvents } from "./PlaywrightScenarioEvents.js";

describe("declared secrets in scenario events", () => {
  it("redacts encoded declared secrets from text evidence and fingerprints", () => {
    const listeners = new Map<string, (value: unknown) => void>();
    const socketListeners = new Map<string, (value: unknown) => void>();
    const page = {
      on: (name: string, listener: (value: unknown) => void) => {
        listeners.set(name, listener);
      },
    } as unknown as Page;
    const secret = "a/b&c\n d";
    const scenario = browserScenarioSchema.parse({
      browser: { mode: "launch", executable_path: "/opt/chromium" },
      start_url: { url: "https://app.example.test/" },
      actions: [
        { step_id: "wait", action: "wait_for_timeout", duration_ms: 1 },
      ],
      secrets: [
        { secret_id: "login_input", environment_variable: "REA_TEST_TOKEN" },
      ],
      capture: { events: ["console", "page-errors", "websockets"] },
    });
    const secrets = BrowserScenarioSecrets.resolve(scenario, {
      REA_TEST_TOKEN: secret,
    });
    if (secrets === undefined) throw new Error("Expected resolved secrets");
    const events = new PlaywrightScenarioEvents({
      page,
      enabled: new Set(["console", "page-errors", "websockets"]),
      secrets,
    });

    listeners.get("console")?.({
      type: () => "log",
      text: () => encodeURIComponent(secret),
      location: () => ({ url: "https://app.example.test/app.js" }),
    });
    const escapedSecret = JSON.stringify(secret).slice(1, -1);
    const error = new Error(`failure ${escapedSecret}`);
    error.stack = `failure ${escapedSecret}`;
    listeners.get("pageerror")?.(error);
    listeners.get("websocket")?.({
      url: () => "wss://app.example.test/socket",
      on: (name: string, listener: (value: unknown) => void) => {
        socketListeners.set(name, listener);
      },
    });
    const formEncodedSecret = new URLSearchParams([["value", secret]])
      .toString()
      .slice("value=".length);
    socketListeners.get("framesent")?.({ payload: formEncodedSecret });

    const items = events.result().items;
    expect(items).toMatchObject([
      { kind: "console", text: "[REDACTED:login_input]" },
      {
        kind: "page-error",
        message: "failure [REDACTED:login_input]",
        stack: "failure [REDACTED:login_input]",
      },
      { kind: "websocket-opened" },
      {
        kind: "websocket-frame-sent",
        payload_text: "[REDACTED:login_input]",
      },
    ]);
    expect(secrets.fingerprint(`stored ${encodeURIComponent(secret)}`)).toEqual(
      { value_state: "redacted-secret", value_sha256: null },
    );
  });
});

const captureNetworkBudgetFixture = async (
  maxTotalEventAllocationBytes?: number,
) => {
  const pageListeners = new Map<string, (value: unknown) => void>();
  const contextListeners = new Map<string, (value: unknown) => void>();
  const context = {
    on: (name: string, listener: (value: unknown) => void) =>
      contextListeners.set(name, listener),
    off: vi.fn(),
  } as unknown as BrowserContext;
  const page = {
    url: () => "http://127.0.0.1/fixture",
    context: () => context,
    on: (name: string, listener: (value: unknown) => void) =>
      pageListeners.set(name, listener),
    off: vi.fn(),
  } as unknown as Page;
  const scenario = browserScenarioSchema.parse({
    browser: { mode: "launch", executable_path: "/fixture/chrome" },
    start_url: { url: "http://127.0.0.1/fixture" },
    actions: [{ step_id: "ready", action: "wait_for_timeout", duration_ms: 1 }],
    capture: {
      events: ["network"],
      network: { response_body: true },
      ...(maxTotalEventAllocationBytes === undefined
        ? {}
        : {
            limits: {
              max_total_event_allocation_bytes: maxTotalEventAllocationBytes,
            },
          }),
    },
  });
  const secrets = BrowserScenarioSecrets.resolve(scenario, {});
  if (secrets === undefined) throw new Error("Expected resolved secrets");
  const redactBytes = vi.spyOn(secrets, "redactBytes");
  const capture = new PlaywrightScenarioEvents({
    page,
    context,
    ownsContext: true,
    enabled: new Set(["network"]),
    network: scenario.capture.network,
    limits: scenario.capture.limits,
    secrets,
  });
  for (let index = 0; index < 43; index += 1) {
    const post = index >= 40;
    const body = post
      ? Buffer.from('{"ok":true}')
      : Buffer.from("x".repeat(60_000));
    const request = {
      method: () => (post ? "POST" : "GET"),
      url: () => `http://127.0.0.1/${post ? "final" : "data"}/${String(index)}`,
      resourceType: () => "fetch",
      postDataBuffer: () => (post ? Buffer.from("{}") : null),
      redirectedFrom: () => null,
      failure: () => null,
      headers: () => ({ "content-type": "application/json" }),
      headersArray: async () => [
        { name: "content-type", value: "application/json" },
      ],
    } as unknown as Request;
    const response = {
      request: () => request,
      url: () => request.url(),
      status: () => 200,
      headers: () => ({ "content-type": "application/json" }),
      headersArray: async () => [
        { name: "content-type", value: "application/json" },
      ],
      body: async () => body,
    } as unknown as Response;
    contextListeners.get("request")?.(request);
    contextListeners.get("response")?.(response);
    contextListeners.get("requestfinished")?.(request);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  await capture.finish();
  return {
    result: capture.result(),
    redactedByteValues: redactBytes.mock.calls.length,
  };
};

describe("PlaywrightScenarioEvents", () => {
  it("identifies omitted network transaction content and honors a raised budget", async () => {
    const baseline = await captureNetworkBudgetFixture();
    const raised = await captureNetworkBudgetFixture(32 * 1024 * 1024);
    expect(baseline.result.dropped).toBeGreaterThan(0);
    expect(
      baseline.result.omissions.by_kind.find(
        ({ kind }) => kind === "network-content",
      ),
    ).toMatchObject({
      count: expect.any(Number),
      reasons: expect.arrayContaining(["max-total-event-allocation-bytes"]),
    });
    expect(
      baseline.result.omissions.network_transactions.length,
    ).toBeGreaterThan(0);
    expect(baseline.redactedByteValues).toBe(
      2 *
        baseline.result.items.filter(
          (event) => event.kind === "network-content",
        ).length,
    );
    expect(raised.result).toMatchObject({
      dropped: 0,
      omissions: { network_transactions: [] },
    });
    expect(
      raised.result.items.filter(
        (event) =>
          event.kind === "network-content" && event.phase === "response",
      ),
    ).toHaveLength(43);
  });

  it("observes requested popup page errors independently of popup lifecycle events", () => {
    const listeners = new Map<string, (value: unknown) => void>();
    const popupListeners = new Map<string, (value: unknown) => void>();
    const page = {
      on: (name: string, listener: (value: unknown) => void) => {
        listeners.set(name, listener);
      },
    } as unknown as Page;
    const popup = {
      url: () => "https://app.example.test/popup",
      on: (name: string, listener: (value: unknown) => void) => {
        popupListeners.set(name, listener);
      },
    } as unknown as Page;
    const scenario = browserScenarioSchema.parse({
      browser: { mode: "launch", executable_path: "/opt/chromium" },
      start_url: { url: "https://app.example.test/" },
      actions: [
        { step_id: "wait", action: "wait_for_timeout", duration_ms: 1 },
      ],
      capture: { events: ["page-errors"] },
    });
    const secrets = BrowserScenarioSecrets.resolve(scenario, {});
    if (secrets === undefined) throw new Error("Expected resolved secrets");
    const events = new PlaywrightScenarioEvents({
      page,
      enabled: new Set(["page-errors"]),
      secrets,
    });
    listeners.get("popup")?.(popup);
    popupListeners.get("pageerror")?.(new Error("popup application failure"));
    expect(events.result().items).toMatchObject([
      { kind: "page-error", message: "popup application failure" },
    ]);
  });

  it("retains oversized page errors without truncating their text", () => {
    const listeners = new Map<string, (value: Error) => void>();
    const page = {
      url: () => "https://app.example.test/",
      on: (name: string, listener: (value: Error) => void) => {
        listeners.set(name, listener);
      },
    } as unknown as Page;
    const scenario = browserScenarioSchema.parse({
      browser: {
        mode: "launch",
        executable_path: "/opt/chromium",
      },
      start_url: { url: "https://app.example.test/" },
      environment: {
        viewport: { width: 1_280, height: 720 },
        locale: "en-US",
        timezone: "UTC",
        color_scheme: "light",
        reduced_motion: "reduce",
      },
      actions: [
        {
          step_id: "wait",
          action: "wait_for_timeout",
          duration_ms: 1,
        },
      ],
      storage: {},
      secrets: [],
      capture: {
        after_each_step: [],
        at_end: [],
        events: ["page-errors"],
      },
    });
    const secrets = BrowserScenarioSecrets.resolve(scenario, {});
    if (secrets === undefined) throw new Error("Expected resolved secrets");
    const events = new PlaywrightScenarioEvents({
      page,
      enabled: new Set(["page-errors"]),
      secrets,
    });
    const error = new Error("m".repeat(70_000));
    error.stack = "s".repeat(300_000);

    listeners.get("pageerror")?.(error);
    expect(events.result().items[0]).toMatchObject({
      kind: "page-error",
      message: "m".repeat(70_000),
      stack: "s".repeat(300_000),
    });
  });
});

it("retains ordinary event volumes and reports event-count exhaustion", () => {
  const listeners = new Map<string, ((value: Error) => void)[]>();
  const page = {
    url: () => "https://app.example.test/",
    on: (name: string, listener: (value: Error) => void) => {
      const registered = listeners.get(name) ?? [];
      registered.push(listener);
      listeners.set(name, registered);
    },
  } as unknown as Page;
  const scenario = browserScenarioSchema.parse({
    browser: {
      mode: "launch",
      executable_path: "/opt/chromium",
    },
    start_url: { url: "https://app.example.test/" },
    actions: [{ step_id: "wait", action: "wait_for_timeout", duration_ms: 1 }],
    capture: { events: ["page-errors"] },
  });
  const secrets = BrowserScenarioSecrets.resolve(scenario, {});
  if (secrets === undefined) throw new Error("Expected resolved secrets");
  const events = new PlaywrightScenarioEvents({
    page,
    enabled: new Set(["page-errors"]),
    secrets,
  });
  for (let index = 0; index < 2_001; index += 1)
    listeners.get("pageerror")?.forEach((listener) => {
      const error = new Error(`failure-${index}`);
      error.stack = "";
      listener(error);
    });
  expect(events.result()).toMatchObject({ retained: 2_001, dropped: 0 });
  expect(events.result().items.at(-1)).toMatchObject({
    kind: "page-error",
    message: "failure-2000",
  });
  // Omit whole oversized events, preserving ordinary messages rather than
  // inventing truncated observations. This also tests admission before redact.
  const redact = vi.spyOn(secrets, "redact");
  listeners.get("pageerror")?.forEach((listener) => {
    const error = new Error("x".repeat(1_000_000));
    error.stack = "";
    listener(error);
  });
  expect(redact).not.toHaveBeenCalled();
  for (let index = 0; index < 10_000; index += 1)
    listeners.get("pageerror")?.forEach((listener) => {
      const error = new Error(`short-${index}`);
      error.stack = "";
      listener(error);
    });
  expect(events.result()).toMatchObject({ retained: 10_000, dropped: 2_002 });
  expect(events.limitations().join(" ")).toContain("resource budget");
  const aggregate = new PlaywrightScenarioEvents({
    page,
    enabled: new Set(["page-errors"]),
    secrets,
  });
  const aggregateListener = listeners.get("pageerror")?.at(-1);
  const aggregateRedact = vi.spyOn(secrets, "redact");
  let refused = false;
  for (let index = 0; index < 64 && !refused; index += 1) {
    aggregateRedact.mockClear();
    const droppedBefore = aggregate.result().dropped;
    const error = new Error("x".repeat(400_000));
    error.stack = "";
    aggregateListener?.(error);
    refused = aggregate.result().dropped > droppedBefore;
    if (refused) expect(aggregateRedact.mock.calls.length).toBe(0);
  }
  expect(refused).toBe(true);

  const small = new Error("small event remains eligible");
  small.stack = "";
  aggregateRedact.mockClear();
  aggregateListener?.(small);
  expect(aggregateRedact.mock.calls.length).toBeGreaterThan(0);
  expect(aggregate.result().retained).toBeGreaterThan(0);
  expect(aggregate.result().items.at(-1)).toMatchObject({
    kind: "page-error",
    message: "small event remains eligible",
  });
});

it("caps live descendant listeners and reuses capacity after closure", () => {
  const listeners = new Map<string, (value: unknown) => void>();
  const page = {
    on: (name: string, listener: (value: unknown) => void) =>
      listeners.set(name, listener),
    off: vi.fn(),
  } as unknown as Page;
  const scenario = browserScenarioSchema.parse({
    browser: { mode: "launch", executable_path: "/fixture/chrome" },
    start_url: { url: "https://example.test" },
    actions: [{ step_id: "wait", action: "wait_for_timeout", duration_ms: 1 }],
  });
  const secrets = BrowserScenarioSecrets.resolve(scenario, {});
  if (secrets === undefined) throw new Error("Expected resolved secrets");
  const events = new PlaywrightScenarioEvents({
    page,
    enabled: new Set(["websockets"]),
    secrets,
  });
  const sockets = Array.from({ length: 2049 }, () => ({
    url: () => "wss://example.test/",
    on: vi.fn<(name: string, listener: () => void) => void>(),
    off: vi.fn(),
  }));
  for (const socket of sockets.slice(0, 2048))
    listeners.get("websocket")?.(socket);
  expect(sockets[2046]?.on).toHaveBeenCalledTimes(3);
  expect(sockets[2047]?.on).not.toHaveBeenCalled();
  expect(events.result().dropped).toBe(1);
  const close = sockets[0]?.on.mock.calls.find(
    ([name]) => name === "close",
  )?.[1];
  close?.();
  expect(sockets[0]?.off).toHaveBeenCalledTimes(3);
  listeners.get("websocket")?.(sockets[2048]);
  expect(sockets[2048]?.on).toHaveBeenCalledTimes(3);
});
