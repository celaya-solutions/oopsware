import { z } from "zod";

import { facetCoverageSchema } from "../formatRegistry.js";

/**
 * JVM class files, JARs and AARs (format expansion F02). Bytes are parsed
 * directly; nothing is loaded into a JVM, no class initializer or annotation
 * processor runs, and no dependency is resolved. Multi-release variants stay
 * distinct: a class's release is always reported, never chosen from the host.
 */

/** Default and maximum bytes read for one local class file or archive. */
export const DEFAULT_JVM_FILE_BYTES = 128 * 1024 ** 2;
export const MAX_JVM_FILE_BYTES = 512 * 1024 ** 2;
/** Default and maximum bytes decompressed from archive members in one call. */
export const DEFAULT_JVM_DECODED_BYTES = 512 * 1024 ** 2;
export const MAX_JVM_DECODED_BYTES = 2 * 1024 ** 3;
/** Largest single member read; real class files are far smaller. */
export const MAX_JVM_MEMBER_BYTES = 256 * 1024 ** 2;
/** Largest page of classes one archive call returns. */
export const MAX_JVM_CLASS_PAGE = 5000;
/** Largest page of instructions one method call returns (a code array is at most 65535 bytes). */
export const MAX_JVM_INSTRUCTION_PAGE = 65_535;
/** Lines, providers and similar lists beyond this are counted, not listed. */
export const MAX_JVM_LISTED = 10_000;

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const offset = z.number().int().min(0);
const count = z.number().int().min(0);

const pathField = z
  .string()
  .min(1)
  .describe(
    "Absolute path to a caller-selected local .class, .jar or .aar file",
  );
const maxFileBytesField = z
  .number()
  .int()
  .min(1)
  .max(MAX_JVM_FILE_BYTES)
  .default(DEFAULT_JVM_FILE_BYTES)
  .describe("Maximum stable bytes to read from the file (default 128 MiB)");
const maxDecodedBytesField = z
  .number()
  .int()
  .min(1)
  .max(MAX_JVM_DECODED_BYTES)
  .default(DEFAULT_JVM_DECODED_BYTES)
  .describe(
    "Maximum bytes to decompress from archive members in this call (default 512 MiB)",
  );

/** How one class inside an archive is chosen. */
const selectorShape = {
  class: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Class to read, as a binary name (com.example.Main) or internal name (com/example/Main)",
    ),
  entry: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Exact archive member path of the class, e.g. META-INF/versions/17/com/example/Main.class",
    ),
  container: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Member path of an embedded JAR that holds the class (for example classes.jar in an AAR)",
    ),
  release: z
    .number()
    .int()
    .min(8)
    .max(1000)
    .optional()
    .describe(
      "Java feature release to resolve a multi-release JAR for; without it the base class is chosen and every variant is listed",
    ),
};

export const inspectJvmArtifactInputSchema = z.strictObject({
  path: pathField,
  start: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("Index of the first class to return"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_JVM_CLASS_PAGE)
    .default(500)
    .describe("Maximum classes to return in this page"),
  max_file_bytes: maxFileBytesField,
  max_decoded_bytes: maxDecodedBytesField,
});
export type InspectJvmArtifactInput = z.infer<
  typeof inspectJvmArtifactInputSchema
>;

export const inspectJvmClassInputSchema = z.strictObject({
  path: pathField,
  ...selectorShape,
  max_file_bytes: maxFileBytesField,
  max_decoded_bytes: maxDecodedBytesField,
});
export type InspectJvmClassInput = z.infer<typeof inspectJvmClassInputSchema>;

export const inspectJvmMethodInputSchema = z.strictObject({
  path: pathField,
  ...selectorShape,
  method: z
    .string()
    .min(1)
    .describe("Method name as stored, e.g. main, <init> or <clinit>"),
  descriptor: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Method descriptor such as ([Ljava/lang/String;)V; required when the name is overloaded",
    ),
  start: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("Index of the first instruction to return"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_JVM_INSTRUCTION_PAGE)
    .default(2000)
    .describe("Maximum instructions to return in this page"),
  max_file_bytes: maxFileBytesField,
  max_decoded_bytes: maxDecodedBytesField,
});
export type InspectJvmMethodInput = z.infer<typeof inspectJvmMethodInputSchema>;

const artifactSchema = z.strictObject({
  path: z.string().min(1),
  sha256,
  bytes: count,
});

export const jvmContainerKindSchema = z.enum(["class", "jar", "aar", "zip"]);
export type JvmContainerKind = z.infer<typeof jvmContainerKindSchema>;

