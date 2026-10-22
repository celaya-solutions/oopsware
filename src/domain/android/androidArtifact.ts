import { z } from "zod";

import { facetCoverageSchema } from "../formatRegistry.js";
import { jsonValueSchema } from "../jsonValue.js";
import {
  DEFAULT_JVM_DECOMPILE_HEAP_MIB,
  DEFAULT_JVM_DECOMPILE_MS,
  DEFAULT_JVM_SOURCE_BYTES,
  MAX_JVM_DECOMPILE_HEAP_MIB,
  MAX_JVM_DECOMPILE_MS,
  MAX_JVM_SOURCE_BYTES,
  vineflowerIdentitySchema,
} from "../jvm/jvm.js";

/**
 * Android packages read from their bytes (format expansion F04): DEX files,
 * APKs, App Bundles (.aab), split APK sets (.apks) and XAPK packages. Nothing
 * is installed, signed, verified or run, no device is contacted, and
 * manifest declarations are not runtime grants. Splits, modules and DEX files
 * keep their own identities; a choice between them is never made silently.
 */

/** Default and maximum bytes read for one local package or DEX file. */
export const DEFAULT_ANDROID_FILE_BYTES = 256 * 1024 ** 2;
export const MAX_ANDROID_FILE_BYTES = 1024 ** 3;
/** Default and maximum bytes decompressed from archive members in one call. */
export const DEFAULT_ANDROID_DECODED_BYTES = 512 * 1024 ** 2;
export const MAX_ANDROID_DECODED_BYTES = 2 * 1024 ** 3;
/** Largest single member read (a nested APK or a native library). */
export const MAX_ANDROID_MEMBER_BYTES = 512 * 1024 ** 2;
/** Largest page of classes one artifact call returns. */
export const MAX_ANDROID_CLASS_PAGE = 5000;
/** Largest page of instructions one method call returns. */
export const MAX_DEX_INSTRUCTION_PAGE = 100_000;
/** Rendered manifest XML beyond this many characters is cut and says so. */
export const MAX_MANIFEST_XML_CHARS = 512 * 1024;

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const count = z.number().int().min(0);
const offset = z.number().int().min(0);

const pathField = z
  .string()
  .min(1)
  .describe(
    "Absolute path to a caller-selected local .dex, .apk, .aab, .apks or .xapk file",
  );
const maxFileBytesField = z
  .number()
  .int()
  .min(1)
  .max(MAX_ANDROID_FILE_BYTES)
  .default(DEFAULT_ANDROID_FILE_BYTES)
  .describe("Maximum stable bytes to read from the file (default 256 MiB)");
const maxDecodedBytesField = z
  .number()
  .int()
  .min(1)
  .max(MAX_ANDROID_DECODED_BYTES)
  .default(DEFAULT_ANDROID_DECODED_BYTES)
  .describe(
    "Maximum bytes to decompress from archive members in this call (default 512 MiB)",
  );

/** Where one DEX file is: the file itself, a member, or a member of a nested APK. */
const selectorShape = {
  container: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Member path of an APK inside an .apks or .xapk file, e.g. splits/base-master.apk",
    ),
  entry: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Exact member path of a DEX file, e.g. classes2.dex or base/dex/classes.dex (inside `container` when one is given)",
    ),
};

export const inspectAndroidArtifactInputSchema = z.strictObject({
  path: pathField,
  ...selectorShape,
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
    .max(MAX_ANDROID_CLASS_PAGE)
    .default(500)
    .describe("Maximum classes to return in this page"),
  max_file_bytes: maxFileBytesField,
  max_decoded_bytes: maxDecodedBytesField,
});
export type InspectAndroidArtifactInput = z.infer<
  typeof inspectAndroidArtifactInputSchema
>;

const classField = z
  .string()
  .min(1)
  .describe(
    "Class as a type descriptor (Lcom/example/Main;) or a binary name (com.example.Main)",
  );

