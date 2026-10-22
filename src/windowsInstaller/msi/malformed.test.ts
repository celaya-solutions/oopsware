import { copyFile, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MsiFormatError } from "./database.js";
import { msiFacts } from "./facts.js";
import {
  cellText,
  COVERAGE_READY,
  exec,
  exportTable,
  MSIBUILD,
  openMsi,
  repack,
} from "./msi.fixture.js";
import { encodeMsiStreamName } from "./streamNames.js";
import {
  buildWindowsFixtures,
  windowsOracle,
  type WindowsFixtures,
} from "../../../tests/fixtures/windowsProducers.js";
import { removeTestWorkspace } from "../../../tests/support/workspace/workspaceFixture.js";

/**
 * Malformed databases made from the shared wixl MSI by one documented edit
 * of one stream, repacked by libgsf (`gsf createole`), or by msibuild SQL.
 * Where libmsi still reads the result, every table is compared with
 * `msiinfo export` again; where it refuses, so does this reader.
 */

let root: string | undefined;
let building: Promise<WindowsFixtures> | undefined;

const built = (): Promise<WindowsFixtures> => {
  building ??= (async () => {
    root = await realpath(
      await mkdtemp(join(await realpath(tmpdir()), "rea-msi-malformed-")),
    );
    return buildWindowsFixtures(join(root, "windows"));
  })();
  return building;
};

afterAll(async () => {
  if (root !== undefined) await removeTestWorkspace(root);
});

const workspace = (name: string): string => {
  if (root === undefined) throw new Error("no workspace");
  return join(root, name);
};

const STRING_POOL = encodeMsiStreamName("_StringPool", true);
const FILE_TABLE = encodeMsiStreamName("File", true);
const COLUMNS = encodeMsiStreamName("_Columns", true);

/** Every table of `path` as this reader decodes it, against msiinfo's export of the same file. */
const expectTablesMatch = async (path: string): Promise<void> => {
  const { database } = await openMsi(path);
  for (const [name, table] of database.tables) {
    const exported = await exportTable(path, name);
    expect(
      table.columns.map((column) => column.declared),
      name,
    ).toEqual(exported.types);
    expect(
      table.rows.map((row) => row.map(cellText)),
      name,
    ).toEqual(exported.rows);
  }
};

