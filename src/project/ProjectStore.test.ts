import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProject } from "../domain/project/projectEdits.js";
import type { Project } from "../domain/project/projectSchema.js";
import { ProjectStore } from "./ProjectStore.js";

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "rea-projects-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const make = (
  title: string,
  updatedAt = "2026-10-21T10:00:00.000Z",
): Project => ({
  ...createProject(
    { id: crypto.randomUUID(), title },
    "2026-10-21T09:00:00.000Z",
  ),
  updatedAt,
});

describe("ProjectStore", () => {
  it("round-trips a project with owner-only permissions", async () => {
    const store = new ProjectStore(root);
    const project = make("Round trip");
    await store.write(project);
    expect(await store.read(project.id)).toEqual({ project, recovered: false });
    const file = await stat(join(root, project.id, "project.json"));
    const folder = await stat(join(root, project.id));
    expect(file.mode & 0o777).toBe(0o600);
    expect(folder.mode & 0o777).toBe(0o700);
  });

  it("recovers from bak", async () => {
    const store = new ProjectStore(root);
    const first = make("First");
    await store.write(first);
    await store.write({ ...first, title: "Second", revision: 1 });
    await writeFile(join(root, first.id, "project.json"), "{");
    expect(await store.read(first.id)).toEqual({
      project: first,
      recovered: true,
    });
    const listed = await store.list();
    expect(listed.projects[0]).toMatchObject({ id: first.id, recovered: true });
  });

  it("lists an unreadable project without throwing", async () => {
    const store = new ProjectStore(root);
    const project = make("Broken");
    await store.write(project);
    await writeFile(join(root, project.id, "project.json"), "not json");
    expect(await store.read(project.id)).toBeUndefined();
    const listed = await store.list();
    expect(listed.projects).toHaveLength(1);
    expect(listed.projects[0]?.unreadable).toMatch(/could not be read/i);
  });

  it("ignores a leftover temporary file", async () => {
    const store = new ProjectStore(root);
    const project = make("Temp");
    await store.write(project);
    await writeFile(
      join(root, project.id, `project.json.${crypto.randomUUID()}.tmp`),
      "{",
    );
    expect((await store.read(project.id))?.project.title).toBe("Temp");
    expect((await store.list()).projects).toHaveLength(1);
  });

  it("pages newest first", async () => {
    const store = new ProjectStore(root);
    await store.write(make("Old", "2026-10-01T00:00:00.000Z"));
    await store.write(make("Middle", "2026-10-10T00:00:00.000Z"));
    await store.write(make("New", "2026-10-20T00:00:00.000Z"));
    const first = await store.list(undefined, 2);
    expect(first.projects.map((row) => row.title)).toEqual(["New", "Middle"]);
    expect(first.total).toBe(3);
    expect(first.nextCursor).not.toBeNull();
    const second = await store.list(first.nextCursor ?? undefined, 2);
    expect(second.projects.map((row) => row.title)).toEqual(["Old"]);
    expect(second.nextCursor).toBeNull();
  });

  it("removes a project folder", async () => {
    const store = new ProjectStore(root);
    const project = make("Gone");
    await store.write(project);
    expect(await store.remove(project.id)).toBe(true);
    expect(await store.read(project.id)).toBeUndefined();
    expect(await readdir(root)).toEqual([]);
    expect(await store.remove(project.id)).toBe(false);
  });

  it("refuses a malformed id and reports an absent one as undefined", async () => {
    const store = new ProjectStore(root);
    await expect(store.read("../escape")).rejects.toThrow(/project id/i);
    expect(await store.read(crypto.randomUUID())).toBeUndefined();
  });
});
