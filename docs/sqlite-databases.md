# SQLite database snapshots

`inspect_sqlite_database` / `inspect-sqlite-database` inspects one explicitly
selected local SQLite database snapshot without an active native analysis
target. Use it to understand application storage, configuration or retained
database evidence. No separate SQLite installation is required.

This operation requires Node.js 24.x >=24.15 or 26+ with the native
`DatabaseSync.limits` API. The worker verifies that capability before querying
the copied database. Other REA features retain their published Node.js 22.x,
24.x or 26+ requirements.

`rea capabilities` reports `inspect_sqlite_database` availability and the
runtime requirement without opening a database. Unsupported runtimes show
`available: false`, `availability_code: "unsupported_version"`, and an upgrade
note while the inventory command still succeeds.

```sh
rea capabilities --json
rea inspect-sqlite-database ./application.sqlite --json
rea inspect-sqlite-database ./application.sqlite --table settings --column key --column value --row-limit 20 --json
```

```json
{
  "name": "inspect_sqlite_database",
  "arguments": {
    "path": "/artifacts/application.sqlite",
    "table": "settings",
    "columns": ["key", "value"],
    "row_limit": 20
  }
}
```

MCP paths must be absolute filesystem paths on the current host. CLI paths
resolve against the operator's working directory. Select a quiescent snapshot:
stop the writer or obtain a consistent database/WAL pair using the application's
backup workflow before inspection. A file copy of a live pair does not establish
an atomic SQLite snapshot, even if no change is detected during inspection.

## Returned evidence

Without a table selection, the default `schema_scope` is `inventory`: compact
table metadata and index, view and trigger names, without SQL declarations or
column details. Selecting a table defaults to `selected_table`, which expands
that table and its indexes and triggers. Explicit `schema_scope: "database"`
(or CLI `--schema-scope database`) expands all stored declarations and supported
columns. `schema.completeness` refers to the reported scope; omitted column
details are marked `not_requested`. SQL declarations retain the original text. Virtual and
shadow tables are identified as such; their supported metadata coverage is
reported. If a virtual table cannot be resolved, possible backing tables have
`kind: "unknown"` and an explicit limitation; their rows are refused. Unrelated
ordinary tables remain selectable. Schema inventory does not execute views,
triggers or arbitrary SQL.

Rows are optional. `table` selects one exact ordinary-table name. `columns`
(CLI repeated `--column`) selects exact visible column names in the requested
order; omission selects all visible columns, including generated columns.
Unselected cells are not evaluated or projected. Malformed column-name bytes
cause a format refusal when all columns are requested. In inventory scope, an explicit valid subset can
still be sampled without decoding unrelated malformed column names.
Column selection requires a
table and at least one name; empty-string identifiers are valid. `row_limit`
requires `table`, defaults to 20 and accepts positive safe integers. Pages
remain subject to the byte and worker resource limits below, regardless of row count.

Rows come one page at a time in an order that stays fixed for one frozen
snapshot: the rowid for an ordinary table, or the primary key (in key order)
for a `WITHOUT ROWID` table. A rowid table's declared primary key is never the
order, because SQLite lets it repeat NULLs. If a real column is named `rowid`,
the order uses `_rowid_` or `oid` instead, and `rows.order` names the columns
used. `offset` (CLI `--offset`, default 0, requires `table`) skips rows in that
order; pass the previous result's `next_offset` to read the following page.
`next_offset` is `null` after the last row, and an offset past the end returns
an empty page. The result also reports the limit, returned count and
`truncated`. An offset only means the same rows on the same snapshot: compare the
database SHA-256 between pages, because a changed file reorders and shifts rows.
In the rare table whose three rowid names are all taken by columns,
`rows.order` is `"unspecified"` and only offset 0 is accepted. View,
virtual-table and shadow-table row reads are unsupported.

```sh
rea inspect-sqlite-database ./application.sqlite --table settings --row-limit 100 --offset 100 --json
```

SQLite integers are decimal strings so every signed 64-bit value survives JSON
serialization. Real values retain their numbers; `"Infinity"`, `"-Infinity"`
and `"-0"` explicitly preserve infinities and negative zero through JSON.
Text returns the decoded string together with its bytes as hex and the database
encoding, preserving malformed text that the SQLite binding may replace for
display. Blobs are hex, and SQL NULL is a distinct tagged value.

Database and existing sibling `-wal` files have separate original SHA-256 and
byte counts. The Evidence subject identifies the original database file;
the WAL identity is also necessary to interpret pending committed data. The
SQLite engine version is reported with the observed result. Neither digest is
a claim that the database is healthy, complete or trusted.

## Read-only SQL

