import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FacetCoverage } from "../domain/formatRegistry.js";
import type {
  ConvertWasmToCInput,
  WasmCConversion,
} from "../domain/wasm/webAssembly.js";
import {
  OwnedCommandFailure,
  runOwnedCommand,
} from "../process/OwnedCommand.js";
import type { ResolvedWasm2c } from "./wasm2c.js";

/** Largest stderr kept from wasm2c or clang. */
const DIAGNOSTIC_BYTES = 4 * 1024 ** 2;
const MAX_MESSAGES = 200;
const MAX_COMPILE_ERRORS = 20;
const MAX_LINE_CHARS = 1000;
const MAX_NAMES_LISTED = 50;

/** Why a translation produced nothing usable. */
export class WasmToCFailure extends Error {
  readonly _tag = "WasmToCFailure";
  constructor(
    readonly reason: "refused" | "no-output" | "too-large",
    message: string,
  ) {
    super(message);
  }
}

type Check = WasmCConversion["checks"][number];

export interface WasmToCRequest {
  readonly artifact: WasmCConversion["artifact"];
  readonly source: WasmCConversion["source"];
  /** The core module handed to wasm2c (the original or the WAT's derived module). */
  readonly module: Uint8Array;
  readonly moduleName: string;
  /** Names of the module's function exports, or why they cannot be compared. */
  readonly exports: { names: readonly string[] } | { reason: string };
  readonly input: ConvertWasmToCInput;
  readonly tool: ResolvedWasm2c;
  /** A clang that syntax-checks the output, when one is installed. */
  readonly compiler: string | null;
  readonly signal?: AbortSignal | undefined;
}

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

const clip = (line: string) =>
  line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;

/** Distinct non-empty lines, with the private scratch path replaced. */
const distinct = (text: string, scratch: string): string[] => [
  ...new Set(
    text
      .split("\n")
      .map((line) => clip(line.trim().replaceAll(scratch, "<scratch>")))
      .filter((line) => line.length > 0),
  ),
];

const lineCount = (text: string) =>
  text.length === 0
    ? 0
    : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);

/**
 * Undo wasm2c's name escaping: every byte it cannot keep is written `0xHH`
 * (uppercase hex). Literal names such as `00x41` are ambiguous in 1.0.42;
 * this conservative decoding can report a false mismatch.
 */
export const demangleWasm2cName = (mangled: string): string => {
  const bytes: number[] = [];
  for (let index = 0; index < mangled.length;) {
    const escape = /^0x([0-9A-F]{2})/u.exec(mangled.slice(index, index + 4));
    if (escape?.[1] === undefined) {
      bytes.push(mangled.charCodeAt(index));
      index += 1;
    } else {
      bytes.push(Number.parseInt(escape[1], 16));
      index += 4;
    }
  }
  return new TextDecoder("utf-8").decode(Uint8Array.from(bytes));
};

/**
 * Exported functions the header declares. wasm2c names the instance struct
 * `w2c_<prefix>` and declares each function export as
 * `w2c_<prefix>_<name>(w2c_<prefix>*, ...)`; memory, table and global
 * accessors take a named `instance` parameter and are not matched.
 */
export const declaredExports = (header: string): string[] | null => {
  const prefix = /\bwasm2c_(\w+)_instantiate\(w2c_\1\*/u.exec(header)?.[1];
  if (prefix === undefined) return null;
  return [
    ...header.matchAll(
      new RegExp(`\\bw2c_${prefix}_(\\w*)\\(w2c_${prefix}\\*[,)]`, "gu"),
    ),
  ].map((match) => demangleWasm2cName(match[1] ?? ""));
};

/** Names present more often on the left than on the right, each repeated by the difference. */
const surplus = (left: readonly string[], right: readonly string[]) => {
  const counts = new Map<string, number>();
  for (const name of right) counts.set(name, (counts.get(name) ?? 0) + 1);
  const out: string[] = [];
  for (const name of left) {
    const remaining = counts.get(name) ?? 0;
    if (remaining > 0) counts.set(name, remaining - 1);
    else out.push(name);
  }
  return out;
};

const readGenerated = async (path: string, scratch: string) => {
  const raw = await readFile(path);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    throw new WasmToCFailure(
      "no-output",
      `wasm2c wrote ${path.replaceAll(scratch, "<scratch>")} with bytes that are not UTF-8.`,
    );
  }
  return { raw, text };
};

