import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { lstat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";

import { ArtifactProvider } from "../../../src/artifacts/ArtifactProvider.js";
import { classifyAndHashRoot } from "../../fixtures/artifactInventory.js";
import { asarHeaderBytes } from "../../fixtures/asarHeader.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const injected = vi.hoisted(() => ({
  opened: undefined as
    | ((path: unknown, handle: FileHandle) => void)
    | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      injected.opened?.(args[0], handle);
      return handle;
    },
  };
});

it.each([false, true])(
  "preserves root admission failure and close authority (invalidated=%s)",
  async (invalidated) => {
    const root = await createTestTempDirectory("rea-root-admission-cleanup-");
    const path = join(root, "payload.bin");
    await writeFile(path, "selected bytes");
    const client = new ArtifactProvider({}).createClient({
      path,
      sourcePath: path,
      sha256: "0".repeat(64),
      kind: "artifact",
      format: "javascript",
    });
    let descriptor: FileHandle | undefined;
    let closeAttempts = 0;
    let blocked = true;
    injected.opened = (openedPath, handle) => {
      if (openedPath !== path || descriptor !== undefined) return;
      descriptor = handle;
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "stat").mockRejectedValueOnce(
        Object.assign(new Error("primary admission stat failure"), {
          code: "EIO",
          errno: -5,
          syscall: "fstat",
        }),
      );
      vi.spyOn(handle, "close").mockImplementation(async () => {
        closeAttempts += 1;
        if (invalidated) await close();
        if (blocked) throw new Error("descriptor cleanup outcome unavailable");
        await close();
      });
    };
    onTestFinished(async () => {
      injected.opened = undefined;
      blocked = false;
      await client.close();
      vi.restoreAllMocks();
    });

    const inventory = await client.execute("inventory_artifact", {});
    expect(inventory).toMatchObject({
      ok: false,
      error: {
        reason: "io",
        detail: expect.stringContaining("primary admission stat failure"),
        cleanup: {
          resources: [expect.stringContaining(path)],
          reason: "descriptor cleanup outcome unavailable",
        },
      },
    });
    expect(descriptor).toBeDefined();
    expect((await client.close()).ok).toBe(false);
    const attemptsBeforeRecovery = closeAttempts;
    blocked = false;
    const recovery = await client.close();
    expect(recovery.ok).toBe(!invalidated);
    expect(closeAttempts).toBe(
      invalidated ? attemptsBeforeRecovery : attemptsBeforeRecovery + 1,
    );
    expect(descriptor?.fd).toBe(-1);
    if (!invalidated && !inventory.ok)
      expect(inventory.error.cleanupIncomplete).toBe(false);
    if (invalidated) expect(closeAttempts).toBe(1);
  },
);

it("classifies root ASAR and DMG signatures across controlled short reads and closes the descriptor", async () => {
  const root = await createTestTempDirectory("rea-root-short-read-signature-");
  const compactPath = join(root, "compact.asar");
  const asarPath = join(root, "whitespace.asar");
  const dmgPath = join(root, "trailer.dmg");
  const asarBytes = asarHeaderBytes(
    `${" ".repeat(9_000)}\t\r\n${JSON.stringify({ files: {} })}`,
  );
  const dmgBytes = Buffer.alloc(1_024);
  const compactBytes = asarHeaderBytes(JSON.stringify({ files: {} }));
  dmgBytes.write("koly", dmgBytes.length - 512);
  await writeFile(asarPath, asarBytes);
  await writeFile(compactPath, compactBytes);
  await writeFile(dmgPath, dmgBytes);
  let openedPath: string | undefined;
  const descriptors: FileHandle[] = [];
  let largestActualRead = 0;
  injected.opened = (candidate, handle) => {
    if (candidate !== openedPath) return;
    descriptors.push(handle);
    const nativeRead = handle.read.bind(handle);
    const readAtMostThreeBytes = async (
      buffer: Buffer,
      offset: number,
      length: number,
      position: number | null,
    ) => {
      const boundedLength = Math.min(length, 3);
      largestActualRead = Math.max(largestActualRead, boundedLength);
      return nativeRead(buffer, offset, boundedLength, position);
    };
    vi.spyOn(handle, "read").mockImplementation(
      readAtMostThreeBytes as FileHandle["read"],
    );
  };
  onTestFinished(() => {
    injected.opened = undefined;
    vi.restoreAllMocks();
  });

  for (const [path, bytes, format] of [
    [compactPath, compactBytes, "asar"],
    [asarPath, asarBytes, "asar"],
    [dmgPath, dmgBytes, "dmg"],
  ] as const) {
    openedPath = path;
    descriptors.length = 0;
    largestActualRead = 0;
    const result = await classifyAndHashRoot(path, false, await lstat(path));
    expect(result.format).toBe(format);
    expect(result.digest?.sha256).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    if (format === "asar")
      expect(result.digest?.asarHeader).toMatchObject({ state: "matched" });
    expect(largestActualRead).toBeLessThanOrEqual(3);
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]?.fd).toBe(-1);
  }
});
