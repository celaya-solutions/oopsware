import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  PdfFailed,
  PdfUnavailable,
  type ReportFile,
  type ReportService,
} from "../application/report/ReportService.js";
import { translate } from "./ProjectRoutes.js";
import { WebFailure } from "./WebFailure.js";

/** A JSON reply, or a file the browser saves. */
export type ReportReply =
  | { status: number; body: unknown }
  | { status: number; file: ReportFile };

const optionsSchema = z.object({
  format: z.enum(["html", "pdf"]),
  includeAppendix: z.boolean().default(false),
});

const runRef = z.object({ workspace_id: z.uuid(), run_id: z.uuid() });

const notFound = (): never => {
  throw new WebFailure(404, "report_not_found", "This report does not exist.");
};

/** Report failures in the dashboard's HTTP failure shape. */
const reported = <T>(work: () => Promise<T>) =>
  translate(async () => {
    try {
      return await work();
    } catch (cause) {
      if (cause instanceof PdfUnavailable)
        throw new WebFailure(409, "pdf_unavailable", cause.message);
      if (cause instanceof PdfFailed)
        throw new WebFailure(502, "pdf_failed", cause.message);
      throw cause;
    }
  });

// A view link lives this long and opens once.
const TICKET_MS = 60_000;

/** Policy a report page is served with: no script, no fetch, inline styles only. */
export const REPORT_PAGE_POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/**
 * `/api/reports…` and `/api/projects/<id>/reports…` (`undefined` when not a
 * report route), plus one-time view links. A report opened as a blob would
 * inherit the dashboard's style policy, so it is served from its own URL.
 */
export const createReportRoutes = (reports: ReportService) => {
  const tickets = new Map<
    string,
    { project: string; report: string; expires: number }
  >();
  /** The file behind a view link; a link opens once, within a minute. */
  const view = async (ticket: string): Promise<ReportFile | undefined> => {
    const found = tickets.get(ticket);
    tickets.delete(ticket);
    if (!found || found.expires < Date.now()) return undefined;
    return reports.savedReport(found.project, found.report);
  };
  const route = async (
    requestPath: string,
    method: string | undefined,
    readBody: () => Promise<unknown>,
  ): Promise<ReportReply | undefined> => {
    const url = new URL(requestPath, "http://localhost");
    if (url.pathname === "/api/reports/status" && method === "GET")
      return { status: 200, body: await reports.pdfStatus() };
    if (url.pathname === "/api/reports/run" && method === "POST") {
      const input = optionsSchema
        .extend({ workspaceId: z.uuid(), runId: z.uuid() })
        .parse(await readBody());
      return reported(async () => ({
        status: 200,
        file:
          (await reports.runReport(input.workspaceId, input.runId, input)) ??
          notFound(),
      }));
    }
    const route =
      /^\/api\/projects\/([^/]+)\/reports(?:\/([^/]+)(?:\/(delete|view))?)?$/.exec(
        url.pathname,
      );
    if (!route) return undefined;
    const id = z.uuid().safeParse(route[1]);
    if (!id.success)
      throw new WebFailure(
        404,
        "project_not_found",
        "This project does not exist.",
      );
    const reportId = route[2];
    if (reportId === undefined) {
      if (method !== "POST") return undefined;
      const input = optionsSchema
        .extend({ runs: z.array(runRef).max(10_000).optional() })
        .parse(await readBody());
      return reported(async () => ({
        status: 201,
        body: await reports.projectReport(id.data, input),
      }));
    }
    if (!z.uuid().safeParse(reportId).success) notFound();
    if (route[3] === undefined && method === "GET")
      return reported(async () => ({
        status: 200,
        file: (await reports.savedReport(id.data, reportId)) ?? notFound(),
      }));
    if (route[3] === "view" && method === "POST")
      return reported(async () => {
        if (!(await reports.savedReport(id.data, reportId))) notFound();
        const now = Date.now();
        for (const [key, item] of tickets)
          if (item.expires < now) tickets.delete(key);
        const ticket = randomBytes(32).toString("base64url");
        tickets.set(ticket, {
          project: id.data,
          report: reportId,
          expires: now + TICKET_MS,
        });
        return { status: 200, body: { url: `/report-view/${ticket}` } };
      });
    if (route[3] === "delete" && method === "POST") {
      const input = z
        .object({ revision: z.number().int().min(0) })
        .parse(await readBody());
      return reported(async () => ({
        status: 200,
        body: {
          project: await reports.removeReport(
            id.data,
            input.revision,
            reportId,
          ),
        },
      }));
    }
    return undefined;
  };
  return { route, view };
};
