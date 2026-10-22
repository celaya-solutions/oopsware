```text
Document:    Website observation with CDP
Version:     v1.0.1
Author:      Celaya Solutions
Contact:     hello@celayasolutions.com
Date:        2026-10-13
SHA256:      164999f8e610b6c00d086f3fcc8c76cb8b54eb19bd3a77b04c1d04679491142a
Chain:       solana-mainnet
Tx:          4QTmSR73KGCwDNPS6CDzkzt2EJgEyfDE6d2YRevx7dPRQ7EythKaKKLX1Wun5FrywK1zQqSxErYsfzSFWKUUBgBb
License:     All Rights Reserved / Celaya Solutions
```

# Website observation with CDP

Captured Debugger sources can be exported for Oopsware's existing static JavaScript
analysis with `export_web_scripts`. See [captured website scripts](website-script-export.md)
for the capture options, source mappings, and browser/local resolution limits.
Use [captured module relationships](website-module-trace.md) to resolve one
exported script's native imports under an explicit URL/import-map context.

Oopsware can attach to a user-owned Chrome-family browser through the Chrome DevTools Protocol (CDP) and produce bounded Evidence about an existing page. This is a passive reverse-engineering capability, not a general browser automation or remote-control surface.

For request/response bodies and traffic debugging, see
[Fiddler Everywhere captures and MCP](web-network-captures.md#reading-fiddler-captures-saz).
Inspect native SAZ or HAR 1.2 offline with REA, or connect Everywhere's separate MCP server.

## Shipped surfaces

- `list_browser_targets` / `oopsware list-browser-targets` discovers all eligible page targets at the endpoint by default, with an optional exact-origin filter.
- `inspect_web_page` / `oopsware inspect-web-page` captures DOM structure, accessibility nodes, scripts, resources, safe response/DOM metadata, attach-window network and console metadata, WebSocket frame sizes, workers, quota, and optionally selected storage key names, redacted storage-content fingerprints, or script sources.
- `analyze_web_bundle` / `oopsware analyze-web-bundle` parses selected script artifacts without execution and derives chunk edges, route and endpoint candidates, vendor fingerprints, static WebMCP declarations, and optionally source-map/original-source evidence.
- `observe_web_session` / `oopsware observe-web-session` arms an observation window of the requested duration for an external user action and records ordered reload, SPA navigation, redirect, failure, lifecycle, and target-termination metadata.
- `discover_webmcp_tools` / `oopsware discover-webmcp-tools` uses the experimental CDP WebMCP domain to return every in-scope registration and its complete observed `input_schema` declaration and canonical `input_schema_sha256` digest inline. Declarations are untrusted JSON data, including declared types, required fields, enums, examples and reference URLs. Oopsware does not resolve schema references. These fields replace `input_schema_shape`. Registrations with the same name and URL in distinct observed frames retain separate identities. `tool_key` includes the observed frame ID; it is not a stable identity across navigation or browser sessions. Same-frame registration updates replace that owner only, and removal leaves other owners intact. Declared `readOnly`, `untrustedContent`, `consequential`, and `autosubmit` annotation hints are reported per registration: `true`/`false` are declared values, `null` means the declaration did not provide the hint in that capture, and a missing `consequential` key means the hint was not recorded, either in a historical capture or because the observed annotation was invalid. Consult discovery completeness and exclusions to distinguish these cases. Malformed annotation values retain the registration with incomplete coverage and an `invalid_protocol_value` exclusion. Other malformed protocol payloads can fail discovery explicitly. Oopsware never exposes `WebMCP.invokeTool`.
- `compare_web_captures` / `oopsware compare-web-captures` compares passive captures or exact-step-aligned browser scenarios. Scenario results commit reproducible literal normalization and expose alignment failures plus artifact-level action, screenshot, DOM, accessibility, URL, history, storage, and event differences. Missing or truncated evidence is never treated as equivalence.

Passive DOM comparison checks complete node inventories and complete frame
parent/child structure independently. Frame IDs and sibling enumeration order
are capture-local and do not establish a change; duplicate IDs, missing parents,
and cyclic ancestry remain unknown. A complete frame difference can still prove
change when DOM nodes are incomplete, and vice versa. Partial DOM or metadata
collection digests do not prove modification: a missing node or link can result
from a protocol omission. Rejected DOM facts also mark derived URL and agent-hint
metadata incomplete, while valid facts from other nodes and documents remain
available in the capture.

- `capture_web_screenshot` / `oopsware capture-web-screenshot` returns a content-addressed visible-viewport PNG.
- `compare_web_screenshots` / `oopsware compare-web-screenshots` performs bounded local PNG pixel comparison without OCR or external services.
- The CLI comparison commands accept each capture, screenshot artifact or normalization policy as inline JSON or a JSON file path. Use files for screenshot artifacts and scenario captures, whose embedded PNG bytes can exceed the host's command-line length limit.
- Every surface has equivalent CLI and MCP contracts and returns Evidence provenance.
- MCP tools return complete results inline and include the Evidence ID. Session evidence can be exported with `export_evidence_bundle`.

Target discovery returns the complete in-scope target array in one result.

## Screenshot comparison memory budget

`compare_web_screenshots` admits both PNGs against a 256 MiB estimated
working-memory budget before inflating either image. This is a processing
buffer budget for this operation, not a PNG dimension limit, CDP transport
limit, or process RSS guarantee. Header-valid dimensions that exceed the
budget return `resource_constraint` with `details.resource: "memory"` and the
estimated and maximum working-set bytes. Invalid PNG structure remains
malformed input; encodings outside supported pixel-comparison coverage remain
unsupported-target errors.

The conservative estimate includes the two decoder-owned decoded input
buffers, the current image's concatenated IDAT buffer, Node zlib's default
16 KiB output chunk backing rounded up for retained chunks, the concatenated
inflate result while its output chunks are retained, one possible extra output
chunk before zlib checks `maxOutputLength`, unfiltered scanline storage,
RGB-to-RGBA expansion, and the first retained RGBA image while the second is
decoded. RGBA output aliases its unfiltered buffer and is counted once.
Admission uses checked integer arithmetic before image-sized allocation.
Caller-owned JSON/base64 strings, input parsing and validation, transport
buffers, garbage-collector behavior, and other runtime memory are outside this
estimate; the budget does not promise a bound on total process memory.

Electron `file://` pages use a separate provider and target boundary; see [electron-observation.md](electron-observation.md).

## Provider authorities

CDP page capture and V8 Inspector observation attach to an already-running
target without launching it, driving actions, or evaluating target code.
Playwright scenarios drive actions and capture step snapshots in either a
provider-owned browser or a caller-selected external browser. Separate providers
preserve these authority and lifecycle differences. They share one exclusion
vocabulary (`BrowserExclusionReason`): every denial reason maps onto it, even
where a wire schema keeps a narrower historical bucket.

CDP attachment is not a guarantee that the browser preserves all state.
Chromium can clear another client's `navigator.platform` emulation when REA's
page session disconnects, even if that session sent no emulation commands.
This affects page inspection, bundle capture, session observation, screenshots,
WebMCP discovery, and Electron page inspection; target listing alone does not
attach a page session. REA cannot read the other client's complete
user-agent/client-hint configuration and does not replay guessed settings.
Use a disposable browser when preserving externally configured emulation is
required, or have the owning client reapply its complete configuration afterward.
See [the reproduction and Chromium ownership limitation](https://github.com/morluto/rea/issues/4089).

Existing static application Evidence and passive web/Electron captures can be
combined later through
[JavaScript static/runtime reconciliation](javascript-runtime-reconciliation.md).

## Start a browser

Start a separate browser profile with an explicit debugging port. The exact executable name varies by platform and installation:

```bash
google-chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/rea-browser-profile \
  http://127.0.0.1:3000
```

Oopsware does not launch, own, or terminate this browser. Use a dedicated profile and stop it yourself when the investigation is complete. Do not expose the debugging port on a non-loopback interface.

Other Chromium-family browsers, such as Chromium or Brave, work the same way
with the same two flags. On macOS, run the executable inside the application
bundle, for example
`"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"` or
`"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"`. Fedora installs
Chromium as `chromium-browser`.

REA needs the browser's HTTP discovery endpoint on a loopback port. A browser
driven over `--remote-debugging-pipe` or a private channel, for example by an
automation SDK, exposes no such endpoint, so `list_browser_targets` has nothing
to attach to. Connection failures report `endpoint_unreachable`; a reachable
HTTP service that returns a non-200 or non-JSON discovery response reports
`invalid_endpoint_response`.
Reproduce that flow in a Chromium-family browser started with
`--remote-debugging-port`.

In a minimal Linux container, headed Chromium under Xvfb can keep running while
its DevTools port never opens. Install the GLES, EGL, and Mesa DRI libraries
(on Fedora: `libglvnd-gles`, `mesa-libEGL`, and `mesa-dri-drivers`), then
restart the browser.

On Linux, a reachable but locked desktop keyring can stall Chrome before its
first navigation. For a dedicated investigation profile, add
`--password-store=basic` to bypass that keyring. Empty or placeholder frame URLs
then describe an unloaded page; REA continues to require an allowed, committed
URL. See [the startup investigation](https://github.com/morluto/rea/issues/1384#issuecomment-6093781686).

### Browsers without HTTP discovery

Some browsers expose a loopback browser WebSocket but no `/json/version` or
`/json/list`. Chrome 144 and later can enable remote debugging on a running
browser from `chrome://inspect/#remote-debugging`; this mode is reported to
serve only the browser socket. Since Chrome 136, `--remote-debugging-port` is
ignored for the default profile, so this is the remaining way to inspect a page
in an existing profile.

For such a browser, pass the browser socket instead of the HTTP endpoint:

```bash
rea list-browser-targets ws://127.0.0.1:9222/devtools/browser/<id>
```

Chrome writes the port and the `/devtools/browser/<id>` path to the
`DevToolsActivePort` file in its user data directory. REA does not read that
file for you.

- Only `list_browser_targets`, `inspect_web_page`, `analyze_web_bundle`,
  `observe_web_session`, `discover_webmcp_tools`, and `capture_web_screenshot`
  accept a browser socket. Website runtime attribution, Electron inspection,
  and scenario attach mode still require HTTP discovery.
- Each call opens one WebSocket and uses it for discovery
  (`Browser.getVersion`, `Target.getTargets`) and for the selected page.
  Discovery must finish within the same 10-second deadline as HTTP discovery.
  Chrome may ask you to approve each connection.
- The browser identifier controls access to the socket. Evidence records the
  endpoint as `ws://127.0.0.1:9222/devtools/browser/[REDACTED]`.
- `browser.revision` is the socket's `Browser.getVersion` value, such as
  `@e533e98…`. HTTP discovery reports `WebKit-Version`, such as
  `537.36 (@e533e98…)`.
- `Target.getTargets` reports whether each target is attached. Chrome's
  `/json/list` can omit it, so HTTP discovery may report `attached` as `null`.
- An existing profile can hold many unrelated pages. Target listing returns
  each eligible page's URL and title, so pass `--allowed-origins` to list only
  the origins you are investigating.

A browser driven only through `--remote-debugging-pipe` or a vendor's private
automation channel has neither endpoint, and REA cannot attach to it.

## Request boundary

CDP connections enforce the shared 64 MiB limit per WebSocket message. A larger
reply, including a valid reply from Chrome, fails with `payload_limit`. The limit
counts message bytes before JSON parsing; it does not bound the memory used by
decoded strings or JSON objects.

Discovery supplies a literal loopback CDP endpoint and returns all eligible
page targets unless an exact HTTP(S) origin filter narrows the result. Follow-up
inspection requests select one target; their default scope is its current origin.
The endpoint is either `http://127.0.0.1:PORT` or a
[browser socket](#browsers-without-http-discovery),
`ws://127.0.0.1:PORT/devtools/browser/ID`; `[::1]` may replace `127.0.0.1`.
`localhost`, private-LAN addresses, HTTPS and `wss:` endpoints, credentials,
queries, fragments, implicit ports, and any other path are not valid CDP
endpoints. Origin filters contain only scheme,
host, and port; paths, credentials, queries, fragments, and wildcards are not
valid origins.

## CLI workflow

Pass the endpoint and selected target for each call. An origin filter is
optional and narrows the target set.

```bash
oopsware list-browser-targets http://127.0.0.1:9222 --json
oopsware inspect-web-page http://127.0.0.1:9222 TARGET_ID \
  --observation-ms 1000 \
  --json
```

Passive observation honors the requested duration using cancellable waits within
the runtime's timer range. Long windows stay pending across successive waits;
caller cancellation, target termination or leaving the allowed origins ends
collection early. `window_elapsed` identifies completion of the requested wait.

Static bundle analysis and a user-driven observation window are separate operations:

```bash
oopsware analyze-web-bundle http://127.0.0.1:9222 TARGET_ID \
  --json
oopsware observe-web-session http://127.0.0.1:9222 TARGET_ID \
  --observation-ms 10000 --json
oopsware discover-webmcp-tools http://127.0.0.1:9222 TARGET_ID \
  --json
```

### WebMCP discovery prerequisites

`discover_webmcp_tools` reports only what the attached browser's experimental
`WebMCP` CDP domain exposes. When a browser rejects the unknown domain, the
result reports `status: "unavailable"`. Whether a page can register tools at
all depends on several conditions that are not interchangeable:

- A site's own origin-trial token can enable the API for that origin
  **provided the trial is still active, the browser version and platform
  support it, and user settings permit it** — token presence alone is not a
  guarantee. The trial is announced for Chrome 149 and later.
- The `WebMCPTesting` feature — `--enable-features=WebMCPTesting` at launch, or
  `chrome://flags/#enable-webmcp-testing` in a normal profile — enables the
  API page-side for that browser instance, independent of per-site tokens.
  In one pilot run, a site whose registration code was present but whose
  served token was scoped for third-party use registered 0 tools under a
  default launch and 4 under the flag; that the token did not enroll the
  first-party document is consistent with this but is an inference, not a
  measured Chrome behavior.

In Chrome 154 specifically (one tested version), `WebMCP.enable` answered
under a default launch — the debug domain was not flag-gated in that run.
Other versions may differ, so an unattributed zero-tool result should be
read as registration state only after domain availability is confirmed.

Discovery is attach-only: the command needs a reachable loopback CDP endpoint
and a target ID from `list_browser_targets`, and it never navigates, reloads,
or evaluates the page. Observe the page in the state you want to measure;
registered tools reflect the document as loaded.

Accessibility names/descriptions, console primitive text, JSON body shapes, WebSocket shapes, script content, and storage key names are selected independently:

```bash
oopsware inspect-web-page http://127.0.0.1:9222 TARGET_ID \
  --include-accessibility-text \
  --include-console-text \
  --include-json-body-shapes \
  --include-websocket-shapes \
  --include-script-sources \
  --include-storage-keys --include-storage-fingerprints \
  --json
```

Accessibility text, script content, query values, and explicitly requested primitive console text may contain application secrets and become part of the returned Evidence. URL username/password credentials are removed; ordinary query values, fragments, and parameter order remain intact. JSON and WebSocket captures retain complete paths, types, and counts, never values or examples. Storage values remain redacted even when key-name capture is requested. `--include-storage-fingerprints` requests SHA-256 identity/value fingerprints, which support comparison only when cookies, DOM storage, IndexedDB, and Cache Storage were all captured completely.

Screenshot capture returns the complete visible viewport as an inline image artifact:

```bash
oopsware capture-web-screenshot http://127.0.0.1:9222 TARGET_ID \
  --json
```

## MCP input

```json
{
  "cdp_endpoint": "http://127.0.0.1:9222",
  "target_id": "TARGET_ID_FROM_LIST_BROWSER_TARGETS"
}
```

The omitted observation window and capture options use conservative defaults.
Set an option only when the investigation needs that additional content.
Collection counts are not capped. Per-value validation, the selected observation
window, and CDP protocol limits still apply; any incomplete or truncated values
are reported in the result.

Call `list_browser_targets` first because target IDs are browser-instance-specific. Oopsware rechecks the selected target's current type and origin immediately before attaching. Without an origin filter, discovery lists all eligible pages; an individual capture defaults to the selected page's current origin.

Oopsware establishes a main-frame origin boundary before enabling Runtime, Debugger, or Network observation, rechecks it before document capture, and validates it again afterward. If the main frame navigates during final capture, Oopsware discards the mixed result and returns `target_changed`.

## Data minimization

The Link projection parses repeated CDP header field lines independently and
retains their declarations in order, including derived untrusted agent hints.
Commas inside URI targets or quoted parameters remain part of those values.
COOP and COEP projections retain the exact declared token after validating the
complete Structured Field Item, including parameters such as `report-to`.
These are declarations, not an assessment of the document's effective policy;
absent, malformed or non-token items project as `null`.

Oopsware retains local observation data and removes only URL userinfo credentials, explicitly declared scenario secrets, and values from structured credential/storage fields:

- URL observations preserve the complete local URL, including query values, fragments, duplicate parameters, and their order. Only username/password userinfo is removed; malformed original URL strings remain available with `origin: null`.
- DOM snapshots retain node types, node names, value lengths, and attribute names, but not text or attribute values.
- Accessibility structure and roles are retained by default, while names and descriptions require `include_accessibility_text: true`.
- Network observations retain method, status, MIME type, size, type, initiator stack location, and complete URLs with userinfo credentials removed. Redirects reported by CDP are attached as ordered `redirects` on the one request ID, with the prior request URL, CDP response URL, method/type, response status/MIME/encoded length, request timestamp, and the next `requestWillBeSent` event timestamp. CDP delivers `redirectResponse` with that next request event, so the latter is an event boundary rather than an exact response timestamp. Redirect response headers and bodies are discarded; hops outside the selected origins are discarded with the request chain. Headers are discarded after an allowlisted projection of length/encoding, structured CSP/Link/policy fields, and untrusted agent hints. Cookies and authorization headers are never retained.
- Request/response bodies are not requested or parsed by default. When selected, only allowed-origin JSON media types are read, converted immediately to complete value-free typed paths, types and observation counts, and discarded. Each path segment is either `{ "kind": "property", "name": "raw property name" }` or `{ "kind": "array-element" }`; array-element types include primitives and nested arrays. Literal `*` properties remain distinct from array elements. `Network.getResponseBody` is never sent unless JSON body shape capture is selected. Comparison uses body shapes only when both captures selected them, and compares request/response shapes only where both observations provide those facts. Unavailable or truncated selected coverage makes equivalence unknown; observed differences still report changed.
  For normalized passive inputs with complete request inventories on both sides,
  request additions and removals remain observable even when selected body shapes,
  response metadata, or WebSocket coverage are unavailable. HTTP request and
  WebSocket inventory coverage are evaluated separately; complete HTTP coverage
  cannot prove a missing WebSocket connection. Limited request inventory still
  prevents request-absence claims. This comparison rule does not make live CDP's
  attach-limited inventory complete or establish body-shape equality.
  An unavailable HTTP resource type also leaves request identity incomplete:
  observations with the same method and URL remain possible matches across types,
  and identical unknown types cannot establish complete equality. Ambiguous type
  groups cannot prove membership or content changes either: a missing type may
  redistribute repeated requests between buckets without changing the requests.
  Their comparison remains unknown, while independently identified groups retain
  proven changes. Different methods/URLs and complete empty peer inventories still
  support absence claims.
  Relevant dropped-event counts also limit inventory completeness even when no
  section is listed as truncated: HTTP uses `network_requests`, while WebSocket
  uses `websocket_connections` and `websocket_frames`. Drops in other event kinds
  and the aggregate total do not by themselves limit HTTP inventory. Proven
  modifications remain reportable despite incomplete inventory.
  Repeated identical HTTP content samples establish multiplicity changes only
  with complete request inventories; limited inventories retain known content
  comparisons without interpreting duplicate sample counts as changes.
  WebSocket stream inventories and connection counts likewise require complete
  WebSocket coverage. Redirect resource types use only shared known metadata:
  an omitted type leaves equality unknown rather than proving a modification.
- Console observations with a stack source retain call type, argument types, timestamp, and source location. When console text capture is selected, already-delivered primitive values are retained verbatim; objects, getters, and remote properties are never expanded.
- WebSocket observations retain direction, opcode, and payload byte length. When shape capture is selected, text frames are classified as text or complete value-free JSON shape; binary bytes, hashes, prefixes, and raw frames are never retained.
- Storage observations always redact values. Key names, IndexedDB names, and cache names require `include_storage_keys`; stable content fingerprints require the additional `include_storage_fingerprints` selection. Cookie fingerprints cover cookies applicable to the current main-frame URL, including its path, rather than every cookie path on that origin. Other storage remains scoped to the origin. Cache fingerprints hash all decoded response bytes, including bodies above 64 KiB, subject to the [64 MiB per-message CDP limit](#request-boundary). Missing or undecodable cache bodies and partial IndexedDB remote objects make fingerprint coverage incomplete, so identical observations remain `unknown`.
- Unavailable or malformed storage inventories mark `storage_keys` unavailable, even without fingerprints. Comparisons suppress inferred key additions and removals while preserving modifications proven by complete fingerprints on both sides. Previously exported captures are not retroactively corrected; recapture them to obtain these coverage markers.
- Script metadata is included only when CDP supplies a URL on an allowed origin. Stable keys exclude transient CDP script IDs, and exact transient raw URLs are used only during script/resource reconciliation. URL-less scripts are excluded because their origin cannot be established. When CDP supplies an execution-context association, the accepted script retains its authorized frame ID for later attribution. Script metadata admission bounds retained identity and source-map strings to 8 MiB and 50,000 records. When a source-map URL cannot fit, the script identity remains and source-map coverage reports `resource_budget_exhausted`; rejected script observations are counted without retaining their IDs. Source content is omitted unless explicitly requested and is returned inline as a self-verifying artifact with its SHA-256 digest.

Frames, resources, scripts, events, and workers outside the selected origin scope are excluded. An explicit `allowed_origins` list can include additional origins; excluded target details are counted without being exposed.
Retained workers include validated opener-target and parent-frame IDs when CDP
provides them; these relationships do not expand the exact-origin boundary or
prove static module ownership.

## Completeness and limits

The default inspection window is 500 ms; callers choose its duration. The
capture returns in-scope frames, DOM and accessibility nodes, admitted scripts,
resources, workers, storage names, and observed network, console, and WebSocket
events. Full selected text, script sources, and JSON shapes are returned inline.
The result distinguishes
`complete_within_window`, `policy_filtered`, `attach_limited`, and `truncated`
coverage. It reports excluded items and any values omitted or truncated by
validation and resource bounds. Omitted script metadata makes its affected
section explicitly truncated.
Disallowed-origin entries are filtered before retention.

Selected script-source collection shares a 32 MiB aggregate UTF-8 retention
budget and a 20-second deadline across the capture. An oversized source is
omitted while later smaller sources may still fit. When the deadline expires,
remaining source reads are skipped. Script metadata, per-item omission reasons,
and `script_sources` completeness remain available. A single CDP response can
still be materialized up to the separate 64 MiB transport limit before source
admission; the retention budget does not bound that transient allocation.

Bundle parsing and semantic inspection run sequentially in an owned child,
without executing captured code. `max_heap_mb` defaults to 1024 MiB V8
old-space; `analysis_timeout_ms` defaults to 30000 per script, including startup
and transfer. A failed or timed-out script becomes an explicit unknown while
completed findings and later scripts remain available. `total_analysis_timeout_ms`
defaults to 300000 across script analysis; expiry returns a typed timeout with
partial Evidence and identifies unstarted scripts. These controls are also
available as CLI flags with hyphenated names. Capture and optional source-map
fetching have separate budgets.

One web-bundle capture/analysis is admitted per Oopsware process at a time. Completed
script results share an 8 MiB serialized transfer budget, with host heap
reservation checked before decoding and validating another result.
Exhausted result capacity stops further script launches and returns a typed
resource failure with completed facts and explicit unstarted-script unknowns.
Worker control frames are limited to 64 KiB. Cleanup must confirm child termination
before releasing its private files; failed cleanup retains its exact owner and
blocks replacement until retry succeeds. Cancellation retains completed bundle
facts, including cancellation during final cleanup.

The worker heap setting is not a process-family RSS limit. Node enforces V8
old-space flags; Bun ignores them. Windows Bun instead uses an owned process
commit limit with a 512 MiB runtime reserve; other Bun hosts have no enforced
memory limit. These bounds do not establish an aggregate host-memory limit
across other Oopsware operations or external processes.

Resource-tree inventories distinguish a valid empty `resources` array from a
missing or malformed collection. Invalid resource entries are omitted with
incomplete coverage, while valid resources from that frame and other frames
remain available. Comparing an incomplete resource inventory cannot prove
addition, removal, or equality; a complete empty inventory can prove removal.
Resource records require a nonempty type and a string MIME type; absent or
malformed required fields are recorded as omissions instead of invented defaults.
An explicitly empty MIME type is valid. The optional content size may be absent;
an invalid supplied size remains unknown with incomplete resource coverage while
the resource's other facts are retained. Zero and nonnegative fractional sizes
are preserved.

CDP discovery has a 10-second deadline. Each WebSocket handshake and command
response has its own 20-second deadline, separate from the caller-selected
observation window. A stalled handshake or command reports `provider_timeout`;
caller cancellation still reports cancellation. WebSocket messages remain subject
to the [64 MiB limit](#request-boundary). Oopsware does not impose a message-count or
pending-command quota. On cancellation, it closes only its own WebSocket,
waiting up to one second before terminating it. Malformed unsolicited events
and malformed replies to pending commands poison the connection so later
commands fail closed. A correlated reply's session ID must match the command's
selected session. An optional method is unavailable only when the browser
rejects it as unknown; other command rejections retain their reported failure.

Network and console coverage starts only after Oopsware attaches and enables the relevant CDP domains. `prior_activity_available` is always `false`; absence from these arrays is not evidence that an event never occurred. Scripts are different: scripts the page parsed before Oopsware attached are still reported under `scripts`. A page that loaded before attach can therefore list its scripts while `network.requests` lacks the requests that fetched them. If CDP reuses a request ID without supplying redirect metadata, Oopsware retains the predecessor observation and marks network coverage incomplete.

Source maps are not fetched by inspection. Bundle analysis fetches them only when `fetch_source_maps` is selected, with exact-origin redirect checks and no credentials, cookies, or referrer. Each fetch operation has a 30-second deadline and a 64 MiB aggregate streamed-response budget across redirects. A deadline or byte-limit failure remains explicitly unavailable and makes bundle completeness partial. Source-map decoding also bounds raw resolved identities to 64 MiB and aggregate inline evidence to 32 MiB. Failed maps preserve their failure context when it fits; if another context cannot fit, collection stops with the full requested count, the returned processed count, and an explicit unknown-results limitation. Retained mappings and original sources are returned inline. See [source-location limits](web-source-location.md) for the structural decoder bounds. Original source artifacts with `.ts`, `.tsx`, `.mts`, or `.cts` suffixes carry `text/typescript`; other source names retain `text/javascript`.

source-map items retain the script's `declared_url` separately from the observed
`effective_url`. successful maps use the latter as their source-resolution base.
failed fetches retain the last response URL observed within the approved origins;
`effective_url` is `null` when no response was observed. query parameters are
preserved, and both URLs count toward the inline evidence budget.
Current fetches emit a string or null; historical observations may omit
`effective_url` without changing their stored content or Evidence identity.
An observed URL must fit before its response body is read. If it cannot fit,
remaining map results are explicitly unknown; failed cancellation retains its
cleanup context and resource constraint.

## Non-goals and threat model

The browser provider deliberately does not expose generic CDP commands, `Runtime.evaluate`, WebMCP invocation, navigation, input, downloads, page closure, or browser closure. Screenshot capture is the sole pixel surface and returns an image only when requested. Oopsware disables the domains it enabled, detaches the target session, and closes only its own WebSocket.

This feature is not a browser sandbox or network containment mechanism. The attached page and browser continue running with their existing privileges and may make external requests independently of Oopsware. CDP gives deep access to the selected browser profile, so use a dedicated profile, include only origins you intend to inspect, and treat other same-user processes as outside this boundary.

Response metadata normalizes a `Referrer-Policy` fallback list to its last recognized nonempty policy, including mixed-case tokens. Unknown policy names are skipped; malformed token syntax and lists without a recognized policy remain `null`. This reports the response's declared policy, not the effective policy of a document or an inferred browser default.
