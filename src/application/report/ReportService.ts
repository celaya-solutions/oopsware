import { targetFromRun } from "../../domain/project/annotationCapture.js";
import {
  ProjectEditError,
  type Project,
  type ProjectReportEntry,
  type ProjectRunLink,
} from "../../domain/project/projectSchema.js";
import {
  ReportBuilder,
  type ReportHeader,
  type ReportTarget,
  type TargetCheck,
} from "../../domain/report/reportHtml.js";
import type {
  ReportRun,
  ReportRunRecord,
} from "../../domain/report/reportRun.js";
import type {
  FileIdentityReader,
  ProjectService,
} from "../project/ProjectService.js";

/** Turns report HTML into a PDF; unavailable when no browser is installed. */
export interface PdfRendererPort {
  status(): Promise<
    { available: true; browser: string } | { available: false; reason: string }
  >;
  render(html: string): Promise<Uint8Array>;
}

export interface ReportOptions {
  readonly format: "html" | "pdf";
  /** PDF only: carry the JSON appendix too. HTML always carries it. */
  readonly includeAppendix: boolean;
}

export interface ReportFile {
  readonly bytes: Uint8Array;
  readonly name: string;
  readonly type: string;
}

export class PdfUnavailable extends Error {
  readonly _tag = "PdfUnavailable";
}

export class PdfFailed extends Error {
  readonly _tag = "PdfFailed";
}

const TYPES = {
  html: "text/html; charset=utf-8",
  pdf: "application/pdf",
} as const;

const missing = (cause: unknown) =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  (cause.code === "ENOENT" || cause.code === "ENOTDIR");

