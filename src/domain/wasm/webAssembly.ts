import { z } from "zod";

import { facetCoverageSchema } from "../formatRegistry.js";

/**
 * WebAssembly inspection (format expansion F01). Modules are decoded from
 * their bytes and never instantiated: no start function runs, no import is
 * resolved. Every fact keeps its byte offset in the original file; facts the
 * reader cannot establish stay explicit (unsupported proposals, unknown
 * indirect-call targets, missing names) instead of being guessed.
 */

/** Default and maximum bytes read for one local module or WAT file. */
export const DEFAULT_WASM_FILE_BYTES = 64 * 1024 ** 2;
export const MAX_WASM_FILE_BYTES = 256 * 1024 ** 2;
/** Largest page of functions one module call returns. */
export const MAX_WASM_FUNCTION_PAGE = 2000;
/** Largest page of instructions one function call returns. */
export const MAX_WASM_INSTRUCTION_PAGE = 10_000;
/** Entries beyond this per list (imports, exports, types, ...) are counted, not listed. */
export const MAX_WASM_LISTED = 10_000;
/** Bytes of each data segment shown as a preview. */
export const WASM_DATA_PREVIEW_BYTES = 64;
/** Largest WAT text one conversion writes. */
export const MAX_WAT_OUTPUT_BYTES = 512 * 1024 ** 2;

export const wasmSourceFormatSchema = z.enum(["binary", "text"]);
export type WasmSourceFormat = z.infer<typeof wasmSourceFormatSchema>;

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const offset = z.number().int().min(0);

const pathField = z
  .string()
  .min(1)
  .describe("Absolute path to a caller-selected local .wasm or .wat file");
const formatField = wasmSourceFormatSchema
  .optional()
  .describe(
    "Read as a binary module or as WebAssembly text instead of what the magic bytes and name suffix suggest",
  );
const maxFileBytesField = z
  .number()
  .int()
  .min(1)
  .max(MAX_WASM_FILE_BYTES)
  .default(DEFAULT_WASM_FILE_BYTES)
  .describe(
    "Maximum stable bytes to read and decode in process (default 64 MiB)",
  );

export const inspectWasmModuleInputSchema = z.strictObject({
  path: pathField,
  format: formatField,
  start: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("Index of the first function (imports first) to return"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_WASM_FUNCTION_PAGE)
    .default(200)
    .describe("Maximum functions to return in this page"),
  max_file_bytes: maxFileBytesField,
});
export type InspectWasmModuleInput = z.infer<
  typeof inspectWasmModuleInputSchema
>;

