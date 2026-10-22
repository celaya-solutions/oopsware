import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { expect, it as nativeTest, onTestFinished } from "vitest";
import { spawnOwnedProviderProcess } from "../../../src/process/ProviderProcess.js";
import { SqliteInspectionFailure } from "../../../src/sqlite/SqliteDatabaseLimits.js";
import { SqliteDatabaseProvider } from "../../../src/sqlite/SqliteDatabaseProvider.js";
import { querySqliteDatabaseSnapshot } from "../../../src/sqlite/SqliteDatabaseQuery.js";
import { querySqliteDatabaseInputSchema } from "../../../src/domain/sqlite/sqliteDatabase.js";
import {
  createSqliteDatabaseFixture,
  SQLITE_NATIVE_LIMITS_AVAILABLE,
} from "../../fixtures/sqlite/database.js";
import {
  createTestWorkspace,
  removeTestWorkspace,
} from "../../support/workspace/workspaceFixture.js";

const it = nativeTest.runIf(SQLITE_NATIVE_LIMITS_AVAILABLE);

const createDatabase = async (
  sql: string,
): Promise<{ readonly path: string; readonly root: string }> => {
  const workspace = await createTestWorkspace("rea-sqlite-query-");
  onTestFinished(() => removeTestWorkspace(workspace.root));
  const path = workspace.path("private.db");
  const producer = new DatabaseSync(path);
  try {
    producer.exec(sql);
  } finally {
    producer.close();
  }
  return { path, root: workspace.root };
};

const query = (path: string, sql: string, rowLimit?: number) =>
  querySqliteDatabaseSnapshot(path, {
    path,
    sql,
    ...(rowLimit === undefined ? {} : { row_limit: rowLimit }),
  });

const failureOf = (run: () => unknown): unknown => {
  try {
    run();
  } catch (cause: unknown) {
    return cause;
  }
  throw new Error("Expected the statement to be refused");
};

const sha256 = async (path: string) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

it("keeps storage classes, 64-bit integers, stored text bytes and duplicate column names", async () => {
  const { path } = await createDatabase(`
    CREATE TABLE t(i INTEGER, r REAL, s TEXT, b BLOB, n);
    INSERT INTO t VALUES (9223372036854775807, 2.5, CAST(x'c328' AS TEXT), x'00ff', NULL);
  `);
  const result = query(path, "SELECT i, r, s, b, n, i FROM t");
  expect(result.columns).toEqual(["i", "r", "s", "b", "n", "i"]);
  expect(result.values).toEqual([
    [
      { type: "integer", value: "9223372036854775807" },
      { type: "real", value: 2.5 },
      expect.objectContaining({
        type: "text",
        bytes_hex: "c328",
        encoding: "UTF-8",
      }),
      { type: "blob", hex: "00ff" },
      { type: "null" },
      { type: "integer", value: "9223372036854775807" },
    ],
  ]);
  expect(result).toMatchObject({
    row_limit: 20,
    returned_rows: 1,
    truncated: false,
    database_encoding: "UTF-8",
  });
});

it("returns rows in the statement's own order and reports rows beyond the limit", async () => {
  const { path } = await createDatabase(`
    CREATE TABLE t(a INTEGER);
    INSERT INTO t VALUES (2), (9), (1), (7);
  `);
  const sorted = query(path, "SELECT a FROM t ORDER BY a DESC", 3);
  expect(sorted.values.map(([cell]) => cell)).toEqual([
    { type: "integer", value: "9" },
    { type: "integer", value: "7" },
    { type: "integer", value: "2" },
  ]);
  expect(sorted).toMatchObject({ returned_rows: 3, truncated: true });
  expect(query(path, "SELECT a FROM t", 4)).toMatchObject({
    returned_rows: 4,
    truncated: false,
  });
});

it("limits an unbounded statement to 20 rows by default", async () => {
  const { path } = await createDatabase("CREATE TABLE t(a);");
  const result = query(
    path,
    "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT x FROM c",
  );
  expect(result).toMatchObject({ returned_rows: 20, truncated: true });
});

