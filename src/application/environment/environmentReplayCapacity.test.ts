import { expect, it } from "vitest";
import { environmentServeSourceWithBody } from "../../../tests/fixtures/environmentServe.js";
import {
  replayEnvironmentTool,
  selectReplayExchange,
} from "./environmentReplay.js";

it("matches a late repeated query and a distant path coordinate without full tuple/segment arrays", () => {
  const source = environmentServeSourceWithBody("{}", "application/json");
  const original = source.manifest.tools.find(
    (tool) => tool.name === "get_users_by_id",
  )!;
  const ordinal = original.record_ordinals[0]!;
  const exchange = source.exchanges.get(ordinal)!;
  const tool = {
    ...original,
    params: [{ ...original.params[0]!, index: 20000 }],
    query_parameter_names: ["q"],
  };
  const retained = {
    ...exchange,
    path: `/${"literal/".repeat(20000)}wanted`,
    query: `?${"q=miss&".repeat(20000)}q=hit`,
  };
  expect(
    selectReplayExchange(tool, new Map([[ordinal, retained]]), {
      id: "wanted",
      q: "hit",
    }),
  ).toEqual({ exchange: retained, exact: true });
});

it("bounds content-type display without changing body interpretation or retained source", () => {
  const contentType = `application/json;${"x".repeat(100000)}`;
  const source = environmentServeSourceWithBody('{"value":1}', contentType);
  const tool = source.manifest.tools.find(
    (tool) => tool.name === "get_users_by_id",
  )!;
  const result = replayEnvironmentTool(source, tool, { id: "2" });
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  expect(result.value.body).toEqual({ value: 1 });
  expect(
    Buffer.byteLength(result.value.content_type ?? ""),
  ).toBeLessThanOrEqual(1024);
  expect(result.value.replay.content_type_truncated).toBe(true);
  expect(source.exchanges.get(tool.record_ordinals[0]!)?.contentType).toBe(
    contentType,
  );
});
