import { createHash } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import {
  formatCapabilities,
  HOSTED_CAPABILITY_CONTEXT,
} from "../domain/formatRegistry.js";
import {
  wasmFunctionSchema,
  wasmModuleReportSchema,
  wasmValidationSchema,
} from "../domain/wasm/webAssembly.js";
import { WASM_MAGIC } from "../wasm/binary/moduleTypes.js";
import { analyzeModule } from "../wasm/moduleAnalysis.js";
import { readModuleReport } from "../wasm/moduleReport.js";
import {
  renderWat,
  validateWasm,
  VALIDATION_PROFILE,
  WABT_CONVERTER,
} from "../wasm/wabt.js";
import { HostedError } from "./types.js";
import { runViewWorker } from "./viewWorker.js";

/** Versioned on-disk shape of a hosted WebAssembly view. */
export const WASM_VIEW_SCHEMA = "oopsware.webassembly.v1";
/** Uploaded modules larger than this keep the byte preview only. */
export const HOSTED_WASM_MAX_BYTES = 32 * 1024 ** 2;
/** Functions kept browsable per submission. */
export const HOSTED_WASM_MAX_FUNCTIONS = 20_000;
/** Functions per stored page. */
export const HOSTED_WASM_PAGE_FUNCTIONS = 500;
/** Largest derived WAT rendering stored for download. */
export const HOSTED_WASM_MAX_WAT_BYTES = 64 * 1024 ** 2;
/** Heap and wall-clock budget of the process that decodes one module. */
export const HOSTED_WASM_HEAP_MIB = 384;
export const HOSTED_WASM_TIME_MS = 3 * 60_000;
/** Command-line mode of the hosted worker that builds one WebAssembly view. */
export const WASM_VIEW_WORKER_MODE = "wasm-view";
/** Fixed ID of the derived WAT output. */
export const WASM_TEXT_OUTPUT_ID = "module.wat";

const DIRECTORY = "wasm";
const sha256Pattern = z.string().regex(/^[a-f0-9]{64}$/u);

const indexSchema = z.strictObject({
  schema: z.literal(WASM_VIEW_SCHEMA),
  sha256: sha256Pattern,
  bytes: z.number().int().min(0),
  /** The module report without functions; the upload name stands in for any storage path. */
  report: wasmModuleReportSchema,
  stored_functions: z.number().int().min(0),
  page_functions: z.number().int().min(1),
  function_pages: z.number().int().min(0),
  wat: z
    .strictObject({
      id: z.literal(WASM_TEXT_OUTPUT_ID),
      sha256: sha256Pattern,
      bytes: z.number().int().min(0),
      converter: z.string(),
      derived_from: sha256Pattern,
    })
    .nullable(),
  wat_omitted: z.string().nullable(),
  limitations: z.array(z.string()),
});
export type WasmViewIndex = z.infer<typeof indexSchema>;

const summarySchema = z.union([
  z.strictObject({
    schema: z.literal(WASM_VIEW_SCHEMA),
    status: z.enum(["decoded", "partial", "identified"]),
    kind: z.enum(["module", "component", "unknown"]),
    validation: wasmValidationSchema.shape.state,
    function_count: z.number().int().min(0),
    stored_functions: z.number().int().min(0),
    unsupported_proposals: z.array(z.string()),
    wat_bytes: z.number().int().min(0).nullable(),
    capabilities: z.custom<ReturnType<typeof formatCapabilities>>(
      (value) => typeof value === "object" && value !== null,
    ),
  }),
  z.null(),
]);

/** Report summary of the hosted WebAssembly view. */
export type WasmViewSummary =
  | NonNullable<z.infer<typeof summarySchema>>
  | {
      readonly schema: typeof WASM_VIEW_SCHEMA;
      readonly status: "skipped";
      readonly reason: string;
    };

const skipped = (reason: string): WasmViewSummary => ({
  schema: WASM_VIEW_SCHEMA,
  status: "skipped",
  reason,
});

