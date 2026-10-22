/**
 * verify:formats:sqlite — real-producer acceptance for format expansion F07.
 *
 * Builds databases with the installed sqlite3 shell (rollback journal, WAL
 * kept beside the file, WAL-mode file without its WAL, a corrupted page, a
 * database another sqlite3 process keeps writing), reads them through the
 * compiled CLI (inspect-sqlite-database, query-database-readonly) and compares
 * rows and CSV with sqlite3's own output. Refused statements, a cancelled
 * expensive query and byte-identical source files are checked too.
 */
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse } from "csv-parse/sync";

const exec = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const cli = join(repository, "scripts/oopsware.mjs");

const exists = async (path) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};
const sqlite3 = (
  await Promise.all(
    [
      "/opt/homebrew/opt/sqlite/bin/sqlite3",
      "/usr/local/bin/sqlite3",
      "/usr/bin/sqlite3",
    ].map(async (path) => ((await exists(path)) ? path : null)),
  )
).find((path) => path !== null);
if (sqlite3 === undefined) {
  console.error("UNAVAILABLE verify:formats:sqlite: needs the sqlite3 shell.");
  process.exit(2);
}

const produce = (path, sql) => execFileSync(sqlite3, [path], { input: sql });
const oracle = (path, sql) =>
  parse(execFileSync(sqlite3, ["-readonly", "-csv", "-header", path, sql]), {
    relax_column_count: false,
  });
const sha256 = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
const digests = async (paths) =>
  Promise.all(paths.map(async (path) => [path, await sha256(path)]));

/** Run the CLI; exit 0 is a result, exit 1 a projected error, anything else fails the lane. */
const run = async (...args) => {
  try {
    const { stdout } = await exec(process.execPath, [cli, ...args, "--json"], {
      maxBuffer: 256 * 1024 ** 2,
      env: { ...process.env, REA_LOG_LEVEL: "silent" },
    });
    return { ok: true, result: JSON.parse(stdout).normalized_result };
  } catch (cause) {
    assert.equal(
      cause.code,
      1,
      `${args.join(" ")}: ${cause.stderr ?? cause.message}`,
    );
    return { ok: false, error: JSON.parse(cause.stdout) };
  }
};
const succeeded = async (...args) => {
  const outcome = await run(...args);
  assert.ok(outcome.ok, `${args.join(" ")}: ${JSON.stringify(outcome.error)}`);
  return outcome.result;
};
const cells = (row) =>
  row.map((value) =>
    value.type === "null"
      ? null
      : value.type === "blob"
        ? value.hex
        : String(value.value),
  );
const oracleCells = (rows) =>
  rows.slice(1).map((row) => row.map((value) => (value === "" ? null : value)));

// Owned SQLite workers started from this checkout's compiled runtime.
const workers = () =>
  execFileSync("ps", ["-axo", "pid=,command="])
    .toString()
    .split("\n")
    .filter((line) =>
      line.includes(join(repository, "dist/sqlite/SqliteDatabaseWorker.js")),
    );

