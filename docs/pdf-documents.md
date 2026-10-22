```text
Document:    PDF inspection (format expansion F12, part 2)
Version:     v1.0.1
Author:      Celaya Solutions
Contact:     hello@celayasolutions.com
Date:        2026-10-21
SHA256:      65b4f3e71773cf5b3b80217fed91063e692c367e7141af6a570ec4877e714510
Chain:       solana-mainnet
Tx:          WA3RSzNPfBHqzm89n6bsNZwy2TW5JVMEnFgxEG3fmsc2EAMJqrZAjBx514A4ArYPMooeV7ZVvTigKS8889NRX39
License:     All Rights Reserved / Celaya Solutions
```

# PDF inspection

Format expansion F12 part 2 reads **PDF** files from their bytes. Part 1 reads Office Open XML (see [Office documents](office-documents.md)); legacy `.doc`, `.xls` and `.ppt` (part 3) are not read yet. Nothing is rendered, repaired, rewritten, decrypted, run or fetched.

| Tool (MCP / CLI)                                | Answers                                                                                                                                                                          |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inspect_pdf_document` / `inspect-pdf-document` | What the file is made of, who made it, whether it is encrypted, which scripts, launch targets, links, attachments and signatures it carries, what each page draws, and its text. |

```sh
oopsware inspect-pdf-document ./invoice.pdf --json
oopsware inspect-pdf-document ./contract.pdf --view pages --limit 50 --json
oopsware inspect-pdf-document ./paper.pdf --view text --limit 5
oopsware inspect-pdf-document ./paper.pdf --view layout --start 10 --limit 2 --json
oopsware inspect-pdf-document ./suspect.pdf --view objects --limit 200 --json
```

## Views

- `package` (default): the header and catalog version, linearization, the cross-reference state, revisions, `%%EOF` markers and trailing bytes, trailer IDs, page counts, tagged/language/outline/form facts, the encryption declaration, the Info dictionary and XMP size and hash, attachments, actions, signatures, and the kinds of the first 25 pages (`content_sample`).
- `pages`: one row per page, paged by `start`/`limit` (default 100): object, boxes, rotation, user unit, what the page draws (`kind`, with the counts behind it), font count, annotation subtypes and link URIs.
- `objects`: one row per indirect object in number order, paged: where it lives (a file offset, or an object stream and index), its kind, `Type`, `Subtype` (or `S`), filters and declared stream length.
- `text`: page text as Markdown lines (`## Page N`, then the page's lines). Paged **by page**: `start` is the first page (0-based), `limit` the number of pages (default 10, at most 200).
- `layout`: the same text as lines with bounding boxes `[left, top, right, bottom]` in points from the page's top-left corner, plus each page's size and word count.

`page.next` continues a view. A page of JSON is cut near 2 million characters, so a page can return fewer rows than `limit`.

## Structure and repair

The file is read from the end: `startxref` leads to a classic table, a cross-reference stream or a hybrid of both, and `Prev` links walk the older revisions (a loop or more than 10,000 sections is named and stopped). Objects inside object streams are read through their stream. `document.xref.state` says what was done:

| State     | Meaning                                                                                                                                                                                                                                                                                                                                                                       |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `table`   | Classic cross-reference tables only.                                                                                                                                                                                                                                                                                                                                          |
| `stream`  | Cross-reference streams only (PDF 1.5 and later).                                                                                                                                                                                                                                                                                                                             |
| `hybrid`  | A table whose trailer points at a cross-reference stream for compressed objects.                                                                                                                                                                                                                                                                                              |
| `rebuilt` | The table, the offsets or `startxref` were missing or wrong, so the file was scanned for `N G obj`. A later definition of an object number wins, and the bytes inside a stream are skipped, so an uncompressed file embedded in an attachment adds no objects or trailer of its own. The catalog is the trailer's `Root`, else the last dictionary whose `Type` is `Catalog`. |
| `none`    | No structure could be read.                                                                                                                                                                                                                                                                                                                                                   |

A rebuilt file is reported as such in `document.problems`, and the identify coverage is `partial`. Offsets that count from the `%PDF-` header after leading junk are accepted (and the junk is named). `document.xref.sections` counts the cross-reference sections in the chain and `startxref_markers` and `eof_markers` count the byte strings in the whole file, so an uncompressed PDF embedded in the file adds to them. `trailing_bytes` is what follows the last `%%EOF` apart from white space.

## Encryption

An `Encrypt` entry is described and **refused for content**: handler, sub-filter, `V`, `R`, key size, the method (`rc4`, `aes-128`, `aes-256`, `identity`), whether it is public-key, `EncryptMetadata`, and the permission bits as the file declares them. No password is tried, including the empty one, and nothing is decrypted, so the Info dictionary, attachments, actions, page content and text are not read; `text` and `layout` fail with an unsupported-target error and `pages` rows have kind `not-read`. The page count is still given when the catalog and page tree are plain objects. A viewer enforces permissions; the data does not, so treat them as a declaration.

## Metadata

