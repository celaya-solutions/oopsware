import {
  chmod,
  copyFile,
  mkdir,
  readdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { ReadPiece } from "../application/identification/IdentificationPort.js";
import {
  identifyArtifactInputSchema,
  type IdentificationWalk,
} from "../domain/identification/identification.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { GZIP } from "../../tests/fixtures/archiveProducers.js";
import {
  produceNestedBundle as nestedBundle,
  produceStoredZip,
  produceZip,
  ZIP,
} from "../../tests/fixtures/identificationProducers.js";
import { walkPath } from "./walkPath.js";

const recordingReader = (
  outcome: (tool: string) => Awaited<ReturnType<ReadPiece>> = (tool) => ({
    ok: true,
    headline: { tool, title: `Read by ${tool}`, facts: [] },
  }),
) => {
  const calls: { tool: string; path: string }[] = [];
  const readPiece: ReadPiece = (route, path) => {
    calls.push({ tool: route.tool, path });
    return Promise.resolve(outcome(route.tool));
  };
  return { calls, readPiece };
};

const walk = async (
  path: string,
  directory: boolean,
  input: Record<string, unknown>,
  options: {
    readonly readPiece: ReadPiece;
    readonly scratch: string;
    readonly signal?: AbortSignal;
  },
): Promise<IdentificationWalk> =>
  walkPath(
    identifyArtifactInputSchema.parse({ path, ...input }),
    path,
    directory,
    {
      readPiece: options.readPiece,
      environment: process.env,
      platform: process.platform,
      scratchParent: options.scratch,
      signal: options.signal,
    },
  );

const byPath = (result: IdentificationWalk, path: string) => {
  const found = result.pieces.find((piece) => piece.path === path);
  if (found === undefined) throw new Error(`No piece at ${path}`);
  return found;
};

describe.skipIf(ZIP === null || GZIP === null)(
  "identification walk over real archives",
  () => {
    it("opens a zip inside a gzip-compressed tar, reads one piece per format, and removes its scratch", async () => {
      const root = await createTestTempDirectory("rea-identify-nested-");
      const scratch = await createTestTempDirectory("rea-identify-scratch-");
      const bundle = await nestedBundle(root);
      const { calls, readPiece } = recordingReader();
      const result = await walk(bundle, false, {}, { readPiece, scratch });

      expect(result.kind).toBe("file");
      expect(result.pieces[0]).toMatchObject({
        format: "gzip",
        format_basis: "bytes",
        container: { state: "opened", members: 2 },
      });
      expect(byPath(result, "app.zip")).toMatchObject({
        depth: 1,
        format: "zip",
        container: { state: "opened", members: 2 },
        outer: "p0",
      });
      expect(byPath(result, "app.zip/notes.json")).toMatchObject({
        depth: 2,
        format: "json",
        format_basis: "reader",
        reader: { tool: "inspect_document", state: "ran" },
        headline: { title: "Read by inspect_document" },
      });
      // One JSON piece is read; the next one says why it was not.
      expect(byPath(result, "app.zip/second.json").reader).toMatchObject({
        state: "skipped",
        reason: expect.stringMatching(/Another JSON was read/u),
      });
      expect(byPath(result, "readme.md")).toMatchObject({
        format: "markdown",
        reader: { state: "ran" },
      });
      expect(calls.map(({ tool }) => tool).sort()).toEqual([
        "inspect_document",
        "inspect_document",
      ]);
      // Readers saw copied members, not the archive, and the copies are gone.
      expect(calls.every(({ path }) => path.startsWith(scratch))).toBe(true);
      expect(result.counters).toMatchObject({
        containersOpened: 2,
        readersRun: 2,
        entryLimit: false,
        spoolLimit: false,
      });
      expect(result.counters.spooledBytes).toBeGreaterThan(0);
      expect(await readdir(scratch)).toEqual([]);
    });

    it("identifies a container without opening it at depth 0", async () => {
      const root = await createTestTempDirectory("rea-identify-depth-");
      const scratch = await createTestTempDirectory("rea-identify-scratch-");
      const bundle = await nestedBundle(root);
      const { readPiece } = recordingReader();
      const result = await walk(
        bundle,
        false,
        { depth: 0 },
        { readPiece, scratch },
      );
      expect(result.pieces).toHaveLength(1);
      expect(result.pieces[0]?.container).toEqual({
        state: "not_opened",
        members: null,
        reason: "depth is 0, so containers are identified but not opened.",
      });
      expect(result.counters.containersNotOpened).toBe(1);
    });
  },
);

describe.skipIf(ZIP === null || GZIP === null)(
  "identification walk budgets, refusals and cancellation",
  () => {
    it("names the spool budget when a nested container cannot be copied out", async () => {
      const root = await createTestTempDirectory("rea-identify-spool-");
      const scratch = await createTestTempDirectory("rea-identify-scratch-");
      const bundle = await nestedBundle(root);
      const { readPiece } = recordingReader();
      const result = await walk(
        bundle,
        false,
        { max_spool_bytes: 0 },
        { readPiece, scratch },
      );
      expect(byPath(result, "app.zip").container).toEqual({
        state: "not_opened",
        members: null,
        reason: "Copying it out would pass the max_spool_bytes budget.",
      });
      expect(result.counters.spoolLimit).toBe(true);
      expect(await readdir(scratch)).toEqual([]);
    });

    it("stops at max_entries and says the counts are partial", async () => {
      const root = await createTestTempDirectory("rea-identify-entries-");
      const scratch = await createTestTempDirectory("rea-identify-scratch-");
      const bundle = await nestedBundle(root);
      const { readPiece } = recordingReader();
      const result = await walk(
        bundle,
        false,
        { max_entries: 1 },
        { readPiece, scratch },
      );
      expect(result.counters).toMatchObject({ entries: 1, entryLimit: true });
      expect(result.pieces).toHaveLength(2);
      expect(await readdir(scratch)).toEqual([]);
    });

    it("clears a name the owning reader refutes and lets the next piece of that format be read", async () => {
      const root = await createTestTempDirectory("rea-identify-refuted-");
      const scratch = await createTestTempDirectory("rea-identify-scratch-");
      await writeFile(join(root, "a-broken.json"), "not json at all");
      await writeFile(join(root, "b-good.json"), "{}");
      let first = true;
      const { calls, readPiece } = recordingReader((tool) => {
        if (!first)
          return {
            ok: true,
            headline: { tool, title: "JSON document", facts: [] },
          };
        first = false;
        return {
          ok: false,
          reason: "It does not parse as JSON.",
          refuted: true,
        };
      });
      // Folder entries are read after the walk, so make them nested: one zip.
      await produceZip(root, join(root, "pair.zip"), [
        "a-broken.json",
        "b-good.json",
      ]);
      const result = await walk(
        join(root, "pair.zip"),
        false,
        {},
        { readPiece, scratch },
      );
      expect(byPath(result, "a-broken.json")).toMatchObject({
        format: null,
        format_basis: null,
        reader: { state: "failed", reason: "It does not parse as JSON." },
        name_conflict:
          "The name suggests JSON, but inspect_document did not confirm it: It does not parse as JSON.",
      });
      expect(byPath(result, "b-good.json")).toMatchObject({
        format: "json",
        reader: { state: "ran" },
      });
      expect(calls).toHaveLength(2);
    });

    it("stops when cancelled and still removes its scratch", async () => {
      const root = await createTestTempDirectory("rea-identify-cancel-");
      const scratch = await createTestTempDirectory("rea-identify-scratch-");
      const bundle = await nestedBundle(root);
      const controller = new AbortController();
      const readPiece: ReadPiece = () => {
        controller.abort(new Error("stop"));
        return Promise.resolve({
          ok: false,
          reason: "cancelled",
          refuted: false,
        });
      };
      await expect(
        walk(
          bundle,
          false,
          {},
          { readPiece, scratch, signal: controller.signal },
        ),
      ).rejects.toThrow("stop");
      expect(await readdir(scratch)).toEqual([]);
    });
  },
);

describe("identification walk over a folder", () => {
  it("tallies files, lists symlinks without following them, and keeps walking past a folder it cannot open", async () => {
    const root = await createTestTempDirectory("rea-identify-folder-");
    const scratch = await createTestTempDirectory("rea-identify-scratch-");
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "docs", "guide.md"), "# Guide\n");
    await writeFile(join(root, "config.yaml"), "a: 1\n");
    await copyFile(process.execPath, join(root, "node-copy"));
    await symlink("/etc/hosts", join(root, "hosts-link"));
    await mkdir(join(root, "locked"));
    await writeFile(join(root, "locked", "hidden.txt"), "hidden");
    await chmod(join(root, "locked"), 0o000);
    try {
      const { calls, readPiece } = recordingReader();
      const result = await walk(root, true, {}, { readPiece, scratch });
      expect(result.kind).toBe("directory");
      expect(result.pieces[0]).toMatchObject({
        kind: "directory",
        format: "directory",
        format_basis: "filesystem",
        reader: { tool: "inspect_desktop_application", state: "ran" },
      });
      expect(byPath(result, "docs/guide.md")).toMatchObject({
        format: "markdown",
        parent: byPath(result, "docs").id,
      });
      expect(byPath(result, "config.yaml").format).toBe("yaml");
      expect(byPath(result, "hosts-link").kind).toBe("symlink");
      expect(result.counters.symlinks).toBe(1);
      expect(byPath(result, "node-copy").format).toMatch(
        /^(mach-o|mach-o-universal|elf|pe)$/u,
      );
      // Readers ran on the real files, so next steps can name real paths.
      expect(calls.every(({ path }) => path.startsWith(root))).toBe(true);
      if (process.getuid?.() !== 0) {
        expect(result.counters.unreadable).toBe(1);
        expect(result.diagnostics).toContainEqual({
          piece: null,
          message: expect.stringMatching(/^locked: not readable/u),
        });
        expect(
          result.pieces.some((piece) => piece.path === "locked/hidden.txt"),
        ).toBe(false);
      }
      expect(result.sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(await readdir(scratch)).toEqual([]);
    } finally {
      await chmod(join(root, "locked"), 0o700);
    }
  });
});

