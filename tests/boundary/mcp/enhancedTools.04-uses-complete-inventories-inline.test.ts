import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  closeEnhancedToolResources,
  connect as connectTool,
  jsonResult,
} from "./enhancedToolsHarness.js";
import type {
  AnalysisExecution,
  AnalysisOperationPort,
} from "../../../src/application/AnalysisProvider.js";
import type { AnalysisError } from "../../../src/domain/analysisErrorBase.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisProtocolError,
} from "../../../src/domain/analysisErrorCore.js";
import { err, type Result } from "../../../src/domain/result.js";
import { observed as ok } from "../../fixtures/analysisExecution.js";

afterEach(closeEnhancedToolResources);

// These fixtures exercise composition for providers without a native overview.
const connect = (analysis: AnalysisOperationPort) =>
  connectTool({
    execute: (operation, parameters, options) =>
      operation === "read_binary_inventory_summary"
        ? Promise.resolve(
            err(
              new AnalysisCapabilityUnavailableError(
                "fixture",
                operation,
                "No native overview",
              ),
            ),
          )
        : analysis.execute(operation, parameters, options),
  });

it("discovers declarations without counting duplicates or compiler bookkeeping", async () => {
  const client = await connect({
    execute: (name) => {
      expect(name).toBe("list_names");
      return Promise.resolve(
        ok([
          { address: "0x1", value: "_OBJC_CLASS_$_First" },
          { address: "0x2", value: "_OBJC_CLASS_$_Last" },
          { address: "0x3", value: "_OBJC_CLASS_$_First" },
          { address: "0x4", value: "__OBJC_CLASS_RO_$_First" },
          { address: "0x5", value: "_OBJC_CLASSLIST_REFERENCES_$_" },
          { address: "0x6", value: "l_OBJC_CLASS_NAME_" },
          { address: "0x7", value: "_OBJC_IVAR_$_First.value" },
          { address: "0x8", value: "_OBJC_METACLASS_$_First" },
          { address: "0x9", value: "_OBJC_PROP_$_First.value" },
          { address: "0xa", value: "__OBJC_PROTOCOL_$_Delegate" },
          { address: "0xb", value: "__OBJC_PROTOCOL_$_Delegate" },
          { address: "0xc", value: "__OBJC_PROTOCOL_REFERENCE_$_Delegate" },
          { address: "0xd", value: "_$s4main7ScoringMp" },
          { address: "0xe", value: "_$s4main7ScoringTL" },
          { address: "0xf", value: "_$s4main7ScoringP5scoreSiyFTq" },
          { address: "0x10", value: "l_OBJC_CLASS_Legacy" },
          { address: "0x11", value: "l_OBJC_CLASS_NAME_.1" },
        ]),
      );
    },
  });
  const result = jsonResult(
    await client.callTool({ name: "get_objc_classes", arguments: {} }),
  );
  expect(result).toMatchObject({
    count: 3,
    classes: [
      { address: "0x1", name: "_OBJC_CLASS_$_First" },
      { address: "0x2", name: "_OBJC_CLASS_$_Last" },
      { address: "0x10", name: "l_OBJC_CLASS_Legacy" },
    ],
  });
  expect(
    jsonResult(
      await client.callTool({
        name: "get_objc_classes",
        arguments: { pattern: "First" },
      }),
    ),
  ).toMatchObject({
    count: 1,
    classes: [{ address: "0x1", name: "_OBJC_CLASS_$_First" }],
  });
  expect(
    jsonResult(
      await client.callTool({ name: "get_objc_protocols", arguments: {} }),
    ),
  ).toMatchObject({
    count: 2,
    protocols: [
      { address: "0xa", name: "__OBJC_PROTOCOL_$_Delegate" },
      { address: "0xd", name: "_$s4main7ScoringMp" },
    ],
  });
});

it("discovers stripped Hopper class labels through MCP with literal filtering", async () => {
  const names = [
    "__objc_class_HuntRoot_class",
    "__objc_class_HuntSub_class",
    "__objc_class_HuntWorker_class",
    "__objc_class_HuntModel_class",
    "__objc_class_HuntLegacy_class",
    "prefix__objc_class_HuntForeign_class",
    "__objc_class__class",
    "__objc_class_HuntMissingSuffix",
  ];
  const client = await connect({
    execute: (name) => {
      expect(name).toBe("list_names");
      return Promise.resolve(
        ok(
          names.map((value, index) => ({
            address: `0x${index + 1}`,
            value,
            ...(index < 5
              ? { objc_class_label: "hopper_legacy_class_object" }
              : {}),
          })),
        ),
      );
    },
  });

  const all = jsonResult(
    await client.callTool({ name: "get_objc_classes", arguments: {} }),
  );
  expect(all).toMatchObject({
    count: 5,
    classes: names.slice(0, 5).map((name, index) => ({
      address: `0x${index + 1}`,
      name,
    })),
  });

  const filtered = jsonResult(
    await client.callTool({
      name: "get_objc_classes",
      arguments: { pattern: "__objc_class_HuntRoot_class" },
    }),
  );
  expect(filtered).toMatchObject({
    count: 1,
    classes: [{ address: "0x1", name: "__objc_class_HuntRoot_class" }],
  });
});

