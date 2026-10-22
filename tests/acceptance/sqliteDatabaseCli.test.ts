import { createHash } from "node:crypto";
import {
  lstat,
  readFile,
  rename,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, onTestFinished } from "vitest";
import { z } from "zod";
import {
  expandProviderCapabilities,
  expandToolAvailability,
  providerCapabilitySet,
  toolAvailabilityInventory,
} from "../../src/contracts/toolOutputSchemaPrimitives.js";

import { SQLITE_NATIVE_LIMITS_AVAILABLE } from "../fixtures/sqlite/database.js";
import { connectLocalToolsMcp } from "../fixtures/localToolsMcp.js";
import { parseMcpToolError } from "../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

const digest = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

for (const expectedErrno of ["ELOOP", "ENAMETOOLONG"] as const) {
  cliTest.skipIf(expectedErrno === "ELOOP" && process.platform === "win32")(
    `reports an initial ${expectedErrno} path failure through CLI and MCP`,
    async ({ cli }) => {
      const root = await createTestTempDirectory("rea-sqlite-path-failure-");
      const path =
        expectedErrno === "ELOOP"
          ? join(root, "cycle-a", "selected.db")
          : join(root, "a".repeat(300), "selected.db");
      if (expectedErrno === "ELOOP") {
        await symlink("cycle-b", join(root, "cycle-a"));
        await symlink("cycle-a", join(root, "cycle-b"));
      }
      const result = await cli.run({
        arguments: ["inspect-sqlite-database", path, "--json"],
        environment: { REA_LOG_LEVEL: "silent" },
      });
      expect(result.exitCode).toBe(1);
      const expectedError = {
        code: "invalid_request",
        details: {
          issues: [
            {
              path: ["path"],
              reason: "invalid_value",
              message: expect.stringContaining(expectedErrno),
            },
          ],
        },
      };
      expect(result.json).toMatchObject(expectedError);
      const { call } = await connectLocalToolsMcp();
      const response = await call("inspect_sqlite_database", { path });
      expect(parseMcpToolError(response).error).toMatchObject(expectedError);
    },
  );
}

cliTest(
  "reports the combined database and WAL byte budget through CLI and MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-sqlite-size-budget-");
    const path = join(root, "selected.db");
    const walPath = `${path}-wal`;
    const maximum = 256 * 1024 * 1024;
    const databaseBytes = maximum / 2;
    const walBytes = databaseBytes + 1;
    await writeFile(path, "");
    await writeFile(walPath, "");
    await truncate(path, databaseBytes);
    await truncate(walPath, walBytes);
    const before = await Promise.all(
      [path, walPath].map(async (filePath) => ({
        path: filePath,
        state: await lstat(filePath, { bigint: true }),
      })),
    );
    const cliResult = await cli.run({
      arguments: ["inspect-sqlite-database", path, "--json"],
      environment: { REA_LOG_LEVEL: "silent" },
    });
    const { call } = await connectLocalToolsMcp();
    const mcpResponse = await call("inspect_sqlite_database", { path });
    const mcpError = parseMcpToolError(mcpResponse).error;
    const expectedError = {
      code: "resource_constraint",
      category: "resource_constraint",
      retryable: false,
      details: {
        reported_limits: {
          sqlite_snapshot_input_bytes: maximum,
          observed_sqlite_snapshot_input_bytes: String(maximum + 1),
        },
      },
      remediation: {
        action: expect.stringContaining("supported export workflow"),
      },
    };
    expect(cliResult.exitCode).toBe(1);
    expect(cliResult.json).toMatchObject(expectedError);
    expect(mcpError).toMatchObject(expectedError);
    const after = await Promise.all(
      before.map(async ({ path: filePath }) => ({
        path: filePath,
        state: await lstat(filePath, { bigint: true }),
      })),
    );
    for (const [index, original] of before.entries()) {
      const current = after[index];
      expect(current?.state).toMatchObject({
        dev: original.state.dev,
        ino: original.state.ino,
        mode: original.state.mode,
        size: original.state.size,
        mtimeNs: original.state.mtimeNs,
        ctimeNs: original.state.ctimeNs,
      });
    }
  },
);

