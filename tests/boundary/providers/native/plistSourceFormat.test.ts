import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { inspectPlistSchema } from "../../../../src/domain/native/nativeInspection.js";
import { ok } from "../../../../src/domain/result.js";
import { NativeMacOSProvider } from "../../../../src/native/NativeMacOSProvider.js";
import {
  NativeFixtureRunner,
  nativeMachoTarget,
} from "../../../fixtures/nativeCommands.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

const VALUE = { Name: "Example", Items: ["a", "b"] };
const XML =
  "<plist><dict><key>Name</key><string>Example</string><key>Items</key><array><string>a</string><string>b</string></array><key>Blob</key><data>3q2+7w==</data></dict></plist>";
const DATA = { $plist_type: "data", base64: "3q2+7w==" };

class PlistSourceRunner extends NativeFixtureRunner {
  constructor(
    description: string,
    private readonly xmlFallback: boolean,
    private readonly convertedXml: string = XML,
  ) {
    super({ file: description, plutil: JSON.stringify(VALUE) });
  }

  override async run(tool: string, arguments_: readonly string[]) {
    const result = await super.run(tool, arguments_);
    if (!result.ok || tool !== "plutil" || !this.xmlFallback) return result;
    const json = arguments_.includes("json");
    const stdout = json ? "" : this.convertedXml;
    return ok({
      ...result.value,
      stdout,
      stdoutBytes: Buffer.byteLength(stdout),
      exitCode: json ? 1 : 0,
    });
  }
}

const OPENSTEP = "{ Name = Example; Items = (a, b); }\n";

interface PlistSourceCase {
  readonly description: string;
  readonly contents?: string | Buffer;
  readonly expected: string;
  readonly xmlFallback: boolean;
  readonly convertedXml?: string;
  readonly expectedValue?: unknown;
}

it.for<PlistSourceCase>([
  { description: "ASCII text\n", expected: "unknown", xmlFallback: false },
  {
    description: "JSON text data\n",
    contents: JSON.stringify(VALUE),
    expected: "json",
    xmlFallback: false,
  },
  ...["<deadbeef>\n", "<de ad\nbe ef>\n", "<>\n"].map((contents) => ({
    description: "ASCII text\n",
    contents,
    expected: "unknown",
    xmlFallback: true,
    convertedXml: `<plist><data>${contents.startsWith("<>") ? "" : DATA.base64}</data></plist>`,
    expectedValue: {
      ...DATA,
      base64: contents.startsWith("<>") ? "" : DATA.base64,
    },
  })),
  // `file` reports XML without a declaration as plain text.
  {
    description: "ASCII text, with no line terminators\n",
    contents: `﻿ \n${XML}`,
    expected: "xml",
    xmlFallback: true,
  },
  {
    description: "ASCII text\n",
    contents: `<!-- source plist -->\n${XML}`,
    expected: "xml",
    xmlFallback: true,
  },
  ...[false, true].map((bigEndian) => ({
    description: `Unicode text, UTF-16, ${bigEndian ? "big" : "little"}-endian text\n`,
    contents: bigEndian
      ? Buffer.from(`\uFEFF${XML}`, "utf16le").swap16()
      : Buffer.from(`\uFEFF${XML}`, "utf16le"),
    expected: "xml",
    xmlFallback: true,
  })),
  { description: "ASCII text\n", expected: "unknown", xmlFallback: true },
  {
    description: "Unicode text, UTF-8 text\n",
    expected: "unknown",
    xmlFallback: false,
  },
  {
    description: "XML 1.0 document text, ASCII text\n",
    expected: "xml",
    xmlFallback: false,
  },
  {
    description:
      "XML 1.0 document text, Unicode text, UTF-16, big-endian text\n",
    expected: "xml",
    xmlFallback: true,
  },
  {
    description: "Apple binary property list\n",
    expected: "binary",
    xmlFallback: true,
  },
])(
  "keeps source format $expected for $description (XML fallback: $xmlFallback)",
  async (
    {
      description,
      contents = OPENSTEP,
      expected,
      xmlFallback,
      convertedXml = XML,
      expectedValue = { ...VALUE, ...(xmlFallback ? { Blob: DATA } : {}) },
    },
    { onTestFinished },
  ) => {
    const root = await createTestTempDirectory("rea-plist-source-format-");
    const path = join(root, "selected.plist");
    await writeFile(path, contents);
    const client = new NativeMacOSProvider(
      {},
      new PlistSourceRunner(description, xmlFallback, convertedXml),
      "darwin",
    ).createClient(nativeMachoTarget(join(root, "target")));
    onTestFinished(async () => {
      const closed = await client.close();
      if (!closed.ok) throw closed.error;
    });

    const inspected = await client.execute("inspect_plist", { path });
    if (!inspected.ok) throw inspected.error;
    const result = inspectPlistSchema.parse(inspected.value.result);
    expect(result.format).toBe(expected);
    expect(result.source_path).toBe(path);
    expect(result.value).toEqual(expectedValue);
    expect(result.provenance.map(({ tool }) => tool)).toEqual(
      xmlFallback ? ["file", "plutil", "plutil"] : ["file", "plutil"],
    );
    expect(result.limitations).toEqual(
      xmlFallback ? [expect.stringContaining("XML conversion")] : [],
    );
  },
);
