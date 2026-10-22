```text
Document:    Oopsware Workspace Design and Workflow Review
Version:     v1.1.1
Author:      Celaya Solutions
Contact:     hello@celayasolutions.com
Date:        2026-10-13
SHA256:      cfaa268ccaf8574015cd9a9f1beb55ddd159d6428e7718c11d4bd95e1420b691
Chain:       solana-mainnet
Tx:          46g4nQawjkPjjRg14oUGNFrfv3ksQgcSMQzr3khVXY8gf9qFzgGecHMoHqyEpqbcoHkURvm1U3Aeoi2jsoZPc2xG
License:     All Rights Reserved / Celaya Solutions
```

# One workspace from file to evidence

Oopsware now keeps the selected target, preview, tool inputs, results, comparisons,
and evidence in one workspace. The design takes its cue from Vercel's neutral
palette and uses owned shadcn components with Radix behavior, Tailwind tokens,
and locally bundled Geist fonts. Oopsware still runs locally.

## Workflow findings and changes

| Finding                                                                      | Change                                                                                                                                                                                  |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Choosing a tool and starting it each changed pages.                          | Tools and results are workspace tabs; the target stays visible.                                                                                                                         |
| The opener, counts, and repeated headings pushed useful work below the fold. | The opener collapses after selection; targets use a compact switcher.                                                                                                                   |
| Every file offered native, Apple, and Android actions.                       | Header observations and labeled filename hints select relevant entry points. All canonical tools remain searchable.                                                                     |
| Switching tools discarded arguments.                                         | Each tool keeps its draft during the tab's lifetime. Verified target inputs are prefilled through the same schema resolver used by forms. Output paths and paired inputs stay explicit. |
| Evidence required expanding a row and following another button.              | One click opens the complete saved result inline.                                                                                                                                       |
| Files could only be added through the picker or path form.                   | Drop individual files anywhere in the workspace. A folder drop explains how to open its local path.                                                                                     |
| Background session checks filled the history.                                | An authenticated read endpoint supplies session context without creating a run. Explicitly requested session tools still create runs.                                                   |
| File and command dialogs did not trap or restore keyboard focus.             | shadcn Dialog handles focus, Escape, accessible titles, and return focus. Workspace tabs use Radix tab semantics.                                                                       |

The sample flow is now: open the sample, inspect it, export its result. These
three actions stay on the same page. Opening a file alone does not execute it
or start a decompiler. Tool effects remain visible before execution.

## Theme and components

The shared theme lives in `web/src/theme.css`. Dark mode uses near-black
surfaces, neutral borders, and a white primary action. The matching light theme
preserves an existing saved choice. State colors remain reserved for success,
work in progress, and errors. Fonts ship inside the local CSS bundle.

| Layer                                          | Source                               |
| ---------------------------------------------- | ------------------------------------ |
| Color, radius, fonts, and density              | `web/src/theme.css`                  |
| Owned shadcn Button, Badge, Tabs, Dialog       | `web/src/components/ui/`             |
| File coverage cards                            | `web/src/components/FileSupport.tsx` |
| Target suggestions and verified input bindings | `web/src/targetSupport.ts`           |
| Shared schema reference resolution             | `web/src/schema.ts`                  |
| Local Tailwind and esbuild pipeline            | `scripts/build-dashboard.mjs`        |
| shadcn project configuration                   | `components.json`                    |

The primitives were copied from shadcn's official `new-york-v4` registry and
adapted to the local import paths. The workspace uses custom compositions,
without replacing Oopsware's CLI, MCP, provider, or evidence contracts.

## File coverage

Any regular local file supports paged text, hex, and string previews. Individual
browser uploads retain the existing 128 MiB limit; larger files and application
folders can be opened by local path. The file support view covers native,
Android, Apple, web/Electron, .NET/Java, archives/installers, firmware, and
bytecode, with direct links to the corresponding tool search.

Native header observations take priority over misleading extensions. Preview
paging retains the original header guidance for the same target version.
Filename hints are labeled and never replace the provider's validation.

Deep Android analysis currently accepts a standalone APK through the user's
JADX engine. Raw DEX, AAB, APKS, and XAPK have preview and applicable inventory
entry points; the UI does not claim decompilation, bundle conversion, or split
APK assembly. Java preview does not imply general JVM decompilation. Archive
recognition does not imply that every compression format has a reader.

## Verification

Focused HTTP and file-boundary checks cover file previews, tool execution,
session isolation, saved runs, authenticated session reads without history
writes, real native headers, Android guidance, and canonical path defaults.
Dashboard type checking, the runtime build, and local static checks cover the
implementation. Browser checks cover the sample's completed inspection,
inline result view, both themes, keyboard search, and preserved tool drafts.
Preview and results fit a 390-pixel viewport without page overflow. The sample
export was saved and parsed as a completed run with its full result.

These checks do not establish real Android device, JADX, Apktool, JEB, Ghidra,
IDA, or alternate-host behavior. Their existing provider verification lanes
remain required before expanding those claims.
