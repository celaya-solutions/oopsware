import wabtInit from "wabt";

/**
 * WABT (WebAssembly Binary Toolkit) compiled to WebAssembly by wabt.js. It
 * runs inside its own WebAssembly memory in this process, so validation,
 * WAT assembly and WAT rendering need no host installation and no child
 * process. The target module is only parsed by it, never instantiated.
 */

/** Pinned wabt.js release; a test checks it against the installed package. */
export const WABT_VERSION = "1.0.39";
export const WABT_CONVERTER = `wabt.js ${WABT_VERSION}`;

type Wabt = Awaited<ReturnType<typeof wabtInit>>;
type WasmFeatures = NonNullable<Parameters<Wabt["parseWat"]>[2]>;

/** WebAssembly 2.0 (including fixed-width SIMD) plus tail calls. */
export const VALIDATION_PROFILE = "webassembly-2.0+tail-call";
const PROFILE_FEATURES: WasmFeatures = {
  mutable_globals: true,
  sat_float_to_int: true,
  sign_extension: true,
  simd: true,
  multi_value: true,
  bulk_memory: true,
  reference_types: true,
  tail_call: true,
};
/** Every proposal wabt knows, to tell "uses a proposal" apart from "invalid". */
const ALL_FEATURES: WasmFeatures = {
  ...PROFILE_FEATURES,
  exceptions: true,
  threads: true,
  function_references: true,
  gc: true,
  memory64: true,
  extended_const: true,
  relaxed_simd: true,
  annotations: true,
  code_metadata: true,
};

/**
 * wabt.js reads the whole backing buffer of a view, not just the view's
 * range, so a slice of a larger buffer would be decoded with bytes that are
 * not part of the file. Every input is copied into its own buffer first.
 */
const exact = (bytes: Uint8Array): Uint8Array => new Uint8Array(bytes);

let loaded: Promise<Wabt> | undefined;
const wabt = (): Promise<Wabt> => (loaded ??= wabtInit());

/**
 * Run one wabt operation. An error that is not wabt's own "failed:" report
 * (an abort inside its WebAssembly memory) discards the instance so the next
 * call starts from a fresh one.
 */
const run = async <T>(operation: (tool: Wabt) => T): Promise<T> => {
  const tool = await wabt();
  try {
    return operation(tool);
  } catch (cause) {
    if (!(cause instanceof Error && / failed:/u.test(cause.message)))
      loaded = undefined;
    throw cause;
  }
};

/** wabt's message without the "readWasm failed:" preamble. */
export const wabtMessage = (cause: unknown): string => {
  const text = cause instanceof Error ? cause.message : String(cause);
  return text
    .replace(/^\w+ failed:\s*/u, "")
    .trim()
    .slice(0, 2000);
};

export type ValidationOutcome =
  | { readonly state: "valid"; readonly message: null }
  | {
      readonly state: "invalid" | "requires-proposal";
      readonly message: string;
    };

const check = (tool: Wabt, bytes: Uint8Array, features: WasmFeatures): void => {
  const module = tool.readWasm(exact(bytes), {
    readDebugNames: false,
    ...features,
  });
  try {
    module.validate();
  } finally {
    module.destroy();
  }
};

/** Validate against the profile; an invalid module is re-checked with every proposal enabled. */
export const validateWasm = async (
  bytes: Uint8Array,
): Promise<ValidationOutcome> =>
  run((tool) => {
    try {
      check(tool, bytes, PROFILE_FEATURES);
      return { state: "valid", message: null };
    } catch (cause) {
      const message = wabtMessage(cause);
      try {
        check(tool, bytes, ALL_FEATURES);
        return { state: "requires-proposal", message };
      } catch {
        return { state: "invalid", message };
      }
    }
  });

/** Assemble WebAssembly text into a binary module, keeping its names. */
export const assembleWat = async (
  name: string,
  text: Uint8Array,
): Promise<Uint8Array> =>
  run((tool) => {
    const module = tool.parseWat(name, exact(text), ALL_FEATURES);
    try {
      module.resolveNames();
      return module.toBinary({ write_debug_names: true }).buffer.slice();
    } finally {
      module.destroy();
    }
  });

/**
 * Render a binary module as WAT. Names come only from the module's name
 * section; nothing is invented, so unnamed items print as indices.
 */
export const renderWat = async (bytes: Uint8Array): Promise<string> =>
  run((tool) => {
    const module = tool.readWasm(exact(bytes), {
      readDebugNames: true,
      check: false,
      ...ALL_FEATURES,
    });
    try {
      module.applyNames();
      return module.toText({ foldExprs: false, inlineExport: false });
    } finally {
      module.destroy();
    }
  });
