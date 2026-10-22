import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import wabtInit from "wabt";
import { describe, expect, it } from "vitest";

import { ByteReader, WasmDecodeError } from "./binary/ByteReader.js";
import { opcodeInfo } from "./binary/opcodes.js";
import { readFunctionReport } from "./functionReport.js";
import { analyzeModule } from "./moduleAnalysis.js";
import { readModuleReport } from "./moduleReport.js";
import { assembleWat, renderWat, validateWasm, WABT_VERSION } from "./wabt.js";
import {
  wasmFunctionReportSchema,
  wasmModuleReportSchema,
} from "../domain/wasm/webAssembly.js";

/** Module fixtures are assembled at test time by wabt.js from these sources. */
const CALLS_WAT = `(module $calls
  (import "env" "log" (func $log (param i32)))
  (type $unary (func (param i32) (result i32)))
  (memory (export "memory") 1 4)
  (global $counter (mut i32) (i32.const 7))
  (data (i32.const 16) "hello\\00world")
  (table 3 funcref)
  (elem (i32.const 0) $double $inc $other)
  (func $double (type $unary) local.get 0 i32.const 2 i32.mul)
  (func $inc (type $unary) local.get 0 i32.const 1 i32.add)
  (func $other (param i64) (result i64) local.get 0)
  (func $run (export "run") (param $x i32) (result i32) (local $tmp i32)
    local.get $x
    call $log
    local.get $x
    i32.const 1
    call_indirect (type $unary)
    local.tee $tmp
    if (result i32)
      local.get $tmp
      call $double
    else
      i32.const 0
    end
    global.get $counter
    i32.add))`;

const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

const report = async (bytes: Uint8Array, start = 0, limit = 200) =>
  readModuleReport({
    artifact: {
      path: "/fixture.wasm",
      sha256: sha(bytes),
      bytes: bytes.length,
    },
    source: { format: "binary", basis: "magic", derived_binary: null },
    validation: {
      ...(await validateWasm(bytes)),
      validator: "wabt",
      profile: "test",
    },
    bytes,
    start,
    limit,
  });

const functionReport = (bytes: Uint8Array, functionIndex: number) =>
  readFunctionReport({
    artifact: {
      path: "/fixture.wasm",
      sha256: sha(bytes),
      bytes: bytes.length,
    },
    source: { format: "binary", basis: "magic", derived_binary: null },
    validation: {
      state: "not_checked",
      validator: "wabt",
      profile: "test",
      message: null,
    },
    bytes,
    functionIndex,
    start: 0,
    limit: 1000,
  });

describe("WebAssembly decoder primitives", () => {
  it("pins the installed wabt.js release", () => {
    const require = createRequire(import.meta.url);
    const manifest = JSON.parse(
      readFileSync(require.resolve("wabt/package.json"), "utf8"),
    ) as { version: string };
    expect(manifest.version).toBe(WABT_VERSION);
  });

  it("names every single-byte numeric opcode from 0x45 to 0xc4", () => {
    expect(opcodeInfo(0x45)?.name).toBe("i32.eqz");
    expect(opcodeInfo(0xc4)?.name).toBe("i64.extend32_s");
    for (let byte = 0x45; byte <= 0xc4; byte += 1)
      expect(opcodeInfo(byte)?.immediate).toBe("none");
  });

  it("rejects an overlong LEB128 at its exact offset", () => {
    const reader = new ByteReader(
      Uint8Array.of(0x80, 0x80, 0x80, 0x80, 0x80, 0x00),
      0,
      6,
    );
    expect(() => reader.u32("count")).toThrow(WasmDecodeError);
    const overflow = new ByteReader(
      Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0x1f),
      0,
      5,
    );
    expect(() => overflow.u32("count")).toThrow(/overflows 32 bits/u);
    expect(
      new ByteReader(Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0x0f), 0, 5).u32(),
    ).toBe(0xffffffff);
    expect(new ByteReader(Uint8Array.of(0x7f), 0, 1).s32()).toBe(-1);
    expect(
      new ByteReader(Uint8Array.of(0x80, 0x80, 0x80, 0x80, 0x78), 0, 5).s32(),
    ).toBe(-(2 ** 31));
    expect(() =>
      new ByteReader(Uint8Array.of(0x80, 0x80, 0x80, 0x80, 0x70), 0, 5).s32(),
    ).toThrow(/overflows/u);
  });
});

