import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import {
  GhidraLanguageCatalogCleanupError,
  readGhidraLanguageCatalog,
} from "../../../src/ghidra/GhidraLanguageCatalog.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

interface FileControl {
  closeFails: boolean;
  /** Hold close() until every synchronized handle has reached it. */
  synchronizedClose: boolean;
  invalidateOnFailure: boolean;
  readFails: boolean;
  invalidated: boolean;
  closeCalls: number;
}

// Per-file failure controls, keyed by definition file name, and a barrier
// that releases synchronized closes only after all of them are pending.
const { controls, barrier } = vi.hoisted(() => {
  const state = { expected: 0, arrived: 0, release: () => {} };
  const gate = new Promise<void>((resolve) => {
    state.release = resolve;
  });
  return {
    controls: new Map<string, FileControl>(),
    barrier: {
      state,
      arrive: async () => {
        state.arrived += 1;
        if (state.arrived >= state.expected) state.release();
        await gate;
      },
    },
  };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const real = await actual.open(...args);
      const control = controls.get(basename(String(args[0])));
      if (control === undefined) return real;
      let released = false;
      const release = async () => {
        if (released) return;
        released = true;
        await real.close();
      };
      return {
        get fd() {
          return control.invalidated ? -1 : real.fd;
        },
        read: (...readArgs: Parameters<typeof real.read>) =>
          control.readFails
            ? Promise.reject(new Error("definition read failed"))
            : real.read(...readArgs),
        close: async () => {
          control.closeCalls += 1;
          if (control.synchronizedClose && control.closeCalls === 1)
            await barrier.arrive();
          if (control.closeFails) {
            if (control.invalidateOnFailure) {
              await release();
              control.invalidated = true;
            }
            throw new Error(`definition close failed: ${String(args[0])}`);
          }
          await release();
        },
      };
    },
  };
});

let preserveUnconfirmedOwner = false;

const control = (name: string, overrides: Partial<FileControl> = {}) => {
  const value: FileControl = {
    closeFails: false,
    synchronizedClose: false,
    invalidateOnFailure: false,
    readFails: false,
    invalidated: false,
    closeCalls: 0,
    ...overrides,
  };
  controls.set(name, value);
  return value;
};

const installation = async (name: string): Promise<string> => {
  const root = await createTestTempDirectory("rea-ghidra-ldefs-cleanup-");
  const languages = join(root, "Ghidra/Processors", name, "data/languages");
  await mkdir(languages, { recursive: true });
  await writeFile(
    join(languages, `${name}.ldefs`),
    `<language_definitions><language id="${name}:LE:32:default"/></language_definitions>`,
  );
  return root;
};

// Let every retained owner close, then drain them through a healthy read.
afterEach(async () => {
  if (preserveUnconfirmedOwner) {
    preserveUnconfirmedOwner = false;
    controls.clear();
    return;
  }
  for (const value of controls.values()) value.closeFails = false;
  await readGhidraLanguageCatalog(await installation("drain"));
  controls.clear();
});

it("retries a retained close before the next read", async () => {
  const retained = control("flaky.ldefs", { closeFails: true });
  await expect(
    readGhidraLanguageCatalog(await installation("flaky")),
  ).rejects.toMatchObject({ paths: [expect.stringContaining("flaky.ldefs")] });
  retained.closeFails = false;
  expect(await readGhidraLanguageCatalog(await installation("x86"))).toEqual([
    { id: "x86:LE:32:default", compilerSpecIds: [] },
  ]);
  expect(retained.closeCalls).toBe(2);
});

it("attempts every retained close and reports the remaining failures together", async () => {
  const first = control("first.ldefs", {
    closeFails: true,
    synchronizedClose: true,
  });
  const second = control("second.ldefs", {
    closeFails: true,
    synchronizedClose: true,
  });
  barrier.state.expected = 2;
  // Concurrent resolutions can each retain an owner.
  const roots = [await installation("first"), await installation("second")];
  const results = await Promise.allSettled(
    roots.map((root) => readGhidraLanguageCatalog(root)),
  );
  expect(results.map(({ status }) => status)).toEqual(["rejected", "rejected"]);
  second.closeFails = false;
  const failure = await readGhidraLanguageCatalog(
    await installation("x86"),
  ).catch((cause: unknown) => cause);
  expect(failure).toBeInstanceOf(GhidraLanguageCatalogCleanupError);
  expect(failure).toMatchObject({
    paths: [expect.stringContaining("first.ldefs")],
  });
  expect(second.closeCalls).toBe(2);
  expect(first.closeCalls).toBe(2);
});

it("keeps the read failure when the close also fails", async () => {
  control("damaged.ldefs", { readFails: true, closeFails: true });
  const failure = await readGhidraLanguageCatalog(
    await installation("damaged"),
  ).catch((cause: unknown) => cause);
  expect(failure).toBeInstanceOf(GhidraLanguageCatalogCleanupError);
  expect(failure).toMatchObject({
    readFailure: expect.objectContaining({ message: "definition read failed" }),
  });
});

it("reports retained cleanup for a catalog without definitions", async () => {
  control("pending.ldefs", { closeFails: true });
  await expect(
    readGhidraLanguageCatalog(await installation("pending")),
  ).rejects.toBeInstanceOf(GhidraLanguageCatalogCleanupError);
  const empty = await createTestTempDirectory("rea-ghidra-ldefs-empty-");
  await expect(readGhidraLanguageCatalog(empty)).rejects.toMatchObject({
    paths: [expect.stringContaining("pending.ldefs")],
  });
});

it("retains an invalidated descriptor owner and keeps later reads blocked", async () => {
  const broken = control("broken.ldefs", {
    closeFails: true,
    invalidateOnFailure: true,
  });
  const first = await readGhidraLanguageCatalog(
    await installation("broken"),
  ).catch((cause: unknown) => cause);
  expect(first).toBeInstanceOf(GhidraLanguageCatalogCleanupError);
  expect(first).toMatchObject({
    paths: [expect.stringContaining("broken.ldefs")],
  });

  const later = await readGhidraLanguageCatalog(
    await installation("x86"),
  ).catch((cause: unknown) => cause);
  expect(later).toBeInstanceOf(GhidraLanguageCatalogCleanupError);
  expect(later).toMatchObject({
    paths: [expect.stringContaining("broken.ldefs")],
  });
  expect(broken.closeCalls).toBe(1);
  preserveUnconfirmedOwner = true;
});