`metadata.info` is a list of `{key, value}` pairs, in file order, up to 200 (`info_total` counts all of them; a key such as `__proto__` is an ordinary entry). Values are the Info dictionary entries as written: text strings are decoded (UTF-16 with a mark, UTF-8 with a mark, or PDFDocEncoding), names keep a leading `/`, and dates stay in PDF date syntax. `metadata.xmp` gives the size and SHA-256 of the XMP stream, which is not parsed.

## Attachments

Attachments come from the `EmbeddedFiles` name tree and from file-attachment annotations (the first 2,000 pages). Each entry has the name, description, media type, relationship, declared size (`Params.Size`), the decoded size, the **SHA-256 of the decoded bytes**, the declared MD5 (`CheckSum`) as written, the dates, the filters and a state: `read`, `not-decoded` (an image filter, or a filter this reader does not implement), `over-budget` (the decoding budget ran out) or `unreadable` (a file specification with no embedded data, which is also listed as a `FileSpec` action). Attached bytes are hashed, never extracted or opened. The list holds 500 entries; `attachment_total` counts all of them.

## Actions

`actions` lists what a reviewer asks about first, each with where it hangs (`trigger`): `OpenAction`, the catalog's `AA`, the `Names` JavaScript tree, a page's `AA`, a page's annotations (`page 3 Link`), form fields and outline items.

| Kind                                                 | `target` / content                                                                            |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `JavaScript`                                         | `script`: the first 2,000 characters; `script_bytes` and `script_sha256` of the whole script. |
| `Launch`, `GoToR`, `GoToE`, `ImportData`             | The file as written.                                                                          |
| `URI`, `SubmitForm`                                  | The URI or URL as written.                                                                    |
| `Rendition`, `RichMedia`, `Movie`, `Sound`, `ThreeD` | Media annotations and rendition actions, listed so they are not missed.                       |
| `FileSpec`                                           | A file specification that names a file but embeds nothing.                                    |

**Nothing is run or followed.** A script's text is evidence of what the file contains, not a safety verdict; a script that never runs in a viewer is still listed. The list holds 500 entries; `action_total` counts all of them, and a diagnostic says when a list is cut. An action object is read once however many places refer to it, under the first trigger that reaches it. Annotation-based entries cover at most the first 2,000 pages and 100,000 annotations; a diagnostic says how far the scan went, and the `pages` view lists annotations and link URIs for every page.

## Signatures

Signature dictionaries are found through form fields (`Sig`) and the catalog's `Perms`. Each has the field name, sub-filter, signer name, reason, location, signing time and contact as written, the size of `Contents`, and the `DocMDP` permission when a reference declares one. `byte_range` and `coverage` say how far the signed ranges reach in **this** file:

- `whole-file`: the gap between the two ranges is exactly the `Contents` hex string (`gap_bytes` is its length including the angle brackets) and the second range ends at the end of the file (white space aside).
- `gap-mismatch`: the ranges skip bytes that are not the `Contents` hex string, so other bytes of the file are unsigned (the signature-wrapping shape).
- `earlier-revision`: bytes follow the signed ranges (`uncovered_trailing_bytes`): the file was changed or extended after signing.
- `invalid-range`: the range does not start at 0, runs backwards or past the file, or is not four non-negative integers.
- `no-range`: the dictionary carries no `ByteRange`.

Signatures are **recorded, never verified**: no certificate is checked and no digest is recomputed.

## What a page draws

A page's content streams (joined, and form XObjects up to four levels deep) are scanned for text-showing operators, image draws, inline images and paint operators. `kind`:

| Kind                     | The streams draw                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------- |
| `text`                   | Visible text and no images.                                                           |
| `text-and-images`        | Visible text and images.                                                              |
| `image-only`             | Images and no text: the usual shape of a **scanned** page.                            |
| `image-with-hidden-text` | Images and only invisible text (render mode 3 or 7): the usual shape of an OCR layer. |
| `vector-only`            | Paint operators and nothing else.                                                     |
| `blank`                  | Nothing.                                                                              |
| `unreadable`             | The streams could not be decoded or scanned (`note` says why).                        |
| `not-read`               | The document is encrypted, or the decoding budget ran out.                            |

This describes the stream, not what a viewer shows: annotations, form field appearances, patterns and Type 3 glyph procedures are not scanned. The render mode is tracked through `q`/`Q` and a form XObject is scanned under the mode it was invoked with (once per mode). An unfiltered inline image is skipped by the length its dictionary fixes, a filtered one at the first `EI` that follows white space or the filter's end marker. A Flate stream that ends early is scanned as far as it decoded and the row's `note` says so; a form nested deeper than four levels makes the page `unreadable` with a note rather than `blank`. OCR is not run; a scanned page returns no text and the text view says it is image-only.

## Text and layout

Page text comes from Poppler's `pdftotext -tsv`, run on a private copy of the file in a scratch folder with an empty environment, a deadline (`timeout_ms`, default 60 s) and an owned process group, and removed afterwards. A build is **admitted by the SHA-256 of its executable**; any other build is reported as unavailable (`AnalysisCapabilityUnavailableError`) instead of run. Admitted: Homebrew poppler 26.08.0 for macOS arm64 (`/opt/homebrew/bin/pdftotext`). The shared `libpoppler` it loads is not separately digested, so the version recorded in `text_tool` is a record, not a proof. The structure views do not need Poppler.

