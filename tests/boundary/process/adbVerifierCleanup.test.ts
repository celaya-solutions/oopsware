import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const runVerifier = async (
  settings: { closeFails?: boolean; thrown?: "undefined" | "null" } = {},
) => {
  const root = await mkdtemp(join(tmpdir(), "rea-adb-verifier-test-"));
  roots.push(root);
  await mkdir(join(root, "scripts", "lib"), { recursive: true });
  await mkdir(join(root, "dist", "application", "adb"), { recursive: true });
  await mkdir(join(root, "dist", "composition"), { recursive: true });
  await writeFile(
    join(root, "scripts", "verify-adb.mjs"),
    await readFile(new URL("../../../scripts/verify-adb.mjs", import.meta.url)),
  );
  await writeFile(
    join(root, "scripts", "lib", "verifier-cleanup.mjs"),
    await readFile(
      new URL("../../../scripts/lib/verifier-cleanup.mjs", import.meta.url),
    ),
  );
  await writeFile(
    join(root, "dist", "composition", "adb.js"),
    `import { writeFile } from "node:fs/promises";
export const createAdbDeviceAnalysisProvider = () => ({
  async close() {
    await writeFile(process.env.REA_ADB_CLOSE_MARKER, "closed");
    if (process.env.REA_ADB_CLOSE_FAIL === "1") {
      const error = new Error("provider cleanup refused");
      error.cleanupResources = ["fixture/private-root"];
      error.diagnostics = { reason: "retry remains possible" };
      throw error;
    }
  },
});\n`,
  );
  await writeFile(
    join(root, "dist", "application", "adb", "AdbDeviceAnalysisService.js"),
    `export class AdbDeviceAnalysisService {
  async execute(operation, input) {
    if (process.env.REA_ADB_THROW === "undefined") throw undefined;
    if (process.env.REA_ADB_THROW === "null") throw null;
    const result = {
      inspect_adb_client: { client: { version: "1", binary_path: "/tmp/adb" } },
      list_adb_devices: { devices: [{ serial: "test", state: "device", kind: "emulator", kind_basis: "stub" }] },
      inspect_adb_device: { properties: [{ name: "ro.build.version.sdk", value: "35" }], emulator_observed: true },
      list_adb_processes: { processes: [{ name: "probe" }], columns: "pid name" },
      inspect_adb_window: { focused_window: null },
      inspect_adb_display: { physical_size: { width: 2, height: 2 }, physical_density: 1 },
      read_adb_setting: { value: "1" },
      read_adb_logcat: { lines: [], coverage: "complete" },
      list_adb_features: { features: ["feature"], coverage: "complete" },
      list_adb_services: { services: ["service"], coverage: "complete" },
      list_adb_directory: { entries: [], coverage: "complete" },
      list_adb_packages: { packages: input.scope === "all" ? [{ package_name: "com.test" }] : [], coverage: "complete" },
      push_adb_file: { bytes: 3, sha256: "${"a".repeat(64)}", device_sha256: "${"a".repeat(64)}", device_digest_source: "device_sha256sum" },
      pull_adb_file: { bytes: 3, sha256: "${"a".repeat(64)}" },
      capture_adb_screen: { width: 2, height: 2, bytes: 3 },
    }[operation];
    return { ok: true, value: { normalized_result: result } };
  }
}\n`,
  );
  const marker = join(root, "provider-closed");
  const run = spawnSync(
    process.execPath,
    [join(root, "scripts", "verify-adb.mjs")],
    {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        REA_ADB_CLOSE_MARKER: marker,
        REA_ADB_CLOSE_FAIL: settings.closeFails ? "1" : "0",
        ...(settings.thrown === undefined
          ? {}
          : { REA_ADB_THROW: settings.thrown }),
      },
    },
  );
  const closed = await readFile(marker, "utf8").catch(() => null);
  return { ...run, closed };
};

it("runs the production verifier successfully and closes its provider", async () => {
  const result = await runVerifier();

  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(result.stdout).toContain("all adb device checks passed");
  expect(result.closed).toBe("closed");
});

it("makes provider cleanup failure fail the production verifier with resource details", async () => {
  const result = await runVerifier({ closeFails: true });

  expect(result.status).toBe(1);
  expect(result.stderr).toContain("provider cleanup refused");
  expect(result.stderr).toContain("fixture/private-root");
  expect(result.stderr).toContain("retry remains possible");
  expect(result.closed).toBe("closed");
});

it.each(["undefined", "null"] as const)(
  "closes after the verifier throws %s and exits unsuccessfully",
  async (thrown) => {
    const result = await runVerifier({ thrown });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`verifier aborted — ${thrown}`);
    expect(result.closed).toBe("closed");
  },
);

it("reports both an unexpected verifier throw and provider cleanup failure", async () => {
  const result = await runVerifier({ closeFails: true, thrown: "null" });

  expect(result.status).toBe(1);
  expect(result.stderr).toContain("verifier aborted — null");
  expect(result.stderr).toContain("provider cleanup refused");
  expect(result.stderr).toContain("fixture/private-root");
  expect(result.closed).toBe("closed");
});