const containerSchema = z.strictObject({
  kind: jvmContainerKindSchema,
  /** `magic`: class bytes; `layout`: archive members (manifest, classes.jar, ...); `name-hint`: only the suffix. */
  basis: z.enum(["magic", "layout", "name-hint"]),
  /** Set when the file name suggests a different kind than the bytes. */
  name_conflict: z.string().nullable(),
});

const versionSchema = z.strictObject({
  major: count,
  minor: count,
  /** Java release that introduced this major version, e.g. "17", "1.4". */
  java: z.string().nullable(),
  /** minor 65535 on a major from 56 marks preview features. */
  preview: z.boolean(),
});

const decodeSchema = z.enum(["complete", "partial", "failed"]);

/** Where a class's bytes are: the file itself, an archive member, or a member of an embedded JAR. */
const locationShape = {
  container: z.string().nullable(),
  entry: z.string().nullable(),
  /** Multi-release feature release (META-INF/versions/N); null for the base class. */
  release: z.number().int().min(9).nullable(),
};

export const jvmClassSummarySchema = z.strictObject({
  ...locationShape,
  /** Null when the member could not be read (budget, encryption, damage). */
  sha256: sha256.nullable(),
  bytes: count,
  name: z.string().nullable(),
  kind: z.enum([
    "class",
    "interface",
    "enum",
    "annotation",
    "record",
    "module",
  ]),
  access: z.array(z.string()),
  super: z.string().nullable(),
  interfaces: z.array(z.string().nullable()),
  version: versionSchema,
  fields: count,
  methods: count,
  source_file: z.string().nullable(),
  decode: decodeSchema,
  /** First structural problem, when decoding was not complete. */
  error: z.string().nullable(),
});
export type JvmClassSummary = z.infer<typeof jvmClassSummarySchema>;

export const jvmModuleSchema = z.strictObject({
  ...locationShape,
  name: z.string().nullable(),
  version: z.string().nullable(),
  flags: z.array(z.string()),
  requires: z.array(
    z.strictObject({
      module: z.string().nullable(),
      flags: z.array(z.string()),
      version: z.string().nullable(),
    }),
  ),
  exports: z.array(
    z.strictObject({
      package: z.string().nullable(),
      flags: z.array(z.string()),
      to: z.array(z.string().nullable()),
    }),
  ),
  opens: z.array(
    z.strictObject({
      package: z.string().nullable(),
      flags: z.array(z.string()),
      to: z.array(z.string().nullable()),
    }),
  ),
  uses: z.array(z.string().nullable()),
  provides: z.array(
    z.strictObject({
      service: z.string().nullable(),
      with: z.array(z.string().nullable()),
    }),
  ),
  packages: z.array(z.string().nullable()),
  main_class: z.string().nullable(),
});

const diagnosticSchema = z.strictObject({
  container: z.string().nullable(),
  entry: z.string().nullable(),
  offset: offset.nullable(),
  message: z.string().min(1),
});

const pageSchema = z.strictObject({
  start: count,
  limit: z.number().int().min(1),
  returned: count,
  next: count.nullable(),
});

const attributeSchema = z.strictObject({
  name: z.string().min(1),
  value: z.string(),
});