const startsWithMagic = async (source: string): Promise<boolean> => {
  const handle = await open(source, "r");
  try {
    const head = Buffer.alloc(4);
    const { bytesRead } = await handle.read(head, 0, 4, 0);
    return (
      bytesRead === 4 &&
      WASM_MAGIC.every((value, index) => head[index] === value)
    );
  } finally {
    await handle.close();
  }
};

/**
 * Decode an uploaded WebAssembly original once and store its module report,
 * function pages and a derived WAT rendering. Decoding runs in its own
 * process with a fixed heap and time budget, so a module that is too large
 * or complex here loses only this view. Returns null when the bytes are not
 * WebAssembly. Nothing is instantiated and the original is never changed.
 */
export const writeWasmView = async (
  source: string,
  name: string,
  folder: string,
  sha256: string,
  worker: string,
): Promise<WasmViewSummary | null> => {
  await rm(join(folder, DIRECTORY), { recursive: true, force: true });
  if (!(await startsWithMagic(source))) return null;
  const { size } = await stat(source);
  if (size > HOSTED_WASM_MAX_BYTES)
    return skipped(
      `WebAssembly decoding is limited to ${String(HOSTED_WASM_MAX_BYTES / 1024 ** 2)} MiB on this service; the byte preview and the original download remain.`,
    );
  const outcome = await runViewWorker(
    worker,
    [WASM_VIEW_WORKER_MODE, source, name, folder, sha256],
    { heapMiB: HOSTED_WASM_HEAP_MIB, timeMs: HOSTED_WASM_TIME_MS },
  );
  const summary = summarySchema.safeParse(outcome);
  if (summary.success && summary.data !== null) return summary.data;
  // A killed or failed decode may leave a partial staging folder; never serve it.
  await rm(join(folder, `${DIRECTORY}.staging`), {
    recursive: true,
    force: true,
  });
  await rm(join(folder, DIRECTORY), { recursive: true, force: true });
  return skipped(
    `WebAssembly decoding of this file did not finish within this service's ${String(HOSTED_WASM_HEAP_MIB)} MiB memory and ${String(HOSTED_WASM_TIME_MS / 60_000)}-minute budget; the byte preview and the original download remain.`,
  );
};

/**
 * Build and store the view in the current process. The hosted worker runs
 * this in its wasm-view mode, inside the budget {@link writeWasmView} sets.
 */