it("accepts one trailing semicolon, a trailing comment, views and VALUES", async () => {
  const { path } = await createDatabase(`
    CREATE TABLE t(a);
    INSERT INTO t VALUES (1);
    CREATE VIEW v AS SELECT a FROM t;
  `);
  for (const sql of [
    "SELECT a FROM t;",
    "SELECT a FROM t -- comment",
    "  SELECT a FROM v  ",
    "VALUES (1)",
  ])
    expect(query(path, sql)).toMatchObject({ returned_rows: 1 });
});

it("binds parameters by position with exact storage classes", async () => {
  const { path } = await createDatabase(`
    CREATE TABLE t(k TEXT, n INTEGER);
    INSERT INTO t VALUES ('a', 1), ('b', 9223372036854775807), ('c', 3);
  `);
  const result = querySqliteDatabaseSnapshot(path, {
    path,
    sql: "SELECT typeof(?), typeof(?), typeof(?), typeof(?), typeof(?6), ?5, (SELECT k FROM t WHERE n = ?5), 'NULL' -- NULL",
    parameters: [
      "text",
      7,
      2.5,
      null,
      { type: "integer", value: "9223372036854775807" },
      { type: "blob", hex: "00ff" },
    ],
  });
  expect(result.values).toEqual([
    [
      expect.objectContaining({ value: "text" }),
      expect.objectContaining({ value: "integer" }),
      expect.objectContaining({ value: "real" }),
      expect.objectContaining({ value: "null" }),
      expect.objectContaining({ value: "blob" }),
      { type: "integer", value: "9223372036854775807" },
      expect.objectContaining({ value: "b" }),
      expect.objectContaining({ value: "NULL" }),
    ],
  ]);
});

it.each([
  ["SELECT ?, ?", [1], "more parameters"],
  ["SELECT ?3", [1, 2], "more parameters"],
  ["SELECT :name", [], "named parameters"],
  ["SELECT ?, :name", [1], "named parameters"],
  ["SELECT 1 WHERE 0 AND @name", [], "named parameters"],
  ["SELECT ?", [1, 2], "fewer ? and ?NNN placeholders"],
  ["SELECT 1", [1], "fewer ? and ?NNN placeholders"],
  ["SELECT :name", ["x"], "Named placeholders"],
] as const)(
  "refuses %s with %j instead of leaving a parameter NULL",
  async (sql, parameters, message) => {
    const { path } = await createDatabase("CREATE TABLE t(a);");
    const failure = failureOf(() =>
      querySqliteDatabaseSnapshot(path, {
        path,
        sql,
        parameters: [...parameters],
      }),
    );
    expect(failure).toBeInstanceOf(SqliteInspectionFailure);
    expect(failure).toMatchObject({ reason: "parameters" });
    expect((failure as Error).message).toContain(message);
  },
);

it("returns raw and escaped CSV while the values keep the stored text", async () => {
  const { path } = await createDatabase(`
    CREATE TABLE t(a, b, c);
    INSERT INTO t VALUES ('=HYPERLINK("x")', 'a,b', -5), ('+1', 'line
break', NULL), ('@x', x'00ff', 2.5);
  `);
  const sql = 'SELECT a, b, c AS "=c" FROM t ORDER BY rowid';
  const raw = querySqliteDatabaseSnapshot(path, { path, sql, csv: "raw" });
  expect(raw.csv).toEqual({
    escaping: "raw",
    text: 'a,b,=c\r\n"=HYPERLINK(""x"")","a,b",-5\r\n+1,"line\nbreak",\r\n@x,00ff,2.5\r\n',
  });
  const escaped = querySqliteDatabaseSnapshot(path, {
    path,
    sql,
    csv: "escaped",
  });
  expect(escaped.csv).toEqual({
    escaping: "escaped",
    text: 'a,b,\'=c\r\n"\'=HYPERLINK(""x"")","a,b",-5\r\n\'+1,"line\nbreak",\r\n\'@x,00ff,2.5\r\n',
  });
  expect(escaped.values[0]?.[0]).toMatchObject({ value: '=HYPERLINK("x")' });
  expect(escaped.limitations.join(" ")).toContain("apostrophe");
  expect(raw.limitations.join(" ")).toContain("formula");
  expect(querySqliteDatabaseSnapshot(path, { path, sql })).not.toHaveProperty(
    "csv",
  );
});