export const jvmArtifactReportSchema = z.strictObject({
  artifact: artifactSchema,
  container: containerSchema,
  manifest: z
    .strictObject({
      container: z.string().nullable(),
      entry: z.string(),
      /** Main-section attributes in file order, exactly as written. */
      main: z.array(attributeSchema),
      /** Per-entry sections (`Name:` blocks), counted. */
      sections: count,
      main_class: z.string().nullable(),
      automatic_module_name: z.string().nullable(),
      multi_release: z.boolean(),
      created_by: z.string().nullable(),
    })
    .nullable(),
  services: z.array(
    z.strictObject({
      container: z.string().nullable(),
      entry: z.string(),
      service: z.string(),
      providers: z.array(z.string()),
      /** Lines that are not a provider name or comment. */
      invalid_lines: count,
    }),
  ),
  modules: z.array(jvmModuleSchema),
  /**
   * JAR signature files. Their presence and declared digests are reported;
   * no certificate is checked and no signature is verified.
   */
  signatures: z.array(
    z.strictObject({
      container: z.string().nullable(),
      signer: z.string(),
      signature_file: z.string(),
      block_file: z.string().nullable(),
      block_type: z.enum(["RSA", "DSA", "EC"]).nullable(),
      digest_attributes: z.array(z.string()),
      entries: count,
    }),
  ),
  /** Per-entry digests declared in the manifest, recomputed over the member bytes. */
  entry_digests: z
    .strictObject({
      algorithms: z.array(z.string()),
      declared: count,
      matched: count,
      mismatched: z.array(z.string()),
      missing: z.array(z.string()),
      unchecked: count,
    })
    .nullable(),
  multi_release: z.strictObject({
    /** `Multi-Release: true` in the main manifest section. */
    declared: z.boolean(),
    releases: z.array(z.number().int().min(9)),
    versioned_classes: count,
    /** Versioned members exist but the manifest does not declare Multi-Release, so a JVM ignores them. */
    ignored: z.boolean(),
  }),
  embedded_jars: z.array(
    z.strictObject({
      entry: z.string(),
      bytes: count,
      sha256: sha256.nullable(),
      classes: count,
      read: z.enum(["complete", "failed", "skipped"]),
      reason: z.string().nullable(),
    }),
  ),
  android: z
    .strictObject({
      manifest: z
        .strictObject({
          entry: z.string(),
          package: z.string().nullable(),
          min_sdk: z.string().nullable(),
          target_sdk: z.string().nullable(),
          error: z.string().nullable(),
        })
        .nullable(),
      native_libraries: z.array(
        z.strictObject({
          entry: z.string(),
          abi: z.string(),
          name: z.string(),
          bytes: count,
          sha256: sha256.nullable(),
          /** ELF class and machine read from the header, when the member is ELF. */
          elf: z
            .strictObject({ class: z.enum(["32", "64"]), machine: z.string() })
            .nullable(),
        }),
      ),
      resources: count,
      assets: count,
      /** Other AAR parts such as R.txt, proguard.txt, public.txt and lint.jar. */
      other: z.array(z.string()),
    })
    .nullable(),
  summary: z.strictObject({
    entries: count,
    classes: count,
    base_classes: count,
    versioned_classes: count,
    resources: count,
    kinds: z.strictObject({
      class: count,
      interface: count,
      enum: count,
      annotation: count,
      record: count,
      module: count,
    }),
    versions: z.array(
      z.strictObject({
        major: count,
        java: z.string().nullable(),
        classes: count,
      }),
    ),
    decoded_bytes: count,
  }),
  class_count: count,
  page: pageSchema,
  classes: z.array(jvmClassSummarySchema),
  diagnostics: z.array(diagnosticSchema),
  coverage: z.array(facetCoverageSchema),
  limitations: z.array(z.string()),
});
export type JvmArtifactReport = z.infer<typeof jvmArtifactReportSchema>;

const selectionSchema = z.strictObject({
  ...locationShape,
  /** `file`: a bare class file; `only`: the single candidate; `base`/`release`: a multi-release choice; `entry`: named exactly. */
  basis: z.enum(["file", "only", "base", "release", "entry"]),
  /** Every multi-release variant of this class, so a choice is never silent. */
  variants: z.array(
    z.strictObject({
      entry: z.string(),
      release: z.number().int().min(9).nullable(),
    }),
  ),
});

const annotationsSchema = z.array(
  z.strictObject({ text: z.string(), visible: z.boolean() }),
);

const attributeInfoSchema = z.strictObject({
  name: z.string().nullable(),
  offset,
  length: count,
  /** `skipped`: a standard attribute this reader does not decode; `unknown`: not defined by the JVM specification. */
  state: z.enum(["decoded", "skipped", "unknown", "malformed"]),
});

export const jvmMethodSummarySchema = z.strictObject({
  index: count,
  name: z.string().nullable(),
  descriptor: z.string().nullable(),
  /** Java-like declaration rendered from flags and descriptor. */
  declaration: z.string().nullable(),
  access: z.array(z.string()),
  signature: z.string().nullable(),
  throws: z.array(z.string()),
  code: z
    .strictObject({
      offset,
      length: count,
      max_stack: count,
      max_locals: count,
      handlers: count,
      line_numbers: z.boolean(),
      local_variables: z.boolean(),
    })
    .nullable(),
  annotations: annotationsSchema,
  parameter_annotations: z.array(annotationsSchema),
  parameters: z.array(
    z.strictObject({
      name: z.string().nullable(),
      access: z.array(z.string()),
    }),
  ),
  annotation_default: z.string().nullable(),
  deprecated: z.boolean(),
  attributes: z.array(attributeInfoSchema),
});

