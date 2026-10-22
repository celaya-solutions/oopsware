import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Ajv2020 } from "ajv/dist/2020.js";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { officeDocumentReportSchema } from "../../../src/domain/officeDocument/officeDocument.js";
import {
  MAIN_TYPES,
  S,
  TEXTUTIL,
  buildPackage,
  relType,
  sharedStrings,
  textutilDocx,
  workbook,
  worksheet,
} from "../../fixtures/officeProducers.js";
import {
  TEXTUTIL as LEGACY_TEXTUTIL,
  textutilDoc,
} from "../../fixtures/legacyDocProducers.js";
import { buildPpt } from "../../fixtures/legacyPptProducers.js";
import { buildXls, cells } from "../../fixtures/legacyXlsProducers.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "reads a Word document and a workbook through the compiled CLI and real stdio MCP with identical evidence",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-office-acceptance-");
    const xlsx = join(root, "budget.xlsx");
    await writeFile(
      xlsx,
      await buildPackage({
        mainPath: "xl/workbook.xml",
        mainType: MAIN_TYPES.xlsx,
        main: workbook([{ name: "Budget", id: "rId1" }]),
        mainLinks: [
          {
            id: "rId1",
            type: relType("worksheet"),
            target: "worksheets/sheet1.xml",
          },
          {
            id: "rId2",
            type: relType("sharedStrings"),
            target: "sharedStrings.xml",
          },
        ],
        parts: {
          "xl/worksheets/sheet1.xml": {
            data: worksheet(
              `<row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="2"><c r="A2"><v>2</v></c><c r="B2"><f>A2*3</f><v>6</v></c></row>`,
            ),
          },
          "xl/sharedStrings.xml": { data: sharedStrings("Total") },
        },
      }),
    );
    const docx =
      TEXTUTIL === null
        ? null
        : (
            await textutilDocx(
              root,
              "memo",
              "<html><body><h1>Memo</h1><p>Plain words.</p></body></html>",
            )
          ).docx;

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("scripts/rea.mjs"), "mcp"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "", REA_LOG_LEVEL: "silent" },
      stderr: "pipe",
    });
    const client = new Client({ name: "office-acceptance", version: "1" });
    try {
      await client.connect(transport);
      const ajv = new Ajv2020({ strict: false, validateFormats: false });
      const contract = toolContract("inspect_office_document");
      const advertised = (await client.listTools()).tools.find(
        (tool) => tool.name === contract.name,
      );
      if (advertised?.outputSchema === undefined)
        throw new Error("inspect_office_document must publish both schemas");
      const inputSchema: Record<string, unknown> = advertised.inputSchema;
      const outputSchema: Record<string, unknown> = advertised.outputSchema;
      expect(ajv.validateSchema(inputSchema)).toBe(true);
      expect(ajv.validateSchema(outputSchema)).toBe(true);

      const both = async (
        cliArguments: string[],
        mcpArguments: Record<string, unknown>,
      ) => {
        const result = await cli.run({
          arguments: [...cliArguments, "--json"],
        });
        expect(result.exitCode, cliArguments.join(" ")).toBe(0);
        const evidence = contract.outputSchema.parse(result.json);
        const response = await client.callTool({
          name: contract.name,
          arguments: mcpArguments,
        });
        expect(response.isError).not.toBe(true);
        expect(
          ajv.validate(outputSchema, response.structuredContent),
          JSON.stringify(ajv.errors),
        ).toBe(true);
        const mcp = contract.outputSchema.parse(response.structuredContent);
        expect(mcp.evidence_id).toBe(evidence.evidence_id);
        expect(mcp.normalized_result).toEqual(evidence.normalized_result);
        return officeDocumentReportSchema.parse(mcp.normalized_result);
      };

      const overview = await both(["inspect-office-document", xlsx], {
        path: xlsx,
      });
      expect(overview.package).toMatchObject({ kind: "xlsx", family: "excel" });
      expect(overview.content_parts.map((part) => part.id)).toEqual([
        "sheet:1",
      ]);

      const rows = await both(
        [
          "inspect-office-document",
          xlsx,
          "--view",
          "content",
          "--part",
          "sheet:1",
        ],
        { path: xlsx, view: "content", part: "sheet:1" },
      );
      expect(rows.items).toHaveLength(2);
      expect(rows.items[1]).toMatchObject({
        kind: "row",
        cells: [
          { ref: "A2", value: "2", formula: null },
          { ref: "B2", value: "6", formula: "A2*3" },
        ],
      });

      const text = await both(
        ["inspect-office-document", xlsx, "--view", "text", "--limit", "1"],
        { path: xlsx, view: "text", limit: 1 },
      );
      expect(text.page).toMatchObject({ returned: 1, next: 1 });

      if (docx !== null) {
        const memo = await both(
          ["inspect-office-document", docx, "--view", "text"],
          { path: docx, view: "text" },
        );
        expect(memo.text.join("\n")).toContain("Plain words.");
      }
      expect(S).toContain("spreadsheetml");
    } finally {
      await client.close();
    }
  },
  240_000,
);

