import {
  convertWasmToCInputSchema,
  convertWasmToTextInputSchema,
  inspectWasmFunctionInputSchema,
  inspectWasmModuleInputSchema,
  wasmCConversionSchema,
  wasmFunctionReportSchema,
  wasmModuleReportSchema,
  wasmTextConversionSchema,
} from "../domain/wasm/webAssembly.js";
import type { ToolContract } from "./toolContractTypes.js";
import { toolContractMetadata } from "./toolEffects.js";
import { evidenceResultOf } from "./toolOutputSchemaPrimitives.js";

/** WebAssembly modules (format expansion F01), independent of binary targets. */
export const WASM_TOOL_CONTRACTS = [
  {
    name: "inspect_wasm_module",
    ...toolContractMetadata("inspect_wasm_module"),
    kind: "artifact-provider",
    description:
      "Decode one explicit local WebAssembly core module (.wasm) or WebAssembly text file (.wat) in process, without instantiating it: no start function runs and no import is resolved. Returns validation against WebAssembly 2.0 plus tail calls, every section with its byte range, types, imports, tables, memories, globals, exports, start function, element and data segments (with offsets and a data preview), module name and producers, and a page of functions with their signature, body range, instruction count, direct callees, callers and indirect-call sites. Names come only from the name section, or are labelled as borrowed from an export or import; unnamed functions stay unnamed. Proposals this reader does not decode (SIMD instructions, exception handling, GC, threads, typed function references, memory64, multi-memory, component model) are named with exact offsets and the rest of the module is still read. A .wat file is assembled by wabt.js into a separate derived module whose digest is reported.",
    inputSchema: inspectWasmModuleInputSchema,
    outputSchema: evidenceResultOf(wasmModuleReportSchema),
    examples: [
      {
        title: "Inventory a local WebAssembly module",
        input: { path: "/artifacts/app.wasm" },
      },
      {
        title: "Read the second page of functions of a WAT file",
        input: { path: "/artifacts/module.wat", start: 200, limit: 200 },
      },
    ],
  },
  {
    name: "inspect_wasm_function",
    ...toolContractMetadata("inspect_wasm_function"),
    kind: "artifact-provider",
    description:
      "Decode one function of an explicit local WebAssembly core module (.wasm or .wat) without running it: params and locals with their names, a page of instructions with byte offset, size, nesting depth, mnemonic and WAT-style immediates, every direct call with its target, and every call_indirect with its signature and candidate targets. Candidates are the functions of a matching signature placed in that table by element segments; the result says `static` only when nothing else can change the table, `partial` when the table is exported, written by code or filled at instantiation, and `unknown` when it is imported. Targets are never invented. Decoding stops at the first instruction of an undecoded proposal and says where.",
    inputSchema: inspectWasmFunctionInputSchema,
    outputSchema: evidenceResultOf(wasmFunctionReportSchema),
    examples: [
      {
        title: "Read the instructions and calls of function 12",
        input: { path: "/artifacts/app.wasm", function_index: 12 },
      },
    ],
  },
  {
    name: "convert_wasm_to_text",
    ...toolContractMetadata("convert_wasm_to_text"),
    kind: "artifact-provider",
    description:
      "Render one explicit local WebAssembly core module as WebAssembly text (WAT) with wabt.js and write it to a new file; an existing output path is never overwritten and the original module is never changed. The text is a derived rendering with its own SHA-256 tied to the original's digest; names come only from the module's name section, otherwise items print as indices. Validation against WebAssembly 2.0 plus tail calls is reported alongside.",
    inputSchema: convertWasmToTextInputSchema,
    outputSchema: evidenceResultOf(wasmTextConversionSchema),
    examples: [
      {
        title: "Write the text form of a module next to it",
        input: {
          path: "/artifacts/app.wasm",
          output_path: "/artifacts/app.wat",
        },
      },
    ],
  },
  {
    name: "convert_wasm_to_c",
    ...toolContractMetadata("convert_wasm_to_c"),
    kind: "artifact-provider",
    description:
      "Translate one explicit local WebAssembly core module (.wasm, or .wat assembled by wabt.js into a separate derived module) to C with the installed, digest-pinned wabt wasm2c, and return the C file and its header inline labelled as derived from the module's SHA-256. This is a mechanical translation that keeps the module's control flow and memory model, not readable source; names come from the module's name section and exports, escaped by wasm2c. wasm2c reads a copy in a scratch directory that is removed afterwards, with an empty environment; nothing is instantiated or run. Then three checks: whether wasm2c printed anything; whether an installed clang accepts the C with -fsyntax-only against wabt's wasm-rt.h (never linked or run); and whether the header declares every function export of the module (missing and extra names listed). Any check that fails or cannot run makes the result partial. A module wasm2c refuses (threads, GC and other proposals it does not enable, or invalid code) is an unsupported target with wasm2c's message. When wasm2c is not installed or is not an admitted build, the tool says so; convert_wasm_to_text still gives the WAT.",
    inputSchema: convertWasmToCInputSchema,
    outputSchema: evidenceResultOf(wasmCConversionSchema),
    examples: [
      {
        title: "Translate a module to C and check it",
        input: { path: "/artifacts/app.wasm" },
      },
      {
        title: "Translate with a chosen symbol prefix, without the checks",
        input: {
          path: "/artifacts/app.wasm",
          module_name: "app",
          check: false,
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
