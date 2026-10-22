import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect } from "vitest";
import { z } from "zod";

import { thinMach } from "../../../src/domain/binaryTarget.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const environment = {
  REA_LOG_LEVEL: "silent",
  REA_ANALYSIS_PROVIDER: "auto",
} as const;

const capturedDiagnostic = (value: unknown): string => {
  const { stdout, stderr } = z
    .object({
      details: z.object({
        captured_output: z.object({ stdout: z.string(), stderr: z.string() }),
      }),
    })
    .parse(value).details.captured_output;
  return `${stdout}\n${stderr}`;
};

/** An app bundle whose Contents holds a directory and a non-plist file. */
const fixtureApp = async () => {
  const app = join(await createTestTempDirectory("rea-plist-fail-"), "A.app");
  const contents = join(app, "Contents");
  await mkdir(join(contents, "MacOS"), { recursive: true });
  await mkdir(join(contents, "Folder.plist"));
  await writeFile(join(contents, "MacOS/App"), thinMach(0xfeedfacf, 0x100000c));
  await writeFile(
    join(contents, "Info.plist"),
    "<plist><dict><key>CFBundleExecutable</key><string>App</string></dict></plist>",
  );
  await writeFile(join(contents, "Text.plist"), "not a property list\n");
  return app;
};

describe.skipIf(process.platform !== "darwin")(
  "native plist CLI selection failures",
  () => {
    cliTest.for([
      ["Contents/Missing.plist", "no file exists there."],
      ["Contents/Folder.plist", "it is not a regular file."],
      ["Contents/Text.plist", "plutil could not decode it as a property list"],
    ] as const)(
      "reports why the selected %s cannot be inspected",
      async ([selected, reason], { cli }) => {
        const app = await fixtureApp();
        const result = await cli.run({
          arguments: [
            "inspect-plist",
            app,
            "--relative-path",
            selected,
            "--json",
          ],
          environment,
        });
        expect(result.exitCode).toBe(1);
        expect(result.json).toMatchObject({
          code: "invalid_request",
          details: {
            operation: "inspect_plist",
            issues: [
              {
                path: ["path"],
                reason: "invalid_value",
                message: expect.stringContaining(
                  `Cannot inspect ${join(app, selected)}: ${reason}`,
                ),
              },
            ],
          },
        });
      },
    );

    // Root bypasses file modes, so the denial is only observable otherwise.
    cliTest.skipIf(process.getuid?.() === 0)(
      "reports a permission denial instead of a malformed plist",
      async ({ cli, onTestFinished }) => {
        const app = await fixtureApp();
        const locked = join(app, "Contents/Locked.plist");
        await writeFile(locked, "<plist><dict/></plist>");
        await chmod(locked, 0o000);
        onTestFinished(async () => {
          await chmod(locked, 0o600);
        });
        const result = await cli.run({
          arguments: [
            "inspect-plist",
            app,
            "--relative-path",
            "Contents/Locked.plist",
            "--json",
          ],
          environment,
        });
        expect(result.exitCode).toBe(1);
        expect(result.json).toMatchObject({
          code: "access_denied",
          details: {
            path: locked,
            reason: "permission denied while reading plist (EACCES)",
            system_code: "EACCES",
          },
        });
      },
    );

    cliTest(
      "reports a missing default Info.plist as unavailable for the target",
      async ({ cli }) => {
        const directory = await createTestTempDirectory("rea-plist-bare-");
        const program = join(directory, "tool");
        await writeFile(program, thinMach(0xfeedfacf, 0x100000c));
        const result = await cli.run({
          arguments: ["inspect-plist", program, "--json"],
          environment,
        });
        expect(result.exitCode).toBe(1);
        expect(result.json).toMatchObject({
          code: "capability_unavailable",
          message: expect.stringContaining("(CLI: --relative-path)"),
          remediation: {
            action: expect.stringContaining(
              "Select another plist in the target with the path input (CLI: --relative-path).",
            ),
          },
          details: {
            operation: "inspect_plist",
            reason: expect.stringContaining(
              `no readable default plist at ${join(directory, "Contents/Info.plist")}: no file exists there.`,
            ),
          },
        });
      },
    );
  },
);

describe.skipIf(process.platform !== "darwin")(
  "native plist CLI decode diagnostics",
  () => {
    cliTest.for([
      "not a property list",
      "<plist><dict><key>value</key><integer> 42 </integer></dict></plist>",
      "<plist><dict><key>value</key><true>x</true></dict></plist>",
    ])(
      "preserves native decode diagnostics for %s",
      async (source, { cli }) => {
        const app = await fixtureApp();
        const malformed = join(app, "Contents/Broken.plist");
        await writeFile(malformed, source);
        const selected = await cli.run({
          arguments: [
            "inspect-plist",
            app,
            "--relative-path",
            "Contents/Broken.plist",
            "--json",
          ],
          environment,
        });
        expect(selected.exitCode).toBe(1);
        expect(selected.json).toMatchObject({
          code: "invalid_request",
          details: {
            issues: [
              { message: expect.stringContaining("Property List error:") },
            ],
            captured_output: { exit_code: 1 },
          },
        });
        expect(capturedDiagnostic(selected.json)).toContain(
          "Property List error:",
        );
        const directory = await createTestTempDirectory(
          "rea-plist-default-diagnostic-",
        );
        const program = join(directory, "program");
        await writeFile(program, thinMach(0xfeedfacf, 0x100000c));
        await mkdir(join(directory, "Contents"));
        const defaultPlist = join(directory, "Contents/Info.plist");
        await writeFile(defaultPlist, source);
        const fallback = await cli.run({
          arguments: ["inspect-plist", program, "--json"],
          environment,
        });
        expect(fallback.exitCode).toBe(1);
        expect(fallback.json).toMatchObject({
          code: "capability_unavailable",
          details: {
            reason: expect.stringContaining("Property List error:"),
            captured_output: { exit_code: 1 },
          },
        });
        expect(capturedDiagnostic(fallback.json)).toContain(
          "Property List error:",
        );
        expect(await readFile(malformed, "utf8")).toBe(source);
        expect(await readFile(defaultPlist, "utf8")).toBe(source);
      },
    );
  },
);

describe.skipIf(process.platform !== "darwin")(
  "native plist CLI direct target selection",
  () => {
    cliTest.for([
      "<plist><dict><key>value</key><integer> 42 </integer></dict></plist>",
      "<plist><dict><key>value</key><true>x</true></dict></plist>",
    ])(
      "classifies the selected malformed plist as input: %s",
      async (source, { cli }) => {
        const root = await createTestTempDirectory("rea-plist-target-input-");
        const path = join(root, "chosen.plist");
        await writeFile(path, source);
        for (const args of [[], ["--relative-path", path]]) {
          const result = await cli.run({
            arguments: ["inspect-plist", path, ...args, "--json"],
            environment,
          });
          expect(result.exitCode).toBe(1);
          expect(result.json).toMatchObject({
            code: "invalid_request",
            details: {
              issues: [
                {
                  path: ["path"],
                  message: expect.stringContaining("Property List error:"),
                },
              ],
              captured_output: { exit_code: 1 },
            },
          });
          expect(capturedDiagnostic(result.json)).toContain(
            "Property List error:",
          );
        }
        expect(await readFile(path, "utf8")).toBe(source);
      },
    );
  },
);
