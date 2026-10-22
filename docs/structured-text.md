```text
Document:    Structured-text reading (format expansion F11)
Version:     v1.0.1
Author:      Celaya Solutions
Contact:     hello@celayasolutions.com
Date:        2026-10-17
SHA256:      cff0fc445d98f18dfc95a09c7f6a322453265d2affc6d8596a0683f0da0b6fce
Chain:       solana-mainnet
Tx:          LLUS118a1cMnHwCeGaxU7LmCKBDAWUYJ9iteZu4gWDBnBV6SUjartio5LiJCbC7HLBCNk71dEvERdunPW2ZPdH3
License:     All Rights Reserved / Celaya Solutions
```

# Structured-text reading

`inspect_document` / `inspect-document` reads one explicitly selected local
document and returns its parsed structure. It covers format expansion F11
(milestone P1): Markdown (`.md`, `.markdown`), JSON (`.json`), JSON Lines
(`.jsonl`), YAML (`.yaml`, `.yml`), TOML (`.toml`), XML (`.xml`), CSV (`.csv`),
TSV (`.tsv`) and plain text (`.txt`). Parsing runs in process; nothing is
installed, fetched, expanded, executed or written back.

```sh
oopsware inspect-document ./config.json --json
oopsware inspect-document ./export.txt --parse-as csv --delimiter ';' --start 500 --limit 500 --json
```

MCP input: `path` (absolute), optional `format`, `encoding` (`utf-8`,
`utf-16le`, `utf-16be`, `windows-1252`), `delimiter` (CSV/TSV only), `start`,
`limit` (1–2000, default 500) and `max_file_bytes` (default 64 MiB, at most
256 MiB). The CLI spells `format` as `--parse-as`, because `--format` selects
the CLI output format.

## What a reading contains

- `artifact`: path, SHA-256 and byte size of the stable read.
- `format`: the profile, whether it came from the name suffix or the caller,
  and the suffix's own hint when a request disagrees with it.
- `encoding`: the decoding used and why (byte-order mark, request, XML
  declaration, or the UTF-8 default), BOM length, every undecodable byte run
  (offset and length, first 100 listed, all counted), NUL count, LF/CRLF/CR
  counts, line count and final newline.
- `parse`: `parsed`, `partial` (structure kept, errors found) or `failed`, the
  pinned parser, and record counts for JSON Lines, CSV/TSV rows, YAML documents
  and text lines.
- `diagnostics`: errors, warnings and notes, each with line, column, byte
  offset and record where known (first 200 listed, the rest counted).
- `nodes`: one page of structural nodes in source order. Each has a stable
  pre-order `index`, `depth`, `kind`, `path` (JSON Pointer for data, XPath-like
  for XML, heading trail for Markdown), `name`, `value` (source text for
  numbers; values over 4096 characters are cut and give their full length),
  CSV `fields`, `record`, `location` and `end_offset`. Paths over 1024
  characters are cut and marked `details.path_cut`, so one long key or name is
  not copied into every node below it. Structure nested deeper than 1000 levels
  stops with a located `nesting_too_deep` error; for JSON Lines only that
  record fails.
- `page`: `start`, `limit`, `returned` and the exact `next` start, or null.
- `coverage`: identify/inspect facets per the format registry contract;
  inventory, extract and reconstruct are `unsupported` for a single document.

## Per-format behavior

| Format     | Parser (pinned)                   | Behavior and limits                                                                                                                                                                                                                    |
| ---------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JSON       | jsonc-parser 3.3.1 + `JSON.parse` | Comments and trailing commas fail. Numbers keep source text and say whether a float64 holds them exactly. Duplicate keys are warnings and every occurrence is listed. Deep nesting fails explicitly.                                   |
| JSON Lines | same                              | Each line is one record. A bad record is an error naming its record and line; every valid record before and after it stays listed. Blank lines are warnings.                                                                           |
| YAML       | yaml 2.9.0 (YAML 1.2 core)        | Aliases are reference nodes, never expanded, so alias amplification stays linear. Custom or language tags (`!!python/...`) are warnings and never constructed. Duplicate keys are errors.                                              |
| TOML       | smol-toml 1.9.0                   | Integers stay exact; offset/local date-times, dates and times keep their kinds. Errors have line and column; values have no source location, and integer-like keys follow JavaScript object order.                                     |
| XML        | @xmldom/xmldom 0.9.12             | Namespaces, prefixes, attribute order and document order are kept. A DTD internal subset is an error: its declarations are not processed, entity references stay literal text. External DTDs and XInclude are recorded, never fetched. |
| CSV / TSV  | csv-parse 7.0.3                   | Quoted delimiters and newlines, uneven rows (warnings with row and line) and formula-like cells (notes) are reported. After a malformed quote the rest is not listed, because the quoting state is unknown.                            |
| Markdown   | markdown-it 14.3.3                | Top-level blocks, headings, links and images. Links that the safe renderer refuses (such as `javascript:`) are flagged; images are never fetched; raw HTML is counted as text. Link locations are block-precise.                       |
| Plain text | line reader                       | One node per line with its newline kind.                                                                                                                                                                                               |

Undecodable bytes stop JSON, JSON Lines, YAML, TOML and XML from being parsed
(the reading is `failed` with the byte offsets); Markdown, CSV/TSV and plain
text are read with one U+FFFD per undecodable run and marked `partial`.

## Public library

Uploaded originals with one of these names are parsed once in the analysis
worker, in a separate process with a 384 MiB heap and a three-minute budget.
Limits: JSON, JSON Lines, CSV, TSV and text originals up to 16 MiB; Markdown,
YAML, XML and TOML (whose parsers build a whole tree) up to 4 MiB; the first
100,000 nodes are stored in pages of 500. A file that exceeds the budget loses
only its structured view: the inspection, byte preview and download remain.
Files inside archives keep the earlier byte preview. Stored views
use schema `oopsware.structured-text.v1` under the submission's `document/`
folder; older uploads have none and keep the byte preview.

- `GET /api/submissions/:id/structure`: the view index (format, encoding,
  parse status, diagnostics, coverage, limits, node page count and reading
  segments).
- `GET /api/submissions/:id/structure/nodes/:page`: one page of stored nodes.
- `GET /api/submissions/:id/previews/segment-:n`: decoded text of one reading
  page, read from the untouched original by its byte range. Pages end on whole
  Markdown blocks, JSON Lines records, CSV rows, YAML documents or lines; one
  unit larger than 64 KiB falls back to lines, then bytes, and says so.

The page shows Read (rendered Markdown with raw HTML disabled, CSV/TSV as a
text-only table, other formats as source text), Structure, Problems and Bytes.
The original download is unchanged.

## Verification

- `npx vitest run --project adapters src/documents`: hostile and edge inputs
  per format (big integers, duplicate keys, JSONL partial errors, YAML alias
  amplification and executable tags, XML entity and XInclude attempts,
  multiline CSV, formula-like cells, BOM, UTF-16 and Windows-1252, undecodable
  bytes, paging and segment alignment).
- `tests/acceptance/applications/structuredText.test.ts`: compiled CLI and real
  stdio MCP return identical Evidence with schemas valid in JSON Schema 2020-12.
- `tests/boundary/web/hosted.test.ts`: upload, structure pages, reading pages,
  exact downloads and 404s through the real worker.
- `node scripts/verify-hosted-catalog.mjs`: real Chrome at desktop and 390 px.
