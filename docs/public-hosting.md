```text
Document:    Oopsware Public Hosting
Version:     v1.4.1
Author:      Celaya Solutions
Contact:     hello@celayasolutions.com
Date:        2026-10-17
SHA256:      c3e541efd6e06e9aa134a81dd8fa4f22750b8d754650eb1f713bdd49fe64b400
Chain:       solana-mainnet
Tx:          3cBCAM6GK4o59BRcquzLxW6RunoW1q1CVTAaeWAgFtuGrES9Sb3j5cLWDprjcKcR8vVdN2kraW1hWcqzfzvUkPUG
License:     All Rights Reserved / Celaya Solutions
```

# Public file library

The public Railway site is a searchable card catalog with its own card-catalog
identity: self-hosted Archivo and Atkinson Hyperlegible fonts, a warm-paper
palette with a single vermilion accent, flat ruled cards, mobile-first, and no
emoji. Visitors can browse, filter by file type and inspection status, sort,
upload, read findings, and download originals or extracted files without an
account.

Uploads remain anonymous, public, and limited to 1 GiB. Visitors must confirm that they can share the file and that it contains no personal data or secrets. This declaration is not automatic screening. Uploaded programs are never executed.

## Pages

The service serves the library plus static pages, all sharing the header,
footer, and `site.css` design system:

- `/` — the library (search, filters, upload, findings, downloads), with a
  Files / Build-prompts view switch. The Build-prompts section is a laid-out
  placeholder for a later feature and has no backend yet.
- `/formats` — a complete file-types reference: what the browser service reads,
  what the desktop tool adds, what needs a bring-your-own provider, and what is
  planned. Filterable by tier and text, readable with JavaScript disabled.
- `/privacy`, `/terms`, `/report`, `/about` — privacy, terms of use, the
  takedown path (a `mailto:` to the operator, no write endpoint), and credits.

## Retention and auto-delete

Each upload carries an `expiresAt`. The upload form offers "Delete automatically
after 24 hours" (default on). When chosen, `expiresAt` is set 24 hours after
creation and the public card and detail view show a live countdown. A sweeper
(`HostedStore.sweepExpired`) runs on startup and every ten minutes and removes
the whole submission — original, extracted files, and findings — once it
expires. Unchecking the toggle leaves `expiresAt` null; the upload stays until
an operator removes it. Visitors can cancel only an incomplete upload, never a
published one. The same sweeper discards any incomplete upload that has received
no bytes for an hour, whatever its retention choice, so abandoned uploads stop
reserving disk space.

## Analytics

Analytics is PostHog, cookieless, US region on the live service, page-views and a few deliberate
clicks only — no autocapture, no session recording, no file names or contents in
events, no personal profiles, and off when the browser sends Do-Not-Track. It is
also off entirely unless `OOPSWARE_POSTHOG_KEY` is set. The server injects the
publishable key and host through `/config.js` and adds only the analytics host
to `connect-src` in the CSP when a key is present; `posthog-js` is self-hosted
with `disable_external_dependency_loading`, so the page still makes no
third-party script request.

## Browsing and reading

Search, category filters, status filters, and sorting apply on the server before pagination. Category counts follow the current search and status selection. Categories use filename extensions as browsing hints, not evidence of actual format. Browse responses carry each item's original file and a `fileCount`, not every extracted file; the item endpoint returns the full list. This keeps catalog pages small as large apps are added (the list was 785 KB for nine items before this change). The inspection report retains the parser’s observed format and its limits.

Cards show factual summaries based on inspection state and published file counts. These are not AI explanations of program behavior. Each card offers details and a direct original download when that file is available. Details contain observations, unknowns, a file browser, and downloadable Markdown and JSON reports.

Markdown files render through locally bundled markdown-it with raw HTML disabled, validated link protocols, and remote images represented as text. Text, hexadecimal, and printable-string views remain available. File previews use 16 KiB pages; the UI identifies partial Markdown pages and offers the complete download. Original files are served as attachments, with content sniffing disabled.

