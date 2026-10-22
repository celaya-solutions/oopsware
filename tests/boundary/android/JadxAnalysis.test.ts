import { expect, it } from "vitest";

import {
  analyzeJadxRequest,
  type JadxToolPort,
} from "../../../src/android/JadxAnalysis.js";
import {
  androidInputSchemas,
  androidResultSchemas,
} from "../../../src/domain/android/androidAnalysis.js";

const summary = {
  full_name: "fixture.Target",
  name: "Target",
  method_count: 2,
  field_count: 0,
  inner_class_count: 0,
  methods: [
    {
      name: "choose",
      signature: "choose(String): void",
      dex_descriptor: "(Ljava/lang/String;)V",
      is_constructor: false,
      def_pos: 0,
    },
    {
      name: "choose",
      signature: "choose(int): void",
      dex_descriptor: "(I)V",
      is_constructor: false,
      def_pos: 0,
    },
  ],
  fields: [],
  inner_classes: [],
};

const engine = {
  name: "jadx",
  version: "0.7.1",
  artifact_sha256: "a".repeat(64),
  source_revision: null,
  worker_count: 1,
  heap_limit_mib: null,
};

it("pages filtered matches independently of the examined inventory and preserves cross-page duplicates", async () => {
  const names = Array.from({ length: 5000 }, (_, i) => `fixture.Target${i}`);
  names[0] = "fixture.TargetDuplicate";
  names[4096] = "fixture.TargetDuplicate";
  const calls: Record<string, unknown>[] = [];
  const tools: JadxToolPort = {
    json: (name, input) => {
      expect(name).toBe("list_classes");
      calls.push({ ...input });
      const offset = Number(input.offset);
      return Promise.resolve({
        scope: "top_level",
        total_classes: 10000,
        next_offset: offset === 0 ? 8191 : 10000,
        offset,
        limit: 4096,
        items: offset === 0 ? names.slice(0, 4096) : names.slice(4096),
      });
    },
    text: () => Promise.reject(new Error("unexpected text call")),
  };
  const result = await analyzeJadxRequest(
    tools,
    {
      operation: "search_android_classes",
      input: { path: "/fixture.apk", query: "Target" },
    },
    {
      state: "LOADED",
      apk_path: "/snapshot.apk",
      class_count: 10000,
      resource_count: 0,
      threads: 1,
      resources: "full",
    },
    engine,
  );
  expect(calls).toEqual([
    { query: "Target", offset: 0, limit: 4096 },
    { query: "Target", offset: 8191, limit: 4096 },
  ]);
  expect(result).toMatchObject({
    total_classes: 10000,
    matches: names,
    duplicate_names: [{ name: "fixture.TargetDuplicate", occurrences: 2 }],
    coverage: "complete",
  });
});

it.each([
  { name: "inventory scope", query: "Target", page: { scope: "all_dex" } },
  { name: "inventory total", query: "Target", page: { total_classes: 9 } },
  { name: "out-of-range cursor", query: "Target", page: { next_offset: 11 } },
  {
    name: "impossible examined row count",
    query: "Target",
    page: { next_offset: 1, items: ["TargetA", "TargetB"] },
  },
  { name: "offset identity", query: "Target", page: { offset: 1 } },
  { name: "requested page size", query: "Target", page: { limit: 1 } },
  { name: "nonmatching row", query: "Target", page: { items: ["Other"] } },
  {
    name: "non-progressing page",
    query: "Target",
    page: { next_offset: 0, items: [] },
  },
  { name: "premature page end", query: "Target", page: { next_offset: 9 } },
  { name: "empty-query completeness", query: "", page: {} },
])(
  "refuses changed $name instead of reporting complete search coverage",
  async ({ query, page }) => {
    const tools: JadxToolPort = {
      json: () =>
        Promise.resolve({
          scope: "top_level",
          total_classes: 10,
          next_offset: 10,
          offset: 0,
          limit: 4096,
          items: ["fixture.Target"],
          ...page,
        }),
      text: () => Promise.reject(new Error("unexpected text call")),
    };
    await expect(
      analyzeJadxRequest(
        tools,
        {
          operation: "search_android_classes",
          input: { path: "/fixture.apk", query },
        },
        {
          state: "LOADED",
          apk_path: "/snapshot.apk",
          class_count: 10,
          resource_count: 0,
          threads: 1,
          resources: "full",
        },
        engine,
      ),
    ).rejects.toThrow();
  },
);

