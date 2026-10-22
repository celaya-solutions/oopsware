import { createServer } from "node:http";

import { expect, it } from "vitest";

import { V8InspectorProvider } from "./V8InspectorProvider.js";

it("keeps connectable siblings when a target omits its direct socket", async () => {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/json/version") {
      response.end(
        JSON.stringify({
          Browser: "Node.js/v24.18.0",
          "Protocol-Version": "1.3",
        }),
      );
      return;
    }
    if (request.url === "/json/list") {
      const address = server.address();
      if (address === null || typeof address === "string") {
        response.writeHead(500).end();
        return;
      }
      response.end(
        JSON.stringify([
          {
            id: "connectable",
            type: "node",
            url: "https://example.test/entry.js",
            webSocketDebuggerUrl: `ws://127.0.0.1:${String(address.port)}/connectable`,
          },
          {
            id: "anonymous",
            type: "node",
            url: "https://example.test/eval.js",
          },
        ]),
      );
      return;
    }
    response.writeHead(404).end();
  });

  try {
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Inspector fixture did not bind a TCP port");

    const result = await new V8InspectorProvider().listTargets({
      inspector_endpoint: `http://127.0.0.1:${String(address.port)}`,
    });
    if (!result.ok)
      throw new Error(result.error.message, { cause: result.error });

    expect(result).toMatchObject({
      ok: true,
      value: {
        targets: [{ target_id: "connectable" }],
        excluded: { unconnectable: 1 },
      },
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