cliTest.skipIf(process.platform === "win32" || !SQLITE_NATIVE_LIMITS_AVAILABLE)(
  "reports an unavailable capability when a closed database sidecar path is too long",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-sqlite-long-basename-");
    const path = join(root, "x".repeat(255));
    const originalPath = join(root, "selected.db");
    const database = new DatabaseSync(originalPath);
    try {
      database.exec(
        "CREATE TABLE selected(value TEXT); INSERT INTO selected VALUES ('retained');",
      );
    } finally {
      database.close();
    }
    await rename(originalPath, path);
    const selectedBefore = await lstat(path, { bigint: true });
    await expect(lstat(`${path}-wal`)).rejects.toMatchObject({
      code: "ENAMETOOLONG",
    });
    await expect(lstat(`${path}-journal`)).rejects.toMatchObject({
      code: "ENAMETOOLONG",
    });

    const cliResult = await cli.run({
      arguments: ["inspect-sqlite-database", path, "--json"],
      environment: { REA_LOG_LEVEL: "silent" },
    });
    const { call } = await connectLocalToolsMcp();
    const mcpResult = await call("inspect_sqlite_database", { path });
    const expectedError = {
      code: "capability_unavailable",
      category: "unsupported_provider",
      retryable: false,
      message: expect.stringContaining("supported consistent offline export"),
      details: {
        provider_id: "sqlite",
        operation: "inspect_sqlite_database",
        reason: expect.stringContaining("ENAMETOOLONG"),
      },
      remediation: {
        action: expect.stringContaining("supported consistent offline export"),
      },
    };
    expect(cliResult.exitCode).toBe(1);
    expect(cliResult.json).toMatchObject(expectedError);
    expect(parseMcpToolError(mcpResult).error).toMatchObject(expectedError);
    const selectedAfter = await lstat(path, { bigint: true });
    expect(selectedAfter).toMatchObject({
      dev: selectedBefore.dev,
      ino: selectedBefore.ino,
      mode: selectedBefore.mode,
      size: selectedBefore.size,
      mtimeNs: selectedBefore.mtimeNs,
      ctimeNs: selectedBefore.ctimeNs,
    });
  },
);

