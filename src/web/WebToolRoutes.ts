import { z } from "zod";
import { createWebToolCatalog } from "./WebToolCatalog.js";
import type { ToolWorkspace } from "./ToolWorkspace.js";
import type { WebToolRun } from "./RunHistory.js";
import { WebFailure } from "./WebFailure.js";

/** Optional project linking for runs started from a tab with an open project. */
export interface ProjectRunHooks {
  /** Throw when the project cannot take a run; called before the run starts. */
  readonly assertProject: (projectId: string) => Promise<void>;
  /** Record a run snapshot (accepted or settled); failures are logged, the run keeps going. */
  readonly link: (
    projectId: string,
    workspaceId: string,
    run: WebToolRun,
  ) => Promise<void>;
}

const runProject = z.object({ project: z.uuid().optional() }).passthrough();

/** Resolve authenticated dashboard requests without exposing arbitrary dispatch. */
export const createWebToolRoutes = (
  tools: ToolWorkspace,
  projects?: ProjectRunHooks,
) => {
  let catalog: ReturnType<typeof createWebToolCatalog> | undefined;
  return async (
    requestPath: string,
    method: string | undefined,
    readBody: () => Promise<unknown>,
  ): Promise<{ status: number; body: unknown } | undefined> => {
    const url = new URL(requestPath, "http://localhost");
    const path = url.pathname;
    if (path === "/api/tools" && method === "GET") {
      catalog ??= createWebToolCatalog();
      return { status: 200, body: { tools: await catalog } };
    }
    if (path === "/api/workspace" && method === "POST")
      return { status: 200, body: await tools.workspace(await readBody()) };
    const route =
      /^\/api\/workspace\/([^/]+)(?:\/(run|runs|session)(?:\/([^/]+)(?:\/(cancel|summary))?)?)?$/.exec(
        path,
      );
    if (!route) return undefined;
    const id = z.uuid().parse(route[1]);
    if (!route[2] && method === "GET")
      return { status: 200, body: await tools.workspace({ id }) };
    if (route[2] === "session" && !route[3] && method === "GET")
      return { status: 200, body: await tools.session(id) };
    if (route[2] === "run" && !route[3] && method === "POST") {
      const { project, ...input } = runProject.parse(await readBody());
      if (project === undefined || projects === undefined)
        return { status: 202, body: await tools.run(id, input) };
      await projects.assertProject(project);
      const accepted = await tools.run(id, input, (settled) => {
        void projects.link(project, id, structuredClone(settled));
      });
      await projects.link(project, id, structuredClone(accepted.run));
      return { status: 202, body: accepted };
    }
    if (route[2] === "runs" && !route[3] && method === "GET") {
      const paging: Record<string, unknown> = {};
      for (const [key, value] of url.searchParams) {
        if (key in paging)
          throw new WebFailure(
            400,
            "invalid_paging",
            "Paging arguments must not be repeated.",
          );
        paging[key] =
          key === "limit" && /^\d+$/.test(value) ? Number(value) : value;
      }
      return { status: 200, body: await tools.listRuns(id, paging) };
    }
    if (route[2] === "runs" && route[3]) {
      if (route[4] === "summary" && method === "GET")
        return { status: 200, body: await tools.getSummary(id, route[3]) };
      if (route[4] === "cancel" && method === "POST")
        return { status: 200, body: await tools.cancel(id, route[3]) };
      if (!route[4] && method === "GET")
        return { status: 200, body: await tools.getRun(id, route[3]) };
    }
    throw new WebFailure(
      404,
      "not_found",
      "This Oopsware route does not exist.",
    );
  };
};
