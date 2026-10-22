```text
Document:    Office document inspection (format expansion F12, parts 1 and 3)
Version:     v1.1.1
Author:      Celaya Solutions
Contact:     hello@celayasolutions.com
Date:        2026-10-21
SHA256:      df2434e97846d7629c6d4f2a2a9327dbe7aadfc300f7656ae391c425281f5540
Chain:       solana-mainnet
Tx:          d4cQEqHf2zEkjTopuT1NW6wNwfRRNs54HCtSbeeYqA1SZfyvXmY4Ah5XEcVoaUWqaUmrQn8pVkutq47fy6SRTgQ
License:     All Rights Reserved / Celaya Solutions
```

# Office document inspection

Format expansion F12 reads supporting documents from their bytes. Part 1 covers **Office Open XML**: Word (`.docx`, `.dotx`, `.docm`, `.dotm`), Excel (`.xlsx`, `.xltx`, `.xlsm`, `.xltm`, `.xlam`) and PowerPoint (`.pptx`, `.potx`, `.pptm`, `.potm`, `.ppsx`, `.ppsm`, `.ppam`). Part 3 covers the **legacy 97-2003 binary files**: Word (`.doc`, `.dot`), Excel (`.xls`, `.xlt`) and PowerPoint (`.ppt`, `.pot`, `.pps`), which are OLE compound files; see [Legacy 97-2003 files](#legacy-97-2003-files). PDF is a separate tool (part 2, [PDF documents](pdf-documents.md)). Nothing is opened in an application, recalculated, converted, run or fetched.

| Tool (MCP / CLI)                                      | Answers                                                                                                                                                                          |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inspect_office_document` / `inspect-office-document` | What kind of document this is, who made it, which macros, embedded objects, signatures and external links it carries, then its paragraphs and tables, worksheet cells or slides. |

```sh
oopsware inspect-office-document ./invoice.docm --json
oopsware inspect-office-document ./budget.xlsx --view content --part sheet:2 --limit 50 --json
oopsware inspect-office-document ./deck.pptx --view text
oopsware inspect-office-document ./report.docx --view parts
```

## Views

- `package` (default): the kind, properties, a count of what the document holds, notable parts, external references, the content parts you can select, and any problem with the package. It reads the document body (Word, PowerPoint) to count what it holds; it does not scan worksheets, which can be huge.
- `parts`: every package part with its declared content type and size, paged.
- `content`: typed items of one content part, paged (`start`, `limit`, `page.next`). `part` picks the part; the default is the Word body, the first visible worksheet, or the slides.
- `text`: the same content as readable Markdown lines, paged the same way.

## The kind comes from the bytes

The main part is the target of the package's `officeDocument` relationship, and its **declared content type** decides the kind (`docx`, `docm`, `xlsx`, `xlsm`, `pptx` and so on). The file name is only a hint: a `.docx` whose main part is a macro-enabled document reports `kind: docm`, `macro_enabled: true` and a `name_conflict`. Strict and transitional Office Open XML are both read (`conformance` says which); strict namespaces are mapped to the transitional ones when the XML is read.

A file that is neither a ZIP nor an OLE compound file, and a ZIP with no `[Content_Types].xml`, are refused. A password-protected Open XML document (an `EncryptedPackage` stream in a compound file) is named as such: no password is tried and nothing is decrypted. A compound file with a `WordDocument`, `Workbook` or `PowerPoint Document` stream is read as a legacy file (below); any other compound file is refused. A binary workbook (`.xlsb`, BIFF12) is identified and reports a diagnostic instead of cells.

## Properties

`properties.core` is the Dublin Core part (`title`, `subject`, `creator`, `keywords`, `description`, `last_modified_by`, `revision`, `created`, `modified`, `last_printed`, `category`, `content_status`, `language`, `version`, `identifier`). `properties.app` holds the simple fields of `docProps/app.xml` as written (`Application`, `AppVersion`, `Company`, `Pages`, `Words`...). `properties.custom` lists custom properties with their value type. Values are as written, cut at 2,000 characters.

## Macros, objects, signatures and external links

`notable` lists parts a reviewer asks about first, each with its content type, size and, for code-bearing parts, a SHA-256:

| Kind                                  | Declared by                                               |
| ------------------------------------- | --------------------------------------------------------- |
| `macro-project`                       | `application/vnd.ms-office.vbaProject` (`vbaProject.bin`) |
| `macro-signature`                     | `application/vnd.ms-office.vbaProjectSignature`           |
| `macro-data`                          | a `vbaData` content type                                  |
| `macro-sheet`                         | an Excel 4.0 (XLM) macro sheet content type               |
| `ole-object`                          | an OLE object part, or a part under `embeddings/`         |
| `embedded-package`                    | another file stored under `embeddings/`                   |
| `activex`                             | an ActiveX control declaration or its data                |
| `digital-signature`                   | package signature parts                                   |
| `custom-xml`, `comments`, `thumbnail` | the part's path or content type                           |

A macro project is **listed and hashed, never unpacked or run**, and its presence is a declaration, not a safety verdict. The report also says when the declared type and the parts disagree: a plain document type that carries a VBA project, or a macro-enabled type with no project. Signatures are recorded, not verified.

`external_references` lists every relationship whose target mode is `External`, as written, with the part that declares it and its kind: linked templates (`attachedTemplate`), hyperlinks, linked images and OLE objects, external workbook paths. **None is fetched.** The list holds at most 500; `external_total` counts all of them. `notable` holds at most 200 entries; `notable_total` counts all of them.

## Content

### Word

`content_parts` lists the body, comments, footnotes, endnotes, and each header and footer. Body items are paragraphs and tables in document order, including content inside content controls (`w:sdt`) and the chosen branch of markup-compatibility alternates.

- A **paragraph** carries its style name, `heading_level` (from a `Heading n` style or an outline level), `list_level`, the text, hyperlinks (`text`, `target`, `external`), field instructions as written (never evaluated), a `revision` flag for tracked changes and `hidden` when every run is marked hidden.
- Tracked changes: inserted text is included, deleted text is not; counts are in `statistics`. Hidden text is included and counted (`hidden_text_runs`).
- A **table** carries its cell text as a grid (at most 200 rows and 50 columns per item; `truncated` says so). A nested table is flattened into its cell.
- Footnote and endnote references appear in the text as `[^fn1]`, `[^en1]`.
- `omissions` counts what is not described: pictures and shapes (`drawing`, `legacy-drawing`), text boxes, embedded objects, symbols, and equations (flattened to their text, structure lost).

### Excel

`content_parts` lists every sheet with its kind (`worksheet`, `chartsheet`, `dialog-sheet`, `macro-sheet`) and whether it is hidden (the `hidden` and `veryHidden` states are not told apart). A worksheet is streamed one row at a time, so a large sheet does not need the whole sheet in memory. Rows without a value or formula are not listed; their count is an omission.

Each cell has:

- `type`: `number`, `string`, `inline-string`, `boolean`, `error`, `date`, `blank`.
- `value`: the stored value, or the **cached result** of a formula. `formula` is the formula text, kept separate. A shared formula's first cell holds the text; the others have `formula: null`, `formula_kind: shared` and `formula_from` naming that cell. Array and data-table formulas are labelled. Nothing is recalculated, and a cached value may be stale or missing (`value: null`).
- `number_format`: the cell's format code. A number whose format shows a date or time is reported as `date`, with the ISO value in `value` and the stored number in `serial`. The 1900 date system (including the day 1900-02-29 that never existed) and the 1904 system are both handled; a number outside the date range stays a number.
- Rich-text shared strings are joined; phonetic runs are skipped.

### PowerPoint

One content part, `slides`, in presentation order. Each slide has its number, `hidden`, layout name, title (the title placeholder), text of the other shapes in shape order (groups are entered), tables, hyperlinks, and the speaker notes. Pictures, charts, diagrams and media are counted as omissions. Comments are listed in the package view.

## Legacy 97-2003 files

The same tool, views and item shapes read Word 97-2003, Excel 97-2003 (BIFF8) and PowerPoint 97-2003 files. They are OLE compound files; `kind` is `doc`, `xls` or `ppt`, decided by the main stream (`WordDocument`, `Workbook`, `PowerPoint Document`), never by the file name (a disagreeing name is a `name_conflict`). `parts` lists the compound file's storages and streams (control characters in a name are shown as `\x05`), and `part_count` counts them. `macro_enabled` is true when the file carries a VBA project or an Excel 4.0 macro sheet, because these formats have no macro-enabled type. `conformance` is `unknown`.

- **Properties** come from the `\x05SummaryInformation` and `\x05DocumentSummaryInformation` streams ([MS-OLEPS] property sets) and are mapped to the same `core`, `app` and `custom` names as Open XML (`TotalTime` in minutes, `AppVersion` as `major.minor`). A property that cannot be read is a package problem; the rest is still read.
- **Macros and objects.** A VBA project storage (`Macros`, `_VBA_PROJECT_CUR`, or a PowerPoint VBA object stored inside the presentation stream), a signature stream, Word `ObjectPool` and Excel `MBD*` object storages, PowerPoint embedded OLE objects and ActiveX controls are listed in `notable` with the SHA-256 of their bytes (inflated bytes for PowerPoint), the ProgID when the object says one, and the same "declaration, not a verdict" note. Nothing is unpacked or run. Excel 4.0 macro sheets are `macro-sheet` notables and content parts.
- **Encryption.** A document with the encryption or obfuscation flag (Word), a `FILEPASS` record (Excel) or an encrypted Current User token (PowerPoint) is refused as password-protected. No password, XOR or RC4 key is tried. Word 6/95 and Excel 5/95 files are named and refused.
- **Text.** Word reads the piece table (compressed Windows-1252 and UTF-16 pieces), styles, paragraph and character properties and tables; headers and footers are split per section and type; comments carry author and date; footnotes and endnotes are notes. Tracked changes follow the Open XML rule (inserted text kept and flagged, deleted text left out, counted). Field instructions are recorded, never evaluated, and external hyperlink targets are listed. Excel reads every cell record type with the shapes of the Open XML reader (formula kept apart from the cached value, dates in the 1900 and 1904 systems, hidden and very hidden sheets, merged ranges). Formulas are decoded from the BIFF8 token stream to A1 text; a token the reader cannot decode leaves `formula: null`, keeps the cached value and is counted as `undecoded-formulas` with a diagnostic naming the token. PowerPoint follows the newest edit in the edit history for every slide, then reads slide order, layout, hidden flag, title, shape text, hyperlinks and notes; if the history cannot be followed it scans the stream and says so.
- **Not decoded, counted as omissions:** pictures, drawings and text boxes, charts, OLE and ActiveX content, Word list numbering text, Excel comment text, PowerPoint tables (a legacy deck stores them as grouped rectangles), media.
- **External references** (hyperlinks, external workbooks, linked media, run-program actions) are listed as written and never followed.
- **Limits** are the Open XML ones where they apply (`max_file_bytes`, `max_decoded_bytes`: every stream and every inflated PowerPoint object is charged to it), plus the structural caps in each reader (record depth, edit-chain length, step budgets, cells per row); every declared count, size and offset is checked against the stream before it is followed.
- **Verification.** Word files come from the real macOS producer (`textutil -convert doc`), with its plain-text reading as the oracle, and from a spec-based encoder for features textutil cannot write (comments, footnotes, tracked changes, hidden text, encryption flags, damaged tables). No producer for `.xls` or `.ppt` is installed on this host: those fixtures are assembled byte by byte from [MS-XLS] and [MS-PPT] by encoders written separately from the readers, so they prove the readers match the specification as read, not that every real Excel or PowerPoint file reads. Hostile inputs (truncation at every offset, declared 4 GiB sizes, cycles, overlapping records, inflate bombs, deep nesting) are in the `*Hostile.test.ts` files.

## Text view

`text` renders each content item as Markdown: headings, bullet lists, tables, comments, footnotes, slide sections, and worksheet rows as `| row | A | B |` with a formula shown as `value {=FORMULA}`. It is a derived reading in document order: layout, styles, pictures, charts and reading order beyond the order in the file are not preserved, and the omissions say what each read left out.

## Limits

- A file is read into memory (`max_file_bytes`, default 128 MiB, up to 1 GiB). The package is decompressed against `max_decoded_bytes` (default 512 MiB, up to 2 GiB); a part that would pass it is named in `diagnostics`, coverage is `partial` and the continuation names the limit. A budget too small for `[Content_Types].xml` itself fails the call with a resource error.
- One XML part is read at most 128 MiB and 256 levels deep. A part parsed into a tree (everything except worksheets) may hold 2 million elements; a worksheet is streamed and may hold 64 million. The XML reader refuses any DOCTYPE, so no entity is declared, expanded or fetched; a part that is not well-formed is named and the rest of the document is still read.
- Text in an item is cut at 32,768 characters and a worksheet cell's value at 4,096 (both counted as omissions); a number format is cut at 256. A paragraph lists at most 100 hyperlinks and 100 field instructions, a slide at most 100 hyperlinks; the rest are counted. A table item keeps at most 200 rows. A report lists at most 200 diagnostics and 200 package problems.
- A page holds at most about 2 million characters of JSON (or text): when it is full, `page.next` continues after the last item it holds, so a page can return fewer rows than `limit`.
- A row number outside 1 to 1,048,576, a cell reference outside A1 to XFD1048576, an outline or list level outside 0 to 8 and a similar number are clamped, and a bad cell reference is named in diagnostics.
- A ZIP with more than 200,000 members is refused. A repeated member name, or two part names that differ only in letter case, keeps the first and is reported as a problem. A relationship type counts as `officeDocument`, `hyperlink` and so on only under the Office, package or Microsoft relationship type families, so a decoy type from elsewhere cannot pose as one.

## Verification

`src/officeDocument/officeDocument.test.ts` builds Word files with the real macOS producer (`textutil`) and compares the text with textutil's own plain-text reading; Excel and PowerPoint packages are assembled from the schemas' markup because no producer is installed on this host. The tests cover styles, lists, links, fields, tracked changes, hidden text, equations, content controls, tables, comments, footnotes, headers, formulas and cached values, shared and array formulas, dates in both systems, hidden and macro sheets, slides with notes, a VBA project with its hash, external relationships, refusals (password-protected, legacy, not a ZIP, corrupt), a DOCTYPE with an external entity, paging and the decompression budget. `tests/acceptance/applications/officeDocument.test.ts` runs the compiled CLI and a real stdio MCP client against the same files and compares the evidence.

## Not done (F12)

PDF is a separate tool (see its guide). Word text boxes, list-number text, symbol mapping and picture decoding; Excel comment text, defined-name formulas, chart content and BIFF5 files; PowerPoint tables, shape names, comments and master text; for all legacy files, decryption, signature verification and the content of embedded OLE objects. VBA module source (the macro project is hashed, not unpacked) and XLM formula analysis; comments, charts and embedded objects' content; spreadsheet tables, pivot caches and defined-name targets; document hyperlink targets inside worksheets; hosted views; a `verify:formats:documents` lane over a corpus of real producer files.
