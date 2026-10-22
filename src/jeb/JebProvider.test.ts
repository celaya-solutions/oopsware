import { describe, expect, it } from "vitest";

import { createJebAnalysisProvider } from "../composition/jeb.js";
import { JebProvider } from "./JebProvider.js";
import type {
  JebMcpConnection,
  JebMcpConnectionTimeouts,
} from "./JebMcpConnection.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisProtocolError,
  AnalysisCancelledError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { jebResultSchemas } from "../domain/jeb/jebAnalysis.js";

const scriptedConnection = (
  responses: Readonly<Record<string, JsonValue | Error>>,
): JebMcpConnection & { readonly calls: unknown[][] } => {
  const calls: unknown[][] = [];
  return {
    calls,
    async connect() {
      return Object.keys(responses);
    },
    async listTools() {
      return Object.keys(responses);
    },
    async call(name, args) {
      calls.push([name, args]);
      const response = responses[name];
      if (response === undefined)
        throw new Error(`Unexpected JEB MCP call: ${name}`);
      if (response instanceof Error) throw response;
      return response;
    },
    async close() {},
  };
};

const providerWith = (connection: JebMcpConnection) =>
  new JebProvider({
    environment: { REA_JEB_MCP_URL: "http://127.0.0.1:8425/mcp" },
    connectionFactory: () => connection,
  });

describe("JebProvider live availability", () => {
  it("passes its validated environment timeout to the production connection", async () => {
    let configured: JebMcpConnectionTimeouts | undefined;
    const provider = createJebAnalysisProvider(
      { REA_JEB_MCP_TIMEOUT_MS: "900000" },
      (_endpoint, timeouts) => {
        configured = timeouts;
        return scriptedConnection({});
      },
    );
    expect(configured).toEqual({ requestTimeoutMs: 900_000 });
    await provider.close();
  });

  it("rejects an invalid JEB timeout before constructing its MCP connection", async () => {
    let constructed = false;
    const provider = createJebAnalysisProvider(
      { REA_JEB_MCP_TIMEOUT_MS: "0" },
      () => {
        constructed = true;
        return scriptedConnection({});
      },
    );
    expect(constructed).toBe(false);
    await expect(provider.inspectAvailability()).resolves.toMatchObject({
      status: "unavailable",
      diagnostics: { setting: "REA_JEB_MCP_TIMEOUT_MS" },
    });
    await provider.close();
  });

  it("reports only the operations advertised by the live engine", async () => {
    const connection = scriptedConnection({
      get_client_information: {
        success: true,
        version: "5.48.0",
        gui_client: false,
      },
      list_units: { success: true, units: [] },
      decompile_code_item: { success: true, text: "" },
    });
    const provider = providerWith(connection);
    expect(await provider.inspectAvailability()).toMatchObject({
      status: "available",
      supportedOperations: [
        "inspect_jeb_client",
        "list_jeb_units",
        "decompile_jeb_item",
      ],
    });
    expect(connection.calls).toEqual([["get_client_information", {}]]);
  });

  it("refreshes live operation support rather than reusing a readiness snapshot", async () => {
    const connection = scriptedConnection({
      get_client_information: { success: true, version: "5.48.0" },
    });
    let tools = ["get_client_information", "open_project"];
    connection.listTools = async () => tools;
    const provider = providerWith(connection);
    expect(await provider.inspectAvailability()).toMatchObject({
      supportedOperations: ["inspect_jeb_client", "open_jeb_project"],
    });
    tools = ["get_client_information"];
    expect(await provider.inspectAvailability()).toMatchObject({
      supportedOperations: ["inspect_jeb_client"],
    });
    expect(connection.calls).toHaveLength(2);
  });
});

