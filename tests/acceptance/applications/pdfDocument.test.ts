import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Ajv2020 } from "ajv/dist/2020.js";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { pdfDocumentReportSchema } from "../../../src/domain/pdfDocument/pdfDocument.js";
import { buildPdf, onePage } from "../../fixtures/pdfProducers.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "reads a PDF through the compiled CLI and real stdio MCP with identical evidence",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-pdf-acceptance-");
    const pdf = join(root, "memo.pdf");
    await writeFile(
      pdf,
      buildPdf(
        onePage("BT /F1 12 Tf 20 100 Td (Plain words on a page) Tj ET", {
          catalog: "/OpenAction << /S /JavaScript /JS (app.alert\\(1\\)) >>",
        }),
        { trailer: "/Info << /Title (Memo) >>" },
      ),
    );

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("scripts/rea.mjs"), "mcp"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "", REA_LOG_LEVEL: "silent" },
      stderr: "pipe",
    });
    const client = new Client({ name: "pdf-acceptance", version: "1" });
    try {
      await client.connect(transport);
      const ajv = new Ajv2020({ strict: false, validateFormats: false });
      const contract = toolContract("inspect_pdf_document");
      const advertised = (await client.listTools()).tools.find(
        (tool) => tool.name === contract.name,
      );
      if (advertised?.outputSchema === undefined)
        throw new Error("inspect_pdf_document must publish both schemas");
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
        return pdfDocumentReportSchema.parse(mcp.normalized_result);
      };

      const overview = await both(["inspect-pdf-document", pdf], { path: pdf });
      expect(overview.document).toMatchObject({
        page_count: 1,
        header_version: "1.7",
      });
      expect(overview.metadata?.info).toEqual([
        { key: "Title", value: "Memo" },
      ]);
      expect(overview.actions[0]).toMatchObject({
        kind: "JavaScript",
        trigger: "OpenAction",
        script: "app.alert(1)",
      });

      const pages = await both(
        ["inspect-pdf-document", pdf, "--view", "pages"],
        { path: pdf, view: "pages" },
      );
      expect(pages.pages[0]).toMatchObject({
        kind: "text",
        text_operations: 1,
      });

      const objects = await both(
        ["inspect-pdf-document", pdf, "--view", "objects", "--limit", "2"],
        { path: pdf, view: "objects", limit: 2 },
      );
      expect(objects.page).toMatchObject({ returned: 2, next: 2 });

      const text = await both(["inspect-pdf-document", pdf, "--view", "text"], {
        path: pdf,
        view: "text",
      });
      expect(text.text.join("\n")).toContain("Plain words on a page");
      expect(text.text_tool?.name).toBe("pdftotext");

      const layout = await both(
        ["inspect-pdf-document", pdf, "--view", "layout"],
        { path: pdf, view: "layout" },
      );
      expect(layout.layout[0]?.lines[0]?.text).toBe("Plain words on a page");
    } finally {
      await client.close();
    }
  },
  240_000,
);
