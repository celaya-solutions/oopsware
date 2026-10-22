import { z } from "zod";

import { facetCoverageSchema } from "../formatRegistry.js";

/**
 * Python source, CPython bytecode, wheels and zip applications (format
 * expansion F03). Nothing is imported, executed, compiled or pip-installed.
 * Bytecode is decoded in process only for release profiles whose exact magic
 * number was checked against that release's own `dis`; source is parsed by
 * an installed interpreter's `ast` module in a separate process.
 */

export const DEFAULT_PYTHON_FILE_BYTES = 128 * 1024 ** 2;
export const MAX_PYTHON_FILE_BYTES = 512 * 1024 ** 2;
export const DEFAULT_PYTHON_DECODED_BYTES = 512 * 1024 ** 2;
export const MAX_PYTHON_DECODED_BYTES = 2 * 1024 ** 3;
/** Largest single archive member read. */
export const MAX_PYTHON_MEMBER_BYTES = 256 * 1024 ** 2;
/** Largest source handed to a parser; bigger files are refused, not truncated. */
export const MAX_PYTHON_SOURCE_BYTES = 64 * 1024 ** 2;
export const MAX_PYTHON_MODULE_PAGE = 5000;
export const MAX_PYTHON_INSTRUCTION_PAGE = 100_000;
/** Objects one .pyc load may create; real modules stay far below this. */
export const MAX_PYTHON_MARSHAL_OBJECTS = 5_000_000;
export const MAX_PYTHON_CODE_OBJECTS = 100_000;
export const DEFAULT_PYTHON_LISTED = 2000;
export const MAX_PYTHON_LISTED = 50_000;
export const DEFAULT_PYTHON_PARSE_MS = 60_000;
export const MAX_PYTHON_PARSE_MS = 600_000;

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const count = z.number().int().min(0);
const line = z.number().int().nullable();

const pathField = z
  .string()
  .min(1)
  .describe(
    "Absolute path to a caller-selected local .py, .pyc, .whl, .pyz or ZIP file",
  );
const entryField = z
  .string()
  .min(1)
  .optional()
  .describe(
    "Exact archive member path of a .py or .pyc file inside a wheel, zip application or ZIP",
  );
const maxFileBytesField = z
  .number()
  .int()
  .min(1)
  .max(MAX_PYTHON_FILE_BYTES)
  .default(DEFAULT_PYTHON_FILE_BYTES)
  .describe("Maximum stable bytes to read from the file (default 128 MiB)");
const maxDecodedBytesField = z
  .number()
  .int()
  .min(1)
  .max(MAX_PYTHON_DECODED_BYTES)
  .default(DEFAULT_PYTHON_DECODED_BYTES)
  .describe(
    "Maximum bytes to decompress from archive members in this call (default 512 MiB)",
  );

export const inspectPythonArtifactInputSchema = z.strictObject({
  path: pathField,
  start: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("Index of the first module to return"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_PYTHON_MODULE_PAGE)
    .default(500)
    .describe("Maximum modules to return in this page"),
  max_file_bytes: maxFileBytesField,
  max_decoded_bytes: maxDecodedBytesField,
});
export type InspectPythonArtifactInput = z.infer<
  typeof inspectPythonArtifactInputSchema
>;

export const inspectPythonModuleInputSchema = z.strictObject({
  path: pathField,
  entry: entryField,
  python: z
    .string()
    .regex(/^3\.\d{1,2}$/u)
    .optional()
    .describe(
      "Python feature release whose grammar parses source, e.g. 3.12; the newest installed interpreter is used otherwise",
    ),
  max_listed: z
    .number()
    .int()
    .min(1)
    .max(MAX_PYTHON_LISTED)
    .default(DEFAULT_PYTHON_LISTED)
    .describe(
      "Most imports, definitions, calls and other facts listed per kind; totals are always counted",
    ),
  timeout_ms: z
    .number()
    .int()
    .min(1000)
    .max(MAX_PYTHON_PARSE_MS)
    .default(DEFAULT_PYTHON_PARSE_MS)
    .describe("Time allowed for the source parser process (default 60 s)"),
  max_file_bytes: maxFileBytesField,
  max_decoded_bytes: maxDecodedBytesField,
});
export type InspectPythonModuleInput = z.infer<
  typeof inspectPythonModuleInputSchema
>;

