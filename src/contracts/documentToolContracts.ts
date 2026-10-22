import {
  inspectDocumentInputSchema,
  structuredTextDocumentSchema,
} from "../domain/document/structuredText.js";
import type { ToolContract } from "./toolContractTypes.js";
import { toolContractMetadata } from "./toolEffects.js";
import { evidenceResultOf } from "./toolOutputSchemaPrimitives.js";

/** Structured-text documents (format expansion F11), independent of binary targets. */
export const DOCUMENT_TOOL_CONTRACTS = [
  {
    name: "inspect_document",
    ...toolContractMetadata("inspect_document"),
    kind: "artifact-provider",
    description:
      "Read one explicit local structured-text document (Markdown, JSON, JSON Lines, YAML, TOML, XML, CSV, TSV or plain text) in process and return its parsed structure as a page of nodes, each with path, kind, exact source value and line/column/byte location. Detects the profile from the name suffix unless format is given, decodes UTF-8, UTF-16 or Windows-1252 from a byte-order mark, XML declaration or explicit encoding, and lists undecodable byte offsets. Parse failures are findings with exact locations, not empty results: JSON Lines and CSV keep valid records before an error, JSON numbers keep their source text, duplicate keys are listed, YAML aliases are never expanded and tags never constructed, XML DTDs/entities/XInclude are never processed or fetched. The file is never rewritten. TOML values carry no source location.",
    inputSchema: inspectDocumentInputSchema,
    outputSchema: evidenceResultOf(structuredTextDocumentSchema),
    examples: [
      {
        title: "Read the structure of a local JSON file",
        input: { path: "/artifacts/config.json" },
      },
      {
        title: "Read a semicolon-separated export as CSV, second page",
        input: {
          path: "/artifacts/export.txt",
          format: "csv",
          delimiter: ";",
          start: 500,
          limit: 500,
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