const completeOverviewPort: AnalysisOperationPort = {
  execute: (name) => {
    switch (name) {
      case "list_segments":
        return Promise.resolve(
          ok([
            {
              name: "__TEXT",
              start: "0x1000",
              end: "0x1800",
              image_base: "0x1000",
              readable: null,
              writable: null,
              executable: null,
            },
            {
              name: "__DATA",
              start: "0x1800",
              end: "0x2000",
              image_base: "0x1000",
              readable: null,
              writable: null,
              executable: null,
            },
          ]),
        );
      case "current_document":
        return Promise.resolve(ok("fixture"));
      case "list_documents":
        return Promise.resolve(ok(["New Document", "fixture"]));
      case "list_strings":
        return Promise.resolve(
          ok(
            Array.from({ length: 700 }, (_, index) => ({
              address: `0x${(0x30 + index).toString(16)}`,
              value: `string-${index}`,
            })),
          ),
        );
      case "list_procedures": {
        return Promise.resolve(
          ok([
            { address: "0x1", value: "first" },
            { address: "0x2", value: "last" },
          ]),
        );
      }
      default:
        throw new Error(`Unexpected analysis operation: ${name}`);
    }
  },
};

describe("enhanced MCP binary overview", () => {
  it("returns the complete overview inline with exhaustive totals", async () => {
    const client = await connect(completeOverviewPort);
    const result = jsonResult(
      await client.callTool({
        name: "binary_overview",
        arguments: {},
      }),
    );
    expect(result).toEqual({
      document: "fixture",
      image_base: "0x1000",
      segments: [
        {
          name: "__TEXT",
          start: "0x1000",
          end: "0x1800",
          length: 2048,
          image_base: "0x1000",
        },
        {
          name: "__DATA",
          start: "0x1800",
          end: "0x2000",
          length: 2048,
          image_base: "0x1000",
        },
      ],
      segment_count: 2,
      procedure_count: 2,
      string_count: 700,
    });
  });

  it("returns binary counts while omitting unavailable segment coverage", async () => {
    const client = await connect({
      execute: (name) => {
        if (name === "current_document")
          return Promise.resolve(
            err(
              new AnalysisCapabilityUnavailableError(
                "fixture",
                name,
                "the provider has one bound document",
              ),
            ),
          );
        if (name === "list_documents")
          return Promise.resolve(ok(["/tmp/fixture.bin"]));
        if (name === "list_segments")
          return Promise.resolve(
            err(
              new AnalysisCapabilityUnavailableError(
                "fixture",
                name,
                "segment enumeration is unsupported",
              ),
            ),
          );
        if (name === "list_procedures" || name === "list_strings")
          return Promise.resolve(ok([]));
        throw new Error(`Unexpected analysis operation: ${name}`);
      },
    });

    expect(
      jsonResult(
        await client.callTool({ name: "binary_overview", arguments: {} }),
      ),
    ).toEqual({
      document: "/tmp/fixture.bin",
      procedure_count: 0,
      string_count: 0,
    });
  });
});

