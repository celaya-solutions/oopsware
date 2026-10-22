import {
  androidArtifactReportSchema,
  decompileDexClassInputSchema,
  dexClassReportSchema,
  dexDecompilationSchema,
  dexMethodReportSchema,
  inspectAndroidArtifactInputSchema,
  inspectDexClassInputSchema,
  inspectDexMethodInputSchema,
} from "../../domain/android/androidArtifact.js";
import type { ToolContract } from "../toolContractTypes.js";
import { toolContractMetadata } from "../toolEffects.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";

/** DEX files, APKs, App Bundles, split APK sets and XAPKs (format expansion F04), read in process. */
export const ANDROID_PACKAGE_TOOL_CONTRACTS = [
  {
    name: "inspect_android_artifact",
    ...toolContractMetadata("inspect_android_artifact"),
    kind: "artifact-provider",
    description:
      "Read one explicit local DEX file, APK, Android App Bundle (.aab), split APK set (.apks) or XAPK from its bytes, without installing, signing, verifying or running anything and without a device. Returns what the package is (and any name/byte disagreement); for an APK its decoded binary manifest (package, version, SDK levels, permissions and features as declarations, components with exported flags and intent filters, the rendered XML), resource table packages, types and configurations, DEX files, ABIs, asset counts and signature material (JAR signers and APK Signing Block entries, never verified); for a bundle each module's protocol buffer manifest (including dist:module delivery), resource table, DEX files and ABIs, plus BundleConfig.pb and BUNDLE-METADATA; for an APK set or XAPK its table of contents (toc.pb) or manifest.json, every APK with its declared role, split, module, targeting and manifest summary, declared-but-missing and undeclared APKs, base APKs (several need an explicit choice) and conflicts, and OBB files. Every DEX file gets its version, Adler-32 checksum and SHA-1 signature recomputed, counts and map list; every native library its digest and ELF machine checked against its ABI directory. Then a page of classes across the DEX files (or the one `container`/`entry` names), each with its DEX location, descriptor, flags, superclass, interfaces, source file and member counts. Pass `container` to read one APK of a set in full.",
    inputSchema: inspectAndroidArtifactInputSchema,
    outputSchema: evidenceResultOf(androidArtifactReportSchema),
    examples: [
      { title: "Inventory a local APK", input: { path: "/artifacts/app.apk" } },
      {
        title: "Read one split of an APK set",
        input: {
          path: "/artifacts/app.apks",
          container: "splits/base-master.apk",
        },
      },
      {
        title: "Page the classes of one DEX in a bundle",
        input: {
          path: "/artifacts/app.aab",
          entry: "base/dex/classes2.dex",
          start: 500,
          limit: 500,
        },
      },
    ],
  },
  {
    name: "inspect_dex_class",
    ...toolContractMetadata("inspect_dex_class"),
    kind: "artifact-provider",
    description:
      "Parse one class from an explicit local DEX, APK, App Bundle, APK set or XAPK without loading it: descriptor, access flags (as dexdump names them), superclass, interfaces, source file, class annotations with their values, static fields with their encoded initial values, instance fields, and direct and virtual methods with exact DEX descriptors, flags, code size, registers, ins and outs, try count, parameter names from debug info and annotations. Every DEX that defines the class is listed; when byte-different DEX files define it, choose one with `container` and `entry` instead of a silent pick.",
    inputSchema: inspectDexClassInputSchema,
    outputSchema: evidenceResultOf(dexClassReportSchema),
    examples: [
      {
        title: "Read an activity from an APK",
        input: {
          path: "/artifacts/app.apk",
          class: "com.example.MainActivity",
        },
      },
      {
        title: "Read a class from one split of an APK set",
        input: {
          path: "/artifacts/app.apks",
          container: "splits/base-master.apk",
          class: "Lcom/example/MainActivity;",
        },
      },
    ],
  },
  {
    name: "inspect_dex_method",
    ...toolContractMetadata("inspect_dex_method"),
    kind: "artifact-provider",
    description:
      "Decode one method's Dalvik bytecode from an explicit local DEX, APK, App Bundle, APK set or XAPK without running or verifying it: a page of instructions with index, code-unit address, file offset, width, opcode, dexdump mnemonic and dexdump-rendered operands, source line, registers, literal, branch target and resolved string/type/field/method/proto/call-site/method-handle reference; switch tables with their key-to-target pairs and array data where they sit; try blocks with handler types and addresses; line positions and local variables from debug info; and every reference the whole method makes (invocations by kind, field reads and writes, type uses, strings). Choose the class as for inspect_dex_class and the method by name, plus descriptor when it is overloaded. Abstract and native methods report no code.",
    inputSchema: inspectDexMethodInputSchema,
    outputSchema: evidenceResultOf(dexMethodReportSchema),
    examples: [
      {
        title: "Decode onCreate in an APK",
        input: {
          path: "/artifacts/app.apk",
          class: "com.example.MainActivity",
          method: "onCreate",
        },
      },
      {
        title: "Decode one overload in a bare DEX",
        input: {
          path: "/artifacts/classes.dex",
          class: "com.example.Util",
          method: "parse",
          descriptor: "(Ljava/lang/String;)I",
        },
      },
    ],
  },
  {
    name: "decompile_dex_class",
    ...toolContractMetadata("decompile_dex_class"),
    kind: "artifact-provider",
    description:
      "Reconstruct Java source for one class of an explicit local DEX, APK, App Bundle, APK set or XAPK (chosen as for inspect_dex_class) without JADX, and return it inline labelled as inferred. The DEX file that defines the class is copied to a scratch directory, converted to class files by the installed, digest-pinned dex2jar 2.4, and the class with its outer and nested classes is decompiled by the installed, digest-pinned Vineflower (as decompile_jvm_class does); both run in their own Java processes with an empty environment, nothing is installed, loaded or run, and the scratch is removed. Then three checks: dex2jar_translated (dex2jar's own error report lists no failed methods in these classes; failed ones are listed as untrusted), vineflower_clean (no `$VF:` notes, unresolved invokedynamic lines or converted methods that do not decode), and methods_present (every source-level method the DEX declares for the class is named in the text; missing ones listed). Any check that fails makes the result partial; the text is still returned. When dex2jar or Vineflower is not installed or not an admitted build, the tool says so instead of guessing; inspect_dex_method still gives the bytecode.",
    inputSchema: decompileDexClassInputSchema,
    outputSchema: evidenceResultOf(dexDecompilationSchema),
    examples: [
      {
        title: "Decompile an activity from an APK",
        input: {
          path: "/artifacts/app.apk",
          class: "com.example.MainActivity",
        },
      },
      {
        title: "Decompile a nested class from one DEX of a bundle",
        input: {
          path: "/artifacts/app.aab",
          entry: "base/dex/classes2.dex",
          class: "Lcom/example/Util$Parser;",
          timeout_ms: 300000,
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