`query_database_readonly` / `query-database-readonly` runs one statement you
write against the same frozen copy, for questions the table browser cannot
answer (a join, a count, a filter). It is local only: the public library never
runs caller SQL, and `inspect_sqlite_database` still never does either. Learn
table and column names with `inspect_sqlite_database` first.

```sh
rea query-database-readonly ./application.sqlite "SELECT kind, count(*) AS n FROM events GROUP BY kind ORDER BY n DESC" --row-limit 10 --json
```

```json
{
  "name": "query_database_readonly",
  "arguments": {
    "path": "/artifacts/application.sqlite",
    "sql": "SELECT kind, count(*) AS n FROM events GROUP BY kind ORDER BY n DESC",
    "row_limit": 10
  }
}
```

Read-only is decided by SQLite, not by looking for keywords. The copy is opened
read-only, query-only and defensive with extensions off, and SQLite's
authorizer admits only reads of tables, views and built-in functions. A write,
`ATTACH`, any `PRAGMA` (including the `pragma_*` table functions), `VACUUM`
(including `VACUUM INTO`), `ANALYZE`, `REINDEX`, a transaction statement or
`load_extension` is refused as an invalid `sql` argument and nothing runs. The
statement must be exactly one `SELECT`, `WITH` or `VALUES`; text after it,
including a trailing comment after a semicolon, is refused. One trailing
semicolon, or a comment inside the statement, is fine. `EXPLAIN` is not
accepted.

The result lists the column names exactly as SQLite reports them (duplicates
kept) and up to `row_limit` rows (default 20, positive safe integer). The
statement runs inside a wrapper that applies the limit, so an unbounded
recursive query still ends; `truncated` says more rows existed. Cells use the
same lossless values as table rows: 64-bit integers as decimal strings, text
with its stored bytes and database encoding, blobs as hex, NULL tagged. Row
order is whatever the statement says: add `ORDER BY` when order matters, since
an unsorted result has no specified order. The Evidence carries the statement,
bound values, limit and CSV choice as its parameters, plus the database and WAL
digests.

### Bound parameters

`parameters` (CLI `--parameters '<JSON array>'`) binds values by position to
the statement's `?` and `?NNN` placeholders: the first value goes to the first
`?`, and `?3` takes the third value. A JSON string binds as text, `null` as
NULL, a safe integer as INTEGER and any other number as REAL. Use
`{"type": "integer", "value": "9223372036854775807"}` for integers beyond
2^53 (the same form results use) and `{"type": "blob", "hex": "00ff"}` for
bytes. Every placeholder needs a value: a statement with more placeholders than
values, or fewer, is refused as an invalid `parameters` argument instead of
running with NULLs. Named placeholders (`:name`, `@name`, `$name`) are refused,
because Node's binding never fills them by position. At most 999 values, and
their text and blob hex together at most 1 MiB.

```sh
rea query-database-readonly ./application.sqlite "SELECT id, total FROM orders WHERE user_id = ? AND total > ? ORDER BY total DESC" --parameters '[42, 9.5]' --json
```

### CSV

`csv: "raw"` or `csv: "escaped"` (CLI `--csv`) also returns the rows as
RFC 4180 CSV text (`csv.text`, CRLF line ends, a header row of column names).
NULL is an empty field, a blob is its lowercase hex, and an integer keeps all
its digits. The raw CSV keeps text exactly as stored, so a value starting with
`=`, `+`, `-`, `@`, tab or carriage return can run as a formula when the file
is opened in a spreadsheet; the result says so in its limitations. The escaped
CSV puts an apostrophe before such text values (numbers are left alone), which
makes it safe to open but no longer equal to the stored text. Text that is not valid in the database encoding appears in the
CSV with U+FFFD replacement characters and the result counts such fields in its
limitations. The `values`
array always keeps the original values (with `bytes_hex`). The CSV counts toward the same 16 MiB
reply budget.

Limits are the ones above, plus these facts about queries. SQLite's progress
handler is not available to Node's binding, so there is no in-process interrupt:
an expensive statement ends when the owned worker reaches its 30-second deadline
or the caller cancels, and returns no partial rows. Reply bytes are counted as
rows are kept, but one very wide row is built before it can be counted, so the
worker's 256 MiB heap and SQLite's 16 MiB value limit are the last guards; both
fail the whole call. The statement text is capped at 64 KiB.

## Source files and failures

REA copies the selected database and existing sibling WAL to an owned private
temporary directory before SQLite opens them. Source files are not opened by
SQLite, so its locks or shared-memory sidecars cannot modify the original
snapshot. Temporary copies and the owned worker are cleaned up on success,
failure and cancellation. Extension loading and schema trust are disabled.
Empty rollback journals and fully zeroed journal headers left by successful
`TRUNCATE` and `PERSIST` commits are accepted after stable identity checks.
Journal headers are checked both before and after acquisition; unchanged file
metadata alone does not establish that a journal remains inactive.
Other retained rollback journals are refused because recovery is outside this
profile. Journal files are never modified or copied into the worker snapshot.

