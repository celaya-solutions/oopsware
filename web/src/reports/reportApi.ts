import { z } from "zod";
import { token } from "../api";
import {
  ProjectRequestError,
  projectReply,
  request,
  type Project,
} from "../projects/projectApi";

export type ReportFormat = "html" | "pdf";
export interface ReportOptions {
  format: ReportFormat;
  includeAppendix: boolean;
}

const statusSchema = z.union([
  z.object({ available: z.literal(true), browser: z.string() }),
  z.object({ available: z.literal(false), reason: z.string() }),
]);
export type PdfStatus = z.infer<typeof statusSchema>;

export const pdfStatus = () =>
  request("/api/reports/status", undefined, statusSchema);

export const buildProjectReport = async (
  project: Project,
  options: ReportOptions & {
    runs: { workspace_id: string; run_id: string }[];
  },
) =>
  (await request(`/api/projects/${project.id}/reports`, options, projectReply))
    .project;

export const deleteReport = async (project: Project, reportId: string) =>
  (
    await request(
      `/api/projects/${project.id}/reports/${reportId}/delete`,
      { revision: project.revision },
      projectReply,
    )
  ).project;

/** Fetch a report file; failures keep the server's own message. */
async function fetchFile(path: string, body?: unknown) {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-rea-token": token, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const failure = z
      .object({ error: z.string(), message: z.string() })
      .safeParse(await response.json().catch(() => null));
    throw new ProjectRequestError(
      failure.success
        ? failure.data.message
        : `Request failed (${response.status})`,
      response.status,
      failure.success ? failure.data.error : "request_failed",
    );
  }
  const name =
    /filename="([^"]+)"/.exec(
      response.headers.get("content-disposition") ?? "",
    )?.[1] ?? "oopsware-report";
  return { blob: await response.blob(), name };
}

function save({ blob, name }: { blob: Blob; name: string }) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const savedPath = (project: Project, reportId: string) =>
  `/api/projects/${project.id}/reports/${reportId}`;

export const downloadReport = async (project: Project, reportId: string) =>
  save(await fetchFile(savedPath(project, reportId)));
/**
 * Open a saved report in a new tab through a one-time link, so the page gets
 * its own no-script policy instead of the dashboard's. The tab is opened
 * before the request so the browser keeps the click's permission.
 */
export async function openReport(project: Project, reportId: string) {
  const tab = window.open("about:blank", "_blank");
  try {
    const { url } = await request(
      `${savedPath(project, reportId)}/view`,
      {},
      z.object({ url: z.string().startsWith("/report-view/") }),
    );
    if (tab) {
      tab.opener = null;
      tab.location.href = url;
    } else window.location.assign(url);
  } catch (cause) {
    tab?.close();
    throw cause;
  }
}

/** Build a one-run report and save it; nothing is kept on the server. */
export const downloadRunReport = async (
  workspaceId: string,
  runId: string,
  options: ReportOptions,
) =>
  save(await fetchFile("/api/reports/run", { workspaceId, runId, ...options }));