cliTest(
  "reads legacy Word, Excel and PowerPoint files through the compiled CLI and real stdio MCP with identical evidence",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-legacy-office-acceptance-");
    const xls = join(root, "budget.xls");
    await writeFile(
      xls,
      buildXls({
        sheets: [
          {
            name: "Budget",
            records: [cells.number(0, 0, 0, 2), cells.number(1, 0, 0, 40)],
          },
        ],
      }),
    );
    const ppt = join(root, "deck.ppt");
    await writeFile(
      ppt,
      buildPpt({ slides: [{ title: "Quarterly plan", body: "Ship it" }] }),
    );
    const doc =
      LEGACY_TEXTUTIL === null
        ? null
        : (
            await textutilDoc(
              root,
              "memo",
              "<html><body><h1>Memo</h1><p>Plain words.</p></body></html>",
            )
          ).doc;

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("scripts/rea.mjs"), "mcp"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "", REA_LOG_LEVEL: "silent" },
      stderr: "pipe",
    });
    const client = new Client({
      name: "legacy-office-acceptance",
      version: "1",
    });
    try {
      await client.connect(transport);
      const ajv = new Ajv2020({ strict: false, validateFormats: false });
      const contract = toolContract("inspect_office_document");
      const advertised = (await client.listTools()).tools.find(
        (tool) => tool.name === contract.name,
      );
      if (advertised?.outputSchema === undefined)
        throw new Error("inspect_office_document must publish both schemas");
      const outputSchema: Record<string, unknown> = advertised.outputSchema;

      const both = async (
        cliArguments: string[],
        mcpArguments: Record<string, unknown>,
      ) => {
        const result = await cli.run({
          arguments: [...cliArguments, "--json"],
        });
        expect(result.exitCode, cliArguments.join(" ")).toBe(0);
        const evidence = contract.outputSchema.parse(result.json);
        const response = await client.callTool({
          name: contract.name,
          arguments: mcpArguments,
        });
        expect(response.isError).not.toBe(true);
        expect(
          ajv.validate(outputSchema, response.structuredContent),
          JSON.stringify(ajv.errors),
        ).toBe(true);
        const mcp = contract.outputSchema.parse(response.structuredContent);
        expect(mcp.evidence_id).toBe(evidence.evidence_id);
        expect(mcp.normalized_result).toEqual(evidence.normalized_result);
        return officeDocumentReportSchema.parse(mcp.normalized_result);
      };

      const workbookRows = await both(
        ["inspect-office-document", xls, "--view", "content"],
        { path: xls, view: "content" },
      );
      expect(workbookRows.package).toMatchObject({
        kind: "xls",
        family: "excel",
      });
      expect(workbookRows.items).toHaveLength(2);

      const deck = await both(
        ["inspect-office-document", ppt, "--view", "text"],
        { path: ppt, view: "text" },
      );
      expect(deck.package).toMatchObject({ kind: "ppt", family: "powerpoint" });
      expect(deck.text.join("\n")).toContain("Quarterly plan");

      if (doc !== null) {
        const memo = await both(
          ["inspect-office-document", doc, "--view", "text"],
          { path: doc, view: "text" },
        );
        expect(memo.package).toMatchObject({ kind: "doc", family: "word" });
        expect(memo.text.join("\n")).toContain("Plain words.");
      }
    } finally {
      await client.close();
    }
  },
  240_000,
);
