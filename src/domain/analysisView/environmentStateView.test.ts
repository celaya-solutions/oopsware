import { expect, it } from "vitest";
import {
  analysisViewCaptureEvidence,
  environmentManifestCaptureFixture,
  environmentStateCaptureFixture,
} from "../../../tests/fixtures/analysisView.js";
import {
  SCENARIO_EXCHANGES,
  scenarioCaptureEvidence,
  scenarioCaptureFixture,
} from "../../../tests/fixtures/browserScenarioCapture.js";
import type { Evidence } from "../evidence.js";
import type { JsonValue } from "../jsonValue.js";
import {
  projectAnalysisView,
  type AnalysisViewParent,
  type AnalysisViewResult,
} from "./analysisView.js";
import { EnvironmentStateAccumulator } from "./EnvironmentStateAccumulator.js";

type State = Extract<AnalysisViewResult, { kind: "environment-state" }>;
const ALL_RULES = [
  "after-uid-literal",
  "opaque-token",
  "sibling-variance",
] as const;

const parentOf = (
  evidence: Evidence = analysisViewCaptureEvidence(
    environmentStateCaptureFixture(),
  ),
): AnalysisViewParent => ({
  evidenceId: evidence.evidence_id,
  operation: evidence.operation,
  normalizedResult: evidence.normalized_result,
  subject: evidence.subject,
  limitations: [],
  parameters: evidence.parameters,
});

const stateOf = (parent: AnalysisViewParent = parentOf()): State => {
  const result = projectAnalysisView(parent, {
    kind: "environment-state",
    template_rules: [...ALL_RULES],
  });
  if (!result.ok || result.value.kind !== "environment-state")
    throw new Error("Expected an environment state");
  return result.value;
};

type Row = readonly [
  method: string,
  path: string,
  body?: JsonValue,
  status?: number,
];

/** HAR entries one second apart on one origin; a string body is recorded as written. */
const captureOf = (rows: readonly Row[]): AnalysisViewParent =>
  parentOf(
    analysisViewCaptureEvidence(
      environmentManifestCaptureFixture(
        rows.map(([method, path, body = null, status = 200], index) => ({
          startedDateTime: new Date(
            Date.parse("2026-10-17T18:00:00.000Z") + index * 1000,
          ).toISOString(),
          time: 5,
          request: { method, url: `http://app.example${path}` },
          response: {
            status,
            content: {
              mimeType: "application/json",
              text: typeof body === "string" ? body : JSON.stringify(body),
            },
          },
        })),
      ),
    ),
  );

const viewOf = (state: State, tool: string) =>
  state.views.find((view) => view.tool === tool);

it("extracts the state the Grafana-shaped capture's reads observed", () => {
  const state = stateOf();
  expect(state.timeline).toBe("recorded-start-time");
  expect(state.types).toContainEqual({
    collection_template: "/api/folders",
    id_field: "uid",
    id_basis: "path-parameter",
    init_before_ordinal: 20,
    volatile_fields: [],
  });
  expect(state.types).toContainEqual({
    collection_template: "/api/search",
    id_field: "id",
    id_basis: "field-name",
    init_before_ordinal: null,
    volatile_fields: [],
  });
  expect(
    state.entities.filter((entity) => entity.type === "/api/folders"),
  ).toEqual([
    {
      type: "/api/folders",
      collection: "/api/folders",
      id: "fg1jo91e57e2ob",
      fields: { id: 5, uid: "fg1jo91e57e2ob", title: "probe folder" },
      view_fields: [],
      record_ordinals: [12, 14],
    },
    {
      type: "/api/folders",
      collection: "/api/folders",
      id: "general",
      fields: { id: 0, uid: "general", title: "Dashboards" },
      view_fields: [],
      record_ordinals: [13],
    },
  ]);
  expect(viewOf(state, "get_folders")).toMatchObject({
    shape: "list",
    pointer: "",
    membership: "recorded",
  });
  expect(viewOf(state, "get_folders_by_uid")).toMatchObject({
    shape: "item",
    envelope_ordinal: 12,
    checked_record_ordinals: [12, 13],
  });
  expect(viewOf(state, "get_dashboards_by_uid")).toMatchObject({
    shape: "item",
    pointer: "/dashboard",
  });
  expect(viewOf(state, "get_annotations")).toEqual({
    tool: "get_annotations",
    shape: "recorded",
    reason: "no-init-recording",
  });
  expect(state.documents).toEqual([]);
  expect(state.unknowns.map((unknown) => unknown.kind)).toEqual([
    "authorization-model",
    "response-semantics",
    "state-transition",
  ]);
  expect(
    state.limitations.filter((limitation) =>
      limitation.startsWith("Body shapes"),
    ),
  ).toEqual([]);
});

