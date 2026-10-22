import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Ajv2020 } from "ajv/dist/2020.js";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import {
  androidArtifactReportSchema,
  dexClassReportSchema,
  dexDecompilationSchema,
  dexMethodReportSchema,
} from "../../../src/domain/android/androidArtifact.js";
import { resolveDex2jar } from "../../../src/androidPackage/dex2jar.js";
import { resolveVineflower } from "../../../src/jvm/vineflower.js";
import {
  ANDROID_TOOLS,
  buildAndroidFixtures,
  PACKAGE_NAME,
  VERSION_CODE,
} from "../../fixtures/androidProducers.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest, type TestCli } from "../../support/cli/cliFixture.js";

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

type AndroidTool =
  | "inspect_android_artifact"
  | "inspect_dex_class"
  | "inspect_dex_method"
  | "decompile_dex_class";

/** Reconstruction needs the host's admitted dex2jar and Vineflower. */
const DECOMPILERS = await Promise.all([
  resolveVineflower(),
  resolveDex2jar(),
]).then(
  () => true,
  () => false,
);

type Listed = Awaited<ReturnType<Client["listTools"]>>["tools"];

/** CLI and MCP must return the same Evidence for the same request. */
const comparer =
  (client: Client, tools: Listed, cli: TestCli) =>
  async (
    name: AndroidTool,
    cliArguments: string[],
    mcpArguments: Record<string, unknown>,
  ) => {
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    const contract = toolContract(name);
    const advertised = tools.find((tool) => tool.name === name);
    if (advertised?.outputSchema === undefined)
      throw new Error(`${name} must publish both schemas`);
    const inputSchema: Record<string, unknown> = advertised.inputSchema;
    const outputSchema: Record<string, unknown> = advertised.outputSchema;
    expect(ajv.validateSchema(inputSchema)).toBe(true);
    expect(ajv.validateSchema(outputSchema)).toBe(true);
    const result = await cli.run({ arguments: [...cliArguments, "--json"] });
    expect(result.exitCode, cliArguments.join(" ")).toBe(0);
    const evidence = contract.outputSchema.parse(result.json);
    const response = await client.callTool({ name, arguments: mcpArguments });
    expect(response.isError, name).not.toBe(true);
    expect(
      ajv.validate(outputSchema, response.structuredContent),
      JSON.stringify(ajv.errors),
    ).toBe(true);
    const mcp = contract.outputSchema.parse(response.structuredContent);
    expect(mcp.evidence_id).toBe(evidence.evidence_id);
    expect(mcp.normalized_result).toEqual(evidence.normalized_result);
    return mcp;
  };

/** dex2jar + Vineflower reconstruction of one APK class through both adapters. */
const checkDecompile = async (
  both: ReturnType<typeof comparer>,
  apk: string,
) => {
  const decompiled = await both(
    "decompile_dex_class",
    ["decompile-dex-class", apk, "com.example.oops.DataProvider"],
    { path: apk, class: "com.example.oops.DataProvider" },
  );
  expect(decompiled.confidence).toBe("inferred");
  const provider = dexDecompilationSchema.parse(decompiled.normalized_result);
  expect(provider.selection.entry).toBe("classes.dex");
  expect(provider.source.derived_from).toEqual([provider.selection.dex_sha256]);
  expect(provider.checks.map((check) => [check.id, check.state])).toEqual([
    ["dex2jar_translated", "passed"],
    ["vineflower_clean", "passed"],
    ["methods_present", "not_checked"],
  ]);
  expect(provider.coverage[0]?.state).toBe("partial");
};

