import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from "@zip.js/zip.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AndroidPackageProvider } from "./AndroidPackageProvider.js";
import { DexFormatError } from "./dex/DexReader.js";
import { DexFile } from "./dex/dexFile.js";
import {
  androidArtifactReportSchema,
  dexClassReportSchema,
  dexMethodReportSchema,
  inspectAndroidArtifactInputSchema,
  inspectDexClassInputSchema,
  inspectDexMethodInputSchema,
  type AndroidArtifactReport,
  type DexClassReport,
  type DexMethodReport,
} from "../domain/android/androidArtifact.js";
import {
  ANDROID_TOOLS,
  buildAndroidFixtures,
  PACKAGE_NAME,
  VERSION_CODE,
  writeZip,
  type AndroidFixtures,
} from "../../tests/fixtures/androidProducers.js";
import { removeTestWorkspace } from "../../tests/support/workspace/workspaceFixture.js";

const provider = new AndroidPackageProvider();

const artifact = async (
  input: Record<string, unknown>,
): Promise<AndroidArtifactReport> => {
  const result = await provider.inspectArtifact(
    inspectAndroidArtifactInputSchema.parse(input),
  );
  if (!result.ok) throw result.error;
  return androidArtifactReportSchema.parse(result.value);
};

const cls = async (input: Record<string, unknown>): Promise<DexClassReport> => {
  const result = await provider.inspectClass(
    inspectDexClassInputSchema.parse(input),
  );
  if (!result.ok) throw result.error;
  return dexClassReportSchema.parse(result.value);
};

const method = async (
  input: Record<string, unknown>,
): Promise<DexMethodReport> => {
  const result = await provider.inspectMethod(
    inspectDexMethodInputSchema.parse(input),
  );
  if (!result.ok) throw result.error;
  return dexMethodReportSchema.parse(result.value);
};

