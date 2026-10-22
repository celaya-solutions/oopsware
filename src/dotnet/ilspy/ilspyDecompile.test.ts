import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { IlspyProvider } from "./IlspyProvider.js";
import { resolveIlspy } from "./ilspycmd.js";
import {
  decompileManagedTypeInputSchema,
  managedDecompilationSchema,
  type ManagedDecompilation,
} from "../../domain/managed/managedDecompilation.js";
import {
  buildDotnetFixtures,
  dotnetSdk,
  type DotnetFixtures,
} from "../../../tests/fixtures/dotnetProducers.js";
import { removeTestWorkspace } from "../../../tests/support/workspace/workspaceFixture.js";

const provider = new IlspyProvider();

/** The real decompiler and SDK are host tools; without them these cases are skipped. */
const ILSPY = await resolveIlspy().then(
  () => true,
  () => false,
);
const SDK = await dotnetSdk();

const decompile = async (input: Record<string, unknown>) => {
  const result = await provider.decompileType(
    decompileManagedTypeInputSchema.parse(input),
  );
  if (!result.ok) throw result.error;
  return managedDecompilationSchema.parse(result.value);
};

const failure = async (input: Record<string, unknown>) => {
  const result = await provider.decompileType(
    decompileManagedTypeInputSchema.parse(input),
  );
  if (result.ok) throw new Error("expected a failure");
  return result.error;
};

const states = (report: ManagedDecompilation) =>
  report.checks.map((check) => [check.id, check.state]);

describe.skipIf(!ILSPY || SDK === null)(
  "ILSpy reconstruction over SDK-built assemblies",
  () => {
    let root: string;
    let fixtures: DotnetFixtures;

    beforeAll(async () => {
      root = await realpath(
        await mkdtemp(join(await realpath(tmpdir()), "rea-ilspy-")),
      );
      if (SDK !== null) fixtures = await buildDotnetFixtures(SDK, root);
    }, 300_000);
    afterAll(async () => {
      await removeTestWorkspace(root);
    });

    it("decompiles a type with its nested type and checks every member", async () => {
      const report = await decompile({
        path: fixtures.shapes,
        type: "Demo.Circle",
      });
      expect(report.selection).toEqual({
        type: "Demo.Circle",
        decompiled: "Demo.Circle",
        nested: ["Unit"],
      });
      expect(report.source.text).toContain(
        "public sealed class Circle : IShape",
      );
      expect(report.source.text).toContain("public static Circle Make()");
      expect(report.source.confidence).toBe("inferred");
      expect(report.source.derived_from).toEqual([report.artifact.sha256]);
      expect(states(report)).toEqual([
        ["decompiler_clean", "passed"],
        ["members_present", "passed"],
      ]);
      expect(report.coverage[0]?.state).toBe("complete");
      expect(report.decompiler.arguments).toContain("--disable-updatecheck");
    }, 120_000);

    it("does not count the members C# writes for a record", async () => {
      const report = await decompile({
        path: fixtures.shapes,
        type: "Demo.Point",
      });
      expect(report.source.text).toContain("record Point");
      expect(report.missing_members).toEqual([]);
      expect(report.coverage[0]?.state).toBe("complete");
    }, 120_000);

    it("names a nested type as Outer+Inner and decompiles its outermost type", async () => {
      const report = await decompile({
        path: fixtures.shapes,
        type: "Demo.Circle+Unit",
      });
      expect(report.selection.decompiled).toBe("Demo.Circle");
      expect(report.coverage[0]?.state).toBe("complete");
    }, 120_000);

    it("decompiles the whole assembly when no type is given", async () => {
      const report = await decompile({ path: fixtures.shapes });
      expect(report.selection.decompiled).toBeNull();
      for (const name of [
        "interface IShape",
        "class Circle",
        "class Tools",
        "delegate double Scale",
      ])
        expect(report.source.text).toContain(name);
      expect(report.coverage[0]?.state).toBe("complete");
    }, 120_000);

    it("marks untyped code when a reference is missing and is clean with it", async () => {
      const without = await decompile({ path: fixtures.uses });
      expect(without.checks[0]?.state).toBe("failed");
      expect(without.decompiler_notes.length).toBeGreaterThan(0);
      expect(without.coverage[0]?.state).toBe("partial");
      const withReference = await decompile({
        path: fixtures.uses,
        reference_paths: [fixtures.shapesDirectory],
      });
      expect(withReference.references).toEqual([fixtures.shapesDirectory]);
      expect(states(withReference)).toEqual([
        ["decompiler_clean", "passed"],
        ["members_present", "passed"],
      ]);
    }, 120_000);

    it("refuses an unknown type, oversized text, a non-.NET file and a missing reference folder", async () => {
      const unknown = await failure({
        path: fixtures.shapes,
        type: "Demo.Nope",
      });
      expect(unknown._tag).toBe("AnalysisInputError");
      const large = await failure({
        path: fixtures.shapes,
        type: "Demo.Circle",
        max_source_bytes: 16,
      });
      expect(large.message).toContain("max_source_bytes");
      const text = await failure({
        path: join(
          import.meta.dirname,
          "../../../tests/fixtures/dotnet/Shapes/Shapes.cs",
        ),
      });
      expect(text._tag).toBe("AnalysisUnsupportedTargetError");
      const folder = await failure({
        path: fixtures.shapes,
        reference_paths: [join(root, "absent")],
      });
      expect(folder._tag).toBe("AnalysisInputError");
    }, 120_000);
  },
);