cliTest.runIf(SQLITE_NATIVE_LIMITS_AVAILABLE)(
  "bounds default context and projects exact columns without evaluating unrelated cells",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-sqlite-selective-");
    const path = join(root, "selected.db");
    const database = new DatabaseSync(path);
    try {
      database.exec(`
        CREATE TABLE selected(id INTEGER, "" TEXT, payload BLOB GENERATED ALWAYS AS (zeroblob(72*1024*1024)) VIRTUAL);
        CREATE TABLE unrelated(value TEXT);
        CREATE VIEW unrelated_view AS SELECT value FROM unrelated;
        CREATE INDEX selected_id ON selected(id);
        CREATE TRIGGER selected_trigger AFTER INSERT ON selected BEGIN SELECT 1; END;
        WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<21)
        INSERT INTO selected(id, "") SELECT n, 'retained' FROM numbers;
      `);
    } finally {
      database.close();
    }
    const before = await readFile(path);
    const { call } = await connectLocalToolsMcp();
    const inventory = await call("inspect_sqlite_database", { path });
    expect(inventory.isError).not.toBe(true);
    const schema = z
      .object({
        normalized_result: z.object({
          schema: z.object({
            scope: z.literal("inventory"),
            tables: z.array(
              z.object({
                name: z.string(),
                columns: z.array(z.unknown()),
                columns_completeness: z.literal("not_requested"),
              }),
            ),
          }),
        }),
      })
      .parse(inventory.structuredContent).normalized_result.schema;
    expect(schema.tables.map((table) => table.name)).toEqual([
      "selected",
      "unrelated",
    ]);
    expect(schema.tables.every((table) => table.columns.length === 0)).toBe(
      true,
    );
    expect(JSON.stringify(inventory.structuredContent)).not.toContain(
      "zeroblob",
    );
    const selected = await call("inspect_sqlite_database", {
      path,
      table: "selected",
      columns: ["", "id", "id"],
    });
    expect(selected.isError).not.toBe(true);
    expect(selected.structuredContent).toMatchObject({
      normalized_result: {
        schema: {
          scope: "selected_table",
          tables: [{ name: "selected" }],
          views: [],
          indexes: [{ name: "selected_id" }],
          triggers: [{ name: "selected_trigger" }],
        },
        rows: {
          columns: ["", "id", "id"],
          row_limit: 20,
          returned_rows: 20,
          truncated: true,
          values: expect.arrayContaining([
            [
              {
                type: "text",
                value: "retained",
                bytes_hex: "72657461696e6564",
                encoding: "UTF-8",
              },
              { type: "integer", value: "1" },
              { type: "integer", value: "1" },
            ],
          ]),
        },
      },
    });
    const cliResult = await cli.run({
      arguments: [
        "inspect-sqlite-database",
        path,
        "--table",
        "selected",
        "--column",
        "id",
        "--column",
        "",
        "--row-limit",
        "1",
        "--json",
      ],
      environment: { REA_LOG_LEVEL: "silent" },
    });
    expect(cliResult.exitCode, cliResult.stdout + cliResult.stderr).toBe(0);
    expect(cliResult.json).toMatchObject({
      normalized_result: { rows: { columns: ["id", ""], returned_rows: 1 } },
    });
    const pagedResult = await cli.run({
      arguments: [
        "inspect-sqlite-database",
        path,
        "--table",
        "selected",
        "--column",
        "id",
        "--row-limit",
        "1",
        "--offset",
        "1",
        "--json",
      ],
      environment: { REA_LOG_LEVEL: "silent" },
    });
    expect(pagedResult.exitCode, pagedResult.stdout + pagedResult.stderr).toBe(
      0,
    );
    expect(pagedResult.json).toMatchObject({
      normalized_result: {
        rows: { offset: 1, next_offset: 2, returned_rows: 1 },
      },
    });
    for (const input of [
      { path, offset: 1 },
      { path, table: "selected", offset: -1 },
      { path, columns: ["id"] },
      { path, schema_scope: "selected_table" },
      { path, table: "selected", columns: [] },
      { path, table: "selected", columns: ["ID"] },
    ])
      expect((await call("inspect_sqlite_database", input)).isError).toBe(true);
    expect(await readFile(path)).toEqual(before);
  },
);

cliTest(
  "discovers SQLite runtime availability before inspecting a database through CLI and MCP",
  async ({ cli }) => {
    const result = await cli.run({
      arguments: ["capabilities", "--json"],
      environment: { REA_LOG_LEVEL: "silent" },
    });
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    const status = z
      .object({
        open: z.literal(false),
        capabilities: z.array(providerCapabilitySet),
      })
      .parse(result.json);
    expect(expandProviderCapabilities(status.capabilities)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: "inspect_sqlite_database",
          available: SQLITE_NATIVE_LIMITS_AVAILABLE,
          reason: SQLITE_NATIVE_LIMITS_AVAILABLE
            ? null
            : expect.stringContaining("Node.js 24.x >=24.15 or 26+"),
          availability_code: SQLITE_NATIVE_LIMITS_AVAILABLE
            ? null
            : "unsupported_version",
          limitations: [expect.stringContaining("DatabaseSync.limits")],
          effects: {
            mutates_artifact: false,
            launches_process: true,
            may_show_ui: false,
            may_access_network: false,
            may_write_filesystem: true,
            changes_permissions: false,
            requires_root: false,
          },
        }),
      ]),
    );
    const { call } = await connectLocalToolsMcp();
    const response = await call("binary_session", {});
    expect(response.isError).not.toBe(true);
    const sessionStatus = z
      .object({
        result: z.object({ tool_availability: toolAvailabilityInventory }),
      })
      .parse(response.structuredContent);
    expect(
      expandToolAvailability(sessionStatus.result.tool_availability),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "inspect_sqlite_database",
          available: SQLITE_NATIVE_LIMITS_AVAILABLE,
          remediation: SQLITE_NATIVE_LIMITS_AVAILABLE
            ? null
            : expect.stringContaining("Node.js 24.x >=24.15 or 26+"),
        }),
      ]),
    );
  },
);