describe.skipIf(ZIP === null)(
  "identification walk when readers disagree or bytes are damaged",
  () => {
    it("keeps what the bytes prove when the reader of a named role refutes it", async () => {
      const root = await createTestTempDirectory("rea-identify-role-");
      const scratch = await createTestTempDirectory("rea-identify-scratch-");
      await writeFile(join(root, "note.txt"), "plain\n");
      const jar = await produceZip(root, join(root, "lib.jar"), ["note.txt"]);
      const { readPiece } = recordingReader(() => ({
        ok: false,
        reason: "It reads as a plain ZIP with no Java classes or manifest.",
        refuted: true,
      }));
      const result = await walk(
        jar,
        false,
        { depth: 0 },
        { readPiece, scratch },
      );
      expect(result.pieces[0]).toMatchObject({
        format: "zip",
        format_basis: "bytes",
        reader: { tool: "inspect_jvm_artifact", state: "failed" },
        name_conflict: expect.stringMatching(
          /^The name suggests Java archive/u,
        ),
      });
    });

    it("keeps the format when a reader fails for a budget or a missing program", async () => {
      const root = await createTestTempDirectory("rea-identify-budget-");
      const scratch = await createTestTempDirectory("rea-identify-scratch-");
      await writeFile(join(root, "big.json"), "{}");
      const { readPiece } = recordingReader(() => ({
        ok: false,
        reason: "The file is larger than max_file_bytes.",
        refuted: false,
      }));
      const result = await walk(
        join(root, "big.json"),
        false,
        {},
        { readPiece, scratch },
      );
      expect(result.pieces[0]).toMatchObject({
        format: "json",
        format_basis: "name",
        name_conflict: null,
        reader: {
          state: "failed",
          reason: "The file is larger than max_file_bytes.",
        },
      });
    });

    it("goes on past one damaged member of a zip and names no scratch path", async () => {
      const root = await createTestTempDirectory("rea-identify-damaged-");
      const scratch = await createTestTempDirectory("rea-identify-scratch-");
      await writeFile(join(root, "a.json"), '{"first": "AAAAAAAAAAAAAAAA"}');
      await writeFile(join(root, "b.yaml"), "second: BBBBBBBBBBBBBBBB\n");
      await writeFile(join(root, "c.md"), "# third\n");
      const zip = await produceStoredZip(root, join(root, "set.zip"), [
        "a.json",
        "b.yaml",
        "c.md",
      ]);
      // Change one stored byte of a.json so its CRC no longer matches.
      const bytes = await readFile(zip);
      const at = bytes.indexOf("AAAAAAAAAAAAAAAA");
      bytes[at] = 0x42;
      await writeFile(zip, bytes);
      const { readPiece } = recordingReader();
      const result = await walk(zip, false, {}, { readPiece, scratch });
      expect(byPath(result, "a.json").reader.state).not.toBe("ran");
      expect(result.counters.unreadable).toBeGreaterThanOrEqual(1);
      expect(byPath(result, "b.yaml")).toMatchObject({
        format: "yaml",
        reader: { state: "ran" },
      });
      expect(byPath(result, "c.md")).toMatchObject({
        format: "markdown",
        reader: { state: "ran" },
      });
      expect(result.pieces[0]?.container).toMatchObject({
        state: "opened",
        members: 3,
        reason: null,
      });
      expect(JSON.stringify(result)).not.toContain(scratch);
      expect(await readdir(scratch)).toEqual([]);
    });
  },
);

describe("identification walk diagnostics", () => {
  it.skipIf(process.getuid?.() === 0)(
    "lists a bounded number of diagnostics and counts the rest",
    async () => {
      const root = await createTestTempDirectory("rea-identify-many-");
      const scratch = await createTestTempDirectory("rea-identify-scratch-");
      for (let index = 0; index < 210; index += 1) {
        const path = join(root, `locked-${String(index)}.bin`);
        await writeFile(path, "x");
        await chmod(path, 0o000);
      }
      const { readPiece } = recordingReader();
      const result = await walk(
        root,
        true,
        { max_readers: 0 },
        { readPiece, scratch },
      );
      expect(result.counters.unreadable).toBe(210);
      expect(result.diagnostics).toHaveLength(200);
      expect(result.counters.diagnosticsOmitted).toBe(10);
    },
  );
});