export const inspectDexClassInputSchema = z.strictObject({
  path: pathField,
  ...selectorShape,
  class: classField,
  max_file_bytes: maxFileBytesField,
  max_decoded_bytes: maxDecodedBytesField,
});
export type InspectDexClassInput = z.infer<typeof inspectDexClassInputSchema>;

export const inspectDexMethodInputSchema = z.strictObject({
  path: pathField,
  ...selectorShape,
  class: classField,
  method: z
    .string()
    .min(1)
    .describe("Method name as stored, e.g. onCreate, <init> or <clinit>"),
  descriptor: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Method descriptor such as (Landroid/os/Bundle;)V; required when the name is overloaded",
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
    .max(MAX_DEX_INSTRUCTION_PAGE)
    .default(2000)
    .describe("Maximum instructions to return in this page"),
  max_file_bytes: maxFileBytesField,
  max_decoded_bytes: maxDecodedBytesField,
});
export type InspectDexMethodInput = z.infer<typeof inspectDexMethodInputSchema>;

const artifactSchema = z.strictObject({
  path: z.string().min(1),
  sha256,
  bytes: count,
});

export const androidPackageKindSchema = z.enum([
  "dex",
  "apk",
  "aab",
  "apks",
  "xapk",
  "zip",
]);
export type AndroidPackageKind = z.infer<typeof androidPackageKindSchema>;

const packageSchema = z.strictObject({
  kind: androidPackageKindSchema,
  /** `magic`: DEX bytes; `layout`: archive members that only this kind has; `name-hint`: only the suffix. */
  basis: z.enum(["magic", "layout", "name-hint"]),
  /** Set when the file name suggests a different kind than the bytes. */
  name_conflict: z.string().nullable(),
});

const diagnosticSchema = z.strictObject({
  container: z.string().nullable(),
  entry: z.string().nullable(),
  offset: offset.nullable(),
  message: z.string().min(1),
});
export type AndroidDiagnostic = z.infer<typeof diagnosticSchema>;

const pageSchema = z.strictObject({
  start: count,
  limit: z.number().int().min(1),
  returned: count,
  next: count.nullable(),
});

const nullableBoolean = z.boolean().nullable();
const nullableString = z.string().nullable();

const intentFilterSchema = z.strictObject({
  actions: z.array(z.string()),
  categories: z.array(z.string()),
  data: z.array(
    z.strictObject({
      scheme: nullableString,
      host: nullableString,
      port: nullableString,
      path: nullableString,
      path_prefix: nullableString,
      path_pattern: nullableString,
      mime_type: nullableString,
    }),
  ),
  priority: z.number().int().nullable(),
  auto_verify: nullableBoolean,
});

const componentSchema = z.strictObject({
  kind: z.enum([
    "activity",
    "activity-alias",
    "service",
    "receiver",
    "provider",
  ]),
  name: nullableString,
  class_name: nullableString,
  /** Null when the manifest does not declare it; platform defaults are not applied. */
  exported: nullableBoolean,
  enabled: nullableBoolean,
  permission: nullableString,
  process: nullableString,
  target_activity: nullableString,
  authorities: z.array(z.string()),
  intent_filters: z.array(intentFilterSchema),
});