const failure = async (
  operation: "inspectArtifact" | "inspectClass" | "inspectMethod",
  input: Record<string, unknown>,
) => {
  const schema =
    operation === "inspectClass"
      ? inspectDexClassInputSchema
      : operation === "inspectMethod"
        ? inspectDexMethodInputSchema
        : inspectAndroidArtifactInputSchema;
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

const readMembers = async (path: string): Promise<Map<string, Uint8Array>> => {
  const reader = new ZipReader(new Uint8ArrayReader(await readFile(path)));
  const members = new Map<string, Uint8Array>();
  for (const entry of await reader.getEntries())
    if (!entry.directory)
      members.set(entry.filename, await entry.getData(new Uint8ArrayWriter()));
  await reader.close();
  return members;
};

const bytesOf = (
  members: Map<string, Uint8Array>,
  name: string,
): Uint8Array => {
  const found = members.get(name);
  if (found === undefined) throw new Error(`${name} is missing`);
  return found;
};

let root = "";
let fixtures: AndroidFixtures;
let built: Promise<void> | null = null;

/** Build the producer fixtures once for every describe block in this file. */
const setup = (): Promise<void> => {
  built ??= (async () => {
    root = await realpath(
      await mkdtemp(join(tmpdir(), "rea-android-reports-")),
    );
    fixtures = await buildAndroidFixtures(root);
  })();
  return built;
};

afterAll(async () => {
  if (root !== "") await removeTestWorkspace(root);
});

const suite = describe.skipIf(ANDROID_TOOLS === null);

suite("DEX header and bare DEX files", () => {
  beforeAll(setup, 180_000);

  it("recomputes the checksum and signature and refuses what Android would refuse", async () => {
    const original = await readFile(fixtures.dex);
    const dex = DexFile.parse(original);
    expect(dex.header.magic_version).toBe("037");
    expect(dex.header.checksum).toBe(dex.header.computed_checksum);
    expect(dex.header.signature).toBe(dex.header.computed_signature);
    expect(dex.problems).toEqual([]);
    expect(dex.map.at(-1)?.name).toBe("map_list");

    // One byte of the first code item changed: both digests disagree, the file is still read.
    const changed = Buffer.from(original);
    const code = dex.map.find((item) => item.name === "code_item")?.offset ?? 0;
    changed[code + 16] = (changed[code + 16] ?? 0) ^ 0xff;
    const tampered = DexFile.parse(changed);
    expect(tampered.problems.map((problem) => problem.offset)).toEqual([8, 12]);

    // endian_tag (offset 40) reversed.
    const reversed = Buffer.from(original);
    reversed.writeUInt32LE(0x78563412, 40);
    expect(() => DexFile.parse(reversed)).toThrow(/big-endian/u);

    // header_size (offset 36) set to 0x78, which only DEX 041 uses.
    const header = Buffer.from(original);
    header.writeUInt32LE(0x78, 36);
    expect(() => DexFile.parse(header)).toThrow(/header_size/u);

    // string_ids_size (offset 56) larger than the file can hold.
    const strings = Buffer.from(original);
    strings.writeUInt32LE(0x0fff_ffff, 56);
    expect(() => DexFile.parse(strings)).toThrow(DexFormatError);

    // map_off (offset 52) moved past the end: the map is reported missing, ids still read.
    const map = Buffer.from(original);
    map.writeUInt32LE(original.length + 64, 52);
    const unmapped = DexFile.parse(map);
    expect(unmapped.map).toEqual([]);
    expect(
      unmapped.problems.some((problem) => /map/u.test(problem.message)),
    ).toBe(true);
    expect(unmapped.classCount).toBe(dex.classCount);
  });

  it("reads a bare DEX and flags a name that suggests another kind", async () => {
    const report = await artifact({ path: fixtures.libraryDex, limit: 2 });
    expect(report.package).toEqual({
      kind: "dex",
      basis: "magic",
      name_conflict: null,
    });
    expect(report.dex_files).toHaveLength(1);
    expect(report.dex_files[0]).toMatchObject({
      entry: null,
      role: "code",
      read: "complete",
    });
    expect(report.page).toMatchObject({ start: 0, limit: 2, returned: 2 });
    expect(report.class_count).toBe(report.summary.classes);

    const renamed = join(root, "library.apk");
    await writeFile(renamed, await readFile(fixtures.libraryDex));
    const conflicted = await artifact({ path: renamed });
    expect(conflicted.package.name_conflict).toMatch(/suggests apk/u);
  });
});

suite("APK and App Bundle inventory", () => {
  beforeAll(setup, 180_000);

  it("reads a signed APK: manifest, resources, DEX order, ABIs and signature material", async () => {
    const report = await artifact({ path: fixtures.apk });
    const apk = report.apk;
    expect(report.package).toMatchObject({ kind: "apk", basis: "layout" });
    expect(apk?.manifest).toMatchObject({
      encoding: "binary-xml",
      error: null,
    });
    expect(apk?.manifest?.facts).toMatchObject({
      package_name: PACKAGE_NAME,
      version_code: VERSION_CODE,
      min_sdk: "24",
      target_sdk: "36",
    });
    expect(apk?.manifest?.facts?.application?.label).toBe("Oops Demo");
    const components = apk?.manifest?.facts?.components ?? [];
    expect(components.find((entry) => entry.kind === "service")).toMatchObject({
      class_name: "com.example.oops.SyncService",
      exported: false,
    });
    expect(apk?.manifest?.xml).toMatch(
      /android:name="android\.permission\.CAMERA"/u,
    );
    expect(apk?.resources?.packages[0]?.name).toBe(PACKAGE_NAME);
    expect(apk?.dex).toEqual(["classes.dex", "classes2.dex"]);
    expect(apk?.native_abis).toEqual(["arm64-v8a", "x86_64"]);
    expect(apk?.assets).toBe(1);
    expect(apk?.signing.jar_signers).toEqual([
      {
        signature_file: "META-INF/OOPS.SF",
        block_file: "META-INF/OOPS.RSA",
        block_type: "RSA",
      },
    ]);
    expect(
      apk?.signing.signing_block?.blocks.map((block) => block.name),
    ).toEqual(
      expect.arrayContaining([
        "APK Signature Scheme v2",
        "APK Signature Scheme v3",
      ]),
    );
    expect(apk?.signing.verified).toBe(false);
    expect(
      report.native_libraries.map((entry) => [
        entry.abi,
        entry.elf?.machine,
        entry.elf?.matches_abi,
      ]),
    ).toEqual([
      ["arm64-v8a", "aarch64", true],
      ["x86_64", "x86_64", true],
    ]);
    expect(report.diagnostics).toEqual([]);
    expect(report.coverage.map((entry) => [entry.facet, entry.state])).toEqual([
      ["identify", "complete"],
      ["inventory", "complete"],
      ["inspect", "complete"],
      ["reconstruct", "not_requested"],
    ]);
  });

  it("reads a bundle's modules, delivery and config, resolving feature references through the base", async () => {
    const report = await artifact({ path: fixtures.aab });
    expect(report.package.kind).toBe("aab");
    const [base, camera] = report.bundle?.modules ?? [];
    expect(base).toMatchObject({
      name: "base",
      dex: ["base/dex/classes.dex", "base/dex/classes2.dex"],
    });
    expect(base?.manifest?.encoding).toBe("proto-xml");
    expect(base?.metadata_files).toEqual(
      expect.arrayContaining(["base/assets.pb", "base/native.pb"]),
    );
    expect(camera?.manifest?.facts?.module).toMatchObject({
      title: "Camera",
      delivery: ["on-demand"],
      fusing_include: true,
    });
    expect(report.bundle?.config).not.toBeNull();
    expect(
      report.dex_files.map((entry) => [entry.entry, entry.module]),
    ).toEqual([
      ["base/dex/classes.dex", "base"],
      ["base/dex/classes2.dex", "base"],
      ["camera/dex/classes.dex", "camera"],
    ]);
    expect(report.diagnostics).toEqual([]);
  });
});

suite("APK sets and XAPK", () => {
  beforeAll(setup, 180_000);

  it("reads an APK set's table of contents and one chosen APK in full", async () => {
    const report = await artifact({ path: fixtures.apks });
    const set = report.apk_set;
    expect(set?.toc).not.toBeNull();
    expect(set?.missing).toEqual([]);
    expect(set?.undeclared).toEqual([]);
    expect(set?.conflicts).toEqual([]);
    expect(
      set?.apks.every((entry) => entry.manifest?.package_name === PACKAGE_NAME),
    ).toBe(true);
    const master = set?.apks.find(
      (entry) => entry.entry === "splits/base-master.apk",
    );
    expect(master).toMatchObject({
      kind: "split",
      module: "base",
      is_master: true,
    });
    expect(
      set?.apks
        .find((entry) => entry.entry === "splits/base-es.apk")
        ?.targeting.join(" "),
    ).toMatch(/es/u);
    expect(set?.base.state).toBe("multiple");

    const chosen = await artifact({
      path: fixtures.apks,
      container: "splits/base-master.apk",
    });
    expect(chosen.apk?.container).toBe("splits/base-master.apk");
    expect(chosen.apk?.manifest?.facts?.package_name).toBe(PACKAGE_NAME);
    expect(
      chosen.classes.every(
        (entry) => entry.container === "splits/base-master.apk",
      ),
    ).toBe(true);
  });

  it("reads APKPure's XAPK layout and keeps other layouts generic", async () => {
    const set = await readMembers(fixtures.apks);
    const manifest = {
      xapk_version: 2,
      package_name: PACKAGE_NAME,
      version_code: String(VERSION_CODE),
      split_apks: [
        { file: `${PACKAGE_NAME}.apk`, id: "base" },
        { file: "config.arm64_v8a.apk", id: "config.arm64_v8a" },
        { file: "config.es.apk", id: "config.es" },
      ],
      expansions: [
        {
          file: `Android/obb/${PACKAGE_NAME}/main.7.${PACKAGE_NAME}.obb`,
          install_location: "EXTERNAL_STORAGE",
          install_path: `Android/obb/${PACKAGE_NAME}/main.7.${PACKAGE_NAME}.obb`,
        },
      ],
    };
    const xapk = join(root, "app.xapk");
    // config.es.apk is declared but left out, so the gap must be reported.
    await writeZip(xapk, [
      ["manifest.json", Buffer.from(JSON.stringify(manifest))],
      [`${PACKAGE_NAME}.apk`, bytesOf(set, "splits/base-master.apk")],
      ["config.arm64_v8a.apk", bytesOf(set, "splits/base-arm64_v8a.apk")],
      [
        `Android/obb/${PACKAGE_NAME}/main.7.${PACKAGE_NAME}.obb`,
        Buffer.from("obb"),
      ],
    ]);
    const report = await artifact({ path: xapk });
    expect(report.package).toMatchObject({ kind: "xapk", basis: "layout" });
    expect(report.apk_set).toMatchObject({
      xapk_profile: "apkpure-v2",
      missing: ["config.es.apk"],
      undeclared: [],
      conflicts: [],
      base: { state: "single", entries: [`${PACKAGE_NAME}.apk`] },
    });
    expect(report.apk_set?.obb[0]?.declared_path).toMatch(/main\.7/u);
    expect(
      report.apk_set?.apks.map((entry) => [entry.entry, entry.kind]),
    ).toEqual([
      [`${PACKAGE_NAME}.apk`, "base"],
      ["config.arm64_v8a.apk", "config"],
    ]);

    const older = join(root, "older.xapk");
    await writeZip(older, [
      [
        "manifest.json",
        Buffer.from(
          JSON.stringify({
            ...manifest,
            xapk_version: 1,
            package_name: "other.app",
          }),
        ),
      ],
      [`${PACKAGE_NAME}.apk`, bytesOf(set, "splits/base-master.apk")],
    ]);
    const generic = await artifact({ path: older });
    expect(generic.apk_set?.xapk_profile).toBe("unknown");
    expect(generic.apk_set?.apks[0]?.kind).toBe("undeclared");
    expect(generic.apk_set?.conflicts.join(" ")).toMatch(/other\.app/u);
  });
});

suite("Damaged packages and budgets", () => {
  beforeAll(setup, 180_000);

  it("reports a library in the wrong ABI directory and a damaged signing block", async () => {
    const apk = await readMembers(fixtures.apk);
    const misplaced = join(root, "misplaced.apk");
    await writeZip(misplaced, [
      ["AndroidManifest.xml", bytesOf(apk, "AndroidManifest.xml")],
      ["classes.dex", bytesOf(apk, "classes.dex")],
      ["lib/x86/libnative.so", bytesOf(apk, "lib/arm64-v8a/libnative.so")],
    ]);
    const report = await artifact({ path: misplaced });
    expect(report.native_libraries[0]?.elf).toMatchObject({
      machine: "aarch64",
      matches_abi: false,
    });
    expect(
      report.diagnostics.some((entry) =>
        /not what ABI directory x86 names/u.test(entry.message),
      ),
    ).toBe(true);
    expect(report.apk?.signing.signing_block).toBeNull();

    // The block's leading size field (8 bytes at the block start) no longer matches the trailing one.
    const signed = Buffer.from(await readFile(fixtures.apk));
    const signedReport = await artifact({ path: fixtures.apk });
    const start = signedReport.apk?.signing.signing_block?.offset ?? 0;
    signed.writeUInt32LE(signed.readUInt32LE(start) + 8, start);
    const broken = join(root, "broken-block.apk");
    await writeFile(broken, signed);
    const damaged = await artifact({ path: broken });
    expect(damaged.apk?.signing.signing_block).toBeNull();
    expect(damaged.apk?.signing.signing_block_error).toMatch(
      /size fields disagree/u,
    );
  });

  it("keeps facts read before a spent budget and says how to continue", async () => {
    const starved = await artifact({
      path: fixtures.apk,
      max_decoded_bytes: 6000,
    });
    expect(
      starved.coverage.find((entry) => entry.facet === "inspect"),
    ).toMatchObject({
      state: "partial",
      continuation: "Raise max_decoded_bytes.",
    });
    expect(starved.dex_files.some((entry) => entry.read === "failed")).toBe(
      true,
    );
    const refused = await failure("inspectClass", {
      path: fixtures.apk,
      class: "org.oops.lib.Codes",
      max_decoded_bytes: 6000,
    });
    expect(refused.tag).toBe("AnalysisResourceConstraintError");
  });

  it("refuses files that are neither DEX nor a ZIP", async () => {
    const text = join(root, "notes.dex");
    await writeFile(text, "not a dex");
    expect((await failure("inspectArtifact", { path: text })).tag).toBe(
      "AnalysisUnsupportedTargetError",
    );
  });
});

suite("DEX class selection", () => {
  beforeAll(setup, 180_000);

  it("reads one class with values, annotations and exact descriptors", async () => {
    const report = await cls({
      path: fixtures.apk,
      class: "Lorg/oops/lib/Codes;",
    });
    expect(report.selection).toMatchObject({
      container: null,
      entry: "classes2.dex",
      basis: "only",
    });
    expect(report.class).toMatchObject({
      name: "org.oops.lib.Codes",
      superclass: "Ljava/lang/Object;",
      source_file: "Codes.java",
    });
    expect(report.class.access).toEqual(["PUBLIC", "FINAL"]);
    expect(
      report.class.static_fields.map((field) => [field.name, field.value]),
    ).toEqual([
      ["NAME", '"codes"'],
      ["calls", null],
    ]);
    const mix = report.class.virtual_methods.find(
      (entry) => entry.name === "mix",
    );
    expect(mix).toMatchObject({ descriptor: "(IF)D" });
    expect(mix?.code).toMatchObject({ tries: 1 });
    expect(mix?.parameters.map((entry) => entry.type)).toEqual(["I", "F"]);
  });

  it("never chooses silently between byte-different definitions", async () => {
    const dex = await readFile(fixtures.libraryDex);
    const other = Buffer.from(dex);
    // DEX version digits 037 -> 035: same classes, different bytes (and a checksum problem).
    other.write("035", 4, "latin1");
    const twice = join(root, "twice.zip");
    await writeZip(twice, [
      ["classes.dex", dex],
      ["classes2.dex", other],
    ]);
    const refused = await failure("inspectClass", {
      path: twice,
      class: "org.oops.lib.Codes",
    });
    expect(refused.tag).toBe("AnalysisInputError");
    expect(refused.message).toMatch(
      /2 different DEX files .*classes\.dex.*classes2\.dex/u,
    );
    const picked = await cls({
      path: twice,
      class: "org.oops.lib.Codes",
      entry: "classes2.dex",
    });
    expect(picked.selection).toMatchObject({
      basis: "entry",
      entry: "classes2.dex",
    });
    expect(picked.selection.definitions).toHaveLength(2);

    const identical = await cls({
      path: fixtures.apks,
      class: "com.example.oops.MainActivity",
    });
    expect(identical.selection.basis).toBe("identical");
    expect(identical.selection.definitions.length).toBeGreaterThan(1);
  });

  it("refuses selections that do not name exactly one DEX, class or method", async () => {
    expect(
      (
        await failure("inspectClass", {
          path: fixtures.apk,
          class: "a.B",
          container: "x.apk",
        })
      ).message,
    ).toMatch(/container names an APK inside an \.apks or \.xapk set/u);
    expect(
      (
        await failure("inspectClass", {
          path: fixtures.apk,
          class: "a.B",
          entry: "nope.dex",
        })
      ).message,
    ).toMatch(/DEX members: classes\.dex, classes2\.dex/u);
    expect(
      (
        await failure("inspectClass", {
          path: fixtures.apk,
          class: "a.Missing",
        })
      ).message,
    ).toMatch(/No DEX of the 2 searched defines La\/Missing;/u);
    expect(
      (
        await failure("inspectClass", {
          path: fixtures.dex,
          class: "a.B",
          entry: "x",
        })
      ).message,
    ).toMatch(/bare DEX file has no members/u);
    const overloaded = await failure("inspectMethod", {
      path: fixtures.libraryDex,
      class: "org.oops.lib.Codes",
      method: "pick",
    });
    expect(overloaded.message).toMatch(
      /overloaded; give descriptor, one of: \(I\)I, \(Ljava\/lang\/String;\)I/u,
    );
    const exact = await method({
      path: fixtures.libraryDex,
      class: "org.oops.lib.Codes",
      method: "pick",
      descriptor: "(Ljava/lang/String;)I",
    });
    expect(exact.method.descriptor).toBe("(Ljava/lang/String;)I");
  });
});

suite("DEX method decoding", () => {
  beforeAll(setup, 180_000);

  it("decodes a method with its switch table, handlers, lines and references", async () => {
    const classify = await method({
      path: fixtures.libraryDex,
      class: "org.oops.lib.Codes",
      method: "classify",
    });
    expect(classify.instructions[0]).toMatchObject({
      mnemonic: "packed-switch",
      line: 8,
    });
    expect(
      classify.instructions[0]?.switch_targets?.map((entry) => entry.key),
    ).toEqual([0, 1, 2, 3]);
    expect(classify.instructions.at(-1)?.mnemonic).toBe("packed-switch-data");
    const first = classify.instructions[0];
    expect(first?.offset).toBe((classify.method.code?.offset ?? 0) + 16);

    const mix = await method({
      path: fixtures.libraryDex,
      class: "org.oops.lib.Codes",
      method: "mix",
    });
    expect(mix.tries[0]?.handlers[0]?.type).toBe(
      "Ljava/lang/ArithmeticException;",
    );
    expect(mix.locals.find((entry) => entry.name === "this")?.type).toBe(
      "Lorg/oops/lib/Codes;",
    );
    expect(
      mix.references.field_accesses.map((entry) => [
        entry.access,
        entry.reference.text,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ["read", "Lorg/oops/lib/Codes;.calls:I"],
        ["write", "Lorg/oops/lib/Codes;.calls:I"],
      ]),
    );

    const paged = await method({
      path: fixtures.libraryDex,
      class: "org.oops.lib.Codes",
      method: "mix",
      start: 2,
      limit: 3,
    });
    expect(paged.instructions.map((entry) => entry.index)).toEqual([2, 3, 4]);
    expect(paged.references).toEqual(mix.references);

    const annotation = await method({
      path: fixtures.libraryDex,
      class: "com.android.tools.r8.annotations.LambdaMethod",
      method: "holder",
    });
    expect(annotation.method.code).toBeNull();
    expect(annotation.instruction_count).toBe(0);
  });
});
