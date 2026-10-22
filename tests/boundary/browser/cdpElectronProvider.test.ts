import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { createPackage } from "@electron/asar";
import { afterEach, describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import { CdpElectronProvider } from "../../../src/browser/CdpElectronProvider.js";
import { AnalysisCancelledError } from "../../../src/domain/analysisErrorCore.js";
import {
  inspectElectronPageInputSchema,
  listElectronTargetsInputSchema,
} from "../../../src/domain/javascript/electronObservation.js";
import {
  startFakeCdpBrowser,
  type FakeCdpBrowser,
} from "../../fixtures/fakeCdpBrowser.js";

const browsers: FakeCdpBrowser[] = [];
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(browsers.splice(0).map(async (browser) => browser.close()));
  await Promise.all(
    temporary
      .splice(0)
      .map(async (path) => rm(path, { recursive: true, force: true })),
  );
});

describe("CdpElectronProvider target access", () => {
  it("retains a completed page observation when cancellation arrives during final detach", async () => {
    const root = await electronFixture();
    const controller = new AbortController();
    const browser = await startFakeCdpBrowser({
      electronFileUrl: pathToFileURL(join(root, "index.html")).href,
      commandEvents: ({ method }) => {
        if (method === "Target.detachFromTarget") controller.abort();
        return undefined;
      },
    });
    browsers.push(browser);

    const result = await new CdpElectronProvider().inspectPage(
      inspectElectronPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        target_id: "electron-page",
        observation_ms: 0,
      }),
      { signal: controller.signal },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected late cancellation");
    expect(result.error).toBeInstanceOf(AnalysisCancelledError);
    expect(result.error.partialObservation).toMatchObject({
      kind: "electron-page-observation",
      cleanup: "transport-closed",
      inspection: { target: { file_path: join(root, "index.html") } },
    });
    expect(browser.commands.map(({ method }) => method)).toContain(
      "Target.detachFromTarget",
    );
    const closeDeadline = Date.now() + 1_000;
    while (browser.activeConnectionCount() !== 0 && Date.now() < closeDeadline)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(browser.activeConnectionCount()).toBe(0);
  });

  it("returns every in-scope resource beyond the former collection ceiling", async () => {
    const root = await electronFixture();
    const index = join(root, "index.html");
    const count = 2_001;
    await Promise.all(
      Array.from({ length: count }, (_value, item) =>
        writeFile(join(root, `inventory-${String(item)}.js`), ""),
      ),
    );
    const browser = await startFakeCdpBrowser({
      electronFileUrl: pathToFileURL(index).href,
      electronInventoryCount: count,
    });
    browsers.push(browser);
    const inspected = await new CdpElectronProvider().inspectPage(
      inspectElectronPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        target_id: "electron-page",
        observation_ms: 0,
      }),
    );
    if (!inspected.ok) throw inspected.error;
    expect(inspected.value.resources).toHaveLength(count + 1);
    expect(inspected.value.completeness.truncated_sections).toEqual([]);
  });

  it("returns every Electron page target exposed by the endpoint inline", async () => {
    const root = await electronFixture();
    const index = join(root, "index.html");
    const browser = await startFakeCdpBrowser({
      electronFileUrl: pathToFileURL(index).href,
      additionalElectronPageCount: 205,
    });
    browsers.push(browser);
    const listed = await new CdpElectronProvider().listTargets(
      listElectronTargetsInputSchema.parse({
        cdp_endpoint: browser.endpoint,
      }),
    );
    if (!listed.ok) throw listed.error;
    expect(listed.value.targets).toHaveLength(206);
    expect(listed.value.targets[0]?.target_id).toBe("electron-page");
    expect(listed.value.targets.at(-1)?.target_id).toBe("electron-page-0204");
  });
});

