import { afterEach, expect, it, onTestFinished, vi } from "vitest";

import { ApktoolProvider } from "../../src/apktool/ApktoolProvider.js";
import { runOwnedCommand } from "../../src/process/OwnedCommand.js";
import type { ProviderProcessSnapshot } from "../../src/process/ProviderProcess.js";

vi.mock("../../src/process/OwnedCommand.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../src/process/OwnedCommand.js")
  >()),
  runOwnedCommand: vi.fn(
    async () =>
      ({
        stdout: { text: "2.7.0-stub\n" },
        stderr: { text: "" },
      }) as unknown as ProviderProcessSnapshot,
  ),
}));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(runOwnedCommand).mockClear();
});
const lastSpawn = () => vi.mocked(runOwnedCommand).mock.lastCall?.[0];

it.skipIf(process.platform === "win32")(
  "keeps an explicit environment's PATH choice and samples ambient inheritance per operation",
  async () => {
    vi.stubEnv("REA_APKTOOL_COMMAND", "/ambient/initial-apktool");
    vi.stubEnv("REA_APKTOOL_TEST_INHERITED_VALUE", "initial");
    const provider = new ApktoolProvider({ environment: {} });
    onTestFinished(() => provider.close());
    vi.stubEnv("REA_APKTOOL_COMMAND", "/ambient/changed-apktool");
    vi.stubEnv("REA_APKTOOL_TEST_INHERITED_VALUE", "changed");
    await provider.inspectAvailability();
    expect(lastSpawn()?.command).toBe("apktool");
    expect(lastSpawn()?.hostEnvironment).toMatchObject({
      REA_APKTOOL_COMMAND: undefined,
      REA_APKTOOL_TEST_INHERITED_VALUE: "changed",
    });
    vi.stubEnv("REA_APKTOOL_TEST_INHERITED_VALUE", undefined);
    await provider.inspectAvailability();
    expect(
      lastSpawn()?.hostEnvironment?.REA_APKTOOL_TEST_INHERITED_VALUE,
    ).toBeUndefined();
  },
);

it.skipIf(process.platform === "win32")(
  "inherits the current default launcher when no environment was selected",
  async () => {
    vi.stubEnv("REA_APKTOOL_COMMAND", "/ambient/initial-apktool");
    const provider = new ApktoolProvider();
    onTestFinished(() => provider.close());
    vi.stubEnv("REA_APKTOOL_COMMAND", "/ambient/later-apktool");
    await provider.inspectAvailability();
    expect(lastSpawn()?.command).toBe("/ambient/later-apktool");
  },
);
