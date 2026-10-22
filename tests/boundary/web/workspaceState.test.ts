import { describe, expect, it } from "vitest";
import {
  claimWorkspace,
  mergeRuns,
  ownWorkspace,
  summarizeRun,
} from "../../../web/src/workspaceState.js";
import type { Run } from "../../../web/src/types.js";
const run = (id: string, status: string): Run => ({
  id,
  tool: "inspect_artifact",
  arguments: {},
  status,
  createdAt: `2026-10-11T10:00:0${id}Z`,
});
describe("workspace response and live-tab ownership", () => {
  it("preserves a run submitted while an older workspace response was in flight", () => {
    const first = run("1", "running"),
      submitted = run("2", "queued");
    const merged = mergeRuns(
      [first, submitted],
      [{ ...first, status: "completed", completedAt: "2026-10-11T10:00:03Z" }],
    );
    expect(merged.map((r) => [r.id, r.status])).toEqual([
      ["1", "completed"],
      ["2", "queued"],
    ]);
  });
  it("does not resurrect cancelled runs from stale polling snapshots", () => {
    const stopped = {
      ...run("1", "cancelled"),
      completedAt: "2026-10-11T10:00:04Z",
    };
    expect(mergeRuns([stopped], [run("1", "running")])).toEqual([
      summarizeRun(stopped),
    ]);
  });
  it("forks a copied workspace while its original tab remains live, then reconnects after it closes", async () => {
    const id = crypto.randomUUID(),
      release = ownWorkspace(id);
    try {
      const duplicate = await claimWorkspace(id);
      expect(duplicate.id).toBeNull();
      duplicate.close();
    } finally {
      release();
    }
    const reload = await claimWorkspace(id);
    try {
      expect(reload.id).toBe(id);
    } finally {
      reload.close();
    }
  });
});

it("allows exactly one simultaneous claim of a copied workspace", async () => {
  const id = crypto.randomUUID();
  const claims = await Promise.all([claimWorkspace(id), claimWorkspace(id)]);
  try {
    expect(claims.filter((claim) => claim.id === id)).toHaveLength(1);
    expect(claims.filter((claim) => claim.id === null)).toHaveLength(1);
  } finally {
    claims.forEach((claim) => claim.close());
  }
});

it("merges older pages and full operation replies while retaining no argument or result bodies", () => {
  const first = {
    ...run("3", "completed"),
    arguments: { payload: "large input" },
    result: { content: "large evidence" },
  };
  const summaries = mergeRuns(
    [first],
    [run("1", "completed"), run("2", "running")],
  );
  expect(summaries.map((row) => row.id)).toEqual(["1", "2", "3"]);
  expect(summaries.find((row) => row.id === "3")).toMatchObject({
    hasResult: true,
  });
  expect(JSON.stringify(summaries)).not.toContain("large");
  expect(mergeRuns(summaries, [first])).toEqual(summaries);
});
