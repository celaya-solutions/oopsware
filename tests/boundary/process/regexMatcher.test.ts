import { expect, it } from "vitest";

import { ok } from "../../../src/domain/result.js";
import { HopperRegexSearch } from "../../../src/hopper/HopperRegexSearch.js";
import { matchRegexValues } from "../../../src/process/RegexMatcher.js";

it("preserves Unicode matching order and refuses a pre-cancelled match", async () => {
  expect(
    await matchRegexValues({
      operation: "search_procedures",
      pattern: "^δ",
      caseSensitive: false,
      values: ["Δelta", "delta", "δίκη"],
    }),
  ).toEqual(ok([0, 2]));
  expect(
    await matchRegexValues({
      operation: "search_procedures",
      pattern: ".",
      caseSensitive: true,
      values: ["value"],
      signal: AbortSignal.abort(),
    }),
  ).toMatchObject({ ok: false, error: { _tag: "AnalysisCancelledError" } });
});

it("keeps Hopper's result projection and invalid-pattern contract with the shared worker", async () => {
  const search = new HopperRegexSearch({
    callTool: async () =>
      ok([
        { address: "0x10", value: "Δelta" },
        { address: "0x20", value: "other" },
      ]),
  });
  expect(
    await search.execute("search_strings", { pattern: "^δ", mode: "regex" }),
  ).toEqual(ok([{ address: "0x10", value: "Δelta" }]));
  expect(
    await search.execute("search_strings", { pattern: "[", mode: "regex" }),
  ).toMatchObject({
    ok: false,
    error: {
      _tag: "HopperRemoteError",
      code: -32000,
      diagnosticType: "invalid_request",
      operation: "search_strings",
    },
  });
  await search.close();
});
