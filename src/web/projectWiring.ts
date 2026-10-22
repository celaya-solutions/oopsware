import { join } from "node:path";
import { ProjectService } from "../application/project/ProjectService.js";
import { ReportService } from "../application/report/ReportService.js";
import { TOOL_CONTRACTS } from "../contracts/toolContracts.js";
import { PRODUCT_IDENTITY } from "../identity.js";
import { silentLogger } from "../logger.js";
import { ProjectStore } from "../project/ProjectStore.js";
import { ChromiumPdfRenderer } from "../report/ChromiumPdfRenderer.js";
import { readFileIdentity } from "./fileIdentity.js";
import { createProjectRoutes } from "./ProjectRoutes.js";
import { createReportRoutes } from "./ReportRoutes.js";
import type { ToolWorkspace } from "./ToolWorkspace.js";
import { WebFailure } from "./WebFailure.js";
import type { ProjectRunHooks } from "./WebToolRoutes.js";

/** Build the project and report services, their routes, and the run-linking hooks for one web server. */
export const wireProjects = (
  directory: string,
  tools: ToolWorkspace,
  environment: Readonly<Record<string, string | undefined>>,
) => {
  const readRun = async (workspaceId: string, runId: string) => {
    try {
      return (await tools.getRun(workspaceId, runId)).run;
    } catch (cause) {
      if (cause instanceof WebFailure && cause.status === 404) return undefined;
      throw cause;
    }
  };
  const service = new ProjectService(
    new ProjectStore(join(directory, "projects")),
    readRun,
    readFileIdentity,
    {
      runExists: async (workspaceId, runId) => {
        try {
          await tools.getSummary(workspaceId, runId);
          return true;
        } catch (cause) {
          if (cause instanceof WebFailure && cause.status === 404) return false;
          throw cause;
        }
      },
    },
  );
  // Runs started with a project are linked when accepted and again when settled.
  const hooks: ProjectRunHooks = {
    assertProject: async (projectId) => {
      await service.get(projectId).catch(() => {
        throw new WebFailure(
          404,
          "project_not_found",
          "This project does not exist.",
        );
      });
    },
    link: async (projectId, workspaceId, run) => {
      await service
        .linkRun(projectId, workspaceId, run)
        .catch((cause) =>
          silentLogger.error(
            { error: cause instanceof Error ? cause.message : String(cause) },
            "Project run link failed",
          ),
        );
    },
  };
  const routes = createProjectRoutes(service, (workspaceId) =>
    tools.session(workspaceId).then((value) => value.result),
  );
  const titles = new Map<string, string>(
    TOOL_CONTRACTS.map((contract) => [contract.name, contract.title]),
  );
  const reports = new ReportService({
    projects: service,
    readRun,
    identify: readFileIdentity,
    pdf: new ChromiumPdfRenderer(environment),
    toolTitle: (tool) => titles.get(tool) ?? null,
    version: PRODUCT_IDENTITY.packageVersion,
    archivePath: (workspaceId, runId) =>
      join(directory, "workspaces", workspaceId, "runs", `${runId}.json`),
  });
  return { service, hooks, routes, reports: createReportRoutes(reports) };
};