Structured text (`.md`, `.markdown`, `.json`, `.jsonl`, `.yaml`, `.yml`, `.toml`, `.xml`, `.csv`, `.tsv`, `.txt`) uploaded as the original is parsed once, in a separate process under the analysis worker with a 384 MiB heap and a three-minute budget (JSON, JSONL, CSV, TSV and text up to 16 MiB; Markdown, YAML, XML and TOML up to 4 MiB; first 100,000 structural nodes). A file over that budget keeps the byte preview and is still published. The page then reads whole Markdown blocks, records, rows or lines instead of 16 KiB byte slices, lists every parsed value with its line and column, and shows parse and encoding problems with exact positions. Routes: `GET /api/submissions/<id>/structure`, `.../structure/nodes/<page>` and `.../previews/segment-<n>`; nothing in them accepts a path, parser option or tool name. Files inside archives and older uploads keep the byte preview. See [structured-text reading](structured-text.md).

WebAssembly originals (bytes that start with `\0asm`, up to 32 MiB) are decoded once by the analysis worker in a separate process with a 384 MiB heap and a three-minute budget. The page shows the module's validation, imports, exports, memories, data segments, sections and the first 20,000 functions with their call edges, and offers the WAT text rendered by wabt.js as a separate download labelled derived. Routes: `GET /api/submissions/<id>/wasm`, `.../wasm/functions/<page>` and `.../outputs/module.wat`; nothing in them accepts a path, option or tool name, and the module is never instantiated. Components are identified only; `.wat` uploads, modules inside archives and older uploads keep the byte preview. See [WebAssembly inspection](webassembly.md).

The public page and server no longer accept chat messages, provider keys, or BYOK report jobs, and no longer read stored AI reports (no live submission had one). Those routes return 404, and the leftover hosted inference modules are deleted. OpenAI Luna is a later integration; no shared inference account or model connection is active.

## Storage and execution limits

Resumable uploads use 8 MiB requests. A random upload token authorizes appending, completing, or canceling that incomplete upload. Published submissions cannot be overwritten or deleted by visitors. Metadata updates are atomic, interrupted chunks resume at their last committed offset, and interrupted analysis resumes after restart. An inspection interrupted twice is marked failed rather than started again, so one poisonous file cannot trap the service in a restart loop.

One disposable parser runs at a time with a 512 MiB JavaScript heap and ten-minute deadline. Extraction has a 2 GiB expanded-byte and 10,000-entry budget and checks free disk space. Failed parsing retains the original and reports the limits. Deep native disassembly and runtime behavior are unavailable here.

The hosted adapter is separate from the local command-capable app. It exposes no local paths, shell commands, setup, MCP execution, browser automation, or arbitrary URL fetches. Keep the local server private. The public service refuses cross-origin and opaque-origin writes, uses a restrictive content security policy, and sends HSTS, `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy`, and a `Permissions-Policy` that disables camera, microphone, location, payment, and USB. Upload names must be plain: under 240 bytes, without separators, control characters, or text-direction marks that could disguise an extension.

## Abuse limits

Each network address has its own budgets: 30 upload starts per hour, at most 3 uploads that are incomplete or waiting for inspection, 600 API requests per minute (upload chunks excluded; their token and declared size bound them), and 10 GiB downloaded per hour. A refused request gets `429` with `Retry-After`; pages and other visitors are unaffected. The address comes from `X-Real-IP`, which Railway's edge sets; a direct connection uses the socket peer, so run the public service only behind such a proxy. Counts live in memory, reset within an hour, and are never written to disk. `startHostedServer({ limits })` overrides them for tests and fixture seeding. Upload admissions run one at a time, so concurrent visitors wait briefly instead of failing.

## Operator takedown

Set `OOPSWARE_OPERATOR_TOKEN` to a long random secret to enable removals. With it set, `DELETE /api/submissions/<id>` carrying `Authorization: Bearer <that secret>` removes any submission — published included — with its files and findings; the match is constant-time and the upload's own token is not required. Leave the variable unset to keep the operator path off entirely (then no one can remove a published upload, and takedowns need volume access). The secret authorizes deletion of anything in the library, so treat it like a root password: set it only as a Railway variable, never in code or a committed file, and rotate it if exposed. This backs the takedown promise on the report page.