it("ends a type's state at the first write under its root, not at unrelated writes", () => {
  const state = stateOf(
    captureOf([
      ["GET", "/api/items/1", { id: 1, title: "Granite Ledger" }],
      ["PUT", "/api/notes/9", { id: 9 }],
      ["GET", "/api/items/1", { id: 1, title: "Granite Ledger" }],
      ["PUT", "/api/items/1", { id: 1, title: "Saltmarsh Depot" }],
      ["GET", "/api/items/1", { id: 1, title: "Saltmarsh Depot" }],
    ]),
  );
  expect(state.types).toEqual([
    {
      collection_template: "/api/items",
      id_field: "id",
      id_basis: "path-parameter",
      init_before_ordinal: 3,
      volatile_fields: [],
    },
  ]);
  expect(state.entities).toMatchObject([
    { id: "1", fields: { title: "Granite Ledger" }, record_ordinals: [0, 2] },
  ]);
  expect(state.views).toContainEqual(
    expect.objectContaining({ shape: "item", checked_record_ordinals: [2] }),
  );
});

it("keeps the latest value of a field that changed with no related write and names it volatile", () => {
  const state = stateOf(
    captureOf([
      ["GET", "/api/items/1", { id: 1, title: "Lighthouse Rota", seen: 10 }],
      ["GET", "/api/items/1", { id: 1, title: "Lighthouse Rota", seen: 11 }],
      ["GET", "/api/items/2", { id: 2, title: "Blue Heron", seen: 3 }],
    ]),
  );
  expect(state.types[0]).toMatchObject({ volatile_fields: ["seen"] });
  expect(state.entities[0]).toMatchObject({
    id: "1",
    fields: { seen: 11 },
  });
  expect(state.views).toContainEqual(
    expect.objectContaining({
      shape: "item",
      checked_record_ordinals: [1, 2],
    }),
  );
});

it("leaves a type recorded when a value changed across a write under another root", () => {
  const state = stateOf(
    captureOf([
      ["GET", "/api/search", [{ id: 1, title: "Granite Ledger" }]],
      ["POST", "/api/dashboards/db", { id: 1, title: "Saltmarsh Depot" }],
      ["GET", "/api/search", [{ id: 1, title: "Saltmarsh Depot" }]],
    ]),
  );
  expect(state.types).toEqual([]);
  expect(state.entities).toEqual([]);
  expect(viewOf(state, "get_search")).toEqual({
    tool: "get_search",
    shape: "recorded",
    reason: "fields-differ",
  });
});

it("leaves a type recorded when a value changed across a write already in flight", () => {
  const exchange = ([method, path, seconds, time, title]: readonly [
    string,
    string,
    number,
    number,
    string,
  ]) => ({
    startedDateTime: new Date(
      Date.parse("2026-10-17T18:00:00.000Z") + seconds * 1000,
    ).toISOString(),
    time,
    request: { method, url: `http://app.example${path}` },
    response: {
      status: 200,
      content: {
        mimeType: "application/json",
        text: JSON.stringify([{ id: 1, title }]),
      },
    },
  });
  const state = stateOf(
    parentOf(
      analysisViewCaptureEvidence(
        environmentManifestCaptureFixture([
          exchange([
            "POST",
            "/api/dashboards/db",
            0,
            30_000,
            "Saltmarsh Depot",
          ]),
          exchange(["GET", "/api/search", 10, 5, "Granite Ledger"]),
          exchange(["GET", "/api/search", 40, 5, "Saltmarsh Depot"]),
        ]),
      ),
    ),
  );
  expect(viewOf(state, "get_search")).toEqual({
    tool: "get_search",
    shape: "recorded",
    reason: "fields-differ",
  });
});