cliTest.skipIf(SQLITE_NATIVE_LIMITS_AVAILABLE)(
  "reports the required native SQLite limits capability through CLI and MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-sqlite-unavailable-");
    const path = join(root, "selected.db");
    const database = new DatabaseSync(path);
    try {
      database.exec("CREATE TABLE items(value INTEGER)");
    } finally {
      database.close();
    }
    const result = await cli.run({
      arguments: ["inspect-sqlite-database", path, "--json"],
      environment: { REA_LOG_LEVEL: "silent" },
    });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      code: "capability_unavailable",
      message: expect.stringContaining("DatabaseSync.limits"),
    });
    const { call } = await connectLocalToolsMcp();
    const response = await call("inspect_sqlite_database", { path });
    expect(response.isError).toBe(true);
    expect(parseMcpToolError(response).error).toMatchObject({
      code: "capability_unavailable",
      message: expect.stringContaining("DatabaseSync.limits"),
    });
  },
);

cliTest.runIf(SQLITE_NATIVE_LIMITS_AVAILABLE)(
  "accepts small samples above 1000 rows within the real resource budgets",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-sqlite-row-budget-");
    const path = join(root, "rows.db");
    const database = new DatabaseSync(path);
    try {
      database.exec(`CREATE TABLE items(value INTEGER);
      WITH RECURSIVE numbers(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM numbers WHERE value < 1002)
      INSERT INTO items SELECT value FROM numbers;`);
    } finally {
      database.close();
    }
    const { call } = await connectLocalToolsMcp();
    for (const limit of [1001, Number.MAX_SAFE_INTEGER]) {
      const result = await cli.run({
        arguments: [
          "inspect-sqlite-database",
          path,
          "--table",
          "items",
          "--row-limit",
          String(limit),
          "--json",
        ],
        environment: { REA_LOG_LEVEL: "silent" },
      });
      expect(result.exitCode, result.stdout + result.stderr).toBe(0);
      expect(result.json).toMatchObject({
        normalized_result: {
          rows: {
            row_limit: limit,
            returned_rows: Math.min(limit, 1002),
            truncated: limit < 1002,
          },
        },
      });
      const response = await call("inspect_sqlite_database", {
        path,
        table: "items",
        row_limit: limit,
      });
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      expect(response.structuredContent).toEqual(result.json);
    }
  },
);

const sourceState = async (path: string) => {
  const bytes = await readFile(path);
  const metadata = await stat(path, { bigint: true });
  return {
    bytes,
    device: metadata.dev,
    inode: metadata.ino,
    size: metadata.size,
    modified: metadata.mtimeNs,
    changed: metadata.ctimeNs,
  };
};

const createLosslessSnapshot = (path: string, journalMode: string): void => {
  const database = new DatabaseSync(path);
  try {
    database.exec(`PRAGMA journal_mode=${journalMode}`);
    database.exec(`
      CREATE TABLE "odd "" table" (
        id INTEGER PRIMARY KEY,
        payload BLOB,
        amount REAL,
        missing TEXT,
        text_value TEXT,
        negative_zero,
        generated TEXT GENERATED ALWAYS AS (hex(payload)) VIRTUAL
      );
      CREATE UNIQUE INDEX "quoted "" index" ON "odd "" table"(payload, id);
      CREATE VIEW readable AS SELECT id FROM "odd "" table";
      CREATE TRIGGER observed AFTER INSERT ON "odd "" table" BEGIN SELECT 1; END;
      CREATE TABLE keyed(k TEXT PRIMARY KEY) WITHOUT ROWID, STRICT;
    `);
    const insert = database.prepare(
      'INSERT INTO "odd "" table"(id,payload,amount,missing,text_value,negative_zero) VALUES(?,?,?,NULL,CAST(X\'80ff\' AS TEXT),?)',
    );
    insert.setReadBigInts(true);
    expect(
      insert.run(
        9007199254740993n,
        Buffer.from("deadbeef", "hex"),
        Infinity,
        -0,
      ).lastInsertRowid,
    ).toBe(9007199254740993n);
    insert.run(9007199254740994n, Buffer.from("deadbeef", "hex"), Infinity, -0);
  } finally {
    database.close();
  }
};

