```text
Document:    Oopsware Native Version Comparison Guide
Version:     v1.1.1
Author:      Celaya Solutions
Contact:     hello@celayasolutions.com
Date:        2026-10-13
SHA256:      f8c5cdd8c209ba501407a2d42f7334fbef1441da5ff856e5b61d70bb37f977fc
Chain:       solana-mainnet
Tx:          3vASp9RtLgVCNgLoXjifm46hbFtghZFFUfjdf8EsqsTK339BmVHnR24ywcWFaSiwH4RbCqUV3QPF9q8STc4Xs6mC
License:     All Rights Reserved / Celaya Solutions
```

# Compare two native versions

Use this workflow to answer: which functions appear related, which observed
representations changed, and which pairs still need investigation? It reads
compiled programs with an existing provider. It does not run either program or
prove that two functions behave the same.

## Start with the two files

Use the two paths selected by the caller. Call `compare_native_versions` if the
connected server advertises it. Supply each side as `{ "path": "/absolute/path" }`.
Include `expected_sha256` on that side when a known digest must match. Select an
available `provider_id` when the investigation needs a particular engine.

```json
{
  "left": { "path": "/cases/before" },
  "right": { "path": "/cases/after" },
  "provider_id": "hopper"
}
```

The workflow collects function inventories and dossiers in its own analysis
sessions and returns the evidence with its result. It leaves the caller's active
native session alone. Both files must have the same supported format and
architecture: a pair of thin Mach-O arm64 files or a pair of ELF x86-64 files.
Cross-format and cross-architecture matching are outside this release. Provider
availability and tested host coverage are separate from the file-format check.

If a comparison exceeds its reported capacity, preserve that limit on the
whole-binary result. Use `analyze_function` and `compare_functions` for a selected
pair rather than treating an unexamined function as absent.

If this tool is absent, preserve that limitation. Existing `analyze_function` and
`compare_functions` can inspect caller-selected pairs, but do not discover pairs
across the two complete binaries by themselves.

## Read the evidence behind each pair

Read the candidate's method, supporting signals, alternatives, collisions, and
unavailable facets. A shared name or high similarity score is a lead. Neither
establishes function identity or equivalent behavior. Check strings, constants,
imports, control flow, and source locations where the provider supplies them.

Unique exact matches can proceed directly to comparison. For ambiguous cases,
inspect both inline dossiers and select the intended addresses. Use
`compare_functions` with those two complete `analyze_function` Evidence records
for focused drill-down without recollecting both binaries. If the pair is known
before collection, supply `selected_pairs` to `compare_native_versions`:

```json
{
  "left": { "path": "/cases/before" },
  "right": { "path": "/cases/after" },
  "selected_pairs": [
    { "left_address": "0x100001000", "right_address": "0x100002000" }
  ]
}
```

Use addresses actually returned for those files. Do not copy example addresses
into a live investigation. Exact comparison reports the dimensions it examined;
representation differences, missing provider data, and changed analysis profiles
can leave the conclusion unknown. Analyst selection resolves which pair to
inspect; it does not establish semantic equivalence.

## Finish with a traceable answer

Describe established comparisons separately from proposed pairings. Name added
and removed _candidates_, ambiguous alternatives, and functions that could not be
examined. Stripping, inlining, compiler changes, and duplicated helpers can hide a
relationship or create a look-alike. An unmatched function does not by itself
prove that a feature was added or removed.

Cite both artifact digests and the supporting Evidence IDs. Keep the returned
limitations in the report. If a behavior claim needs execution, record the
remaining question and the controlled runtime observation it would need.

In the dashboard, run the same tool from **Tools**. **Runs** pages through saved
summaries; select a run to load its complete result or download it. Use
`export_evidence_bundle` when the investigation needs a portable session bundle.
Do not treat a history summary as the full analysis record.
