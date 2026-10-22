import { expect, it } from "vitest";
import { environmentServeSource } from "../../../tests/fixtures/environmentServe.js";
import {
  environmentToolDefinitions,
  ENVIRONMENT_CATALOG_LIMIT_BYTES,
} from "../../application/environment/environmentTools.js";
import { serveEnvironment } from "./serveEnvironment.js";

it("refuses a complete oversized discovery before trying to bind", async () => {
  const source = environmentServeSource();
  const tool = source.manifest.tools[0]!;
  const manifest = {
    ...source.manifest,
    tools: [
      {
        ...tool,
        query_parameter_names: Array.from(
          { length: 10000 },
          (_, index) => `q_${index}`,
        ),
      },
    ],
  };
  const result = await serveEnvironment({
    source: { ...source, manifest },
    host: "invalid.rea.invalid",
    port: 0,
  });
  expect(result).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisResourceConstraintError",
      resource: "capacity",
      retryable: false,
      reportedLimits: { max_catalog_bytes: ENVIRONMENT_CATALOG_LIMIT_BYTES },
    },
  });
  expect(manifest.tools[0]?.query_parameter_names).toHaveLength(10000);
});

it("charges environment identity, aggregate tools and escaped text before producing a card", () => {
  const source = environmentServeSource();
  const tools = Array.from({ length: 1000 }, (_, index) => ({
    ...source.manifest.tools[0]!,
    name: `tool_${index}`,
    params: [],
    query_parameter_names: [],
  }));
  expect(
    environmentToolDefinitions({ ...source.manifest, tools }, source.evidenceId)
      .ok,
  ).toBe(false);
  expect(
    environmentToolDefinitions(
      source.manifest,
      source.evidenceId,
      "x".repeat(ENVIRONMENT_CATALOG_LIMIT_BYTES),
    ).ok,
  ).toBe(false);
  const normal = environmentToolDefinitions(source.manifest, source.evidenceId);
  expect(normal.ok).toBe(true);
  if (!normal.ok) throw normal.error;
  expect(
    Buffer.byteLength(
      JSON.stringify(
        normal.value.map(({ tool: _, ...definition }) => definition),
      ),
    ),
  ).toBeLessThan(ENVIRONMENT_CATALOG_LIMIT_BYTES);
});
