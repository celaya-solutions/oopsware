```text
Document:    JVM class file, JAR and AAR inspection (format expansion F02)
Version:     v1.1.1
Author:      Celaya Solutions
Contact:     hello@celayasolutions.com
Date:        2026-10-21
SHA256:      e7ecca9e174325b2793803f6328a9d871f3021441a09faa8aeecce946ef9d279
Chain:       solana-mainnet
Tx:          4N1noLWeQ2qqeXmbUVSaTHm92YWQxw3vUfDP1JaFrM1tKiVpZwf86zAdoP5arHP98qWcsmwLtAPjDRDSnF4PeMUP
License:     All Rights Reserved / Celaya Solutions
```

# JVM class file, JAR and AAR inspection

Four tools cover format expansion F02 (milestone P2). They read one
explicitly selected local file from its bytes. Nothing is loaded into a JVM:
no class initializer, annotation processor or `main` runs, and no dependency is
resolved or fetched.

| Tool (MCP / CLI)                                | Answers                                                                                                                                                                                                                          |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inspect_jvm_artifact` / `inspect-jvm-artifact` | What is in a class file, JAR or AAR: manifest, services, module descriptors, signature files, per-entry digests, multi-release variants, embedded JARs, AAR manifest and JNI libraries, and a page of classes.                   |
| `inspect_jvm_class` / `inspect-jvm-class`       | One class: version, flags, fields, methods, annotations, records, nest, permitted subclasses, inner classes, bootstrap methods, module descriptor, every attribute with its byte range, and every class the constant pool names. |
| `inspect_jvm_method` / `inspect-jvm-method`     | One method: a page of instructions (javap mnemonics and operands, pc, byte offset, source line), exception table, line numbers, local variable names, and every invocation, invokedynamic site, field access, type and constant. |
| `decompile_jvm_class` / `decompile-jvm-class`   | Inferred Java source for one class and its nested classes, rebuilt by the installed Vineflower, with every input's digest, untrusted methods and uncertain lines listed.                                                         |

```sh
oopsware inspect-jvm-artifact ./app.jar --json
oopsware inspect-jvm-artifact ./library.aar --start 500 --limit 500 --json
oopsware inspect-jvm-class ./Main.class --json
oopsware inspect-jvm-class ./app.jar --class com.example.Main --release 21 --json
oopsware inspect-jvm-method ./app.jar main --class com.example.Main --json
oopsware inspect-jvm-method ./Util.class parse --descriptor '(Ljava/lang/String;)I' --json
oopsware decompile-jvm-class ./app.jar --class com.example.Main --json
oopsware decompile-jvm-class ./classes/com/example/Shapes.class --siblings --json
```

MCP input: `path` (absolute); for the class and method tools a selector of
`class` (binary `com.example.Main` or internal `com/example/Main`), `entry`
(exact member path), `container` (an embedded JAR such as `classes.jar`) and
`release` (multi-release resolution); `method` and `descriptor` for the method
tool; `start` and `limit` (classes: 1–5000, default 500; instructions:
1–65,535, default 2000); `max_file_bytes` (default 128 MiB, at most 512 MiB)
and `max_decoded_bytes` (decompressed archive members per call, default
512 MiB, at most 2 GiB).

## How a file is read

- **Class file**: `0xCAFEBABE` followed by a major version of at least 45. A
  universal Mach-O starts with the same magic; its next word is a small
  architecture count, which is how the two are told apart everywhere in
  Oopsware (the artifact graph no longer records class files as Mach-O).
- **JAR / AAR / ZIP**: a ZIP whose members decide the role. An archive with
  `AndroidManifest.xml` and `classes.jar` is an AAR; one with a manifest or
  class members is a JAR. A file name that disagrees with the bytes is reported
  in `container.name_conflict`.
- **Embedded JARs** (an AAR's `classes.jar` and `libs/*.jar`, or libraries
  packed in a JAR) are opened one level deep inside the same decompression
  budget. Each class reports the `container` it came from. JARs inside
  embedded JARs are listed, not opened.

The parser follows chapter 4 of the Java Virtual Machine Specification
and the JAR File Specification. It decodes the constant pool
(modified UTF-8 names are checked, not repaired), fields, methods, `Code`,
exception tables, `LineNumberTable`, `LocalVariableTable` and
`LocalVariableTypeTable`, `Signature`, annotations and parameter annotations
(rendered Java-like, visible and invisible kept apart), `AnnotationDefault`,
`MethodParameters`, `Exceptions`, `InnerClasses`, `EnclosingMethod`,
`NestHost`/`NestMembers`, `PermittedSubclasses`, `Record`, `BootstrapMethods`,
`Module`, `ModulePackages` and `ModuleMainClass`. `StackMapTable`, type
annotations and `SourceDebugExtension` are located by byte range and marked
`skipped`. Attributes the specification does not define are kept as
`unknown`, as a JVM would ignore them.

Each attribute body is read inside its declared length, so a damaged body is
marked `malformed` and the next attribute is still read. A truncated or
damaged class keeps every fact read before the damage (`decode: "partial"`
plus the byte offset). Bytecode decoding stops at an undefined opcode or a
truncated operand and keeps the instructions before it; branch targets that
do not land on an instruction start are reported.

## Multi-release JARs

Every `META-INF/versions/N/` variant (N ≥ 9) is listed with its release. The
host JDK never chooses one:

- With `release`, the class tool reads the highest variant at or below that
  release, or the base class, exactly as a JVM of that release would, and only
  when the manifest declares `Multi-Release: true`.
- Without `release`, the base class is read; when only versioned variants
  exist, the tool asks for `release`.
- `selection.variants` always lists every variant, and `selection.basis` says
  how the one read was chosen (`file`, `only`, `base`, `release` or `entry`).
- Versioned members in a JAR that does not declare `Multi-Release` are
  reported with `multi_release.ignored: true`.

## Signatures and digests

Signature files (`META-INF/*.SF` with their `.RSA`, `.DSA` or `.EC` block) are
listed with their declared digest attributes and entry counts. **No
certificate is checked and no signature is verified.** Per-entry digests the
manifest declares (`SHA-256-Digest`, `SHA-384-Digest`, `SHA1-Digest`, ...) are
recomputed over the member bytes: `entry_digests.matched`, `mismatched`,
`missing` and `unchecked` say what was found. A match shows the content agrees
with the manifest, not that a trusted signer produced it.

## AARs

For an AAR the report adds the text `AndroidManifest.xml` package and SDK
levels (compiled binary XML is reported, not decoded), each JNI library under
`jni/<abi>/` with its size, SHA-256 and ELF class and machine, resource and
asset counts, and other parts such as `R.txt`, `proguard.txt` and `lint.jar`.
To analyze a native library, extract the AAR with `extract_artifact` and open
the library with the native tools; its digest here identifies it.

## Reconstructed source (decompile_jvm_class)

Reconstruction uses [Vineflower](https://github.com/Vineflower/vineflower)
(Apache-2.0), which the owner installs; Oopsware never installs it. It is
found only at fixed locations (`/opt/homebrew/opt/vineflower/libexec`,
`/usr/local/opt/vineflower/libexec`, `/usr/share/java/vineflower.jar`) and
runs only when the jar's SHA-256 is an admitted build. Admitted today:
Homebrew `vineflower` 1.12.0 (built from source,
`a72cdc807e6e539eb467906f2576569eda618a57e6701c32021a5018e62932af`). The
GitHub release jar of 1.12.0 has a different digest and is not admitted
until it passes the same checks. Without an admitted build the tool returns
`AnalysisCapabilityUnavailableError` and the bytecode tools still work.

Tool discovery can be cached, but each run hashes the Vineflower jar again and runs a private copy of those verified bytes. A changed jar or a missing Java executable is reported as unavailable.

How a run works:

1. The class is selected as for `inspect_jvm_class`. The tool walks to its
   outermost class and gathers every nested class from the same JAR and
   multi-release release. A loose class file is decompiled alone unless
   `siblings: true` asks for its `Outer$*.class` neighbours.
2. Copies of those class files, plus the containing JAR as type context, are
   written to a scratch directory. Vineflower runs in its own Java process
   (fixed Java 17+ path, `-Xmx` from `max_heap_mib`, `timeout_ms`, an empty
   environment, its own home and temp directories). It reads the classes as
   data; no target class is loaded or run. The scratch directory is removed
   after process cleanup is confirmed. Failed cleanup retains the exact process
   owner and scratch for retry before another run. Diagnostic messages replace
   scratch paths with `<scratch>`.
3. The result names every input by entry and SHA-256, the decompiler build
   and Java runtime, and returns the text with `confidence: "inferred"`.

What the result does not trust:

- **Untrusted methods.** Each method is also decoded by Oopsware's own
  reader. A method whose bytecode does not decode cleanly is listed in
  `untrusted_methods`: Vineflower can print a plausible body for bytes the
  JVM would reject (an undefined opcode became `return 10` in testing).
- **Uncertain lines.** `$VF:` comments, and lines where Vineflower printed an
  invokedynamic call as pseudo-Java (`SwitchBootstraps.typeSwitch<"typeSwitch", ...>`),
  are listed in `decompiler_notes`. Vineflower 1.12.0 does this for Java 21
  pattern switches without a warning; the result is then `partial`, not
  `complete`.
- **Missing nested classes** are listed in `missing_nested`.

The text is a reading aid, not the original source: local names come only
from debug tables, comments and formatting are gone, and it may not compile.

## Limits and what is not covered

- Reconstructed source is inferred (see above); the hosted service does not
  run a decompiler.
- No verification: stack maps are not decoded and code is not type-checked.
  Signatures are not verified.
- JMOD files, Android DEX and APK classes, and Kotlin metadata are out of
  scope here (APK and DEX belong to the Android tools).
- A single member over 256 MiB is refused; a page of classes is bounded by
  `limit`, and the decompression budget by `max_decoded_bytes`.
- The public library does not decode classes yet; uploads keep the ZIP member
  list and byte preview.

## Verification

- `src/jvm/jvmReports.test.ts` builds classes, a signed modular JAR, a
  multi-release JAR (releases 8, 11, 17), a JAR with undeclared versioned
  members and an AAR with the installed JDK (`javac`, `jar`, `jarsigner`,
  `keytool`) at test time, and checks every method of every class against
  `javap`. No binary fixture is committed; without a JDK 17+ the suite is
  skipped.
- `src/jvm/jvmDecompile.test.ts` runs the installed Vineflower over the same
  fixtures: nested classes, outer-class selection, siblings, multi-release,
  a corrupted method flagged as untrusted and a pattern switch flagged as
  partial. It is skipped when no admitted build is installed.
- `tests/acceptance/applications/jvm.test.ts` checks that the compiled CLI and
  a real stdio MCP client return identical Evidence for all four tools
  (decompilation only when Vineflower is installed).
- `npm run verify:formats:jvm` (JDK 21+) builds a Java 21 sample and reads it,
  the JDK's demo JARs and any JARs named in `REA_JVM_LANE_JARS`
  (colon-separated) through the CLI, then compares every method of every class
  with `javap`. On 2026-10-19 it passed for the sample plus the Guava
  32.1.3, Bouncy Castle 1.84 (signed, multi-release 9–25) and `Base.jar` JARs
  that Ghidra ships:
  13,637 classes, 97,192 methods and 2,782,061 instructions matched javap
  (JDK 21.0.12.1). The lane also decompiles 25 top-level classes per JAR and
  checks that a reconstructed ordinary class recompiles with `javac` while
  the pattern-switch class is flagged `partial`; on the same day all 75
  sampled Guava, Bouncy Castle and `Base.jar` classes reconstructed with no
  untrusted methods or notes (Vineflower 1.12.0 on Java 27).