/** A download name made only of safe characters. */
export const reportFileName = (
  title: string,
  at: string,
  format: "html" | "pdf",
) => {
  const slug =
    title
      .normalize("NFKD")
      .replace(/[^A-Za-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .toLowerCase() || "report";
  return `oopsware-${slug}-${at.slice(0, 10)}.${format}`;
};

/** Builds HTML and PDF reports from stored run records only (spec C.2.6). */
export class ReportService {
  private readonly clock: () => string;

  constructor(
    private readonly deps: {
      readonly projects: ProjectService;
      readonly readRun: (
        workspaceId: string,
        runId: string,
      ) => Promise<ReportRunRecord | undefined>;
      readonly identify: FileIdentityReader;
      readonly pdf: PdfRendererPort;
      readonly toolTitle: (tool: string) => string | null;
      readonly version: string;
      readonly archivePath: (workspaceId: string, runId: string) => string;
      readonly clock?: () => string;
    },
  ) {
    this.clock = deps.clock ?? (() => new Date().toISOString());
  }

  pdfStatus() {
    return this.deps.pdf.status();
  }

  /** Recheck a recorded file now: same, changed, missing or not hashed. */
  async #check(target: {
    path: string;
    kind: string;
    sha256: string | null;
  }): Promise<{ check: TargetCheck; currentSha256: string | null }> {
    // Folders and bundles are never rehashed, so their recorded digest cannot be rechecked.
    if (target.sha256 === null || target.kind !== "file")
      return { check: "not_hashed", currentSha256: null };
    try {
      const now = await this.deps.identify(target.path);
      if (now.sha256 === target.sha256)
        return { check: "same", currentSha256: now.sha256 };
      return { check: "changed", currentSha256: now.sha256 };
    } catch (cause) {
      return {
        check: missing(cause) ? "missing" : "unreadable",
        currentSha256: null,
      };
    }
  }

  async #targets(project: Pick<Project, "targets">): Promise<ReportTarget[]> {
    const rows: ReportTarget[] = [];
    for (const target of project.targets)
      rows.push({
        name: target.name,
        path: target.path,
        kind: target.kind,
        size: target.size,
        sha256: target.sha256,
        format: target.format,
        ...(await this.#check(target)),
      });
    return rows;
  }

  async #finish(builder: ReportBuilder, options: ReportOptions) {
    const html = builder.html();
    if (options.format === "html") return new TextEncoder().encode(html);
    const status = await this.deps.pdf.status();
    if (!status.available) throw new PdfUnavailable(status.reason);
    try {
      return await this.deps.pdf.render(html);
    } catch (cause) {
      throw new PdfFailed(
        `The PDF could not be printed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }

  async #run(link: {
    workspace_id: string;
    run_id: string;
    tool: string;
    status: string;
    problem?: string | null;
  }): Promise<ReportRun> {
    const record =
      link.status === "missing"
        ? undefined
        : await this.deps.readRun(link.workspace_id, link.run_id);
    return {
      workspace_id: link.workspace_id,
      run_id: link.run_id,
      tool: record?.tool ?? link.tool,
      status: record?.status ?? "missing",
      record: record ?? null,
      archivePath: this.deps.archivePath(link.workspace_id, link.run_id),
      problem: link.problem ?? null,
    };
  }

  /**
   * Build and save a whole-project report. With no run list, every completed
   * linked run is included; failed, cancelled and missing runs are always
   * listed among the limits.
   */
  async projectReport(
    id: string,
    options: ReportOptions & {
      readonly runs?:
        | readonly { workspace_id: string; run_id: string }[]
        | undefined;
    },
  ): Promise<{ project: Project; entry: ProjectReportEntry }> {
    const { project } = await this.deps.projects.get(id);
    const key = (ref: { workspace_id: string; run_id: string }) =>
      `${ref.workspace_id}/${ref.run_id}`;
    const linked = new Map(project.runs.map((link) => [key(link), link]));
    const picked = new Set(
      options.runs?.map((ref) => {
        if (!linked.has(key(ref)))
          throw new ProjectEditError("That run is not linked to this project.");
        return key(ref);
      }) ?? project.runs.filter((link) => link.status === "completed").map(key),
    );
    const leftOut = project.runs.filter(
      (link) => link.status === "completed" && !picked.has(key(link)),
    ).length;
    const generatedAt = this.clock();
    const builder = new ReportBuilder(
      this.#header(
        {
          title: project.title,
          description: project.description,
          generatedAt,
          leftOut,
        },
        options,
      ),
      await this.#targets(project),
      project,
      this.deps.toolTitle,
    );
    for (const link of project.runs) {
      if (picked.has(key(link))) builder.addRun(await this.#run(link));
      else builder.addUnselected(this.#unselected(link));
    }
    const bytes = await this.#finish(builder, options);
    const entry: ProjectReportEntry = {
      id: crypto.randomUUID(),
      title: project.title,
      format: options.format,
      file: "",
      bytes: bytes.length,
      createdAt: generatedAt,
      run_ids: project.runs
        .filter((link) => picked.has(key(link)))
        .map((link) => link.run_id),
    };
    const saved = { ...entry, file: `${entry.id}.${options.format}` };
    return {
      project: await this.deps.projects.addReport(id, saved, bytes),
      entry: saved,
    };
  }

  #unselected(link: ProjectRunLink): ReportRun {
    return {
      workspace_id: link.workspace_id,
      run_id: link.run_id,
      tool: link.tool,
      status: link.status,
      record: null,
      archivePath: this.deps.archivePath(link.workspace_id, link.run_id),
      problem: link.problem,
    };
  }

  #header(
    page: Pick<
      ReportHeader,
      "title" | "description" | "generatedAt" | "leftOut"
    >,
    options: ReportOptions,
  ): ReportHeader {
    const { title, description, generatedAt, leftOut } = page;
    return {
      title,
      description,
      generatedAt,
      version: this.deps.version,
      format: options.format,
      includeAppendix: options.format === "html" || options.includeAppendix,
      leftOut,
    };
  }

  /** Delete a saved project report. */
  removeReport(id: string, revision: number, reportId: string) {
    return this.deps.projects.removeReport(id, revision, reportId);
  }

  /** A saved project report, ready to download. */
  async savedReport(
    id: string,
    reportId: string,
  ): Promise<ReportFile | undefined> {
    const found = await this.deps.projects.readReport(id, reportId);
    if (!found) return undefined;
    return {
      bytes: found.bytes,
      name: reportFileName(
        found.entry.title,
        found.entry.createdAt,
        found.entry.format,
      ),
      type: TYPES[found.entry.format],
    };
  }

  /** A one-run report, built for download and not saved anywhere. */
  async runReport(
    workspaceId: string,
    runId: string,
    options: ReportOptions,
  ): Promise<ReportFile | undefined> {
    const record = await this.deps.readRun(workspaceId, runId);
    if (!record) return undefined;
    const generatedAt = this.clock();
    const title = `${this.deps.toolTitle(record.tool) ?? record.tool} run`;
    const target = targetFromRun(record, generatedAt);
    const builder = new ReportBuilder(
      this.#header(
        { title, description: "", generatedAt, leftOut: 0 },
        options,
      ),
      target ? await this.#targets({ targets: [target] }) : [],
      { notes: [], bookmarks: [], renames: [] },
      this.deps.toolTitle,
    );
    builder.addRun({
      workspace_id: workspaceId,
      run_id: runId,
      tool: record.tool,
      status: record.status,
      record,
      archivePath: this.deps.archivePath(workspaceId, runId),
      problem: null,
    });
    return {
      bytes: await this.#finish(builder, options),
      name: reportFileName(title, generatedAt, options.format),
      type: TYPES[options.format],
    };
  }
}