/** Declarations read from AndroidManifest.xml; none of them is a runtime grant. */
export const androidManifestFactsSchema = z.strictObject({
  package_name: nullableString,
  version_code: z.number().int().nullable(),
  version_code_major: z.number().int().nullable(),
  version_name: nullableString,
  split: nullableString,
  config_for_split: nullableString,
  is_feature_split: nullableBoolean,
  is_split_required: nullableBoolean,
  min_sdk: nullableString,
  target_sdk: nullableString,
  max_sdk: nullableString,
  compile_sdk: nullableString,
  compile_sdk_codename: nullableString,
  platform_build_version: nullableString,
  uses_permissions: z.array(
    z.strictObject({
      name: z.string(),
      max_sdk: z.number().int().nullable(),
      kind: z.enum(["uses-permission", "uses-permission-sdk-23"]),
    }),
  ),
  declared_permissions: z.array(
    z.strictObject({ name: z.string(), protection_level: nullableString }),
  ),
  uses_features: z.array(
    z.strictObject({
      name: nullableString,
      required: nullableBoolean,
      gl_es_version: nullableString,
    }),
  ),
  uses_libraries: z.array(
    z.strictObject({
      name: z.string(),
      required: nullableBoolean,
      native: z.boolean(),
    }),
  ),
  uses_splits: z.array(z.string()),
  application: z
    .strictObject({
      name: nullableString,
      label: nullableString,
      debuggable: nullableBoolean,
      allow_backup: nullableBoolean,
      uses_cleartext_traffic: nullableBoolean,
      extract_native_libs: nullableBoolean,
      has_code: nullableBoolean,
      test_only: nullableBoolean,
      network_security_config: nullableString,
      app_component_factory: nullableString,
    })
    .nullable(),
  components: z.array(componentSchema),
  meta_data: z.array(
    z.strictObject({
      name: z.string(),
      value: nullableString,
      resource: nullableString,
    }),
  ),
  /** The `dist:module` element of an App Bundle module manifest. */
  module: z
    .strictObject({
      title: nullableString,
      delivery: z.array(z.string()),
      fusing_include: nullableBoolean,
      instant: nullableBoolean,
      type: nullableString,
    })
    .nullable(),
  problems: z.array(z.string()),
});
export type AndroidManifestFactsReport = z.infer<
  typeof androidManifestFactsSchema
>;

const manifestSchema = z.strictObject({
  container: nullableString,
  entry: z.string(),
  /** `binary-xml`: an installed-APK manifest; `proto-xml`: aapt2's protocol buffer form in bundles. */
  encoding: z.enum(["binary-xml", "proto-xml"]).nullable(),
  facts: androidManifestFactsSchema.nullable(),
  /** The decoded XML, rendered as text (references named when the resource table knows them). */
  xml: nullableString,
  xml_truncated: z.boolean(),
  /** Why the manifest could not be decoded, when it could not. */
  error: nullableString,
  problems: z.array(diagnosticSchema),
});

const resourceTableSchema = z.strictObject({
  container: nullableString,
  entry: z.string(),
  encoding: z.enum(["arsc", "proto"]),
  string_count: count.nullable(),
  packages: z.array(
    z.strictObject({
      id: z.number().int().nullable(),
      name: z.string(),
      types: z.array(
        z.strictObject({
          id: z.number().int().nullable(),
          name: z.string(),
          entry_count: count,
          /** Configuration qualifiers as aapt2 prints them; "" is the default configuration. */
          configs: z.array(z.string()),
        }),
      ),
    }),
  ),
  error: nullableString,
  problems: z.array(diagnosticSchema),
});

const signingSchema = z.strictObject({
  /** JAR signature files under META-INF (v1). Present, not verified. */
  jar_signers: z.array(
    z.strictObject({
      signature_file: z.string(),
      block_file: nullableString,
      block_type: z.enum(["RSA", "DSA", "EC"]).nullable(),
    }),
  ),
  jar_manifest: z.boolean(),
  /** The APK Signing Block before the ZIP central directory (v2, v3, v3.1 and other blocks). */
  signing_block: z
    .strictObject({
      offset,
      bytes: count,
      blocks: z.array(
        z.strictObject({
          id: z.string().regex(/^0x[0-9a-f]{8}$/u),
          /** Known block names; null for an ID this reader does not know. */
          name: nullableString,
          bytes: count,
        }),
      ),
    })
    .nullable(),
  signing_block_error: nullableString,
  /** Always false: signatures, digests and certificates are recorded, never checked or trusted. */
  verified: z.literal(false),
});

const nativeLibrarySchema = z.strictObject({
  container: nullableString,
  /** App Bundle module that holds it, or null. */
  module: nullableString,
  entry: z.string(),
  abi: z.string(),
  name: z.string(),
  bytes: count,
  sha256: sha256.nullable(),
  elf: z
    .strictObject({
      class: z.enum(["32", "64"]),
      machine: z.string(),
      /** Whether the ELF machine is the one the ABI directory names; null for an unknown ABI. */
      matches_abi: nullableBoolean,
    })
    .nullable(),
});

