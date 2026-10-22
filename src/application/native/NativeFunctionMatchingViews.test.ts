import { expect, it } from "vitest";
import { matchNativeFunctions } from "./NativeFunctionMatchingService.js";
import { inspectAnalysisView } from "../analysisView/AnalysisViewService.js";
import { nativeMatchingInventory } from "../../../tests/fixtures/nativeFunctionMatching.js";
import { analysisViewResultSchema } from "../../domain/analysisView/analysisView.js";

it("pages individual function facts without transferring an entire ambiguous alias group, preserving mandatory identity and source coverage", async () => {
  const entries = Array.from({ length: 500 }, (_, i) => ({
    address: `0x${i.toString(16)}`,
    value: "same",
  }));
  const matched = await matchNativeFunctions({
    left: nativeMatchingInventory("1", entries),
    right: nativeMatchingInventory("2", entries),
  });
  if (!matched.ok) throw matched.error;
  const source = { kind: "inline", evidence: matched.value.evidence };
  const view = (query: unknown) => {
    const result = inspectAnalysisView({ source, view: query });
    if (!result.ok) throw result.error;
    return analysisViewResultSchema.parse(result.value.normalized_result);
  };
  const groups = view({
    kind: "function-matches",
    collection: "matches",
    fields: ["basis"],
    limit: 1,
  });
  expect(groups).toMatchObject({
    kind: "function-matches",
    coverage: { examined: 1, total: 1, exhausted: true },
    items: [
      { state: "unresolved", basis: null, left_count: 500, right_count: 500 },
    ],
  });
  if (groups.kind !== "function-matches") throw new Error("Wrong view");
  expect(groups.items[0]).not.toHaveProperty("left");
  const member = `${matched.value.sources[0]!.evidence_id}/123`;
  const functions = view({
    kind: "function-matches",
    collection: "functions",
    function_ids: [member],
    fields: ["name"],
    limit: 1,
  });
  expect(functions).toMatchObject({
    kind: "function-matches",
    coverage: { examined: 1, total: 1, exhausted: true },
    items: [
      {
        function_id: member,
        source_index: 123,
        address: "0x7b",
        name: "same",
        side: "left",
        state: "unresolved",
        evidence_links: [matched.value.sources[0]!.evidence_id],
      },
    ],
  });
  expect(JSON.stringify(functions).length).toBeLessThan(6000);
  expect(
    view({
      kind: "function-matches",
      collection: "functions",
      names: [],
      limit: 1,
    }),
  ).toMatchObject({ coverage: { total: 0 } });
  expect(
    view({
      kind: "function-matches",
      collection: "functions",
      names: ["same"],
      sides: ["left"],
      limit: 1,
    }),
  ).toMatchObject({ coverage: { total: 500, next_offset: 1 } });
  expect(
    view({
      kind: "function-matches",
      collection: "functions",
      sides: ["right"],
      offset: 499,
      limit: 2,
    }),
  ).toMatchObject({
    coverage: { examined: 1, total: 500, exhausted: true, next_offset: null },
  });
  expect(
    view({ kind: "function-matches", collection: "functions", states: [] }),
  ).toMatchObject({ coverage: { total: 0, exhausted: true } });
  expect(view({ kind: "summary" })).toMatchObject({
    summary: {
      scope: "provider-observed-inputs",
      summary: { unresolved: 1 },
      left: { functions: 500 },
      right: { functions: 500 },
    },
  });
});
