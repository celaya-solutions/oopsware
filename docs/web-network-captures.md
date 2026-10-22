```text
Document:    Historical web network captures
Version:     v1.0.1
Author:      Celaya Solutions
Contact:     hello@celayasolutions.com
Date:        2026-10-13
SHA256:      c401559db13780936503acf8a78e9866b4b8024b69a763550256864204538f99
Chain:       solana-mainnet
Tx:          3Q1aobGUw2zGcajoBW3SNiFx15bWK5KoXeQRYzXWYMSMDLkiU41BaLoe2KwjyUVGGvNMRk6iUewjet9vxXYerb55
License:     All Rights Reserved / Celaya Solutions
```

# Historical web network captures

Use `inspect_web_network_capture` / `inspect-web-network-capture` to inspect
retained producer evidence. This is an offline operation: recorded URLs are
never fetched, and no browser or proxy listener is started.

```sh
oopsware inspect-web-network-capture /absolute/session.har har --json
oopsware inspect-web-network-capture /absolute/session.har har --record 2 --record 0 --json
```

```json
{
  "name": "inspect_web_network_capture",
  "arguments": {
    "capture_path": "/absolute/session.har",
    "format": "har",
    "record_ordinals": [2, 0]
  }
}
```

Omit ordinals to return every record. Explicit selection preserves caller order
and original zero-based producer ordinals; duplicate or out-of-range selections
are input errors. Every record is validated before selection, so selecting one
entry does not hide a malformed entry elsewhere.

For agent discovery over MCP, request `detail: "summary"`. REA retains the
complete selected Evidence in the session and returns identity and counts.
Use `normalized_result.parent_evidence_id` with `inspect_analysis_view`:

```json
{
  "source": {
    "kind": "retained-evidence",
    "evidence_id": "<parent_evidence_id>"
  },
  "view": { "kind": "capture", "detail": "preview", "offset": 0, "limit": 20 }
}
```

Preview pages select recorded HTTP headline fields, event names/times when
present, original locations and byte descriptors; they omit headers, XML and
payload content. Choose `detail: "complete"` in that view for exact record
pages, including all sidecars. Offsets follow the parent's selected record
order; producer ordinals remain unchanged. `total_records` counts the original
capture while `retained_records` and page coverage count records in the parent.
An exhausted page does not establish absence from unselected records.

Views do not reopen the file or rerun its decoder. They remain historical
Evidence if the source changes or disappears; inspect the capture again to
observe new bytes. The inspection tool's default `detail: "complete"` preserves
existing inline delivery. For CLI use, save complete inspection JSON and pass
it as inline Evidence to `inspect-analysis-view`; the same summary and capture
page contracts apply. Large complete records can still exceed MCP's response
budget; export the retained Evidence when a single record cannot fit.

If decoding completes before cancellation or private-root cleanup fails, the
failure retains the completed capture as Evidence with the requested record
selection and explicit sensitivity exclusions. Earlier decode failures remain
primary. Failed cleanup stays linked to its exact owner, including through
redaction, and its live status clears only after a confirmed retry.

## Formats and upstream profiles

