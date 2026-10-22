import { z } from "zod";
import { err, ok, type Result } from "../result.js";
import {
  PROJECT_LIMITS,
  ProjectEditError,
  anchorSchema,
  lineSchema,
  noteTextSchema,
  projectSchema,
  projectTargetSchema,
  titleSchema,
  type Anchor,
  type Project,
  type ProjectTarget,
  type Provenance,
} from "./projectSchema.js";

/** Every change an analyst can make to a project by hand. */
export const projectEditSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("set_title"), title: z.string() }),
  z.strictObject({
    kind: z.literal("set_description"),
    description: z.string(),
  }),
  z.strictObject({
    kind: z.literal("add_note"),
    text: z.string(),
    anchor: anchorSchema.nullable().optional(),
  }),
  z.strictObject({
    kind: z.literal("update_note"),
    id: z.uuid(),
    text: z.string().optional(),
    anchor: anchorSchema.nullable().optional(),
  }),
  z.strictObject({ kind: z.literal("delete_note"), id: z.uuid() }),
  z.strictObject({
    kind: z.literal("add_bookmark"),
    label: z.string(),
    anchor: anchorSchema,
  }),
  z.strictObject({
    kind: z.literal("update_bookmark"),
    id: z.uuid(),
    label: z.string().optional(),
    anchor: anchorSchema.optional(),
  }),
  z.strictObject({ kind: z.literal("delete_bookmark"), id: z.uuid() }),
  z.strictObject({
    kind: z.literal("add_rename"),
    target_sha256: z.string(),
    address: z.string(),
    name: z.string(),
  }),
  z.strictObject({
    kind: z.literal("update_rename"),
    id: z.uuid(),
    name: z.string().optional(),
  }),
  z.strictObject({ kind: z.literal("delete_rename"), id: z.uuid() }),
  z.strictObject({
    kind: z.literal("add_target"),
    target: projectTargetSchema,
  }),
  z.strictObject({ kind: z.literal("remove_target"), id: z.uuid() }),
]);
export type ProjectEdit = z.infer<typeof projectEditSchema>;

const NO_PROVENANCE: Provenance = {
  run: null,
  provider: null,
  profile_digest: null,
};

const plain = (schema: z.ZodType<string>, value: string) => {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new ProjectEditError(
    parsed.error.issues[0]?.message ?? "That text cannot be saved.",
  );
};

/** Refuse a change that would grow a collection past its ceiling. */
export const limit = (count: number, max: number, noun: string) => {
  if (count >= max)
    throw new ProjectEditError(
      `A project can hold up to ${max.toLocaleString("en-US")} ${noun}.`,
    );
};

const missing = (noun: string): never => {
  throw new ProjectEditError(`No ${noun} with that id in this project.`);
};

/** Start an empty version 1 project. */
export const createProject = (
  input: { id: string; title: string; description?: string },
  now: string,
): Project =>
  projectSchema.parse({
    version: 1,
    id: input.id,
    title: input.title,
    description: input.description ?? "",
    createdAt: now,
    updatedAt: now,
    revision: 0,
    targets: [],
    notes: [],
    bookmarks: [],
    renames: [],
    runs: [],
    reports: [],
  });

/** Add a target unless one with the same SHA-256 (or folder path) is already there. */
export const withTarget = (
  project: Project,
  target: ProjectTarget,
): Project => {
  const known = project.targets.some((existing) =>
    target.sha256 === null
      ? existing.sha256 === null && existing.path === target.path
      : existing.sha256 === target.sha256,
  );
  if (known) return project;
  limit(project.targets.length, PROJECT_LIMITS.targets, "targets");
  return { ...project, targets: [...project.targets, target] };
};

const replaceById = <T extends { id: string }>(
  items: readonly T[],
  id: string,
  noun: string,
  change: (item: T) => T,
): T[] => {
  if (!items.some((item) => item.id === id)) missing(noun);
  return items.map((item) => (item.id === id ? change(item) : item));
};

const removeById = <T extends { id: string }>(
  items: readonly T[],
  id: string,
  noun: string,
): T[] => {
  if (!items.some((item) => item.id === id)) missing(noun);
  return items.filter((item) => item.id !== id);
};

type MarkEdit = Extract<
  ProjectEdit,
  {
    kind:
      | "add_bookmark"
      | "update_bookmark"
      | "delete_bookmark"
      | "add_rename"
      | "update_rename"
      | "delete_rename";
  }
