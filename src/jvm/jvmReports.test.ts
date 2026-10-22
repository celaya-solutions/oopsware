import { execFile } from "node:child_process";
import {
  mkdtemp,
  readdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { JvmProvider } from "./JvmProvider.js";
import { decodeBytecode } from "./classfile/bytecode.js";
import { parseClass } from "./classfile/parseClass.js";
import { OPCODES } from "./classfile/opcodes.js";
import {
  inspectJvmArtifactInputSchema,
  inspectJvmClassInputSchema,
  inspectJvmMethodInputSchema,
  jvmArtifactReportSchema,
  jvmClassReportSchema,
  jvmMethodReportSchema,
  type JvmArtifactReport,
  type JvmClassReport,
  type JvmMethodReport,
} from "../domain/jvm/jvm.js";
import {
  buildJvmFixtures,
  JDK_HOME,
  type JvmFixtures,
} from "../../tests/fixtures/jvmProducers.js";
import { removeTestWorkspace } from "../../tests/support/workspace/workspaceFixture.js";

const run = promisify(execFile);
const provider = new JvmProvider();

const artifact = async (
  input: Record<string, unknown>,
): Promise<JvmArtifactReport> => {
  const result = await provider.inspectArtifact(
    inspectJvmArtifactInputSchema.parse(input),
  );
  if (!result.ok) throw result.error;
  return jvmArtifactReportSchema.parse(result.value);
};

const cls = async (input: Record<string, unknown>): Promise<JvmClassReport> => {
  const result = await provider.inspectClass(
    inspectJvmClassInputSchema.parse(input),
  );
  if (!result.ok) throw result.error;
  return jvmClassReportSchema.parse(result.value);
};

const method = async (
  input: Record<string, unknown>,
): Promise<JvmMethodReport> => {
  const result = await provider.inspectMethod(
    inspectJvmMethodInputSchema.parse(input),
  );
  if (!result.ok) throw result.error;
  return jvmMethodReportSchema.parse(result.value);
};

const failure = async (
  operation: "inspectClass" | "inspectMethod" | "inspectArtifact",
  input: Record<string, unknown>,
) => {
  const schema =
    operation === "inspectClass"
      ? inspectJvmClassInputSchema
      : operation === "inspectMethod"
        ? inspectJvmMethodInputSchema
        : inspectJvmArtifactInputSchema;
  const result = await provider[operation](schema.parse(input) as never);
  if (result.ok) throw new Error("expected a failure");
  const issues =
    "issues" in result.error
      ? (result.error.issues as readonly { message: string }[])
      : [];
  return {
    tag: result.error._tag,
    message: [
      result.error.message,
      ...issues.map((issue) => issue.message),
    ].join(" "),
  };
};

const classFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".class"))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
};