export const inspectPythonCodeInputSchema = z.strictObject({
  path: pathField,
  entry: entryField,
  code: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Qualified name of the code object, e.g. Child.fetch or outer.<locals>.inner; it must be unique",
    ),
  code_index: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Pre-order index of the code object as inspect_python_module lists it; 0 is the module",
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
    .max(MAX_PYTHON_INSTRUCTION_PAGE)
    .default(2000)
    .describe("Maximum instructions to return in this page"),
  max_file_bytes: maxFileBytesField,
  max_decoded_bytes: maxDecodedBytesField,
});
export type InspectPythonCodeInput = z.infer<
  typeof inspectPythonCodeInputSchema
>;

const artifactSchema = z.strictObject({
  path: z.string().min(1),
  sha256,
  bytes: count,
});

export const pythonContainerKindSchema = z.enum([
  "source",
  "bytecode",
  "wheel",
  "zipapp",
  "zip",
]);
export type PythonContainerKind = z.infer<typeof pythonContainerKindSchema>;

const containerSchema = z.strictObject({
  kind: pythonContainerKindSchema,
  /** `magic`: .pyc header; `layout`: archive members; `name-hint`: only the suffix; `text`: decodable text with a .py name. */
  basis: z.enum(["magic", "layout", "name-hint", "text"]),
  name_conflict: z.string().nullable(),
});

const pageSchema = z.strictObject({
  start: count,
  limit: count,
  returned: count,
  next: count.nullable(),
});

const invalidationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("timestamp"),
    source_mtime: count,
    source_size: count,
  }),
  z.strictObject({
    kind: z.enum(["checked-hash", "unchecked-hash"]),
    /** importlib's SipHash of the source, hex. */
    source_hash: z.string().regex(/^[a-f0-9]{16}$/u),
  }),
]);

export const pycHeaderSchema = z.strictObject({
  magic: count,
  /** The release a known final-release magic number belongs to. */
  release: z.string().nullable(),
  /** Whether this exact magic number has a decoding profile. */
  admitted: z.boolean(),
  flags: count.nullable(),
  invalidation: invalidationSchema.nullable(),
  header_bytes: count,
  problem: z.string().nullable(),
});

const moduleSummarySchema = z.strictObject({
  /** Archive member path; null for a loose file. */
  entry: z.string().nullable(),
  kind: z.enum(["source", "bytecode"]),
  /** Dotted module name from the member path; null when the path is not importable. */
  module: z.string().nullable(),
  sha256: sha256.nullable(),
  bytes: count,
  /** For bytecode: the magic number, its release and whether it is decoded. */
  magic: count.nullable(),
  release: z.string().nullable(),
  admitted: z.boolean().nullable(),
  problem: z.string().nullable(),
});

const recordMismatchSchema = z.strictObject({
  entry: z.string(),
  algorithm: z.string(),
  expected: z.string(),
  actual: z.string().nullable(),
  expected_size: count.nullable(),
  actual_size: count.nullable(),
});

const wheelSchema = z.strictObject({
  /** PEP 427 file name parts; null when the name does not follow it. */
  filename: z
    .strictObject({
      distribution: z.string(),
      version: z.string(),
      build: z.string().nullable(),
      python_tags: z.array(z.string()),
      abi_tags: z.array(z.string()),
      platform_tags: z.array(z.string()),
    })
    .nullable(),
  dist_info: z.string().nullable(),
  /** Core metadata fields as written; multiple-use fields keep every value. */
  metadata: z
    .strictObject({
      metadata_version: z.string().nullable(),
      name: z.string().nullable(),
      version: z.string().nullable(),
      summary: z.string().nullable(),
      requires_python: z.string().nullable(),
      requires_dist: z.array(z.string()),
      provides_extra: z.array(z.string()),
      license: z.string().nullable(),
      license_expression: z.string().nullable(),
      license_files: z.array(z.string()),
      classifiers: z.array(z.string()),
      project_urls: z.array(z.string()),
      author: z.string().nullable(),
      author_email: z.string().nullable(),
      has_description: z.boolean(),
    })
    .nullable(),
  wheel: z
    .strictObject({
      wheel_version: z.string().nullable(),
      generator: z.string().nullable(),
      root_is_purelib: z.boolean().nullable(),
      tags: z.array(z.string()),
      build: z.string().nullable(),
    })
    .nullable(),
  /** entry_points.txt declarations; none is run. */
  entry_points: z.array(
    z.strictObject({ group: z.string(), name: z.string(), value: z.string() }),
  ),
  record: z
    .strictObject({
      entry: z.string(),
      rows: count,
      verified: count,
      mismatched: z.array(recordMismatchSchema),
      /** Rows with no digest (RECORD itself, signatures). */
      unhashed: z.array(z.string()),
      /** Members RECORD does not list. */
      not_listed: z.array(z.string()),
      /** RECORD rows naming no member. */
      absent: z.array(z.string()),
      unsupported_algorithm: z.array(z.string()),
      /** Members whose digest could not be checked (budget, damage). */
      unread: z.array(z.string()),
      problem: z.string().nullable(),
    })
    .nullable(),
  licenses: z.array(
    z.strictObject({
      entry: z.string(),
      bytes: count,
      sha256: sha256.nullable(),
    }),
  ),
  native_extensions: z.array(
    z.strictObject({
      entry: z.string(),
      bytes: count,
      sha256: sha256.nullable(),
      binary: z.enum(["elf", "mach-o", "pe", "unknown", "unread"]),
      /** Extension-module suffix tag such as cpython-312-darwin or abi3. */
      abi_tag: z.string().nullable(),
    }),
  ),
  /** Members under <name>.data/<scheme>/, by scheme. */
  data_schemes: z.array(z.strictObject({ scheme: z.string(), members: count })),
  problems: z.array(z.string()),
});

