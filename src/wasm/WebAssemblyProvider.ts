import { createHash } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import { basename } from "node:path";

import type { ExecutionOptions } from "../application/AnalysisProvider.js";
import { WEBASSEMBLY_PROVIDER } from "../application/InvestigationProviders.js";
import type { WebAssemblyPort } from "../application/wasm/WebAssemblyPort.js";
import { readStableArtifact } from "../artifacts/readStableArtifact.js";
import { stableReadFailure } from "../artifacts/stableReadFailure.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
  AnalysisUnsupportedTargetError,
} from "../domain/analysisErrorCore.js";
import { ArtifactOperationError } from "../domain/artifactOperationError.js";
import { err, ok, type Result } from "../domain/result.js";
import { OwnedCommandFailure } from "../process/OwnedCommand.js";
import {
  MAX_WAT_OUTPUT_BYTES,
  WASM_C_MODULE_NAME,
  type ConvertWasmToCInput,
  type ConvertWasmToTextInput,
  type InspectWasmFunctionInput,
  type InspectWasmModuleInput,
  type WasmModuleReport,
  type WasmSourceFormat,
} from "../domain/wasm/webAssembly.js";
import { decodeModule } from "./binary/decodeModule.js";
import { WASM_MAGIC } from "./binary/moduleTypes.js";
import { convertModuleToC, WasmToCFailure } from "./convertToC.js";
import { findClang, resolveWasm2c, Wasm2cUnavailable } from "./wasm2c.js";
import { readFunctionReport } from "./functionReport.js";
import { readModuleReport } from "./moduleReport.js";
import {
  assembleWat,
  renderWat,
  validateWasm,
  VALIDATION_PROFILE,
  WABT_CONVERTER,
  wabtMessage,
} from "./wabt.js";

type Operation =
  | "inspect_wasm_module"
  | "inspect_wasm_function"
  | "convert_wasm_to_text"
  | "convert_wasm_to_c";

const TEXT_SUFFIX = /\.(wat|wast)$/iu;

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const hasMagic = (bytes: Uint8Array): boolean =>
  WASM_MAGIC.every((value, index) => bytes[index] === value);

interface Loaded {
  readonly artifact: WasmModuleReport["artifact"];
  readonly source: WasmModuleReport["source"];
  readonly module: Uint8Array;
}

const sourceFormat = (
  bytes: Uint8Array,
  path: string,
  requested: WasmSourceFormat | undefined,
): {
  format: WasmSourceFormat;
  basis: WasmModuleReport["source"]["basis"];
} | null => {
  if (requested !== undefined) return { format: requested, basis: "requested" };
  if (hasMagic(bytes)) return { format: "binary", basis: "magic" };
  if (TEXT_SUFFIX.test(path)) return { format: "text", basis: "name-hint" };
  return null;
};

/** Read one file and, for WAT, assemble the separate derived module. */
const load = async (
  operation: Operation,
  input: {
    path: string;
    format?: WasmSourceFormat | undefined;
    max_file_bytes: number;
  },
  options?: ExecutionOptions,
): Promise<Result<Loaded, AnalysisError>> => {
  let snapshot: Awaited<ReturnType<typeof readStableArtifact>>;
  try {
    snapshot = await readStableArtifact(
      input.path,
      input.max_file_bytes,
      options?.signal,
    );
  } catch (cause) {
    return err(
      stableReadFailure(operation, input.path, cause, {
        cancelled: options?.signal?.aborted === true,
        maxFileBytes: input.max_file_bytes,
        remediationAction:
          "Raise max_file_bytes (up to 256 MiB) or select a smaller module.",
      }),
    );
  }
  if (options?.signal?.aborted)
    return err(new AnalysisCancelledError(operation));
  const artifact = {
    path: input.path,
    sha256: snapshot.sha256,
    bytes: snapshot.bytes.length,
  };
  const chosen = sourceFormat(snapshot.bytes, input.path, input.format);
  if (chosen === null)
    return err(
      new AnalysisUnsupportedTargetError(
        operation,
        input.path,
        "The file has no WebAssembly magic bytes and no .wat or .wast suffix.",
        {
          remediationAction:
            "Pass format (binary or text) to choose how to read this file.",
        },
      ),
    );
  if (chosen.format === "binary")
    return ok({
      artifact,
      source: { ...chosen, derived_binary: null },
      module: snapshot.bytes,
    });
  let module: Uint8Array;
  try {
    module = await assembleWat(basename(input.path), snapshot.bytes);
  } catch (cause) {
    return err(
      new AnalysisUnsupportedTargetError(
        operation,
        input.path,
        `The WebAssembly text could not be assembled: ${wabtMessage(cause)}`,
        { cause },
      ),
    );
  }
  return ok({
    artifact,
    source: {
      ...chosen,
      derived_binary: {
        sha256: sha256(module),
        bytes: module.length,
        converter: WABT_CONVERTER,
      },
    },
    module,
  });
};