HAR uses unchanged `har-schema@2.0.0` draft-06 schemas, `ajv@8.20.0`,
`ajv-formats@3.0.1`, `jsonc-parser@3.3.1` JSON visitor, and
`lossless-json@4.3.1` numeric representations, pinned in the npm lockfile.
Only the HAR 1.2 profile is supported. Unknown extensions remain reported
evidence. Duplicate object keys, including equal values and escaped spellings,
are rejected before materialization. Prototype-named members such as
`__proto__` are preserved as ordinary own JSON members without prototype
mutation. Original capture files remain unchanged.
The observed mitmproxy 12.2.3 `SaveHar` profile can emit `postData.text: null`
for a missing request body. Oopsware preserves that reported null, omitting the
optional field only from its validation copy for this exact producer profile;
it does not invent an empty string or body bytes.
The observed Playwright 1.58.2 profile can report a bracketed IPv6
`serverIPAddress`, forwarded from Chromium's `remoteIPAddress` through
[Playwright's HAR tracer](https://github.com/microsoft/playwright/blob/v1.58.2/packages/playwright-core/src/server/har/harTracer.ts).
REA preserves the original spelling in reported Evidence and removes brackets
only from its validation copy, only for this declared producer and a valid IPv6
literal. Invalid addresses, bracketed IPv4, ports and zone identifiers remain
validation failures. Producer declarations do not authenticate origin.

Native mitmproxy decoding requires a caller-supplied **mitmdump 12.2.3 on
Linux**. Set its absolute executable path:

```sh
REA_MITMDUMP_COMMAND=/absolute/mitmdump oopsware inspect-web-network-capture /absolute/session.mitm mitmproxy --json
```

Oopsware does not install mitmproxy. Its owned process uses a private configuration
directory, `--no-server`, and the unchanged upstream `mitmproxy.io.tnetstring`
decoder. It does not run `FlowReader` migrations or convert native states to
HAR. Raw IDs, state versions, flow types, backup states and unknown extensions
are preserved without synthesizing connections, timestamps or content. The
tested upstream source is tag `v12.2.3`, commit
`6c09d56e4c29a92f5ad01b03199977584b8ea14f`; other native tool versions return
an explicit unsupported-profile diagnostic. Non-Linux native decoding is not
supported by this adapter.

## Reading Fiddler captures (`.saz`)

Fiddler Everywhere saves traffic in **Session Archive Zip (`.saz`)** files.
Inspect native SAZ directly, without installing Fiddler or converting to HAR:

```sh
rea inspect-web-network-capture /absolute/session.saz saz --json
rea inspect-web-network-capture /absolute/session.saz saz --record 0 --json
```

MCP uses the same `capture_path`, `format: "saz"`, and optional
`record_ordinals` fields as the examples above. REA pairs `raw/<id>_c.txt`
requests, `_s.txt` responses, and `_m.xml` metadata by filename stem. Archive
member names identify the source; zero-based ordinals follow each session's
first member in ZIP directory order, not its numeric ID or capture time.

HTTP fields and ordered duplicate headers are retained, with stored body bytes
in binary sidecars. Bodies are not dechunked or decompressed. Metadata is an
XML node tree; optional `_w.txt` and `_g.txt` files retain opaque WebSocket and
gRPC message bytes. Missing members remain null, distinct from empty bodies.
See Telerik's [SAZ format reference](https://www.telerik.com/fiddler/fiddler-everywhere/documentation/knowledge-base/fiddler-archives).

## Protobuf and gRPC bodies

Selecting `record_ordinals` (CLI `--record`) also decodes retained bodies with
recognized protobuf or gRPC content types. Whole-capture inspection does not
perform this extra work. The original binary sidecar, SHA-256 and producer
ordinal remain the source; decoding adds flat body, frame and field facts.

Native gRPC admits only data-frame flags 0/1; gRPC-web additionally admits its
terminal trailer frame. `grpc-web-text` supports independently padded base64
chunks. Its offsets refer to **base64-decoded body bytes**; other offsets refer
to retained body bytes. Every field has a body-scoped `field_id` derived from
its byte offset, a `frame_index`, and a `parent_field_id` for schema-driven
nested messages or groups. Repeated field numbers remain separate occurrences.

Without a schema, varints and fixed-width values retain exact unsigned decimal
representations. Length-delimited UTF-8, nested-message and packed readings
are candidates; REA does not choose one or invent field names or signedness.
Nested candidate ranges remain accessible without recursively expanding them.
Malformed messages retain the parsed prefix and an exact error offset.
Compressed frames and encoded HTTP bodies remain unknown; they are not
silently treated as empty messages.

For schema interpretation, supply a local compiled `FileDescriptorSet` and its
fully qualified message type. All imports must be included. REA never fetches
schemas or executes the selected application. Descriptor identity and parser
version remain in the body facts. Scalars, repeated numeric packing and nested
messages are interpreted alongside the unchanged wire facts; disagreements
remain explicit. Map semantics, extensions and required-field validation are
unsupported. A supplied schema does not establish the sender's actual schema.
An invalid nested interpretation records `schema_status: "invalid-message"`
and `schema_error` locally; later outer fields remain available. Valid string
contents, including a leading U+FEFF, are preserved.

```bash
# Compile your own schema with your existing protoc, including local imports:
protoc --include_imports --descriptor_set_out=/evidence/api.pb api.proto
rea inspect-web-network-capture /evidence/session.har har --record 3 \
  --protobuf-schema /evidence/api.pb --protobuf-message example.Response \
  --detail summary --evidence_output /evidence/session-evidence.json --json
```

MCP accepts the same choices as `protobuf: {schema: {descriptor_set_path:
"/evidence/api.pb", message_type: "example.Response"}}`, with explicit
`record_ordinals`. Optional `body_pointers` batch-select exact binary pointers;
`framing` can explicitly select `raw`, `grpc`, `grpc-web` or `grpc-web-text`
when MIME metadata is unavailable. CLI exposes `--protobuf-body-pointer` and
`--protobuf-framing`. Filters never invent bytes excluded by source redaction. Decoding an extra
base64 layer also checks explicit exclusions; newly recognized trailer
credentials exclude the entire affected binary sidecar and its reported
encoding, preserving a redaction coordinate instead of a credential digest.
Credential inspection covers every selected body before descriptor reads or
field expansion. Later capacity or schema failures can therefore retain the
sanitized source even with explicit sensitivity options. If that source pass
is interrupted, unchecked bodies are not published as partial Evidence.
Framing overrides apply only to format-owned body coordinates and preserve
exclusions for the transport declared in MIME metadata.
Unknown or explicitly excluded HTTP coding metadata is not treated as absent:
SAZ/native bodies remain opaque until identity coding is established. Raw
header values and retained body bytes remain available in source Evidence.
Skipping wire analysis still runs the independent credential check. If HTTP
coding metadata is unavailable and that check cannot complete, the operation
returns unavailable without publishing unchecked capture bodies as Evidence.

Use `detail: "summary"`, then `inspect_analysis_view` with its retained parent:

```json
{"kind":"protobuf","collection":"bodies","offset":0,"limit":16}
{"kind":"protobuf","collection":"frames","record_ordinals":[3],"offset":0,"limit":16}
{"kind":"protobuf","collection":"fields","record_ordinals":[3],"field_numbers":[1,4],"fields":["number","schema_name","schema_value"],"offset":0,"limit":32}
```

Filters intersect; an empty filter selects nothing. Field pages also accept
`field_ids`, `frame_indices` and `schema_names`. Default field pages omit `text`,
`schema_value` and enum alias inventories; select these columns when needed. Identity, source offset
basis and body status survive column selection. Complete Evidence retains
all decoded values, and ordinary capture previews expose counts. Page exhaustion
covers retained facts only; a partial source does not establish absence.

Authenticated immutable parents reuse validation and the most recent field
filter per capture. These caches live only with retained Evidence, hold references
to existing facts and never reopen either file. Cached selector text is bounded
by retained field cardinality; larger selections use an uncached scan. Mutable
input is revalidated.
The existing 96 MiB report budget includes the original decoder reply plus
conservative charges for new facts, strings and descriptor expansion. The explicit
`protobuf_coverage` reports selected and inspected record counts, preserving
partial decoding through composed views. Capacity failure retains the source
observation as partial Evidence; cancellation yields
between bounded work batches. Real elapsed time and process-family memory
still depend on the selected capture and schema.

## Fiddler Everywhere MCP and public skills

For agent-driven traffic debugging, connect Everywhere's MCP server separately
from REA. Run a current Everywhere release with MCP access (Trial, Pro, or
higher), internet access, and a compatible MCP client. Use
**Settings > MCP Server > Coding agent**, or **Manual setup** with the generated
API key. The default endpoint is `http://localhost:8868/mcp`. See Telerik's
[MCP setup guide](https://www.telerik.com/fiddler/fiddler-everywhere/documentation/agent-tools/fiddler-mcp-server)
and [agent-skills prerequisites](https://www.telerik.com/fiddler/fiddler-everywhere/documentation/agent-tools/agent-skills).

Telerik's [public skills](https://github.com/telerik/fiddler-agent-tools) cover
installation (`fiddler-download-setup`), connection setup, and traffic analysis:

```sh
npx skills add telerik/fiddler-agent-tools --skill fiddler-mcp-setup
npx skills add telerik/fiddler-agent-tools --skill fiddler-traffic-debugging
```

After setup, reload the agent client and use the connected server's advertised
tool names and schemas. Check status, list sessions, then inspect relevant
session IDs. Set `sessionsSource` to `LiveTraffic` for HTTP(S) traffic or
`AgentCalls` for enriched LLM calls; active filters affect the session list.
For an existing run, skip the skill's pre-capture steps that replace process
filters and clear sessions. The documented MCP session sources do not provide
a saved-snapshot selector; use the SAZ workflow above for saved files. REA does
not register or wrap the Fiddler MCP server.

## Reading the evidence

- `artifact` identifies the caller-selected file and stable snapshot digest.
- `records` preserve producer order/ordinals and original JSON pointers, byte
  ranges, or SAZ member names. No live browser transaction or scenario IDs are invented.
- `reported` retains the producer's fields. HAR container metadata is returned
  separately, with `log.entries` replaced by `null` and `records_pointer`
  identifying the record collection. This is an inspection representation,
  not a reconstructed HAR file.
- `numeric_literals` preserve HAR number lexemes and native integer/float
  representations, including unsafe integers and non-finite native floats.
  Values that cannot be safely represented as JSON numbers are `null` in the
  reported view. Unsafe standard HAR numeric fields fail schema validation;
  unsafe extension numbers remain available through their sidecars.
- `binary_fields` retain exposed bytes, base64 and SHA-256 independently of
  declared sizes. Valid HAR `content.encoding: "base64"` is decoded exactly;
  producer-decoded Unicode text, missing text and unknown encodings do not
  establish original body bytes. Post-data parameters do not reconstruct a
  multipart body. Native byte fields also have an exact UTF-8 display view
  when valid; binary sidecars establish their actual representation. Native
  missing content and empty content remain distinct.
- `redactions` identify known transport authentication exclusions and explicit
  sensitive-value exclusions. Redacted byte fields retain neither original
  bytes nor their digest. Unknown extension names and token-looking query
  parameters do not establish sensitivity.

Mark sensitive literal string/UTF-8 byte values with MCP `sensitive_values`, or
repeat CLI `--sensitive-value`. These declarations are never persisted in
Evidence parameters; the count is retained. Explicit text/UTF-8 byte matches
exclude the entire field with a reported `null` rather than substitute a text
marker or rewrite payload bytes. This prevents replacement markers from
reintroducing declared literals. The file digest identifies the original artifact
unless it matches an explicit declaration; in that case `artifact.sha256` and
Evidence `subject` are null with an explanation. A sensitive property name excludes that
entire property and its sidecars; a `scope: "property-name"` redaction points
to its actual parent. No substitute property name or child pointer is invented.
Omitted subtrees are still validated, including canonical HAR base64. Explicitly sensitive artifact
paths are empty in Evidence and omitted from locations, while the original
SHA-256 and size remain available unless the digest itself is explicitly excluded. Failure messages, diagnostics and cleanup
resources follow the same explicit declarations without changing error types;
sensitive issue pointers identify a real ancestor instead of a fabricated
coordinate. Header/cookie authentication values and known
transport URL userinfo are excluded structurally, including native backups.
HAR redaction and API-surface projection share the same recorded-URL parser.
Canonical userinfo spans are removed without rewriting the remaining source
text. Credential-bearing spellings without a safe raw span, such as slashless
or extra-slash HTTP URLs, are excluded as a whole transport field. Ordinary
extension text and noncredential path/query values remain unchanged.

Generated free-text limitations follow the same literal declarations, including
global, per-record and Evidence explanations added during projection. Contract
field names, typed discriminators and exact decoder identities keep their
canonical meanings; declarations do not rename formats or providers.

Historical evidence does not prove runtime attribution, execution or deployment
authenticity. Mitmproxy messages are upstream-assembled messages, not recovered
wire fragments. Native dictionary duplicate keys have the unchanged upstream
decoder's last-value semantics; this adapter does not claim to recover discarded
duplicates or the original numeric spelling of parsed native floats.

## Derived API surface

Pass retained HAR Evidence to `inspect_analysis_view` with
`view: {"kind":"api-surface","offset":0,"limit":50}`. Omitted offset and limit
are 0 and 50. The view groups request lines by method, WHATWG URL origin and
path template, sorted by origin, template and method. Query strings, fragments,
credentials, headers and bodies are not copied into groups.

Select `include_query_parameter_names: true` in the view to include distinct
observed query names per group. The default and explicit `false` omit the
`query_parameter_names` field. Selected groups include an array of
`{name, record_ordinals}` entries, sorted by Unicode code point; each name's
ordinals follow the parent's selected record order and occur once per record.
For `/products?category=books&page=1` and
`/products?category=games&sort=price`, names are `category`, `page` and `sort`.
Query values and fragments are not copied into this inventory.

Names use WHATWG `URLSearchParams` form-query decoding: literal `+` becomes
space, `%2B` becomes `+`, percent escapes decode as UTF-8, and empty names are
retained. Empty query pairs are ignored. Original URLs stay in parent Evidence;
name decoding does not normalize the recorded paths used for grouping.
The inventory describes observed names, without inferring required parameters,
value types or a complete API schema. Sensitive-parent refusals still apply.

| Rule       | Exact segment format                                 | Placeholder  |
| ---------- | ---------------------------------------------------- | ------------ |
| `numeric`  | ASCII digits only                                    | `{numeric}`  |
| `uuid`     | RFC 9562 textual UUID, any version, case-insensitive | `{uuid}`     |
| `hex`      | At least 32 hexadecimal digits                       | `{hex}`      |
| `iso-date` | Valid calendar date `YYYY-MM-DD`                     | `{iso-date}` |

Rules apply in table order to the recorded, still-encoded request path, read
before WHATWG dot-segment removal, so `/a/%2e%2e/admin` and `/admin` stay distinct. Segment indexes start
at zero after the leading slash. Each matched segment lists its observed literals
and `basis: "inferred"`. `templated_groups` counts templated groups across every
page. Because paging follows the full grouping, every page is inferred Evidence
when that count is nonzero, and derived Evidence only when no group was templated. Version prefixes, short opaque IDs
and digit-bearing route names stay literal. Samples merge only when method,
origin, and exact segment rules match. The view does not infer further
cross-sample patterns.

Groups cite parent record ordinals and distinct statuses and MIME types (lowercase
type/subtype without parameters). An invalid type/subtype essence is unknown;
parameters do not affect this projection. Flags report single samples, mixed
statuses or mixed content types.
`coverage` pages groups; `records` separately reports examined, total and excluded
parent records. Ordinal subsets carry a limitation. Null URLs are excluded as
`url-redacted`; unparseable URLs, URLs without an origin, spellings without
`scheme://authority` (such as `https:host/path`), and authorities containing a
tab or newline as `url-unparseable`.
Unavailable request objects or methods are explicitly excluded. Unavailable
response fields, including HAR's `status: 0` and an empty `mimeType`, remain
unknown, not invented statuses or MIME types.

The view makes no handler-identity, schema or causality claim. It performs no
network activity. Native mitmproxy, SAZ and qlog captures return a typed unsupported error.
Parents inspected with `sensitive_values`, or whose Evidence does not record
`sensitive_value_count`, return a typed unsupported error whose reason is the
canonical token `sensitive_values_unretained`. The view would write path
templates and limitation text that it cannot check against declarations the
parent does not retain, so the refusal does not repeat declaration text.

One accumulator owns group identity, observed-value/status/MIME sets, ordinals,
exclusions and deduplicated limitations. It scans path spans without splitting
literal paths into arrays. Before schema parsing, it reserves the capture clone
and validation scratch by walking the parent without cloning it. Inline requests
borrow the Evidence value through CLI/MCP envelope validation; the application
admits the entire portable envelope before authenticated parsing or hashing. An
`evidence-file` source is read and authenticated first and then admitted like
retained Evidence, so its strings are not charged as inline envelope text: a
capture too large to project inline can be projected from its file. Before
authentication REA checks that live heap headroom holds its copies of the parsed
Evidence, and over MCP the read follows the request's cancellation.
An invalid Evidence file returns `EvidenceFileError` with the selected `path`
and `content_issues` relative to the file's JSON root; those locations do not
refer to the request's `source.path` string.
The envelope clone, hash scratch and capture clone stay charged during grouping.
Temporary URL/path/MIME/query work and retained state must
fit together within a 96 MiB projection representation budget. A whole group or
merge is admitted before allocating its retained sets, map entries or array
values. Fixed group storage, distinct text, exclusions and limitations count as
well as matched segments. Per-record reservations are released after each
record; repeated values do not accumulate another retained charge. Only the
requested page is materialized as output groups.
Opt-in query projection reserves parser tuples and the per-record name set
before decoding, then admits distinct retained names and source ordinals before
changing a group. Repeated names within a request retain that ordinal once.

The representation budget uses conservative storage and worst-case JSON-escaping
allowances; it is not an enforced V8 heap or process-memory limit. It is separate
from the decoder's actual reply-byte limit and MCP transport admission. Exceeding
it returns `resource_constraint` without a partial view. Limitations on the
parent envelope, capture and examined records are deduplicated onto the view.
Portable captures must retain unique ordinals within their declared total;
caller-selected subsets can preserve any requested ordinal order.

## Environment manifest

Pass retained HAR Evidence to `inspect_analysis_view` with
`view: {"kind":"environment-manifest"}` to project one application's recorded
request lines into a replayable tool surface: the environment manifest that an
agent environment later serves from retained Evidence. The view reuses the
api-surface grouping, then keeps the groups on the primary origin, the origin
with the most JSON-like records (`application/json`, `application/*+json`,
`text/plain`, `text/markdown`), whose path starts with `/api/` or `/apis/` or
whose content types are JSON-like. Every other group is listed under
`excluded` with reason `other-origin`, `ui-page-or-asset` or `non-json`, and
retained records without a usable request line are counted in a limitation.

The parent may instead be `capture_browser_scenario` Evidence whose scenario
selected response bodies or header values: each network transaction is then
one record, in request order, and the result names
`parent_operation: "capture_browser_scenario"` with an empty `artifact`, since
a scenario records no file. See
[agent environments](agent-environments.md#from-a-browser-scenario).

```json
{
  "name": "inspect_analysis_view",
  "arguments": {
    "source": { "kind": "retained-evidence", "evidence_id": "ev_..." },
    "view": {
      "kind": "environment-manifest",
      "template_rules": [
        "after-uid-literal",
        "opaque-token",
        "sibling-variance"
      ],
      "include_query_parameter_names": true
    }
  }
}
```

`origin` and `name` identify the environment; the name is the kebab-case
primary host with dots and ports replaced by hyphens, `grafana-example` for
`http://grafana.example`. Each tool carries a deterministic `name`, `method`,
`path_template`, `api_surface_template` (the four-rule template of its
earliest record), `params`, `query_parameter_names`, `body_shape`,
`statuses`, `content_types` and `record_ordinals`. `records` lists one pointer
`{ordinal, method, path, status, content_type}` per record a tool cites and
never a header, cookie or body. Tools sort by template then method.

Without `template_rules`, every `path_template` equals the api-surface
template and `params` carry the four format rules with names `id`, `uuid`,
`hash` and `date`; a repeated name gets a numeric suffix. Opt-in rules apply
only when listed, each at most once (a repeated rule is an `invalid_request`),
in this order:

| Rule                    | Applies to                                                                                                                                                                                                                                                                                                         | Parameter                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| `after-uid-literal`     | The literal segment right after a literal `uid`, unless it is a stop word                                                                                                                                                                                                                                          | `uid`                                                   |
| `opaque-token`          | A lowercase alphanumeric segment of twelve or more characters mixing letters and digits that is not a `v1`-style version                                                                                                                                                                                           | `uid`                                                   |
| `sibling-pair-variance` | Groups equal in method, origin and segment count that differ in two adjacent literals right after a plural literal at index 2 or later and followed by a literal, with at least three distinct pairs and both positions varying (`/repos/{owner}/{repo}/issues`); stop words and `v1`-style versions never qualify | singular plural literal plus `_namespace`, then `_name` |
| `sibling-variance`      | Groups equal in method, origin and segment count that differ in one literal at index 2 or later; the siblings whose literal is identifier-like (a digit or `:`, or three or more hyphenated names under a plural literal) merge, never a stop word, and the other literals stay their own tools                    | singular previous literal plus `_id`, else `id`         |

With `sibling-variance` selected, literal siblings within its comparison scope
fold into existing opt-in parameters as observed values unless they are stop words.
For example, select both `opaque-token` and `sibling-variance` so
`/api/folders/{uid}` lists `general` beside the recorded token. With only
`opaque-token`, `/api/folders/general` stays a separate literal tool.
A position templated by one of the four format rules
absorbs no literal, so `/api/teams/{numeric}` keeps its exact-format meaning
and `/api/teams/search` stays its own tool. Opt-in placeholders use the
parameter name; format-rule placeholders keep their api-surface spelling. Tool names are
`<method>_<literals>` with `api`, `apis`, `namespaces`, `default`, `v`-prefixed
version tokens and a `uid` literal before a parameter dropped, dotted literals
cut to their first label, `_by_<params>` appended when parameters exist,
sanitized to `[a-z0-9_]`, at most 60 characters and made unique with numeric
suffixes: `get_dashboards_by_uid`, `get_plugins_settings_by_plugin_id`.

`sibling-variance` and `sibling-pair-variance` compare routes of at most 32 segments; longer routes keep
their grouped templates and the manifest says so in a limitation. `body_shape`
is derived for `POST`, `PUT` and `PATCH` from the tool's earliest record when it
carries an `application/json` or `application/*+json` request body: top-level
keys and their JSON type names, never values and never nested structure; a body
on a later record adds nothing. `unknowns` always states three facts: the authorization model, response
semantics and state transitions are not established by a capture.
`templated_groups` counts tools and excluded groups with a templated segment;
whenever it is nonzero the Evidence is inferred, otherwise derived. The view
performs no network activity and replays nothing. Native mitmproxy, SAZ and
qlog captures, and parents inspected with `sensitive_values`, return the same
typed unsupported errors as the api-surface view, including the canonical
token `sensitive_values_unretained`. A `capture_browser_scenario` parent is not
refused for declaring secrets: the capture redacted them as it recorded, a
transaction whose URL was redacted is left unrepresented, and a response body
keeps the capture's redaction markers, which a manifest limitation counts.

The manifest accumulator shares the api-surface admission model: the capture
clone, the inline envelope (for an inline source), record pointers, groups, every route part, observed
values, query names and body-shape keys are admitted before allocation, and each
recorded body is charged as temporary bytes before it is parsed. Retained state and
temporary work must fit together within the 96 MiB projection representation
budget; exceeding it returns `resource_constraint` without a partial manifest.
Name a large capture with `{"kind": "evidence-file", "path": "/abs/capture.json"}`
rather than inline: response bodies the manifest never reads are then charged
once per value in the capture clone, not per character. A
`capture_browser_scenario` parent is also charged, before validation, for
checking its largest body and for the decoded text of its request bodies.

## Environment state

Pass the same parent to `inspect_analysis_view` with
`view: {"kind":"environment-state"}` to extract the initial state the
capture's reads observed, and a render plan per read tool that reproduces those
reads from it. Where the environment manifest names an application's tools, the
state holds its data: entities by type and identity, plus documents for written
paths whose reads are not entities. Use the `template_rules` of the manifest the
state accompanies so tool names match; the view groups records the same way.

```json
{
  "name": "inspect_analysis_view",
  "arguments": {
    "source": { "kind": "retained-evidence", "evidence_id": "ev_..." },
    "view": {
      "kind": "environment-state",
      "template_rules": [
        "after-uid-literal",
        "opaque-token",
        "sibling-variance"
      ]
    }
  }
}
```

Records on the primary origin are ordered by recorded start time, or by record
order when any start time is missing (`timeline`), as for a
`capture_browser_scenario` parent. A `POST`, `PUT`, `PATCH` or `DELETE` with a
2xx or 3xx status, or no status, may change state, unless it is a `POST` whose
path has a segment such as `search`, `query`, `list`, `find`, `fuzzy`,
`count` or `stats`, which queries state instead. A type's state comes from its
successful reads that finished before the first such write under the same root:
the path's API base (the literal segments every tool sharing its first segment
has), any `v1`-style version segments, then one more segment. A read that
overlaps that write in time is left out. A write whose URL a scenario redacted
has an unknown target, so it ends the state of every type, and a limitation
counts such writes. Values from a `capture_browser_scenario` parent keep the
capture's redaction markers in place of declared secrets; the state is not
refused for them, as the manifest is not.

Each `GET` tool whose template ends in a parameter is an item tool, and its
type's `collection_template` is the template without that parameter; any other
`GET` tool is a list tool of its own template. An item tool proves its type's
`id_field` when every initial response carries the requested path value in the
same field, at the root or in one wrapper member (`id_basis: "path-parameter"`).
Otherwise the field is the first of `id`, `uid`, `uuid`, `_id`, `ID`, `UID`,
`Id`, `guid`, `key`, `slug` and `name` that every listed item carries as a
distinct string or number (`id_basis: "field-name"`). A list is the response
array, or the one array of objects in an envelope that is not itself an entity.

`entities` merge every initial observation of one identity within one
collection path: an item view's latest values win over a list view's, a view
whose latest values differ keeps them in `view_fields`, and a field whose value
changed between one tool's observations with no recorded write between is named
in the type's `volatile_fields`, keeping the latest value. A value that changed
across a write under another root may be that write's effect, so every tool of
its type is a recorded view with reason `fields-differ`; so is a value one tool
read before a write and another tool read after it. Repeated reads of one full request line also keep the type recorded when list membership changes across a write, including transitions to or from an empty list, or when entity fields are added or removed. Different query strings remain distinct request lines. Sparse responses do not erase the last observation of a field supplied by another request line. Entities are ordered
by type, collection and first sighting; that order is a list's state order.
Every entity cites its `record_ordinals`.

`views` lists one plan per read tool in tool order:

| Shape      | Plan                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `item`     | The entity object at `pointer` (the root or one member), the ordered `fields` the view shows and the `required_fields` every recording had, and `envelope_ordinal`: the recording whose response, with the entity replaced, every item response shares                                                                                                                                                                                                                                                                      |
| `list`     | The array at `pointer`, its `fields`, `membership` (`all`: every entity of the collection in state order, when each recording listed exactly that, had no query, no item-total member (`total`, `count`, `totalCount`, `item_count`, `totalcount`, `itemcount`, but not `total_pages` or `per_page`; a number or a string of digits) differing from the number listed, and no `has_more`, `next` or next-page token member set; `recorded`: the entities each recording listed) and `counters` that equal the number listed |
| `document` | The path's latest initial value, held in `documents`                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `recorded` | A `reason` the tool replays its recordings instead                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

An item or list plan is kept only when it reproduces the latest initial
recording of each request line from the state, comparing JSON values without
regard to member order; a volatile field compares its recorded value. Each
plan lists the `checked_record_ordinals`. Otherwise the tool is a recorded view
with reason `envelope-varies`, `fields-differ` or `list-differs`; the other
reasons are `query-body` (a query `POST`), `no-init-recording`,
`body-unusable`, `not-entity`, `no-identity` and `query-varies` (a document
read under several queries). Documents are held only for list-shaped paths
that a `POST`, `PUT` or `PATCH` tool writes: a non-entity read of an item path
such as `/api/files/{id}`, or of a path that is only deleted, stays recorded
with `no-identity` or `not-entity`. A body is usable when its content type is
JSON-like, it is UTF-8 text of at most 256 KiB, every number survives native
conversion exactly, and no member is named `__proto__`.

Values in the state are recorded data, so the view refuses the same parents as
the manifest, including those inspected with `sensitive_values`, and a
`capture_browser_scenario` parent must have selected response bodies. Types and
identity are inferences, so the Evidence is always inferred. `unknowns` states
that the state establishes no authorization model, no way the application
computes responses or derived values, and no effects of writes. The state
accumulator charges the manifest's admission and grouping, every record line,
each body as temporary bytes before it is decoded and parsed, and every value
it keeps, within the same 96 MiB budget. The view performs no network activity
and serves nothing.

## Resource and lifecycle boundaries

Complete evidence has a 32 MiB input, 96 MiB decoder reply and 64-level nesting
budget. Exceeding a budget returns no partial success.
Oversized selected captures return an input error identifying `capture_path`
and the byte budget; owned reply/output failures remain output or provider errors.
HAR, SAZ and qlog run in an owned
192 MiB Node old-generation heap with one V8 worker. Mitmproxy decoding applies
Linux limits of 768 MiB address space, 30 seconds CPU and 96 MiB file output;
both commands have a 30-second wall deadline and independently supervised
process cleanup. Owned decoder diagnostics retain at most 1 MiB across stdout
and stderr; the collector drops overflow as it arrives, reports the limit
failure and verifies cleanup. Heap limits alone do not establish aggregate RSS limits.
SAZ and qlog refuse decoding when neither a Node heap limit nor a Windows Job Object bound can be enforced. Existing HAR availability is preserved.
When REA runs on Bun, the HAR/SAZ/qlog decoder runs on Bun, which ignores these V8 heap
flags; its limitations and resource failures then omit the heap sizes. On
Windows, the decoder's owned Job Object instead limits its committed memory to
704 MiB, the 192 MiB budget plus a 512 MiB reserve for Bun itself. The
limitations state that limit, and reaching it returns `resource_constraint`
with `process_memory_limit_bytes`, whatever exit status Bun reports.

Observed decoder memory exhaustion returns `resource_constraint`, with the
selected capture, applicable limits and retained process diagnostics. HAR/SAZ/qlog's
old-generation heap is fixed; inherited `NODE_OPTIONS` cannot raise it.
Record selection happens after complete decoding and does not reduce that
workload. Use a smaller capture exported by its producer or another decoder
with sufficient capacity, retaining the original for provenance. Subsets do
not establish complete-capture coverage. Repeating the same workload or
running provider health diagnostics does not resolve the heap constraint.

Stable regular-file reads reject symlinks, replacement and concurrent changes.
Private snapshots, declarations and tool configuration are removed before the
result returns. Cleanup uncertainty retains the selected capture, resource and
original failure information. The original capture is never changed.

## Excluded coordinates and read failures

Explicitly marked values also exclude matching source coordinates and their sidecars. A hidden record coordinate is reported as `location.kind: "unknown"`; Oopsware does not invent a replacement pointer. Original record ordinals and artifact digests remain available.

Host filesystem read denials return `code: "access_denied"`, `category: "unavailable"`, the actual `EACCES`/`EPERM` code and read-access guidance. Missing files remain input failures. Cleanup failures retain the prior structured error, including its input constraints or provider diagnostics, with explicitly marked text excluded.

An observed replacement or in-place change during stable artifact acquisition
returns `code: "artifact_changed"`, `category: "integrity_mismatch"` and
`retryable: true`, retaining the selected path and reader's reason. Wait until
the capture file is stable before retrying. No unstable snapshot is decoded.
Command cleanup failures retain the original status and both diagnostic streams;
the decoder's ownership preparation receives the same cancellation signal.

MCP advertises the same strict named input contract used by the application. Historical inspection delegates argument validation to that shared application boundary so accepted explicit-sensitive declarations also cover invalid argument names and other correction details. The SDK receives raw arguments through its Standard Schema interface; malformed inputs still fail before decoder or filesystem effects and return the normal structured Oopsware error. Protocol-envelope validation remains owned by MCP.

## Retained aioquic qlog

Select `format: "qlog"` through `inspect_web_network_capture`, or:

```bash
rea inspect-web-network-capture /absolute/origin.qlog qlog --json
rea inspect-web-network-capture /absolute/origin.qlog qlog --record 95 --record 0 --json
```

The initial profile is **aioquic 1.5.0, JSON qlog 0.3**: one JSON object with
`qlog_format: "JSON"`, `qlog_version: "0.3"`, `traces` containing object events
with `name`, finite numeric `time` and object `data`. JSON-SEQ, JSONL, columnar
array events and other versions are unsupported. Duplicate JSON members,
malformed UTF-8, invalid interpreted QUIC integers and excessive nesting fail
without partial success, including in events outside the selected ordinals.
Well-formed event subsets and missing frame metadata remain inspectable.
Unknown extensions are retained; this is not validation of every qlog schema.

Choosing the format selects the interpretation profile; the file does not
necessarily report or authenticate an aioquic version. The profile's clock
uses Unix-epoch milliseconds, verified in aioquic 1.5.0's `QuicLoggerTrace`
`log_event`/`encode_time`. The `qlog.clock.basis` and Evidence analysis profile
state that assumption explicitly. Numeric lexemes survive independently of
safe JSON-number projections; decimal spelling does not establish physical
clock precision or monotonicity.

Every event has a global ordinal from trace/event source traversal and its
original `/traces/T/events/E` pointer. This order is not a global time sort.
Trace index and the selected artifact identify a connection observation;
reported ODCID is preserved without claiming global uniqueness. Streams are
scoped by trace, stream ID and sent/received direction. Control/QPACK streams
are retained, so counting streams does not count HTTP requests.

`qlog` is a typed facet required exactly for this format. Its scope is
`all-recorded-events-before-selection`: selection changes returned event
records while facts cite the original ordinals across the entire recorded
file. The container retains trace metadata with each events array replaced
by null; there is no single events pointer shared by all traces.

| Fact                                | Basis and limits                                                                                                                                                                                                                                                              |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Original event and loss declaration | Observed endpoint report; `recovery:packet_lost` does not prove actual network loss. Missing packet number/type remains unknown.                                                                                                                                              |
| STREAM ranges and byte totals       | Derived per trace and direction from reported offsets and lengths using exact integer arithmetic. `unique_bytes` unions intervals; `frame_length_sum` includes overlaps; `repeated_bytes` is their difference. Overlap alone does not prove retransmission or equal contents. |
| FIN final sizes                     | Reported offset plus length where FIN is true; multiple conflicting sizes remain visible. A final size does not establish complete coverage or a received body.                                                                                                               |
| Incomplete fact records             | Ordinals with omitted/redacted interpretable frame metadata; usable fields in other records survive. An empty list does not establish complete logging or capture.                                                                                                            |
| HTTP bodies and causality           | `body_bytes: "not-reported"`; lengths and headers are metadata, with no reconstructed body, hash, timing causality or live process attribution.                                                                                                                               |

QUIC integer fields interpreted here accept exact nonnegative JSON integer
values through `2^62 - 1`, including equivalent exponent notation. Offsets plus
lengths must fit that range. Derived sums are decimal strings and are not
rounded to JavaScript numbers. A missing offset is unknown, never defaulted to
zero. Ranges can start above zero or contain gaps. Packet headers, HTTP events,
raw lengths and unknown extensions remain producer evidence rather than being
normalized into invented HAR requests.

The adapter excludes authorization/proxy authorization/cookie/set-cookie
values in known HTTP frame events, reset tokens in transport parameters and
NEW_CONNECTION_ID frames, and NEW_TOKEN frame tokens. Known URL header userinfo
and explicit sensitive values follow the shared exclusions. Ordinary extension
fields and token-looking query text remain retained. Explicit declarations also
cover normalized numeric projections, derived totals and trace pointers; facts
that cannot be safely shown are omitted with incomplete-record coordinates.
No keylog, PCAP, live URL or recorded target is opened by the qlog decoder.

To repeat the real-provider lane with **local caller-supplied evidence** from
the educational aioquic 1.5.0 experiment (one origin trace, known 32,803-byte
stream coverage and one 1,169-byte repeated range in the loss case):

```bash
npm run verify:web:qlog -- /absolute/control/origin.qlog /absolute/loss/origin.qlog /absolute/new-report.json
```

This lane checks built CLI/stdio MCP parity, SDK-converted JSON Schemas,
artifact digests, original event count, selection scope, retained parent lookup,
credential exclusions and the known control/loss facts. The report is created
exclusively and contains no keys or captured credential values. It is a
fixture-specific verification, not a general loss detector. CI uses synthetic
format inputs for malformed cases and limits; those tests do not establish
producer provenance. PCAP parsing and correlation remain outside this stage.

### Focused qlog views

Use MCP `inspect_web_network_capture` with `format: "qlog", detail: "summary"`
for identity, profile, scope and retained-fact counts. Then pass its
`normalized_result.parent_evidence_id` to `inspect_analysis_view` as a
`retained-evidence` source.

```json
{"kind":"qlog","facet":"traces","offset":0,"limit":10}
{"kind":"qlog","facet":"streams","trace_index":0,"offset":0,"limit":10}
{"kind":"qlog","facet":"contributions","trace_index":0,"stream_id":"0","direction":"sent","offset":0,"limit":20}
```

Trace pages omit nested lists and give their counts. Stream pages preserve
exact byte totals but omit contributions, ranges and final-size lists. For
those lists select `contributions`, `ranges` or `final-sizes` with all three
stream selectors. `loss-declarations` and `incomplete-records` need only
`trace_index`. Offsets count rows in that retained facet; defaults are 0 and 64. Missing or ambiguous selectors fail rather than choosing a connection.

These views page already interpreted facts without decoding again or opening
the source, and work after its deletion. Facts still cover all recorded events
before parent record selection. Their exhaustion does not prove logging or
network completeness. Event preview/complete pages remain available through
kind `capture`, with original numeric lexemes and producer ordinals preserved.