const zipappSchema = z.strictObject({
  /** The `#!` line before the ZIP data, as written; null when there is none. */
  shebang: z.string().nullable(),
  prefix_bytes: count,
  /** `__main__.py` is what `python app.pyz` would run; it is declared here, not run. */
  main: z
    .strictObject({
      entry: z.string(),
      bytes: count,
      sha256: sha256.nullable(),
    })
    .nullable(),
});

export const pythonArtifactReportSchema = z.strictObject({
  artifact: artifactSchema,
  container: containerSchema,
  members: z
    .strictObject({
      files: count,
      directories: count,
      duplicates: z.array(z.string()),
      encrypted: count,
    })
    .nullable(),
  wheel: wheelSchema.nullable(),
  zipapp: zipappSchema.nullable(),
  /** For a loose .pyc. */
  header: pycHeaderSchema.nullable(),
  module_count: count,
  page: pageSchema,
  modules: z.array(moduleSummarySchema),
  native_count: count,
  coverage: z.array(facetCoverageSchema),
  limitations: z.array(z.string()),
});
export type PythonArtifactReport = z.infer<typeof pythonArtifactReportSchema>;

const spanShape = {
  line,
  column: line,
  end_line: line,
  end_column: line,
};

const sourceImportSchema = z.strictObject({
  ...spanShape,
  kind: z.enum(["import", "from"]),
  module: z.string().nullable(),
  name: z.string().nullable(),
  asname: z.string().nullable(),
  level: count,
  scope: z.string(),
  /** PEP 810 `lazy import` (3.15+). */
  lazy: z.boolean(),
  /** Enclosing blocks, outermost first: if, else, try, except, finally, __main__, TYPE_CHECKING. */
  guarded: z.array(z.string()),
});

const sourceDefinitionSchema = z.strictObject({
  ...spanShape,
  kind: z.enum(["function", "async-function", "class"]),
  name: z.string(),
  qualname: z.string(),
  scope: z.string(),
  /** Decorator expressions as source text; they are declarations, not evaluated. */
  decorators: z.array(z.string().nullable()),
  docstring: z.string().nullable(),
  type_params: z.array(z.string().nullable()),
  /** Classes only; empty for functions. */
  bases: z.array(z.string().nullable()),
  keywords: z.array(z.string().nullable()),
  /** Functions only; null for classes. */
  arguments: z.string().nullable(),
  returns: z.string().nullable(),
});

const sourceCallSchema = z.strictObject({
  ...spanShape,
  /** The dotted name written at the call; what it resolves to at run time is not known. */
  callee: z.string(),
  scope: z.string(),
});

const sourceDynamicSchema = z.strictObject({
  ...spanShape,
  kind: z.enum(["import", "exec", "eval", "compile", "reflection"]),
  callee: z.string(),
  scope: z.string(),
  /** The first argument when it is a string literal. */
  literal: z.string().nullable(),
  source: z.string().nullable(),
});

const listed = <T extends z.ZodType>(item: T) =>
  z.strictObject({ total: count, items: z.array(item) });

