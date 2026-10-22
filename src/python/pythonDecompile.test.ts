import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readFile } from "node:fs/promises";

import { PythonProvider } from "./PythonProvider.js";
import { readPycHeader } from "./bytecode/pyc.js";
import { decompilePyc } from "./decompile.js";
import { resolvePycdc } from "./pycdc.js";
import {
  decompilePythonCodeInputSchema,
  pythonDecompilationSchema,
  type PythonDecompilation,
} from "../domain/python/python.js";
import {
  admittedProducers,
  compileSample,
  minorOf,
} from "../../tests/fixtures/pythonProducers.js";
import { removeTestWorkspace } from "../../tests/support/workspace/workspaceFixture.js";

const provider = new PythonProvider();

/** The real decompiler is a host tool; without an admitted build these cases are skipped. */
const PYCDC = await resolvePycdc().then(
  () => true,
  () => false,
);
const producers = await admittedProducers();
const readable = producers.filter((interpreter) => minorOf(interpreter) <= 13);
const unreadable = producers.filter(
  (interpreter) => minorOf(interpreter) >= 14,
);

const decompile = async (input: Record<string, unknown>) => {
  const result = await provider.decompileCode(
    decompilePythonCodeInputSchema.parse(input),
  );
  if (!result.ok) throw result.error;
  return pythonDecompilationSchema.parse(result.value);
};

const state = (report: PythonDecompilation, id: string) =>
  report.checks.find((check) => check.id === id)?.state;

describe.skipIf(!PYCDC || readable.length === 0)(
  "pycdc reconstruction over CPython-compiled modules",
  () => {
    let root: string;

    beforeAll(async () => {
      root = await realpath(
        await mkdtemp(join(await realpath(tmpdir()), "rea-pycdc-")),
      );
    });
    afterAll(async () => {
      await removeTestWorkspace(root);
    });

    it.each(readable.map((interpreter) => [interpreter.version, interpreter]))(
      "decompiles and checks a Python %s module",
      async (_version, interpreter) => {
        const path = await compileSample(
          interpreter,
          join(root, interpreter.version),
          "decompile_tiny.py",
        );
        const report = await decompile({ path });
        expect(report.bytecode.release).toBe(interpreter.version);
        expect(report.source.confidence).toBe("inferred");
        expect(report.source.derived_from).toEqual([report.selection.sha256]);
        expect(report.selection.sha256).toBe(report.artifact.sha256);
        expect(report.checker?.release).toBe(interpreter.release);
        expect(report.decompiler.id).toBe("pycdc");
        if (minorOf(interpreter) <= 12) {
          // pycdc reads this module cleanly up to 3.12; every check passes.
          expect(report.source.text).toContain("def double(value):");
          expect(report.source.text).toContain("class Counter:");
          expect(report.checks.map((check) => [check.id, check.state])).toEqual(
            [
              ["decompiler_warnings", "passed"],
              ["recompiles", "passed"],
              ["code_objects_match", "passed"],
            ],
          );
          expect(report.code_objects).toEqual({
            original: 5,
            reconstructed: 5,
            missing: [],
            extra: [],
          });
          expect(report.coverage[0]?.state).toBe("complete");
        } else {
          // pycdc stops at the first function of 3.13 bytecode and says so.
          expect(state(report, "decompiler_warnings")).toBe("failed");
          expect(
            report.messages.some((line) => line.includes("MAKE_FUNCTION")),
          ).toBe(true);
          expect(report.decompiler_notes.length).toBeGreaterThan(0);
          expect(report.coverage[0]?.state).toBe("partial");
        }
        if (state(report, "recompiles") === "failed")
          expect(report.syntax_error).not.toBeNull();
        else expect(report.syntax_error).toBeNull();
      },
      60_000,
    );

    it("keeps the text when the checker itself fails", async () => {
      const interpreter = readable[0];
      if (interpreter === undefined) return;
      const path = await compileSample(
        interpreter,
        join(root, "broken-checker"),
        "decompile_tiny.py",
      );
      const bytes = await readFile(path);
      const header = readPycHeader(bytes);
      if (header?.release == null) throw new Error("no release");
      const selection = {
        entry: null,
        sha256: "0".repeat(64),
        bytes: bytes.length,
      };
      const report = await decompilePyc({
        artifact: { path, sha256: selection.sha256, bytes: bytes.length },
        selection,
        bytes,
        header: { ...header, release: header.release },
        input: decompilePythonCodeInputSchema.parse({ path }),
        tool: await resolvePycdc(),
        // An "interpreter" that exits 1 without printing anything.
        checker: { ...interpreter, path: "/usr/bin/false" },
      });
      expect(report.source.text.length).toBeGreaterThan(0);
      expect(state(report, "recompiles")).toBe("not_checked");
      expect(state(report, "code_objects_match")).toBe("not_checked");
      expect(report.coverage[0]?.state).toBe("partial");
      expect(report.messages.join("\n")).not.toContain("oopsware-pycdc-");
    });

    it("skips the checks when asked and stays partial", async () => {
      const interpreter = readable[0];
      if (interpreter === undefined) return;
      const path = await compileSample(
        interpreter,
        join(root, "nocheck"),
        "decompile_tiny.py",
      );
      const report = await decompile({ path, check: false });
      expect(report.checker).toBeNull();
      expect(state(report, "recompiles")).toBe("not_checked");
      expect(state(report, "code_objects_match")).toBe("not_checked");
      expect(report.coverage[0]?.state).toBe("partial");
    });

    it("refuses source files and output over max_source_bytes", async () => {
      const interpreter = readable[0];
      if (interpreter === undefined) return;
      const source = await provider.decompileCode(
        decompilePythonCodeInputSchema.parse({
          path: join(
            import.meta.dirname,
            "../../tests/fixtures/python/decompile_tiny.py",
          ),
        }),
      );
      expect(source.ok).toBe(false);
      if (!source.ok)
        expect(source.error.message).toContain("source, not bytecode");
      const path = await compileSample(
        interpreter,
        join(root, "small"),
        "decompile_tiny.py",
      );
      const small = await provider.decompileCode(
        decompilePythonCodeInputSchema.parse({ path, max_source_bytes: 16 }),
      );
      expect(small.ok).toBe(false);
      if (!small.ok) expect(small.error.message).toContain("max_source_bytes");
    });

    it.skipIf(unreadable.length === 0)(
      "refuses releases pycdc does not read",
      async () => {
        const interpreter = unreadable[0];
        if (interpreter === undefined) return;
        const path = await compileSample(
          interpreter,
          join(root, interpreter.version),
          "decompile_tiny.py",
        );
        const result = await provider.decompileCode(
          decompilePythonCodeInputSchema.parse({ path }),
        );
        expect(result.ok).toBe(false);
        if (!result.ok)
          expect(result.error.message).toContain(
            `does not read Python ${interpreter.version}`,
          );
      },
    );
  },
);