>;

const markChange = (project: Project, edit: MarkEdit, now: string): Project => {
  switch (edit.kind) {
    case "add_bookmark":
      limit(project.bookmarks.length, PROJECT_LIMITS.bookmarks, "bookmarks");
      return {
        ...project,
        bookmarks: [
          ...project.bookmarks,
          {
            id: crypto.randomUUID(),
            label: plain(lineSchema(1024), edit.label),
            anchor: edit.anchor satisfies Anchor,
            createdAt: now,
            updatedAt: now,
            provenance: NO_PROVENANCE,
          },
        ],
      };
    case "update_bookmark":
      return {
        ...project,
        bookmarks: replaceById(
          project.bookmarks,
          edit.id,
          "bookmark",
          (item) => ({
            ...item,
            ...(edit.label === undefined
              ? {}
              : { label: plain(lineSchema(1024), edit.label) }),
            ...(edit.anchor === undefined ? {} : { anchor: edit.anchor }),
            updatedAt: now,
          }),
        ),
      };
    case "delete_bookmark":
      return {
        ...project,
        bookmarks: removeById(project.bookmarks, edit.id, "bookmark"),
      };
    case "add_rename":
      limit(project.renames.length, PROJECT_LIMITS.renames, "renames");
      return {
        ...project,
        renames: [
          ...project.renames,
          {
            id: crypto.randomUUID(),
            target_sha256: edit.target_sha256,
            address: edit.address,
            name: plain(lineSchema(4096), edit.name),
            createdAt: now,
            updatedAt: now,
            provenance: NO_PROVENANCE,
          },
        ],
      };
    case "update_rename":
      return {
        ...project,
        renames: replaceById(project.renames, edit.id, "rename", (item) => ({
          ...item,
          ...(edit.name === undefined
            ? {}
            : { name: plain(lineSchema(4096), edit.name) }),
          updatedAt: now,
        })),
      };
    case "delete_rename":
      return {
        ...project,
        renames: removeById(project.renames, edit.id, "rename"),
      };
  }
};

const change = (project: Project, edit: ProjectEdit, now: string): Project => {
  switch (edit.kind) {
    case "set_title":
      return { ...project, title: plain(titleSchema, edit.title) };
    case "set_description":
      return {
        ...project,
        description: plain(noteTextSchema, edit.description),
      };
    case "add_note":
      limit(project.notes.length, PROJECT_LIMITS.notes, "notes");
      return {
        ...project,
        notes: [
          ...project.notes,
          {
            id: crypto.randomUUID(),
            text: plain(noteTextSchema, edit.text),
            anchor: edit.anchor ?? null,
            kind: "note",
            createdAt: now,
            updatedAt: now,
            provenance: NO_PROVENANCE,
          },
        ],
      };
    case "update_note":
      return {
        ...project,
        notes: replaceById(project.notes, edit.id, "note", (note) => ({
          ...note,
          ...(edit.text === undefined
            ? {}
            : { text: plain(noteTextSchema, edit.text) }),
          ...(edit.anchor === undefined ? {} : { anchor: edit.anchor }),
          updatedAt: now,
        })),
      };
    case "delete_note":
      return { ...project, notes: removeById(project.notes, edit.id, "note") };
    case "add_bookmark":
    case "update_bookmark":
    case "delete_bookmark":
    case "add_rename":
    case "update_rename":
    case "delete_rename":
      return markChange(project, edit, now);
    case "add_target":
      return withTarget(project, edit.target);
    case "remove_target":
      return {
        ...project,
        targets: removeById(project.targets, edit.id, "target"),
      };
  }
};

/** Apply one analyst edit; on success the revision rises by one. */
export const applyProjectEdit = (
  project: Project,
  edit: ProjectEdit,
  now: string,
): Result<Project, ProjectEditError> => {
  try {
    const next = change(project, edit, now);
    const parsed = projectSchema.safeParse({
      ...next,
      revision: project.revision + 1,
      updatedAt: now,
    });
    if (!parsed.success)
      return err(
        new ProjectEditError(
          parsed.error.issues[0]?.message ?? "That change cannot be saved.",
        ),
      );
    return ok(parsed.data);
  } catch (cause) {
    if (cause instanceof ProjectEditError) return err(cause);
    throw cause;
  }
};
