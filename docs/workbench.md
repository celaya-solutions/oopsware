```text
Document:    Oopsware Workbench Projects, Graphs and Reports
Version:     v1.2.1
Author:      Celaya Solutions
Contact:     hello@celayasolutions.com
Date:        2026-10-22
SHA256:      61fa7f37c757c971215ad22f1b2824ad126b186339e1635fa6844d73bac9cddf
Chain:       solana-mainnet
Tx:          2yRhvWtBksuHSjYWGznp2hYN4a4cafsosBqSjwsZsQvDHbfLDoHneKdC6qNcd8SHxC9phV1K9EJpw4dsDXoCpXRY
License:     All Rights Reserved / Celaya Solutions
```

# Workbench: projects, graphs and reports

The local dashboard (`node scripts/oopsware.mjs web --port 4097`) keeps your
work in **projects** and draws graph results as pictures. One-click reports
build on them and land in the last step of the same roadmap item (README roadmap item 6). See the [roadmap](roadmap.md) for remaining work.

## Projects

A project is a named folder of work: the files you looked at, your notes,
bookmarks and names, and links to the runs behind them. It lives on disk and
comes back after a restart.

- **Projects** in the sidebar lists them, newest first. Name one to create it;
  it opens right away. The header shows the open project; click it to return.
- While a project is open, every tool you run from that tab is linked to it.
  The file each run looked at is added to the project's **Files**. A run that is
  still going when Oopsware stops is settled the next time the project opens;
  a run whose saved record is gone is listed as **Run archive not found**.
  When a finished run's file or changes cannot be added (a full project, for
  example), the run is still linked and says why.
- **Add to project** on the selected file adds it by hand. Files are hashed
  with SHA-256 when added; folders and app bundles are not hashed, so their
  identity is shown as unknown.
- **Notes** take plain text (up to 64 KiB each) and can point at a file and an
  address. **Bookmarks** are a label at a place. **Names** are a new name for an
  address in one file.
- Click a linked run to read its result inside the project. **Open in
  Results** appears when the run belongs to the current tab.

### Names, comments and bookmarks made in a native session

When one of these tools succeeds while a project is open, its change is copied
into the project: `set_address_name`, `set_addresses_names`, `set_comment`,
`set_inline_comment`, `set_bookmark`, `unset_bookmark` and
`annotate_native_function`.

- Only changes the provider confirmed are copied. A `false` readback copies
  nothing; for `set_addresses_names` only the addresses that held are copied.
- One item per file, provider, address and kind. Doing the same change again
  replaces it instead of adding a copy. An empty comment, or an
  `unset_bookmark` that held, removes the item.
- Each copied item remembers the run, the provider and its version.

### Apply to session

Ghidra's analysis database is temporary, so names vanish when its session
closes. **Files → Apply to session** puts a project's names, comments and
bookmarks for one file back into the open session, as ordinary runs you can
see in the history.

It only runs when the open session is the same file (same SHA-256) in the same
provider the items came from; addresses can differ between tools. It refuses
with a plain reason otherwise. Ghidra stores names but not comments or
bookmarks, so on Ghidra those are skipped and counted. When both the items
and the session record their analysis settings (profile), those must match
too.

### Where projects live and their limits

Each project is one folder under `~/.config/rea/web/projects/<id>/`:
`project.json` (owner-only, replaced atomically) and `project.json.bak` (the
previous good copy). A damaged `project.json` opens from the backup and the
list marks it **Recovered**. Saved reports will go in `reports/` beside them.

| Per project | Limit          |
| ----------- | -------------- |
| Notes       | 2,000          |
| Bookmarks   | 5,000          |
| Names       | 20,000         |
| Linked runs | 10,000         |
| Files       | 200            |
| Title       | 200 characters |
| One note    | 64 KiB of text |

A change past a limit is refused, never cut short. Two tabs editing one
project do not overwrite each other: the later save is refused, the project is
reloaded, and additions are retried once.

Projects read only the saved run records, which are already redacted when
written, so values marked sensitive never reach a project. Projects are
dashboard-only for now; there are no project CLI or MCP tools.

## Graphs

A run whose result holds a graph gets a **Graph** section above its result,
in Results and in a project's linked-run view. Graphs come from:

