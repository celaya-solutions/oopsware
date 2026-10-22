import { expect, it } from "vitest";
import { Cli } from "incur";
import pino from "pino";

import type { ApktoolResourceAnalysisPort } from "../../../src/application/apktool/ApktoolResourceAnalysisPort.js";
import { createAnalysisExecution } from "../../../src/application/AnalysisProvider.js";
import { registerApktoolCommands } from "../../../src/cli/apktoolCommands.js";
import { presentOmittableDefaults } from "../../../src/cli/omittableDefaults.js";
import type { ApktoolRequest } from "../../../src/domain/apktool/apktoolResourceAnalysis.js";
import { ok } from "../../../src/domain/result.js";

const invoke = async (argv: readonly string[]) => {
  const requests: ApktoolRequest[] = [];
  const provider: ApktoolResourceAnalysisPort = {
    async inspectAvailability() {
      throw new Error("unexpected provider probe");
    },
    async close() {},
    async execute(request) {
      requests.push(request);
      return ok(
        createAnalysisExecution(
          { strings: [] },
          { id: "apktool", name: "Apktool", version: null },
        ),
      );
    },
  };
  const cli = Cli.create("rea", { sync: false });
  registerApktoolCommands(cli, pino({ level: "silent" }), {}, provider);
  presentOmittableDefaults(cli);

  let stdout = "";
  let exitCode = 0;
  await cli.serve([...argv], {
    env: {},
    exit: (code) => {
      exitCode = code;
    },
    stdout: (text) => {
      stdout += text;
    },
  });
  return { exitCode, stdout, requests };
};

/**
 * Locales the apktool input owner admits. The owner's own rejection message
 * advertises `b+zh+Hans+CN`, so the CLI cannot be narrower than this list
 * without refusing a caller-selected locale the decoding lane supports.
 */
const OWNER_ADMITTED_LOCALES = [
  "de",
  "pt-BR",
  "pt-rBR",
  "zh-rCN",
  "en-419",
  "es-419",
  "en-001",
  "ar-015",
  "b+zh+Hans+CN",
  "b+sr+Latn+RS+REVISED",
  "b+fil+Latn+419+ABCDEFGH",
] as const;

it("forwards the table-only string choice through the CLI", async () => {
  const result = await invoke([
    "decode-android-resources",
    "/targets/app.apk",
    "--string-tables-only",
    "--locales",
    "de",
    "--json",
  ]);
  expect(result.exitCode, result.stdout).toBe(0);
  expect(result.requests).toEqual([
    {
      operation: "decode_android_resources",
      input: {
        path: "/targets/app.apk",
        include_strings: true,
        locales: ["de"],
        string_tables_only: true,
      },
    },
  ]);
});

it("forwards every locale the apktool input owner admits", async () => {
  for (const locale of OWNER_ADMITTED_LOCALES) {
    const result = await invoke([
      "decode-android-resources",
      "/targets/app.apk",
      "--locale",
      locale,
      "--json",
    ]);

    expect(result.exitCode, `exit code for locale ${locale}`).toBe(0);
    expect(result.requests, `request for locale ${locale}`).toEqual([
      {
        operation: "decode_android_resources",
        input: { path: "/targets/app.apk", include_strings: true, locale },
      },
    ]);
  }
});

it("forwards repeated --locales to project multiple localized tables", async () => {
  const result = await invoke([
    "decode-android-resources",
    "/targets/app.apk",
    "--locales",
    "de",
    "--locales",
    "pt-BR",
    "--json",
  ]);

  expect(result.exitCode).toBe(0);
  expect(result.requests).toEqual([
    {
      operation: "decode_android_resources",
      input: {
        path: "/targets/app.apk",
        include_strings: true,
        locales: ["de", "pt-BR"],
      },
    },
  ]);
});

it.each(["not a locale", "en-r419", "es-r419"])(
  "refuses the invalid locale %s before invoking Apktool",
  async (locale) => {
    const result = await invoke([
      "decode-android-resources",
      "/targets/app.apk",
      "--locale",
      locale,
      "--json",
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.requests).toEqual([]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: "VALIDATION_ERROR",
      fieldErrors: [expect.objectContaining({ path: "locale" })],
    });
  },
);

it("forwards --no-strings with --locale preserving caller options", async () => {
  const result = await invoke([
    "decode-android-resources",
    "/targets/app.apk",
    "--no-strings",
    "--locale",
    "de",
    "--json",
  ]);

  expect(result.exitCode).toBe(0);
  expect(result.requests).toEqual([
    {
      operation: "decode_android_resources",
      input: {
        path: "/targets/app.apk",
        include_strings: false,
        locale: "de",
      },
    },
  ]);
});