const summary = [];
const scratch = await mkdtemp(join(tmpdir(), "oopsware-sqlite-lane-"));
try {
  const version = execFileSync(sqlite3, ["--version"]).toString().split(" ")[0];
  summary.push(`producer ${sqlite3} ${version}`);

  // 1. Ordinary rollback-journal database: quoted names, composite and
  // WITHOUT ROWID keys, 64-bit edges, blobs, NULLs, views and triggers.
  const ordinary = join(scratch, "ordinary.db");
  produce(
    ordinary,
    `PRAGMA foreign_keys = ON;
     CREATE TABLE "odd ""name"" t"("key one" INTEGER, [b c] TEXT, big INTEGER, data BLOB, note,
       PRIMARY KEY ("key one", [b c]));
     CREATE TABLE wr(k TEXT PRIMARY KEY, v) WITHOUT ROWID;
     CREATE TABLE parent(id INTEGER PRIMARY KEY);
     CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));
     CREATE INDEX child_parent ON child(parent_id);
     CREATE VIEW wr_keys AS SELECT k FROM wr;
     CREATE TRIGGER wr_note AFTER INSERT ON wr BEGIN SELECT 1; END;
     INSERT INTO "odd ""name"" t" VALUES
       (1, 'a,b', 9223372036854775807, x'00ff', NULL),
       (1, 'quote "x"', -9223372036854775808, x'', '=SUM(A1)'),
       (2, 'line
break', 0, NULL, '+cmd'),
       (3, 'plain', 9007199254740993, x'7f', '@x');
     INSERT INTO wr VALUES ('c', 3), ('a', 1), ('b', 2);
     INSERT INTO parent VALUES (1); INSERT INTO child VALUES (10, 1);`,
  );
  const ordinaryBefore = await digests([ordinary]);
  const schema = await succeeded(
    "inspect-sqlite-database",
    ordinary,
    "--schema-scope",
    "database",
  );
  const tableNames = schema.schema.tables.map((table) => table.name).sort();
  assert.deepEqual(tableNames, ["child", 'odd "name" t', "parent", "wr"]);
  assert.equal(
    schema.schema.tables.find((table) => table.name === "wr").without_rowid,
    true,
  );
  assert.deepEqual(
    schema.schema.views.map((view) => view.name),
    ["wr_keys"],
  );
  assert.deepEqual(
    schema.schema.triggers.map((trigger) => trigger.name),
    ["wr_note"],
  );
  assert.ok(
    schema.schema.indexes.some((index) => index.name === "child_parent"),
  );

  const wr = await succeeded(
    "inspect-sqlite-database",
    ordinary,
    "--table",
    "wr",
  );
  assert.deepEqual(wr.rows.order, { basis: "primary_key", columns: ["k"] });
  assert.deepEqual(
    wr.rows.values.map(cells),
    oracleCells(oracle(ordinary, "SELECT k, v FROM wr ORDER BY k")),
  );

  const odd = await succeeded(
    "inspect-sqlite-database",
    ordinary,
    "--table",
    'odd "name" t',
    "--row-limit",
    "2",
  );
  assert.deepEqual(odd.rows.order, { basis: "rowid", columns: ["rowid"] });
  const oddNext = await succeeded(
    "inspect-sqlite-database",
    ordinary,
    "--table",
    'odd "name" t',
    "--row-limit",
    "2",
    "--offset",
    String(odd.rows.next_offset),
  );
  assert.equal(oddNext.rows.next_offset, null);
  const textColumns = `"key one", [b c], big, note`;
  assert.deepEqual(
    [...odd.rows.values, ...oddNext.rows.values].map((row) =>
      cells([row[0], row[1], row[2], row[4]]),
    ),
    oracleCells(
      oracle(
        ordinary,
        `SELECT ${textColumns} FROM "odd ""name"" t" ORDER BY rowid`,
      ),
    ),
  );
  const blobs = await succeeded(
    "query-database-readonly",
    ordinary,
    `SELECT data FROM "odd ""name"" t" ORDER BY rowid`,
  );
  assert.deepEqual(
    blobs.values.map(cells).flat(),
    // quote() tells NULL from an empty blob; hex() prints both as "".
    oracle(ordinary, `SELECT quote(data) FROM "odd ""name"" t" ORDER BY rowid`)
      .slice(1)
      .map(([quoted]) =>
        quoted === "NULL" ? null : quoted.slice(2, -1).toLowerCase(),
      ),
  );
  summary.push(
    "ordinary database: schema, quoted names, WITHOUT ROWID order, paging, 64-bit values and blobs match sqlite3",
  );

  // 2. CSV and bound parameters against sqlite3's own CSV.
  const sql = `SELECT ${textColumns} FROM "odd ""name"" t" WHERE "key one" >= ? AND big <> ? ORDER BY rowid`;
  const raw = await succeeded(
    "query-database-readonly",
    ordinary,
    sql,
    "--parameters",
    JSON.stringify([1, { type: "integer", value: "1" }]),
    "--csv",
    "raw",
  );
  const expected = oracle(
    ordinary,
    `SELECT ${textColumns} FROM "odd ""name"" t" WHERE "key one" >= 1 AND big <> 1 ORDER BY rowid`,
  );
  assert.deepEqual(
    parse(raw.csv.text),
    expected,
    "raw CSV equals sqlite3 -csv",
  );
  const escaped = await succeeded(
    "query-database-readonly",
    ordinary,
    sql,
    "--parameters",
    "[1, 1]",
    "--csv",
    "escaped",
  );
  const escapedRows = parse(escaped.csv.text);
  const escape = (value) => (/^[=+\-@\t\r]/.test(value) ? `'${value}` : value);
  assert.deepEqual(
    escapedRows,
    expected.map((row, index) =>
      row.map((value, column) =>
        index === 0 || [0, 2].includes(column) ? value : escape(value),
      ),
    ),
    "escaped CSV prefixes only formula-like text",
  );
  assert.ok(escapedRows.flat().includes("'=SUM(A1)"));
  for (const [parameters, sqlText] of [
    ["[]", "SELECT ?"],
    ["[1, 2]", "SELECT ?"],
    ['["x"]', "SELECT :named"],
  ]) {
    const refused = await run(
      "query-database-readonly",
      ordinary,
      sqlText,
      "--parameters",
      parameters,
    );
    assert.equal(refused.ok, false, sqlText);
    assert.equal(
      refused.error.details.issues[0].path[0],
      "parameters",
      sqlText,
    );
  }
  summary.push(
    "CSV raw equals sqlite3 -csv cell for cell; escaped differs only on formula-like text; parameter mismatches refused",
  );

  // 3. Writes, attaches, pragmas, extension loads and second statements are refused.
  const vacuumTarget = join(scratch, "vacuum-into.db");
  for (const refusedSql of [
    "DELETE FROM wr",
    "INSERT INTO wr VALUES ('d', 4)",
    "UPDATE wr SET v = 0",
    "DROP TABLE wr",
    `ATTACH '${join(scratch, "other.db")}' AS other`,
    "PRAGMA journal_mode = DELETE",
    "SELECT * FROM pragma_table_info('wr')",
    `VACUUM INTO '${vacuumTarget}'`,
    "SELECT load_extension('/usr/lib/libz.dylib')",
    "SELECT 1; DELETE FROM wr",
    "CREATE TEMP TABLE t(a)",
  ]) {
    const refused = await run("query-database-readonly", ordinary, refusedSql);
    assert.equal(refused.ok, false, refusedSql);
    assert.equal(refused.error.code, "invalid_request", refusedSql);
  }
  assert.equal(
    await exists(vacuumTarget),
    false,
    "VACUUM INTO created nothing",
  );
  assert.deepEqual(
    await digests([ordinary]),
    ordinaryBefore,
    "ordinary database unchanged",
  );
  summary.push(
    "11 write, attach, pragma, VACUUM INTO, extension and multi-statement attempts refused; source byte-identical",
  );

  // 4. WAL kept beside the database; then the same file without its WAL.
  const walDirectory = join(scratch, "wal");
  await mkdir(walDirectory);
  const walDatabase = join(walDirectory, "wal.db");
  produce(
    walDatabase,
    `PRAGMA journal_mode = WAL;
     CREATE TABLE t(a TEXT, b INTEGER);
     INSERT INTO t VALUES ('checkpointed', 1);
     PRAGMA wal_checkpoint(TRUNCATE);
.dbconfig no_ckpt_on_close on
     INSERT INTO t VALUES ('only in wal', 2);`,
  );
  assert.ok(await exists(`${walDatabase}-wal`), "sqlite3 kept the WAL");
  const walFiles = [walDatabase, `${walDatabase}-wal`, `${walDatabase}-shm`];
  const walBefore = await digests(walFiles);
  const withWal = await succeeded(
    "query-database-readonly",
    walDatabase,
    "SELECT a FROM t ORDER BY b",
  );
  assert.deepEqual(withWal.values.map(cells), [
    ["checkpointed"],
    ["only in wal"],
  ]);
  assert.equal(withWal.wal.sha256, walBefore[1][1]);
  assert.ok(
    !withWal.limitations.some((line) => line.includes("not proven current")),
  );
  assert.deepEqual(await digests(walFiles), walBefore, "WAL set unchanged");

  const lonely = join(scratch, "lonely");
  await mkdir(lonely);
  const withoutWal = join(lonely, "wal.db");
  await copyFile(walDatabase, withoutWal);
  const lonelyResult = await succeeded(
    "query-database-readonly",
    withoutWal,
    "SELECT a FROM t ORDER BY b",
  );
  assert.deepEqual(lonelyResult.values.map(cells), [["checkpointed"]]);
  assert.equal(lonelyResult.wal, null);
  assert.ok(
    lonelyResult.limitations.some((line) =>
      line.includes("not proven current"),
    ),
  );
  summary.push(
    "WAL rows read with the WAL identity; the same file without its WAL returns only checkpointed rows and says it is not proven current",
  );

  // 5. A damaged b-tree page is refused, never read as a short table.
  const corrupt = join(scratch, "corrupt.db");
  produce(
    corrupt,
    `PRAGMA page_size = 4096;
     CREATE TABLE big(id INTEGER PRIMARY KEY, body TEXT);
     WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000)
     INSERT INTO big SELECT i, printf('%0200d', i) FROM n;`,
  );
  const pages = (await readFile(corrupt)).length / 4096;
  const handle = await open(corrupt, "r+");
  try {
    const garbage = Buffer.alloc(4096, 0xa5);
    await handle.write(
      garbage,
      0,
      garbage.length,
      4096 * Math.floor(pages / 2),
    );
  } finally {
    await handle.close();
  }
  const corruptBefore = await digests([corrupt]);
  const damaged = await run(
    "query-database-readonly",
    corrupt,
    "SELECT count(*) FROM big",
  );
  assert.equal(
    damaged.ok,
    false,
    "a damaged page must not count as a shorter table",
  );
  assert.equal(damaged.error.code, "invalid_request");
  assert.deepEqual(damaged.error.details.issues[0].path, ["path"]);
  assert.match(damaged.error.details.issues[0].message, /malformed/);
  const damagedRows = await run(
    "inspect-sqlite-database",
    corrupt,
    "--table",
    "big",
    "--row-limit",
    "2000",
  );
  assert.ok(!damagedRows.ok || damagedRows.result.rows.returned_rows < 2000);
  assert.deepEqual(
    await digests([corrupt]),
    corruptBefore,
    "corrupt database unchanged",
  );
  summary.push(
    `corrupt page ${String(Math.floor(pages / 2) + 1)} of ${String(pages)}: query refused (${damaged.error.code}), row read ${damagedRows.ok ? "stopped short" : `refused (${damagedRows.error.code})`}; file unchanged`,
  );

  // 6. Another sqlite3 process commits while the tool reads: each run either
  // reads a whole committed state or refuses the changed file set.
  const busy = join(scratch, "busy.db");
  produce(busy, "CREATE TABLE log(id INTEGER PRIMARY KEY, body TEXT);");
  const writes = Array.from(
    { length: 30000 },
    (_, index) => `INSERT INTO log(body) VALUES ('${String(index)}');`,
  ).join("\n");
  const writer = spawn(sqlite3, [busy], { stdio: ["pipe", "ignore", "pipe"] });
  const writerDone = new Promise((resolveWriter, rejectWriter) => {
    writer.on("error", rejectWriter);
    writer.on("exit", (code) =>
      code === 0
        ? resolveWriter()
        : rejectWriter(new Error(`writer exit ${String(code)}`)),
    );
  });
  writer.stdin.end(`.timeout 5000\n${writes}\n`);
  const outcomes = { read: 0, refused: 0, counts: [] };
  let finished = false;
  void writerDone.finally(() => {
    finished = true;
  });
  while (!finished || outcomes.read + outcomes.refused < 3) {
    const outcome = await run(
      "query-database-readonly",
      busy,
      "SELECT count(*), max(id) FROM log",
    );
    if (outcome.ok) {
      const [count, max] = cells(outcome.result.values[0]);
      assert.equal(
        count,
        max ?? "0",
        "a read snapshot holds whole transactions",
      );
      outcomes.read += 1;
      outcomes.counts.push(Number(count));
    } else {
      assert.notEqual(
        outcome.error.code,
        "internal_error",
        JSON.stringify(outcome.error),
      );
      outcomes.refused += 1;
    }
    if (outcomes.read + outcomes.refused > 200) break;
  }
  await writerDone;
  assert.ok(outcomes.read >= 1, "a read after the last commit succeeds");
  assert.equal(
    execFileSync(sqlite3, [busy, "PRAGMA integrity_check"]).toString().trim(),
    "ok",
  );
  assert.equal(
    oracle(busy, "SELECT count(*) AS n FROM log")[1][0],
    "30000",
    "writer finished every commit",
  );
  summary.push(
    `concurrent writer (30000 commits): ${String(outcomes.read)} consistent reads (${outcomes.counts.join(", ")}), ${String(outcomes.refused)} refused changes; writer finished, integrity ok`,
  );

  // 7. An expensive statement stops on cancellation instead of running on.
  const started = Date.now();
  const child = spawn(
    process.execPath,
    [
      cli,
      "query-database-readonly",
      ordinary,
      "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c",
      "--json",
    ],
    {
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, REA_LOG_LEVEL: "silent" },
    },
  );
  let stdout = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  const exited = new Promise((resolveExit) =>
    child.on("exit", (code, signal) => resolveExit({ code, signal })),
  );
  await new Promise((resolveWait) => setTimeout(resolveWait, 3000));
  assert.ok(workers().length > 0, "the owned worker is running the statement");
  child.kill("SIGINT");
  const exit = await exited;
  const elapsed = Date.now() - started;
  assert.deepEqual(exit, { code: 130, signal: null }, "the CLI handled SIGINT");
  const cancelled = JSON.parse(stdout);
  assert.equal(cancelled.code, "cancelled");
  assert.equal(cancelled.details.cleanup, "complete");
  assert.deepEqual(workers(), [], "no worker outlives the cancelled call");
  assert.ok(
    elapsed < 20_000,
    `cancelled query ended after ${String(elapsed)} ms`,
  );
  assert.deepEqual(
    await digests([ordinary]),
    ordinaryBefore,
    "ordinary database unchanged",
  );
  summary.push(
    `unbounded recursive query cancelled after 3 s, CLI exited in ${String(elapsed)} ms total`,
  );

  for (const line of summary) console.log(line);
  console.log("PASS verify:formats:sqlite");
} finally {
  await rm(scratch, { recursive: true, force: true });
}
