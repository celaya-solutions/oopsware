import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { codepageDecoder } from "./codepage.js";
import type { MsiDatabase } from "./database.js";
import {
  buildCoverageFixtures,
  cellText,
  COVERAGE_READY,
  exec,
  exportTable,
  openMsi,
  type CoverageFixtures,
} from "./msi.fixture.js";
import { summaryInformationOf } from "./summaryInformation.js";
import {
  buildWindowsFixtures,
  WINDOWS_TOOLS,
  windowsOracle,
  type WindowsFixtures,
} from "../../../tests/fixtures/windowsProducers.js";
import { removeTestWorkspace } from "../../../tests/support/workspace/workspaceFixture.js";

/**
 * The MSI database reader against msitools 0.106 itself: table names and
 * order (`msiinfo tables`), every row and cell of every table with column
 * names, type codes and keys (`msiinfo export`), the code page
 * (`_ForceCodepage`), streams and their bytes (`msiinfo streams`,
 * `msiinfo extract`) and summary information (`msiinfo export
 * _SummaryInformation`, `msiinfo suminfo`), over wixl, msibuild and libgsf
 * databases in code pages 0, 1252 and 65001 with 2- and 3-byte string
 * references and 512- and 4096-byte sectors.
 */

interface Built {
  readonly windows: WindowsFixtures;
  readonly coverage: CoverageFixtures;
  readonly all: readonly string[];
}

let root: string | undefined;
let building: Promise<Built> | undefined;

const built = (): Promise<Built> => {
  building ??= (async () => {
    root = await realpath(
      await mkdtemp(join(await realpath(tmpdir()), "rea-msi-")),
    );
    const windows = await buildWindowsFixtures(join(root, "windows"));
    const coverage = await buildCoverageFixtures(
      join(root, "coverage"),
      windows.msi,
    );
    return {
      windows,
      coverage,
      all: [
        windows.msi,
        windows.msiExternal,
        coverage.neutral,
        coverage.utf8,
        coverage.latin,
        coverage.sql,
        coverage.long,
        coverage.v4,
      ],
    };
  })();
  return building;
};

afterAll(async () => {
  if (root !== undefined) await removeTestWorkspace(root);
});

const lines = (output: Buffer): string[] =>
  output
    .toString("utf8")
    .split("\n")
    .filter((line) => line !== "");

const SYSTEM_TABLES = new Set(["_Tables", "_Columns"]);

const userTables = (database: MsiDatabase): string[] =>
  [...database.tables.keys()].filter((name) => !SYSTEM_TABLES.has(name));

describe.skipIf(!COVERAGE_READY)("MSI databases against msiinfo", () => {
  beforeAll(async () => {
    await built();
  }, 120_000);

  it("lists every table in the order msiinfo lists them", async () => {
    for (const path of (await built()).all) {
      const { database } = await openMsi(path);
      const listed = lines(await windowsOracle("msiinfo", ["tables", path]));
      expect(listed.slice(0, 2)).toEqual([
        "_SummaryInformation",
        "_ForceCodepage",
      ]);
      expect(userTables(database), path).toEqual(listed.slice(2));
    }
  });

  it("decodes every cell, column name, type code and key of every table as msiinfo exports it", async () => {
    let cells = 0;
    let tables = 0;
    for (const path of (await built()).all) {
      const { database } = await openMsi(path);
      const exports = new Map(
        await Promise.all(
          [...database.tables.keys()].map(
            async (name) => [name, await exportTable(path, name)] as const,
          ),
        ),
      );
      for (const [name, table] of database.tables) {
        const exported = exports.get(name);
        if (exported === undefined) throw new Error(`${name} was not exported`);
        expect(
          table.columns.map((column) => column.name),
          `${path} ${name}`,
        ).toEqual(exported.names);
        expect(
          table.columns.map((column) => column.declared),
          `${path} ${name}`,
        ).toEqual(exported.types);
        const keys = SYSTEM_TABLES.has(name)
          ? []
          : table.columns
              .filter((column) => column.key)
              .map((column) => column.name);
        expect([name, ...keys], `${path} ${name}`).toEqual(exported.header);
        expect(
          table.rows.map((row) => row.map(cellText)),
          `${path} ${name}`,
        ).toEqual(exported.rows);
        cells += table.rows.length * table.columns.length;
        tables += 1;
      }
    }
    expect(tables).toBeGreaterThan(275);
    expect(cells).toBeGreaterThan(70_000);
  }, 120_000);

  it("reads the code page and string reference width each producer chose", async () => {
    const { windows, coverage } = await built();
    const expected = new Map([
      [windows.msi, [0, 2]],
      [coverage.neutral, [0, 2]],
      [coverage.utf8, [65001, 2]],
      [coverage.latin, [1252, 2]],
      [coverage.long, [0, 3]],
      [coverage.v4, [0, 2]],
    ]);
    for (const [path, [codepage, strref]] of expected) {
      const { database } = await openMsi(path);
      const forced = /(\d+)\t_ForceCodepage/u.exec(
        (
          await windowsOracle("msiinfo", ["export", path, "_ForceCodepage"])
        ).toString("latin1"),
      );
      expect(Number(forced?.[1])).toBe(database.codepage);
      expect([database.codepage, database.strref], path).toEqual([
        codepage,
        strref,
      ]);
    }
    for (const path of [coverage.neutral, coverage.utf8, coverage.latin]) {
      const { database } = await openMsi(path);
      expect(
        database.rows("Property").find((row) => row.Property === "UNI")?.Value,
      ).toBe("wert é ü");
    }
  });

  it("lists the streams msiinfo lists, with the bytes msiinfo extracts", async () => {
    let compared = 0;
    for (const path of (await built()).all) {
      const { database, file } = await openMsi(path);
      expect(
        database.streams.map((stream) => stream.name),
        path,
      ).toEqual(lines(await windowsOracle("msiinfo", ["streams", path])));
      expect(database.storages).toEqual([]);
      for (const stream of database.streams) {
        const extracted = await windowsOracle("msiinfo", [
          "extract",
          path,
          stream.name,
        ]);
        expect(
          Buffer.from(await file.read(stream.entry, stream.entry.size)).equals(
            extracted,
          ),
          `${path} ${stream.name}`,
        ).toBe(true);
        compared += 1;
      }
    }
    expect(compared).toBeGreaterThan(20);
  });

  it("reports only what is wrong: a binary cell whose keyed stream (Pic.-2) msibuild never wrote", async () => {
    const { coverage, all } = await built();
    for (const path of all) {
      const { database } = await openMsi(path);
      expect(database.problems, path).toEqual(
        path === coverage.sql
          ? [
              "Table Pic has 1 binary cells whose stream is not in the database; they read as null.",
            ]
          : [],
      );
    }
    const { database } = await openMsi(coverage.sql);
    expect(database.rows("Pic")).toEqual([
      { Id: -2, Big: 2147483647, Small: null, Note: null, Data: null },
      {
        Id: 5,
        Big: -70000,
        Small: -3,
        Note: "five",
        Data: { stream: "Pic.5" },
      },
    ]);
  });
});