const dexFileSchema = z.strictObject({
  container: nullableString,
  entry: nullableString,
  module: nullableString,
  /** `code`: classesN.dex the platform loads as app code; `other`: a DEX elsewhere, e.g. in assets. */
  role: z.enum(["code", "other"]),
  sha256: sha256.nullable(),
  bytes: count,
  read: z.enum(["complete", "partial", "failed"]),
  error: nullableString,
  version: nullableString,
  checksum: z
    .strictObject({
      declared: z.string(),
      computed: z.string(),
      valid: z.boolean(),
    })
    .nullable(),
  signature: z
    .strictObject({
      declared: z.string(),
      computed: z.string(),
      valid: z.boolean(),
    })
    .nullable(),
  counts: z
    .strictObject({
      strings: count,
      types: count,
      protos: count,
      fields: count,
      methods: count,
      classes: count,
      call_sites: count,
      method_handles: count,
    })
    .nullable(),
  map: z.array(z.strictObject({ name: z.string(), size: count, offset })),
  problems: z.array(diagnosticSchema),
});

const apkSchema = z.strictObject({
  container: nullableString,
  manifest: manifestSchema.nullable(),
  resources: resourceTableSchema.nullable(),
  dex: z.array(z.string()),
  native_abis: z.array(z.string()),
  assets: count,
  resource_files: count,
  signing: signingSchema,
});

const moduleSchema = z.strictObject({
  name: z.string(),
  manifest: manifestSchema.nullable(),
  resources: resourceTableSchema.nullable(),
  dex: z.array(z.string()),
  native_abis: z.array(z.string()),
  assets: count,
  resource_files: count,
  /** Module-level bundle files such as assets.pb and native.pb. */
  metadata_files: z.array(z.string()),
});

const nestedApkSchema = z.strictObject({
  entry: z.string(),
  bytes: count,
  sha256: sha256.nullable(),
  /** Declared role: from toc.pb for .apks, from manifest.json for .xapk; `undeclared` when the set does not name it. */
  kind: z.enum([
    "split",
    "standalone",
    "instant",
    "system",
    "asset_slice",
    "apex",
    "archived",
    "base",
    "config",
    "undeclared",
    "unknown",
  ]),
  module: nullableString,
  split_id: nullableString,
  is_master: nullableBoolean,
  /** Targeting as declared, e.g. "abi=ARM64_V8A", "sdk>=31", "language=es". */
  targeting: z.array(z.string()),
  /** Variant numbers (toc.pb) that list this APK. */
  variants: z.array(count),
  manifest: z
    .strictObject({
      package_name: nullableString,
      version_code: z.number().int().nullable(),
      version_name: nullableString,
      split: nullableString,
      config_for_split: nullableString,
      is_feature_split: nullableBoolean,
      min_sdk: nullableString,
      target_sdk: nullableString,
    })
    .nullable(),
  dex: z.array(z.string()),
  native_abis: z.array(z.string()),
  error: nullableString,
});

/** A decoded protocol buffer or JSON document, field names as the format names them. */
const documentSchema = z.record(z.string(), jsonValueSchema);

const apkSetSchema = z.strictObject({
  format: z.enum(["apks", "xapk"]),
  /** bundletool's toc.pb (an .apks set), decoded field by field. */
  toc: documentSchema.nullable(),
  toc_error: nullableString,
  /** An XAPK's manifest.json, as parsed JSON. */
  xapk_manifest: documentSchema.nullable(),
  /** `apkpure-v2`: the one layout this reader admits (no producer-made XAPK was available to check it); `unknown`: other layouts keep generic ZIP facts only. */
  xapk_profile: z.enum(["apkpure-v2", "unknown"]).nullable(),
  xapk_error: nullableString,
  apks: z.array(nestedApkSchema),
  /** Paths the set declares that are not members. */
  missing: z.array(z.string()),
  /** APK members the set does not declare. */
  undeclared: z.array(z.string()),
  /** Base APKs found; more than one needs an explicit `container` choice. */
  base: z.strictObject({
    state: z.enum(["none", "single", "multiple"]),
    entries: z.array(z.string()),
  }),
  /** Disagreements between APKs of the set, e.g. different package names or version codes. */
  conflicts: z.array(z.string()),
  obb: z.array(
    z.strictObject({
      entry: z.string(),
      bytes: count,
      declared_path: nullableString,
    }),
  ),
});

