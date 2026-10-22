import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  inspectPythonArtifactInputSchema,
  inspectPythonCodeInputSchema,
  inspectPythonModuleInputSchema,
  pythonArtifactReportSchema,
  pythonCodeReportSchema,
  pythonModuleReportSchema,
} from "../domain/python/python.js";
import {
  admittedProducers,
  buildWheel,
  buildZipapp,
  compileSample,
  replaceMember,
  wheelProducer,
} from "../../tests/fixtures/pythonProducers.js";
import { admittedProfile } from "./bytecode/profiles.js";
import { discoverInterpreters } from "./interpreters.js";
import { PythonProvider } from "./PythonProvider.js";

const provider = new PythonProvider();
const producers = await admittedProducers();
const builder = await wheelProducer();
const interpreters = await discoverInterpreters();
const newest = producers[0];
const scratch = await mkdtemp(join(tmpdir(), "oopsware-python-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));

const artifact = async (input: Record<string, unknown>) => {
  const result = await provider.inspectArtifact(
    inspectPythonArtifactInputSchema.parse(input),
  );
  if (!result.ok) throw result.error;
  return pythonArtifactReportSchema.parse(result.value);
};

const module = async (input: Record<string, unknown>) => {
  const result = await provider.inspectModule(
    inspectPythonModuleInputSchema.parse(input),
  );
  if (!result.ok) throw result.error;
  return pythonModuleReportSchema.parse(result.value);
};

const code = async (input: Record<string, unknown>) => {
  const result = await provider.inspectCode(
    inspectPythonCodeInputSchema.parse(input),
  );
  if (!result.ok) throw result.error;
  return pythonCodeReportSchema.parse(result.value);
};

const failure = async (
  operation: "inspectArtifact" | "inspectModule" | "inspectCode",
  input: Record<string, unknown>,
) => {
  const schema =
    operation === "inspectArtifact"
      ? inspectPythonArtifactInputSchema
      : operation === "inspectModule"
        ? inspectPythonModuleInputSchema
        : inspectPythonCodeInputSchema;
  const result = await provider[operation](schema.parse(input) as never);
  if (result.ok) throw new Error("expected a failure");
  return result.error;
};

describe.skipIf(builder === null)("wheels built by pip and setuptools", () => {
  let pure = "";
  let native = "";
  beforeAll(async () => {
    if (builder === null) return;
    pure = await buildWheel(builder, scratch, "project");
    native = await buildWheel(builder, scratch, "native");
  }, 300_000);

  it("reads metadata, entry points, licenses and verifies every RECORD digest", async () => {
    const report = await artifact({ path: pure });
    expect(report.container).toEqual({
      kind: "wheel",
      basis: "layout",
      name_conflict: null,
    });
    const wheel = report.wheel;
    expect(wheel?.filename).toEqual({
      distribution: "oopsdemo",
      version: "1.2.3",
      build: null,
      python_tags: ["py3"],
      abi_tags: ["none"],
      platform_tags: ["any"],
    });
    expect(wheel?.dist_info).toBe("oopsdemo-1.2.3.dist-info");
    expect(wheel?.metadata).toMatchObject({
      name: "oopsdemo",
      version: "1.2.3",
      summary: "Fixture package for Oopsware's Python reader",
      requires_python: ">=3.9",
      classifiers: ["Programming Language :: Python :: 3"],
      provides_extra: ["pretty"],
    });
    expect(wheel?.metadata?.requires_dist).toContain("requests>=2");
    expect(wheel?.wheel?.root_is_purelib).toBe(true);
    expect(wheel?.wheel?.tags).toEqual(["py3-none-any"]);
    expect(wheel?.entry_points).toEqual(
      expect.arrayContaining([
        {
          group: "console_scripts",
          name: "oopsdemo",
          value: "oopsdemo.cli:main",
        },
        {
          group: "oopsdemo.plugins",
          name: "basic",
          value: "oopsdemo.plugins:Basic",
        },
      ]),
    );
    expect(wheel?.licenses.map((entry) => entry.entry)).toEqual([
      "oopsdemo-1.2.3.dist-info/licenses/LICENSE",
    ]);
    const record = wheel?.record;
    expect(record?.mismatched).toEqual([]);
    expect(record?.not_listed).toEqual([]);
    expect(record?.absent).toEqual([]);
    expect(record?.unhashed).toEqual(["oopsdemo-1.2.3.dist-info/RECORD"]);
    expect(record?.verified).toBe((record?.rows ?? 0) - 1);
    expect(report.modules.map((entry) => [entry.entry, entry.module])).toEqual([
      ["oopsdemo/__init__.py", "oopsdemo"],
      ["oopsdemo/cli.py", "oopsdemo.cli"],
      ["oopsdemo/plugins.py", "oopsdemo.plugins"],
    ]);
    expect(
      report.coverage.find((entry) => entry.facet === "inspect")?.state,
    ).toBe("complete");
    expect(
      report.coverage.find((entry) => entry.facet === "reconstruct")?.state,
    ).toBe("not_requested");
  });

  it("reports a member whose bytes no longer match RECORD", async () => {
    if (builder === null) return;
    const changed = join(scratch, "oopsdemo-1.2.3-py3-none-any.changed.whl");
    await replaceMember(
      builder,
      pure,
      changed,
      "oopsdemo/plugins.py",
      "print('changed')\n",
    );
    const record = (await artifact({ path: changed })).wheel?.record;
    expect(record?.mismatched).toHaveLength(1);
    expect(record?.mismatched[0]).toMatchObject({
      entry: "oopsdemo/plugins.py",
      algorithm: "sha256",
      actual_size: 17,
    });
    expect(record?.mismatched[0]?.expected).not.toBe(
      record?.mismatched[0]?.actual,
    );
  });

  it("lists a native extension with its binary format and ABI tag", async () => {
    const report = await artifact({ path: native });
    expect(report.wheel?.wheel?.root_is_purelib).toBe(false);
    expect(report.native_count).toBe(1);
    const extension = report.wheel?.native_extensions[0];
    expect(extension?.binary).toBe(
      process.platform === "darwin" ? "mach-o" : "elf",
    );
    expect(extension?.abi_tag).toMatch(/^cpython-3\d+-/u);
    expect(extension?.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(report.wheel?.record?.mismatched).toEqual([]);
  });

  it("parses a wheel member's source", async () => {
    const report = await module({ path: pure, entry: "oopsdemo/cli.py" });
    expect(report.kind).toBe("source");
    expect(report.selection.entry).toBe("oopsdemo/cli.py");
    expect(report.source?.dynamic.items).toEqual([
      expect.objectContaining({
        kind: "import",
        callee: "importlib.import_module",
        literal: "oopsdemo.plugins",
        scope: "main",
      }),
    ]);
  });
});

describe.skipIf(newest === undefined)("zip applications", () => {
  let app = "";
  beforeAll(async () => {
    if (newest === undefined) return;
    app = await buildZipapp(newest, join(scratch, "zipapp"));
  }, 120_000);

  it("declares the shebang and __main__.py and lists source and bytecode modules", async () => {
    const report = await artifact({ path: app });
    expect(report.container.kind).toBe("zipapp");
    expect(report.zipapp?.shebang).toBe("#!/usr/bin/env python3");
    expect(report.zipapp?.main?.entry).toBe("__main__.py");
    const bytecode = report.modules.find((entry) => entry.kind === "bytecode");
    expect(bytecode).toMatchObject({ module: "pkg.sample", admitted: true });
    expect(
      report.modules.find((entry) => entry.entry === "__main__.py")?.module,
    ).toBe("__main__");
  });

  it("decodes a .pyc member's code objects and one method", async () => {
    const report = await artifact({ path: app });
    const entry =
      report.modules.find((item) => item.kind === "bytecode")?.entry ?? "";
    const listed = await module({ path: app, entry });
    expect(listed.bytecode?.decode).toBe("complete");
    expect(listed.bytecode?.filename).toBe("pkg/sample.py");
    const qualnames =
      listed.bytecode?.code_objects.map((item) => item.qualname) ?? [];
    expect(qualnames).toContain("Child.fetch");
    expect(listed.bytecode?.imports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          module: "collections",
          fromlist: ["OrderedDict", "namedtuple"],
          level: 0,
        }),
        expect.objectContaining({
          module: "",
          fromlist: ["sibling"],
          level: 1,
        }),
      ]),
    );
    const fetch = await code({ path: app, entry, code: "Child.fetch" });
    expect(fetch.code.flag_names).toContain("ASYNC_GENERATOR");
    expect(fetch.problems).toEqual([]);
    expect(fetch.exception_table.length).toBeGreaterThan(0);
  });
});