A provider admits at most two inspections or queries (together) through
acquisition, worker execution and cleanup. Additional requests receive a typed capacity error before reading
files or creating workers; retry after an active inspection finishes. This
bounds simultaneous input buffering and private snapshot/worker counts.

The database and WAL together are limited to 256 MiB. SQLite values/records,
SQL statements and the complete worker JSON reply each have a 16 MiB limit.
The owned worker has a 256 MiB JavaScript heap limit and a 30-second inspection
deadline. SQLite native allocations are separate from the JavaScript heap;
overall native heap and total resident memory are not capped. Row limits do not
override these byte and resource limits. Resource-limit failures do not return
an incomplete schema as successful complete evidence.

If the combined database and WAL exceed the snapshot budget, the refusal is a
`resource_constraint` and reports both the configured byte limit and the exact
observed combined size as a decimal string. The remediation directs callers to
create a smaller consistent offline snapshot containing only relevant data
through the application's supported export workflow. A generic backup or copy
does not guarantee a smaller result; REA does not truncate or modify the
selected source.

On hosts that cannot address the derived WAL or rollback-journal path for a
long selected database name, REA reports that the SQLite capability is
unavailable. It does not assume an inaccessible sidecar is absent. Use the
application's supported consistent offline export or copy workflow to place
the complete known file set at a shorter path.

MCP also applies its configured response budget to the complete Evidence
envelope. If delivery exceeds that budget, it reports a transport constraint
with guidance for exporting retained Evidence, requesting a matching larger
client/server response budget or using complete CLI JSON output.

A cancellation received after the worker has completed does not erase the
completed observation. If subsequent private-root cleanup fails, the error
retains the completed Evidence and the resource owner for cleanup retry. MCP
records that Evidence before delivering the error, which carries its retained
evidence ID for later retrieval or export.

A database whose header says WAL mode but that has no `-wal` file beside it is
read as its last checkpointed state, with a limitation saying the result is not
proven current: rows committed to a WAL that was not supplied are missing, and
SQLite cannot tell. Supply the database together with its `-wal` file.

Changed input identities, special files, malformed databases, unsupported
formats and resource failures are reported as errors with the selected path and
meaningful reason. Encrypted databases, database repair, cross-database queries
and live capture are outside this inspection's coverage; `inspect_sqlite_database`
runs no caller SQL, and `query_database_readonly` is the separate local tool for it.

## Compatibility verification

`npm run verify:formats:sqlite` is the real-producer lane. It builds databases
with the installed `sqlite3` shell and reads them through the compiled CLI: an
ordinary database with quoted names, composite and `WITHOUT ROWID` keys, 64-bit
edges, blobs, views and triggers (rows and CSV compared cell for cell with
`sqlite3 -csv`); bound parameters; eleven refused write, attach, pragma,
`VACUUM INTO`, extension and multi-statement attempts; a database with its WAL
and the same file without it; a page overwritten with garbage (refused, never
read as a shorter table); a second `sqlite3` process committing 30,000
transactions while the tool reads (each read either holds whole transactions or
refuses the changed file set); and an unbounded query cancelled with SIGINT.
Every source file is checked byte for byte afterwards. Without a `sqlite3`
shell the lane exits 2 as unavailable.

Run `npm run test:sqlite` after changing the SQLite adapter or its shared
process, filesystem, CLI or MCP boundaries. It prepares the compiled runtime
and runs SQLite service, snapshot, inspection, cleanup and public CLI/MCP
tests. Directory-based selection includes new SQLite service and boundary
tests automatically. `npm run test:sqlite:run` runs the same cases when the
compiled runtime and generated test artifacts are already current.

The reusable SQLite CI workflow consumes the shared build artifact and tests
the latest Node 22.x unavailable-runtime diagnostics, the minimum supported
24.15.0 release, and the latest 24.x and 26.x releases. The repository-pinned
runtime also runs the full suite. CI's required gate waits for every selected
SQLite matrix job; a failed, cancelled, skipped or missing selected lane blocks
the gate. Workflow changes themselves select the build and compatibility lane.

PR checks run against GitHub's merge with the current base branch. A later
change to `main` can introduce failures outside SQLite; inspect the failing
job and recheck the updated merge before treating an earlier green run as
current verification. Compatibility checks detect regressions, but cannot
guarantee that an arbitrary future upstream change remains compatible.
