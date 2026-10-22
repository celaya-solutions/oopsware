import { createEmptyIl2cppMetadataFixture } from "../il2cpp/il2cppMetadata.fixture.js";
import { afterEach, expect, it, vi } from "vitest";
import {
  il2cppMetadataParentSchema,
  type Il2cppMetadata,
} from "../il2cpp/il2cppMetadata.js";
import { createEvidence } from "../evidence.js";
import { freezeJsonSnapshot } from "../immutableJson.js";
import { jsonObjectSchema } from "../jsonValue.js";
import { projectIl2cppMetadataView } from "./il2cppMetadataView.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const report: Il2cppMetadata = {
  ...createEmptyIl2cppMetadataFixture(),
  images: [{ name: "A.dll", type_start: 0, type_count: 2 }],
  types: [
    {
      name: "Outer",
      namespace: "N",
      method_start: 0,
      method_count: 1,
      nested_type_start: 0,
      nested_type_count: 1,
      declaring_type: -1,
    },
    {
      name: "Inner",
      namespace: "",
      method_start: -1,
      method_count: 0,
      nested_type_start: -1,
      nested_type_count: 0,
      declaring_type: 0,
    },
  ],
  methods: [{ name: "Run", declaring_type: 0 }],
  fields: [{ name: "value", declaring_type: 0 }],
  properties: [],
  events: [],
  parameters: [{ name: "times", method: 0 }],
  string_literals: [{ value: "Go", value_base64: null }],
  binary: null,
  method_addresses: [],
  return_types: [],
  field_types: [],
  parameter_types: [],
  limitations: [],
};

const parent = (normalizedResult: unknown, sealedResult: boolean) => ({
  evidenceId: `ev_${"b".repeat(64)}`,
  operation: "inspect_il2cpp_metadata",
  normalizedResult,
  sealedResult,
  limitations: [],
});

const summarize = (source: ReturnType<typeof parent>) => {
  const result = projectIl2cppMetadataView(source, { kind: "summary" });
  if (!result.ok) throw result.error;
  return result.value;
};

const page = {
  kind: "il2cpp-metadata",
  collection: "types",
  offset: 0,
  limit: 1,
} as const;

it("validates a sealed parent once across pages and keeps counts exact", () => {
  const parse = vi.spyOn(il2cppMetadataParentSchema, "safeParse");
  const sealed = parent(freezeJsonSnapshot(structuredClone(report)), true);
  for (const offset of [0, 1]) {
    const view = projectIl2cppMetadataView(sealed, { ...page, offset });
    if (!view.ok) throw view.error;
    expect(view.value).toMatchObject({
      items: [{ index: offset, ...report.types[offset] }],
      counts: {
        sections: report.sections.length,
        images: 1,
        types: 2,
        methods: 1,
        nested_types: 1,
        fields: 1,
        properties: 0,
        events: 0,
        parameters: 1,
        string_literals: 1,
        method_addresses: null,
        return_types: null,
        field_types: null,
        parameter_types: null,
      },
    });
  }
  expect(parse).toHaveBeenCalledTimes(1);
});

it("revalidates unsealed inline input on every page", () => {
  const parse = vi.spyOn(il2cppMetadataParentSchema, "safeParse");
  const inline = parent(structuredClone(report), false);
  projectIl2cppMetadataView(inline, page);
  projectIl2cppMetadataView(inline, page);
  expect(parse).toHaveBeenCalledTimes(2);
});

it("preserves historical omission as unknown while keeping existing metadata queries usable", () => {
  const historical = jsonObjectSchema.parse(report);
  for (const key of [
    "fields",
    "properties",
    "events",
    "parameters",
    "string_literals",
  ])
    delete historical[key];
  const source = parent(freezeJsonSnapshot(historical), true);
  const summary = summarize(source);
  expect(summary).toMatchObject({
    summary: {
      counts: { types: 2, methods: 1, fields: null, parameters: null },
    },
    unknowns: expect.arrayContaining([
      expect.stringContaining("did not collect fields"),
    ]),
  });
  const existing = projectIl2cppMetadataView(source, page);
  if (!existing.ok) throw existing.error;
  expect(existing.value).toMatchObject({
    items: [{ index: 0, name: "Outer" }],
  });
  const unavailable = projectIl2cppMetadataView(source, {
    kind: "il2cpp-metadata",
    collection: "parameters",
    offset: 0,
    limit: 1,
  });
  expect(unavailable.ok).toBe(false);
});