const validation = async (
  module: Uint8Array,
): Promise<WasmModuleReport["validation"]> => {
  const base = { validator: WABT_CONVERTER, profile: VALIDATION_PROFILE };
  if (!hasMagic(module) || module[4] !== 1 || module[6] !== 0)
    return {
      ...base,
      state: "not_checked",
      message: "Only core modules are validated.",
    };
  return { ...base, ...(await validateWasm(module)) };
};

/** In-process WebAssembly decoding over one bounded, identity-checked regular file. */
export class WebAssemblyProvider implements WebAssemblyPort {
  readonly identity = WEBASSEMBLY_PROVIDER;

  async inspectModule(
    input: InspectWasmModuleInput,
    options?: ExecutionOptions,
  ) {
    const loaded = await load("inspect_wasm_module", input, options);
    if (!loaded.ok) return loaded;
    return ok(
      readModuleReport({
        ...loaded.value,
        bytes: loaded.value.module,
        validation: await validation(loaded.value.module),
        start: input.start,
        limit: input.limit,
      }),
    );
  }

  async inspectFunction(
    input: InspectWasmFunctionInput,
    options?: ExecutionOptions,
  ) {
    const loaded = await load("inspect_wasm_function", input, options);
    if (!loaded.ok) return loaded;
    const report = readFunctionReport({
      ...loaded.value,
      bytes: loaded.value.module,
      validation: {
        state: "not_checked",
        validator: WABT_CONVERTER,
        profile: VALIDATION_PROFILE,
        message: null,
      },
      functionIndex: input.function_index,
      start: input.start,
      limit: input.limit,
    });
    if ("missing" in report)
      return err(
        report.kind === "module"
          ? new AnalysisInputError("inspect_wasm_function", undefined, [
              {
                path: ["function_index"],
                reason: "out_of_range",
                message: `The module has ${String(report.functionCount)} functions (indices 0 to ${String(report.functionCount - 1)}).`,
                minimum: 0,
                maximum: Math.max(0, report.functionCount - 1),
              },
            ])
          : new AnalysisUnsupportedTargetError(
              "inspect_wasm_function",
              input.path,
              report.kind === "component"
                ? "Component-model binaries are identified but not decoded; only core module functions can be inspected."
                : "The bytes are not a WebAssembly core module.",
            ),
      );
    return ok(report);
  }

  async convertToText(
    input: ConvertWasmToTextInput,
    options?: ExecutionOptions,
  ) {
    const operation = "convert_wasm_to_text";
    const loaded = await load(
      operation,
      { ...input, format: "binary" },
      options,
    );
    if (!loaded.ok) return loaded;
    const { artifact, module } = loaded.value;
    const decoded = decodeModule(module);
    if (decoded.kind !== "module")
      return err(
        new AnalysisUnsupportedTargetError(
          operation,
          input.path,
          decoded.kind === "component"
            ? "Component-model binaries cannot be rendered as core-module text."
            : "The bytes are not a WebAssembly core module.",
        ),
      );
    const checked = await validation(module);
    let text: string;
    try {
      text = await renderWat(module);
    } catch (cause) {
      return err(
        new AnalysisUnsupportedTargetError(
          operation,
          input.path,
          `wabt.js could not render this module as text: ${wabtMessage(cause)}`,
          { cause },
        ),
      );
    }
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(operation));
    const output = Buffer.from(text, "utf8");
    if (output.length > MAX_WAT_OUTPUT_BYTES)
      return err(
        new AnalysisResourceConstraintError(
          operation,
          "file-size",
          `The rendered text is ${String(output.length)} bytes, over the ${String(MAX_WAT_OUTPUT_BYTES)}-byte output limit.`,
          { max_output_bytes: MAX_WAT_OUTPUT_BYTES },
        ),
      );
    const written = await writeNew(input.output_path, output);
    if (!written.ok) return written;
    const named =
      decoded.names.functions.size > 0 || decoded.names.module !== null;
    return ok({
      artifact,
      output: {
        path: input.output_path,
        sha256: sha256(output),
        bytes: output.length,
        media_type: "text/plain; charset=utf-8" as const,
        derived_from: artifact.sha256,
        converter: WABT_CONVERTER,
        names: named ? ("name-section" as const) : ("indices" as const),
      },
      validation: checked,
      limitations: [
        "The text is rendered by wabt.js from the binary; it is a derived view, not original source.",
        ...(named
          ? []
          : [
              "The module has no name section, so functions, locals and labels print as indices.",
            ]),
        ...(checked.state === "valid"
          ? []
          : [
              `The module did not pass ${VALIDATION_PROFILE} validation, so the text may show structure the runtime would reject.`,
            ]),
      ],
    });
  }

  async convertToC(input: ConvertWasmToCInput, options?: ExecutionOptions) {
    const operation = "convert_wasm_to_c";
    const loaded = await load(operation, input, options);
    if (!loaded.ok) return loaded;
    const { artifact, source, module } = loaded.value;
    const decoded = decodeModule(module);
    if (decoded.kind !== "module")
      return err(
        new AnalysisUnsupportedTargetError(
          operation,
          input.path,
          decoded.kind === "component"
            ? "Component-model binaries cannot be translated by wasm2c; only core modules can."
            : "The bytes are not a WebAssembly core module.",
        ),
      );
    // Export section id 7, or -1 for an unreadable section header: the export list may be short.
    const exports =
      decoded.incompleteSections.has(7) || decoded.incompleteSections.has(-1)
        ? {
            reason:
              "This reader could not decode the module's whole export section, so there is nothing to compare against.",
          }
        : {
            names: decoded.exports
              .filter((entry) => entry.kind === "func")
              .map((entry) => entry.name),
          };
    try {
      const tool = await resolveWasm2c();
      const report = await convertModuleToC({
        artifact,
        source,
        module,
        moduleName:
          input.module_name ?? defaultModuleName(decoded.names.module, input),
        exports,
        input,
        tool,
        compiler: input.check ? await findClang() : null,
        signal: options?.signal,
      });
      if (options?.signal?.aborted)
        return err(new AnalysisCancelledError(operation));
      return ok(report);
    } catch (cause) {
      const mapped = wasmToCFailure(input, cause);
      if (mapped === null) throw cause;
      return err(mapped);
    }
  }
}