describe("enhanced MCP inventory validation", () => {
  it("rejects paginated provider output", async () => {
    const client = await connect({
      execute: () =>
        Promise.resolve(
          ok({
            items: [{ address: "0x1", value: "_TtC5First" }],
          }),
        ),
    });
    const result = await client.callTool({
      name: "analyze_swift_types",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    const text = result.content.find((item) => item.type === "text");
    expect(text?.type === "text" ? text.text : "").toBe(
      JSON.stringify(parseMcpToolError(result)),
    );
  });

  it("rejects a segment with omitted coordinates instead of reporting zero length", async () => {
    const client = await connect({
      execute: (name) => {
        if (name === "list_segments")
          return Promise.resolve(
            ok([
              {
                name: "__TEXT",
                end: "0x2000",
                readable: null,
                writable: null,
                executable: null,
              },
            ]),
          );
        if (name === "current_document") return Promise.resolve(ok("fixture"));
        if (name === "list_procedures" || name === "list_strings")
          return Promise.resolve(ok([]));
        throw new Error(`Unexpected analysis operation: ${name}`);
      },
    });
    const result = await client.callTool({
      name: "binary_overview",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContainEqual({
      type: "text",
      text: JSON.stringify(parseMcpToolError(result)),
    });
  });

  it("preserves unknown length for malformed segment coordinates", async () => {
    const client = await connect({
      execute: (name) => {
        if (name === "list_segments")
          return Promise.resolve(
            ok([
              {
                name: "__TEXT",
                start: "unparsed-start",
                end: "0x2000",
                readable: null,
                writable: null,
                executable: null,
              },
            ]),
          );
        if (name === "current_document") return Promise.resolve(ok("fixture"));
        if (name === "list_procedures" || name === "list_strings")
          return Promise.resolve(ok([]));
        throw new Error(`Unexpected analysis operation: ${name}`);
      },
    });
    expect(
      jsonResult(
        await client.callTool({ name: "binary_overview", arguments: {} }),
      ),
    ).toMatchObject({
      segments: [{ name: "__TEXT", start: "unparsed-start", length: null }],
      segment_count: 1,
    });
  });
});

const overviewPort = (
  current: Result<AnalysisExecution, AnalysisError>,
  documents: readonly string[],
): AnalysisOperationPort => ({
  execute: (name) => {
    switch (name) {
      case "current_document":
        return Promise.resolve(current);
      case "list_documents":
        return Promise.resolve(ok([...documents]));
      case "list_segments":
        return Promise.resolve(
          ok([
            {
              name: "text",
              start: "0x1000",
              end: "0x2000",
              readable: null,
              writable: null,
              executable: null,
            },
          ]),
        );
      case "list_procedures":
      case "list_strings":
        return Promise.resolve(ok([]));
      default:
        throw new Error(`Unexpected analysis operation: ${name}`);
    }
  },
});

describe("overview document identity through MCP", () => {
  const unsupported = () =>
    err(
      new AnalysisCapabilityUnavailableError(
        "fixture",
        "current_document",
        "headless provider",
      ),
    );

  it("uses the sole headless document when current-document selection is unsupported", async () => {
    const client = await connect(
      overviewPort(unsupported(), ["single-target"]),
    );
    expect(
      jsonResult(
        await client.callTool({ name: "binary_overview", arguments: {} }),
      ),
    ).toMatchObject({ document: "single-target" });
  });

  it.each([
    { documents: [] },
    { documents: [""] },
    { documents: ["one", "two"] },
  ])(
    "rejects ambiguous or missing headless identities: $documents",
    async ({ documents }) => {
      const client = await connect(overviewPort(unsupported(), documents));
      expect(
        (await client.callTool({ name: "binary_overview", arguments: {} }))
          .isError,
      ).toBe(true);
    },
  );

  it.each([{ value: null }, { value: "" }, { value: [] }])(
    "rejects a malformed current-document result: $value",
    async ({ value }) => {
      const client = await connect(
        overviewPort(ok(value), ["fallback-must-not-hide-error"]),
      );
      expect(
        (await client.callTool({ name: "binary_overview", arguments: {} }))
          .isError,
      ).toBe(true);
    },
  );

  it("preserves non-capability current-document failures", async () => {
    const client = await connect(
      overviewPort(
        err(new AnalysisProtocolError("failed current-document transport")),
        ["must-not-be-selected"],
      ),
    );
    expect(
      (await client.callTool({ name: "binary_overview", arguments: {} }))
        .isError,
    ).toBe(true);
  });

  it("reports document selection unavailable when neither current-document nor list-documents is supported", async () => {
    const client = await connect({
      execute: (name) => {
        if (name === "current_document" || name === "list_documents")
          return Promise.resolve(
            err(
              new AnalysisCapabilityUnavailableError(
                "fixture",
                name,
                "provider lacks document selection",
              ),
            ),
          );
        if (name === "list_segments") return Promise.resolve(ok([]));
        if (name === "list_procedures" || name === "list_strings")
          return Promise.resolve(ok([]));
        throw new Error(`Unexpected analysis operation: ${name}`);
      },
    });
    const result = await client.callTool({
      name: "binary_overview",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(parseMcpToolError(result).error).toMatchObject({
      code: "capability_unavailable",
      details: {
        provider_id: "fixture",
        operation: "list_documents",
        reason: expect.stringContaining("provider lacks document selection"),
      },
    });
  });
});

it("refuses document fallback while the current-selection owner reports incomplete cleanup", async () => {
  const failure = new AnalysisCapabilityUnavailableError(
    "fixture",
    "current_document",
    "Selection unavailable during cleanup",
    {
      cleanup: {
        reason: "controlled live selection resource",
        resources: ["selection owner"],
      },
    },
  );
  const calls: string[] = [];
  const client = await connect({
    execute: async (operation) => {
      calls.push(operation);
      return operation === "current_document"
        ? err(failure)
        : ok(["must-not-be-selected"]);
    },
  });
  const response = await client.callTool({
    name: "binary_overview",
    arguments: {},
  });
  expect(response.isError).toBe(true);
  expect(parseMcpToolError(response).error).toMatchObject({
    code: "cleanup_incomplete",
    details: { operation: "current_document" },
  });
  expect(calls).toEqual(["current_document"]);
  expect(failure.cleanupIncomplete).toBe(true);
});