it("treats Evidence retained before binary linking as unknown, not unlinked", () => {
  const historical = jsonObjectSchema.parse(report);
  for (const key of [
    "binary",
    "method_addresses",
    "return_types",
    "field_types",
    "parameter_types",
  ])
    delete historical[key];
  const source = parent(freezeJsonSnapshot(historical), true);
  const summary = summarize(source);
  expect(summary).not.toHaveProperty("summary.binary");
  expect(summary).toMatchObject({
    summary: {
      counts: {
        fields: 1,
        method_addresses: null,
        method_address_states: null,
        return_types: null,
      },
    },
    unknowns: expect.arrayContaining([
      expect.stringContaining("did not collect method_addresses"),
    ]),
  });
  expect(projectIl2cppMetadataView(source, page).ok).toBe(true);
  const unavailable = projectIl2cppMetadataView(source, {
    kind: "il2cpp-metadata",
    collection: "method_addresses",
    offset: 0,
    limit: 1,
  });
  expect(unavailable.ok).toBe(false);
  const current = projectIl2cppMetadataView(parent(report, false), {
    kind: "summary",
  });
  if (!current.ok) throw current.error;
  expect(current.value).toMatchObject({
    summary: {
      binary: null,
      counts: {
        method_addresses: null,
        method_address_states: null,
        return_types: null,
      },
    },
  });
  expect(
    projectIl2cppMetadataView(parent(report, false), {
      kind: "il2cpp-metadata",
      collection: "method_addresses",
      offset: 0,
      limit: 64,
    }).ok,
  ).toBe(false);
});

const linkedBinary = {
  artifact: {
    path: "/fixture/libil2cpp.so",
    sha256: "c".repeat(64),
    bytes: 64,
  },
  format: "elf" as const,
  architecture: "arm64",
  image_base: "0x0",
  code_gen_modules_field: "0x10",
  code_gen_modules_array: "0x20",
  code_gen_modules: [],
  types_field: "0x30",
  types_count: 4,
};

it("selects parameter types by owning method through the parameters collection", () => {
  const linked = {
    ...report,
    parameters: [
      { name: "a", method: 0 },
      { name: "b", method: 0 },
    ],
    binary: { ...linkedBinary },
    method_addresses: report.methods.map(() => ({
      state: "no-body" as const,
      address: null,
      rva: null,
    })),
    return_types: report.methods.map(() => ({ type: -1, name: null })),
    field_types: report.fields.map(() => ({ type: 1, name: "int" })),
    parameter_types: [
      { type: 2, name: "string" },
      { type: 3, name: "bool" },
    ],
  };
  const select = (
    source: ReturnType<typeof parent>,
    method_indices: number[],
  ) =>
    projectIl2cppMetadataView(source, {
      kind: "il2cpp-metadata",
      collection: "parameter_types",
      method_indices,
      offset: 0,
      limit: 8,
    });
  const owned = select(parent(linked, false), [0]);
  if (!owned.ok) throw owned.error;
  expect(owned.value).toMatchObject({
    items: [
      { index: 0, type: 2, name: "string" },
      { index: 1, type: 3, name: "bool" },
    ],
  });
  const none = select(parent(linked, false), [1]);
  if (!none.ok) throw none.error;
  expect(none.value).toMatchObject({ items: [] });
  // Without retained parameters the owners are unknown, so the filter is refused.
  const historical = jsonObjectSchema.parse(linked);
  delete historical.parameters;
  expect(select(parent(freezeJsonSnapshot(historical), true), [0]).ok).toBe(
    false,
  );
});

it.each([{ method_addresses: undefined }, { binary: undefined }])(
  "rejects a binary link field retained without its collections: %j",
  (changed) => {
    const result = projectIl2cppMetadataView(
      parent({ ...report, ...changed }, false),
      { kind: "summary" },
    );
    expect(result.ok).toBe(false);
  },
);

