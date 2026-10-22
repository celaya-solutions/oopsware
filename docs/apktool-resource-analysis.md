```text
Document:    Apktool resource decoding
Version:     v1.0.4
Author:      Celaya Solutions
Contact:     hello@celayasolutions.com
Date:        2026-10-22
SHA256:      4778fc283f6c4a8b171b1851a8383a44b9da9f842995c990479663a04d073d48
Chain:       solana-mainnet
Tx:          21k67cRP8uW9ViBJLvQppSk3qPmstnC6Dv6My8PzEL7o1h14L4fAvx12DxdUDVLwpNFnfBbKBcgMiYeSYTr7jFLm
License:     All Rights Reserved / Celaya Solutions
```

# Apktool resource decoding

Oopsware decodes Android resource tables and the binary manifest through the
caller's Apktool launcher. This completes the static triad for Android
targets: Java/Kotlin sources through the JADX family, engine-grade
decompilation through JEB, and resources through this family. Oopsware never
installs Apktool or a Java runtime.

## Supply tools

Use Apktool 2.7.0 or newer (verified with 2.7.0 and 3.0.3 on Linux) and a Java runtime the
launcher can find. Select the launcher through the environment:

```sh
# Optional: absolute path to the apktool launcher (upstream wrapper or a
# java -jar script); without it, apktool resolves from PATH.
export REA_APKTOOL_COMMAND=/absolute/path/apktool
```

Readiness is `oopsware inspect-apktool-client`: it runs `apktool --version` and
reports the resolved launcher, its selection source, and its version. A
missing launcher reports `capability_unavailable` with the
`REA_APKTOOL_COMMAND` remediation rather than attempting an installation.
`binary_session` uses the same host probe for tool availability; it does not
validate a particular APK or guarantee that the selected input can be decoded.

Client inspection and decode results disclose the following reported-version
advisory windows without refusing otherwise compatible launchers:

| Advisory                                                                                              | Reported version window                          | Host scope |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ---------- |
| [CVE-2024-21633](https://github.com/iBotPeaches/Apktool/security/advisories/GHSA-2hqv-2xv4-5h5w)      | Before 2.9.2                                     | All        |
| [GHSA-vgwr-4w3p-xmjv](https://github.com/iBotPeaches/Apktool/security/advisories/GHSA-vgwr-4w3p-xmjv) | Before 2.9.3                                     | Windows    |
| [CVE-2026-39973](https://github.com/iBotPeaches/Apktool/security/advisories/GHSA-m8mh-x359-vm8m)      | 3.0.0 release line through versions before 3.0.2 | All        |

The 2026 advisory names 3.0.1 and its 3.0.2 fix. Inclusion of 3.0.0 is
source-derived: [tagged 3.0.0](https://github.com/iBotPeaches/Apktool/blob/f770b39e425af4fa6ac4ca1e9ea6c4824339c6d3/brut.apktool/apktool-lib/src/main/java/brut/androlib/res/table/ResTypeSpec.java)
passes type names through unchanged; the [3.0.2 patch](https://github.com/iBotPeaches/Apktool/commit/65dd8480dfcb63068562ffaa527f71bb0a9f772c)
validates those names at their owner before they reach the output-path producer.
Prereleases before the fixed release are conservatively disclosed; the exact
`-dirty` downstream marker is compared as a release while preserving its spelling.
This is version guidance, not verification of a particular prerelease or decoder.

A launcher version does not prove the decoder's contents, execution platform,
downstream backports, or overall safety. Windows applicability uses the selected
local host; an opaque wrapper may run another engine. A missing warning means
only that none of these version/host windows matched. Verify the selected
decoder's patches before decoding untrusted APKs; the compatibility floor above
is not a security recommendation. REA does not fetch advisories at runtime.

On Windows, a `.bat` or `.cmd` launcher (such as Chocolatey's `apktool.bat`)
runs through an explicit `cmd.exe /d /s /c` call. That call has no AutoRun,
no delayed expansion, and quotes every argument. A launcher path that
contains `"`, `%`, `^`, `!`, `&`, `|`, `<` or `>` is reported as
`not_configured` instead of being passed to `cmd.exe`. If REA's temporary
decode paths contain those characters, decoding through a batch launcher
reports `capability_unavailable`.

## Answer an analyst question

```sh
oopsware inspect-apktool-client
oopsware decode-android-resources /targets/Example.apk
oopsware decode-android-resources /targets/Example.apk --locale de
oopsware decode-android-resources /targets/Example.apk --locales de --locales pt-BR
oopsware decode-android-resources /targets/Example.apk --locales de --locales pt-BR --string-tables-only
oopsware decode-android-resources /targets/Example.apk --no-strings
```

Equivalent MCP methods are `inspect_apktool_client` and
`decode_android_resources`. The decode request takes `path`, an optional
primary `locale` (project `res/values-<locale>/strings.xml` instead of the default
table), `locales` (repeatable array of additional localized string tables to project
from the same single decode pass), and `include_strings` (default true). Regional locales such as `pt-BR`
select Android's `values-pt-rBR`. A three-digit region such as `es-419`
selects `values-b+es+419`; `es-r419` is rejected because Android's legacy
`-r` form requires a two-letter region. Android qualifiers such as `pt-rBR`
and `b+zh+Hans+CN` may also be supplied directly.

Set `string_tables_only: true` (CLI `--string-tables-only`) to return string
entries only inside `string_tables`, including when selecting a single table.
The top-level `strings` array is then empty by request; it does not establish
that the primary table is empty. Table status, counts and coverage still describe
the examined source. This avoids repeating primary entries in multi-locale
responses and charges the aggregate output budget for one copy per table.
Omitting the option preserves existing responses. `include_strings: false`
still suppresses all string projection, including in this mode.

## Interpret the result

- **An owned APK snapshot is digested and decoded.** `target.sha256` and
  `target.bytes` bind the observation to the exact APK that was decoded.
  The Evidence subject carries the same snapshot digest and caller-selected
  path, including when the original file changes during decoding.
- **Metadata comes from apktool.yml as apktool printed it.** Version codes
  keep their own spelling (`'7'` versus `7`); `package_name` is read from
  the decoded manifest, not inferred.
- **The manifest is the decoded text**, bounded at 512 KiB and reported as
  truncated when larger.
- **Strings are projected verbatim.** Escaped entities stay escaped, and
  entries containing nested markup (`<b>`, `<xliff:g>`) are counted as
  unparsed rather than flattened — the limitation names the examined count.
  Malformed XML and a wrong document root are whole-document projection
  failures: the result is partial, the failure reason is disclosed, and entry
  counts remain unknown. They are not counted as one unsupported string.
  The default table is bounded to 2000 entries with partial coverage when more
  exist. `locales` lists observed regular `strings.xml` tables whose exact
  `values-<locale>` directory is selectable by the request's locale grammar.
  Locale suffixes allow up to 23 ASCII characters, derived from Apktool's
  language, script, region, and variant fields; for example,
  `b+sr+Latn+RS+REVISED` selects that exact table.
  Other table directories, including combined qualifiers such as
  `values-en-rUS-v21` and `values-mcc310-fr`, are named in limitations with
  their source spelling. They are not advertised as selectable locales;
  REA does not infer Android's runtime resource matching. Non-regular
  strings-table paths are disclosed with partial coverage. Discovery uses
  the same bounded traversal as the file count; filesystem failures remain
  failures rather than being interpreted as missing tables.
  When multiple tables are requested with `locales`, `string_tables` records
  each projected table with its locale, status (`present`, `missing`,
  `oversized`, `malformed`, or `skipped`), entry counts, and coverage,
  bounded at an aggregate budget of 10,000 strings and 32 MiB XML. When `locales`
  is omitted and `string_tables_only` is not true, legacy single-table payloads are preserved
  without adding `string_tables`.
- **Smali is skipped by design** (`apktool d --no-src`): Java-source
  recovery belongs to the JADX family. Resource smali edits and rebuild are
  a follow-up lane with mutation authority.
- **Workspaces are owned and short-lived.** Decoding happens in a
  provider-owned temporary directory that is removed before the result is
  returned. The APK snapshot and framework cache both live inside this directory.
  If removal fails, the result names the residual path and the provider retains
  ownership for a cleanup retry on close, including failed decodes.

## Resource and lifecycle limits

- The decode runs with a 600 s deadline and a 4 MiB output capture budget;
  a stopped decode reports `provider_timeout` and exceeded budgets report
  `resource_constraint`.
- Manifest reads are bounded to 512 KiB before decoding UTF-8. Strings XML
  reads are bounded to 8 MiB; larger documents are skipped with partial
  coverage and an explicit limit, rather than reported as missing.
- `decoded_file_count` is capped at 100,000 files; the cap is reported in
  the limitations when hit.
- An ordinary nonzero decode exit surfaces as `unsupported_target` naming
  the caller-selected APK, with Apktool's diagnostic and captured output.
  Launcher startup, ownership preparation, signal termination and incomplete
  output collection remain provider failures; they do not establish that the
  selected APK is unsupported.

## Real verification

`npm run verify:apktool -- --apk PATH` exercises both operations against a
real launcher. Record: apktool 2.7.0-dirty (Debian packaging) on Linux with
OpenJDK 25 against a signed aapt2-built probe APK carrying two resource
locales — launcher version, on-disk digest agreement, apktool.yml metadata
(1.2.3, SDK 24–34), manifest package agreement, default and `de` string
tables projected. Parser goldens in the test suite come from the same
decode. See `docs/testing.md` for the lane summary.

The table-only projection supports selected locales without repeating the decode.
See the [testing guide](testing.md) for provider verification scope.

This qualifies selected resource facts, not application execution or independent
binary resource-decoder completeness.