it("accepts an examined empty inventory without requiring cursor progress", async () => {
  const tools: JadxToolPort = {
    json: () =>
      Promise.resolve({
        scope: "top_level",
        total_classes: 0,
        offset: 0,
        next_offset: 0,
        limit: 4096,
        items: [],
      }),
    text: () => Promise.reject(new Error("unexpected text call")),
  };
  const result = await analyzeJadxRequest(
    tools,
    {
      operation: "search_android_classes",
      input: { path: "/fixture.apk", query: "Target" },
    },
    {
      state: "LOADED",
      apk_path: "/snapshot.apk",
      class_count: 0,
      resource_count: 0,
      threads: 1,
      resources: "full",
    },
    engine,
  );
  expect(result).toMatchObject({
    total_classes: 0,
    matches: [],
    duplicate_names: [],
    coverage: "complete",
  });
});

it("requires explicit direct invoke coverage state in result evidence", () => {
  const result = {
    engine,
    class_name: "fixture.Target",
    method_name: null,
    overload_index: null,
    reported_signature: null,
    dex_descriptor: null,
    total: 1,
    references: [
      {
        kind: "method",
        name: "caller",
        reported_full_name: "fixture.Other.caller",
        containing_class: "fixture.Other",
        top_class: "fixture.Other",
        source_line: null,
        dex_offset: null,
        direct_invokes: null,
      },
    ],
    coverage: "complete",
    reference_unit: "using_node",
  };
  expect(
    androidResultSchemas.trace_android_references.safeParse(result).success,
  ).toBe(false);
  expect(
    androidResultSchemas.trace_android_references.safeParse({
      ...result,
      references: [
        { ...result.references[0], direct_invokes_exhaustive: null },
      ],
    }).success,
  ).toBe(true);
});

it("publishes exact DEX prototypes instead of discarding bridge metadata", async () => {
  const tools: JadxToolPort = {
    json: () => Promise.resolve(summary),
    text: () => Promise.reject(new Error("unexpected text call")),
  };
  const result = await analyzeJadxRequest(
    tools,
    {
      operation: "inspect_android_class",
      input: androidInputSchemas.inspect_android_class.parse({
        path: "/fixture.apk",
        class_name: "fixture.Target",
      }),
    },
    {} as never,
    engine,
  );
  expect(result).toMatchObject({
    methods: [
      { name: "choose", dex_descriptor: "(Ljava/lang/String;)V" },
      { name: "choose", dex_descriptor: "(I)V" },
    ],
  });
});

it("traces only the selected overloaded method and checks the producer identity", async () => {
  const calls: Record<string, unknown>[] = [];
  const tools: JadxToolPort = {
    json: (name, input) => {
      calls.push({ name, ...input });
      if (name === "get_class_summary") return Promise.resolve(summary);
      return Promise.resolve({
        target: "fixture.Target.choose",
        overload_index: 1,
        reported_signature: "choose(int): void",
        total: 1,
        count: 1,
        resolve_line: false,
        items: [
          {
            kind: "method",
            name: "caller",
            full_name: "fixture.Other.caller",
            containing_class: "fixture.Other",
            top_class: "fixture.Other",
            def_pos: 0,
            direct_invokes: [
              {
                dex_entry: "classes.dex",
                source_raw_method_id: "fixture.Other.caller()V",
                dex_code_unit_offset: 0,
                dex_method_index: 1,
                opcode: "INVOKE_STATIC",
              },
              {
                dex_entry: "classes.dex",
                source_raw_method_id: "fixture.Other.caller()V",
                dex_code_unit_offset: 3,
                dex_method_index: 1,
                opcode: "INVOKE_STATIC",
              },
            ],
          },
        ],
      });
    },
    text: () => Promise.reject(new Error("unexpected text call")),
  };
  const request = {
    operation: "trace_android_references",
    input: androidInputSchemas.trace_android_references.parse({
      path: "/fixture.apk",
      class_name: "fixture.Target",
      method_name: "choose",
      overload_index: 1,
    }),
  } as const;
  const result = await analyzeJadxRequest(tools, request, {} as never, engine);
  expect(result).toMatchObject({
    method_name: "choose",
    overload_index: 1,
    reported_signature: "choose(int): void",
    dex_descriptor: "(I)V",
    total: 1,
    reference_unit: "using_node",
    references: [
      {
        direct_invokes: [
          { dex_code_unit_offset: 0 },
          { dex_code_unit_offset: 3 },
        ],
      },
    ],
  });
  expect(calls[1]).toMatchObject({
    name: "get_xrefs_to_method",
    overload_index: 1,
  });
});