export const jvmClassReportSchema = z.strictObject({
  artifact: artifactSchema,
  selection: selectionSchema,
  class: jvmClassSummarySchema.extend({
    access_flags: count.nullable(),
    signature: z.string().nullable(),
    deprecated: z.boolean(),
    constant_pool: z.strictObject({
      count,
      by_tag: z.record(z.string(), count),
    }),
    annotations: annotationsSchema,
    fields: z.array(
      z.strictObject({
        index: count,
        name: z.string().nullable(),
        descriptor: z.string().nullable(),
        type: z.string().nullable(),
        access: z.array(z.string()),
        signature: z.string().nullable(),
        constant_value: z.string().nullable(),
        annotations: annotationsSchema,
        deprecated: z.boolean(),
        attributes: z.array(attributeInfoSchema),
      }),
    ),
    methods: z.array(jvmMethodSummarySchema),
    inner_classes: z.array(
      z.strictObject({
        inner: z.string().nullable(),
        outer: z.string().nullable(),
        name: z.string().nullable(),
        access: z.array(z.string()),
      }),
    ),
    enclosing_method: z
      .strictObject({
        class: z.string().nullable(),
        method: z.string().nullable(),
        descriptor: z.string().nullable(),
      })
      .nullable(),
    nest_host: z.string().nullable(),
    nest_members: z.array(z.string().nullable()),
    permitted_subclasses: z.array(z.string().nullable()),
    record_components: z
      .array(
        z.strictObject({
          name: z.string().nullable(),
          descriptor: z.string().nullable(),
          type: z.string().nullable(),
          signature: z.string().nullable(),
          annotations: annotationsSchema,
        }),
      )
      .nullable(),
    bootstrap_methods: z.array(
      z.strictObject({
        index: count,
        handle: z.string().nullable(),
        arguments: z.array(z.string()),
      }),
    ),
    module: jvmModuleSchema.nullable(),
    attributes: z.array(attributeInfoSchema),
    /** Every class the constant pool names, sorted. */
    referenced_classes: z.array(z.string()),
  }),
  diagnostics: z.array(diagnosticSchema),
  coverage: z.array(facetCoverageSchema),
  limitations: z.array(z.string()),
});
export type JvmClassReport = z.infer<typeof jvmClassReportSchema>;

const memberRefSchema = z.strictObject({
  owner: z.string().nullable(),
  name: z.string().nullable(),
  descriptor: z.string().nullable(),
});

const at = { instruction: count, pc: count };

export const jvmInstructionSchema = z.strictObject({
  index: count,
  pc: count,
  /** Byte offset of the opcode within the class bytes. */
  offset,
  size: z.number().int().min(1),
  /** Mnemonic as javap prints it; `wide` forms carry a `_w` suffix. */
  op: z.string().min(1),
  /** Operands as javap prints them, including the constant it names. */
  operands: z.string(),
  line: z.number().int().min(0).nullable(),
});

export const jvmMethodReportSchema = z.strictObject({
  artifact: artifactSchema,
  selection: selectionSchema,
  class: z.strictObject({
    name: z.string().nullable(),
    version: versionSchema,
  }),
  method: jvmMethodSummarySchema,
  instruction_count: count,
  page: pageSchema,
  instructions: z.array(jvmInstructionSchema),
  exception_table: z.array(
    z.strictObject({
      start_pc: count,
      end_pc: count,
      handler_pc: count,
      /** Null catches any throwable (finally blocks, monitor exits). */
      catch_type: z.string().nullable(),
    }),
  ),
  line_numbers: z.array(z.strictObject({ pc: count, line: count })),
  local_variables: z.array(
    z.strictObject({
      slot: count,
      name: z.string().nullable(),
      descriptor: z.string().nullable(),
      signature: z.string().nullable(),
      start_pc: count,
      length: count,
    }),
  ),
  /** References over the whole method, not only this page of instructions. */
  references: z.strictObject({
    invocations: z.array(
      z.strictObject({
        ...at,
        op: z.string(),
        interface: z.boolean(),
        target: memberRefSchema,
      }),
    ),
    dynamic: z.array(
      z.strictObject({
        ...at,
        name: z.string().nullable(),
        descriptor: z.string().nullable(),
        bootstrap: z
          .strictObject({
            index: count,
            handle: z.string().nullable(),
            arguments: z.array(z.string()),
          })
          .nullable(),
      }),
    ),
    fields: z.array(
      z.strictObject({ ...at, op: z.string(), target: memberRefSchema }),
    ),
    types: z.array(
      z.strictObject({ ...at, op: z.string(), type: z.string().nullable() }),
    ),
    constants: z.array(
      z.strictObject({
        ...at,
        op: z.string(),
        kind: z.string(),
        value: z.string(),
      }),
    ),
  }),
  diagnostics: z.array(diagnosticSchema),
  coverage: z.array(facetCoverageSchema),
  limitations: z.array(z.string()),
});
export type JvmMethodReport = z.infer<typeof jvmMethodReportSchema>;