describe("JebProvider observations and failures", () => {
  it("normalizes client information and caches engine identity", async () => {
    const connection = scriptedConnection({
      get_client_information: {
        success: true,
        version: "5.48.0.202610071539",
        gui_client: false,
        startup_ts: 1791623439,
      },
    });
    const provider = providerWith(connection);
    const result = await provider.execute({
      operation: "inspect_jeb_client",
      input: {},
    });
    if (!result.ok) throw result.error;
    const normalized = jebResultSchemas.inspect_jeb_client.parse(
      result.value.result,
    );
    expect(normalized.engine.version).toBe("5.48.0.202610071539");
    expect(normalized.startup_ts).toBe(1791623439);
    expect(result.value.provider.version).toBe("5.48.0.202610071539");
  });

  it("reports unavailable when the engine endpoint is unreachable", async () => {
    const provider = providerWith(
      scriptedConnection({
        get_client_information: new Error(
          "connect ECONNREFUSED 127.0.0.1:8425",
        ),
        list_units: new Error("connect ECONNREFUSED 127.0.0.1:8425"),
      }),
    );
    const availability = await provider.inspectAvailability();
    expect(availability.status).toBe("unavailable");
    const result = await provider.execute({
      operation: "list_jeb_units",
      input: { count: 10, index: 0 },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(AnalysisCapabilityUnavailableError);
    expect(result.error.message).toContain("ECONNREFUSED");
  });

  it("maps transport failures during an operation to provider unavailability", async () => {
    const provider = providerWith(
      scriptedConnection({
        get_client_information: {
          success: true,
          version: "5.48.0",
          gui_client: false,
        },
        list_units: new Error("connect ECONNREFUSED 127.0.0.1:8425"),
      }),
    );
    const result = await provider.execute({
      operation: "list_jeb_units",
      input: { count: 10, index: 0 },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(AnalysisCapabilityUnavailableError);
    expect(result.error.message).toContain("ECONNREFUSED");
  });

  it("preserves engine refusal reasons as unsupported targets", async () => {
    const provider = providerWith(
      scriptedConnection({
        get_client_information: {
          success: true,
          version: "5.48.0",
          gui_client: false,
        },
        decompile_code_item: {
          success: false,
          message:
            "The decompilation failed because the item address does not reference an existing code item",
        },
      }),
    );
    const result = await provider.execute({
      operation: "decompile_jeb_item",
      input: { item_address: "LNope;->x()V", item_kind: "method" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("does not reference an existing");
  });

  it("derives partial coverage only from a full engine page", async () => {
    const provider = providerWith(
      scriptedConnection({
        get_client_information: {
          success: true,
          version: "5.48.0",
          gui_client: false,
        },
        list_units: {
          success: true,
          units: Array.from({ length: 3 }, (_, index) => ({
            unit_path: `a/class${index}.dex`,
            unit_type: "dex",
          })),
        },
      }),
    );
    const full = await provider.execute({
      operation: "list_jeb_units",
      input: { count: 3, index: 0 },
    });
    if (!full.ok) throw full.error;
    expect(
      jebResultSchemas.list_jeb_units.parse(full.value.result).coverage,
    ).toBe("partial");
    const last = await provider.execute({
      operation: "list_jeb_units",
      input: { count: 4, index: 0 },
    });
    if (!last.ok) throw last.error;
    expect(
      jebResultSchemas.list_jeb_units.parse(last.value.result).coverage,
    ).toBe("complete");
  });
});

describe("JebProvider open project inventories", () => {
  it.each(["input_files", "units"] as const)(
    "rejects an omitted %s inventory from a successful project response",
    async (omitted) => {
      const project = {
        success: true,
        name: "empty-project",
        creation_datetime: "2026-10-12T00:00:00",
        input_files: [],
        units: [],
      };
      const response = { ...project };
      delete response[omitted];
      const provider = providerWith(
        scriptedConnection({
          get_client_information: { success: true, version: "5.48.0" },
          open_project: response,
        }),
      );

      const result = await provider.execute({
        operation: "open_jeb_project",
        input: { path: "probe.apk" },
      });

      if (result.ok) throw new Error("Expected an omitted inventory failure");
      expect(result.error).toBeInstanceOf(AnalysisProtocolError);
    },
  );

  it("preserves explicitly empty project inventories", async () => {
    const provider = providerWith(
      scriptedConnection({
        get_client_information: { success: true, version: "5.48.0" },
        open_project: {
          success: true,
          name: "empty-project",
          creation_datetime: "2026-10-12T00:00:00",
          input_files: [],
          units: [],
        },
      }),
    );

    const result = await provider.execute({
      operation: "open_jeb_project",
      input: { path: "probe.apk" },
    });

    if (!result.ok) throw result.error;
    expect(result.value.result).toMatchObject({
      input_files: [],
      units: [],
    });
  });
});

describe("JebProvider target and endpoint selection", () => {
  it("keeps the implicitly selected unit unknown when unit_path is omitted", async () => {
    const provider = providerWith(
      scriptedConnection({
        get_client_information: {
          success: true,
          version: "5.48.0",
          gui_client: false,
        },
        decompile_code_item: { success: true, text: "int x() { return 1; }" },
      }),
    );
    const result = await provider.execute({
      operation: "decompile_jeb_item",
      input: { item_address: "LFoo;->x()I", item_kind: "method" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const normalized = result.value.result as {
      readonly unit_path: string | null;
    };
    expect(normalized.unit_path).toBeNull();
    expect(result.value.limitations.join(" ")).toContain("implicitly");
  });

  it("rejects unusable endpoints at construction", () => {
    const rejection = (value: string): AnalysisInputError => {
      try {
        new JebProvider({ environment: { REA_JEB_MCP_URL: value } });
      } catch (cause) {
        if (cause instanceof AnalysisInputError) return cause;
        throw cause;
      }
      throw new Error("endpoint should have been rejected");
    };
    expect(rejection("ftp://example.invalid/mcp").cause).toMatch(
      /http and https/,
    );
    expect(rejection("http://user:pass@127.0.0.1:8425/mcp").cause).toMatch(
      /credentials/,
    );
  });
});

it("refuses remote endpoints before constructing a connection", () => {
  expect(
    () =>
      new JebProvider({
        environment: { REA_JEB_MCP_URL: "http://example.com/mcp" },
      }),
  ).toThrow(AnalysisInputError);
});

it.each(["list_jeb_units", "decompile_jeb_item"] as const)(
  "rejects an omitted successful payload for %s",
  async (operation) => {
    const provider = providerWith(
      scriptedConnection({
        get_client_information: { success: true, version: "5.48.0" },
        list_units: { success: true },
        decompile_code_item: { success: true },
      }),
    );
    const result = await provider.execute(
      operation === "list_jeb_units"
        ? { operation, input: { count: 10, index: 0 } }
        : {
            operation,
            input: { item_address: "LTest;->x()V", item_kind: "method" },
          },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(AnalysisProtocolError);
  },
);

it("forwards in-flight cancellation to the MCP call", async () => {
  const controller = new AbortController();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const provider = providerWith({
    async connect() {
      return ["get_client_information"];
    },
    async listTools() {
      return ["get_client_information"];
    },
    async close() {},
    async call(_name, _args, signal) {
      entered();
      await new Promise<void>((_resolve, reject) =>
        signal!.addEventListener(
          "abort",
          () =>
            reject(
              new AnalysisCancelledError(_name, { cause: signal!.reason }),
            ),
          { once: true },
        ),
      );
      return {};
    },
  });
  const pending = provider.execute(
    { operation: "inspect_jeb_client", input: {} },
    { signal: controller.signal },
  );
  await started;
  controller.abort();
  const result = await pending;
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toBeInstanceOf(AnalysisCancelledError);
    expect(result.error.cause).toBe(controller.signal.reason);
  }
});

it("refreshes cached unknown metadata only through an explicit information probe", async () => {
  const responses: Record<string, JsonValue> = {
    get_client_information: { success: true, gui_client: false },
    list_units: { success: true, units: [] },
  };
  const connection = scriptedConnection(responses);
  const provider = providerWith(connection);
  try {
    const first = await provider.execute({
      operation: "list_jeb_units",
      input: { count: 2, index: 0 },
    });
    if (!first.ok) throw first.error;
    expect(first.value.provider.version).toBeNull();
    responses.get_client_information = {
      success: true,
      version: "5.49.0",
      gui_client: true,
    };
    const inspected = await provider.execute({
      operation: "inspect_jeb_client",
      input: {},
    });
    if (!inspected.ok) throw inspected.error;
    const after = await provider.execute({
      operation: "list_jeb_units",
      input: { count: 2, index: 0 },
    });
    if (!after.ok) throw after.error;
    expect(after.value.provider.version).toBe("5.49.0");
    expect(after.value.result).toMatchObject({
      engine: { version: "5.49.0", gui_client: true },
    });
    expect(connection.calls.map(([name]) => name)).toEqual([
      "list_units",
      "get_client_information",
      "get_client_information",
      "list_units",
    ]);
  } finally {
    await provider.close();
  }
});

it("keeps concurrent client inspections bound to their own parsed metadata", async () => {
  const connection = scriptedConnection({});
  let replies = 0;
  connection.call = async () => ({
    success: true,
    version: `inspection-${++replies}`,
    gui_client: replies === 1,
  });
  const provider = providerWith(connection);
  try {
    const results = await Promise.all([
      provider.execute({ operation: "inspect_jeb_client", input: {} }),
      provider.execute({ operation: "inspect_jeb_client", input: {} }),
    ]);
    for (const [index, result] of results.entries()) {
      if (!result.ok) throw result.error;
      expect(result.value.provider.version).toBe(`inspection-${index + 1}`);
      expect(result.value.result).toMatchObject({
        engine: {
          version: result.value.provider.version,
          gui_client: index === 0,
        },
      });
    }
  } finally {
    await provider.close();
  }
});

it("preserves provider-authored timeout guidance when projecting the requested operation", async () => {
  const reason = new Error("selected deadline elapsed");
  const timeout = new AnalysisTimeoutError("list_units", 123, {
    cause: reason,
    userMessage: "The selected MCP request budget elapsed.",
    remediationAction: "Increase the selected MCP request budget.",
  });
  const provider = providerWith(scriptedConnection({ list_units: timeout }));
  try {
    const result = await provider.execute({
      operation: "list_jeb_units",
      input: { count: 2, index: 0 },
    });
    if (result.ok) throw new Error("Timed-out request passed");
    expect(result.error).toMatchObject({
      operation: "list_jeb_units",
      timeoutMs: 123,
      userMessage: timeout.userMessage,
      remediationAction: timeout.remediationAction,
    });
    expect(result.error.cause).toBe(reason);
  } finally {
    await provider.close();
  }
});
