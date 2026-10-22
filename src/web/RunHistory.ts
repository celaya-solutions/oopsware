import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { CallToolResultSchema } from "@modelcontextprotocol/core";
import { z } from "zod";
import { WebFailure } from "./WebFailure.js";

const uuid = z.uuid();
/** Validated complete invocation record shared by execution and storage. */
export const runSchema = z.object({
  id: uuid,
  tool: z.string(),
  arguments: z.record(z.string(), z.unknown()),
  targetPath: z
    .string()
    .refine(isAbsolute, "targetPath must be an absolute local path")
    .optional(),
  status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  progress: z
    .object({
      progress: z.number(),
      total: z.number().optional(),
      message: z.string().optional(),
    })
    .optional(),
  result: CallToolResultSchema.optional(),
  error: z.string().optional(),
});
/** Durable invocation evidence; restoring it never restarts an operation. */
export type WebToolRun = z.infer<typeof runSchema>;

const summarySchema = runSchema
  .omit({
    arguments: true,
    result: true,
    error: true,
    progress: true,
    targetPath: true,
  })
  .extend({ hasResult: z.boolean() });
/** Small history row; full arguments and evidence are available on demand. */
export type WebRunSummary = z.infer<typeof summarySchema>;
const indexSchema = z.object({
  version: z.literal(1),
  id: uuid,
  runs: z.array(summarySchema),
});
const legacySchema = z.object({ id: uuid, runs: z.array(runSchema) });
const pagingSchema = z.strictObject({
  limit: z.number().int().min(1).max(100).default(50),
  cursor: uuid.optional(),
});
const missing = (cause: unknown) =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT";

/** Atomic summary index and independently readable per-run evidence files. */
export class RunHistory {
  constructor(private readonly directory: string) {}
  /** Strip evidence and potentially large invocation values from listing rows. */
  summary(run: WebToolRun): WebRunSummary {
    return summarySchema.parse({ ...run, hasResult: run.result !== undefined });
  }
  private async atomic(path: string, serialized: string) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, serialized, { mode: 0o600, flag: "wx" });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  /** Publish a full run before publishing its matching summary. */
  async writeRun(id: string, runId: string, serialized: string) {
    const directory = join(this.directory, id, "runs");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await this.atomic(join(directory, `${runId}.json`), serialized);
  }
  /** Replace only the small index after evidence writes finish. */
  async writeIndex(id: string, serialized: string) {
    await mkdir(join(this.directory, id), { recursive: true, mode: 0o700 });
    await this.atomic(join(this.directory, id, "index.json"), serialized);
  }
  /** Load summaries or finish a retryable legacy migration before publishing them. */
  async load(id: string, create: boolean): Promise<WebRunSummary[]> {
    if (create) {
      await this.writeIndex(id, JSON.stringify({ version: 1, id, runs: [] }));
      return [];
    }
    try {
      const index = indexSchema.parse(
        JSON.parse(
          await readFile(join(this.directory, id, "index.json"), "utf8"),
        ),
      );
      if (
        index.id !== id ||
        new Set(index.runs.map((run) => run.id)).size !== index.runs.length
      )
        throw new Error(
          "Workspace identity mismatch or duplicate run identity",
        );
      return index.runs;
    } catch (cause) {
      if (!missing(cause)) throw cause;
    }
    let legacy;
    try {
      legacy = legacySchema.parse(
        JSON.parse(await readFile(join(this.directory, `${id}.json`), "utf8")),
      );
    } catch (cause) {
      if (missing(cause))
        throw new WebFailure(
          404,
          "workspace_not_found",
          "This workspace was not found. Create a new workspace.",
        );
      throw cause;
    }
    if (
      legacy.id !== id ||
      new Set(legacy.runs.map((run) => run.id)).size !== legacy.runs.length
    )
      throw new Error("Workspace identity mismatch or duplicate run identity");
    for (const run of legacy.runs)
      await this.writeRun(id, run.id, JSON.stringify(run));
    const runs = legacy.runs.map((run) => this.summary(run));
    await this.writeIndex(id, JSON.stringify({ version: 1, id, runs }));
    // Retain the original until and after publication. Interrupted migrations can retry.
    return runs;
  }
  /** Return full evidence without retaining it in the workspace cache. */
  async read(id: string, runId: string): Promise<WebToolRun> {
    const run = runSchema.parse(
      JSON.parse(
        await readFile(
          join(this.directory, id, "runs", `${runId}.json`),
          "utf8",
        ),
      ),
    );
    if (run.id !== runId) throw new Error("Run identity mismatch");
    return run;
  }
  /** Cursor anchors to a retained run, so later appends cannot shift older pages. */
  page(id: string, runs: readonly WebRunSummary[], input: unknown) {
    const { limit, cursor } = pagingSchema.parse(input);
    const end =
      cursor === undefined
        ? runs.length
        : runs.findIndex((run) => run.id === cursor);
    if (end < 0)
      throw new WebFailure(
        400,
        "invalid_cursor",
        "This history cursor does not belong to this workspace.",
      );
    const start = Math.max(0, end - limit);
    return {
      id,
      runs: runs.slice(start, end).reverse(),
      total: runs.length,
      nextCursor: start > 0 ? (runs[start]?.id ?? null) : null,
    };
  }
}
