```text
Document:    Android DEX, APK, App Bundle, APK set and XAPK inspection (format expansion F04)
Version:     v1.1.1
Author:      Celaya Solutions
Contact:     hello@celayasolutions.com
Date:        2026-10-21
SHA256:      7c690f5693b07d9c7fc2d7654d131bb2ed46f6465b457bd0bb6f9c892c072018
Chain:       solana-mainnet
Tx:          2ugvqYaWy2bNCq2FybTZgLwZC6nf91fiTVKvWfYzu1cdxqhFiWc83KFvGnciMQTFn99Q2WniekaC18GHAzFYANKd
License:     All Rights Reserved / Celaya Solutions
```

# Android DEX, APK, App Bundle, APK set and XAPK inspection

Four tools cover format expansion F04 (milestone P3, plus the DEX-to-Java decompiler from roadmap item 5). The three inspection tools read one explicitly selected local file's bytes in process; the decompiler hands the bytes to two owner-installed tools. Nothing is installed, signed, verified, optimized or run, no device is contacted, and no Android SDK tool is needed at run time.

| Tool (MCP / CLI)                                        | Answers                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inspect_android_artifact` / `inspect-android-artifact` | What a `.dex`, `.apk`, `.aab`, `.apks` or `.xapk` is: manifests (binary and proto XML), resource tables, bundle modules and `BundleConfig.pb`, an APK set's `toc.pb` or an XAPK's `manifest.json`, every nested APK with its declared role, signature material (never verified), every DEX file with its checksum and signature recomputed, native libraries with their ELF machine, and a page of classes. |
| `inspect_dex_class` / `inspect-dex-class`               | One class: descriptor, flags, superclass, interfaces, source file, annotations with values, static fields with their encoded initial values, instance fields, and methods with exact DEX descriptors, code sizes, registers and parameter names from debug info.                                                                                                                                            |
| `inspect_dex_method` / `inspect-dex-method`             | One method's Dalvik bytecode: a page of instructions rendered as `dexdump` renders them, with addresses, file offsets, registers, literals, branch and switch targets and resolved references; try blocks, line positions, locals, and every reference the whole method makes.                                                                                                                              |
| `decompile_dex_class` / `decompile-dex-class`           | Inferred Java source for one class from an owner-installed, digest-pinned dex2jar 2.4 and Vineflower 1.12.0, with three checks: dex2jar's own error report, Vineflower's uncertainty notes, and whether every method the DEX declares is named in the text.                                                                                                                                                 |

```sh
oopsware inspect-android-artifact ./app.apk --json
oopsware inspect-android-artifact ./app.aab --entry base/dex/classes2.dex --limit 200 --json
oopsware inspect-android-artifact ./app.apks --container splits/base-master.apk --json
oopsware inspect-dex-class ./app.apk com.example.MainActivity --json
oopsware inspect-dex-class ./app.apks 'Lcom/example/MainActivity;' --container splits/base-master.apk --json
oopsware inspect-dex-method ./classes.dex com.example.Util parse --descriptor '(Ljava/lang/String;)I' --json
oopsware decompile-dex-class ./app.apk com.example.MainActivity --json
oopsware decompile-dex-class ./app.aab 'Lcom/example/Util$Parser;' --entry base/dex/classes2.dex --timeout-ms 300000 --json
```

MCP input: `path` (absolute); `container` names one APK inside an `.apks` or `.xapk`; `entry` names one DEX member (inside `container` when given); `class` is a descriptor (`Lcom/example/Main;`) or binary name (`com.example.Main`); `method` and, for overloads, `descriptor` pick a method; `start`/`limit` page classes and instructions; `max_file_bytes` and `max_decoded_bytes` bound the read. `decompile_dex_class` also takes `timeout_ms` (each tool run, default 120 s), `max_heap_mib` (each Java process, default 1024) and `max_source_bytes` (default 4 MiB).

## How a file is read

The bytes decide the kind. `dex\n` plus a three-digit version and NUL is a DEX file. A ZIP is an APK set when it has `toc.pb`, an App Bundle when it has `BundleConfig.pb` or a `<module>/manifest/AndroidManifest.xml`, an XAPK when a root `manifest.json` sits beside APK members, and an APK when it has a root `AndroidManifest.xml`. A ZIP without an Android layout is reported as `zip` and only its DEX members are read. A name that suggests another kind is reported as a conflict.

Members, and the APKs inside a set, are read in memory inside one `max_decoded_bytes` budget. A member that cannot be read is listed with the reason and makes the inspect facet partial; the other members are still read.

## DEX files

The header is checked first: the magic and version, the little-endian tag (a big-endian file is refused, as Android runtimes refuse it), `header_size`, and every index table's place in the file. The Adler-32 checksum and SHA-1 signature are recomputed and compared with the declared ones; a mismatch is reported, not repaired. The map list is listed with every item's type, size and offset.

Classes come from `class_defs` with their DEX location, so a class is never separated from the file that defines it. `inspect_dex_class` decodes class data, annotations (class, field, method and parameter), encoded values and code item headers. `inspect_dex_method` decodes the code: every instruction of DEX 035, 037, 038 and 039 renders exactly as `dexdump` from Android build-tools 37.0.0 renders it, including switch and array payloads where they sit in the code. DEX 040 and 041 are read by their published layout; no producer on this host writes them, so they are not claimed as checked.

A class defined in more than one DEX file is never resolved silently. When every definition is in byte-identical DEX files (an APK set repeats the base APK per variant), the first is read and the selection says `identical`; otherwise the call asks for `container` and `entry`.

## APKs and App Bundles

An APK's `AndroidManifest.xml` is compiled binary XML; a bundle module's `manifest/AndroidManifest.xml` is aapt2's protocol buffer form. Both are decoded to the same tree, rendered as XML text (references named through the resource table when it knows them), and read for facts: package, version, split names, SDK levels, requested permissions, features, libraries, application flags, components with their declared `exported` flags and intent filters, meta-data, and a bundle module's `dist:module` delivery and fusing. Attributes are matched by framework resource ID, so obfuscated attribute names still resolve. Nothing is inferred from defaults: an undeclared `exported` stays null, and a requested permission is a declaration, not a grant.

`resources.arsc` and `resources.pb` are read for packages, types, entry counts and configuration qualifiers as aapt2 prints them. A bundle's `BundleConfig.pb` is decoded field by field; `BUNDLE-METADATA/` members are listed, not read.

Signature material is recorded, never checked: JAR signature files under `META-INF/` and the APK Signing Block before the ZIP central directory, with each block's ID and a name for the known ones (v2, v3, v3.1, source stamp, verity padding, dependency info). Signature validity, certificates and signer trust are out of scope.

Native libraries under `lib/<abi>/` are hashed and their ELF class and machine compared with the ABI directory; a library in the wrong directory is a diagnostic.

## APK sets and XAPK

An `.apks` set's `toc.pb` (bundletool's `BuildApksResult`) is decoded: variants with their targeting, modules with delivery type and dependencies, and every APK description with its split ID, master flag and targeting. Each APK in the set is opened and its manifest summarised. Paths the table declares that are missing, and APK members it does not declare, are listed. Base APKs are counted: a set built for several variants has one base master per variant, so `base.state` is `multiple` and reading one APK in full needs `container`. Which APKs a device would install is not evaluated.

XAPK has no formal specification. The reader admits APKPure's layout: a root `manifest.json` with `xapk_version` 2, `split_apks` (`base`, `config.*` and feature splits) and `expansions` (OBB files with install paths). Other layouts keep generic ZIP facts, and `xapk_profile` says `unknown`. No producer-made XAPK was available on this host, so the layout is admitted from APKPure's published format, not from a producer fixture; the registry keeps XAPK identification and inspection partial for that reason. The package name and version code in `manifest.json` are compared with the APKs' manifests.

## Decompiling a DEX class

`decompile_dex_class` reconstructs Java source for one class without JADX. It selects the class exactly as `inspect_dex_class` does (a class in byte-different DEX files needs `container` and `entry`) and works on every kind this family reads: a bare DEX, an APK, a bundle, an APK set or an XAPK.

Two owner-installed tools do the work; neither is part of the package:

- [dex2jar](https://github.com/pxb1988/dex2jar) 2.4 (Apache-2.0) converts the DEX file to class files. It is found only at `/opt/homebrew/opt/dex2jar/libexec/lib`, `/usr/local/opt/dex2jar/libexec/lib`, `/usr/share/dex2jar/lib` or `/usr/share/java/dex2jar`, never on `PATH`, and the shell launcher is never run. dex2jar is a directory of jars on one classpath, so the install is admitted by the SHA-256 of its whole jar set: the sorted `name:sha256` line of every `*.jar` in `lib/`, joined with newlines (`src/androidPackage/dex2jar.ts`). The admitted set is Homebrew's dex2jar 2.4 (23 jars); any other set is reported as unavailable with the path and digest found.
- Vineflower 1.12.0, admitted for `decompile_jvm_class` (see [JVM inspection](jvm.md)), decompiles the converted class. dex2jar runs on the Java runtime that Vineflower's resolution finds.

Each run copies and hashes the complete dex2jar jar set and Vineflower jar again, then runs those verified private copies; cached discovery never authorizes changed tool bytes. Missing executables and unreadable or non-file jars are reported as unavailable.

Only the bytes of the DEX file that defines the class are copied, to a private `oopsware-dex2jar-*` scratch directory. dex2jar runs as `java -classpath <jar set> com.googlecode.dex2jar.tools.Dex2jarCmd -f -d -o classes.jar -e errors.txt classes.dex` with an empty environment, `user.home` and `java.io.tmpdir` inside the scratch, the requested heap and `timeout_ms`. The scratch is removed after process cleanup is confirmed, and its path is scrubbed from messages. If cleanup fails, the exact process owner and scratch are retained and retried before another decompiler run. The class, its outer classes and its nested classes are then decompiled from the converted JAR by the same code `decompile_jvm_class` uses, with the whole JAR as type context. The text comes back inline as inferred Evidence derived from the DEX file's SHA-256 (`selection` names its container and entry). Text over `max_source_bytes` is refused, not cut.

Then three checks, each `passed`, `failed` or `not_checked` with a reason:

- `dex2jar_translated`: dex2jar's text error report lists no failed method in the decompiled classes. Methods it could not translate are listed in `untrusted_methods` (`source: "dex2jar"`); their converted bodies only throw. A report too large to read gives `not_checked`.
- `vineflower_clean`: Vineflower left no `$VF:` note or unresolved invokedynamic line, and every converted method decoded cleanly in this repository's class-file reader (others are listed with `source: "class_file"`).
- `methods_present`: scans names from this family's DEX decoder. Missing names are listed in `missing_methods` and fail the check. Otherwise the check is `not_checked`: a name could be a call, another overload, or a member of a different class. Implicit constructors and folded static initializers also cannot establish method coverage from names alone. Synthetic and bridge methods and the enum's generated `values`/`valueOf` remain excluded.

The result remains partial while method declaration coverage is unverified. Failed or unchecked checks never hide the text. Passing checks do not prove a body is right: d8 and R8 lower code (synchronized blocks, try ranges, desugared lambdas) in ways dex2jar and Vineflower can turn into plausible but wrong Java. Read a suspect method's bytecode with `inspect_dex_method`.

Limits:

- One class (with its outer and nested classes) per call. dex2jar converts the whole DEX file that defines it every time, so time grows with the DEX file's size; raise `timeout_ms` for large ones.
- Nested classes defined in another DEX file of a multi-DEX package are listed in `missing_nested`, not gathered; decompile them by name.
- `methods_present` matches names only, anywhere in the text of the top-level class; overloads are not told apart.
- The hosted service does not decompile.

## Handing off to other tools

- Decompiled source: `decompile_dex_class` covers one class from any package kind. The JADX-backed tools (`inspect_android_package`, `inspect_android_class`, `inspect_android_method`) read one standalone APK with a caller-supplied engine; for a bundle-derived set, extract the chosen APK with `extract_artifact` and pass that file.
- Native code: extract a library listed in `native_libraries` with `extract_artifact` and open it with the native tools.

## Verification

Fixtures are built at test time by real producers (`tests/fixtures/androidProducers.ts`): `javac` and `d8` for DEX files, `aapt2` for binary and proto manifests and resource tables, clang with the SDK's `lld` for native libraries, `bundletool` for the App Bundle (base plus an on-demand feature module) and the split APK set, and `zipalign` with `apksigner` (v1, v2, v3) for the APK. No binary fixture is committed and nothing is installed on a device.

- Instruction and structure oracle: a listing rebuilt from this reader is compared line by line with `dexdump -d -a` for DEX 035, 037, 038 and 039 (`src/androidPackage/dex/dexdump.test.ts`).
- XML and resource oracle: decoded manifests, layouts and tables are compared with `aapt2 dump xmltree` and `aapt2 dump resources`; bundle files with `protoc --decode` against the `.proto` files bundletool ships.
- Decompiler: `src/androidPackage/androidDecompile.test.ts` runs the real dex2jar and Vineflower on d8-built classes (the content provider retains unverified method coverage; a synchronized method Vineflower cannot rebuild leaves the result partial with the text kept; a nested class decompiles its outer class; a class from an APK's second DEX and the same class in a bundle give the same text; a missing class and oversized text are refused). `tests/acceptance/applications/androidPackage.test.ts` includes one `decompile_dex_class` call through the CLI and MCP.
- Lane: `npm run verify:formats:android` builds the fixtures, runs the CLI on each kind, compares whole DEX files that d8 builds from large real JARs with `dexdump`, and decompiles a spread of 24 classes from those DEX files through the public CLI (`REA_ANDROID_DECOMPILE_SAMPLE` changes the number). The counts are reported, not asserted; the lane fails only when the tool errors in another way or the checks disagree with themselves. The earlier 2026-10-21 run reported 20 of 24 classes complete under the old name-only check. That does not establish method declaration coverage; the corrected check keeps those results partial.

Requirements for the producer checks: Android SDK build-tools 37.0.0 and platform `android-36` (`REA_TEST_ANDROID_SDK`, or the Homebrew `android-commandlinetools` root), bundletool (`REA_TEST_BUNDLETOOL_JAR`), a JDK 17 or newer, and clang. Without them the producer tests are skipped, not passed.