describe.skipIf(!COVERAGE_READY)(
  "malformed MSI databases from real streams",
  () => {
    beforeAll(async () => {
      await built();
    }, 120_000);

    it("keeps every string when _StringPool declares one more 100-byte string than _StringData holds", async () => {
      const path = await repack(
        (await built()).msi,
        workspace("pool.msi"),
        512,
        (name, bytes) =>
          name === STRING_POOL
            ? Buffer.concat([bytes, Buffer.from([100, 0, 1, 0])])
            : bytes,
      );
      const { database } = await openMsi(path);
      expect(database.problems).toEqual([
        expect.stringMatching(
          /^String \d+ needs 100 bytes at _StringData offset (\d+), past its \1 bytes; this and later strings are missing\.$/u,
        ),
      ]);
      await expectTablesMatch(path);
    });

    it("refuses a table stream two bytes short of whole rows, as libmsi does", async () => {
      const path = await repack(
        (await built()).msi,
        workspace("short.msi"),
        512,
        (name, bytes) =>
          name === FILE_TABLE ? bytes.subarray(0, bytes.length - 2) : bytes,
      );
      const { database } = await openMsi(path);
      expect(database.table("File")?.rows).toEqual([]);
      expect(database.problems).toEqual([
        "Table File's stream is 38 bytes, not a multiple of its 20-byte rows; its rows are not decoded.",
      ]);
      await expect(
        windowsOracle("msiinfo", ["export", path, "File"]),
      ).rejects.toThrow();
      expect(msiFacts(database).files).toEqual([]);
      expect(
        database.table("Component")?.rows.map((row) => row.map(cellText)),
      ).toEqual((await exportTable(path, "Component")).rows);
    });

    it("reads a column _Columns declares as a 3-byte integer the way libmsi does (4 bytes), and says so", async () => {
      const source = (await built()).msi;
      const rows = (await exportTable(source, "_Columns")).rows;
      const index = rows.findIndex(
        ([table, number]) => table === "File" && number === "4",
      );
      // Type cells follow Table, Number and Name (2 bytes each with 2-byte string references): i4 (0x8104) becomes i3.
      const path = await repack(
        source,
        workspace("i3.msi"),
        512,
        (name, bytes) => {
          if (name !== COLUMNS) return bytes;
          const copy = Buffer.from(bytes);
          expect(copy.readUInt16LE(6 * rows.length + 2 * index)).toBe(0x8104);
          copy.writeUInt16LE(0x8103, 6 * rows.length + 2 * index);
          return copy;
        },
      );
      const { database } = await openMsi(path);
      expect(database.table("File")?.columns[3]).toMatchObject({
        name: "FileSize",
        declared: "i3",
        bytes: 4,
        code: 0x103,
      });
      expect(database.problems).toEqual([
        "Table File: column FileSize declares a 3-byte integer; it is read as 4 bytes, as msitools reads it.",
      ]);
      await expectTablesMatch(path);
    });

    it("refuses a database without _StringPool, as libmsi does", async () => {
      const path = await repack(
        (await built()).msi,
        workspace("no-pool.msi"),
        512,
        (name, bytes) => (name === STRING_POOL ? null : bytes),
      );
      await expect(openMsi(path)).rejects.toMatchObject({
        name: "MsiFormatError",
        stream: "_StringPool",
      });
      await expect(openMsi(path)).rejects.toBeInstanceOf(MsiFormatError);
      await expect(
        windowsOracle("msiinfo", ["tables", path]),
      ).rejects.toThrow();
    });

    it("reports a directory cycle, a missing parent and a missing directory (msiextract would loop on the cycle)", async () => {
      if (MSIBUILD === null) throw new Error("msibuild is not installed");
      const path = workspace("loops.msi");
      await copyFile((await built()).msi, path);
      const directory = (id: string, parent: string, name: string) =>
        `INSERT INTO \`Directory\` (\`Directory\`, \`Directory_Parent\`, \`DefaultDir\`) VALUES ('${id}', '${parent}', '${name}')`;
      await exec(MSIBUILD, [
        path,
        "-q",
        directory("LOOPA", "LOOPB", "a"),
        "-q",
        directory("LOOPB", "LOOPA", "b"),
        "-q",
        directory("ORPHAN", "NOPE", "orphan"),
        "-q",
        "INSERT INTO `Component` (`Component`, `Directory_`, `Attributes`) VALUES ('Lost', 'GONE', 0)",
        "-q",
        "INSERT INTO `File` (`File`, `Component_`, `FileName`, `FileSize`, `Sequence`) VALUES ('LostFile', 'Lost', 'lost.txt', 1, 3)",
      ]);
      const facts = msiFacts((await openMsi(path)).database);
      const paths = Object.fromEntries(
        facts.directories.map((entry) => [entry.id, entry.target_path]),
      );
      expect(paths).toMatchObject({
        LOOPA: "LOOPA",
        LOOPB: "LOOPB",
        ORPHAN: "NOPE/orphan",
      });
      expect(
        facts.files.find((file) => file.key === "LostFile")?.target_path,
      ).toBe("GONE/lost.txt");
      expect(facts.problems).toEqual([
        "Directory LOOPA is its own ancestor; its path starts at its ID.",
        "Directory ORPHAN names parent NOPE, which the Directory table does not hold.",
        "Component Lost names directory GONE, which the Directory table does not hold.",
        "File LostFile has sequence 3, past every Media row's LastSequence.",
      ]);
    });
  },
);