- Text is in **Poppler's layout order, which is not guaranteed to be reading order**: columns, tables, sidebars and rotated text can interleave. Words on a line are joined with a space; Poppler does not report the original spacing. End-of-line hyphens are kept (`-remove-hyphens none`).
- Text the file hides (invisible render mode, white or clipped text) is returned like any other. Characters a font cannot map to Unicode can come back wrong or missing.
- A page with no words gets a note: `image-only` pages say there is no text layer and that OCR is not run. A page Poppler returns nothing for gets a placeholder and a diagnostic.
- A line that starts with Markdown syntax (`#`, `*`, `-`, `>`, a list number) is escaped with a backslash in the `text` view, so page text cannot pose as a heading or a note.
- `layout` lines carry Poppler's `flow` (paragraph), `block` and `line` numbers; one line is one such triple.
- Poppler follows the page tree's declared structure and this reader the distinct pages; when the tree repeats a node or its `Count` is wrong a diagnostic says text may belong to a neighbouring page.
- Poppler's messages for a damaged file are returned in `diagnostics` (location `pdftotext`).
- The output of one call is limited to 64 MiB; a page range over it fails with a resource error that says to read fewer pages.

## Limits

- A file is read into memory (`max_file_bytes`, default 128 MiB, up to 1 GiB). Streams are decompressed against `max_decoded_bytes` (default 512 MiB, up to 2 GiB), at most 256 MiB for one stream; a stream that would pass it is named, coverage is `partial` and the continuation names the limit. Image filters (DCT, JPX, CCITT, JBIG2) are never decoded.
- One object may hold 2 million tokens, 64 levels of nesting and strings of 16 MiB. The cross-reference table keeps 4 million entries, the chain 10,000 sections, the page tree 200,000 pages and 400,000 nodes, a form 100,000 fields, the outline 5,000 items and an action chain 16 links. Info values are cut at 4,096 characters, URIs and file names at 2,048, scripts at 2,000.
- The in-process read is stopped between steps by cancellation or by `timeout_ms`; one step (a single decompression, one long token) is bounded by size limits rather than the clock. The name-tree, action and form walks share a budget of 1,000,000 steps and say when it runs out; every queue counts what it queues, so a Kids array or action list that many nodes share cannot multiply the work.
- A decoded stream is kept for reuse (up to 8 MiB each, 64 MiB in all) and charged to `max_decoded_bytes` once, so many actions that share one script do not drain the budget. Flate data that ends early keeps what decoded and reports `truncated`; an attachment in that state gets no hash.
- A hostile dictionary key can never reach a prototype: dictionaries are `Map`s, the Info list and annotation subtypes are lists, and every number that reaches the report is a finite, safe integer or null (a 400-digit number is not a number here).
- Free text in the report (names, titles, signer details, field names, triggers, IDs) is cut to a fixed length, so a small file cannot produce a huge report.

## Verification

`src/pdfDocument/syntax.test.ts` covers the lexer, text strings and every filter, including the specification's LZW example, predictors and decompression bombs. `src/pdfDocument/pdfDocument.test.ts` uses real producers: Quartz (`cupsfilter`, `sips`), pdfTeX (object streams and a cross-reference stream), Ghostscript (RC4 encryption with permissions) and Poppler's `pdfattach`, with Poppler's `pdfinfo`, `pdftotext`, `pdfdetach` and `pdfimages` as the oracles (versions, page counts, words in order, attachment names, image counts, permission flags). `src/pdfDocument/pdfHostile.test.ts` assembles what no producer writes: JavaScript, launch and URI actions, media annotations, embedded files with each state, page kinds (OCR layer, form XObjects that draw themselves, inline images, render-mode restore), inherited page boxes, a self-listing page tree, skewed offsets, a missing table, a bad `startxref`, junk before the header, a lying `/Length`, a looping `Prev`, an update after the last `%%EOF`, signatures that do and do not cover the file, AES and public-key encryption declarations, and the decoding budget. `src/pdfDocument/pdfReview.test.ts` pins the defects a fresh adversarial review found and confirmed by running them: a quadratic number regex, merged text lines, values that failed the output schema, deep action chains, shared Kids and action hubs, filter memory, render mode through forms, hybrid files, objects inside streams during a rebuild, truncated Flate data, signature gaps, unclipped text, repeated decoding, large cross-reference tables, inline images, forged headings and the deadline; its LZW cases round-trip an encoder written in the test. `tests/acceptance/applications/pdfDocument.test.ts` runs the compiled CLI and a real stdio MCP client against the same file and compares the evidence.

## Not done (F12)

Legacy `.doc`, `.xls`, `.ppt` (part 3); decryption of any kind; OCR; image extraction and decoding; attached files as members of the artifact graph (they are hashed, not extracted); signature verification; XFA forms and XMP parsing; font, outline and destination detail; Type 3 and pattern content; PDF/A and PDF/UA conformance checks; hosted views; a `verify:formats:pdf` lane over a corpus of real producer files; a Linux Poppler admission.