const pad = (value: number): string => String(value).padStart(2, "0");
/** libmsi's summary export form, "%Y/%m/%d %H:%M:%S", here in UTC. */
const slashTime = (iso: string): string => {
  const date = new Date(iso);
  return `${String(date.getUTCFullYear())}/${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
};
/** ctime(3) in UTC, as `msiinfo suminfo` prints times. */
const ctime = (iso: string): string => {
  const date = new Date(iso);
  const day =
    ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getUTCDay()] ?? "";
  const month =
    [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ][date.getUTCMonth()] ?? "";
  return `${day} ${month} ${String(date.getUTCDate()).padStart(2, " ")} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} ${String(date.getUTCFullYear())}`;
};

describe.skipIf(!COVERAGE_READY)("summary information against msiinfo", () => {
  beforeAll(async () => {
    await built();
  }, 120_000);

  it("reads every stored property as msiinfo exports _SummaryInformation", async () => {
    for (const path of (await built()).all) {
      const { file } = await openMsi(path);
      const summary = await summaryInformationOf(file);
      if (summary === null || WINDOWS_TOOLS === null)
        throw new Error(`${path} has no summary information`);
      const output = await exec(WINDOWS_TOOLS.msiinfo, [
        "export",
        path,
        "_SummaryInformation",
      ]);
      const exported = codepageDecoder(summary.codepage ?? 0)
        .decode(output)
        .split("\r\n")
        .slice(3)
        .filter((line) => line !== "")
        .map((line) => [
          Number(line.slice(0, line.indexOf("\t"))),
          line.slice(line.indexOf("\t") + 1),
        ]);
      const ours = summary.properties.map((property) => [
        property.id,
        property.vt === "VT_FILETIME" && typeof property.value === "string"
          ? slashTime(property.value)
          : String(property.value),
      ]);
      expect(ours, path).toEqual(exported);
      expect(summary.problems).toEqual([]);
      expect(summary.unknown_properties).toBe(0);
    }
  });

  it("names the Windows Installer meanings msiinfo suminfo prints", async () => {
    const { windows, coverage } = await built();
    for (const path of [windows.msi, coverage.neutral, coverage.latin]) {
      const { file } = await openMsi(path);
      const summary = await summaryInformationOf(file);
      if (summary === null || WINDOWS_TOOLS === null)
        throw new Error(`${path} has no summary information`);
      const printed = codepageDecoder(summary.codepage ?? 0).decode(
        await exec(WINDOWS_TOOLS.msiinfo, ["suminfo", path]),
      );
      const expected = [
        `Title: ${String(summary.title)}`,
        `Subject: ${String(summary.subject)}`,
        `Author: ${String(summary.author)}`,
        `Keywords: ${String(summary.keywords)}`,
        `Comments: ${String(summary.comments)}`,
        `Template: ${String(summary.template)}`,
        `Revision number (UUID): ${String(summary.revision)}`,
        `Created: ${ctime(summary.created ?? "")}`,
        `Last saved: ${ctime(summary.last_saved ?? "")}`,
        `Version: ${String(summary.page_count)} (${(summary.page_count ?? 0).toString(16)})`,
        `Source: ${String(summary.word_count)} (${(summary.word_count ?? 0).toString(16)})`,
        `Application: ${String(summary.creating_application)}`,
        `Security: ${String(summary.security)} (${(summary.security ?? 0).toString(16)})`,
      ];
      expect(
        printed.split("\n").filter((line) => line !== ""),
        path,
      ).toEqual(expected);
    }
    const utf8 = await summaryInformationOf(
      (await openMsi(coverage.utf8)).file,
    );
    expect(utf8).toMatchObject({
      codepage: 65001,
      subject: "Coverage ☃",
      platforms: ["x64"],
      languages: [1033],
      page_count: 500,
      source_flags: ["compressed"],
    });
    expect(utf8?.revision).toMatch(/^\{[0-9A-F-]{36}\}$/u);
  });
});
