import { z } from "zod";
import {
  ProjectConflict,
  ProjectNotFound,
  type ProjectService,
} from "../application/project/ProjectService.js";
import type { SessionIdentity } from "../domain/project/applyPlan.js";
import { projectEditSchema } from "../domain/project/projectEdits.js";
import { ProjectEditError } from "../domain/project/projectSchema.js";
import {
  expandProviderCapabilities,
  providerCapabilitySet,
} from "../contracts/toolOutputSchemaPrimitives.js";
import { WebFailure } from "./WebFailure.js";

const NAMES = "set_addresses_names";
const COMMENTS = "set_comment";
const BOOKMARKS = "set_bookmark";

const sessionResult = z.object({
  structuredContent: z
    .object({
      result: z
        .object({
          open: z.boolean(),
          sha256: z.string().optional(),
          capabilities: z.array(z.unknown()).optional(),
          analysis_provider_binding: z
            .object({
              provider: z.object({ id: z.string() }),
              analysis_profile: z
                .object({ digest: z.string() })
                .nullable()
                .optional(),
            })
            .nullable()
            .optional(),
        })
        .passthrough(),
    })
    .passthrough(),
});

/**
 * Read what the open native session says about itself. `binary_session`
 * reports no analysis profile, so the profile digest stays unknown.
 */
export const sessionIdentityFrom = (result: unknown): SessionIdentity => {
  const parsed = sessionResult.safeParse(result);
  const unknown: SessionIdentity = {
    sha256: null,
    provider_id: null,
    profile_digest: null,
    capabilities: { names: false, comments: false, bookmarks: false },
  };
  if (!parsed.success || !parsed.data.structuredContent.result.open)
    return unknown;
  const session = parsed.data.structuredContent.result;
  const provider = session.analysis_provider_binding?.provider.id ?? null;
  const sets = z
    .array(providerCapabilitySet)
    .safeParse(session.capabilities ?? []);
  const available = new Set(
    (sets.success ? expandProviderCapabilities(sets.data) : [])
      .filter((item) => item.available && item.provider.id === provider)
      .map((item) => item.operation),
  );
  return {
    sha256: session.sha256 ?? null,
    provider_id: provider,
    profile_digest:
      session.analysis_provider_binding?.analysis_profile?.digest ?? null,
    capabilities: {
      names: available.has(NAMES),
      comments: available.has(COMMENTS),
      bookmarks: available.has(BOOKMARKS),
    },
  };
};

const revisionBody = z.object({ revision: z.number().int().min(0) });

/** Map project service failures onto the dashboard's HTTP failure shape. */
export const translate = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (cause) {
    if (cause instanceof ProjectNotFound)
      throw new WebFailure(404, "project_not_found", cause.message);
    if (cause instanceof ProjectConflict)
      throw new WebFailure(409, "project_conflict", cause.message);
    if (cause instanceof ProjectEditError)
      throw new WebFailure(400, "invalid_project_edit", cause.message);
    throw cause;
  }
};

type Reply = { status: number; body: unknown };
type ProjectAction = (
  projects: ProjectService,
  id: string,
  body: unknown,
  readSession: (workspaceId: string) => Promise<unknown>,
) => Promise<Reply>;

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/** POST actions on one project, each parsing its own body. */
const ACTIONS: Readonly<Record<string, ProjectAction>> = {
  edit: async (projects, id, body) => {
    const input = revisionBody.extend({ edit: projectEditSchema }).parse(body);
    return {
      status: 200,
      body: { project: await projects.edit(id, input.revision, input.edit) },
    };
  },
  targets: async (projects, id, body) => {
    const input = revisionBody.extend({ path: z.string().min(1) }).parse(body);
    return {
      status: 200,
      body: {
        project: await projects.addTarget(id, input.revision, input.path),
      },
    };
  },
  runs: async (projects, id, body) => {
    const input = z
      .object({ workspaceId: z.uuid(), runId: z.uuid() })
      .parse(body);
    return {
      status: 200,
      body: {
        project: await projects.linkStoredRun(
          id,
          input.workspaceId,
          input.runId,
        ),
      },
    };
  },
  "apply-plan": async (projects, id, body, readSession) => {
    const input = z
      .object({ targetSha256: sha256, workspaceId: z.uuid() })
      .parse(body);
    const session = sessionIdentityFrom(await readSession(input.workspaceId));
    return {
      status: 200,
      body: { plan: await projects.planApply(id, input.targetSha256, session) },
    };
  },
  delete: async (projects, id, body) => {
    await projects.remove(id, revisionBody.parse(body).revision);
    return { status: 200, body: { deleted: true } };
  },
};

const listOrCreate = async (
  projects: ProjectService,
  url: URL,
  method: string | undefined,
  readBody: () => Promise<unknown>,
): Promise<Reply | undefined> => {
  if (method === "GET") {
    const query = z
      .object({
        cursor: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
      })
      .parse(Object.fromEntries(url.searchParams));
    return {
      status: 200,
      body: await projects.list(query.cursor, query.limit),
    };
  }
  if (method !== "POST") return undefined;
  const input = z
    .object({ title: z.string(), description: z.string().optional() })
    .parse(await readBody());
  return translate(async () => ({
    status: 201,
    body: { project: await projects.create(input) },
  }));
};

/** `/api/projects…` routes; `undefined` when the path is not a project route. */
export const createProjectRoutes = (
  projects: ProjectService,
  readSession: (workspaceId: string) => Promise<unknown>,
) => {
  return async (
    requestPath: string,
    method: string | undefined,
    readBody: () => Promise<unknown>,
  ): Promise<Reply | undefined> => {
    const url = new URL(requestPath, "http://localhost");
    if (url.pathname === "/api/projects")
      return listOrCreate(projects, url, method, readBody);
    const route = /^\/api\/projects\/([^/]+)(?:\/([a-z-]+))?$/.exec(
      url.pathname,
    );
    if (!route) return undefined;
    const parsedId = z.uuid().safeParse(route[1]);
    if (!parsedId.success)
      throw new WebFailure(
        404,
        "project_not_found",
        "This project does not exist.",
      );
    const id = parsedId.data;
    const action = route[2];
    if (action === undefined && method === "GET")
      return translate(async () => {
        // Settling links is best effort; the project must still open.
        await projects.refreshRuns(id).catch(() => undefined);
        return { status: 200, body: await projects.get(id) };
      });
    const handler = action === undefined ? undefined : ACTIONS[action];
    if (handler === undefined || method !== "POST") return undefined;
    const body = await readBody();
    return translate(() => handler(projects, id, body, readSession));
  };
};