/** Syntax-check the C (never link or run it); a checker that cannot run is not a failed check. */
const compileCheck = async (
  compiler: string,
  include: string,
  file: string,
  cwd: string,
  scratch: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Check & { errors: string[] }> => {
  const id = "compiles";
  try {
    await runOwnedCommand(
      {
        command: compiler,
        arguments: ["-fsyntax-only", "-I", include, file],
        runId: randomUUID(),
        cwd,
        hostEnvironment: {},
        ...(signal === undefined ? {} : { signal }),
      },
      { timeoutMs, diagnosticBytes: DIAGNOSTIC_BYTES },
      signal === undefined ? {} : { signal },
    );
    return {
      id,
      state: "passed",
      detail: `${compiler} -fsyntax-only accepts the C with wabt's wasm-rt.h (it was not linked or run).`,
      errors: [],
    };
  } catch (cause) {
    // A checker that fails never hides the text; cancellation still ends the call.
    if (!(cause instanceof OwnedCommandFailure) || cause.reason === "cancelled")
      throw cause;
    const errors = distinct(cause.snapshot?.stderr.text ?? "", scratch).filter(
      (line) => / error: /u.test(line),
    );
    const missingHeaders = errors.flatMap((line) => {
      const header = /fatal error: ['<]([^'>]+)['>] file not found/u.exec(
        line,
      )?.[1];
      return header === undefined ? [] : [header];
    });
    if (cause.reason === "process" && missingHeaders.length > 0)
      return {
        id,
        state: "not_checked",
        detail: `${compiler} could not check the C because required headers are unavailable: ${[...new Set(missingHeaders)].join(", ")}.`,
        errors: [],
      };
    if (cause.reason === "process" && errors.length > 0)
      return {
        id,
        state: "failed",
        detail: `${compiler} -fsyntax-only rejects the C with ${String(errors.length)} distinct errors.`,
        errors: errors.slice(0, MAX_COMPILE_ERRORS),
      };
    return {
      id,
      state: "not_checked",
      detail:
        cause.reason === "timeout"
          ? `${compiler} did not finish within ${String(timeoutMs)} ms.`
          : cause.reason === "output-limit"
            ? `${compiler} printed more than the check's output budget.`
            : `${compiler} stopped without a compiler error (${cause.snapshot?.signal ?? `exit code ${String(cause.snapshot?.exitCode ?? "unknown")}`}).`,
      errors: [],
    };
  }
};

/**
 * Run the admitted wasm2c on a scratch copy of one core module with an empty
 * environment, then check its C with an installed clang and compare the
 * header's exported functions with the module's. The scratch is removed.
 */
