import { describe, expect, it } from "vitest";

import {
  parseGhidraInventoryInput,
  parseGhidraInventoryResult,
} from "./GhidraInventoryValues.js";

it("validates large masked byte queries at the provider boundary without changing caller spelling", () => {
  const input = {
    pattern: "aA??".repeat(1024 * 1024),
    mask: "ff00".repeat(1024 * 1024),
  };
  const parsed = parseGhidraInventoryInput("search_bytes", input);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw parsed.error;
  expect(parsed.value.pattern === input.pattern).toBe(true);
  expect(parsed.value.mask === input.mask).toBe(true);
  expect(
    parseGhidraInventoryInput("search_bytes", {
      ...input,
      mask: `${input.mask.slice(0, -2)}g0`,
    }).ok,
  ).toBe(false);
  expect(
    parseGhidraInventoryInput("search_bytes", {
      ...input,
      mask: "00ff".repeat(1024 * 1024),
    }).ok,
  ).toBe(false);
});

describe("provider-owned overview boundary", () => {
  const overview = {
    document: "fixture",
    segments: [],
    procedure_count: 0,
    string_count: 0,
  };

  it("keeps exact empty counts and an observed empty segment set", () => {
    expect(
      parseGhidraInventoryInput("read_binary_inventory_summary", {}),
    ).toEqual({
      ok: true,
      value: {},
    });
    expect(
      parseGhidraInventoryInput("read_binary_inventory_summary", {
        document: "other",
      }).ok,
    ).toBe(false);
    expect(
      parseGhidraInventoryResult("read_binary_inventory_summary", overview),
    ).toEqual({
      ok: true,
      value: { value: { ...overview, segment_count: 0 }, rawResult: overview },
    });
  });

  it("keeps the independent segment permissions and provenance behind an overview", () => {
    const reported = {
      ...overview,
      segments: [
        {
          name: ".text",
          start: "0x1000",
          end: "0x100f",
          readable: true,
          writable: false,
          executable: true,
          permissions: { available: true, source: "ghidra-memory-block" },
          provenance: "ghidra-memory-block",
          address_space: "ram",
          image_base: "0x1000",
          initialized: true,
          overlay: false,
          sections: [],
        },
      ],
    };
    const parsed = parseGhidraInventoryResult(
      "read_binary_inventory_summary",
      reported,
    );
    if (!parsed.ok) throw parsed.error;
    expect(parsed.value.rawResult).toEqual(reported);
    expect(parsed.value.value).toMatchObject({
      procedure_count: 0,
      string_count: 0,
      segments: [{ name: ".text", start: "0x1000", end: "0x100f" }],
    });
  });

  it.each([
    { procedure_count: -1 },
    { string_count: 1.5 },
    { procedure_count: Number.MAX_SAFE_INTEGER + 1 },
    { string_count: null },
    { document: "" },
    { segments: [{ name: "incomplete" }] },
    { extra: "unexpected" },
  ])("rejects malformed aggregates before creating Evidence: %j", (change) => {
    expect(
      parseGhidraInventoryResult("read_binary_inventory_summary", {
        ...overview,
        ...change,
      }).ok,
    ).toBe(false);
  });
});

// Wire-boundary fixture only; real-provider acceptance belongs to the DOS verifier.
describe("containing-procedure complete body evidence", () => {
  const identity = () => ({
    address: "0x1000",
    name: "fixture_function",
    classification: {
      external: false,
      thunk: false,
      thunk_target: null,
      provenance: "ghidra-function-manager",
    },
    body: {
      available: true,
      provenance: "ghidra-function-body-address-set",
      ranges: [
        { start: "0x1000", end: "0x1002" },
        { start: "0x1020", end: "0x1021" },
      ],
      total_bytes: 5,
      span_bytes: 34,
      non_contiguous: true,
      contains_entry: true,
    },
  });
  const found = () => ({
    query_address: "0x1001",
    found: true,
    procedure: identity(),
  });
  it("rejects a missing body rather than treating a legacy identity as complete", () => {
    const { body: omitted, ...legacy } = identity();
    expect(omitted.total_bytes).toBe(5);
    expect(
      parseGhidraInventoryResult("resolve_containing_procedure", {
        ...found(),
        procedure: legacy,
      }).ok,
    ).toBe(false);
  });
  it.each([
    { total_bytes: 34 },
    { span_bytes: 5 },
    { contains_entry: false },
    { provenance: "unreviewed" },
    {
      ranges: [
        { start: "0x1000", end: "0x1002" },
        { start: "bad space:0x1020", end: "bad space:0x1021" },
      ],
      span_bytes: null,
    },
    { non_contiguous: false },
    { ranges: [{ start: "0X1000", end: "0x1002" }] },
    {
      ranges: [
        { start: "0x1000", end: "0x1002" },
        { start: "0x1002", end: "0x1004" },
      ],
    },
  ])("rejects malformed or contradictory body evidence %j", (change) => {
    const procedure = identity();
    expect(
      parseGhidraInventoryResult("resolve_containing_procedure", {
        ...found(),
        procedure: { ...procedure, body: { ...procedure.body, ...change } },
      }).ok,
    ).toBe(false);
  });
  it("accepts canonically encoded address-space endpoints with an unknown enclosing span", () => {
    const procedure = identity();
    const body = {
      ...procedure.body,
      ranges: [
        { start: "0x1000", end: "0x1002" },
        { start: "other%20space:0x1020", end: "other%20space:0x1021" },
      ],
      span_bytes: null,
    };
    expect(
      parseGhidraInventoryResult("resolve_containing_procedure", {
        ...found(),
        procedure: { ...procedure, body },
      }).ok,
    ).toBe(true);
  });

  it("does not accept a found query that lies in the gap between body ranges", () => {
    expect(
      parseGhidraInventoryResult("resolve_containing_procedure", {
        ...found(),
        query_address: "0x1010",
      }).ok,
    ).toBe(false);
  });
});
