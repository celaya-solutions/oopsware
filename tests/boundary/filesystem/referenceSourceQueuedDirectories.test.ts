import type { Dir, Dirent } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { importReferenceSource } from "../../support/referenceSourceResourceScope.js";

const { opendirMock } = vi.hoisted(() => ({ opendirMock: vi.fn() }));

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  opendir: opendirMock,
}));

const directoryHandle = (items: readonly (string | Error | null)[]): Dir => {
  let index = 0;
  return {
    async read() {
      const item = items[index++];
      if (item instanceof Error) throw item;
      return item === null || item === undefined
        ? null
        : ({ name: item } as Dirent);
    },
    async close() {},
  } as unknown as Dir;
};

it.skipIf(process.platform === "win32")(
  "traverses directories lstat-observed before their parent enumeration failed",
  async () => {
    const root = await createTestTempDirectory(
      "rea-queued-source-directories-",
    );
    const container = join(root, "container");
    const hidden = join(container, "hidden");
    await mkdir(hidden, { recursive: true });
    await writeFile(join(container, "visible.txt"), "visible\n");
    await writeFile(join(hidden, "target.txt"), "target\n");
    await symlink("hidden/target.txt", join(container, "alias-file.txt"));
    await symlink("hidden", join(container, "alias-directory"));

    const readFailure = Object.assign(
      new Error("injected directory read failure"),
      { code: "EIO" },
    );
    opendirMock.mockImplementation(async (path: string) => {
      if (path === root) return directoryHandle(["container", null]);
      if (path === container)
        return directoryHandle([
          "visible.txt",
          "hidden",
          "alias-file.txt",
          "alias-directory",
          readFailure,
        ]);
      if (path === hidden) return directoryHandle(["target.txt", null]);
      throw new Error(`Unexpected directory traversal: ${path}`);
    });

    const imported = await importReferenceSource({
      root,
      caller: "queued-directory-read-failure-test",
      policy: { secretPatterns: [] },
    });
    if (!imported.ok) throw new Error(imported.error.message);
    expect(imported.value.inventory_state).toBe("partial");
    expect(imported.value.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "container",
          kind: "directory",
          tree_state: "unreadable",
        }),
        expect.objectContaining({
          path: "container/hidden",
          kind: "directory",
          tree_state: "enumerated",
        }),
        expect.objectContaining({
          path: "container/visible.txt",
          kind: "file",
          content_state: "hashed",
        }),
        expect.objectContaining({
          path: "container/hidden/target.txt",
          kind: "file",
          content_state: "hashed",
        }),
        expect.objectContaining({
          path: "container/alias-file.txt",
          kind: "symlink",
          target: "hidden/target.txt",
          target_state: "internal",
        }),
        expect.objectContaining({
          path: "container/alias-directory",
          kind: "symlink",
          target: "hidden",
          target_state: "internal",
        }),
      ]),
    );
  },
);
