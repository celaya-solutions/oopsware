import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  projectSchema,
  type Project,
  type ProjectListRow,
} from "../domain/project/projectSchema.js";

export type { ProjectListRow };

const FILE = "project.json";
const BACKUP = "project.json.bak";
const projectId = z.uuid();

const missing = (cause: unknown) =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  cause.code === "ENOENT";

const parseFile = async (path: string): Promise<Project | undefined> => {
  try {
    return projectSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (cause) {
    if (
      missing(cause) ||
      cause instanceof SyntaxError ||
      cause instanceof z.ZodError
    )
      return undefined;
    throw cause;
  }
};

/** Saved projects under one owner-only folder, one subfolder per project. */
export class ProjectStore {
  constructor(private readonly directory: string) {}

  private folder(id: string): string {
    if (!projectId.safeParse(id).success)
      throw new Error("Invalid project id.");
    return join(this.directory, id);
  }

  /** The folder a project's saved reports live in. */
  reportsDirectory(id: string): string {
    return join(this.folder(id), "reports");
  }

  private reportPath(id: string, file: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(file) || file.startsWith("."))
      throw new Error("Invalid report file name.");
    return join(this.reportsDirectory(id), file);
  }

  /** Save one report file; owner-only, never replacing an existing one. */
  async writeReport(id: string, file: string, bytes: Uint8Array) {
    await mkdir(this.reportsDirectory(id), { recursive: true, mode: 0o700 });
    const path = this.reportPath(id, file);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  /** A saved report's bytes; undefined when the file is gone. */
  async readReport(id: string, file: string): Promise<Buffer | undefined> {
    try {
      return await readFile(this.reportPath(id, file));
    } catch (cause) {
      if (missing(cause)) return undefined;
      throw cause;
    }
  }

  async removeReport(id: string, file: string) {
    await rm(this.reportPath(id, file), { force: true });
  }

  /** Read a project, falling back to the last good copy when the main file is damaged. */
  async read(
    id: string,
  ): Promise<{ project: Project; recovered: boolean } | undefined> {
    const folder = this.folder(id);
    const project = await parseFile(join(folder, FILE));
    if (project?.id === id) return { project, recovered: false };
    const backup = await parseFile(join(folder, BACKUP));
    return backup?.id === id ? { project: backup, recovered: true } : undefined;
  }

  private async atomic(path: string, content: string) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  /** Keep the current good copy as the backup, then replace the project atomically. */
  async write(project: Project): Promise<void> {
    const folder = this.folder(project.id);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const current = await parseFile(join(folder, FILE));
    if (current !== undefined)
      await this.atomic(join(folder, BACKUP), JSON.stringify(current));
    await this.atomic(
      join(folder, FILE),
      JSON.stringify(projectSchema.parse(project)),
    );
  }

  /** Remove a project and everything saved with it. */
  async remove(id: string): Promise<boolean> {
    const folder = this.folder(id);
    try {
      await readdir(folder);
    } catch (cause) {
      if (missing(cause)) return false;
      throw cause;
    }
    await rm(folder, { recursive: true, force: true });
    return true;
  }

  /** List projects newest first, a page at a time. */
  async list(
    cursor?: string,
    limit = 50,
  ): Promise<{
    projects: ProjectListRow[];
    total: number;
    nextCursor: string | null;
  }> {
    const size = z.number().int().min(1).max(100).parse(limit);
    const offset =
      cursor === undefined ? 0 : z.coerce.number().int().min(0).parse(cursor);
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (cause) {
      if (missing(cause)) return { projects: [], total: 0, nextCursor: null };
      throw cause;
    }
    const rows = await Promise.all(
      names
        .filter((name) => projectId.safeParse(name).success)
        .map(async (id): Promise<ProjectListRow> => {
          try {
            const found = await this.read(id);
            if (found)
              return {
                id,
                title: found.project.title,
                updatedAt: found.project.updatedAt,
                targets: found.project.targets.length,
                runs: found.project.runs.length,
                recovered: found.recovered,
              };
          } catch {
            // Reported below as unreadable; one bad folder never hides the rest.
          }
          return {
            id,
            title: "Unreadable project",
            updatedAt: "",
            targets: 0,
            runs: 0,
            recovered: false,
            unreadable:
              "This project could not be read. Its files are kept as they are.",
          };
        }),
    );
    rows.sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) ||
        left.id.localeCompare(right.id),
    );
    const page = rows.slice(offset, offset + size);
    const next = offset + size;
    return {
      projects: page,
      total: rows.length,
      nextCursor: next < rows.length ? String(next) : null,
    };
  }
}