cliTest
  .runIf(SQLITE_NATIVE_LIMITS_AVAILABLE)
  .for(["DELETE", "PERSIST", "TRUNCATE"])(
  "inspects a real %s SQLite schema and lossless selected records identically through CLI and MCP",
  async (journalMode, { cli }) => {
    const root = await createTestTempDirectory("rea-sqlite-public-");
    const path = join(root, "selected.db");
    createLosslessSnapshot(path, journalMode);
    const original = await readFile(path);
    const result = await cli.run({
      arguments: [
        "inspect-sqlite-database",
        "selected.db",
        "--schema-scope",
        "database",
        "--table",
        'odd " table',
        "--row-limit",
        "1",
        "--json",
      ],
      cwd: root,
      environment: {
        REA_LOG_LEVEL: "silent",
        REA_ANALYSIS_PROVIDER: "ghidra",
        REA_GHIDRA_HOME: "/unconfigured/ghidra",
      },
    });
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(result.json).toMatchObject({
      operation: "inspect_sqlite_database",
      confidence: "observed",
      subject: { local_path: path, digest: { sha256: digest(original) } },
      normalized_result: {
        artifact: { path, sha256: digest(original), bytes: original.length },
        wal: null,
        schema: {
          completeness: "complete",
          tables: expect.arrayContaining([
            expect.objectContaining({
              name: 'odd " table',
              columns: expect.arrayContaining([
                expect.objectContaining({
                  name: "id",
                  primary_key_position: 1,
                }),
                expect.objectContaining({ name: "generated", hidden: 2 }),
              ]),
            }),
            expect.objectContaining({
              name: "keyed",
              without_rowid: true,
              strict: true,
            }),
          ]),
          indexes: expect.arrayContaining([
            expect.objectContaining({
              name: 'quoted " index',
              table: 'odd " table',
            }),
          ]),
          views: [
            { name: "readable", sql: expect.stringContaining("SELECT id") },
          ],
          triggers: [
            {
              name: "observed",
              table: 'odd " table',
              sql: expect.stringContaining("AFTER INSERT"),
            },
          ],
        },
        rows: {
          table: 'odd " table',
          columns: [
            "id",
            "payload",
            "amount",
            "missing",
            "text_value",
            "negative_zero",
            "generated",
          ],
          returned_rows: 1,
          row_limit: 1,
          truncated: true,
          values: [
            [
              {
                type: "integer",
                value: expect.stringMatching(/^900719925474099[34]$/),
              },
              { type: "blob", hex: "deadbeef" },
              { type: "real", value: "Infinity" },
              { type: "null" },
              { type: "text", value: "\ufffd\ufffd", bytes_hex: "80ff" },
              { type: "real", value: "-0" },
              {
                type: "text",
                value: "DEADBEEF",
                bytes_hex: "4445414442454546",
              },
            ],
          ],
        },
      },
    });
    const { call } = await connectLocalToolsMcp();
    const response = await call("inspect_sqlite_database", {
      path,
      table: 'odd " table',
      schema_scope: "database",
      row_limit: 1,
    });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    expect(response.structuredContent).toEqual(result.json);
    expect(await readFile(path)).toEqual(original);
  },
);

cliTest.runIf(SQLITE_NATIVE_LIMITS_AVAILABLE)(
  "includes uncheckpointed committed WAL data without modifying the source database or sidecars",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-sqlite-wal-public-");
    const path = join(root, "wal.db");
    const database = new DatabaseSync(path);
    onTestFinished(() => database.close());
    database.exec(
      "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE committed(value TEXT); INSERT INTO committed VALUES('only in WAL');",
    );
    const files = [path, `${path}-wal`, `${path}-shm`];
    const before = await Promise.all(files.map(sourceState));
    const db = before[0];
    const wal = before[1];
    expect(db).toBeDefined();
    expect(wal).toBeDefined();
    const result = await cli.run({
      arguments: [
        "inspect-sqlite-database",
        path,
        "--table",
        "committed",
        "--json",
      ],
      environment: { REA_LOG_LEVEL: "silent" },
    });
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(result.json).toMatchObject({
      normalized_result: {
        artifact: { sha256: db === undefined ? "missing" : digest(db.bytes) },
        wal: {
          path: `${path}-wal`,
          sha256: wal === undefined ? "missing" : digest(wal.bytes),
        },
        rows: {
          values: [
            [
              {
                type: "text",
                value: "only in WAL",
                bytes_hex: Buffer.from("only in WAL").toString("hex"),
              },
            ],
          ],
          returned_rows: 1,
          truncated: false,
        },
      },
    });
    const { call } = await connectLocalToolsMcp();
    const response = await call("inspect_sqlite_database", {
      path,
      table: "committed",
    });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    expect(response.structuredContent).toEqual(result.json);
    const after = await Promise.all(files.map(sourceState));
    expect(after).toEqual(before);
  },
);

