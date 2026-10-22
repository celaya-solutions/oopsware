import { z } from "zod";

/** Per-project ceilings; a change past one is refused, never truncated. */
export const PROJECT_LIMITS = {
  notes: 2000,
  bookmarks: 5000,
  renames: 20000,
  runs: 10000,
  targets: 200,
  titleChars: 200,
  noteBytes: 65536,
  reports: 1000,
} as const;

// Control, line-break and bidirectional-override characters hide or reorder
// what an analyst reads in a title or label.
const UNSAFE_LINE =
  /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
// Note text may keep newlines and tabs; everything else unsafe stays refused.
const UNSAFE_TEXT =
  /[\x00-\x08\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

const id = z.uuid();
const time = z.iso.datetime();
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/** Replace hidden or reordering characters so untrusted display text stays readable. */
export const plainLine = (value: string, max: number): string =>
  value.replace(new RegExp(UNSAFE_LINE.source, "g"), "\uFFFD").slice(0, max);

/** One line of analyst text: titles, labels, names. */
export const lineSchema = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => !UNSAFE_LINE.test(value), {
      message: "Use plain text without control or direction characters.",
    });

export const titleSchema = lineSchema(PROJECT_LIMITS.titleChars).refine(
  (value) => value.trim().length > 0,
  { message: "A project needs a title." },
);

export const noteTextSchema = z
  .string()
  .refine(
    (value) =>
      new TextEncoder().encode(value).length <= PROJECT_LIMITS.noteBytes,
    { message: "A note can hold up to 64 KiB of text." },
  )
  .refine((value) => !UNSAFE_TEXT.test(value), {
    message: "Use plain text without control or direction characters.",
  });

export const runRefSchema = z.strictObject({
  workspace_id: id,
  run_id: id,
});

export const locationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("address"), address: lineSchema(200) }),
  z.strictObject({ kind: z.literal("symbol"), symbol: lineSchema(4096) }),
  z.strictObject({ kind: z.literal("member_path"), path: lineSchema(4096) }),
  z.strictObject({
    kind: z.literal("graph_node"),
    node_id: lineSchema(200),
    label: lineSchema(4096),
  }),
  z.strictObject({ kind: z.literal("run"), ...runRefSchema.shape }),
]);

export const anchorSchema = z.strictObject({
  target_sha256: sha256.nullable(),
  target_id: id.nullable(),
  location: locationSchema.nullable(),
});

export const provenanceSchema = z.strictObject({
  run: runRefSchema.nullable(),
  provider: z
    .strictObject({
      id: z.string().min(1),
      name: z.string().min(1),
      version: z.string().nullable(),
    })
    .nullable(),
  profile_digest: z.string().min(1).nullable(),
});

export const projectTargetSchema = z.strictObject({
  id,
  name: lineSchema(1024),
  path: z.string().min(1),
  kind: z.enum(["file", "folder", "bundle"]),
  size: z.number().int().min(0).nullable(),
  sha256: sha256.nullable(),
  format: z.string().min(1).nullable(),
  architecture: z.string().min(1).nullable(),
  addedAt: time,
  source: z.enum(["manual", "run"]),
});

export const projectNoteSchema = z.strictObject({
  id,
  text: noteTextSchema,
  anchor: anchorSchema.nullable(),
  kind: z.enum(["note", "comment", "inline_comment"]),
  createdAt: time,
  updatedAt: time,
  provenance: provenanceSchema,
});

export const projectBookmarkSchema = z.strictObject({
  id,
  label: lineSchema(1024),
  anchor: anchorSchema,
  createdAt: time,
  updatedAt: time,
  provenance: provenanceSchema,
});

export const projectRenameSchema = z.strictObject({
  id,
  target_sha256: sha256,
  address: lineSchema(200).refine((value) => value.length > 0),
  name: lineSchema(4096).refine((value) => value.length > 0),
  createdAt: time,
  updatedAt: time,
  provenance: provenanceSchema,
});

export const RUN_LINK_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "missing",
] as const;

export const projectRunLinkSchema = z.strictObject({
  ...runRefSchema.shape,
  tool: z.string().min(1),
  status: z.enum(RUN_LINK_STATUSES),
  createdAt: time,
  completedAt: time.nullable(),
  target_id: id.nullable(),
  linkedAt: time,
  /** Why a settled run's file or annotations were not copied in, if they were not. */
  problem: z.string().max(1000).nullable().default(null),
});

export const projectReportEntrySchema = z.strictObject({
  id,
  title: lineSchema(PROJECT_LIMITS.titleChars),
  format: z.enum(["html", "pdf"]),
  file: z.string().regex(/^[A-Za-z0-9._-]+$/),
  bytes: z.number().int().min(0),
  createdAt: time,
  run_ids: z.array(id),
});

/** Version 1 of a saved project; strict so unknown fields are never dropped silently. */
export const projectSchema = z.strictObject({
  version: z.literal(1),
  id,
  title: titleSchema,
  description: noteTextSchema,
  createdAt: time,
  updatedAt: time,
  revision: z.number().int().min(0),
  targets: z.array(projectTargetSchema).max(PROJECT_LIMITS.targets),
  notes: z.array(projectNoteSchema).max(PROJECT_LIMITS.notes),
  bookmarks: z.array(projectBookmarkSchema).max(PROJECT_LIMITS.bookmarks),
  renames: z.array(projectRenameSchema).max(PROJECT_LIMITS.renames),
  runs: z.array(projectRunLinkSchema).max(PROJECT_LIMITS.runs),
  reports: z.array(projectReportEntrySchema).max(PROJECT_LIMITS.reports),
});

export type Project = z.infer<typeof projectSchema>;
export type ProjectTarget = z.infer<typeof projectTargetSchema>;
export type Anchor = z.infer<typeof anchorSchema>;
export type Provenance = z.infer<typeof provenanceSchema>;
export type ProjectNote = z.infer<typeof projectNoteSchema>;
export type ProjectBookmark = z.infer<typeof projectBookmarkSchema>;
export type ProjectRename = z.infer<typeof projectRenameSchema>;
export type ProjectRunLink = z.infer<typeof projectRunLinkSchema>;
export type ProjectReportEntry = z.infer<typeof projectReportEntrySchema>;

/** One row of the project list; an unreadable folder is listed, never hidden. */
export interface ProjectListRow {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly targets: number;
  readonly runs: number;
  readonly recovered: boolean;
  readonly unreadable?: string;
}

/** A refused project change, worded for the analyst. */
export class ProjectEditError extends Error {
  readonly _tag = "ProjectEditError";
}