export const inspectWasmFunctionInputSchema = z.strictObject({
  path: pathField,
  format: formatField,
  function_index: z
    .number()
    .int()
    .min(0)
    .describe(
      "Function index in the module's function index space (imported functions come first)",
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
    .max(MAX_WASM_INSTRUCTION_PAGE)
    .default(1000)
    .describe("Maximum instructions to return in this page"),
  max_file_bytes: maxFileBytesField,
});
export type InspectWasmFunctionInput = z.infer<
  typeof inspectWasmFunctionInputSchema
>;

export const convertWasmToTextInputSchema = z.strictObject({
  path: pathField,
  output_path: z
    .string()
    .min(1)
    .describe(
      "Absolute path of a new .wat file to create; an existing file is never overwritten",
    ),
  max_file_bytes: maxFileBytesField,
});
export type ConvertWasmToTextInput = z.infer<
  typeof convertWasmToTextInputSchema
>;

const artifactSchema = z.strictObject({
  path: z.string().min(1),
  sha256,
  bytes: z.number().int().min(0),
});

/** Where the decoded module bytes came from. */
export const wasmSourceSchema = z.strictObject({
  format: wasmSourceFormatSchema,
  basis: z.enum(["magic", "name-hint", "requested"]),
  /** A WAT input is assembled into this separate derived module; the original text is never rewritten. */
  derived_binary: z
    .strictObject({
      sha256,
      bytes: z.number().int().min(0),
      converter: z.string().min(1),
    })
    .nullable(),
});

export const wasmValidationSchema = z.strictObject({
  state: z.enum(["valid", "invalid", "requires-proposal", "not_checked"]),
  validator: z.string().min(1),
  /** Feature profile the module was validated against. */
  profile: z.string().min(1),
  message: z.string().nullable(),
});

export const wasmDiagnosticSchema = z.strictObject({
  offset,
  section: z.string().nullable(),
  message: z.string().min(1),
  /** Proposal that owns the bytes when the reader stopped because it does not decode them. */
  proposal: z.string().nullable(),
});

const limitsSchema = z.strictObject({
  min: z.number().int().min(0),
  max: z.number().int().min(0).nullable(),
  shared: z.boolean(),
  memory64: z.boolean(),
});

const decodeStateSchema = z.enum(["complete", "stopped", "not_applicable"]);
const decodeErrorSchema = z
  .strictObject({
    offset,
    message: z.string().min(1),
    proposal: z.string().nullable(),
  })
  .nullable();

const nameSourceSchema = z
  .enum(["name-section", "export", "import"])
  .nullable();

export const wasmFunctionSchema = z.strictObject({
  index: z.number().int().min(0),
  name: z.string().nullable(),
  /** `name-section` names come from the module; `export`/`import` names are borrowed from those declarations. */
  name_source: nameSourceSchema,
  imported: z
    .strictObject({ module: z.string(), name: z.string(), offset })
    .nullable(),
  type: z.number().int().min(0).nullable(),
  signature: z.string().nullable(),
  exports: z.array(z.string()),
  body: z
    .strictObject({
      offset,
      size: z.number().int().min(0),
      code_offset: offset,
      locals: z.number().int().min(0),
    })
    .nullable(),
  instructions: z.number().int().min(0).nullable(),
  decode: decodeStateSchema,
  decode_error: decodeErrorSchema,
  /** Distinct functions this body calls directly (`call`, `return_call`). */
  direct_callees: z.array(z.number().int().min(0)),
  indirect_call_sites: z.number().int().min(0),
  /** Distinct decoded functions that call this one directly. */
  direct_callers: z.number().int().min(0),
});
export type WasmFunction = z.infer<typeof wasmFunctionSchema>;

const pageSchema = z.strictObject({
  start: z.number().int().min(0),
  limit: z.number().int().min(1),
  returned: z.number().int().min(0),
  next: z.number().int().min(0).nullable(),
});

const omittedSchema = z.strictObject({
  types: z.number().int().min(0),
  imports: z.number().int().min(0),
  exports: z.number().int().min(0),
  globals: z.number().int().min(0),
  elements: z.number().int().min(0),
  data: z.number().int().min(0),
});

export const wasmModuleReportSchema = z.strictObject({
  artifact: artifactSchema,
  source: wasmSourceSchema,
  encoding: z.strictObject({
    kind: z.enum(["module", "component", "unknown"]),
    version: z.number().int().min(0).nullable(),
  }),
  validation: wasmValidationSchema,
  /** Proposals the bytes use that this reader does not decode. */
  unsupported_proposals: z.array(z.string()),
  module_name: z.string().nullable(),
  producers: z.array(
    z.strictObject({
      field: z.string(),
      values: z.array(
        z.strictObject({ name: z.string(), version: z.string() }),
      ),
    }),
  ),
  summary: z.strictObject({
    sections: z.number().int().min(0),
    types: z.number().int().min(0),
    imports: z.number().int().min(0),
    functions: z.number().int().min(0),
    imported_functions: z.number().int().min(0),
    tables: z.number().int().min(0),
    memories: z.number().int().min(0),
    globals: z.number().int().min(0),
    exports: z.number().int().min(0),
    elements: z.number().int().min(0),
    data: z.number().int().min(0),
    named_functions: z.number().int().min(0),
    instructions: z.number().int().min(0),
    direct_call_edges: z.number().int().min(0),
    indirect_call_sites: z.number().int().min(0),
  }),
  sections: z.array(
    z.strictObject({
      id: z.number().int().min(0),
      name: z.string(),
      custom_name: z.string().nullable(),
      offset,
      payload_offset: offset,
      size: z.number().int().min(0),
      decoded: z.boolean(),
    }),
  ),
  types: z.array(
    z.strictObject({
      index: z.number().int().min(0),
      params: z.array(z.string()),
      results: z.array(z.string()),
    }),
  ),
  imports: z.array(
    z.strictObject({
      module: z.string(),
      name: z.string(),
      kind: z.enum(["func", "table", "memory", "global", "tag"]),
      index: z.number().int().min(0),
      description: z.string(),
      offset,
    }),
  ),
  tables: z.array(
    z.strictObject({
      index: z.number().int().min(0),
      imported: z.boolean(),
      exported_as: z.array(z.string()),
      type: z.string(),
      limits: limitsSchema,
    }),
  ),
  memories: z.array(
    z.strictObject({
      index: z.number().int().min(0),
      imported: z.boolean(),
      exported_as: z.array(z.string()),
      limits: limitsSchema,
    }),
  ),
  globals: z.array(
    z.strictObject({
      index: z.number().int().min(0),
      imported: z.boolean(),
      type: z.string(),
      mutable: z.boolean(),
      init: z.string().nullable(),
    }),
  ),
  exports: z.array(
    z.strictObject({
      name: z.string(),
      kind: z.enum(["func", "table", "memory", "global", "tag"]),
      index: z.number().int().min(0),
      offset,
    }),
  ),
  start: z
    .strictObject({
      function: z.number().int().min(0),
      name: z.string().nullable(),
    })
    .nullable(),
  elements: z.array(
    z.strictObject({
      index: z.number().int().min(0),
      offset,
      mode: z.enum(["active", "passive", "declarative"]),
      table: z.number().int().min(0).nullable(),
      offset_expression: z.string().nullable(),
      type: z.string(),
      items: z.number().int().min(0),
      functions: z.array(z.number().int().min(0)),
      null_items: z.number().int().min(0),
      unknown_items: z.number().int().min(0),
    }),
  ),
  data: z.array(
    z.strictObject({
      index: z.number().int().min(0),
      offset,
      mode: z.enum(["active", "passive"]),
      memory: z.number().int().min(0).nullable(),
      offset_expression: z.string().nullable(),
      payload_offset: offset,
      size: z.number().int().min(0),
      preview_hex: z.string(),
      preview_text: z.string(),
    }),
  ),
  omitted: omittedSchema,
  function_count: z.number().int().min(0),
  page: pageSchema,
  functions: z.array(wasmFunctionSchema),
  diagnostics: z.array(wasmDiagnosticSchema),
  coverage: z.array(facetCoverageSchema),
  limitations: z.array(z.string()),
});
export type WasmModuleReport = z.infer<typeof wasmModuleReportSchema>;

export const wasmInstructionSchema = z.strictObject({
  index: z.number().int().min(0),
  offset,
  size: z.number().int().min(1),
  depth: z.number().int().min(0),
  op: z.string().min(1),
  /** WAT-style immediates using indices; names are never invented. */
  immediates: z.string(),
});
export type WasmInstruction = z.infer<typeof wasmInstructionSchema>;

const functionRefSchema = z.strictObject({
  index: z.number().int().min(0),
  name: z.string().nullable(),
});

export const wasmIndirectTargetsSchema = z.strictObject({
  /**
   * `static`: every element that can reach the table is known and nothing can
   * change it; `partial`: listed candidates are real but the host or code may
   * add others; `unknown`: the table's contents are not visible in this module.
   */
  state: z.enum(["static", "partial", "unknown"]),
  candidates: z.array(functionRefSchema),
  reasons: z.array(z.string()),
});

export const wasmFunctionReportSchema = z.strictObject({
  artifact: artifactSchema,
  source: wasmSourceSchema,
  function: wasmFunctionSchema.extend({
    locals: z.array(
      z.strictObject({
        index: z.number().int().min(0),
        type: z.string(),
        name: z.string().nullable(),
      }),
    ),
    locals_omitted: z.number().int().min(0),
  }),
  instruction_count: z.number().int().min(0),
  page: pageSchema,
  instructions: z.array(wasmInstructionSchema),
  calls: z.array(
    z.strictObject({
      instruction: z.number().int().min(0),
      offset,
      tail: z.boolean(),
      target: functionRefSchema,
    }),
  ),
  indirect_calls: z.array(
    z.strictObject({
      instruction: z.number().int().min(0),
      offset,
      tail: z.boolean(),
      type: z.number().int().min(0),
      table: z.number().int().min(0),
      signature: z.string().nullable(),
      targets: wasmIndirectTargetsSchema,
    }),
  ),
  calls_omitted: z.number().int().min(0),
  coverage: z.array(facetCoverageSchema),
  limitations: z.array(z.string()),
});
export type WasmFunctionReport = z.infer<typeof wasmFunctionReportSchema>;

export const wasmTextConversionSchema = z.strictObject({
  artifact: artifactSchema,
  output: z.strictObject({
    path: z.string().min(1),
    sha256,
    bytes: z.number().int().min(0),
    media_type: z.literal("text/plain; charset=utf-8"),
    /** The WAT is a derived rendering, not the original file. */
    derived_from: sha256,
    converter: z.string().min(1),
    names: z.enum(["name-section", "indices"]),
  }),
  validation: wasmValidationSchema,
  limitations: z.array(z.string()),
});
export type WasmTextConversion = z.infer<typeof wasmTextConversionSchema>;

export const DEFAULT_WASM2C_MS = 60_000;
export const MAX_WASM2C_MS = 600_000;
/** Default and maximum bytes of generated C plus header returned inline. */
export const DEFAULT_WASM_C_BYTES = 8 * 1024 ** 2;
export const MAX_WASM_C_BYTES = 64 * 1024 ** 2;
/** wasm2c prefixes every generated symbol with this name (`-n`). */
export const WASM_C_MODULE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u;

export const convertWasmToCInputSchema = z.strictObject({
  path: pathField,
  format: formatField,
  module_name: z
    .string()
    .regex(WASM_C_MODULE_NAME)
    .optional()
    .describe(
      "C identifier wasm2c prefixes to every generated symbol (default: the module's own name, else the file name, else `module`)",
    ),
  check: z
    .boolean()
    .default(true)
    .describe(
      "Syntax-check the C with an installed clang and compare the header's exported functions with the module's (default true)",
    ),
  timeout_ms: z
    .number()
    .int()
    .min(1000)
    .max(MAX_WASM2C_MS)
    .default(DEFAULT_WASM2C_MS)
    .describe(
      "Wall-clock limit for wasm2c and, separately, for the compile check (default 60 s)",
    ),
  max_source_bytes: z
    .number()
    .int()
    .min(1)
    .max(MAX_WASM_C_BYTES)
    .default(DEFAULT_WASM_C_BYTES)
    .describe(
      "Largest C plus header returned inline; larger output is refused, not cut (default 8 MiB)",
    ),
  max_file_bytes: maxFileBytesField,
});
export type ConvertWasmToCInput = z.infer<typeof convertWasmToCInputSchema>;

const generatedTextSchema = z.strictObject({
  /** File name wasm2c wrote; the C file includes the header by this name. */
  name: z.string().min(1),
  /** Mechanically translated C; it is derived from the module, not original source. */
  text: z.string(),
  bytes: z.number().int().min(0),
  sha256,
  lines: z.number().int().min(0),
  media_type: z.literal("text/x-c; charset=utf-8"),
  confidence: z.literal("derived"),
  derived_from: z.array(sha256),
});

const wasmCCheckSchema = z.strictObject({
  id: z.enum(["wasm2c_succeeded", "compiles", "exports_match"]),
  state: z.enum(["passed", "failed", "not_checked"]),
  detail: z.string(),
});

export const wasmCConversionSchema = z.strictObject({
  artifact: artifactSchema,
  source: wasmSourceSchema,
  module_name: z.string().regex(WASM_C_MODULE_NAME),
  converter: z.strictObject({
    id: z.literal("wasm2c"),
    version: z.string(),
    build: z.string(),
    executable: z.strictObject({ path: z.string(), sha256 }),
    arguments: z.array(z.string()),
  }),
  c: generatedTextSchema,
  header: generatedTextSchema,
  /** Distinct lines wasm2c printed while succeeding (capped). */
  messages: z.array(z.string()),
  checks: z.array(wasmCCheckSchema),
  /** The clang that syntax-checked the C and wabt's runtime header directory, when it ran. */
  compiler: z
    .strictObject({ path: z.string(), include: z.string() })
    .nullable(),
  /** First distinct clang diagnostics when the C did not compile (capped). */
  compile_errors: z.array(z.string()),
  /** Function exports of the module against the exported functions the header declares. */
  exports: z
    .strictObject({
      module: z.number().int().min(0),
      declared: z.number().int().min(0),
      missing: z.array(z.string()),
      extra: z.array(z.string()),
    })
    .nullable(),
  coverage: z.array(facetCoverageSchema),
  limitations: z.array(z.string()),
});
export type WasmCConversion = z.infer<typeof wasmCConversionSchema>;
