import { describe, expect, it } from "vitest";
import { createEvidence } from "../evidence.js";
import { createAnalysisProfile } from "../analysisProfile.js";
import type { JsonValue } from "../jsonValue.js";
import {
  applyCaptures,
  captureAnnotations,
  targetFromRun,
  type ProjectRunRecord,
} from "./annotationCapture.js";
import { createProject } from "./projectEdits.js";
import type { Project } from "./projectSchema.js";

const T0 = "2026-10-21T10:00:00.000Z";
const SHA = "a".repeat(64);
const WORKSPACE = "3d1f6a2c-7b8e-4c5d-9e0f-112233445566";
const HOPPER = { id: "hopper", name: "Hopper", version: "6.0.0" };

let runNumber = 0;
const run = (
  tool: string,
  args: Record<string, JsonValue>,
  result: JsonValue,
  overrides: Partial<ProjectRunRecord> = {},
): ProjectRunRecord => {
  const evidence = createEvidence(
    { path: "/tmp/Calculator", sha256: SHA, format: "mach-o" },
    HOPPER,
    {
      operation: tool,
      parameters: args,
      result,
      analysisProfile: createAnalysisProfile(HOPPER, { base: "0x0" }),
    },
  );
  runNumber += 1;
  return {
    id: `00000000-0000-4000-8000-${String(runNumber).padStart(12, "0")}`,
    tool,
    arguments: args,
    status: "completed",
    createdAt: T0,
    completedAt: T0,
    result: { content: [], structuredContent: evidence },
    ...overrides,
  };
};

const project = (): Project =>
  createProject({ id: "8f6c0f1e-6a4e-4d8b-9a55-0d6b1f0e2c11", title: "P" }, T0);

const applied = (base: Project, records: ProjectRunRecord[]) =>
  records.reduce((current, record) => {
    const result = applyCaptures(
      current,
      captureAnnotations(record, WORKSPACE),
      T0,
    );
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  }, base);

describe("captureAnnotations", () => {
  it("copies a set_address_name with a true readback", () => {
    const captures = captureAnnotations(
      run("set_address_name", { address: "0x1000", name: "decrypt" }, true),
      WORKSPACE,
    );
    expect(captures).toEqual([
      expect.objectContaining({
        op: "upsert",
        kind: "name",
        target_sha256: SHA,
        address: "0x1000",
        value: "decrypt",
      }),
    ]);
    expect(captures[0]?.provenance.provider).toEqual(HOPPER);
    expect(captures[0]?.provenance.profile_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(captures[0]?.provenance.run?.workspace_id).toBe(WORKSPACE);
  });

  it("false readback copies nothing", () => {
    expect(
      captureAnnotations(
        run("set_address_name", { address: "0x1000", name: "x" }, false),
        WORKSPACE,
      ),
    ).toEqual([]);
  });

  it("copies only the true addresses of set_addresses_names", () => {
    const captures = captureAnnotations(
      run(
        "set_addresses_names",
        { names: { "0x10": "a", "0x20": "b" } },
        { "0x10": true, "0x20": false },
      ),
      WORKSPACE,
    );
    expect(captures.map((c) => [c.address, c.value])).toEqual([["0x10", "a"]]);
  });

  it("turns an empty comment into a delete", () => {
    expect(
      captureAnnotations(
        run("set_comment", { address: "0x10", comment: "" }, true),
        WORKSPACE,
      ),
    ).toEqual([expect.objectContaining({ op: "delete", kind: "comment" })]);
  });

  it("reads annotate_native_function from its readback", () => {
    const captures = captureAnnotations(
      run(
        "annotate_native_function",
        { procedure: "sub_10", name: "parse", comment: "reads header" },
        {
          annotations: {
            address: "0x10",
            name: "parse",
            comment: "reads header",
            inline_comment: null,
          },
        },
      ),
      WORKSPACE,
    );
    expect(captures.map((c) => [c.kind, c.op, c.address, c.value])).toEqual([
      ["name", "upsert", "0x10", "parse"],
      ["comment", "upsert", "0x10", "reads header"],
    ]);
  });

  it("ignores failed runs, error results and runs without a subject", () => {
    const failed = run(
      "set_address_name",
      { address: "0x1", name: "x" },
      true,
      {
        status: "failed",
      },
    );
    const errored = run(
      "set_address_name",
      { address: "0x1", name: "x" },
      true,
    );
    errored.result = { isError: true, content: [] };
    const noSubject = {
      ...run("set_address_name", { address: "0x1", name: "x" }, true),
    };
    noSubject.result = { content: [], structuredContent: { ok: true } };
    for (const record of [failed, errored, noSubject])
      expect(captureAnnotations(record, WORKSPACE)).toEqual([]);
  });
});

describe("applyCaptures", () => {
  it("repeated capture replaces instead of duplicating", () => {
    const result = applied(project(), [
      run("set_address_name", { address: "0x1000", name: "first" }, true),
      run("set_address_name", { address: "0x1000", name: "second" }, true),
    ]);
    expect(result.renames).toHaveLength(1);
    expect(result.renames[0]?.name).toBe("second");
  });

  it("maps comments to notes and bookmarks to bookmarks, and unset deletes", () => {
    const withMarks = applied(project(), [
      run("set_inline_comment", { address: "0x20", comment: "loop" }, true),
      run("set_bookmark", { address: "0x20", name: "hot" }, true),
    ]);
    expect(withMarks.notes[0]).toMatchObject({
      kind: "inline_comment",
      text: "loop",
      anchor: {
        target_sha256: SHA,
        location: { kind: "address", address: "0x20" },
      },
    });
    expect(withMarks.bookmarks[0]?.label).toBe("hot");
    const cleared = applied(withMarks, [
      run("unset_bookmark", { address: "0x20" }, true),
      run("set_inline_comment", { address: "0x20", comment: "" }, true),
    ]);
    expect(cleared.bookmarks).toEqual([]);
    expect(cleared.notes).toEqual([]);
  });

  it("keeps an existing bookmark label when set_bookmark omits the name", () => {
    const result = applied(project(), [
      run("set_bookmark", { address: "0x30", name: "keep me" }, true),
      run("set_bookmark", { address: "0x30" }, true),
    ]);
    expect(result.bookmarks.map((b) => b.label)).toEqual(["keep me"]);
  });
});

describe("targetFromRun", () => {
  it("uses the Evidence subject when present", () => {
    expect(
      targetFromRun(
        run("set_address_name", { address: "0x1", name: "x" }, true),
        T0,
      ),
    ).toMatchObject({
      name: "Calculator",
      path: "/tmp/Calculator",
      sha256: SHA,
      format: "mach-o",
      kind: "file",
      source: "run",
    });
  });

  it("falls back to targetPath with an unknown digest", () => {
    expect(
      targetFromRun(
        {
          id: "00000000-0000-4000-8000-000000000999",
          tool: "inspect_artifact",
          arguments: {},
          status: "failed",
          createdAt: T0,
          targetPath: "/tmp/thing.bin",
        },
        T0,
      ),
    ).toMatchObject({
      path: "/tmp/thing.bin",
      sha256: null,
      name: "thing.bin",
    });
  });
});
