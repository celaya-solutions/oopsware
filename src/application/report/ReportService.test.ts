import { describe, expect, it } from "vitest";
import type { Project } from "../../domain/project/projectSchema.js";
import type { ProjectService } from "../project/ProjectService.js";
import { ReportService } from "./ReportService.js";

const SHA = "c".repeat(64);
const target = (
  name: string,
  kind: "file" | "folder",
  sha256: string | null,
) => ({
  id: crypto.randomUUID(),
  name,
  path: `/x/${name}`,
  kind,
  size: null,
  sha256,
  format: null,
  architecture: null,
  addedAt: "2026-10-21T10:00:00.000Z",
  source: "manual" as const,
});

const project = {
  version: 1,
  id: crypto.randomUUID(),
  title: "Checks",
  description: "",
  createdAt: "2026-10-21T10:00:00.000Z",
  updatedAt: "2026-10-21T10:00:00.000Z",
  revision: 0,
  targets: [
    target("same", "file", SHA),
    target("changed", "file", SHA),
    target("gone", "file", SHA),
    target("dir", "folder", SHA),
  ],
  notes: [],
  bookmarks: [],
  renames: [],
  runs: [],
  reports: [],
} satisfies Project;

describe("ReportService target checks", () => {
  it("rechecks files and never folders", async () => {
    let saved: Uint8Array | undefined;
    const service = new ReportService({
      projects: {
        get: async () => ({ project, recovered: false }),
        addReport: async (_id: string, _entry: unknown, bytes: Uint8Array) => {
          saved = bytes;
          return project;
        },
      } as unknown as ProjectService,
      readRun: async () => undefined,
      identify: async (path) => {
        if (path.endsWith("gone"))
          throw Object.assign(new Error("gone"), { code: "ENOENT" });
        if (path.endsWith("dir"))
          return { name: "dir", kind: "folder", size: null, sha256: null };
        return {
          name: "f",
          kind: "file",
          size: 1,
          sha256: path.endsWith("same") ? SHA : "d".repeat(64),
        };
      },
      pdf: {
        status: async () => ({ available: false, reason: "none" }),
        render: async () => new Uint8Array(),
      },
      toolTitle: () => null,
      version: "1",
      archivePath: () => "/a",
    });
    await service.projectReport(project.id, {
      format: "html",
      includeAppendix: false,
    });
    const html = new TextDecoder().decode(saved);
    const row = (name: string) =>
      html.slice(html.indexOf(`<td>${name}</td>`)).split("</tr>")[0]!;
    expect(row("same")).toContain("Same as when added");
    expect(row("changed")).toContain("Changed since it was added");
    expect(row("gone")).toContain("Missing at report time");
    expect(row("dir")).toContain("Not rechecked");
    await expect(
      service.projectReport(project.id, {
        format: "pdf",
        includeAppendix: false,
      }),
    ).rejects.toThrow("none");
  });
});