it.each([
  { fields: [{ name: "bad", declaring_type: 2 }] },
  { parameters: [{ name: "bad", method: 1 }] },
  { string_literals: [{ value: null, value_base64: null }] },
  { string_literals: [{ value: "Go", value_base64: "R28=" }] },
])(
  "rejects inconsistent member ownership or literal representation in authenticated parent facts: %j",
  (changed) => {
    const result = projectIl2cppMetadataView(
      parent({ ...report, ...changed }, false),
      { kind: "summary" },
    );
    expect(result.ok).toBe(false);
  },
);

it("selects a batch of parameter owners before paging and intersects exact identities and names", () => {
  const source = parent(
    freezeJsonSnapshot({
      ...report,
      parameters: [
        { name: "first", method: 0 },
        { name: "unclaimed", method: -1 },
        { name: "last", method: 0 },
      ],
    }),
    true,
  );
  const query = {
    kind: "il2cpp-metadata",
    collection: "parameters",
    method_indices: [0, 0, 99],
    fields: ["name", "method"],
    offset: 1,
    limit: 1,
  } as const;
  const result = projectIl2cppMetadataView(source, {
    ...query,
    method_indices: [...query.method_indices],
    fields: [...query.fields],
  });
  if (!result.ok) throw result.error;
  expect(result.value).toMatchObject({
    items: [{ index: 2, name: "last", method: 0 }],
    coverage: { total: 2, exhausted: true, next_offset: null },
  });
  for (const selection of [
    { method_indices: [] },
    { method_indices: [99] },
    { method_indices: [0], indices: [1] },
    { method_indices: [0], names: ["unclaimed"] },
  ]) {
    const empty = projectIl2cppMetadataView(source, {
      ...query,
      ...selection,
      offset: 0,
      fields: [...query.fields],
    });
    if (!empty.ok) throw empty.error;
    expect(empty.value).toMatchObject({
      items: [],
      coverage: { total: 0, exhausted: true },
    });
  }
});

it("intersects batch identities, fields, image ranges and exact names in source order", () => {
  const source = parent(freezeJsonSnapshot(structuredClone(report)), true);
  const result = projectIl2cppMetadataView(source, {
    ...page,
    indices: [1, 0, 1, 100],
    image_indices: [0],
    names: ["Inner"],
    namespaces: [""],
    declaring_types: [0],
    fields: ["name"],
  });
  if (!result.ok) throw result.error;
  expect(result.value).toMatchObject({
    items: [{ index: 1, name: "Inner" }],
    coverage: { total: 1, exhausted: true },
    counts: { images: 1, types: 2, methods: 1 },
  });
  const identityOnly = projectIl2cppMetadataView(source, {
    ...page,
    fields: [],
  });
  if (!identityOnly.ok) throw identityOnly.error;
  expect(identityOnly.value).toMatchObject({ items: [{ index: 0 }] });
});

it.each([
  "indices",
  "image_indices",
  "names",
  "namespaces",
  "declaring_types",
] as const)("keeps an empty %s selection empty", (field) => {
  const result = projectIl2cppMetadataView(parent(report, false), {
    ...page,
    [field]: [],
  });
  if (!result.ok) throw result.error;
  expect(result.value).toMatchObject({
    items: [],
    coverage: { total: 0, exhausted: true },
  });
});

it("does not trust a forged seal flag or a shallow frozen mutable report", () => {
  const mutable = structuredClone(report);
  Object.freeze(mutable);
  const source = parent(mutable, true);
  const first = projectIl2cppMetadataView(source, page);
  if (!first.ok) throw first.error;
  mutable.types[0]!.name = "Changed";
  const second = projectIl2cppMetadataView(source, page);
  if (!second.ok) throw second.error;
  expect(second.value).toMatchObject({
    items: [{ index: 0, name: "Changed" }],
  });
});

it("refuses a parent whose subject contradicts the recorded artifact identity", () => {
  const result = projectIl2cppMetadataView(
    {
      ...parent(report, false),
      subject: createEvidence(
        { path: report.artifact.path, format: "file", sha256: "c".repeat(64) },
        { id: "fixture", name: "fixture", version: "1" },
        {
          operation: "inspect_il2cpp_metadata",
          parameters: {},
          result: report,
        },
      ).subject,
    },
    page,
  );
  expect(result.ok).toBe(false);
});