const bundleSchema = z.strictObject({
  /** BundleConfig.pb, decoded field by field. */
  config: documentSchema.nullable(),
  config_error: nullableString,
  modules: z.array(moduleSchema),
  /** BUNDLE-METADATA/ members (for example ProGuard maps), listed, not read. */
  metadata: z.array(z.string()),
  signing: signingSchema,
});

export const dexClassSummarySchema = z.strictObject({
  container: nullableString,
  entry: nullableString,
  descriptor: z.string().nullable(),
  /** Java-style binary name, e.g. com.example.Main$Inner. */
  name: nullableString,
  access_flags: count,
  access: z.array(z.string()),
  superclass: nullableString,
  interfaces: z.array(z.string().nullable()),
  source_file: nullableString,
  static_fields: count,
  instance_fields: count,
  direct_methods: count,
  virtual_methods: count,
  decode: z.enum(["complete", "failed"]),
  error: nullableString,
});
export type DexClassSummary = z.infer<typeof dexClassSummarySchema>;

export const androidArtifactReportSchema = z.strictObject({
  artifact: artifactSchema,
  package: packageSchema,
  apk: apkSchema.nullable(),
  bundle: bundleSchema.nullable(),
  apk_set: apkSetSchema.nullable(),
  dex_files: z.array(dexFileSchema),
  native_libraries: z.array(nativeLibrarySchema),
  summary: z.strictObject({
    entries: count,
    dex_files: count,
    classes: count,
    native_libraries: count,
    decoded_bytes: count,
  }),
  /** Classes in the selected scope (all DEX files, or the one `container`/`entry` names). */
  class_count: count,
  page: pageSchema,
  classes: z.array(dexClassSummarySchema),
  diagnostics: z.array(diagnosticSchema),
  coverage: z.array(facetCoverageSchema),
  limitations: z.array(z.string()),
});
export type AndroidArtifactReport = z.infer<typeof androidArtifactReportSchema>;

const selectionSchema = z.strictObject({
  container: nullableString,
  entry: nullableString,
  dex_sha256: sha256,
  /**
   * `file`: a bare DEX; `only`: the single DEX defining the class; `entry`:
   * named exactly; `identical`: every definition is in byte-identical DEX
   * files (split sets repeat the base per variant), so the first is read.
   */
  basis: z.enum(["file", "only", "entry", "identical"]),
  class_def_index: count,
  class_def_offset: offset,
  /** Every DEX in the artifact that defines this class, so a choice is never silent. */
  definitions: z.array(
    z.strictObject({ container: nullableString, entry: nullableString }),
  ),
});

const annotationSchema = z.strictObject({
  visibility: z.enum(["build", "runtime", "system", "unknown"]),
  type: nullableString,
  elements: z.array(
    z.strictObject({ name: nullableString, value: z.string() }),
  ),
});

const codeSummarySchema = z.strictObject({
  offset,
  registers: count,
  ins: count,
  outs: count,
  /** Size of the instruction array in 16-bit code units. */
  insns_units: count,
  tries: count,
  debug_info_offset: offset.nullable(),
});

const fieldSchema = z.strictObject({
  field_index: count,
  name: nullableString,
  type: nullableString,
  access_flags: count,
  access: z.array(z.string()),
  /** Static initial value from static_values_off, rendered as dexdump renders it. */
  value: nullableString,
  annotations: z.array(annotationSchema),
});