it("does not list the whole collection when a counter exceeds the number listed", () => {
  const state = stateOf(
    captureOf([
      [
        "GET",
        "/api/items",
        { total: 50, items: [{ id: 1, title: "Ada Finch" }] },
      ],
    ]),
  );
  expect(viewOf(state, "get_items")).toMatchObject({
    shape: "list",
    membership: "recorded",
    counters: [],
  });
});

it("lists the whole collection with its counter only when every recording did", () => {
  const rows: Row[] = [
    [
      "GET",
      "/api/items",
      {
        total: 2,
        items: [
          { id: 1, title: "Ada Finch" },
          { id: 2, title: "Tomas Vey" },
        ],
      },
    ],
    ["GET", "/api/items/1", { title: "Ada Finch", id: 1, notes: "first" }],
    ["GET", "/api/items/2", { id: 2, notes: "second", title: "Tomas Vey" }],
  ];
  const whole = stateOf(captureOf(rows));
  expect(whole.views).toContainEqual(
    expect.objectContaining({
      shape: "list",
      pointer: "/items",
      fields: ["id", "title"],
      membership: "all",
      counters: ["total"],
    }),
  );
  expect(whole.entities.map((entity) => entity.fields)).toEqual([
    { id: 1, title: "Ada Finch", notes: "first" },
    { id: 2, notes: "second", title: "Tomas Vey" },
  ]);
  const filtered = stateOf(
    captureOf([
      ...rows,
      [
        "GET",
        "/api/items?title=Ada",
        { total: 1, items: [{ id: 1, title: "Ada Finch" }] },
      ],
    ]),
  );
  expect(filtered.views).toContainEqual(
    expect.objectContaining({ shape: "list", membership: "recorded" }),
  );
});

it("leaves recorded the views it cannot reproduce, with the reason", () => {
  const state = stateOf(
    captureOf([
      [
        "GET",
        "/api/boards/1",
        { meta: { viewer: "Ada Finch" }, board: { id: 1, name: "Rota" } },
      ],
      [
        "GET",
        "/api/boards/2",
        { meta: { viewer: "Mina Okafor" }, board: { id: 2, name: "Depot" } },
      ],
      ["GET", "/api/ledgers/1", '{"id":1,"total":12345678901234567890}'],
      ["POST", "/api/boards/search", [{ id: 1, name: "Rota" }]],
    ]),
  );
  expect(
    state.views.map((view) =>
      view.shape === "recorded" ? [view.tool, view.reason] : view.tool,
    ),
  ).toEqual([
    ["post_boards_search", "query-body"],
    ["get_boards_by_id", "envelope-varies"],
    ["get_ledgers_by_id", "body-unusable"],
  ]);
  expect(state.types).toEqual([]);
  expect(state.entities).toEqual([]);
});

it("holds a written path's non-entity read as a document", () => {
  const state = stateOf(
    captureOf([
      ["GET", "/api/settings", { theme: "dark", density: "compact" }],
      ["PUT", "/api/settings", { theme: "light", density: "compact" }],
      ["GET", "/api/settings", { theme: "light", density: "compact" }],
    ]),
  );
  expect(state.documents).toEqual([
    {
      tool: "get_settings",
      path: "/api/settings",
      value: { theme: "dark", density: "compact" },
      record_ordinal: 0,
    },
  ]);
  expect(viewOf(state, "get_settings")).toEqual({
    tool: "get_settings",
    shape: "document",
    checked_record_ordinals: [0],
  });
});

it.each([
  ["/api/files/123", "PUT", "get_files_by_id"],
  ["/api/settings", "DELETE", "get_settings"],
] as const)(
  "leaves a deferred document path recorded (%s, %s)",
  (path, method, tool) => {
    const state = stateOf(
      captureOf([
        ["GET", path, { text: "initial document" }],
        [method, path, null],
      ]),
    );
    expect(state.documents).toEqual([]);
    expect(viewOf(state, tool)).toMatchObject({ shape: "recorded" });
  },
);

