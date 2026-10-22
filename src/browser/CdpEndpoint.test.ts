import { createServer, type RequestListener, type Server } from "node:http";
import { once } from "node:events";

import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { BrowserObservationError } from "../domain/browserObservationError.js";

import { afterEach, describe, expect, it } from "vitest";

import {
  discoverCdpEndpoint,
  readCdpJson,
  withCdpDiscoveryDeadline,
} from "./CdpEndpoint.js";

const servers: Server[] = [];

const listen = async (
  handler: RequestListener,
): Promise<{ readonly server: Server; readonly endpoint: string }> => {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Expected a TCP listener address.");
  return {
    server,
    endpoint: `http://127.0.0.1:${String(address.port)}`,
  };
};

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      server.closeAllConnections();
      if (server.listening) {
        server.close();
        await once(server, "close");
      }
    }),
  );
});

describe("CDP discovery cancellation ownership", () => {
  it("preserves the exact reason for a pre-aborted discovery request", async () => {
    let requests = 0;
    const { endpoint } = await listen((_request, response) => {
      requests += 1;
      response.end("{}");
    });
    const reason = { _tag: "caller-stop" };
    const controller = new AbortController();
    controller.abort(reason);

    const failure = await readCdpJson(
      new URL("/json/version", endpoint),
      "inspect_web_page",
      controller.signal,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AnalysisCancelledError);
    expect(failure).toMatchObject({ cause: reason });
    expect(requests).toBe(0);
  });

  it("cancels an in-flight discovery at the HTTP producer with the original reason", async () => {
    let requestedPath: string | undefined;
    let requestSeen!: () => void;
    const seen = new Promise<void>((resolve) => {
      requestSeen = resolve;
    });
    const { endpoint } = await listen((request) => {
      requestedPath = request.url;
      requestSeen();
    });
    const reason = new Error("operator stopped discovery");
    const controller = new AbortController();
    const discovery = discoverCdpEndpoint(
      endpoint,
      "inspect_web_page",
      controller.signal,
    ).catch((error: unknown) => error);

    await seen;
    controller.abort(reason);
    const failure = await discovery;

    expect(requestedPath).toBe("/json/version");
    expect(failure).toBeInstanceOf(AnalysisCancelledError);
    expect(failure).toMatchObject({ cause: reason });
  });

  it("does not replace a primary discovery failure when cancellation arrives later", async () => {
    const primary = new BrowserObservationError(
      "inspect_web_page",
      "protocol_error",
    );
    const controller = new AbortController();
    const failure = await withCdpDiscoveryDeadline(
      "inspect_web_page",
      controller.signal,
      async () => {
        throw primary;
      },
      100,
    ).catch((error: unknown) => error);
    controller.abort(new Error("late caller cancellation"));

    expect(failure).toBe(primary);
  });

  it("does not replace a plain physical failure rejected before a late abort", async () => {
    const primary = new Error("socket failed before cancellation");
    const controller = new AbortController();
    const pending = withCdpDiscoveryDeadline(
      "inspect_web_page",
      controller.signal,
      () => Promise.reject(primary),
      100,
    ).catch((error: unknown) => error);
    controller.abort(new Error("later caller cancellation"));
    const failure = await pending;

    expect(failure).toBe(primary);
  });

  it("classifies its own discovery deadline as timeout", async () => {
    const failure = await withCdpDiscoveryDeadline(
      "inspect_web_page",
      undefined,
      (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
      1,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BrowserObservationError);
    expect(failure).toMatchObject({ reason: "timeout" });
  });

  it("normalizes a typed cancellation caused by its own deadline to timeout", async () => {
    const failure = await withCdpDiscoveryDeadline(
      "inspect_web_page",
      undefined,
      (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () =>
              reject(
                new AnalysisCancelledError("inspect_web_page", {
                  cause: signal.reason,
                }),
              ),
            { once: true },
          );
        }),
      1,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BrowserObservationError);
    expect(failure).toMatchObject({ reason: "timeout" });
  });

  it("treats the caller's AnalysisError abort reason as cancellation when caller wins first", async () => {
    const reason = new BrowserObservationError(
      "inspect_web_page",
      "protocol_error",
    );
    const controller = new AbortController();
    const failure = await withCdpDiscoveryDeadline(
      "inspect_web_page",
      controller.signal,
      async () => {
        controller.abort(reason);
        throw reason;
      },
      0,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AnalysisCancelledError);
    expect(failure).toMatchObject({ cause: reason });
  });

  it("keeps a deadline rejection when the caller aborts only after timeout", async () => {
    const controller = new AbortController();
    const failure = await withCdpDiscoveryDeadline(
      "inspect_web_page",
      controller.signal,
      (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
      0,
    ).catch((error: unknown) => error);
    controller.abort(new Error("caller stopped after timeout"));

    expect(failure).toBeInstanceOf(BrowserObservationError);
    expect(failure).toMatchObject({ reason: "timeout" });
  });
});

it("preserves an independent typed cancellation when the discovery deadline also expires", async () => {
  const primary = new AnalysisCancelledError("inspect_web_page", {
    cause: "independent cancellation",
  });
  const failure = await withCdpDiscoveryDeadline(
    "inspect_web_page",
    undefined,
    (signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(primary), { once: true });
      }),
    1,
  ).catch((cause: unknown) => cause);
  expect(failure).toBe(primary);
});
