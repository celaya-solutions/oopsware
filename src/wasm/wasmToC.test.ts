import { createHash } from "node:crypto";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { WebAssemblyProvider } from "./WebAssemblyProvider.js";
import {
  convertModuleToC,
  declaredExports,
  demangleWasm2cName,
} from "./convertToC.js";
import { assembleWat } from "./wabt.js";
import { findClang, resolveWasm2c } from "./wasm2c.js";
import {
  convertWasmToCInputSchema,
  wasmCConversionSchema,
  type WasmCConversion,
} from "../domain/wasm/webAssembly.js";
import { removeTestWorkspace } from "../../tests/support/workspace/workspaceFixture.js";

const provider = new WebAssemblyProvider();

/** wasm2c is a host tool; without an admitted build the real cases are skipped. */
const WASM2C = await resolveWasm2c().then(
  () => true,
  () => false,
);
const CLANG = await findClang();

/** Export names chosen to exercise wasm2c's escaping (assembled by wabt.js at test time). */
const NAMES_WAT = `(module $demo
  (import "env" "log" (func $log (param i32)))
  (func $add (export "add") (param i32 i32) (result i32)
    local.get 0 local.get 1 i32.add)
  (func (export "weird-name.x") (result i32) i32.const 7)
  (func (export "_under") (result i32) i32.const 8)
  (func (export "a__b") (result i32) i32.const 9)
  (func (export "0xAB") (result i32) i32.const 10)
  (func (export "Ünï") (export "alias") (result i32)
    i32.const 11 call $log i32.const 11)
  (memory (export "mem") 1)
  (global (export "g") i32 (i32.const 1)))`;

/** Shared memory needs the threads proposal, which wasm2c 1.0.42 does not enable. */
const THREADS_WAT = `(module
  (memory 1 1 shared)
  (func (export "load") (result i32) i32.const 0 i32.atomic.load))`;

const sha256 = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");

const state = (report: WasmCConversion, id: string) =>
  report.checks.find((check) => check.id === id)?.state;

describe("wasm2c name handling", () => {
  it("undoes wasm2c's escapes as observed in wasm2c 1.0.42 headers", () => {
    for (const [mangled, name] of [
      ["add", "add"],
      ["weird0x2Dname0x2Ex", "weird-name.x"],
      ["0x5Funder", "_under"],
      ["a_0x5Fb", "a__b"],
      ["0x0x41B", "0xAB"],
      ["0x0x30xF", "0x0xF"],
      ["0xab", "0xab"],
      ["0xC30x9Cn0xC30xAF", "Ünï"],
      ["", ""],
    ] as const)
      expect(demangleWasm2cName(mangled)).toBe(name);
  });

  it("reads function exports, not accessors or imports, from a header", () => {
    expect(
      declaredExports(`void wasm2c_m__x_instantiate(w2c_m__x*, struct w2c_env*);
u32 w2c_env_log(struct w2c_env*, u32);
u32 w2c_m__x_add(w2c_m__x*, u32, u32);
u32 w2c_m__x_0x5F(w2c_m__x*);
wasm_rt_memory_t* w2c_m__x_mem(w2c_m__x* instance);`),
    ).toEqual(["add", "_"]);
    expect(declaredExports("no instance here")).toBeNull();
  });
});

let root: string;
let names: Uint8Array;
let namesPath: string;

const convert = async (input: Record<string, unknown>) => {
  const result = await provider.convertToC(
    convertWasmToCInputSchema.parse(input),
  );
  if (!result.ok) throw result.error;
  return wasmCConversionSchema.parse(result.value);
};

beforeAll(async () => {
  if (!WASM2C) return;
  root = await realpath(
    await mkdtemp(join(await realpath(tmpdir()), "rea-wasm2c-")),
  );
  names = await assembleWat("names.wat", new TextEncoder().encode(NAMES_WAT));
  namesPath = join(root, "names.wasm");
  await writeFile(namesPath, names);
});
afterAll(async () => {
  if (root) await removeTestWorkspace(root);
});