describe("CdpElectronProvider target selection", () => {
  it("lists and inspects every canonical local file target", async () => {
    const root = await electronFixture();
    const index = join(root, "index.html");
    const browser = await startFakeCdpBrowser({
      electronFileUrl: pathToFileURL(index).href,
      duplicateElectronInventory: true,
      omitElectronTargetAttachmentState: true,
    });
    browsers.push(browser);
    const provider = new CdpElectronProvider();
    const listed = await provider.listTargets(
      listElectronTargetsInputSchema.parse({
        cdp_endpoint: browser.endpoint,
      }),
    );
    if (!listed.ok) throw listed.error;
    expect(listed.value.targets).toEqual([
      expect.objectContaining({
        target_id: "electron-page",
        file_path: index,
        attached: null,
      }),
    ]);
    expect(
      listed.value.limitations.some((item) =>
        item.includes("attachment state"),
      ),
    ).toBe(true);
    expect(listed.value.excluded).toEqual({
      unsupported_url: 3,
      non_page: 2,
    });

    const inspected = await provider.inspectPage(
      inspectElectronPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        target_id: "electron-page",
        observation_ms: 0,
      }),
    );
    if (!inspected.ok) throw inspected.error;
    expect(inspected.value.target.file_path).toBe(index);
    expect(inspected.value.target.attached).toBeNull();
    expect(
      inspected.value.limitations.some((item) =>
        item.includes("attachment state"),
      ),
    ).toBe(true);
    expect(inspected.value.frames).toEqual([
      expect.objectContaining({ file_path: index }),
    ]);
    expect(inspected.value.dom).toMatchObject({ total_nodes: 2 });
    expect(inspected.value.scripts).toMatchObject({
      total: 1,
      items: [
        expect.objectContaining({
          file_path: join(root, "app.js"),
          source: {
            included: false,
            reason: "source capture was not selected",
          },
        }),
      ],
    });
    expect(inspected.value.resources).toEqual([
      expect.objectContaining({ file_path: join(root, "app.js") }),
    ]);
    const methods = browser.commands.map(({ method }) => method);
    expect(methods).not.toContain("Runtime.evaluate");
    expect(methods).not.toContain("Network.enable");
    expect(methods).not.toContain("Debugger.getScriptSource");
    expect(methods).toContain("Target.detachFromTarget");

    const missing = await provider.inspectPage(
      inspectElectronPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        target_id: "missing",
        observation_ms: 0,
      }),
    );
    expect(missing).toMatchObject({
      ok: false,
      error: {
        _tag: "BrowserObservationError",
        operation: "inspect_electron_page",
        reason: "target_not_found",
      },
    });
  });

  it("inspects a page-scoped Electron endpoint without browser attachment", async () => {
    const root = await electronFixture();
    const index = join(root, "index.html");
    const browser = await startFakeCdpBrowser({
      electronFileUrl: pathToFileURL(index).href,
      pageScopedVersionWebSocket: true,
      omitTargetWebSocket: true,
    });
    browsers.push(browser);
    const result = await new CdpElectronProvider().inspectPage(
      inspectElectronPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        target_id: "electron-page",
        observation_ms: 0,
      }),
    );
    if (!result.ok) throw result.error;
    expect(result.value.target.file_path).toBe(index);
    expect(browser.commands.map(({ method }) => method)).not.toContain(
      "Target.attachToTarget",
    );
    expect(
      browser.commands.every(({ sessionId }) => sessionId === undefined),
    ).toBe(true);
  });

  it("maps cancelled Electron discovery to the Electron operation", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await new CdpElectronProvider().listTargets(
      listElectronTargetsInputSchema.parse({
        cdp_endpoint: "http://127.0.0.1:9222",
      }),
      { signal: controller.signal },
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisCancelledError",
        operation: "list_electron_targets",
      },
    });
  });
});

describe("CdpElectronProvider packaged pages", () => {
  it("lists and inspects packaged pages served from inside app.asar", async () => {
    const root = await createTestTempDirectory("rea-electron-asar-provider-");
    temporary.push(root);
    const source = join(root, "source");
    await mkdir(source);
    await writeFile(
      join(source, "index.html"),
      "<script src='app.js'></script>",
    );
    await writeFile(join(source, "app.js"), "export const app = true;");
    const archive = join(root, "app.asar");
    await createPackage(source, archive);
    const packaged = await realpath(archive);
    const browser = await startFakeCdpBrowser({
      electronFileUrl: `${pathToFileURL(join(archive, "index.html")).href}?isBookDoubleClicked=0#/library`,
    });
    browsers.push(browser);
    const provider = new CdpElectronProvider();
    const listed = await provider.listTargets(
      listElectronTargetsInputSchema.parse({ cdp_endpoint: browser.endpoint }),
    );
    if (!listed.ok) throw listed.error;
    expect(listed.value.targets).toEqual([
      expect.objectContaining({
        target_id: "electron-page",
        file_path: join(packaged, "index.html"),
      }),
    ]);

    const inspected = await provider.inspectPage(
      inspectElectronPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        target_id: "electron-page",
        observation_ms: 0,
      }),
    );
    if (!inspected.ok) throw inspected.error;
    expect(inspected.value.target.file_path).toBe(join(packaged, "index.html"));
    expect(inspected.value.scripts.items).toEqual([
      expect.objectContaining({ file_path: join(packaged, "app.js") }),
    ]);
  });
});