it("orders a scenario capture by request order and needs its response bodies", () => {
  const state = stateOf(parentOf(scenarioCaptureEvidence()));
  expect(state.timeline).toBe("record-order");
  expect(state.types).toEqual([
    {
      collection_template: "/api/users",
      id_field: "id",
      id_basis: "path-parameter",
      init_before_ordinal: null,
      volatile_fields: [],
    },
  ]);
  expect(state.entities.map((entity) => entity.fields)).toEqual([
    { id: 2, login: "probe" },
    { id: 3, login: "viewer" },
  ]);
  const headersOnly = scenarioCaptureEvidence(
    scenarioCaptureFixture(SCENARIO_EXCHANGES, {
      request_body: true,
      response_body: false,
      header_values: true,
    }),
  );
  expect(
    projectAnalysisView(parentOf(headersOnly), {
      kind: "environment-state",
      template_rules: [],
    }),
  ).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisUnsupportedTargetError",
      message: expect.stringContaining("response_body selected"),
    },
  });
});

it("refuses when extraction would exceed the projection budget", () => {
  expect(
    projectAnalysisView(
      parentOf(),
      { kind: "environment-state", template_rules: [...ALL_RULES] },
      { state: new EnvironmentStateAccumulator(160 * 1024, [...ALL_RULES]) },
    ),
  ).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisResourceConstraintError",
      resource: "memory",
      message: expect.stringContaining("Environment-state"),
    },
  });
});

it("ends every type's state at a write whose URL was redacted, and says so", () => {
  const parent = captureOf([
    ["GET", "/api/items/1", { id: 1, title: "Granite Ledger" }],
    ["PUT", "/api/items/1", { id: 1 }],
    ["GET", "/api/items/1", { id: 1, title: "Saltmarsh Depot" }],
  ]);
  const result = structuredClone(parent.normalizedResult) as {
    records: { reported: { request: { url: string | null } } }[];
  };
  // A scenario keeps a redacted URL as null, so the write's target is unknown.
  result.records[1]!.reported.request.url = null;
  const state = stateOf({ ...parent, normalizedResult: result });
  expect(state.types).toMatchObject([{ init_before_ordinal: 1 }]);
  expect(state.entities).toMatchObject([
    { fields: { title: "Granite Ledger" }, record_ordinals: [0] },
  ]);
  expect(state.limitations).toContain(
    "1 of the recorded writes had a redacted URL; each ends the initial state of every type, since its target is unknown.",
  );
});

it("infers no identity for a list whose recordings held no items", () => {
  const state = stateOf(captureOf([["GET", "/api/widgets", []]]));
  expect(state.types).toEqual([]);
  expect(state.views).toEqual([
    { tool: "get_widgets", shape: "recorded", reason: "no-identity" },
  ]);
});

it("does not call a value volatile when it differs between request lines", () => {
  const state = stateOf(
    captureOf([
      ["GET", "/api/items/1?lang=fr", { id: 1, name: "Bonjour" }],
      ["GET", "/api/items/1", { id: 1, name: "Hello" }],
    ]),
  );
  expect(state.types).toEqual([]);
  expect(
    state.views.map((view) =>
      view.shape === "recorded" ? [view.tool, view.reason] : view.tool,
    ),
  ).toEqual([["get_items_by_id", "fields-differ"]]);
});

it("orders entities by their earliest sighting, so a complete list keeps all membership", () => {
  const state = stateOf(
    captureOf([
      [
        "GET",
        "/api/items",
        [
          { id: 1, title: "Granite Ledger" },
          { id: 2, title: "Blue Heron" },
        ],
      ],
      ["GET", "/api/items/2", { id: 2, title: "Blue Heron" }],
      ["GET", "/api/items/1", { id: 1, title: "Granite Ledger" }],
    ]),
  );
  expect(state.entities.map((entity) => entity.id)).toEqual(["1", "2"]);
  expect(state.views).toContainEqual(
    expect.objectContaining({ tool: "get_items", membership: "all" }),
  );
});

it("does not take a later recording that is itself an entity as the list", () => {
  const state = stateOf(
    captureOf([
      ["GET", "/api/items", { items: [{ id: 1, title: "Granite Ledger" }] }],
      [
        "GET",
        "/api/items",
        { id: 99, items: [{ id: 2, title: "Blue Heron" }] },
      ],
    ]),
  );
  expect(state.views).toContainEqual(
    expect.objectContaining({ tool: "get_items", shape: "recorded" }),
  );
  expect(state.entities).toEqual([]);
});

