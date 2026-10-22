```text
Document:    Static Android APK analysis
Version:     v1.0.2
Author:      Celaya Solutions
Contact:     hello@celayasolutions.com
Date:        2026-10-22
SHA256:      3a184b06d98355e02e9dd5c14706e8391c216b4bb46cfb5b5d0e528143819235
Chain:       solana-mainnet
Tx:          2AAPFyMREbPt2rJpq1Fo2E4F8kK4Y3Vv3XbqkqL4n5dw1kKEpTGRrf5WBAySZQGxxL1TFUr7iWK9TCzrpeXTD6wM
License:     All Rights Reserved / Celaya Solutions
```

# Static Android APK analysis

Oopsware wraps an existing headless JADX engine through `src/android/`. Its source is
kept as an unmodified, commit-pinned Git submodule; see
[upstream provenance](https://github.com/celaya-solutions/oopsware/blob/main/third_party/README.md). CLI and MCP use the same
application workflow and return artifact-bound Evidence inline.

This family is present on repository main and in npm 4.1.0. Check the
[released package boundary](installation.md#released-package-and-main) and the
connected server's tool list before selecting it.

On Linux, JADX launches an REA-owned process and requires a procps-compatible
`ps` on REA's `PATH`; see the shared
[Linux process prerequisite](installation.md#linux-owned-process-prerequisite).

## Optional package delivery

The MCP `inspect_android_package` request keeps complete output when `detail` is
omitted or `"complete"`. Select `detail: "summary"` explicitly to receive all
package, SDK and permission declarations, engine identity and class/resource
counts without decoded manifest text or duplicate raw provider replies. A
retaining session keeps the complete original Evidence and returns a distinct
linked `inspect_analysis_view` summary. This changes delivery, not JADX analysis.

Use the returned `normalized_result.parent_evidence_id` with
`inspect_analysis_view`, source kind `retained-evidence`, and
`view: {kind: "android", facet: "manifest", offset: 0, limit: 4096}` to read the
exact decoded manifest without reopening the APK. Offsets and limits count UTF-16
code units; follow `coverage.next_offset`. The page preserves `source_status` and
`reported_total_bytes`: exhausting retained text does not make a partial decoded
manifest complete. Complete source Evidence remains exportable under the existing
session lifetime. Servers without retention reject summary before starting JADX.
One-shot CLI output remains complete. Older servers require the existing complete
request after schema discovery. APK authenticity and runtime behavior remain
unverified.

## Supply tools

Use a **full JDK 17 or newer** (including its compiler module) and
[**jadx-headless-mcp 0.7.1**](https://github.com/1013503897/jadx-headless-mcp/releases/download/v0.7.1/jadx-headless-mcp-0.7.1-all.jar).
Verify the downloaded JAR's SHA-256 against
[Oopsware's pinned release metadata](https://github.com/morluto/rea/blob/main/src/android/JadxRelease.ts)
before using it. The following download and verification commands work for npm
package consumers as well as repository checkouts; the repository-only
`npm run fixtures:android` helper is not included in the npm package.

On macOS or Linux, choose a destination and verify the pinned digest:

```sh
mkdir -p "$HOME/.local/share/rea/android" &&
cd "$HOME/.local/share/rea/android" &&
curl -fL -o jadx-headless-mcp-0.7.1-all.jar https://github.com/1013503897/jadx-headless-mcp/releases/download/v0.7.1/jadx-headless-mcp-0.7.1-all.jar &&
if command -v sha256sum >/dev/null; then
  echo '6e5eacf500b64292bfb73c49797c1958f6ee44646e43e868039ae7feb573ff75  jadx-headless-mcp-0.7.1-all.jar' | sha256sum -c -
else
  echo '6e5eacf500b64292bfb73c49797c1958f6ee44646e43e868039ae7feb573ff75  jadx-headless-mcp-0.7.1-all.jar' | shasum -a 256 -c -
fi &&
export REA_JADX_MCP_JAR="$PWD/jadx-headless-mcp-0.7.1-all.jar"
```

On Windows, run the equivalent in PowerShell:

```powershell
$jar = Join-Path $HOME '.local\share\rea\android\jadx-headless-mcp-0.7.1-all.jar'
New-Item -ItemType Directory -Force (Split-Path $jar) | Out-Null
Invoke-WebRequest -Uri 'https://github.com/1013503897/jadx-headless-mcp/releases/download/v0.7.1/jadx-headless-mcp-0.7.1-all.jar' -OutFile $jar
if ((Get-FileHash -Algorithm SHA256 $jar).Hash.ToLowerInvariant() -ne '6e5eacf500b64292bfb73c49797c1958f6ee44646e43e868039ae7feb573ff75') { throw 'JADX JAR SHA-256 does not match Oopsware pinned metadata' }
$env:REA_JADX_MCP_JAR = $jar
```

Oopsware runs its packaged Java metadata bridge in source-file mode against the
unmodified engine JAR. Oopsware does not install Java, an Android SDK, JADX, a device
service or an emulator. Set the path in the shell or MCP server environment:

```sh
export REA_JADX_MCP_JAR=/absolute/path/jadx-headless-mcp-0.7.1-all.jar
# Optional: select an existing JDK rather than java on PATH.
export JAVA_HOME=/absolute/path/existing-jdk
```

On Windows x64, use a Oopsware package with its matching bundled Windows native
controls **including owned protocol stdin support**. This Windows boundary is
new on repository main; an older released package can still reject this host.
PowerShell accepts paths containing spaces without additional escaping
inside these environment values:

```powershell
$env:REA_JADX_MCP_JAR = 'D:\tools\jadx-headless-mcp-0.7.1-all.jar'
$env:JAVA_HOME = 'D:\tools\jdk-21'
oopsware inspect-android-package 'D:\targets\Example.apk'
```

Oopsware selects `JAVA_HOME\bin\java.exe`, or resolves `java.exe` on the selected
Windows `PATH`. A missing or mismatched native artifact reports the package
prerequisite rather than attempting an unowned Java launch. Windows arm64 is
outside this provider's current native boundary.

Readiness checks the selected JAR's ZIP directory for the classes consumed by
Oopsware's metadata bridge, as well as Java's compiler and version modules. It does
not load an APK or execute engine code. Invalid archives and missing bridge
classes report JAR-specific recovery; classpath inventory alone does not prove
that every class or engine operation will load successfully. Discovery limits
each ZIP metadata read to 8 MiB before allocation; a larger directory reports
the exhausted read budget and the selected JAR path.

The filtered class-page bridge (protocol 2) is verified on Linux x86-64 with
Temurin 21, public Appium ApiDemos 6.0.18 and NewPipe 0.29.1 APKs. Earlier
metadata-bridge records covered macOS arm64/OpenJDK 21 and Windows x64/JDK 21;
this protocol revision has not been rerun on those hosts or Linux/JDK 25.
Windows x64 uses an owned Job Object with bidirectional stdio, atomic job
assignment and kill-on-owner-close. Real Windows verification uses JDK 21 and
the pinned JADX 0.7.1 JAR; see the real verification lane below.

## Answer an analyst question

```sh
oopsware inspect-android-package /path/Example.apk
oopsware search-android-classes /path/Example.apk MainActivity
oopsware inspect-android-class /path/Example.apk example.MainActivity
oopsware inspect-android-method /path/Example.apk example.MainActivity onCreate
oopsware inspect-android-method /path/Example.apk example.MainActivity select --overload-index 1
oopsware trace-android-references /path/Example.apk example.MainActivity
oopsware trace-android-references /path/Example.apk example.MainActivity --method-name onCreate
oopsware trace-android-references /path/Example.apk example.MainActivity --method-name select --overload-index 1
```

Equivalent MCP methods are `inspect_android_package`, `search_android_classes`,
`inspect_android_class`, `inspect_android_method` and `trace_android_references`.
Every request includes `path`. Class/method operations use `class_name`,
`method_name` and optional `overload_index` as applicable. For example:

```json
{
  "name": "inspect_android_method",
  "arguments": {
    "path": "/path/Example.apk",
    "class_name": "example.MainActivity",
    "method_name": "select",
    "overload_index": 1
  }
}
```

Use `inspect_android_class` to choose an overload. Oopsware rejects an ambiguous
method request rather than silently selecting the first match. Method reference
queries accept the same `overload_index`; the bridge resolves the selected
method node and the result reports its index and displayed signature. These
indices are tied to the current artifact and engine, not stable across builds.

Smali fallbacks select one complete block using the original method name and DEX
descriptor, before applying the source byte limit. This preserves the selected
overload even when Java code generation renames a method. If the selected Java
body was omitted, including a method merged into a synthetic bridge, Oopsware returns
its original smali with the `java_body_unavailable` marker. The marker describes
missing Java; it does not infer why the method was omitted or name a replacement.
Unresolved or duplicate disassembly identities fail instead of attributing another
method's instructions to the selection.

Native and abstract methods are identified from access flags
captured before code generation. They report `body_status: "not_available"`, an
empty source, and the `native_method` or `abstract_method` marker; their declarations
are not passed through the engine's source slicer. Other missing decompiled bodies
do not establish either access flag.

Static initializers (`<clinit>`) return smali with the
`static_initializer_disassembly` marker. Java decompilation can move their
instructions into field declarations, leaving an empty or incomplete method
body. The selected method's disassembly preserves those instructions and retains
the same source byte limit and explicit truncation reporting.

## Interpret the result

- Package inspection retains decoded manifest XML, summary declarations,
  permissions and class/resource counts. Summary fields are extracted by the
  upstream engine and should be checked against the retained XML when needed.
  Signature verification is explicitly `not_performed`.
- Class search filters the engine's cached top-level names before transferring
  pages, then follows contiguous inventory positions without rescanning earlier
  rows. It checks selection, scope, examined ranges and counts before reporting
  complete coverage. Complete producer replies stay in Evidence; an empty `query`
  inventories all class-name rows; class names are decompiler representations.
  Repeated names remain repeated in `matches` so the inventory row count and
  producer evidence stay visible. `duplicate_names` identifies matching names
  with multiple rows and their occurrence counts; a name alone does not
  distinguish which provider class node a later lookup selects.
- Class inventories read parsed metadata without generating source and return
  full reported display types, fields and inner class names. Synthetic members
  that code generation hides can appear in the inventory; it stays consistent
  after method decompilation within the retained session.
  Exact DEX prototypes are reported from frozen JADX method metadata as
  `dex_descriptor`, for example `(I)V`. Display names can be JADX aliases;
  the descriptor alone is not a complete raw DEX method ID. Overload indices
  are tied to this artifact and engine, not stable identities across builds.
- Method inspection reports Java or smali, fallback markers and complete/partial
  returned text. Decompiled source is a derived representation. A complete text
  result does not establish complete semantics or a byte-identical reconstruction.
- Reference results are incoming static relationships between provider nodes.
  `reference_unit=using_node` means `total` counts containing JADX nodes, not
  individual invoke instructions; two calls from one method can appear as one
  entry. `coverage=complete` covers this node inventory only. For a method
  reference whose using node has raw code, `direct_invokes` lists matching DEX
  invoke instructions with their DEX entry, raw source method ID, code-unit
  offset, method index and opcode. An empty array means no direct invoke was
  matched in that node; `null` means raw code was unavailable or the using node
  was not a method. This list does not establish complete call-site coverage
  outside JADX's using-node inventory or through reflection and dynamic loading.
  A virtual or interface invoke also does not establish its runtime implementation.
  Source lines and the containing node's own `dex_offset` remain unknown.
  Method-reference results also carry the selected `dex_descriptor`;
  class-reference results report `null`.
  These relationships are not observed runtime calls.
- Original requests, APK SHA-256, actual engine JAR SHA-256 and raw producer
  responses remain in Evidence. Source revision is populated only for bytes
  matching the audited release JAR.

If a later step fails, the error's `details.partial_observation` retains the
selected and resolved APK paths, digest, observed provider identity and versions,
and each upstream request and reply collected before the failure. Failed replies
remain available even when their payload cannot be interpreted. Cancellation
also stops target hashing before provider admission.

These operations do not execute the APK or provide split APK/AAB handling,
signature validation, full resource-table semantics, native-library analysis or
Android runtime capture. An `.aab` suffix is a ZIP archive, not an APK, so
Android tools and the application graph do not treat it as a standalone APK.
Existing artifact inventory/extraction tools can supply archive evidence.
Inventory records an APK root only for ZIP bytes whose name ends in `.apk`.
The projection adds a limitation when no root `AndroidManifest.xml` was
observed, because such a ZIP may not be an APK. Nested members take a ZIP or
ASAR family from their bytes; an unread member keeps an unknown format.
Inventory keeps ZIP names that differ only in case and records that a
case-insensitive destination cannot store both spellings. Extraction fails
only when that destination directory cannot keep both names. Project that
Evidence with the execution-free inventory tool:

```sh
oopsware project-android-application-graph '{"inventory_evidence":[<inventory_artifact Evidence>]}'
```

```json
{
  "name": "project_android_application_graph",
  "arguments": {
    "inventory_evidence": ["<inventory_artifact Evidence>"]
  }
}
```

The projection reports exact component paths and hashes, runtime-family hints,
and path-based bridge hypotheses. File and slice occurrences supply component
endpoints; directory trees and symlinks retain their identities in the source
inventory without being classified as code files. It does not decode DEX or
claim observed runtime calls. DEX/JVM runtime hints summarize the classified
bytecode component lists. Framework hints match complete native library names,
such as
`libreactnativejni.so`, `libreactnative.so`, `libhermes.so`,
`libhermes_executor.so`, `libflutter.so`, and `libunity.so`; unrelated names
such as `libcommunity.so` and `libreactivity.so` do not identify those families.
The bridge basis is inferred from the native path and repeated for each managed
component, so it does not identify a specific JNI binding. Bridge hypotheses form a DEX/JVM-class by native-library
Cartesian product. The projection computes the product and exact serialized
candidate-array size before creating candidate objects, then retains a
deterministic prefix within a 2 MiB UTF-8 JSON budget. If candidates are omitted,
`bridge_candidate_coverage` reports total, emitted, and omitted counts; overall
coverage is `partial` while component arrays still include every component
from the supplied inventory pages. A path pair does not establish that a
managed declaration names, loads, or calls the native library.

## Resource and lifecycle limits

Oopsware retains one serialized session with private, immutable APK, engine JAR and
metadata-bridge copies. Matching requests reuse the loaded engine. APK/engine
digests and JVM configuration are checked before reuse; changed inputs retire
the previous session. Sessions are cleaned after 60 seconds of inactivity, on
target/configuration changes, failure, timeout, cancellation, MCP disconnect or
server shutdown. One-shot CLI commands always join cleanup before returning.
Oopsware never writes to the original APK or launches target code.

On Windows, stdin writes preserve stream backpressure and run outside the Node
event loop. Cancellation terminates the retained job, including descendants,
before workspace cleanup. On Windows, a detached REA helper owns the private
workspace's native directory handle. An abrupt CLI/server owner termination
closes the Java job and the helper's input pipe; the helper then removes the
workspace by handle. The real Windows lane checks both effects. If the helper
also dies or the host loses power before it finishes, private files can remain.

If Java cannot start the bridge, Oopsware reports the selected executable and retained
startup diagnostics. Select a full JDK through `JAVA_HOME` or `PATH`, and use
`java --list-modules` to confirm `jdk.compiler` is present. A runnable JRE alone
cannot compile the bridge. Missing or ambiguous class and method selections are
input failures; discover names with `search_android_classes` and
`inspect_android_class` before correcting the selected argument.

If process cleanup cannot be confirmed, Oopsware retains the workspace and reports its
location. That provider instance blocks subsequent engine launches until the
caller resolves the reported resources and starts a fresh instance.

The provider uses one JADX analysis worker independently of JVM processor and
garbage-collector settings. Oopsware supplies no default heap or visible-CPU override;
Java uses its normal ergonomics and inherits caller JVM settings. Optional
provider settings add explicit JVM arguments:

```sh
export REA_JADX_HEAP_MIB=8192
# Optional, independent of the single JADX worker:
export REA_JADX_ACTIVE_PROCESSOR_COUNT=4
# Or select settings through Java's standard environment options:
export JAVA_TOOL_OPTIONS=-Xmx8g
```

Both Oopsware settings must be positive safe integers; processor counts must also fit
the JVM's signed 32-bit range. Oopsware preserves
`JAVA_TOOL_OPTIONS`, `JDK_JAVA_OPTIONS` and `_JAVA_OPTIONS` rather than replacing
them. Java's standard precedence applies: explicit command-line heap settings
override `JAVA_TOOL_OPTIONS`, while `_JAVA_OPTIONS` can override command-line
settings. Evidence reports the worker's observed `Runtime.maxMemory()` rounded
down to MiB and retains exact bytes, Java version and visible processors in its
raw runtime response. The observed allocatable heap can differ from configured
`-Xmx`, especially with Serial GC. Heap is not a total RSS cap: the JVM also
uses native memory. A typed JVM memory allocation failure during APK loading
reports `resource_constraint` with the observed maximum heap in bytes. Known
heap failures name `REA_JADX_HEAP_MIB` in remediation; other memory regions
remain unknown. A healthy doctor configuration check does not establish that
any particular APK fits. Failures before the bridge can report a typed result
and upstream errors from other operations retain their existing diagnostics;
error text alone does not establish memory exhaustion.

Independent Oopsware instances have independent queues. Whole
operations have a **120-second** execution deadline by default, starting after
they reach the queue's front. For a known slow cold load, such as a large
multidex APK, select another finite deadline:

```sh
export REA_JADX_OPERATION_TIMEOUT_MS=600000
```

The value must be a decimal millisecond count from 1 to 2147483647; anything
else is refused before Java starts. The same deadline bounds each upstream
call, a timeout reports the selected value, and a passing JADX configuration
check in `rea doctor` reports the effective `operation_timeout_ms`. Explicit
cancellation still ends the operation immediately, and partial observations
and owned-process cleanup are unchanged. Raising the deadline does not extend
the bridge's 30-second startup handshake or the upstream **90-second**
decompilation limit. MCP clients enforce their own tool-call timeouts, and
setup's derived [client tool timeout](client-configuration.md) does not include
this setting, so also raise the client timeout when selecting a longer
deadline.

Decoded manifest and method text have a **1 MiB** upstream byte budget and report
truncation. Class-name pages use indexed slices of up to 4,096 names without changing the
complete, case-sensitive search contract. A protocol frame above **8 MiB**, or combined stdout/stderr above
**32 MiB per operation**, fails with a diagnostic instead of returning an incomplete inventory
as complete. These are memory-safety boundaries, not undocumented result caps.

## Real verification

Download the explicit public fixtures once; this installs no tools:

```sh
npm run fixtures:android
export REA_JADX_MCP_JAR="$PWD/_reference/apk-integration/jadx-headless-mcp-0.7.1-all.jar"
export REA_ANDROID_TEST_APK="$PWD/_reference/apk-integration/ApiDemos-debug.apk"
npm run verify:android
```

The main lane and Windows Java-selection checks validate the selected JDK and
engine archive through `validateVerifierJadxConfiguration`. This shared verifier
boundary supplies the production validator's resource owner and waits for
retained cleanup before proceeding. Failed closes retain their exact owners for
retry; prerequisite failures must not be mistaken for completed bridge tests.
Recovery checks match the typed Java or archive failure and its applicable
remediation.

The lane also uses the selected full JDK's `jlink` to create a disposable JRE
without the compiler module. It checks real Java startup failures, missing
selectors, recovery after failures, and CLI cancellation with owned cleanup.
The original APK and host Java configuration remain unchanged.

The same lane runs on Windows x64 with the bundled native controls and a full
JDK. It checks CLI/MCP results, real MCP cancellation and disconnect, and Java
exit and workspace removal after abrupt CLI owner termination. Windows forced
termination is checked separately from the POSIX CLI SIGTERM handler. A
synthetic two-owner test confirms that one owner's exit does not remove the
other owner's workspace. The lane does not claim a structured cancellation
result or power-loss recovery.

The download script verifies fixed SHA-256 values, reuses matching files and
refuses to overwrite a different existing file. APK/JAR files live under ignored
`_reference/` and are excluded from package contents. The lane exercises actual
Oopsware CLI and MCP results with the real engine, separately from synthetic protocol
regressions. It needs no Gradle build, emulator, Android SDK or Ghidra.

Direct invoke sites retain exact DEX code-unit offsets separately from each
containing node's unknown `dex_offset`. `direct_invokes_exhaustive: false`
means instruction rows were bounded by the local bridge frame budget; `null`
means the producer did not establish instruction coverage. Using-node totals
and coverage do not imply complete instruction evidence.
