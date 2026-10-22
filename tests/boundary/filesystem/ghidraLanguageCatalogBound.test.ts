import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { readGhidraLanguageCatalog } from "../../../src/ghidra/GhidraLanguageCatalog.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const LIMIT = 4 * 1024 * 1024;
const OVERSIZED = "oversized.ldefs";

// Count bytes delivered from the oversized definition, whichever read API is used.
const { readBytes } = vi.hoisted(() => ({ readBytes: { value: 0 } }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const tracked = (path: unknown) => String(path).endsWith(OVERSIZED);
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const bytes = await actual.readFile(...args);
      if (tracked(args[0])) readBytes.value += bytes.length;
      return bytes;
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (!tracked(args[0])) return handle;
      const read = handle.read.bind(handle) as (
        ...readArgs: unknown[]
      ) => Promise<{ bytesRead: number }>;
      return Object.assign(handle, {
        read: async (...readArgs: unknown[]) => {
          const result = await read(...readArgs);
          readBytes.value += result.bytesRead;
          return result;
        },
      });
    },
  };
});

afterEach(() => {
  readBytes.value = 0;
});

it("skips an oversized definition without buffering it beyond the catalog limit", async () => {
  const root = await createTestTempDirectory("rea-ghidra-ldefs-bound-");
  const module = (name: string) =>
    join(root, "Ghidra/Processors", name, "data/languages");
  await mkdir(module("huge"), { recursive: true });
  await mkdir(module("x86"), { recursive: true });
  await writeFile(
    join(module("huge"), OVERSIZED),
    Buffer.concat([
      Buffer.from(
        '<language_definitions><language id="huge:LE:32:default"/></language_definitions>',
      ),
      Buffer.alloc(2 * LIMIT, 0x20),
    ]),
  );
  await writeFile(
    join(module("x86"), "x86.ldefs"),
    '<language_definitions><language id="x86:LE:32:default"/></language_definitions>',
  );

  expect(await readGhidraLanguageCatalog(root)).toEqual([
    { id: "x86:LE:32:default", compilerSpecIds: [] },
  ]);
  expect(readBytes.value).toBeGreaterThan(0);
  expect(readBytes.value).toBeLessThanOrEqual(LIMIT + 1);
});

it("keeps a definition at exactly the catalog limit", async () => {
  const root = await createTestTempDirectory("rea-ghidra-ldefs-limit-");
  const languages = join(root, "Ghidra/Processors/edge/data/languages");
  await mkdir(languages, { recursive: true });
  const document = Buffer.from(
    '<language_definitions><language id="edge:LE:32:default"/></language_definitions>',
  );
  await writeFile(
    join(languages, "edge.ldefs"),
    Buffer.concat([document, Buffer.alloc(LIMIT - document.length, 0x20)]),
  );

  expect(await readGhidraLanguageCatalog(root)).toEqual([
    { id: "edge:LE:32:default", compilerSpecIds: [] },
  ]);
});