const methodSchema = z.strictObject({
  method_index: count,
  name: nullableString,
  /** Exact DEX descriptor, e.g. (Landroid/os/Bundle;)V. */
  descriptor: nullableString,
  access_flags: count,
  access: z.array(z.string()),
  code: codeSummarySchema.nullable(),
  parameters: z.array(
    z.strictObject({
      type: nullableString,
      /** From debug info; null when the DEX does not record it. */
      name: nullableString,
      annotations: z.array(annotationSchema),
    }),
  ),
  annotations: z.array(annotationSchema),
});

export const dexClassReportSchema = z.strictObject({
  artifact: artifactSchema,
  selection: selectionSchema,
  class: z.strictObject({
    descriptor: z.string(),
    name: z.string(),
    access_flags: count,
    access: z.array(z.string()),
    superclass: nullableString,
    interfaces: z.array(z.string().nullable()),
    source_file: nullableString,
    annotations: z.array(annotationSchema),
    static_fields: z.array(fieldSchema),
    instance_fields: z.array(fieldSchema),
    direct_methods: z.array(methodSchema),
    virtual_methods: z.array(methodSchema),
  }),
  diagnostics: z.array(diagnosticSchema),
  limitations: z.array(z.string()),
});
export type DexClassReport = z.infer<typeof dexClassReportSchema>;

const referenceSchema = z.strictObject({
  kind: z.enum([
    "string",
    "type",
    "field",
    "method",
    "proto",
    "call_site",
    "method_handle",
  ]),
  index: count,
  text: nullableString,
});

const instructionSchema = z.strictObject({
  index: count,
  /** Address in 16-bit code units from the start of the method. */
  address: count,
  /** Byte offset in the DEX file. */
  offset,
  units: z.number().int().min(1),
  opcode: z.string().regex(/^0x[0-9a-f]{2,4}$/u),
  mnemonic: z.string().min(1),
  format: z.string().min(1),
  /** Operands exactly as dexdump prints them after the mnemonic. */
  operands: z.string(),
  line: z.number().int().nullable(),
  registers: z.array(count),
  literal: nullableString,
  target: count.nullable(),
  reference: referenceSchema.nullable(),
  proto: referenceSchema.nullable(),
  switch_targets: z
    .array(z.strictObject({ key: z.number().int(), target: z.number().int() }))
    .nullable(),
  array_data: z
    .strictObject({ element_width: z.number().int().min(1), count })
    .nullable(),
});

const referencesSchema = z.strictObject({
  invocations: z.array(
    z.strictObject({
      address: count,
      kind: z.enum([
        "virtual",
        "super",
        "direct",
        "static",
        "interface",
        "polymorphic",
        "custom",
      ]),
      reference: referenceSchema,
    }),
  ),
  field_accesses: z.array(
    z.strictObject({
      address: count,
      access: z.enum(["read", "write"]),
      static: z.boolean(),
      reference: referenceSchema,
    }),
  ),
  types: z.array(
    z.strictObject({
      address: count,
      use: z.enum([
        "new-instance",
        "new-array",
        "filled-new-array",
        "check-cast",
        "instance-of",
        "const-class",
      ]),
      reference: referenceSchema,
    }),
  ),
  strings: z.array(
    z.strictObject({ address: count, reference: referenceSchema }),
  ),
  other: z.array(
    z.strictObject({ address: count, reference: referenceSchema }),
  ),
});

export const dexMethodReportSchema = z.strictObject({
  artifact: artifactSchema,
  selection: selectionSchema,
  method: z.strictObject({
    class: z.string(),
    name: z.string(),
    descriptor: z.string(),
    method_index: count,
    access_flags: count,
    access: z.array(z.string()),
    code: codeSummarySchema.nullable(),
  }),
  instruction_count: count,
  page: pageSchema,
  instructions: z.array(instructionSchema),
  tries: z.array(
    z.strictObject({
      start: count,
      end: count,
      handlers: z.array(
        z.strictObject({ type: nullableString, address: count }),
      ),
    }),
  ),
  positions: z.array(
    z.strictObject({ address: count, line: z.number().int() }),
  ),
  locals: z.array(
    z.strictObject({
      register: count,
      start: count,
      end: count,
      name: nullableString,
      type: nullableString,
      signature: nullableString,
    }),
  ),
  /** Every reference the whole method makes, whatever page is returned. */
  references: referencesSchema,
  problems: z.array(z.strictObject({ address: count, message: z.string() })),
  diagnostics: z.array(diagnosticSchema),
  limitations: z.array(z.string()),
});
export type DexMethodReport = z.infer<typeof dexMethodReportSchema>;

