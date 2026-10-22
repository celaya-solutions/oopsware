import { describe, expect, it } from "vitest";
import { createProject, applyProjectEdit } from "./projectEdits.js";
import {
  PROJECT_LIMITS,
  projectSchema,
  type Project,
  type ProjectTarget,
} from "./projectSchema.js";

const T0 = "2026-10-21T10:00:00.000Z";
const T1 = "2026-10-21T10:05:00.000Z";
const ID = "8f6c0f1e-6a4e-4d8b-9a55-0d6b1f0e2c11";

const fresh = (): Project =>
  createProject({ id: ID, title: "Calculator study" }, T0);

const edited = (
  project: Project,
  edit: Parameters<typeof applyProjectEdit>[1],
) => {
  const result = applyProjectEdit(project, edit, T1);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

const target = (sha256: string | null, path = "/tmp/app"): ProjectTarget => ({
  id: crypto.randomUUID(),
  name: "app",
  path,
  kind: "file",
  size: 10,
  sha256,
  format: "mach-o",
  architecture: null,
  addedAt: T0,
  source: "manual",
});

describe("createProject", () => {
  it("starts at revision 0 with empty collections", () => {
    const project = fresh();
    expect(projectSchema.parse(project)).toEqual(project);
    expect(project).toMatchObject({
      version: 1,
      id: ID,
      title: "Calculator study",
      description: "",
      revision: 0,
      createdAt: T0,
      updatedAt: T0,
      targets: [],
      notes: [],
      bookmarks: [],
      renames: [],
      runs: [],
      reports: [],
    });
  });
});

describe("applyProjectEdit", () => {
  it("adds and updates a note, bumping the revision each time", () => {
    const added = edited(fresh(), { kind: "add_note", text: "entry point" });
    const id = added.notes[0]?.id ?? "";
    const updated = edited(added, { kind: "update_note", id, text: "main" });
    expect(updated.revision).toBe(2);
    expect(updated.notes).toHaveLength(1);
    expect(updated.notes[0]).toMatchObject({
      id,
      text: "main",
      kind: "note",
      updatedAt: T1,
    });
    expect(updated.updatedAt).toBe(T1);
  });

  it("refuses to delete an unknown note and leaves the project unchanged", () => {
    const project = fresh();
    const result = applyProjectEdit(
      project,
      { kind: "delete_note", id: crypto.randomUUID() },
      T1,
    );
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.message).toBe(
        "No note with that id in this project.",
      );
    expect(project.revision).toBe(0);
  });

  it("rejects oversize and control text", () => {
    const refuse = (edit: Parameters<typeof applyProjectEdit>[1]) =>
      applyProjectEdit(fresh(), edit, T1).ok;
    expect(refuse({ kind: "set_title", title: "x".repeat(201) })).toBe(false);
    expect(refuse({ kind: "set_title", title: "a\u0007b" })).toBe(false);
    expect(refuse({ kind: "set_title", title: "a\u202eb" })).toBe(false);
    expect(refuse({ kind: "set_title", title: "   " })).toBe(false);
    expect(refuse({ kind: "add_note", text: "é".repeat(32_768) + "x" })).toBe(
      false,
    );
    expect(refuse({ kind: "add_note", text: "line one\nline two\tend" })).toBe(
      true,
    );
    expect(refuse({ kind: "set_title", title: "x".repeat(200) })).toBe(true);
  });

  it("enforces the note and target limits with a plain message", () => {
    const full = projectSchema.parse({
      ...fresh(),
      notes: Array.from({ length: PROJECT_LIMITS.notes }, () => ({
        id: crypto.randomUUID(),
        text: "n",
        anchor: null,
        kind: "note",
        createdAt: T0,
        updatedAt: T0,
        provenance: { run: null, provider: null, profile_digest: null },
      })),
      targets: Array.from({ length: PROJECT_LIMITS.targets }, (_, index) =>
        target(index.toString(16).padStart(64, "0")),
      ),
    });
    const note = applyProjectEdit(full, { kind: "add_note", text: "x" }, T1);
    expect(note.ok).toBe(false);
    if (!note.ok) expect(note.error.message).toContain("2,000 notes");
    const more = applyProjectEdit(
      full,
      { kind: "add_target", target: target("f".repeat(64)) },
      T1,
    );
    expect(more.ok).toBe(false);
    if (!more.ok) expect(more.error.message).toContain("200 targets");
  });

  it("does not duplicate a target with the same SHA-256", () => {
    const sha = "a".repeat(64);
    const once = edited(fresh(), { kind: "add_target", target: target(sha) });
    const twice = edited(once, {
      kind: "add_target",
      target: target(sha, "/elsewhere/app"),
    });
    expect(twice.targets).toHaveLength(1);
    expect(twice.revision).toBe(2);
  });

  it("adds a bookmark and a rename, then deletes the rename", () => {
    const sha = "b".repeat(64);
    const withBookmark = edited(fresh(), {
      kind: "add_bookmark",
      label: "decrypt loop",
      anchor: {
        target_sha256: sha,
        target_id: null,
        location: { kind: "address", address: "0x1000" },
      },
    });
    const withRename = edited(withBookmark, {
      kind: "add_rename",
      target_sha256: sha,
      address: "0x1000",
      name: "decrypt",
    });
    const id = withRename.renames[0]?.id ?? "";
    const removed = edited(withRename, { kind: "delete_rename", id });
    expect(removed.bookmarks[0]?.label).toBe("decrypt loop");
    expect(removed.renames).toEqual([]);
    expect(removed.revision).toBe(3);
  });

  it("stores a hostile-looking key as plain note text", () => {
    const project = edited(fresh(), { kind: "add_note", text: "__proto__" });
    expect(project.notes[0]?.text).toBe("__proto__");
    expect(Object.getPrototypeOf(project)).toBe(Object.prototype);
  });
});