describe("WebAssembly module inventory", () => {
  it("inventories imports, exports, memory, data, tables and calls of a WABT-built module", async () => {
    const bytes = await assembleWat(
      "calls.wat",
      new TextEncoder().encode(CALLS_WAT),
    );
    const result = wasmModuleReportSchema.parse(await report(bytes));
    expect(result.encoding).toEqual({ kind: "module", version: 1 });
    expect(result.validation.state).toBe("valid");
    expect(result.module_name).toBe("calls");
    expect(result.summary).toMatchObject({
      imports: 1,
      functions: 5,
      imported_functions: 1,
      exports: 2,
      memories: 1,
      tables: 1,
      data: 1,
      elements: 1,
      direct_call_edges: 2,
      indirect_call_sites: 1,
    });
    expect(result.imports[0]).toMatchObject({
      module: "env",
      name: "log",
      kind: "func",
      description: "func (i32) -> ()",
    });
    expect(result.memories[0]).toMatchObject({
      exported_as: ["memory"],
      limits: { min: 1, max: 4 },
    });
    expect(result.data[0]).toMatchObject({
      offset_expression: "i32.const 16",
      size: 11,
      preview_text: "hello.world",
    });
    expect(result.elements[0]).toMatchObject({
      mode: "active",
      table: 0,
      offset_expression: "i32.const 0",
      functions: [1, 2, 3],
    });
    expect(result.globals[0]).toMatchObject({
      mutable: true,
      init: "i32.const 7",
    });
    const run = result.functions.find((entry) => entry.name === "run");
    expect(run).toMatchObject({
      index: 4,
      name_source: "name-section",
      exports: ["run"],
      signature: "(i32) -> (i32)",
      direct_callees: [0, 1],
      indirect_call_sites: 1,
      decode: "complete",
    });
    expect(result.functions[0]).toMatchObject({
      imported: { module: "env", name: "log" },
      body: null,
      decode: "not_applicable",
      direct_callers: 1,
    });
    expect(
      result.coverage.find((entry) => entry.facet === "inspect")?.state,
    ).toBe("complete");
    // The data payload offset points at the real bytes.
    const data = result.data[0];
    expect(
      new TextDecoder().decode(
        bytes.subarray(data?.payload_offset, (data?.payload_offset ?? 0) + 5),
      ),
    ).toBe("hello");
  });

  it("pages functions across the whole index space", async () => {
    const bytes = await assembleWat(
      "calls.wat",
      new TextEncoder().encode(CALLS_WAT),
    );
    const first = await report(bytes, 0, 2);
    expect(first.page).toEqual({ start: 0, limit: 2, returned: 2, next: 2 });
    const last = await report(bytes, 4, 2);
    expect(last.page).toEqual({ start: 4, limit: 2, returned: 1, next: null });
  });

  it("leaves names unset when the module has no name section", async () => {
    const wabt = await wabtInit();
    const module = wabt.parseWat(
      "anon.wat",
      `(module (func (result i32) i32.const 1) (func (export "e") call 0 drop))`,
      {},
    );
    const bytes = module.toBinary({ write_debug_names: false }).buffer;
    module.destroy();
    const result = await report(bytes);
    expect(result.summary.named_functions).toBe(0);
    expect(result.functions[0]).toMatchObject({
      name: null,
      name_source: null,
    });
    expect(result.functions[1]).toMatchObject({
      name: "e",
      name_source: "export",
    });
    expect(result.limitations.join(" ")).toMatch(/no function names/u);
    expect(await renderWat(bytes)).not.toMatch(/\$/u);
  });

  it("identifies a component without decoding it as a core module", async () => {
    // Hand-built empty component: magic, version 0x0d, layer 1.
    const bytes = Uint8Array.of(0x00, 0x61, 0x73, 0x6d, 0x0d, 0x00, 0x01, 0x00);
    const result = await report(bytes);
    expect(result.encoding).toEqual({ kind: "component", version: 13 });
    expect(result.unsupported_proposals).toEqual(["component-model"]);
    expect(result.coverage).toMatchObject([
      { facet: "identify", state: "complete" },
      { facet: "inspect", state: "unsupported" },
    ]);
    expect(result.function_count).toBe(0);
  });
});