it("leaves a type recorded when two of its tools read different values across a write", () => {
  const state = stateOf(
    captureOf([
      ["GET", "/api/search", [{ id: 1, title: "Granite Ledger" }]],
      ["POST", "/api/dashboards/db", { id: 9 }],
      ["GET", "/api/search/1", { id: 1, title: "Saltmarsh Depot" }],
    ]),
  );
  expect(state.types).toEqual([]);
  expect(state.entities).toEqual([]);
  expect(
    state.views.map((view) =>
      view.shape === "recorded" ? [view.tool, view.reason] : view.tool,
    ),
  ).toEqual([
    ["get_search", "fields-differ"],
    ["get_search_by_id", "fields-differ"],
  ]);
});

it.each(["old", "new"])(
  "retains field observations through sparse reads across a write (%s)",
  (title) => {
    const state = stateOf(
      captureOf([
        ["GET", "/api/search", [{ id: 1, title: "old" }]],
        ["POST", "/api/items", { id: 2 }],
        ["GET", "/api/search?fields=id", [{ id: 1 }]],
        ["GET", "/api/search/1", { id: 1, title }],
      ]),
    );
    if (title === "new") {
      expect(state.types).toEqual([]);
      expect(state.entities).toEqual([]);
      expect(
        state.views.every(
          (view) =>
            view.shape === "recorded" && view.reason === "fields-differ",
        ),
      ).toBe(true);
    } else {
      expect(viewOf(state, "get_search_by_id")).toMatchObject({
        shape: "item",
      });
      expect(state.entities[0]?.fields.title).toBe("old");
    }
  },
);

it("proves the identity field against every item response", () => {
  const state = stateOf(
    captureOf([
      ["GET", "/api/widgets/1", { left: 1, right: 1 }],
      ["GET", "/api/widgets/2", { right: 2, left: "other" }],
    ]),
  );
  expect(state.types).toMatchObject([
    { id_field: "right", id_basis: "path-parameter" },
  ]);
  expect(state.entities.map((entity) => entity.id)).toEqual(["1", "2"]);
});

it.each(["/api", "/api/items/1/update"])(
  "bounds a type by a write at a related root (%s)",
  (path) => {
    const state = stateOf(
      captureOf([
        ["GET", "/api/items/1", { id: 1, title: "initial" }],
        ["POST", path, {}],
        ["GET", "/api/items/1", { id: 1, title: "after" }],
      ]),
    );
    expect(state.types).toMatchObject([{ init_before_ordinal: 1 }]);
    expect(state.entities).toMatchObject([{ fields: { title: "initial" } }]);
  },
);

it("chooses the earliest related write in timeline order, across ancestor and descendant roots", () => {
  const parent = captureOf([
    ["GET", "/api/items/1", { id: 1, title: "initial" }],
    ["POST", "/api/items/1/update", {}],
    ["POST", "/api", {}],
    ["GET", "/api/items/1", { id: 1, title: "after" }],
  ]);
  const data = structuredClone(parent.normalizedResult) as {
    records: { reported: { startedDateTime: string } }[];
  };
  const first = data.records[1]!.reported.startedDateTime;
  data.records[1]!.reported.startedDateTime =
    data.records[2]!.reported.startedDateTime;
  data.records[2]!.reported.startedDateTime = first;
  const state = stateOf({ ...parent, normalizedResult: data });
  expect(state.types).toMatchObject([{ init_before_ordinal: 2 }]);
  expect(state.entities).toMatchObject([{ fields: { title: "initial" } }]);
});

it("bounds a parameterized namespace by concrete writes before publishing new items", () => {
  const result = projectAnalysisView(
    captureOf([
      ["GET", "/api/v1/repos/alice/alpha/issues/1", { id: 1 }],
      ["GET", "/api/v1/repos/bob/beta/issues/2", { id: 2 }],
      ["GET", "/api/v1/repos/carol/gamma/issues/3", { id: 3 }],
      ["POST", "/api/v1/repos/dana/delta/issues", { id: 4 }],
      ["GET", "/api/v1/repos/dana/delta/issues/4", { id: 4 }],
    ]),
    {
      kind: "environment-state",
      template_rules: [...ALL_RULES, "sibling-pair-variance"],
    },
  );
  if (!result.ok || result.value.kind !== "environment-state")
    throw new Error("Expected state");
  expect(result.value.entities.map((entity) => entity.id)).toEqual([
    "1",
    "2",
    "3",
  ]);
  expect(result.value.types).toMatchObject([{ init_before_ordinal: 3 }]);
});