describe.skipIf(interpreters.length === 0)("source parsing", () => {
  it("reports imports, definitions, decorators, guards and dynamic calls", async () => {
    const path = join(
      import.meta.dirname,
      "../../tests/fixtures/python/sample.py",
    );
    const report = await module({ path, max_listed: 50 });
    const source = report.source;
    expect(source?.status).toBe("parsed");
    expect(source?.encoding).toBe("utf-8");
    expect(source?.docstring).toContain("🐍");
    expect(
      source?.imports.items.map((item) => [
        item.kind,
        item.module,
        item.name,
        item.level,
      ]),
    ).toEqual([
      ["import", "os", null, 0],
      ["import", "sys", null, 0],
      ["from", "collections", "OrderedDict", 0],
      ["from", "collections", "namedtuple", 0],
      ["from", null, "sibling", 1],
      ["from", "parent", "thing", 2],
    ]);
    const outer = source?.definitions.items.find(
      (item) => item.qualname === "outer",
    );
    expect(outer?.decorators).toEqual(["decorator"]);
    expect(outer?.arguments).toBe("a, b=2, /, c=3, *args, d, e=5, **kwargs");
    expect(
      source?.definitions.items.find((item) => item.qualname === "Child")
        ?.bases,
    ).toEqual(["Base"]);
    expect(source?.definitions.items.map((item) => item.qualname)).toContain(
      "Child.fetch",
    );
    expect(source?.main_guards).toHaveLength(1);
    expect(source?.calls.total).toBeGreaterThan(10);
    expect(source?.calls.items.length).toBeLessThanOrEqual(50);
    expect(source?.lambdas).toBe(1);
    expect(
      report.coverage.find((item) => item.facet === "inspect")?.state,
    ).toBe("complete");
  });

  it("decodes a PEP 263 declared encoding", async () => {
    const path = join(scratch, "latin.py");
    await writeFile(
      path,
      Buffer.concat([
        Buffer.from("# -*- coding: latin-1 -*-\nNAME = '"),
        Buffer.from([0xe9]),
        Buffer.from("'\nimport json\n"),
      ]),
    );
    const report = await module({ path });
    expect(report.source?.encoding).toBe("iso-8859-1");
    expect(report.source?.status).toBe("parsed");
    expect(report.source?.imports.items[0]?.module).toBe("json");
  });

  it.skipIf(!interpreters.some((item) => item.version === "3.9"))(
    "reports a syntax error under an older grammar and parses with a newer one",
    async () => {
      const path = join(
        import.meta.dirname,
        "../../tests/fixtures/python/sample_310.py",
      );
      const old = await module({ path, python: "3.9" });
      expect(old.source?.status).toBe("syntax-error");
      expect(old.source?.syntax_error?.line).toBe(2);
      expect(old.coverage.find((item) => item.facet === "inspect")?.state).toBe(
        "unsupported",
      );
      const current = await module({ path });
      expect(current.source?.status).toBe("parsed");
    },
  );

  it("says when the chosen release is not installed", async () => {
    const path = join(
      import.meta.dirname,
      "../../tests/fixtures/python/sample.py",
    );
    const error = await failure("inspectModule", { path, python: "3.99" });
    expect(error._tag).toBe("AnalysisCapabilityUnavailableError");
  });
});