export const convertModuleToC = async (
  request: WasmToCRequest,
): Promise<WasmCConversion> => {
  const { artifact, source, module, moduleName, input, tool, signal } = request;
  const scratch = await mkdtemp(join(tmpdir(), "oopsware-wasm2c-"));
  try {
    const out = join(scratch, "out");
    await mkdir(join(scratch, "in"));
    await mkdir(out);
    const target = join(scratch, "in", "module.wasm");
    const cPath = join(out, `${moduleName}.c`);
    const hPath = join(out, `${moduleName}.h`);
    await writeFile(target, module, { flag: "wx" });
    let snapshot: Awaited<ReturnType<typeof runOwnedCommand>>;
    try {
      snapshot = await runOwnedCommand(
        {
          command: tool.path,
          arguments: [target, "-o", cPath, "-n", moduleName],
          runId: randomUUID(),
          cwd: scratch,
          hostEnvironment: {},
          ...(signal === undefined ? {} : { signal }),
        },
        { timeoutMs: input.timeout_ms, diagnosticBytes: DIAGNOSTIC_BYTES },
        signal === undefined ? {} : { signal },
      );
    } catch (cause) {
      if (!(cause instanceof OwnedCommandFailure) || cause.reason !== "process")
        throw cause;
      const last = distinct(cause.snapshot?.stderr.text ?? "", scratch).slice(
        0,
        5,
      );
      const stop = cause.snapshot?.signal ?? null;
      throw new WasmToCFailure(
        "refused",
        `${stop === null ? `wasm2c refused the module (exit code ${String(cause.snapshot?.exitCode ?? "unknown")})` : `wasm2c crashed (${stop}) on the module`}${last.length === 0 ? "." : `: ${last.join(" ")}`}`,
      );
    }
    const allMessages = distinct(
      `${snapshot.stderr.text}\n${snapshot.stdout.text}`,
      scratch,
    );
    let size: number;
    try {
      size = (await stat(cPath)).size + (await stat(hPath)).size;
    } catch {
      throw new WasmToCFailure(
        "no-output",
        `wasm2c did not write both the C file and its header.${allMessages.length > 0 ? ` ${allMessages.slice(0, 3).join(" ")}` : ""}`,
      );
    }
    if (size > input.max_source_bytes)
      throw new WasmToCFailure(
        "too-large",
        `The generated C and header are ${String(size)} bytes, over max_source_bytes (${String(input.max_source_bytes)}).`,
      );
    const c = await readGenerated(cPath, scratch);
    const header = await readGenerated(hPath, scratch);
    const moduleSha256 = sha256(module);
    const generated = (
      name: string,
      file: { raw: Uint8Array; text: string },
    ): WasmCConversion["c"] => ({
      name,
      text: file.text,
      bytes: file.raw.length,
      sha256: sha256(file.raw),
      lines: lineCount(file.text),
      media_type: "text/x-c; charset=utf-8",
      confidence: "derived",
      derived_from: [moduleSha256],
    });

    const checks: Check[] = [
      allMessages.length === 0
        ? {
            id: "wasm2c_succeeded",
            state: "passed",
            detail: "wasm2c exited 0 and printed nothing.",
          }
        : {
            id: "wasm2c_succeeded",
            state: "failed",
            detail: `wasm2c exited 0 but printed ${String(allMessages.length)} distinct lines; they are listed in messages.`,
          },
    ];
    let compiler: WasmCConversion["compiler"] = null;
    let compileErrors: string[] = [];
    let exports: WasmCConversion["exports"] = null;
    if (!input.check)
      checks.push(
        ...(["compiles", "exports_match"] as const).map((id) => ({
          id,
          state: "not_checked" as const,
          detail: "Checks were not requested (check: false).",
        })),
      );
    else {
      if (request.compiler === null || tool.include === null)
        checks.push({
          id: "compiles",
          state: "not_checked",
          detail:
            request.compiler === null
              ? "No clang that finds the system headers with an empty environment is installed at the standard locations."
              : "wabt's runtime header wasm-rt.h is not installed next to the admitted wasm2c.",
        });
      else {
        compiler = { path: request.compiler, include: tool.include };
        const { errors, ...check } = await compileCheck(
          request.compiler,
          tool.include,
          `${moduleName}.c`,
          out,
          scratch,
          input.timeout_ms,
          signal,
        );
        compileErrors = errors;
        checks.push(check);
      }
      const declared = declaredExports(header.text);
      if ("reason" in request.exports || declared === null)
        checks.push({
          id: "exports_match",
          state: "not_checked",
          detail:
            "reason" in request.exports
              ? request.exports.reason
              : "The header does not declare wasm2c's instantiate function, so its exports cannot be read.",
        });
      else {
        const missing = surplus(request.exports.names, declared);
        const extra = surplus(declared, request.exports.names);
        exports = {
          module: request.exports.names.length,
          declared: declared.length,
          missing: missing.slice(0, MAX_NAMES_LISTED),
          extra: extra.slice(0, MAX_NAMES_LISTED),
        };
        checks.push(
          missing.length === 0 && extra.length === 0
            ? {
                id: "exports_match",
                state: "passed",
                detail: `The header declares the module's ${String(declared.length)} function exports by name.`,
              }
            : {
                id: "exports_match",
                state: "failed",
                detail: `${String(missing.length)} function exports of the module are not declared in the header and ${String(extra.length)} declared ones are not exports.`,
              },
        );
      }
    }

    const unpassed = checks.filter((check) => check.state !== "passed");
    const examined = `1 core module translated into ${String(lineCount(c.text))} lines of C and ${String(lineCount(header.text))} of header`;
    const reconstruct: FacetCoverage =
      unpassed.length === 0
        ? {
            facet: "reconstruct",
            state: "complete",
            examined,
            omitted: null,
            reason: null,
            continuation: null,
          }
        : {
            facet: "reconstruct",
            state: "partial",
            examined,
            omitted: unpassed
              .map((check) => `${check.id} ${check.state.replace("_", " ")}`)
              .join("; "),
            reason:
              "The generated C is unchecked or did not pass a check in the ways the checks list.",
            continuation:
              "inspect_wasm_function gives the decoded instructions of every function.",
          };
    return {
      artifact,
      source,
      module_name: moduleName,
      converter: {
        id: "wasm2c",
        version: tool.version,
        build: tool.build,
        executable: { path: tool.path, sha256: tool.sha256 },
        arguments: ["<input>", "-o", "<output>.c", "-n", moduleName],
      },
      c: generated(`${moduleName}.c`, c),
      header: generated(`${moduleName}.h`, header),
      messages: allMessages.slice(0, MAX_MESSAGES),
      checks,
      compiler,
      compile_errors: compileErrors,
      exports,
      coverage: [reconstruct],
      limitations: [
        "The C is a mechanical translation by wasm2c: it is derived from the module, not the original source, and keeps the module's control flow, locals and memory model rather than readable code.",
        "Names come from the module's name section and exports, escaped by wasm2c; nothing is invented.",
        "wasm2c read a copy of the module as data in its own process with an empty environment; nothing was instantiated, compiled into a program or run.",
        "A passed compile check means clang accepts the C syntax against wabt's wasm-rt.h; it does not link the runtime or prove the C behaves like the module.",
        "Export-name decoding is conservative: wasm2c 1.0.42 leaves some names such as 00x41 ambiguous, so exports_match can report a false mismatch.",
        "max_source_bytes is checked after wasm2c exits; it bounds returned source, not the temporary output written to disk while wasm2c runs.",
        ...(allMessages.length > MAX_MESSAGES
          ? [
              `wasm2c printed ${String(allMessages.length)} distinct lines; the first ${String(MAX_MESSAGES)} are listed.`,
            ]
          : []),
      ],
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
};