it.each(["totalcount", "itemcount"])(
  "recognizes a compact compound item total (%s)",
  (name) => {
    const state = stateOf(
      captureOf([["GET", "/api/items", { [name]: 50, items: [{ id: 1 }] }]]),
    );
    expect(viewOf(state, "get_items")).toMatchObject({
      shape: "list",
      membership: "recorded",
      counters: [],
    });
  },
);

it.each([
  [[], [{ id: 1 }]],
  [[{ id: 1 }], []],
  [[{ id: 1 }], [{ id: 2 }]],
] as const)(
  "keeps changed list membership across another root's write recorded (%j -> %j)",
  (before, after) => {
    const state = stateOf(
      captureOf([
        ["GET", "/api/search", [...before]],
        ["POST", "/api/items", { id: 2 }],
        ["GET", "/api/search", [...after]],
      ]),
    );
    expect(state.types).toEqual([]);
    expect(state.entities).toEqual([]);
    expect(viewOf(state, "get_search")).toEqual({
      tool: "get_search",
      shape: "recorded",
      reason: "fields-differ",
    });
  },
);

it("accepts stable membership across another root's write and changes confined before it", () => {
  const state = stateOf(
    captureOf([
      ["GET", "/api/search", []],
      ["GET", "/api/search", [{ id: 1 }]],
      ["POST", "/api/items", { id: 2 }],
      ["GET", "/api/search", [{ id: 1 }]],
    ]),
  );
  expect(viewOf(state, "get_search")).toMatchObject({ shape: "list" });
  expect(state.entities.map((entity) => entity.id)).toEqual(["1"]);
});

it("keeps membership checks specific to the full request line", () => {
  const state = stateOf(
    captureOf([
      ["GET", "/api/search?page=1", [{ id: 1 }]],
      ["POST", "/api/items", { id: 2 }],
      ["GET", "/api/search?page=2", [{ id: 2 }]],
    ]),
  );
  expect(viewOf(state, "get_search")).toMatchObject({
    shape: "list",
    membership: "recorded",
  });
});

it("does not treat a first observation as a membership change", () => {
  const parent = captureOf([
    ["GET", "/api/search", [{ id: 1 }]],
    ["POST", "/api/items", { id: 2 }],
    ["GET", "/api/search", [{ id: 1 }]],
  ]);
  const data = structuredClone(parent.normalizedResult) as {
    records: { reported: { time: number } }[];
  };
  data.records[0]!.reported.time = 1500;
  const state = stateOf({ ...parent, normalizedResult: data });
  expect(viewOf(state, "get_search")).toMatchObject({ shape: "list" });
});

it.each([
  [{ id: 1 }, { id: 1, title: "Created" }],
  [{ id: 1, title: "Original" }, { id: 1 }],
])(
  "keeps fields added or removed across another root's write recorded (%j -> %j)",
  (before, after) => {
    const state = stateOf(
      captureOf([
        ["GET", "/api/search/1", before],
        ["POST", "/api/items", { id: 2 }],
        ["GET", "/api/search/1", after],
      ]),
    );
    expect(state.types).toEqual([]);
    expect(state.entities).toEqual([]);
    expect(viewOf(state, "get_search_by_id")).toMatchObject({
      shape: "recorded",
      reason: "fields-differ",
    });
  },
);

it("reads only item totals and next-page markers as signs of a partial list", () => {
  const membership = (body: JsonValue) =>
    stateOf(captureOf([["GET", "/api/items", body]])).views.map((view) =>
      view.shape === "list" ? [view.membership, view.counters] : view.shape,
    );
  // Page and id numbers are not item totals, so a complete page stays whole.
  expect(
    membership({
      page: 1,
      total: 2,
      total_pages: 1,
      account_id: 77,
      items: [{ id: 1 }, { id: 2 }],
    }),
  ).toEqual([["all", ["total"]]]);
  expect(membership({ has_more: true, items: [{ id: 1 }, { id: 2 }] })).toEqual(
    [["recorded", []]],
  );
  expect(membership({ total: "50", items: [{ id: 1 }] })).toEqual([
    ["recorded", []],
  ]);
});
