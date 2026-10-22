import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { JvmProvider } from "./JvmProvider.js";
import { parseClass } from "./classfile/parseClass.js";
import {
  safeInternalName,
  decompileJarClass,
  vineflowerFailure,
} from "./decompile.js";
import { resolveVineflower, stageVineflower } from "./vineflower.js";
import {
  decompileJvmClassInputSchema,
  jvmDecompilationSchema,
  type JvmDecompilation,
} from "../domain/jvm/jvm.js";
import {
  buildJvmFixtures,
  JDK_HOME,
  type JvmFixtures,
} from "../../tests/fixtures/jvmProducers.js";
import { removeTestWorkspace } from "../../tests/support/workspace/workspaceFixture.js";

const provider = new JvmProvider();

/** The real decompiler is a host tool; without an admitted build these cases are skipped. */
const VINEFLOWER = await resolveVineflower().then(
  () => true,
  () => false,
);

const decompile = async (
  input: Record<string, unknown>,
): Promise<JvmDecompilation> => {
  const result = await provider.decompileClass(
    decompileJvmClassInputSchema.parse(input),
  );
  if (!result.ok) throw result.error;
  return jvmDecompilationSchema.parse(result.value);
};

describe("decompiler scratch names", () => {
  it("accepts ordinary internal names and refuses ones that would leave the scratch tree", () => {
    expect(safeInternalName("demo/Shapes$Circle")).toBe(true);
    for (const name of [
      "",
      "../x",
      "a//b",
      "a/./b",
      "/abs",
      "a\\b",
      "a\0b",
      "C:x",
    ])
      expect(safeInternalName(name), JSON.stringify(name)).toBe(false);
  });
});

let root: string;
let fixtures: JvmFixtures;

beforeAll(async () => {
  if (JDK_HOME === null || !VINEFLOWER) return;
  root = await realpath(
    await mkdtemp(join(await realpath(tmpdir()), "rea-jvm-decompile-")),
  );
  fixtures = await buildJvmFixtures(root);
}, 120_000);
afterAll(async () => {
  if (root) await removeTestWorkspace(root);
});

