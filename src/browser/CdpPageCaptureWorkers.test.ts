import { describe, expect, it } from "vitest";

import { inspectWebPageInputSchema } from "../domain/browserObservation.js";
import { CdpCaptureEvents } from "./CdpCaptureEvents.js";
import type { CdpConnection } from "./CdpConnection.js";
import type { CdpEndpointTarget } from "./CdpEndpoint.js";
import { captureWorkers } from "./CdpPageCaptureWorkers.js";
import type { CaptureContext } from "./CdpPageCapture.js";

const origin = "http://127.0.0.1:43127";

const capture = async (inventory: unknown) => {
  const input = inspectWebPageInputSchema.parse({
    cdp_endpoint: origin,
    allowed_origins: [origin],
    target_id: "page",
  });
  const events = new CdpCaptureEvents(input, new Set([origin]));
  const context = {
    connection: {
      async send() {
        return inventory;
      },
    } as unknown as CdpConnection,
    sessionId: undefined,
    target: {
      id: "page",
      type: "page",
      title: "Fixture",
      url: `${origin}/index.html`,
      attached: false,
    } satisfies CdpEndpointTarget,
  } as unknown as CaptureContext;
  const workers = await captureWorkers(
    {
      context,
      allowedOrigins: new Set([origin]),
      limitations: [],
      events,
    },
    new Set(),
  );
  return { workers, completeness: events.completeness.snapshot() };
};

describe("web worker target inventory", () => {
  it("preserves an explicit empty inventory", async () => {
    const result = await capture({ targetInfos: [] });

    expect(result.workers).toEqual([]);
    expect(result.completeness.unavailable_sections).not.toContain("workers");
  });

  it.each([undefined, { length: 1 }])(
    "reports a missing or non-array target inventory as unknown: %s",
    async (targetInfos) => {
      const result = await capture({ targetInfos });

      expect(result.workers).toEqual([]);
      expect(result.completeness).toMatchObject({
        unavailable_sections: ["workers"],
        excluded: [
          {
            section: "workers",
            reason: "invalid_protocol_value",
            count: null,
          },
        ],
      });
    },
  );

  it("retains valid worker records beside malformed entries", async () => {
    const result = await capture({
      targetInfos: [
        null,
        {
          targetId: "worker-1",
          type: "service_worker",
          url: `${origin}/worker.js`,
          attached: true,
          openerId: "page",
        },
        {
          targetId: "worker-missing-url",
          type: "worker",
          attached: true,
          openerId: "another-page",
        },
        {
          type: "worker",
          url: `${origin}/missing-id.js`,
          attached: true,
          openerId: "page",
        },
        {
          targetId: "worker-invalid-attached",
          type: "worker",
          url: `${origin}/invalid-attached.js`,
          attached: "true",
          openerId: "page",
        },
        "malformed",
      ],
    });

    expect(result.workers.map((worker) => worker.target_id)).toEqual([
      "worker-1",
    ]);
    expect(result.completeness).toMatchObject({
      unavailable_sections: ["workers"],
      excluded: [
        {
          section: "workers",
          reason: "invalid_protocol_value",
          count: 5,
        },
      ],
    });
    expect(result.completeness.excluded).not.toContainEqual(
      expect.objectContaining({
        section: "workers",
        reason: "out_of_target_scope",
      }),
    );
  });
});