const linkedReport = (): Il2cppMetadata => ({
  ...structuredClone(report),
  types: report.types.map((type, index) => ({
    ...type,
    method_start: index * 2,
    method_count: 2,
  })),
  methods: [
    { name: "A", declaring_type: 0 },
    { name: "B", declaring_type: 0 },
    { name: "Abstract", declaring_type: 1 },
    { name: "Unresolved", declaring_type: 1 },
  ],
  binary: {
    artifact: {
      path: "/artifacts/GameAssembly.dll",
      sha256: "c".repeat(64),
      bytes: 4096,
    },
    format: "pe",
    architecture: "amd64",
    image_base: "0x1000",
    code_gen_modules_field: "0x1200",
    code_gen_modules_array: "0x1300",
    code_gen_modules: [
      { image: 0, address: "0x1400", method_pointer_count: 4 },
    ],
    types_field: "0x1500",
    types_count: 1,
  },
  method_addresses: [
    { state: "code", address: "0x1100", rva: "0x100" },
    { state: "code", address: "0x1100", rva: "0x100" },
    { state: "no-body", address: null, rva: null },
    { state: "unknown", address: null, rva: null },
  ],
  return_types: Array.from({ length: 4 }, () => ({ type: 0, name: "void" })),
  field_types: [{ type: 0, name: "int" }],
  parameter_types: [{ type: 0, name: "int" }],
});

it("selects every folded method by numeric address with stable indices and both source identities", () => {
  const source = parent(freezeJsonSnapshot(linkedReport()), true);
  const view = projectIl2cppMetadataView(source, {
    kind: "il2cpp-metadata",
    collection: "method_addresses",
    addresses: ["0x00001100", "0x1100"],
    states: ["code"],
    fields: [],
    offset: 1,
    limit: 1,
  });
  if (!view.ok) throw view.error;
  expect(view.value).toMatchObject({
    items: [{ index: 1 }],
    artifact: { sha256: report.artifact.sha256 },
    binary_source: {
      artifact: { path: "/artifacts/GameAssembly.dll", sha256: "c".repeat(64) },
      image_base: "0x1000",
    },
    coverage: { total: 2, exhausted: true },
  });
});

it.each([
  { addresses: [] },
  { states: [] },
  { indices: [] },
  { addresses: ["0x1100"], indices: [2] },
  { states: ["no-body" as const], addresses: ["0x1100"] },
])(
  "intersects native selectors and preserves empty selection: %j",
  (selection) => {
    const view = projectIl2cppMetadataView(parent(linkedReport(), false), {
      kind: "il2cpp-metadata",
      collection: "method_addresses",
      ...selection,
      offset: 0,
      limit: 64,
    });
    if (!view.ok) throw view.error;
    expect(view.value).toMatchObject({
      items: [],
      coverage: { total: 0, exhausted: true },
    });
  },
);

it.each([
  { state: "no-body", address: "0x1100", rva: null },
  { state: "unknown", address: null, rva: "0x100" },
  { state: "code", address: "0x1100", rva: "0x101" },
  { state: "code", address: "0x10000000000000000", rva: "0x100" },
  { state: "code", address: "malformed", rva: "0x100" },
])(
  "rejects malformed native facts without throwing during boundary validation: %j",
  (row) => {
    const value = jsonObjectSchema.parse(linkedReport());
    value.method_addresses = [row, ...linkedReport().method_addresses.slice(1)];
    const view = projectIl2cppMetadataView(parent(value, false), {
      kind: "summary",
    });
    expect(view.ok).toBe(false);
  },
);

it("keeps native summaries bounded while paging selected module facts", () => {
  const value = linkedReport(),
    source = parent(value, false);
  const summary = summarize(source);
  expect(summary).toMatchObject({
    summary: {
      counts: { code_gen_modules: 1 },
      binary: { artifact: value.binary!.artifact },
    },
  });
  expect("summary" in summary && summary.summary).not.toHaveProperty(
    "binary.code_gen_modules",
  );
  const page = projectIl2cppMetadataView(source, {
    kind: "il2cpp-metadata",
    collection: "code_gen_modules",
    image_indices: [0],
    fields: ["image", "address"],
    offset: 0,
    limit: 1,
  });
  if (!page.ok) throw page.error;
  expect(page.value).toMatchObject({
    items: [{ index: 0, image: 0, address: "0x1400" }],
    coverage: { total: 1, exhausted: true },
  });
});