describe.skipIf(JDK_HOME === null || !VINEFLOWER)(
  "Vineflower reconstruction over JDK-built classes",
  () => {
    it("decompiles a class with its nested classes from a JAR and labels the text inferred", async () => {
      const report = await decompile({
        path: fixtures.app,
        class: "demo.Shapes",
      });
      expect(report.top_level).toBe("demo/Shapes");
      expect(report.inputs.map((entry) => [entry.name, entry.role])).toEqual(
        expect.arrayContaining([
          ["demo/Shapes", "selected"],
          ["demo/Shapes$Circle", "nested"],
          ["demo/Shapes$Square", "nested"],
        ]),
      );
      expect(report.missing_nested).toEqual([]);
      expect(report.library).toEqual({
        container: null,
        sha256: report.artifact.sha256,
      });
      expect(report.source).toMatchObject({
        file: "demo/Shapes.java",
        confidence: "inferred",
        media_type: "text/x-java; charset=utf-8",
      });
      expect(report.source.derived_from).toEqual(
        report.inputs.map((entry) => entry.sha256),
      );
      expect(report.source.text).toMatch(/sealed interface Shapes permits/u);
      expect(report.source.text).toMatch(/record Circle\(double radius\)/u);
      expect(report.source.text).toMatch(
        /catch \(IllegalStateException \| IllegalArgumentException/u,
      );
      expect(report.decompiler).toMatchObject({
        id: "vineflower",
        version: "1.12.0",
      });
      expect(report.untrusted_methods).toEqual([]);
      expect(report.coverage).toEqual([
        expect.objectContaining({ facet: "reconstruct", state: "complete" }),
      ]);
      expect(report.limitations[0]).toMatch(/inferred, not the original/u);
    });

    it("decompiles the outermost class when a nested class is selected", async () => {
      const report = await decompile({
        path: fixtures.aar,
        class: "demo.Shapes$Circle",
      });
      expect(report.selection).toMatchObject({
        container: "classes.jar",
        entry: "demo/Shapes$Circle.class",
      });
      expect(report.top_level).toBe("demo/Shapes");
      expect(report.inputs.find((entry) => entry.role === "outer")?.name).toBe(
        "demo/Shapes",
      );
      expect(report.library?.container).toBe("classes.jar");
    });

    it("reads siblings of a loose class only when asked", async () => {
      const path = join(fixtures.classes, "demo", "Shapes.class");
      const alone = await decompile({ path });
      expect(alone.missing_nested).toEqual([
        "demo/Shapes$Circle",
        "demo/Shapes$Square",
      ]);
      expect(alone.coverage[0]).toMatchObject({
        state: "partial",
        continuation: "Pass siblings: true, or read the class from its JAR.",
      });
      const withSiblings = await decompile({ path, siblings: true });
      expect(withSiblings.missing_nested).toEqual([]);
      expect(
        withSiblings.inputs.filter((entry) => entry.file !== null),
      ).toHaveLength(2);
    });

    it("decompiles the multi-release variant the caller names", async () => {
      const seventeen = await decompile({
        path: fixtures.multiRelease,
        class: "mr.Version",
        release: 21,
      });
      expect(seventeen.selection).toMatchObject({ release: 17 });
      expect(seventeen.source.text).toMatch(/"seventeen"/u);
      const base = await decompile({
        path: fixtures.multiRelease,
        class: "mr.Version",
      });
      expect(base.source.text).toMatch(/"base"/u);
    });

    it("flags methods whose bytecode does not decode, even when the decompiler prints a body", async () => {
      const original = await readFile(
        join(fixtures.classes, "demo", "Task.class"),
      );
      const parsed = parseClass(original);
      const run = parsed?.methods.find((entry) => entry.name === "run");
      const corrupt = Buffer.from(original);
      corrupt[(run?.code?.codeOffset ?? 0) + 0] = 0xff;
      const path = join(root, "Task.class");
      await writeFile(path, corrupt);
      const report = await decompile({ path });
      expect(report.untrusted_methods).toEqual([
        expect.objectContaining({
          class: "demo/Task",
          method: "run",
          descriptor: "()V",
        }),
      ]);
      expect(report.coverage[0]?.state).toBe("partial");
      expect(report.limitations.join(" ")).toMatch(/not evidence of behavior/u);
    });

    it("marks pattern switches the decompiler cannot resugar instead of calling the text complete", async (context) => {
      // The fixture needs javac 21+.
      if (fixtures.patterns === null) context.skip();
      const report = await decompile({
        path: fixtures.patterns,
        class: "lane.Patterns",
      });
      expect(report.decompiler_notes).toEqual([
        expect.objectContaining({
          text: expect.stringMatching(
            /^Unresolved invokedynamic .*typeSwitch/u,
          ),
        }),
      ]);
      expect(report.coverage[0]).toMatchObject({ state: "partial" });
    });

    it("refuses selections that do not name one class", async () => {
      const result = await provider.decompileClass(
        decompileJvmClassInputSchema.parse({ path: fixtures.app }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error._tag).toBe("AnalysisInputError");
    });
  },
);

describe.skipIf(JDK_HOME === null || !VINEFLOWER)(
  "Vineflower review regressions",
  () => {
    it.each([0, 1])(
      "scrubs scratch paths from Vineflower diagnostics (exit %s)",
      async (exit) => {
        const java = join(root, `diagnostic-java-${exit}`);
        await writeFile(
          java,
          `#!/bin/sh\nprintf 'WARN cannot read %s/library.jar\\n' "$PWD" >&2\nexit ${exit}\n`,
          { mode: 0o700 },
        );
        const limits = decompileJvmClassInputSchema.parse({
          path: fixtures.app,
          class: "demo.Shapes",
        });
        const failure = await decompileJarClass({
          jar: await readFile(fixtures.app),
          name: "app.jar",
          className: "demo/Shapes",
          limits,
          tool: { ...(await resolveVineflower()), java },
        }).catch((cause: unknown) => cause);
        const mapped = vineflowerFailure(
          "decompile_jvm_class",
          fixtures.app,
          limits,
          failure,
        );
        expect(mapped).not.toBeNull();
        expect(mapped?.message).toContain("<scratch>/library.jar");
        expect(mapped?.message).not.toContain("oopsware-vineflower-");
      },
    );

    it("rechecks a cached Vineflower jar before every run", async () => {
      const tool = await resolveVineflower();
      const jar = join(root, "copied-vineflower.jar");
      await stageVineflower(tool, jar);
      await writeFile(jar, "changed after discovery");
      await expect(
        stageVineflower({ ...tool, jar }, join(root, "refused.jar")),
      ).rejects.toMatchObject({
        _tag: "VineflowerUnavailable",
        message: expect.stringContaining("jar changed"),
      });
    });
  },
);