| Tool                                                                                                                      | What is drawn                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_call_graph`                                                                                                          | Each procedure the walk reached; edges point caller to callee in both directions (a `backward` walk stores callers in `calls`). Per-node coverage and errors are in the node panel. |
| `procedure_callers`, `procedure_callees`                                                                                  | The queried procedure and its direct callers or callees.                                                                                                                            |
| `trace_call_path`                                                                                                         | Visited nodes, direct-call edges, start and goal; goal status, residual unknowns and truncation are listed as limits.                                                               |
| `build_call_path`                                                                                                         | Every shortest path, merged by address.                                                                                                                                             |
| `project_android_application_graph`, `project_apple_application_graph`, `project_harmony_application_graph`               | Application, then component groups, then components. Each bridge candidate is a dashed edge labelled with its basis. Unavailable components are listed, not drawn.                  |
| Any result holding a `JavaScriptApplicationGraph` (the JavaScript application tools, `project_managed_application_graph`) | Its nodes and edges as given; a result with several gets a picker.                                                                                                                  |

Above the picture: the fixed sentence "Edges show what the tool observed. A
missing edge is not proof that no call or link exists.", the drawn and
hidden counts, every limitation the tool reported (each line once), and its
coverage as reported.

- At most 300 nodes are drawn. A bigger graph shows nodes from the roots
  outward until the limit and says how many nodes and edges are hidden.
  Hidden is never shown as absent.
- Drag to pan, wheel or buttons to zoom, **Fit** to view. Click a node for
  its kind, address, id, evidence ids and observations.
- **Find** by label or address; picking a match focuses on it. Depth (1 to 5)
  and direction (callers, callees, both) set the focus; **Show whole graph**
  clears it. Node kinds and edge relations can be filtered out.
- **List** shows the drawn nodes and edges as tables. It is the keyboard path
  and the default on narrow screens.
- **Bookmark** and **Add note** in the node panel save to the open project,
  anchored to the node's address, else its symbol, else its path inside the
  container, else the graph node id and label. Without an open project they
  are off and say why.
- **Download SVG** saves the drawn picture. Reports will embed the same SVG.

The layout is a small layered layout of our own (`src/domain/graph/`), not a
library: it is pure, deterministic (same input, same picture) and adds no
runtime dependency. A dense 300-node graph lays out in about 0.1 s.

## Reports

A report is one file you can hand to someone: what the runs found, the
evidence behind it, and what could not be established. It shows only what the
runs delivered; it adds no analysis and never calls anything "safe" or
"clean".

- **Project report**: open a project and press **Report** (or the
  **Reports** tab). Every completed run is ticked; untick what you leave out
  (the cover counts them). Failed, cancelled and missing runs are always
  listed among the limits. Saved reports are listed there with **Open**,
  **Download** and delete.
- **One-run report**: **Report this run** (HTML) or **PDF** next to a run in
  Results or in a project's run view. It downloads and is not saved.

Sections, in order: cover (title, time, Oopsware version, description),
targets (name, path, size, SHA-256, format, and a fresh check: same, changed
or missing; folders and bundles are not rehashed and say so), summary (runs by
status, tools with their plain names, limit count), notes/bookmarks/renames,
findings (one block per run: inputs as stored, status and timing, headline
facts = the top-level values of the result, the graph picture when there is
one, the run's own limits box, evidence ids with provider and version), **What
this report could not establish**, and an appendix with each run's complete
stored result (4 MiB per run, 128 MiB per report; past that the line says how
many bytes were left out and where the full run record is).

**Limits are collected generously.** The Evidence envelope's `limitations`
and `relationship_coverage` are read by schema; every other field named
`limitations`, `unknowns`, `residual_unknowns`, `coverage`, `omissions`,
`diagnostics` or `warnings` (or ending in `_<one of those>`) is shown
verbatim with its JSON path, labelled "collected by field name". Showing too
much is accepted; missing one is not. Empty fields are skipped. The sweep
stops after 200,000 values and says so.

**HTML** is self-contained: inline CSS, a system font stack, no script, no
remote fetch, CSP `default-src 'none'; style-src 'unsafe-inline'; img-src
data:`. Every value is escaped and direction-override characters are
replaced. **Open** goes through a one-time link (`/report-view/<ticket>`,
one minute, one use) so the page is served with its own policy rather than
the dashboard's.

**PDF** prints that same HTML with an installed Chromium-family browser
through `playwright-core`: JavaScript off, every request refused, a throwaway
profile, a 60-second limit. The browser is `REA_BROWSER_EXECUTABLE` when set,
otherwise Google Chrome, Chromium, Microsoft Edge or Brave at their usual
install paths (macOS `/Applications`, Linux `/usr/bin`). Oopsware installs no
browser; without one the PDF choice is off and says why (print the HTML
instead). A PDF leaves out the JSON appendix unless you tick **Include the
JSON appendix**, and its cover says so.

Reports read only stored run records, which are redacted when they are
written, so sensitive inputs never reach a report. Saved reports live in
`~/.config/rea/web/projects/<id>/reports/` (owner-only), at most 1,000 per
project, and are removed with the project. There is no CLI or MCP tool for
reports.
