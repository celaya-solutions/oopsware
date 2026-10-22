import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { PRODUCT_IDENTITY } from "../../src/identity.js";

const jsonExamples = (content: string): unknown[] =>
  [...content.matchAll(/```json\s*([\s\S]*?)```/gu)].map((match): unknown =>
    JSON.parse(match[1] ?? ""),
  );

describe("onboarding documentation product facts", () => {
  it.each([
    ["docs/native-investigation.md", "raw-binary.md#nmos-6502"],
    ["docs/ghidra-riscv.md", "raw-binary.md"],
  ])(
    "routes raw admission guidance in %s to the owning guide",
    async (path, target) => {
      const content = await readFile(resolve(path), "utf8");
      const links = [...content.matchAll(/\]\(([^)\s]+)\)/gu)].map(
        (match) => match[1],
      );
      expect(links, path).toContain(target);
    },
  );

  it("keeps the installation MCP example aligned with the package registration command", async () => {
    const content = await readFile(resolve("docs/installation.md"), "utf8");
    expect(jsonExamples(content)).toContainEqual(
      expect.objectContaining({
        mcpServers: expect.objectContaining({
          rea: expect.objectContaining({
            command: "npx",
            args: ["-y", PRODUCT_IDENTITY.registrationPackageSpecifier, "mcp"],
          }),
        }),
      }),
    );
  });
});