cliTest.runIf(SQLITE_NATIVE_LIMITS_AVAILABLE)(
  "returns actionable public errors for corrupt input, unknown or ambiguous tables and invalid record choices",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-sqlite-errors-public-");
    const path = join(root, "invalid.db");
    await writeFile(path, "not a SQLite database");
    const { call } = await connectLocalToolsMcp();
    const corrupt = await cli.run({
      arguments: ["inspect-sqlite-database", path, "--json"],
      environment: { REA_LOG_LEVEL: "silent" },
    });
    expect(corrupt.exitCode).toBe(1);
    expect(corrupt.json).toMatchObject({ code: "invalid_request" });
    expect((await call("inspect_sqlite_database", { path })).isError).toBe(
      true,
    );
    const valid = join(root, "valid.db");
    const database = new DatabaseSync(valid);
    try {
      database.exec(
        "CREATE TABLE present(value TEXT); CREATE VIRTUAL TABLE search USING fts5(body);",
      );
    } finally {
      database.close();
    }
    const bytes = await readFile(valid);
    const declaration = bytes.indexOf(Buffer.from("USING fts5"));
    if (declaration < 0) throw new Error("Virtual declaration missing");
    bytes.write("zzzz", declaration + Buffer.byteLength("USING "), "utf8");
    await writeFile(valid, bytes);
    const schema = await call("inspect_sqlite_database", { path: valid });
    expect(schema.isError).not.toBe(true);
    expect(schema.structuredContent).toMatchObject({
      normalized_result: {
        schema: {
          tables: expect.arrayContaining([
            expect.objectContaining({ name: "search_data", kind: "unknown" }),
          ]),
        },
      },
    });
    const ambiguous = await cli.run({
      arguments: [
        "inspect-sqlite-database",
        valid,
        "--table",
        "search_data",
        "--json",
      ],
      environment: { REA_LOG_LEVEL: "silent" },
    });
    expect(ambiguous.exitCode).toBe(1);
    expect(ambiguous.stdout).toContain("shadow table");
    expect(
      (
        await call("inspect_sqlite_database", {
          path: valid,
          table: "search_data",
        })
      ).isError,
    ).toBe(true);
    const missing = await cli.run({
      arguments: [
        "inspect-sqlite-database",
        valid,
        "--table",
        "absent",
        "--json",
      ],
      environment: { REA_LOG_LEVEL: "silent" },
    });
    expect(missing.exitCode).toBe(1);
    expect(missing.stdout).toContain("absent");
    expect(
      (await call("inspect_sqlite_database", { path: valid, table: "absent" }))
        .isError,
    ).toBe(true);
    for (const input of [
      { path: valid, row_limit: 1 },
      { path: valid, table: "present", row_limit: 0 },
      { path: valid, query: "DELETE FROM present" },
    ]) {
      expect(
        (await call("inspect_sqlite_database", input)).isError,
        JSON.stringify(input),
      ).toBe(true);
    }
  },
);