it("rejects an ambiguous method and a producer response for a different overload", async () => {
  const xrefs = {
    target: "fixture.Target.choose",
    overload_index: 0,
    reported_signature: "choose(String): void",
    total: 0,
    count: 0,
    resolve_line: false,
    items: [],
  };
  const tools: JadxToolPort = {
    json: (name) =>
      Promise.resolve(name === "get_class_summary" ? summary : xrefs),
    text: () => Promise.reject(new Error("unexpected text call")),
  };
  const input = {
    path: "/fixture.apk",
    class_name: "fixture.Target",
    method_name: "choose",
  };
  await expect(
    analyzeJadxRequest(
      tools,
      {
        operation: "trace_android_references",
        input,
      },
      {} as never,
      engine,
    ),
  ).rejects.toMatchObject({
    _tag: "AnalysisInputError",
  });
  await expect(
    analyzeJadxRequest(
      tools,
      {
        operation: "trace_android_references",
        input: { ...input, overload_index: 1 },
      },
      {} as never,
      engine,
    ),
  ).rejects.toMatchObject({
    _tag: "AnalysisOutputError",
  });
});

const invokeSite = {
  dex_entry: "classes.dex",
  source_raw_method_id: "fixture.Other.caller()V",
  dex_code_unit_offset: 0,
  dex_method_index: 1,
  opcode: "INVOKE_STATIC",
};
const traceWithReference = (fields: Record<string, unknown>) =>
  analyzeJadxRequest(
    {
      json: (name) =>
        Promise.resolve(
          name === "get_class_summary"
            ? summary
            : {
                target: "fixture.Target.choose",
                overload_index: 0,
                reported_signature: "choose(String): void",
                total: 1,
                count: 1,
                resolve_line: false,
                items: [
                  {
                    kind: "method",
                    name: "caller",
                    full_name: "fixture.Other.caller",
                    containing_class: "fixture.Other",
                    top_class: "fixture.Other",
                    def_pos: 0,
                    ...fields,
                  },
                ],
              },
        ),
      text: () => Promise.reject(new Error("unexpected text call")),
    },
    {
      operation: "trace_android_references",
      input: {
        path: "/fixture.apk",
        class_name: "fixture.Target",
        method_name: "choose",
        overload_index: 0,
      },
    },
    {} as never,
    engine,
  );

it.each([
  [{}, null],
  [{ direct_invokes: [] }, []],
])(
  "preserves unavailable versus observed-empty invoke sites: %j",
  async (fields, expected) => {
    const result = await traceWithReference(fields as Record<string, unknown>);
    expect(result).toMatchObject({
      references: [
        { direct_invokes: expected, direct_invokes_exhaustive: null },
      ],
    });
  },
);

it.each([
  { ...invokeSite, dex_code_unit_offset: -1 },
  {
    dex_entry: "classes.dex",
    source_raw_method_id: "fixture.Other.caller()V",
    dex_code_unit_offset: 0,
    dex_method_index: 1,
  },
])("rejects malformed direct invoke producer evidence: %j", async (site) => {
  await expect(
    traceWithReference({ direct_invokes: [site] }),
  ).rejects.toThrow();
});

it("preserves bounded instruction coverage separately from using-node coverage", async () => {
  const result = await traceWithReference({
    direct_invokes: [invokeSite],
    direct_invokes_exhaustive: false,
  });
  expect(result).toMatchObject({
    coverage: "complete",
    reference_unit: "using_node",
    references: [
      { direct_invokes: [invokeSite], direct_invokes_exhaustive: false },
    ],
  });
});

it.each([
  "not-a-dex-descriptor",
  "(Lbad(name;)V",
  "(Lbad)name;)V",
  "()Lbad(name;",
  "()Lbad)name;",
])(
  "rejects malformed DEX prototype %s at the adapter boundary",
  async (descriptor) => {
    const invalidSummary = {
      ...summary,
      methods: summary.methods.map((method) => ({
        ...method,
        dex_descriptor: descriptor,
      })),
    };
    await expect(
      analyzeJadxRequest(
        {
          json: () => Promise.resolve(invalidSummary),
          text: () => Promise.reject(new Error("unexpected text call")),
        },
        {
          operation: "inspect_android_class",
          input: { path: "/fixture.apk", class_name: "fixture.Target" },
        },
        {} as never,
        engine,
      ),
    ).rejects.toMatchObject({
      _tag: "AnalysisOutputError",
      cause: {
        issues: expect.arrayContaining([
          expect.objectContaining({
            path: ["methods", 0, "dex_descriptor"],
          }),
        ]),
      },
    });
  },
);