export const pythonSourceFactsSchema = z.strictObject({
  parser: z.strictObject({
    path: z.string(),
    release: z.string(),
  }),
  /** Encoding from the BOM or PEP 263 declaration (utf-8 otherwise), as tokenize.detect_encoding reports it. */
  encoding: z.string().nullable(),
  bom: z.boolean(),
  status: z.enum(["parsed", "syntax-error", "undecodable", "parser-limit"]),
  syntax_error: z
    .strictObject({
      message: z.string(),
      ...spanShape,
      text: z.string(),
    })
    .nullable(),
  problem: z.string().nullable(),
  docstring: z.string().nullable(),
  node_count: count.nullable(),
  imports: listed(sourceImportSchema),
  definitions: listed(sourceDefinitionSchema),
  calls: listed(sourceCallSchema),
  /** Calls whose target is not a dotted name, e.g. f()() or table[key](). */
  unresolved_calls: count,
  /** Dynamic import, exec/eval/compile and reflection calls; what they reach is unknown. */
  dynamic: listed(sourceDynamicSchema),
  assignments: listed(z.strictObject({ ...spanShape, name: z.string() })),
  scope_declarations: listed(
    z.strictObject({
      ...spanShape,
      name: z.string(),
      scope: z.string(),
      kind: z.enum(["global", "nonlocal"]),
    }),
  ),
  lambdas: count,
  /** A literal `__all__` of strings; null when absent or not literal. */
  all: z.array(z.string()).nullable(),
  main_guards: z.array(z.strictObject(spanShape)),
});

const codeSummarySchema = z.strictObject({
  index: count,
  parent: count.nullable(),
  depth: count,
  qualname: z.string(),
  name: z.string(),
  firstlineno: z.number().int(),
  flags: z.array(z.string()),
  argcount: count,
  posonlyargcount: count,
  kwonlyargcount: count,
  code_bytes: count,
  instruction_count: count,
  constants: count,
  names: count,
  problems: count,
});

export const pythonBytecodeFactsSchema = z.strictObject({
  header: pycHeaderSchema,
  decode: z.enum(["complete", "partial", "failed", "not-admitted"]),
  /** The profile (release and magic number) the bytecode was decoded with. */
  profile: z.strictObject({ release: z.string(), magic: count }).nullable(),
  problem: z.string().nullable(),
  filename: z.string().nullable(),
  code_count: count,
  code_objects: z.array(codeSummarySchema),
  /** IMPORT_NAME instructions anywhere in the module, with the from-list and level loaded just before them. */
  imports: z.array(
    z.strictObject({
      code_index: count,
      offset: count,
      line,
      module: z.string(),
      fromlist: z.array(z.string()).nullable(),
      level: z.number().int().nullable(),
      lazy: z.boolean().nullable(),
    }),
  ),
  module_names: z.array(z.string()),
  trailing_bytes: count,
});

export const pythonModuleReportSchema = z.strictObject({
  artifact: artifactSchema,
  selection: z.strictObject({
    entry: z.string().nullable(),
    sha256,
    bytes: count,
  }),
  kind: z.enum(["source", "bytecode"]),
  source: pythonSourceFactsSchema.nullable(),
  bytecode: pythonBytecodeFactsSchema.nullable(),
  coverage: z.array(facetCoverageSchema),
  limitations: z.array(z.string()),
});
export type PythonModuleReport = z.infer<typeof pythonModuleReportSchema>;

const instructionSchema = z.strictObject({
  index: count,
  offset: count,
  /** Offset of the first EXTENDED_ARG prefix. */
  start_offset: count,
  opcode: count,
  opname: z.string(),
  arg: z.number().int().nullable(),
  argval: z.string().nullable(),
  /** The argument as the producing release's dis renders it (labels L<n> from 3.13). */
  argrepr: z.string(),
  jump_target: count.nullable(),
  cache_units: count,
  line,
  starts_line: z.boolean(),
  column: line,
  end_line: line,
  end_column: line,
  problem: z.string().nullable(),
});

export const pythonCodeReportSchema = z.strictObject({
  artifact: artifactSchema,
  selection: z.strictObject({
    entry: z.string().nullable(),
    sha256,
    code_index: count,
    qualname: z.string(),
  }),
  profile: z.strictObject({ release: z.string(), magic: count }),
  code: z.strictObject({
    name: z.string(),
    qualname: z.string(),
    filename: z.string(),
    firstlineno: z.number().int(),
    argcount: count,
    posonlyargcount: count,
    kwonlyargcount: count,
    nlocals: count,
    stacksize: count,
    flags: count,
    flag_names: z.array(z.string()),
    varnames: z.array(z.string()),
    cellvars: z.array(z.string()),
    freevars: z.array(z.string()),
    names: z.array(z.string()),
    constants: z.array(
      z.strictObject({ index: count, type: z.string(), repr: z.string() }),
    ),
    code_bytes: count,
  }),
  instruction_count: count,
  page: pageSchema,
  instructions: z.array(instructionSchema),
  exception_table: z.array(
    z.strictObject({
      start: count,
      end: count,
      target: count,
      depth: count,
      lasti: z.boolean(),
    }),
  ),
  problems: z.array(z.string()),
  coverage: z.array(facetCoverageSchema),
  limitations: z.array(z.string()),
});
export type PythonCodeReport = z.infer<typeof pythonCodeReportSchema>;