## Railway operation

- Workspace: `celaya-solutions`, ID `c404b6f3-f28c-4387-9a20-15bf94bb760e`.
- Project: `Oopsware Public Lab`, ID `fbbdb6b4-0209-4e54-948d-6f7ffea91df5`.
- Service: `public-lab`, ID `f3e4fb08-1cac-43b1-88c1-b7c305ad4473`.
- Production environment: `81d3bf28-1202-4aa0-b27e-7542ab9847ce`.
- Domain: <https://public-lab-production-3eed.up.railway.app>.
- Persistent volume: `public-archive`, 51,200 MB at `/data`.
- Runtime data: `/data/rea-public`; HTTP port: `8080`; health: `/health`.

Use `Dockerfile.hosted`, `RAILWAY_DOCKERFILE_PATH=Dockerfile.hosted`, `PORT=8080`, and `REA_PUBLIC_DATA=/data/rea-public`. The container pins Node 24.18.0/npm 11.16.0, prepares the volume, and drops to UID/GID 1000 before serving. Keep `/health` as the health check and disable sleeping.

To turn on analytics, set `OOPSWARE_POSTHOG_KEY` to the PostHog project's
publishable key; `OOPSWARE_POSTHOG_HOST` is optional and defaults to
`https://eu.i.posthog.com`. Leave both unset to keep analytics off. The build
copies the three self-hosted fonts from `node_modules/@fontsource-variable/*`
into `dist-hosted/public/fonts/` and bundles `site.js`, `app.js`, and
`formats.js`; no binaries are committed.

Deploy only runtime source, hosted assets, package manifests, build/entrypoint scripts, and license notices. Do not include personal workspaces, credentials, or local archives. Verify the submitted deployment reaches `SUCCESS`, then check the actual public page. Use direct Railway source upload; do not use GitHub Actions or merge into main without a direct request. Files remain on the existing volume across redeployments.

## Verification

```sh
npm run hosted:build
npm run check:fast
npx vitest run --project boundary tests/boundary/web/hosted.test.ts
node scripts/verify-hosted-catalog.mjs
```

The browser check starts an isolated local service and temporary archive. It requires installed Chrome on macOS, or `CHROME_EXECUTABLE` pointing to installed Chromium. Set `REA_HOSTED_SCREENSHOTS` to an existing directory to capture desktop, Markdown, and mobile views.

Ten HTTP/worker tests pass for upload ownership, limits, resuming, restart, extraction, exact downloaded bytes, unsafe archive paths, collection filtering beyond the first page, removal of inference routes, auto-delete, static pages, hardening headers, opaque origins, disguised filenames, per-address budgets, abandoned uploads, and bounded inspection retries. The real-browser check passes for cards, search, filters, rendered Markdown, inert hostile markup, exact original downloads, Markdown report export, form uploads, 390-pixel layout, and JavaScript errors.

The earlier hosted release also verified a full 1 GiB upload locally and an 8 MiB chunk plus one byte through Railway. Those limits and upload semantics are unchanged. Real Hopper/Ghidra and live AI inference are outside this catalog change.

## Open-source apps

The About page lists every open-source app in the library with its version, license, exact-version source, and official download. Disk-image downloads were verified against the project's published SHA-256; apps repackaged from a disk image (their bytes change) were verified by their Apple-notarized code signature instead — for example Wireshark 4.6.9 signed by the Wireshark Foundation and OpenCode 2.0.26 by Anomaly Innovations, Inc.

## Live catalog release

Railway deployment `bac91ac5-10d3-4365-a55c-914053449311` reached `SUCCESS` on 2026-10-16. Public JavaScript and CSS match the tested build byte for byte. Live browser checks passed for the preserved three-item archive, category and search filters, empty results, report and file details, exact sample-download SHA-256, the upload dialog, 390-pixel layout, and absence of browser errors. A real four-byte upload chunk was accepted and its incomplete submission removed with its owner token; no test upload was published. The removed chat endpoint returns 404. The Markdown parser is pinned to 14.3.3 and the dependency audit reports zero vulnerabilities.
