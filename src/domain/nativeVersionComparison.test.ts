import { describe, expect, it } from "vitest";
import { FUNCTION_COMPARISON_EXAMPLE } from "../contracts/functionComparisonExample.js";
import { createEvidence } from "./evidence.js";
import { functionDossierSchema } from "./hopperValues.js";
import { discoverNativeFunctionCandidates } from "./nativeVersionComparison.js";

const observation = (
  address: string,
  name: string,
  digit: string,
  assembly: string[] = [],
) => {
  const source = FUNCTION_COMPARISON_EXAMPLE.left;
  const dossier = functionDossierSchema.parse(source.normalized_result);
  return createEvidence(
    { path: `/tmp/${digit}`, sha256: digit.repeat(64), format: "mach-o" },
    source.provider,
    {
      operation: "analyze_function",
      parameters: { procedure: address },
      result: {
        ...dossier,
        assembly,
        procedure: { ...dossier.procedure, address, name },
        basic_blocks: [
          {
            start: address,
            end: `0x${(BigInt(address) + 4n).toString(16)}`,
            successors: [],
          },
        ],
      },
    },
  );
};

describe("native version candidate discovery", () => {
  it("does not pair matching names when structural facets are unavailable", () => {
    const withoutStructure = (digit: string) => {
      const source = observation("0x1000", "same_name", digit);
      const dossier = functionDossierSchema.parse(source.normalized_result);
      return createEvidence(
        { path: `/tmp/${digit}`, sha256: digit.repeat(64), format: "mach-o" },
        source.provider,
        {
          operation: "analyze_function",
          parameters: {},
          result: { ...dossier, basic_blocks: [] },
        },
      );
    };
    const result = discoverNativeFunctionCandidates(
      [withoutStructure("1")],
      [withoutStructure("2")],
      [],
    );
    expect(result.candidates).toEqual([]);
    expect(result.added_candidates).toHaveLength(1);
    expect(result.removed_candidates).toHaveLength(1);
  });
  it("automatically pairs a unique exact moved assembly representation but keeps a constant patch disputed", () => {
    const left = observation("0x1000", "old", "1", ["0x1000: add w0, w0, #7"]);
    const right = observation("0x2000", "renamed", "2", [
      "0x2000: add w0, w0, #7",
    ]);
    expect(
      discoverNativeFunctionCandidates([left], [right], [], undefined, true)
        .comparisons[0]?.selection,
    ).toBe("unique-exact-representation");
    const changed = observation("0x2000", "renamed", "2", [
      "0x2000: add w0, w0, #8",
    ]);
    expect(
      discoverNativeFunctionCandidates([left], [changed], [], undefined, true)
        .comparisons,
    ).toEqual([]);
    const duplicate = observation("0x3000", "copy", "2", [
      "0x3000: add w0, w0, #7",
    ]);
    expect(
      discoverNativeFunctionCandidates(
        [left],
        [right, duplicate],
        [],
        undefined,
        true,
      ).comparisons,
    ).toEqual([]);
  });
  it("keeps moved renamed CFG look-alikes disputed and exposes duplicate alternatives", () => {
    const result = discoverNativeFunctionCandidates(
      [observation("0x1000", "old", "1")],
      [observation("0x2000", "new", "2"), observation("0x3000", "copy", "2")],
      [],
    );
    expect(result.candidates).toHaveLength(2);
    expect(
      result.candidates.every(
        (candidate) => candidate.selection === "disputed",
      ),
    ).toBe(true);
    expect(result.ambiguous).toHaveLength(1);
    expect(result.comparisons).toEqual([]);
    expect(
      result.candidates[0]?.signals.map((signal) => signal.facet),
    ).toContain("cfg");
  });
  it("compares only the explicitly selected disputed pair using existing exact semantics", () => {
    const result = discoverNativeFunctionCandidates(
      [observation("0x1000", "old", "1")],
      [observation("0x2000", "new", "2")],
      [{ left_address: "0x1000", right_address: "0x2000" }],
    );
    expect(result.comparisons[0]?.comparison.function_match).toMatchObject({
      status: "mismatched",
      method: "explicit",
    });
  });
});