/** javap's `pc: mnemonic` lines per method, keyed by name and descriptor. */
const javapListing = async (path: string): Promise<Map<string, string[]>> => {
  const { stdout } = await run(join(JDK_HOME ?? "", "bin", "javap"), [
    "-c",
    "-p",
    "-s",
    path,
  ]);
  const listing = new Map<string, string[]>();
  let header = "";
  let current: string[] | null = null;
  for (const line of stdout.split("\n")) {
    if (/^ {2}(\S.*\(.*\)|static \{\}).*;$/u.test(line)) {
      header = line;
      current = null;
      continue;
    }
    const descriptor = /^ {4}descriptor: (\S+)$/u.exec(line);
    if (descriptor !== null && header !== "") {
      const name = header.includes("static {}")
        ? "<clinit>"
        : (/([\w$<>.]+)\(/u.exec(header)?.[1] ?? "?");
      current = [];
      listing.set(
        `${name.split(".").at(-1) ?? name}${descriptor[1] ?? ""}`,
        current,
      );
      continue;
    }
    const instruction = /^\s+(\d+): ([a-z]\w*)/u.exec(line);
    if (instruction !== null && current !== null)
      current.push(`${instruction[1] ?? ""}: ${instruction[2] ?? ""}`);
  }
  return listing;
};

describe("opcode table", () => {
  it("defines the 202 JVM instructions (0x00-0xc9) and nothing else", () => {
    expect(OPCODES).toHaveLength(202);
    expect(OPCODES.map((entry) => entry.code)).toEqual(
      Array.from({ length: 202 }, (_, code) => code),
    );
  });
});

let fixtures: JvmFixtures;
let root: string | undefined;
let building: Promise<void> | undefined;

/** Building the fixtures runs javac and jarsigner, so every group shares one tree. */
const useFixtures = () =>
  beforeAll(async () => {
    building ??= (async () => {
      root = await realpath(
        await mkdtemp(join(await realpath(tmpdir()), "rea-jvm-")),
      );
      fixtures = await buildJvmFixtures(root);
    })();
    await building;
  }, 120_000);

afterAll(async () => {
  if (root !== undefined) await removeTestWorkspace(root);
});

describe.skipIf(JDK_HOME === null)(
  "JVM class and method views over JDK-built classes",
  () => {
    useFixtures();

    it("decodes every method of every class exactly as javap lists it", async () => {
      let compared = 0;
      for (const path of await classFiles(fixtures.classes)) {
        const bytes = await readFile(path);
        const parsed = parseClass(bytes);
        expect(parsed?.stopped, path).toBeNull();
        expect(parsed?.problems, path).toEqual([]);
        const expected = await javapListing(path);
        for (const entry of parsed?.methods ?? []) {
          if (entry.code === null || parsed?.pool == null) continue;
          const decoded = decodeBytecode(
            bytes,
            entry.code.codeOffset,
            entry.code.codeLength,
            parsed.pool,
          );
          expect(decoded.stopped).toBeNull();
          expect(decoded.problems).toEqual([]);
          const owner = parsed.thisClass?.split("/").at(-1) ?? "";
          const key = `${entry.name === "<init>" ? owner : entry.name}${entry.descriptor}`;
          expect(
            decoded.instructions.map(
              (instruction) =>
                `${String(instruction.pc)}: ${instruction.opcode.name}${instruction.wide ? "_w" : ""}`,
            ),
            `${path} ${key}`,
          ).toEqual(expected.get(key));
          compared += 1;
        }
      }
      expect(compared).toBeGreaterThan(20);
    });
  },
);

describe.skipIf(JDK_HOME === null)(
  "JVM class and method views over JDK-built classes (2)",
  () => {
    useFixtures();

    it("reads a sealed interface, its records and annotations from a loose class file", async () => {
      const shapes = await cls({
        path: join(fixtures.classes, "demo", "Shapes.class"),
      });
      expect(shapes.selection).toMatchObject({
        basis: "file",
        entry: null,
        variants: [],
      });
      expect(shapes.class).toMatchObject({
        name: "demo/Shapes",
        kind: "interface",
        version: { major: 61, java: "17", preview: false },
        decode: "complete",
        permitted_subclasses: ["demo/Shapes$Circle", "demo/Shapes$Square"],
        source_file: "Shapes.java",
      });
      expect(shapes.class.annotations).toEqual([
        { text: '@demo.Tag(value="shape", weight=7)', visible: true },
      ]);
      expect(
        shapes.class.bootstrap_methods.some((entry) =>
          entry.handle?.includes("LambdaMetafactory.metafactory"),
        ),
      ).toBe(true);
      expect(
        shapes.class.methods.find((entry) => entry.name === "guarded"),
      ).toMatchObject({
        declaration:
          "public static long guarded(java.lang.Object, java.util.List)",
        throws: ["java/lang/Exception"],
      });
      expect(
        shapes.coverage.find((entry) => entry.facet === "reconstruct")?.state,
      ).toBe("not_requested");

      const square = await cls({
        path: join(fixtures.classes, "demo", "Shapes$Square.class"),
      });
      expect(square.class.kind).toBe("record");
      expect(square.class.record_components).toEqual([
        {
          name: "side",
          descriptor: "J",
          type: "long",
          signature: null,
          annotations: [],
        },
      ]);
      // @Deprecated cannot target a record component, so javac puts it on the field.
      expect(square.class.fields[0]?.annotations).toEqual([
        { text: "@java.lang.Deprecated", visible: true },
      ]);
      expect(square.class.nest_host).toBe("demo/Shapes");

      const tag = await cls({
        path: join(fixtures.classes, "demo", "Tag.class"),
      });
      expect(tag.class.kind).toBe("annotation");
      expect(
        tag.class.methods.find((entry) => entry.name === "weight")
          ?.annotation_default,
      ).toBe("3");
      expect(
        tag.class.methods.find((entry) => entry.name === "on")
          ?.annotation_default,
      ).toBe("{java.lang.annotation.ElementType.TYPE}");
    });
  },
);

describe.skipIf(JDK_HOME === null)(
  "JVM class and method views over JDK-built classes (3)",
  () => {
    useFixtures();

    it("decodes switches, handlers, invokedynamic and overload choice in one method view", async () => {
      const path = join(fixtures.classes, "demo", "Shapes.class");
      const dense = await method({ path, method: "dense" });
      const table = dense.instructions.find(
        (entry) => entry.op === "tableswitch",
      );
      expect(table?.operands).toMatch(
        /^\{ 0: \d+, 1: \d+, 2: \d+, default: \d+ \}$/u,
      );
      expect(dense.instructions.every((entry) => entry.line !== null)).toBe(
        true,
      );

      const guarded = await method({ path, method: "guarded" });
      const catches = guarded.exception_table.map((entry) => entry.catch_type);
      expect(catches).toContain("java/lang/IllegalStateException");
      expect(catches).toContain("java/lang/IllegalArgumentException");
      expect(catches).toContain(null);
      expect(guarded.references.constants).toContainEqual(
        expect.objectContaining({
          op: "ldc2_w",
          kind: "long",
          value: "9000000000l",
        }),
      );
      expect(guarded.local_variables.map((entry) => entry.name)).toEqual(
        expect.arrayContaining(["lock", "items", "total"]),
      );
      expect(
        guarded.local_variables.find((entry) => entry.name === "items")
          ?.signature,
      ).toBe("Ljava/util/List<Ljava/lang/String;>;");

      const lambda = await method({ path, method: "lambda" });
      expect(lambda.references.dynamic.map((entry) => entry.name)).toEqual([
        "apply",
        "get",
      ]);
      expect(lambda.references.dynamic[0]?.bootstrap?.handle).toMatch(
        /LambdaMetafactory\.metafactory/u,
      );
      expect(
        lambda.references.dynamic[0]?.bootstrap?.arguments.join(" "),
      ).toMatch(/lambda\$lambda\$0/u);

      const paged = await method({
        path,
        method: "guarded",
        start: 2,
        limit: 3,
      });
      expect(paged.page).toEqual({ start: 2, limit: 3, returned: 3, next: 5 });
      expect(paged.instructions.map((entry) => entry.index)).toEqual([2, 3, 4]);

      const overloaded = await failure("inspectMethod", {
        path,
        method: "area",
      });
      expect(overloaded.message).toMatch(/overloaded/u);
      const one = await method({ path, method: "area", descriptor: "(I)I" });
      expect(one.method.declaration).toBe("public static int area(int)");
      const abstract = await method({
        path,
        method: "area",
        descriptor: "()D",
      });
      expect(abstract.instructions).toEqual([]);
      expect(abstract.coverage[0]).toMatchObject({
        facet: "inspect",
        state: "unavailable",
      });
    });
  },
);

describe.skipIf(JDK_HOME === null)(
  "JVM archive views over JDK-built JARs and AARs",
  () => {
    useFixtures();

    it("inventories a signed modular JAR: manifest, services, module, signature and digests", async () => {
      const report = await artifact({ path: fixtures.app });
      expect(report.container).toEqual({
        kind: "jar",
        basis: "layout",
        name_conflict: null,
      });
      expect(report.manifest).toMatchObject({
        main_class: "demo.Task",
        multi_release: false,
      });
      expect(report.services).toEqual([
        {
          container: null,
          entry: "META-INF/services/java.lang.Runnable",
          service: "java.lang.Runnable",
          providers: ["demo.Task"],
          invalid_lines: 1,
        },
      ]);
      expect(report.modules).toHaveLength(1);
      expect(report.modules[0]).toMatchObject({
        entry: "module-info.class",
        name: "demo.shapes",
        requires: expect.arrayContaining([
          { module: "java.logging", flags: ["static"], version: null },
        ]),
        exports: [{ package: "demo", flags: [], to: [] }],
        provides: [{ service: "java/lang/Runnable", with: ["demo/Task"] }],
      });
      expect(report.signatures).toEqual([
        expect.objectContaining({
          signer: "FIXTURE",
          signature_file: "META-INF/FIXTURE.SF",
          block_file: "META-INF/FIXTURE.EC",
          block_type: "EC",
        }),
      ]);
      expect(report.entry_digests).toMatchObject({
        mismatched: [],
        missing: [],
        unchecked: 0,
      });
      expect(report.entry_digests?.algorithms).toHaveLength(1);
      expect(report.entry_digests?.matched).toBe(
        report.entry_digests?.declared,
      );
      expect(report.summary.kinds).toMatchObject({
        module: 1,
        interface: 1,
        record: 2,
        annotation: 1,
      });
      expect(
        report.classes.every(
          (entry) => entry.sha256 !== null && entry.decode === "complete",
        ),
      ).toBe(true);
      expect(
        report.coverage.map((entry) => [entry.facet, entry.state]),
      ).toEqual([
        ["identify", "complete"],
        ["inventory", "complete"],
        ["inspect", "complete"],
        ["reconstruct", "not_requested"],
      ]);
      expect(report.limitations.join(" ")).toMatch(/not verified/u);

      const page = await artifact({ path: fixtures.app, start: 1, limit: 2 });
      expect(page.page).toEqual({ start: 1, limit: 2, returned: 2, next: 3 });
      expect(page.classes).toEqual(report.classes.slice(1, 3));
    });
  },
);

describe.skipIf(JDK_HOME === null)(
  "JVM archive views over JDK-built JARs and AARs (2)",
  () => {
    useFixtures();

    it("keeps every multi-release variant and resolves only the release the caller names", async () => {
      const report = await artifact({ path: fixtures.multiRelease });
      expect(report.multi_release).toEqual({
        declared: true,
        releases: [11, 17],
        versioned_classes: 2,
        ignored: false,
      });
      expect(
        report.classes.map((entry) => [
          entry.entry,
          entry.release,
          entry.version.java,
        ]),
      ).toEqual([
        ["mr/Version.class", null, "8"],
        ["META-INF/versions/11/mr/Version.class", 11, "11"],
        ["META-INF/versions/17/mr/Version.class", 17, "17"],
      ]);
      const base = await cls({
        path: fixtures.multiRelease,
        class: "mr.Version",
      });
      expect(base.selection).toMatchObject({
        basis: "base",
        release: null,
        entry: "mr/Version.class",
      });
      expect(base.selection.variants.map((entry) => entry.release)).toEqual([
        null,
        11,
        17,
      ]);
      const label = async (release: number | undefined) =>
        (
          await method({
            path: fixtures.multiRelease,
            class: "mr/Version",
            method: "label",
            ...(release === undefined ? {} : { release }),
          })
        ).references.constants.map((entry) => entry.value);
      expect(await label(undefined)).toEqual(['"base"']);
      expect(await label(8)).toEqual(['"base"']);
      expect(await label(11)).toEqual(['"eleven"']);
      expect(await label(16)).toEqual(['"eleven"']);
      expect(await label(21)).toEqual(['"seventeen"']);
      const exact = await cls({
        path: fixtures.multiRelease,
        entry: "META-INF/versions/17/mr/Version.class",
      });
      expect(exact.selection).toMatchObject({ basis: "entry", release: 17 });

      const undeclared = await artifact({ path: fixtures.undeclared });
      expect(undeclared.multi_release).toMatchObject({
        declared: false,
        ignored: true,
      });
      const notHonoured = await cls({
        path: fixtures.undeclared,
        class: "mr.Version",
        release: 21,
      });
      expect(notHonoured.selection).toMatchObject({
        basis: "release",
        entry: "mr/Version.class",
      });
    });
  },
);

describe.skipIf(JDK_HOME === null)(
  "JVM archive views over JDK-built JARs and AARs (3)",
  () => {
    useFixtures();

    it("inventories an AAR and reads classes from the JARs it contains", async () => {
      const report = await artifact({ path: fixtures.aar });
      expect(report.container.kind).toBe("aar");
      expect(report.android).toMatchObject({
        manifest: {
          package: "com.example.lib",
          min_sdk: "24",
          target_sdk: "34",
          error: null,
        },
        native_libraries: [
          expect.objectContaining({
            entry: "jni/arm64-v8a/libnative.so",
            abi: "arm64-v8a",
            elf: { class: "64", machine: "aarch64" },
          }),
        ],
        resources: 1,
        other: ["R.txt"],
      });
      expect(
        report.embedded_jars.map((entry) => [entry.entry, entry.read]),
      ).toEqual(
        expect.arrayContaining([
          ["classes.jar", "complete"],
          ["libs/extra.jar", "complete"],
        ]),
      );
      expect(new Set(report.classes.map((entry) => entry.container))).toEqual(
        new Set(["classes.jar", "libs/extra.jar"]),
      );
      const task = await cls({ path: fixtures.aar, class: "demo.Task" });
      expect(task.selection).toMatchObject({
        container: "classes.jar",
        entry: "demo/Task.class",
        basis: "only",
      });
      expect(task.class.fields[0]).toMatchObject({
        name: "NAME",
        constant_value: '"task"',
        access: ["public", "static", "final"],
      });
      const wrong = await failure("inspectClass", {
        path: fixtures.aar,
        class: "demo.Task",
        container: "libs/extra.jar",
      });
      expect(wrong.message).toMatch(/No class demo\.Task/u);
    });
  },
);

describe.skipIf(JDK_HOME === null)(
  "JVM reads of damaged and unsupported input",
  () => {
    useFixtures();

    it("keeps facts before damage and refuses what it cannot read", async () => {
      const workspace = root ?? "";
      const original = await readFile(
        join(fixtures.classes, "demo", "Shapes.class"),
      );
      const truncated = join(workspace, "Truncated.class");
      const methods = parseClass(original)?.methods ?? [];
      // Cut inside the fourth method, after the constant pool and class header.
      await writeFile(
        truncated,
        original.subarray(0, (methods[3]?.offset ?? 0) + 4),
      );
      const damaged = await cls({ path: truncated });
      expect(damaged.class.decode).toBe("partial");
      expect(damaged.class.name).toBe("demo/Shapes");
      expect(
        damaged.coverage.find((entry) => entry.facet === "inspect")?.state,
      ).toBe("partial");

      const parsed = parseClass(original);
      expect(damaged.class.methods).toHaveLength(3);
      const dense = parsed?.methods.find((entry) => entry.name === "dense");
      const corrupt = Buffer.from(original);
      corrupt[(dense?.code?.codeOffset ?? 0) + 1] = 0xff;
      const badOpcode = join(workspace, "BadOpcode.class");
      await writeFile(badOpcode, corrupt);
      const stopped = await method({ path: badOpcode, method: "dense" });
      expect(stopped.instruction_count).toBe(1);
      expect(stopped.coverage[0]).toMatchObject({
        facet: "inspect",
        state: "partial",
      });
      expect(stopped.diagnostics.at(-1)?.message).toMatch(
        /0xff .* not a defined opcode/u,
      );

      // Constant #1's tag byte (offset 10) set to an undefined tag stops the read in the pool.
      const badPool = Buffer.from(original);
      badPool[10] = 2;
      const poolPath = join(workspace, "BadPool.class");
      await writeFile(poolPath, badPool);
      const pool = await artifact({ path: poolPath });
      expect(pool.classes[0]).toMatchObject({ decode: "failed", name: null });
      expect(pool.diagnostics.at(-1)?.message).toMatch(/unknown tag 2/u);

      const future = Buffer.from(original);
      future.writeUInt16BE(99, 6);
      const futurePath = join(workspace, "Future.class");
      await writeFile(futurePath, future);
      const newer = await cls({ path: futurePath });
      expect(newer.class).toMatchObject({
        decode: "complete",
        version: { major: 99, java: "55" },
      });
      expect(newer.diagnostics[0]?.message).toMatch(/newer than 71/u);

      const text = join(workspace, "notes.class");
      await writeFile(text, "not a class");
      expect((await failure("inspectArtifact", { path: text })).tag).toBe(
        "AnalysisUnsupportedTargetError",
      );

      const starved = await artifact({
        path: fixtures.app,
        max_decoded_bytes: 2000,
      });
      const inspect = starved.coverage.find(
        (entry) => entry.facet === "inspect",
      );
      expect(inspect).toMatchObject({
        state: "partial",
        continuation: "Raise max_decoded_bytes.",
      });
      expect(
        starved.classes.some(
          (entry) => entry.decode === "failed" && entry.sha256 === null,
        ),
      ).toBe(true);

      const loose = await failure("inspectClass", {
        path: join(fixtures.classes, "demo", "Task.class"),
        entry: "x.class",
      });
      expect(loose.message).toMatch(/single class file/u);
    });
  },
);
