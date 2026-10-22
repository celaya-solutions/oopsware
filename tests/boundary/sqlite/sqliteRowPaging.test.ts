import { DatabaseSync } from "node:sqlite";
import { expect, it as nativeTest, onTestFinished } from "vitest";
import { SQLITE_NATIVE_LIMITS_AVAILABLE } from "../../fixtures/sqlite/database.js";
import { inspectSqliteDatabaseSnapshot } from "../../../src/sqlite/SqliteDatabaseInspection.js";
import { SqliteInspectionFailure } from "../../../src/sqlite/SqliteDatabaseLimits.js";
import {
  createTestWorkspace,
  removeTestWorkspace,
} from "../../support/workspace/workspaceFixture.js";

const it = nativeTest.runIf(SQLITE_NATIVE_LIMITS_AVAILABLE);

const createDatabase = async (sql: string): Promise<string> => {
  const workspace = await createTestWorkspace("rea-sqlite-paging-");
  onTestFinished(() => removeTestWorkspace(workspace.root));
  const path = workspace.path("private.db");
  const producer = new DatabaseSync(path);
  try {
    producer.exec(sql);
  } finally {
    producer.close();
  }
  return path;
};

const page = (
  path: string,
  table: string,
  options: { readonly row_limit?: number; readonly offset?: number } = {},
) => {
  const rows = inspectSqliteDatabaseSnapshot(path, {
    path,
    table,
    ...options,
  }).rows;
  if (rows === null) throw new Error("expected rows");
  return rows;
};

const integers = (rows: ReturnType<typeof page>, column = 0): string[] =>
  rows.values.map((row) => {
    const value = row[column];
    if (value?.type !== "integer") throw new Error("expected an integer");
    return value.value;
  });

it("pages a rowid table in rowid order, not insertion order", async () => {
  const path = await createDatabase(`
    CREATE TABLE items(label TEXT);
    INSERT INTO items(rowid, label) VALUES (5, 'e'), (2, 'b'), (9, 'i'), (1, 'a'), (7, 'g');
  `);
  const first = page(path, "items", { row_limit: 2 });
  expect(first).toMatchObject({
    offset: 0,
    returned_rows: 2,
    truncated: true,
    next_offset: 2,
    order: { basis: "rowid", columns: ["rowid"] },
  });
  const second = page(path, "items", { row_limit: 2, offset: 2 });
  expect(second).toMatchObject({ offset: 2, truncated: true, next_offset: 4 });
  const last = page(path, "items", { row_limit: 2, offset: 4 });
  expect(last).toMatchObject({
    returned_rows: 1,
    truncated: false,
    next_offset: null,
  });
  const labels = [first, second, last].flatMap((rows) =>
    rows.values.map((row) => (row[0]?.type === "text" ? row[0].value : "?")),
  );
  expect(labels).toEqual(["a", "b", "e", "g", "i"]);
});

it("returns an empty final page, not an error, past the last row", async () => {
  const path = await createDatabase(`
    CREATE TABLE items(label TEXT);
    INSERT INTO items VALUES ('a'), ('b');
  `);
  expect(page(path, "items", { offset: 2 })).toMatchObject({
    values: [],
    returned_rows: 0,
    truncated: false,
    next_offset: null,
  });
  expect(page(path, "items", { offset: 50 })).toMatchObject({
    returned_rows: 0,
    next_offset: null,
  });
});

it("orders a WITHOUT ROWID table by its primary key in key order, with quoted names", async () => {
  const path = await createDatabase(`
    CREATE TABLE "kv "" pairs"("second" INTEGER, "first" INTEGER, note TEXT, PRIMARY KEY("first", "second")) WITHOUT ROWID;
    INSERT INTO "kv "" pairs" VALUES (1, 2, 'x'), (2, 1, 'y'), (1, 1, 'z'), (2, 2, 'w');
  `);
  const rows = page(path, 'kv " pairs', { row_limit: 3 });
  expect(rows.order).toEqual({
    basis: "primary_key",
    columns: ["first", "second"],
  });
  expect(rows).toMatchObject({ truncated: true, next_offset: 3 });
  // Columns are returned in table order (second, first); rows sort by (first, second).
  expect(integers(rows, 1)).toEqual(["1", "1", "2"]);
  expect(integers(rows, 0)).toEqual(["1", "2", "1"]);
  const rest = page(path, 'kv " pairs', { row_limit: 3, offset: 3 });
  expect(integers(rest, 1)).toEqual(["2"]);
  expect(rest.next_offset).toBeNull();
});

it("uses the rowid, not a declared primary key that may repeat NULLs, in a rowid table", async () => {
  const path = await createDatabase(`
    CREATE TABLE loose(a, b, PRIMARY KEY(a, b));
    INSERT INTO loose(rowid, a, b) VALUES (3, NULL, 1), (1, NULL, 1), (2, NULL, 1);
  `);
  const rows = page(path, "loose");
  expect(rows.order).toEqual({ basis: "rowid", columns: ["rowid"] });
  expect(integers(rows, 1)).toEqual(["1", "1", "1"]);
});

it("reaches the rowid through another alias when a column shadows rowid", async () => {
  const path = await createDatabase(`
    CREATE TABLE shadowed(ROWID TEXT, value TEXT);
    INSERT INTO shadowed(_rowid_, ROWID, value) VALUES (2, 'x', 'second'), (1, 'y', 'first');
  `);
  const rows = page(path, "shadowed");
  expect(rows.order).toEqual({ basis: "rowid", columns: ["_rowid_"] });
  expect(rows.values.map((row) => row[1])).toEqual([
    expect.objectContaining({ value: "first" }),
    expect.objectContaining({ value: "second" }),
  ]);
});

it("finds the shadowing column in a UTF-16 database", async () => {
  const path = await createDatabase(`
    PRAGMA encoding = 'UTF-16le';
    CREATE TABLE shadowed(rowid TEXT, value TEXT);
    INSERT INTO shadowed(_rowid_, rowid, value) VALUES (2, 'x', 'b'), (1, 'y', 'a');
  `);
  expect(page(path, "shadowed").order).toEqual({
    basis: "rowid",
    columns: ["_rowid_"],
  });
});

it("reads only the first page, unordered, when every rowid alias is shadowed", async () => {
  const path = await createDatabase(`
    CREATE TABLE hidden(rowid, _rowid_, oid);
    INSERT INTO hidden VALUES (1, 2, 3), (4, 5, 6);
  `);
  expect(page(path, "hidden")).toMatchObject({
    order: "unspecified",
    offset: 0,
    returned_rows: 2,
    next_offset: null,
  });
  expect(() => page(path, "hidden", { offset: 1 })).toThrow(
    SqliteInspectionFailure,
  );
});

it("keeps one stable order across pages of a larger table", async () => {
  const path = await createDatabase(`
    CREATE TABLE numbers(n INTEGER);
    WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 250)
    INSERT INTO numbers(rowid, n) SELECT 1000 - x, x FROM c;
  `);
  const seen: string[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const rows = page(path, "numbers", { row_limit: 64, offset });
    seen.push(...integers(rows));
    offset = rows.next_offset;
  }
  expect(seen).toHaveLength(250);
  expect(new Set(seen).size).toBe(250);
  expect(seen[0]).toBe("250");
  expect(seen[249]).toBe("1");
});