cliTest.skipIf(!SQLITE_NATIVE_LIMITS_AVAILABLE)(
  "queries a real database read-only identically through CLI and MCP and refuses writes",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-sqlite-query-");
    const path = join(root, "selected.db");
    const database = new DatabaseSync(path);
    try {
      database.exec(`
        CREATE TABLE events(kind TEXT, n INTEGER);
        INSERT INTO events VALUES ('a', 9223372036854775807), ('b', 2), ('c', 1);
      `);
    } finally {
      database.close();
    }
    const before = digest(await readFile(path));
    const sql = "SELECT kind, n FROM events ORDER BY n DESC";
    const cliResult = await cli.run({
      arguments: [
        "query-database-readonly",
        path,
        sql,
        "--row-limit",
        "2",
        "--json",
      ],
      environment: { REA_LOG_LEVEL: "silent" },
    });
    expect(cliResult.exitCode).toBe(0);
    const { call } = await connectLocalToolsMcp();
    const mcpResult = await call("query_database_readonly", {
      path,
      sql,
      row_limit: 2,
    });
    expect(mcpResult.isError).not.toBe(true);
    const expected = {
      operation: "query_database_readonly",
      parameters: { path, sql, row_limit: 2 },
      normalized_result: {
        artifact: { path, sha256: before },
        wal: null,
        columns: ["kind", "n"],
        row_limit: 2,
        returned_rows: 2,
        truncated: true,
        values: [
          [
            expect.objectContaining({ type: "text", value: "a" }),
            { type: "integer", value: "9223372036854775807" },
          ],
          [
            expect.objectContaining({ type: "text", value: "b" }),
            { type: "integer", value: "2" },
          ],
        ],
      },
    };
    expect(cliResult.json).toMatchObject(expected);
    expect(mcpResult.structuredContent).toMatchObject(expected);
    for (const refused of [
      "DELETE FROM events",
      "ATTACH 'other.db' AS other",
      "SELECT 1; SELECT 2",
    ]) {
      const cliRefusal = await cli.run({
        arguments: ["query-database-readonly", path, refused, "--json"],
        environment: { REA_LOG_LEVEL: "silent" },
      });
      expect(cliRefusal.exitCode, refused).toBe(1);
      expect(cliRefusal.json).toMatchObject({
        code: "invalid_request",
        details: { issues: [{ path: ["sql"], reason: "invalid_format" }] },
      });
      expect(
        (await call("query_database_readonly", { path, sql: refused })).isError,
        refused,
      ).toBe(true);
    }
    expect(digest(await readFile(path))).toBe(before);
  },
);

cliTest.skipIf(!SQLITE_NATIVE_LIMITS_AVAILABLE)(
  "binds parameters and returns escaped CSV identically through CLI and MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-sqlite-query-bind-");
    const path = join(root, "selected.db");
    const database = new DatabaseSync(path);
    try {
      database.exec(`
        CREATE TABLE events(kind TEXT, n INTEGER);
        INSERT INTO events VALUES ('=cmd', 9223372036854775807), ('b', 2);
      `);
    } finally {
      database.close();
    }
    const before = digest(await readFile(path));
    const sql = "SELECT kind, n FROM events WHERE n >= ? ORDER BY n DESC";
    const parameters = [{ type: "integer", value: "9223372036854775807" }];
    const cliResult = await cli.run({
      arguments: [
        "query-database-readonly",
        path,
        sql,
        "--parameters",
        JSON.stringify(parameters),
        "--csv",
        "escaped",
        "--json",
      ],
      environment: { REA_LOG_LEVEL: "silent" },
    });
    expect(cliResult.exitCode).toBe(0);
    const { call } = await connectLocalToolsMcp();
    const mcpResult = await call("query_database_readonly", {
      path,
      sql,
      parameters,
      csv: "escaped",
    });
    expect(mcpResult.isError).not.toBe(true);
    const expected = {
      operation: "query_database_readonly",
      parameters: { path, sql, parameters, csv: "escaped" },
      normalized_result: {
        returned_rows: 1,
        values: [
          [
            expect.objectContaining({ type: "text", value: "=cmd" }),
            { type: "integer", value: "9223372036854775807" },
          ],
        ],
        csv: {
          escaping: "escaped",
          text: "kind,n\r\n'=cmd,9223372036854775807\r\n",
        },
      },
    };
    expect(cliResult.json).toMatchObject(expected);
    expect(mcpResult.structuredContent).toMatchObject(expected);
    for (const bad of ["[]", "not json"]) {
      const refusal = await cli.run({
        arguments: [
          "query-database-readonly",
          path,
          sql,
          "--parameters",
          bad,
          "--json",
        ],
        environment: { REA_LOG_LEVEL: "silent" },
      });
      expect(refusal.exitCode, bad).toBe(1);
      expect(refusal.json, bad).toMatchObject({
        code: "invalid_request",
        details: { issues: [{ path: ["parameters"] }] },
      });
    }
    expect(digest(await readFile(path))).toBe(before);
  },
);