cliTest.skipIf(ANDROID_TOOLS === null)(
  "reads d8/aapt2/bundletool-built DEX, APK, bundle and APK set through the compiled CLI and real stdio MCP with identical evidence",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-android-acceptance-");
    const fixtures = await buildAndroidFixtures(root);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("scripts/rea.mjs"), "mcp"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "", REA_LOG_LEVEL: "silent" },
      stderr: "pipe",
    });
    const client = new Client({ name: "android-acceptance", version: "1" });
    try {
      await client.connect(transport);
      const both = comparer(client, (await client.listTools()).tools, cli);

      const apkEvidence = await both(
        "inspect_android_artifact",
        ["inspect-android-artifact", fixtures.apk],
        { path: fixtures.apk },
      );
      expect(apkEvidence.subject?.digest.sha256).toBe(
        sha256(await readFile(fixtures.apk)),
      );
      const apk = androidArtifactReportSchema.parse(
        apkEvidence.normalized_result,
      );
      expect(apk.package).toMatchObject({ kind: "apk", basis: "layout" });
      expect(apk.apk?.manifest?.facts).toMatchObject({
        package_name: PACKAGE_NAME,
        version_code: VERSION_CODE,
      });
      expect(apk.apk?.dex).toEqual(["classes.dex", "classes2.dex"]);
      expect(
        apk.apk?.signing.signing_block?.blocks.map((block) => block.name),
      ).toEqual(
        expect.arrayContaining([
          "APK Signature Scheme v2",
          "APK Signature Scheme v3",
        ]),
      );
      expect(
        apk.native_libraries.every(
          (library) => library.elf?.matches_abi === true,
        ),
      ).toBe(true);

      const bundleEvidence = await both(
        "inspect_android_artifact",
        ["inspect-android-artifact", fixtures.aab, "--limit", "2"],
        { path: fixtures.aab, limit: 2 },
      );
      const bundle = androidArtifactReportSchema.parse(
        bundleEvidence.normalized_result,
      );
      expect(bundle.package.kind).toBe("aab");
      expect(bundle.bundle?.modules.map((module) => module.name)).toEqual([
        "base",
        "camera",
      ]);
      expect(
        bundle.bundle?.modules.find((module) => module.name === "camera")
          ?.manifest?.facts?.module?.delivery,
      ).toEqual(["on-demand"]);
      expect(bundle.page).toMatchObject({ start: 0, limit: 2, returned: 2 });

      const setEvidence = await both(
        "inspect_android_artifact",
        [
          "inspect-android-artifact",
          fixtures.apks,
          "--container",
          "splits/base-master.apk",
        ],
        { path: fixtures.apks, container: "splits/base-master.apk" },
      );
      const set = androidArtifactReportSchema.parse(
        setEvidence.normalized_result,
      );
      expect(set.package.kind).toBe("apks");
      expect(set.apk?.container).toBe("splits/base-master.apk");
      expect(set.apk_set?.missing).toEqual([]);
      expect(set.apk_set?.base.state).toBe("multiple");
      expect(
        set.classes.every(
          (entry) => entry.container === "splits/base-master.apk",
        ),
      ).toBe(true);

      const classEvidence = await both(
        "inspect_dex_class",
        ["inspect-dex-class", fixtures.apk, "org.oops.lib.Codes"],
        { path: fixtures.apk, class: "org.oops.lib.Codes" },
      );
      const codes = dexClassReportSchema.parse(classEvidence.normalized_result);
      expect(codes.selection).toMatchObject({
        entry: "classes2.dex",
        basis: "only",
      });
      expect(
        codes.class.static_fields.find((field) => field.name === "NAME")?.value,
      ).toBe('"codes"');

      const methodEvidence = await both(
        "inspect_dex_method",
        [
          "inspect-dex-method",
          fixtures.libraryDex,
          "Lorg/oops/lib/Codes;",
          "classify",
          "--limit",
          "2",
        ],
        {
          path: fixtures.libraryDex,
          class: "Lorg/oops/lib/Codes;",
          method: "classify",
          limit: 2,
        },
      );
      const classify = dexMethodReportSchema.parse(
        methodEvidence.normalized_result,
      );
      expect(classify.selection.basis).toBe("file");
      expect(classify.instructions[0]).toMatchObject({
        mnemonic: "packed-switch",
      });
      expect(
        classify.instructions[0]?.switch_targets?.map((entry) => entry.key),
      ).toEqual([0, 1, 2, 3]);
      expect(classify.page).toMatchObject({ returned: 2, next: 2 });

      if (DECOMPILERS) await checkDecompile(both, fixtures.apk);
    } finally {
      await client.close();
    }
  },
  240_000,
);