nativeTest.each(["abc", "1.5", "9223372036854775808", "9".repeat(2_000_000)])(
  "rejects the integer parameter %# as a validation issue, never a throw",
  (value) => {
    const parsed = querySqliteDatabaseInputSchema.safeParse({
      path: "/db.sqlite",
      sql: "SELECT ?",
      parameters: [{ type: "integer", value }],
    });
    expect(parsed.success).toBe(false);
  },
);

it("says how many CSV fields lost bytes that are not valid text", async () => {
  const { path } = await createDatabase(`
    CREATE TABLE t(s TEXT);
    INSERT INTO t VALUES (CAST(x'c328' AS TEXT)), ('fine');
  `);
  const result = querySqliteDatabaseSnapshot(path, {
    path,
    sql: "SELECT s FROM t ORDER BY rowid",
    csv: "raw",
  });
  expect(result.csv?.text).toBe("s\r\n\ufffd(\r\nfine\r\n");
  expect(result.values[0]?.[0]).toMatchObject({ bytes_hex: "c328" });
  expect(result.limitations.join(" ")).toContain(
    "1 returned text values are not valid UTF-8",
  );
  expect(
    querySqliteDatabaseSnapshot(path, {
      path,
      sql: "SELECT s FROM t",
    }).limitations.join(" "),
  ).not.toContain("not valid UTF-8");
});

it.each([
  "INSERT INTO t VALUES (1)",
  "DELETE FROM t",
  "UPDATE t SET a = 2",
  "CREATE TABLE z(x)",
  "DROP TABLE t",
  "ALTER TABLE t ADD COLUMN b",
  "ATTACH ':memory:' AS m",
  "PRAGMA writable_schema = ON",
  "PRAGMA table_info(t)",
  "SELECT * FROM pragma_table_info('t')",
  "SELECT load_extension('anything')",
  "REINDEX",
  "ANALYZE",
  "BEGIN",
  "SAVEPOINT s",
  "WITH w AS (SELECT 1) INSERT INTO t SELECT * FROM w",
])("refuses a statement that is not a plain read: %s", async (sql) => {
  const { path } = await createDatabase(
    "CREATE TABLE t(a); INSERT INTO t VALUES (1);",
  );
  const failure = failureOf(() => query(path, sql));
  expect(failure).toBeInstanceOf(SqliteInspectionFailure);
  expect(failure).toMatchObject({ reason: "query" });
});

it.each([
  ["SELECT 1; SELECT 2", /Exactly one statement/],
  ["SELECT 1; DROP TABLE t", /Exactly one statement/],
  ["SELECT 1; -- comment", /Exactly one statement/],
  ["VACUUM", /Only a SELECT/],
  ["EXPLAIN SELECT 1", /syntax error/],
  ["SELECT * FROM absent", /no such table/],
])("names why %s is refused", async (sql, message) => {
  const { path } = await createDatabase("CREATE TABLE t(a);");
  expect(failureOf(() => query(path, sql))).toMatchObject({
    reason: "query",
    message: expect.stringMatching(message),
  });
});