export const buildWasmView = async (
  source: string,
  name: string,
  folder: string,
  sha256: string,
): Promise<WasmViewSummary> => {
  const bytes = new Uint8Array(await readFile(source));
  const kind = bytes[4] === 1 && bytes[6] === 0 ? "module" : "other";
  const validation =
    kind === "module"
      ? {
          validator: WABT_CONVERTER,
          profile: VALIDATION_PROFILE,
          ...(await validateWasm(bytes)),
        }
      : {
          validator: WABT_CONVERTER,
          profile: VALIDATION_PROFILE,
          state: "not_checked" as const,
          message: "Only core modules are validated.",
        };
  const analysis = analyzeModule(bytes);
  const full = readModuleReport({
    analysis,
    artifact: { path: name, sha256, bytes: bytes.length },
    source: { format: "binary", basis: "magic", derived_binary: null },
    validation,
    bytes,
    start: 0,
    limit: 1,
  });
  const stored = Math.min(full.function_count, HOSTED_WASM_MAX_FUNCTIONS);
  const pages = Math.ceil(stored / HOSTED_WASM_PAGE_FUNCTIONS);
  const limitations = [...full.limitations];
  if (full.function_count > stored)
    limitations.push(
      `Only the first ${stored.toLocaleString("en-US")} of ${full.function_count.toLocaleString("en-US")} functions are browsable here; the original download is complete.`,
    );
  let wat: WasmViewIndex["wat"] = null;
  let watOmitted: string | null = null;
  let watText: Buffer | null = null;
  if (full.encoding.kind !== "module")
    watOmitted = "Only core modules are rendered as WebAssembly text.";
  else
    try {
      watText = Buffer.from(await renderWat(bytes), "utf8");
      if (watText.length > HOSTED_WASM_MAX_WAT_BYTES) {
        watOmitted = `The text rendering is ${watText.length.toLocaleString("en-US")} bytes, over this service's ${String(HOSTED_WASM_MAX_WAT_BYTES / 1024 ** 2)} MiB output limit.`;
        watText = null;
      } else
        wat = {
          id: WASM_TEXT_OUTPUT_ID,
          sha256: createHash("sha256").update(watText).digest("hex"),
          bytes: watText.length,
          converter: WABT_CONVERTER,
          derived_from: sha256,
        };
    } catch {
      watOmitted = "wabt.js could not render this module as text.";
    }
  const index: WasmViewIndex = {
    schema: WASM_VIEW_SCHEMA,
    sha256,
    bytes: bytes.length,
    report: {
      ...full,
      functions: [],
      page: { start: 0, limit: 1, returned: 0, next: null },
    },
    stored_functions: stored,
    page_functions: HOSTED_WASM_PAGE_FUNCTIONS,
    function_pages: pages,
    wat,
    wat_omitted: watOmitted,
    limitations,
  };
  // Write beside the final name, then rename, so readers never see half a view.
  const staging = join(folder, `${DIRECTORY}.staging`);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { mode: 0o700 });
  for (let page = 0; page < pages; page += 1) {
    const start = page * HOSTED_WASM_PAGE_FUNCTIONS;
    const functions = readModuleReport({
      analysis,
      artifact: index.report.artifact,
      source: index.report.source,
      validation,
      bytes,
      start,
      limit: Math.min(HOSTED_WASM_PAGE_FUNCTIONS, stored - start),
    }).functions;
    await writeFile(
      join(staging, `functions-${String(page)}.json`),
      JSON.stringify(functions),
      { mode: 0o600 },
    );
  }
  if (watText !== null)
    await writeFile(join(staging, WASM_TEXT_OUTPUT_ID), watText, {
      mode: 0o600,
    });
  await writeFile(join(staging, "index.json"), JSON.stringify(index), {
    mode: 0o600,
  });
  await rename(staging, join(folder, DIRECTORY));
  const inspect = full.coverage.find((entry) => entry.facet === "inspect");
  return {
    schema: WASM_VIEW_SCHEMA,
    status:
      full.encoding.kind !== "module"
        ? "identified"
        : inspect?.state === "complete"
          ? "decoded"
          : "partial",
    kind: full.encoding.kind,
    validation: validation.state,
    function_count: full.function_count,
    stored_functions: stored,
    unsupported_proposals: full.unsupported_proposals,
    wat_bytes: wat?.bytes ?? null,
    capabilities: formatCapabilities(
      full.encoding.kind === "component" ? "wasm-component" : "wasm-module",
      HOSTED_CAPABILITY_CONTEXT,
    ),
  };
};

const missing = () =>
  new HostedError(404, "No WebAssembly view exists for this upload.");

const readJson = async (path: string): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      throw missing();
    throw cause;
  }
};

/** The stored view index, validated before it is served. */
export const readWasmIndex = async (folder: string): Promise<WasmViewIndex> =>
  indexSchema.parse(await readJson(join(folder, DIRECTORY, "index.json")));

/** One stored page of functions. */
export const readWasmFunctions = async (folder: string, page: number) => {
  const index = await readWasmIndex(folder);
  if (page >= index.function_pages)
    throw new HostedError(404, "That function page does not exist.");
  const functions = z
    .array(wasmFunctionSchema)
    .parse(
      await readJson(join(folder, DIRECTORY, `functions-${String(page)}.json`)),
    );
  return {
    page,
    pages: index.function_pages,
    page_functions: index.page_functions,
    stored_functions: index.stored_functions,
    function_count: index.report.function_count,
    functions,
  };
};

/** Path and download name of the stored derived WAT, when one exists. */
export const wasmTextOutput = async (
  folder: string,
  originalName: string,
): Promise<{ readonly path: string; readonly name: string }> => {
  const index = await readWasmIndex(folder);
  if (index.wat === null)
    throw new HostedError(
      404,
      index.wat_omitted ?? "No text rendering exists.",
    );
  return {
    path: join(folder, DIRECTORY, WASM_TEXT_OUTPUT_ID),
    name: `${originalName.replace(/\.wasm$/iu, "")}.derived.wat`,
  };
};
