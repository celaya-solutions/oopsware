import {
  decompileJvmClassInputSchema,
  inspectJvmArtifactInputSchema,
  inspectJvmClassInputSchema,
  inspectJvmMethodInputSchema,
  jvmArtifactReportSchema,
  jvmClassReportSchema,
  jvmDecompilationSchema,
  jvmMethodReportSchema,
} from "../domain/jvm/jvm.js";
import type { ToolContract } from "./toolContractTypes.js";
import { toolContractMetadata } from "./toolEffects.js";
import { evidenceResultOf } from "./toolOutputSchemaPrimitives.js";

/** JVM class files, JARs and AARs (format expansion F02), independent of binary targets. */
export const JVM_TOOL_CONTRACTS = [
  {
    name: "inspect_jvm_artifact",
    ...toolContractMetadata("inspect_jvm_artifact"),
    kind: "artifact-provider",
    description:
      "Read one explicit local JVM class file, JAR or Android library (AAR) from its bytes, without loading anything into a JVM: no class initializer, annotation processor or dependency resolution runs. Returns what the container is (and any name/byte disagreement), the manifest's main attributes, META-INF/services providers, module descriptors, JAR signature files with their declared digests (signatures are not verified), per-entry manifest digests recomputed over the member bytes, multi-release releases (and whether a JVM would ignore them), JARs it directly contains, and for an AAR its manifest package and SDK levels, JNI libraries per ABI with digest and ELF machine, and resource counts. Then a page of classes, each with member path, multi-release release, digest, name, kind, flags, superclass, interfaces, class file version and Java release. Embedded JARs are opened one level deep within max_decoded_bytes.",
    inputSchema: inspectJvmArtifactInputSchema,
    outputSchema: evidenceResultOf(jvmArtifactReportSchema),
    examples: [
      { title: "Inventory a local JAR", input: { path: "/artifacts/app.jar" } },
      {
        title: "Read the second page of classes of an AAR",
        input: { path: "/artifacts/library.aar", start: 500, limit: 500 },
      },
    ],
  },
  {
    name: "inspect_jvm_class",
    ...toolContractMetadata("inspect_jvm_class"),
    kind: "artifact-provider",
    description:
      "Parse one class from an explicit local class file, JAR or AAR without loading it: version, flags, generic signature, constant pool counts, fields (type, flags, constant value, annotations), methods (Java-like declaration, flags, throws, code size, max stack and locals, handler count, parameter names and annotations, annotation defaults), class annotations, inner and enclosing classes, nest, permitted subclasses, record components, invokedynamic bootstrap methods, a module descriptor, every attribute with its byte range and whether it was decoded, and every class the constant pool names. In an archive, choose the class by name or exact member path; a class with multi-release variants is resolved for `release` when given, otherwise the base class is read, and every variant is listed so the choice is never silent.",
    inputSchema: inspectJvmClassInputSchema,
    outputSchema: evidenceResultOf(jvmClassReportSchema),
    examples: [
      { title: "Read a class file", input: { path: "/artifacts/Main.class" } },
      {
        title: "Read a class from a JAR for Java 21",
        input: {
          path: "/artifacts/app.jar",
          class: "com.example.Main",
          release: 21,
        },
      },
    ],
  },
  {
    name: "inspect_jvm_method",
    ...toolContractMetadata("inspect_jvm_method"),
    kind: "artifact-provider",
    description:
      "Decode one method's bytecode from an explicit local class file, JAR or AAR without running or verifying it: a page of instructions with pc, byte offset, size, javap mnemonic, javap-style operands and source line, the exception table, line numbers and local variable names, and every reference the whole method makes: invocations (owner, name, descriptor, interface or not), invokedynamic sites with their bootstrap method and arguments, field reads and writes, type checks and allocations, and loaded constants. Choose the class as for inspect_jvm_class and the method by name, plus descriptor when it is overloaded. Abstract and native methods report no bytecode.",
    inputSchema: inspectJvmMethodInputSchema,
    outputSchema: evidenceResultOf(jvmMethodReportSchema),
    examples: [
      {
        title: "Decode main in a JAR",
        input: {
          path: "/artifacts/app.jar",
          class: "com.example.Main",
          method: "main",
        },
      },
      {
        title: "Decode one overload",
        input: {
          path: "/artifacts/Util.class",
          method: "parse",
          descriptor: "(Ljava/lang/String;)I",
        },
      },
    ],
  },
  {
    name: "decompile_jvm_class",
    ...toolContractMetadata("decompile_jvm_class"),
    kind: "artifact-provider",
    description:
      "Reconstruct Java source for one class of an explicit local class file, JAR or AAR with the installed, digest-pinned Vineflower decompiler, and return it inline labelled as inferred. The class is chosen as for inspect_jvm_class (a multi-release class only for an explicit release); its outermost class and every nested class from the same JAR and release are decompiled together, and each input is listed by entry and SHA-256. Vineflower runs in its own Java process over copies in a scratch directory that is removed afterwards, with the containing JAR as type context, read as data; no target class is loaded or run. Methods whose bytecode this reader cannot decode cleanly are listed as untrusted, because Vineflower may still print a body for them, and its own `$VF:` uncertainty comments are listed by line. When Vineflower is not installed or is not an admitted build, the tool says so instead of guessing; inspect_jvm_method still gives the bytecode.",
    inputSchema: decompileJvmClassInputSchema,
    outputSchema: evidenceResultOf(jvmDecompilationSchema),
    examples: [
      {
        title: "Decompile a class from a JAR",
        input: { path: "/artifacts/app.jar", class: "com.example.Main" },
      },
      {
        title: "Decompile a loose class with its nested classes",
        input: {
          path: "/artifacts/classes/com/example/Shapes.class",
          siblings: true,
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