it("never writes: the database stays byte-identical and VACUUM INTO creates nothing", async () => {
  const { path, root } = await createDatabase(
    "CREATE TABLE t(a); INSERT INTO t VALUES (1);",
  );
  const before = await sha256(path);
  const target = `${root}/copy.db`;
  for (const sql of [
    `VACUUM INTO '${target}'`,
    "INSERT INTO t VALUES (2)",
    "ATTACH 'attached.db' AS m",
    "PRAGMA user_version = 7",
  ])
    expect(failureOf(() => query(path, sql))).toBeInstanceOf(
      SqliteInspectionFailure,
    );
  expect(await sha256(path)).toBe(before);
  await expect(access(target)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(access(`${root}/attached.db`)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("keeps the stored bytes of a UTF-16 database", async () => {
  const { path } = await createDatabase(`
    PRAGMA encoding = 'UTF-16le';
    CREATE TABLE t(a);
    INSERT INTO t VALUES ('hé');
  `);
  expect(query(path, "SELECT a FROM t")).toMatchObject({
    database_encoding: "UTF-16le",
    values: [
      [
        {
          type: "text",
          value: "hé",
          bytes_hex: "6800e900",
          encoding: "UTF-16le",
        },
      ],
    ],
  });
});

it("leaves storage limits as resource failures instead of calling them statement errors", async () => {
  const { path } = await createDatabase("CREATE TABLE t(a);");
  const failure = failureOf(() =>
    query(path, "SELECT hex(zeroblob(10000000))"),
  );
  expect(failure).not.toBeInstanceOf(SqliteInspectionFailure);
  expect(failure).toMatchObject({ errcode: 18 });
});

const workerUrl = new URL(
  "../../../dist/sqlite/SqliteDatabaseWorker.js",
  import.meta.url,
);
const createProvider = () =>
  new SqliteDatabaseProvider(process.env, (spawn) =>
    spawnOwnedProviderProcess({
      ...spawn,
      arguments: spawn.arguments.map((argument, index) =>
        index === 1 ? fileURLToPath(workerUrl) : argument,
      ),
    }),
  );

const createFixture = async (wal: boolean) => {
  const workspace = await createTestWorkspace("rea-sqlite-query-boundary-");
  const database = createSqliteDatabaseFixture(workspace.root, wal);
  if (!wal) database.close();
  onTestFinished(async () => {
    if (wal) database.close();
    await removeTestWorkspace(workspace.root);
  });
  return database;
};

it("queries a database and its WAL through the owned worker and binds both identities", async () => {
  const database = await createFixture(true);
  const provider = createProvider();
  onTestFinished(() => provider.close());
  const databaseBytes = await readFile(database.path);
  const result = await provider.query({
    path: database.path,
    sql: "SELECT count(*) AS n FROM records",
  });
  if (!result.ok) throw result.error;
  expect(result.value.subject).toMatchObject({
    path: database.path,
    sha256: createHash("sha256").update(databaseBytes).digest("hex"),
  });
  expect(result.value.result).toMatchObject({
    artifact: { path: database.path },
    wal: { path: database.walPath },
    columns: ["n"],
    returned_rows: 1,
    truncated: false,
  });
});

it("reports a refused statement against the sql argument, without touching the database", async () => {
  const database = await createFixture(false);
  const before = await sha256(database.path);
  const provider = createProvider();
  onTestFinished(() => provider.close());
  const result = await provider.query({
    path: database.path,
    sql: "DELETE FROM records",
  });
  if (result.ok || result.error._tag !== "AnalysisInputError")
    throw new Error("Expected a refused statement");
  expect(result.error).toMatchObject({
    operation: "query_database_readonly",
    issues: [{ path: ["sql"], reason: "invalid_format" }],
  });
  expect(await sha256(database.path)).toBe(before);
});

it("stops an expensive statement when the caller cancels and releases the worker", async () => {
  const database = await createFixture(false);
  const provider = createProvider();
  onTestFinished(() => provider.close());
  const controller = new AbortController();
  const running = provider.query(
    {
      path: database.path,
      sql: "SELECT count(*) FROM (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT x FROM c)",
    },
    { signal: controller.signal },
  );
  setTimeout(() => controller.abort(), 2_000);
  const result = await running;
  if (result.ok || result.error._tag !== "AnalysisCancelledError")
    throw new Error("Expected the expensive statement to be cancelled");
  await expect(provider.close()).resolves.toBeUndefined();
}, 60_000);