/** A C identifier for `-n`: the module's own name, else the file name, else `module`. */
const defaultModuleName = (
  named: string | null,
  input: ConvertWasmToCInput,
): string =>
  [named, basename(input.path).replace(/\.[^.]*$/u, "")]
    .map((name) => name?.replace(/[^A-Za-z0-9_]/gu, "_") ?? "")
    .find((name) => WASM_C_MODULE_NAME.test(name)) ?? "module";

const wasmToCFailure = (
  input: ConvertWasmToCInput,
  cause: unknown,
): AnalysisError | null => {
  const operation = "convert_wasm_to_c";
  if (cause instanceof Wasm2cUnavailable)
    return new AnalysisCapabilityUnavailableError(
      "wasm2c",
      operation,
      cause.message,
      { cause },
    );
  if (cause instanceof WasmToCFailure)
    return cause.reason === "too-large"
      ? new AnalysisResourceConstraintError(
          operation,
          "memory",
          cause.message,
          { max_source_bytes: input.max_source_bytes },
          {
            cause,
            remediationAction: "Raise max_source_bytes (up to 64 MiB).",
          },
        )
      : new AnalysisUnsupportedTargetError(
          operation,
          input.path,
          cause.message,
          {
            cause,
          },
        );
  if (!(cause instanceof OwnedCommandFailure)) return null;
  switch (cause.reason) {
    case "cancelled":
      return new AnalysisCancelledError(operation, { cause });
    case "timeout":
      return new AnalysisTimeoutError(operation, input.timeout_ms, { cause });
    case "output-limit":
      return new AnalysisResourceConstraintError(
        operation,
        "memory",
        "wasm2c or clang printed more diagnostics than the capture budget.",
        null,
        { cause },
      );
    case "process":
      // wasm2c's own exit is mapped in convertToC.ts; this is any other child.
      return new AnalysisUnsupportedTargetError(
        operation,
        input.path,
        `A translation process exited with code ${String(cause.snapshot?.exitCode ?? "unknown")}.`,
        { cause },
      );
  }
};

/** Create a new file; an existing path is never replaced and a failed write leaves no file. */
const writeNew = async (
  path: string,
  bytes: Uint8Array,
): Promise<Result<void, AnalysisError>> => {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, "wx", 0o644);
  } catch (cause) {
    const code =
      cause instanceof Error && "code" in cause ? String(cause.code) : "";
    const message =
      code === "EEXIST"
        ? "The output path already exists; it is never overwritten. Choose a new path."
        : code === "ENOENT" || code === "ENOTDIR"
          ? "The output path's parent directory does not exist."
          : null;
    return err(
      message === null
        ? new ArtifactOperationError(
            "convert_wasm_to_text",
            "io",
            undefined,
            cause instanceof Error
              ? cause.message
              : "The output file could not be created.",
            { cause },
          )
        : new AnalysisInputError("convert_wasm_to_text", { cause }, [
            { path: ["output_path"], reason: "invalid_value", message },
          ]),
    );
  }
  try {
    await handle.writeFile(bytes);
    await handle.close();
    return ok(undefined);
  } catch (cause) {
    await handle.close().catch(() => undefined);
    await unlink(path).catch(() => undefined);
    return err(
      new ArtifactOperationError(
        "convert_wasm_to_text",
        "io",
        undefined,
        cause instanceof Error
          ? cause.message
          : "Writing the output file failed.",
        { cause },
      ),
    );
  }
};