describe("WebAssembly function view", () => {
  it("lists instructions with offsets, depth and signature-matched indirect targets", async () => {
    const bytes = await assembleWat(
      "calls.wat",
      new TextEncoder().encode(CALLS_WAT),
    );
    const result = functionReport(bytes, 4);
    if ("missing" in result) throw new Error("function 4 missing");
    const parsed = wasmFunctionReportSchema.parse(result);
    expect(parsed.function.locals).toEqual([
      { index: 0, type: "i32", name: "x" },
      { index: 1, type: "i32", name: "tmp" },
    ]);
    const ops = parsed.instructions.map((entry) => [entry.op, entry.depth]);
    expect(ops).toContainEqual(["if", 0]);
    expect(ops).toContainEqual(["call", 1]);
    expect(ops).toContainEqual(["else", 0]);
    expect(parsed.instructions.at(-1)).toMatchObject({ op: "end", depth: 0 });
    for (const instruction of parsed.instructions)
      expect(bytes[instruction.offset]).toBeDefined();
    expect(parsed.calls.map((call) => call.target)).toEqual([
      { index: 0, name: "log" },
      { index: 1, name: "double" },
    ]);
    expect(parsed.indirect_calls).toHaveLength(1);
    // $other has a different signature, so only $double and $inc qualify.
    expect(parsed.indirect_calls[0]?.targets).toEqual({
      state: "static",
      candidates: [
        { index: 1, name: "double" },
        { index: 2, name: "inc" },
      ],
      reasons: [],
    });
  });

  it("agrees with WABT's rendering on every instruction mnemonic", async () => {
    const wat = `(module
      (memory 1) (table 2 funcref) (elem declare func $f)
      (data $d "x")
      (func $f (param i32 i64 f32 f64) (result i32)
        local.get 0 i32.load8_u offset=4 drop
        local.get 1 i64.const -5 i64.rotl drop
        local.get 2 f32.const nan:0x200000 f32.min drop
        local.get 3 f64.const -inf f64.max i64.trunc_sat_f64_s drop
        i32.const 0 i32.const 0 i32.const 1 memory.init $d
        data.drop $d
        i32.const 0 i32.const 0 i32.const 0 memory.copy
        ref.func $f drop
        ref.null extern ref.is_null drop
        i32.const 1 i32.extend8_s
        block $b (result i32) i32.const 2 br $b end i32.add
        loop $l br_if $l (i32.const 0) end
        i32.const 0 br_table 0 0
      )
      (func (result i32) i32.const 1 i32.const 2 i32.const 0 select (result i32)
        return_call 1))`;
    const bytes = await assembleWat("ops.wat", new TextEncoder().encode(wat));
    const rendered = (await renderWat(bytes))
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("("))
      .map((line) => line.split(/[\s)]/u)[0]);
    const decoded: string[] = [];
    const analysis = analyzeModule(bytes);
    for (const body of analysis.module.bodies) {
      const result = functionReport(bytes, body.index);
      if ("missing" in result) throw new Error("missing body");
      // WABT prints each body's final `end` as the closing parenthesis.
      decoded.push(
        ...result.instructions.slice(0, -1).map((entry) => entry.op),
      );
    }
    expect(decoded).toEqual(rendered);
    const f = functionReport(bytes, 0);
    if ("missing" in f) throw new Error("missing");
    expect(
      f.instructions.find((entry) => entry.op === "i32.load8_u")?.immediates,
    ).toBe("offset=4");
    expect(
      f.instructions.find((entry) => entry.op === "f32.const")?.immediates,
    ).toBe("nan:0x200000");
    expect(
      f.instructions.find((entry) => entry.op === "i64.const")?.immediates,
    ).toBe("-5");
  });

  it("reports exported or written tables as partial indirect-call targets", async () => {
    const wat = `(module (type $t (func))
      (table (export "t") 2 funcref) (elem (i32.const 0) $a)
      (func $a) (func $b call_indirect (type $t) (i32.const 0))
      (func $c (table.set 0 (i32.const 1) (ref.func $a))) (elem declare func $a))`;
    const bytes = await assembleWat(
      "tables.wat",
      new TextEncoder().encode(wat),
    );
    const result = functionReport(bytes, 1);
    if ("missing" in result) throw new Error("missing");
    expect(result.indirect_calls[0]?.targets.state).toBe("partial");
    expect(result.indirect_calls[0]?.targets.reasons).toHaveLength(2);
    expect(result.indirect_calls[0]?.targets.candidates).toEqual([
      { index: 0, name: "a" },
    ]);
  });
});

describe("WebAssembly damaged and unsupported input", () => {
  it("keeps earlier sections when a section length runs past the end", async () => {
    const bytes = await assembleWat(
      "calls.wat",
      new TextEncoder().encode(CALLS_WAT),
    );
    const result = await report(bytes);
    const code = result.sections.find((section) => section.name === "code");
    if (code === undefined) throw new Error("no code section");
    // Documented edit: cut the file ten bytes into the code section.
    const truncated = bytes.subarray(0, code.offset + 10);
    const damaged = await report(truncated);
    expect(damaged.validation.state).toBe("invalid");
    expect(damaged.summary.imports).toBe(1);
    expect(damaged.summary.exports).toBe(2);
    expect(damaged.coverage[1]).toMatchObject({
      facet: "inspect",
      state: "partial",
    });
    expect(damaged.diagnostics[0]?.message).toMatch(
      /exceeds .* bytes left.*Decoding stopped/u,
    );
    expect(damaged.diagnostics[0]?.offset).toBe(code.offset + 1);
  });

  it("names an unsupported proposal instead of guessing at its bytes", async () => {
    const wat = `(module (tag $e) (func (export "f") (try_table (catch_all 0) throw $e)))`;
    const bytes = await assembleWat("eh.wat", new TextEncoder().encode(wat));
    const result = await report(bytes);
    expect(result.unsupported_proposals).toContain("exception-handling");
    expect(result.validation.state).toBe("requires-proposal");
    expect(result.coverage[1]).toMatchObject({ state: "partial" });
    expect(result.summary.exports).toBe(1);
  });

  it("stops one SIMD body explicitly and keeps the rest of the module", async () => {
    const wat = `(module (func (export "s") (result i32) v128.const i32x4 1 2 3 4 i32x4.extract_lane 0) (func (export "plain") (result i32) i32.const 9))`;
    const bytes = await assembleWat("simd.wat", new TextEncoder().encode(wat));
    const result = await report(bytes);
    expect(result.validation.state).toBe("valid");
    expect(result.functions[0]).toMatchObject({
      decode: "stopped",
      decode_error: { proposal: "simd" },
    });
    expect(result.functions[1]).toMatchObject({
      decode: "complete",
      instructions: 2,
    });
  });
});