describe.skipIf(!WASM2C)("wasm2c translation of wabt-assembled modules", () => {
  it("translates a module, compiles it and matches every function export", async () => {
    const report = await convert({ path: namesPath });
    expect(report.module_name).toBe("demo");
    expect(report.converter).toMatchObject({
      id: "wasm2c",
      version: "1.0.42",
      arguments: ["<input>", "-o", "<output>.c", "-n", "demo"],
    });
    expect(report.c.name).toBe("demo.c");
    expect(report.c.text).toContain('#include "demo.h"');
    expect(report.header.text).toContain(
      "u32 w2c_demo_add(w2c_demo*, u32, u32);",
    );
    for (const file of [report.c, report.header]) {
      expect(file.sha256).toBe(sha256(file.text));
      expect(file.derived_from).toEqual([sha256(names)]);
      expect(file.confidence).toBe("derived");
    }
    expect(report.exports).toEqual({
      module: 7,
      declared: 7,
      missing: [],
      extra: [],
    });
    expect(state(report, "wasm2c_succeeded")).toBe("passed");
    expect(state(report, "exports_match")).toBe("passed");
    if (CLANG === null) {
      expect(state(report, "compiles")).toBe("not_checked");
      expect(report.coverage[0]?.state).toBe("partial");
    } else {
      expect(state(report, "compiles")).toBe("passed");
      expect(report.compiler?.path).toBe(CLANG);
      expect(report.compile_errors).toEqual([]);
      expect(report.coverage[0]?.state).toBe("complete");
    }
  }, 60_000);

  it("names the prefix from the caller, and reads WAT through its derived module", async () => {
    const wat = join(root, "named.wat");
    await writeFile(wat, NAMES_WAT);
    const report = await convert({
      path: wat,
      module_name: "my_mod",
      check: false,
    });
    expect(report.source).toMatchObject({
      format: "text",
      basis: "name-hint",
      derived_binary: { sha256: sha256(names) },
    });
    expect(report.artifact.sha256).toBe(sha256(NAMES_WAT));
    expect(report.c.derived_from).toEqual([sha256(names)]);
    expect(report.header.text).toContain("w2c_my__mod_add(w2c_my__mod*");
    expect(report.compiler).toBeNull();
    expect(state(report, "compiles")).toBe("not_checked");
    expect(state(report, "exports_match")).toBe("not_checked");
    expect(report.coverage[0]?.state).toBe("partial");
  });

  it("keeps the C when the compile checker itself fails", async () => {
    const report = await convertModuleToC({
      artifact: { path: namesPath, sha256: sha256(names), bytes: names.length },
      source: { format: "binary", basis: "magic", derived_binary: null },
      module: names,
      moduleName: "demo",
      exports: { names: ["add"] },
      input: convertWasmToCInputSchema.parse({ path: namesPath }),
      tool: await resolveWasm2c(),
      // A "compiler" that exits 1 without printing an error.
      compiler: "/usr/bin/false",
    });
    expect(report.c.text.length).toBeGreaterThan(0);
    expect(state(report, "compiles")).toBe("not_checked");
    // The header declares six more exports than the list handed in.
    expect(state(report, "exports_match")).toBe("failed");
    expect(report.exports?.extra).toHaveLength(6);
    expect(report.coverage[0]?.state).toBe("partial");
  });

  it.skipIf(CLANG === null)(
    "reports missing runtime headers as unchecked",
    async () => {
      const report = await convertModuleToC({
        artifact: {
          path: namesPath,
          sha256: sha256(names),
          bytes: names.length,
        },
        source: { format: "binary", basis: "magic", derived_binary: null },
        module: names,
        moduleName: "demo",
        exports: { reason: "not compared here" },
        input: convertWasmToCInputSchema.parse({ path: namesPath }),
        // An include directory without wasm-rt.h.
        tool: { ...(await resolveWasm2c()), include: root },
        compiler: CLANG,
      });
      expect(state(report, "compiles")).toBe("not_checked");
      expect(
        report.checks.find((check) => check.id === "compiles")?.detail,
      ).toContain("wasm-rt.h");
      expect(report.compile_errors).toEqual([]);
      expect(report.compile_errors.join("\n")).not.toContain(
        "oopsware-wasm2c-",
      );
      expect(state(report, "exports_match")).toBe("not_checked");
    },
  );

  it("refuses a module wasm2c rejects, with its message and no scratch path", async () => {
    const path = join(root, "threads.wasm");
    await writeFile(
      path,
      await assembleWat("threads.wat", new TextEncoder().encode(THREADS_WAT)),
    );
    const result = await provider.convertToC(
      convertWasmToCInputSchema.parse({ path }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("threads not allowed");
    expect(result.error.message).not.toContain("oopsware-wasm2c-");
  });

  it("refuses output over max_source_bytes instead of cutting it", async () => {
    const result = await provider.convertToC(
      convertWasmToCInputSchema.parse({
        path: namesPath,
        max_source_bytes: 16,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("max_source_bytes");
  });
});

describe.skipIf(!WASM2C)("wasm2c review regressions", () => {
  it.skipIf(CLANG === null)("keeps real syntax errors failed", async () => {
    await writeFile(
      join(root, "wasm-rt.h"),
      "#error controlled syntax-check failure\n",
    );
    const report = await convertModuleToC({
      artifact: { path: namesPath, sha256: sha256(names), bytes: names.length },
      source: { format: "binary", basis: "magic", derived_binary: null },
      module: names,
      moduleName: "demo",
      exports: { names: ["add"] },
      input: convertWasmToCInputSchema.parse({ path: namesPath }),
      tool: { ...(await resolveWasm2c()), include: root },
      compiler: CLANG,
    });
    expect(state(report, "compiles")).toBe("failed");
    expect(report.compile_errors.join("\n")).toContain(
      "controlled syntax-check failure",
    );
  });

  it.skipIf(CLANG === null)(
    "reports the missing SIMD dependency by name",
    async () => {
      const path = join(root, "simd.wat");
      await writeFile(
        path,
        '(module (func (export "vector") (result v128) v128.const i32x4 1 2 3 4))',
      );
      const report = await convert({ path });
      expect(["passed", "not_checked"]).toContain(state(report, "compiles"));
      if (state(report, "compiles") === "not_checked")
        expect(
          report.checks.find((check) => check.id === "compiles")?.detail,
        ).toContain("simde/wasm/simd128.h");
      expect(report.compile_errors).toEqual([]);
      expect(report.c.text.length).toBeGreaterThan(0);
    },
  );

  it("keeps ambiguous export names conservative and states both limits", async () => {
    const path = join(root, "ambiguous.wat");
    await writeFile(path, '(module (func (export "00x41")))');
    const report = await convert({ path });
    expect(state(report, "exports_match")).toBe("failed");
    expect(report.exports?.missing).toContain("00x41");
    expect(report.exports?.extra).toContain("0A");
    expect(report.limitations.join(" ")).toContain("false mismatch");
    expect(report.limitations.join(" ")).toContain(
      "temporary output written to disk",
    );
  });
});