/** Default and maximum wall clock for one decompiler run. */
export const DEFAULT_JVM_DECOMPILE_MS = 120_000;
export const MAX_JVM_DECOMPILE_MS = 600_000;
/** Default and maximum Java heap for the decompiler process. */
export const DEFAULT_JVM_DECOMPILE_HEAP_MIB = 1024;
export const MAX_JVM_DECOMPILE_HEAP_MIB = 8192;
/** Default and maximum bytes of reconstructed source returned inline. */
export const DEFAULT_JVM_SOURCE_BYTES = 4 * 1024 ** 2;
export const MAX_JVM_SOURCE_BYTES = 32 * 1024 ** 2;

export const decompileJvmClassInputSchema = z.strictObject({
  path: pathField,
  ...selectorShape,
  siblings: z
    .boolean()
    .default(false)
    .describe(
      "For a loose .class file, also read its nested classes (Outer$*.class) from the same directory",
    ),
  timeout_ms: z
    .number()
    .int()
    .min(1000)
    .max(MAX_JVM_DECOMPILE_MS)
    .default(DEFAULT_JVM_DECOMPILE_MS)
    .describe("Wall-clock limit for the decompiler (default 120 s)"),
  max_heap_mib: z
    .number()
    .int()
    .min(128)
    .max(MAX_JVM_DECOMPILE_HEAP_MIB)
    .default(DEFAULT_JVM_DECOMPILE_HEAP_MIB)
    .describe("Java heap for the decompiler process in MiB (default 1024)"),
  max_source_bytes: z
    .number()
    .int()
    .min(1)
    .max(MAX_JVM_SOURCE_BYTES)
    .default(DEFAULT_JVM_SOURCE_BYTES)
    .describe("Largest reconstructed source returned inline (default 4 MiB)"),
  max_file_bytes: maxFileBytesField,
  max_decoded_bytes: maxDecodedBytesField,
});
export type DecompileJvmClassInput = z.infer<
  typeof decompileJvmClassInputSchema
>;

/** The admitted Vineflower run, reported verbatim as provenance (shared with decompile_dex_class). */
export const vineflowerIdentitySchema = z.strictObject({
  id: z.literal("vineflower"),
  version: z.string(),
  build: z.string(),
  jar: z.strictObject({ path: z.string(), sha256 }),
  java: z.strictObject({ path: z.string(), version: z.string() }),
  options: z.array(z.string()),
});

export const jvmDecompilationSchema = z.strictObject({
  artifact: artifactSchema,
  selection: selectionSchema,
  /** The outermost class decompiled; nested classes are written inside it. */
  top_level: z.string(),
  /** Every class file handed to the decompiler, by identity. */
  inputs: z.array(
    z.strictObject({
      name: z.string(),
      role: z.enum(["selected", "outer", "nested"]),
      container: z.string().nullable(),
      entry: z.string().nullable(),
      /** Set for a sibling class file read from disk. */
      file: z.string().nullable(),
      release: z.number().int().min(9).nullable(),
      sha256,
      bytes: count,
    }),
  ),
  /** Nested classes the bytes name but that were not available to the decompiler. */
  missing_nested: z.array(z.string()),
  /** The JAR given as type context (read as data, never run). */
  library: z
    .strictObject({ container: z.string().nullable(), sha256 })
    .nullable(),
  decompiler: vineflowerIdentitySchema,
  source: z.strictObject({
    /** Path the decompiler wrote, relative to its output root. */
    file: z.string(),
    /** Inferred Java source; it is not the original and may not compile. */
    text: z.string(),
    bytes: count,
    sha256,
    lines: count,
    media_type: z.literal("text/x-java; charset=utf-8"),
    confidence: z.literal("inferred"),
    /** SHA-256 of every class file the text was reconstructed from. */
    derived_from: z.array(sha256),
  }),
  /**
   * `$VF:` comments the decompiler left where it could not be sure, and lines
   * where it printed an invokedynamic call as pseudo-Java instead of source.
   */
  decompiler_notes: z.array(
    z.strictObject({ line: z.number().int().min(1), text: z.string() }),
  ),
  /**
   * Methods whose bytecode this reader could not decode cleanly. The
   * decompiler may still print a body for them; that body must not be trusted.
   */
  untrusted_methods: z.array(
    z.strictObject({
      class: z.string().nullable(),
      method: z.string().nullable(),
      descriptor: z.string().nullable(),
      reason: z.string(),
    }),
  ),
  /** Warnings and errors the decompiler printed. */
  messages: z.array(z.string()),
  coverage: z.array(facetCoverageSchema),
  limitations: z.array(z.string()),
});
export type JvmDecompilation = z.infer<typeof jvmDecompilationSchema>;