describe.skipIf(newest === undefined)(
  "unsupported and damaged bytecode",
  () => {
    let pyc = new Uint8Array();
    beforeAll(async () => {
      if (newest === undefined) return;
      pyc = await readFile(
        await compileSample(newest, join(scratch, "damaged"), "sample.py"),
      );
    }, 60_000);

    it("keeps the header of a release without a profile", async () => {
      const path = join(scratch, "py310.pyc");
      const bytes = Uint8Array.from(pyc);
      bytes[0] = 3439 & 0xff;
      bytes[1] = 3439 >> 8;
      await writeFile(path, bytes);
      const report = await module({ path });
      expect(report.bytecode?.header).toMatchObject({
        magic: 3439,
        release: "3.10",
        admitted: false,
      });
      expect(report.bytecode?.decode).toBe("not-admitted");
      expect(
        report.coverage.find((item) => item.facet === "inspect")?.state,
      ).toBe("unsupported");
      const error = await failure("inspectCode", { path });
      expect(error._tag).toBe("AnalysisUnsupportedTargetError");
    });

    it("reports truncated marshal data as a failed decode", async () => {
      const path = join(scratch, "truncated.pyc");
      await writeFile(path, pyc.subarray(0, 200));
      const report = await module({ path });
      expect(report.bytecode?.decode).toBe("failed");
      expect(report.bytecode?.problem).toMatch(/data ends/u);
    });

    it("flags an opcode the release does not define", async () => {
      const path = join(scratch, "bad-opcode.pyc");
      const bytes = Uint8Array.from(pyc);
      const magic = (bytes[0] ?? 0) | ((bytes[1] ?? 0) << 8);
      const profile = admittedProfile(magic);
      if (profile === null) throw new Error("no profile");
      // Header, the code object's type byte and its fixed integer fields, then co_code's type byte.
      const at = 16 + 1 + (profile.layout === "3.11+" ? 20 : 24);
      expect((bytes[at] ?? 0) & 0x7f).toBe(0x73);
      const unused = Array.from({ length: 256 }, (_, value) => value).find(
        (value) => !profile.opname.has(value),
      );
      if (unused === undefined) throw new Error("every opcode is defined");
      bytes[at + 5] = unused;
      await writeFile(path, bytes);
      const report = await module({ path });
      expect(report.bytecode?.decode).toBe("partial");
      const first = await code({ path, code_index: 0 });
      expect(first.instructions[0]?.problem).toMatch(/not a base instruction/u);
      expect(
        first.coverage.find((item) => item.facet === "inspect")?.state,
      ).toBe("partial");
    });

    it("refuses an ambiguous qualified name and accepts an index", async () => {
      if (newest === undefined) return;
      const path = await compileSample(
        newest,
        join(scratch, "duplicate"),
        "duplicate.py",
      );
      const error = await failure("inspectCode", { path, code: "f" });
      expect(error._tag).toBe("AnalysisInputError");
      const listed = await module({ path });
      const indexes = listed.bytecode?.code_objects
        .filter((item) => item.qualname === "f")
        .map((item) => item.index);
      expect(indexes).toHaveLength(2);
      const report = await code({ path, code_index: indexes?.[1] ?? -1 });
      expect(report.selection.qualname).toBe("f");
      expect(report.code.constants.map((item) => item.repr)).toContain("2");
    });
  },
);