describe("CdpElectronProvider frame capture", () => {
  it.each([7, undefined])(
    "reports a malformed child frame ID as unavailable protocol evidence: %s",
    async (childId) => {
      const root = await electronFixture();
      const main = pathToFileURL(join(root, "index.html")).href;
      const child = pathToFileURL(join(root, "child.html")).href;
      const browser = await startFakeCdpBrowser({
        electronFileUrl: main,
        commandResult: (command) =>
          command.method === "Page.getFrameTree"
            ? {
                frameTree: {
                  frame: { id: "frame-main", url: main },
                  childFrames: [
                    {
                      frame: {
                        ...(childId === undefined ? {} : { id: childId }),
                        url: child,
                      },
                    },
                  ],
                },
              }
            : undefined,
      });
      browsers.push(browser);
      const result = await new CdpElectronProvider().inspectPage(
        inspectElectronPageInputSchema.parse({
          cdp_endpoint: browser.endpoint,
          target_id: "electron-page",
          observation_ms: 0,
        }),
      );

      if (!result.ok) throw result.error;
      expect(result.value.frames.map((frame) => frame.frame_id)).toEqual([
        "frame-main",
      ]);
      expect(result.value.completeness).toMatchObject({
        unavailable_sections: ["frames"],
      });
      expect(result.value.completeness.excluded).toContainEqual({
        section: "frames",
        reason: "invalid_protocol_value",
        count: 1,
      });
      expect(result.value.completeness.policy_filtered_sections).not.toContain(
        "frames",
      );
      expect(result.value.completeness.conditions).toContain("attach_limited");
    },
  );
});

describe("CdpElectronProvider malformed source replies", () => {
  it.each([{}, { scriptSource: null }, { scriptSource: 123 }])(
    "rejects malformed Electron source replies instead of inventing source: %j",
    async (reply) => {
      const root = await electronFixture();
      const browser = await startFakeCdpBrowser({
        electronFileUrl: pathToFileURL(join(root, "index.html")).href,
        commandResult: ({ method }) =>
          method === "Debugger.getScriptSource" ? reply : undefined,
      });
      browsers.push(browser);
      const result = await new CdpElectronProvider().inspectPage(
        inspectElectronPageInputSchema.parse({
          cdp_endpoint: browser.endpoint,
          target_id: "electron-page",
          observation_ms: 0,
          include_script_sources: true,
        }),
      );

      expect(result).toMatchObject({
        ok: false,
        error: {
          operation: "inspect_electron_page",
          reason: "protocol_error",
          userMessage: expect.stringContaining("scriptSource must be a string"),
        },
      });
      expect(browser.commands.map(({ method }) => method)).toContain(
        "Target.detachFromTarget",
      );
    },
  );
});

describe("CdpElectronProvider malformed inventory replies", () => {
  const inspectWith = async (
    method: string,
    reply: (fileUrl: string) => Readonly<Record<string, unknown>>,
  ) => {
    const root = await electronFixture();
    const fileUrl = pathToFileURL(join(root, "index.html")).href;
    const browser = await startFakeCdpBrowser({
      electronFileUrl: fileUrl,
      commandResult: (command) =>
        command.method === method ? reply(fileUrl) : undefined,
    });
    browsers.push(browser);
    const result = await new CdpElectronProvider().inspectPage(
      inspectElectronPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        target_id: "electron-page",
        observation_ms: 0,
      }),
    );
    if (!result.ok) throw result.error;
    return result.value;
  };

  it("keeps documents unknown when the DOM string table is missing", async () => {
    const inspected = await inspectWith("DOMSnapshot.captureSnapshot", () => ({
      documents: [{ documentURL: 0, nodes: { nodeType: [] } }],
    }));

    expect(inspected.dom).toEqual({ total_nodes: 0, nodes: [] });
    expect(inspected.completeness.unavailable_sections).toContain("dom");
    expect(inspected.completeness.excluded).toContainEqual({
      section: "dom",
      reason: "invalid_protocol_value",
      count: null,
    });
    expect(inspected.completeness.policy_filtered_sections).not.toContain(
      "dom",
    );
  });

  it.each([
    ["dom", "DOMSnapshot.captureSnapshot", () => ({ strings: [] })],
    [
      "dom",
      "DOMSnapshot.captureSnapshot",
      (fileUrl: string) => ({
        strings: [fileUrl],
        documents: [{ documentURL: 0, nodes: { nodeType: null } }],
      }),
    ],
    [
      "resources",
      "Page.getResourceTree",
      (fileUrl: string) => ({
        frameTree: { frame: { id: "main", url: fileUrl }, resources: null },
      }),
    ],
    ["workers", "Target.getTargets", () => ({ targetInfos: null })],
  ] as const)(
    "keeps a malformed %s inventory incomplete (%s)",
    async (section, method, reply) => {
      const inspected = await inspectWith(method, reply);
      expect(inspected.completeness.status).not.toBe("complete_within_window");
      expect(inspected.completeness.excluded).toContainEqual(
        expect.objectContaining({
          section,
          reason: "invalid_protocol_value",
        }),
      );
    },
  );
});

