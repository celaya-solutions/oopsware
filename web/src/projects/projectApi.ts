import { z } from "zod";
import { token } from "../api";

/**
 * Client mirrors of the saved project shapes (src/domain/project/projectSchema.ts).
 * The server owns validation; these only check what the screens read.
 */
const runRefSchema = z.object({ workspace_id: z.string(), run_id: z.string() });
export const locationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("address"), address: z.string() }),
  z.object({ kind: z.literal("symbol"), symbol: z.string() }),
  z.object({ kind: z.literal("member_path"), path: z.string() }),
  z.object({
    kind: z.literal("graph_node"),
    node_id: z.string(),
    label: z.string(),
  }),
  z.object({ kind: z.literal("run"), ...runRefSchema.shape }),
]);
export const anchorSchema = z.object({
  target_sha256: z.string().nullable(),
  target_id: z.string().nullable(),
  location: locationSchema.nullable(),
});
const provenanceSchema = z.object({
  run: runRefSchema.nullable(),
  provider: z
    .object({
      id: z.string(),
      name: z.string(),
      version: z.string().nullable(),
    })
    .nullable(),
  profile_digest: z.string().nullable(),
});
const targetSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  kind: z.enum(["file", "folder", "bundle"]),
  size: z.number().nullable(),
  sha256: z.string().nullable(),
  format: z.string().nullable(),
  architecture: z.string().nullable(),
  addedAt: z.string(),
  source: z.enum(["manual", "run"]),
});
const stamped = {
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  provenance: provenanceSchema,
};
export const projectSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  title: z.string(),
  description: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  revision: z.number(),
  targets: z.array(targetSchema),
  notes: z.array(
    z.object({
      ...stamped,
      text: z.string(),
      anchor: anchorSchema.nullable(),
      kind: z.enum(["note", "comment", "inline_comment"]),
    }),
  ),
  bookmarks: z.array(
    z.object({ ...stamped, label: z.string(), anchor: anchorSchema }),
  ),
  renames: z.array(
    z.object({
      ...stamped,
      target_sha256: z.string(),
      address: z.string(),
      name: z.string(),
    }),
  ),
  runs: z.array(
    z.object({
      ...runRefSchema.shape,
      tool: z.string(),
      status: z.string(),
      createdAt: z.string(),
      completedAt: z.string().nullable(),
      target_id: z.string().nullable(),
      linkedAt: z.string(),
    }),
  ),
  reports: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      format: z.enum(["html", "pdf"]),
      file: z.string(),
      bytes: z.number(),
      createdAt: z.string(),
      run_ids: z.array(z.string()),
    }),
  ),
});
export type Project = z.infer<typeof projectSchema>;
export type Anchor = z.infer<typeof anchorSchema>;
export type ProjectTarget = Project["targets"][number];

const listSchema = z.object({
  projects: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      updatedAt: z.string(),
      targets: z.number(),
      runs: z.number(),
      recovered: z.boolean(),
      unreadable: z.string().optional(),
    }),
  ),
  total: z.number(),
  nextCursor: z.string().nullable(),
});
export type ProjectRow = z.infer<typeof listSchema>["projects"][number];

export const projectReply = z.object({ project: projectSchema });
const planSchema = z.object({
  plan: z.union([
    z.object({
      ok: z.literal(true),
      calls: z.array(
        z.object({
          tool: z.string(),
          arguments: z.record(z.string(), z.json()),
        }),
      ),
      skipped: z.array(
        z.object({ kind: z.string(), count: z.number(), reason: z.string() }),
      ),
    }),
    z.object({ ok: z.literal(false), reason: z.string() }),
  ]),
});
export type ApplyPlan = z.infer<typeof planSchema>["plan"];

/** A failed project request with its HTTP status and stable error code. */
export class ProjectRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

export async function request<T>(
  path: string,
  body: unknown,
  schema: z.ZodType<T>,
): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-rea-token": token, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value: unknown = await response.json();
  if (!response.ok) {
    const failure = z
      .object({ error: z.string(), message: z.string() })
      .safeParse(value);
    throw new ProjectRequestError(
      failure.success
        ? failure.data.message
        : `Request failed (${response.status})`,
      response.status,
      failure.success ? failure.data.error : "request_failed",
    );
  }
  return schema.parse(value);
}

export type ProjectEdit = { kind: string } & Record<string, unknown>;

export const listProjects = (cursor?: string) =>
  request(
    `/api/projects${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
    undefined,
    listSchema,
  );
export const createProject = async (title: string) =>
  (await request("/api/projects", { title }, projectReply)).project;
export const getProject = async (id: string) =>
  (
    await request(
      `/api/projects/${id}`,
      undefined,
      z.object({ project: projectSchema, recovered: z.boolean() }),
    )
  ).project;
export const deleteProject = (project: Project) =>
  request(
    `/api/projects/${project.id}/delete`,
    { revision: project.revision },
    z.object({ deleted: z.literal(true) }),
  );
/** Add a file by path; adding commutes, so a stale revision is retried once. */
export async function addProjectTarget(
  project: Project,
  path: string,
): Promise<Project> {
  const add = async (base: Project) =>
    (
      await request(
        `/api/projects/${base.id}/targets`,
        { revision: base.revision, path },
        projectReply,
      )
    ).project;
  try {
    return await add(project);
  } catch (cause) {
    if (!(cause instanceof ProjectRequestError) || cause.status !== 409)
      throw cause;
    return add(await getProject(project.id));
  }
}
export const linkProjectRun = async (
  project: Project,
  workspaceId: string,
  runId: string,
) =>
  (
    await request(
      `/api/projects/${project.id}/runs`,
      { workspaceId, runId },
      projectReply,
    )
  ).project;
export const planApply = async (
  project: Project,
  targetSha256: string,
  workspaceId: string,
) =>
  (
    await request(
      `/api/projects/${project.id}/apply-plan`,
      { targetSha256, workspaceId },
      planSchema,
    )
  ).plan;

/**
 * Save one edit. Another tab (or a settling run) may have moved the revision:
 * additions commute, so they are retried once on the fresh copy; other edits
 * reload and report the conflict.
 */
export async function editProject(
  project: Project,
  edit: ProjectEdit,
): Promise<Project> {
  const save = (base: Project) =>
    request(
      `/api/projects/${base.id}/edit`,
      { revision: base.revision, edit },
      projectReply,
    ).then((reply) => reply.project);
  try {
    return await save(project);
  } catch (cause) {
    if (!(cause instanceof ProjectRequestError) || cause.status !== 409)
      throw cause;
    const fresh = await getProject(project.id);
    if (edit.kind.startsWith("add_")) return save(fresh);
    throw new ProjectConflictReload(fresh);
  }
}

/** Thrown when an edit lost to a newer revision; carries the reloaded project. */
export class ProjectConflictReload extends Error {
  constructor(readonly project: Project) {
    super("This project changed in another tab. It was reloaded; try again.");
  }
}