/** Releases whose .pyc the admitted pycdc build reads; 3.14 and later it rejects. */
export const PYCDC_RELEASES = [
  "2.7",
  "3.5",
  "3.6",
  "3.7",
  "3.8",
  "3.9",
  "3.10",
  "3.11",
  "3.12",
  "3.13",
] as const;
export const DEFAULT_PYTHON_DECOMPILE_MS = 60_000;
export const MAX_PYTHON_DECOMPILE_MS = 600_000;
/** Default and maximum bytes of reconstructed source returned inline. */
export const DEFAULT_PYTHON_SOURCE_BYTES = 4 * 1024 ** 2;
export const MAX_PYTHON_RECONSTRUCTED_BYTES = 32 * 1024 ** 2;

export const decompilePythonCodeInputSchema = z.strictObject({
  path: pathField,
  entry: entryField,
  check: z
    .boolean()
    .default(true)
    .describe(
      "Compile the reconstructed text with an installed interpreter of the same release and compare its code objects with the original (default true)",
    ),
  timeout_ms: z
    .number()
    .int()
    .min(1000)
    .max(MAX_PYTHON_DECOMPILE_MS)
    .default(DEFAULT_PYTHON_DECOMPILE_MS)
    .describe(
      "Wall-clock limit for the decompiler and, separately, for the check (default 60 s)",
    ),
  max_source_bytes: z
    .number()
    .int()
    .min(1)
    .max(MAX_PYTHON_RECONSTRUCTED_BYTES)
    .default(DEFAULT_PYTHON_SOURCE_BYTES)
    .describe("Largest reconstructed source returned inline (default 4 MiB)"),
  max_file_bytes: maxFileBytesField,
  max_decoded_bytes: maxDecodedBytesField,
});
export type DecompilePythonCodeInput = z.infer<
  typeof decompilePythonCodeInputSchema
>;

const checkSchema = z.strictObject({
  id: z.enum(["decompiler_warnings", "recompiles", "code_objects_match"]),
  state: z.enum(["passed", "failed", "not_checked"]),
  detail: z.string(),
});

export const pythonDecompilationSchema = z.strictObject({
  artifact: artifactSchema,
  selection: z.strictObject({
    entry: z.string().nullable(),
    sha256,
    bytes: count,
  }),
  bytecode: z.strictObject({ magic: count, release: z.string() }),
  decompiler: z.strictObject({
    id: z.literal("pycdc"),
    version: z.string(),
    build: z.string(),
    executable: z.strictObject({ path: z.string(), sha256 }),
    arguments: z.array(z.string()),
  }),
  source: z.strictObject({
    /** Inferred Python source; it is not the original and may not compile. */
    text: z.string(),
    bytes: count,
    sha256,
    lines: count,
    media_type: z.literal("text/x-python; charset=utf-8"),
    confidence: z.literal("inferred"),
    /** Bytes that were not UTF-8 were shown as U+FFFD; the digest is of the raw bytes. */
    replaced_invalid_utf8: z.boolean(),
    derived_from: z.array(sha256),
  }),
  /** `# WARNING: Decompyle incomplete` markers the decompiler left in the text. */
  decompiler_notes: z.array(
    z.strictObject({ line: z.number().int().min(1), text: z.string() }),
  ),
  /** Distinct warnings the decompiler printed, such as unsupported opcodes. */
  messages: z.array(z.string()),
  checks: z.array(checkSchema),
  /** The interpreter that compiled the text for the checks, when one ran. */
  checker: z.strictObject({ path: z.string(), release: z.string() }).nullable(),
  syntax_error: z
    .strictObject({
      message: z.string(),
      line: z.number().int().nullable(),
      offset: z.number().int().nullable(),
    })
    .nullable(),
  /** Code object names in the original but not the recompiled text, and the reverse (capped). */
  code_objects: z
    .strictObject({
      original: count,
      reconstructed: count,
      missing: z.array(z.string()),
      extra: z.array(z.string()),
    })
    .nullable(),
  coverage: z.array(facetCoverageSchema),
  limitations: z.array(z.string()),
});
export type PythonDecompilation = z.infer<typeof pythonDecompilationSchema>;
