import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import {
  inspectSqliteDatabaseInputSchema,
  querySqliteDatabaseInputSchema,
} from "../domain/sqlite/sqliteDatabase.js";
import { inspectSqliteDatabaseSnapshot } from "./SqliteDatabaseInspection.js";
import {
  SQLITE_DATABASE_LIMITS,
  SqliteInspectionFailure,
} from "./SqliteDatabaseLimits.js";
import { querySqliteDatabaseSnapshot } from "./SqliteDatabaseQuery.js";

const requestSchema = z.strictObject({
  snapshot_path: z.string(),
  reply_path: z.string(),
  work: z.discriminatedUnion("operation", [
    z.strictObject({
      operation: z.literal("inspect_sqlite_database"),
      input: inspectSqliteDatabaseInputSchema,
    }),
    z.strictObject({
      operation: z.literal("query_database_readonly"),
      input: querySqliteDatabaseInputSchema,
    }),
  ]),
});
const main = async (): Promise<void> => {
  const requestPath = process.argv[2];
  if (requestPath === undefined)
    throw new Error("Owned SQLite worker request path missing.");
  const request = requestSchema.parse(
    JSON.parse(await readFile(requestPath, "utf8")),
  );
  let reply: unknown;
  try {
    reply = {
      ok: true,
      report:
        request.work.operation === "inspect_sqlite_database"
          ? inspectSqliteDatabaseSnapshot(
              request.snapshot_path,
              request.work.input,
            )
          : querySqliteDatabaseSnapshot(
              request.snapshot_path,
              request.work.input,
            ),
    };
  } catch (cause: unknown) {
    const code =
      cause instanceof Error && "errcode" in cause ? cause.errcode : undefined;
    reply = {
      ok: false,
      reason:
        cause instanceof SqliteInspectionFailure
          ? cause.reason
          : code === 7
            ? "memory"
            : code === 18
              ? "output-limit"
              : "format",
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }
  let encoded = JSON.stringify(reply);
  if (Buffer.byteLength(encoded) > SQLITE_DATABASE_LIMITS.outputBytes)
    encoded = JSON.stringify({
      ok: false,
      reason: "output-limit",
      message:
        "Complete SQLite evidence exceeds the 16 MiB JSON reply budget; no partial success was returned.",
    });
  await writeFile(request.reply_path, encoded, { flag: "wx", mode: 0o600 });
};
await main();