describe("CdpElectronProvider script source capture", () => {
  it("retains an explicitly empty Electron producer script", async () => {
    const root = await electronFixture();
    const browser = await startFakeCdpBrowser({
      electronFileUrl: pathToFileURL(join(root, "index.html")).href,
      commandResult: ({ method }) =>
        method === "Debugger.getScriptSource"
          ? { scriptSource: "" }
          : undefined,
    });
    browsers.push(browser);
    const result = await new CdpElectronProvider().inspectPage(
      inspectElectronPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        target_id: "electron-page",
        observation_ms: 0,
        include_script_sources: true,
      }),
    );

    if (!result.ok) throw result.error;
    expect(result.value.scripts.items[0]?.source).toMatchObject({
      included: true,
      artifact: { text: "", bytes: 0 },
    });
  });

  it("captures Electron script source only after separate approval", async () => {
    const root = await electronFixture();
    const browser = await startFakeCdpBrowser({
      electronFileUrl: pathToFileURL(join(root, "index.html")).href,
    });
    browsers.push(browser);
    const result = await new CdpElectronProvider().inspectPage(
      inspectElectronPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        target_id: "electron-page",
        observation_ms: 0,
        include_script_sources: true,
      }),
    );
    if (!result.ok) throw result.error;
    expect(result.value.scripts.items[0]?.source).toMatchObject({
      included: true,
      artifact: { text: "export const observed = 'source-secret';" },
    });
    expect(browser.commands.map(({ method }) => method)).toContain(
      "Debugger.getScriptSource",
    );
  });

  it("rebases DOM parent indexes across allowed file documents", async () => {
    const root = await electronFixture();
    const browser = await startFakeCdpBrowser({
      electronFileUrl: pathToFileURL(join(root, "index.html")).href,
      extraCollections: true,
    });
    browsers.push(browser);
    const result = await new CdpElectronProvider().inspectPage(
      inspectElectronPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        target_id: "electron-page",
        observation_ms: 0,
      }),
    );

    if (!result.ok) throw result.error;
    expect(result.value.dom).toMatchObject({
      total_nodes: 4,
      nodes: [
        { index: 0, parent_index: -1 },
        { index: 1, parent_index: 0 },
        { index: 2, parent_index: -1 },
        { index: 3, parent_index: 2 },
      ],
    });
  });

  it("rejects mixed Electron evidence when the main frame navigates", async () => {
    const root = await electronFixture();
    const page = join(root, "index.html");
    const next = join(root, "next.html");
    await writeFile(next, "<html>next</html>");
    const browser = await startFakeCdpBrowser({
      electronFileUrl: pathToFileURL(page).href,
      navigateDuringCaptureUrl: pathToFileURL(next).href,
    });
    browsers.push(browser);
    const result = await new CdpElectronProvider().inspectPage(
      inspectElectronPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        target_id: "electron-page",
        observation_ms: 0,
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        _tag: "BrowserObservationError",
        operation: "inspect_electron_page",
        reason: "target_changed",
      },
    });
  });
});

const electronFixture = async (): Promise<string> => {
  const root = await createTestTempDirectory("rea-electron-provider-");
  temporary.push(root);
  await writeFile(join(root, "index.html"), "<script src='app.js'></script>");
  await writeFile(join(root, "app.js"), "export const app = true;");
  await writeFile(join(root, "child.html"), "<div>child</div>");
  return root;
};