export const decompileDexClassInputSchema = z.strictObject({
  path: pathField,
  ...selectorShape,
  class: classField,
  timeout_ms: z
    .number()
    .int()
    .min(1000)
    .max(MAX_JVM_DECOMPILE_MS)
    .default(DEFAULT_JVM_DECOMPILE_MS)
    .describe(
      "Wall-clock limit for dex2jar and, separately, for the decompiler (default 120 s each)",
    ),
  max_heap_mib: z
    .number()
    .int()
    .min(128)
    .max(MAX_JVM_DECOMPILE_HEAP_MIB)
    .default(DEFAULT_JVM_DECOMPILE_HEAP_MIB)
    .describe("Java heap for each tool process in MiB (default 1024)"),
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
export type DecompileDexClassInput = z.infer<
  typeof decompileDexClassInputSchema
>;

const dexCheckSchema = z.strictObject({
  id: z.enum(["dex2jar_translated", "vineflower_clean", "methods_present"]),
  state: z.enum(["passed", "failed", "not_checked"]),
  detail: z.string(),
});

export const dexDecompilationSchema = z.strictObject({
  artifact: artifactSchema,
  selection: selectionSchema,
  class: z.strictObject({ descriptor: z.string(), name: z.string() }),
  /** The outermost class decompiled (internal name); nested classes are written inside it. */
  top_level: z.string(),
  /** Class files dex2jar produced that the decompiler read, by identity. */
  classes: z.array(
    z.strictObject({
      name: z.string(),
      role: z.enum(["selected", "outer", "nested"]),
      sha256,
      bytes: count,
    }),
  ),
  /** Nested classes the converted bytes name but that the DEX file does not define. */
  missing_nested: z.array(z.string()),
  converter: z.strictObject({
    id: z.literal("dex2jar"),
    version: z.string(),
    build: z.string(),
    lib: z.strictObject({
      path: z.string(),
      /** SHA-256 of the sorted `name:sha256` lines of every jar in lib/. */
      set_sha256: sha256,
      jars: count,
    }),
    java: z.strictObject({ path: z.string(), version: z.string() }),
    options: z.array(z.string()),
  }),
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
    /** SHA-256 of the DEX file the text was reconstructed from. */
    derived_from: z.array(sha256),
  }),
  /** `$VF:` notes and unresolved invokedynamic lines, by line of the text. */
  decompiler_notes: z.array(
    z.strictObject({ line: z.number().int().min(1), text: z.string() }),
  ),
  /**
   * Methods whose decompiled body must not be trusted: dex2jar could not
   * translate them (the converted body only throws), or the converted
   * bytecode did not decode cleanly.
   */
  untrusted_methods: z.array(
    z.strictObject({
      source: z.enum(["dex2jar", "class_file"]),
      class: z.string().nullable(),
      method: z.string().nullable(),
      descriptor: z.string().nullable(),
      reason: z.string(),
    }),
  ),
  /** Methods the DEX declares for the class whose names the text does not contain (capped). */
  missing_methods: z.array(
    z.strictObject({ name: z.string(), descriptor: z.string().nullable() }),
  ),
  /** Warnings and errors dex2jar and the decompiler printed. */
  messages: z.array(z.string()),
  checks: z.array(dexCheckSchema),
  coverage: z.array(facetCoverageSchema),
  limitations: z.array(z.string()),
});
export type DexDecompilation = z.infer<typeof dexDecompilationSchema>;
