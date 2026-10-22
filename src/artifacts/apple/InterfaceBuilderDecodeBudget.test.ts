import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { buildBinary } from "plist";
import { describe, expect, it } from "vitest";

import { analyzeInterfaceBuilderBundle } from "./InterfaceBuilderAnalysis.js";
import { preflightPropertyListDecode } from "./InterfaceBuilderDecodeBudget.js";
import { parseXmlPropertyList } from "../../domain/propertyListKeys.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";

const example = "<!DOCTYPE document [ harmless example ]>";

it.each([
  [
    "XML",
    Buffer.from(
      "<plist><array><integer>9007199254740993</integer></array></plist>",
    ),
  ],
  ["binary", Buffer.from(buildBinary([9007199254740992]))],
] as const)(
  "reserves %s number metadata and value projection before decoding",
  (_format, bytes) => {
    const ordinary = preflightPropertyListDecode(
      bytes,
      1024 * 1024,
    ).estimatedBytes;
    const projected = preflightPropertyListDecode(
      bytes,
      1024 * 1024,
      undefined,
      { numberProjection: true },
    ).estimatedBytes;
    if (_format === "binary")
      expect(projected).toBeGreaterThanOrEqual(ordinary + bytes.length);
    expect(() =>
      preflightPropertyListDecode(bytes, ordinary, undefined, {
        numberProjection: true,
      }),
    ).toThrow(/budget/u);
    expect(() =>
      preflightPropertyListDecode(bytes, 1024 * 1024, undefined, {
        numberProjection: true,
      }),
    ).not.toThrow();
  },
);
const archive = (content: string, comment = "") =>
  `<?xml version="1.0"?><plist version="1.0">${comment}<dict><key>$archiver</key><string>NSKeyedArchiver</string><key>$objects</key><array><string>$null</string><dict><key>$class</key><dict><key>CF$UID</key><integer>2</integer></dict><key>title</key><string>${content}</string></dict><dict><key>$classname</key><string>NSButton</string><key>$classes</key><array><string>NSButton</string><string>NSObject</string></array></dict></array><key>$top</key><dict><key>root</key><dict><key>CF$UID</key><integer>1</integer></dict></dict></dict></plist>`;

const inertDeclarations = [
  {
    kind: "CDATA text",
    xml: archive(`<![CDATA[${example}]]>`),
    title: example,
  },
  {
    kind: "XML comment",
    xml: archive("Build", `<!-- ${example} -->`),
    title: "Build",
  },
] as const;

describe("inert XML declaration examples in Interface Builder archives", () => {
  it.each(inertDeclarations)(
    "preflights $kind without treating it as entity expansion",
    ({ xml }) => {
      expect(() => parseXmlPropertyList(xml)).not.toThrow();
      expect(
        preflightPropertyListDecode(Buffer.from(xml), 16 * 1024 * 1024),
      ).toMatchObject({
        binaryPrototypeKeyObserved: false,
      });
    },
  );

  it.each(inertDeclarations)(
    "retains $kind and archive provenance through bundle decoding",
    async ({ xml, title }) => {
      const root = await createTestTempDirectory("rea-ib-inert-declaration-");
      const bundle = join(root, "Example.app");
      await mkdir(bundle);
      const bytes = Buffer.from(xml);
      await writeFile(join(bundle, "Panel.nib"), bytes);

      const result = await analyzeInterfaceBuilderBundle({
        bundlePath: bundle,
        targetSha256: "a".repeat(64),
      });

      expect(result.documents).toContainEqual(
        expect.objectContaining({
          relative_path: "Panel.nib",
          archive_sha256: createHash("sha256").update(bytes).digest("hex"),
        }),
      );
      expect(result.graph.nodes.map(({ name }) => name)).toContain(title);
      expect(result.graph.coverage).toContainEqual(
        expect.objectContaining({
          facet: "archive_decode",
          status: "complete",
        }),
      );
    },
  );

  it("continues to refuse an actual internal entity declaration before decoding", () => {
    const xml = archive("&harmless;").replace(
      "<plist",
      '<!DOCTYPE plist [<!ENTITY harmless "value">]><plist',
    );
    expect(() =>
      preflightPropertyListDecode(Buffer.from(xml), 16 * 1024 * 1024),
    ).toThrow(
      "XML plist internal entity expansion exceeds the aggregate Interface Builder decode budget",
    );
  });

  it("does not mistake a bracket in a quoted external identifier for an internal subset", () => {
    const xml = archive("Build").replace(
      "<plist",
      '<!DOCTYPE plist SYSTEM "example[edition].dtd"><plist',
    );
    expect(() => parseXmlPropertyList(xml)).not.toThrow();
    expect(() =>
      preflightPropertyListDecode(Buffer.from(xml), 16 * 1024 * 1024),
    ).not.toThrow();
  });

  it.each([
    '<!DOCTYPE plist SYSTEM "example>[edition].dtd">',
    "<!DOCTYPE plist SYSTEM 'example>[edition].dtd'>",
    "<?example <!DOCTYPE document [ harmless example ]> ?>",
  ])("consumes quoted or opaque declaration text once: %s", (declaration) => {
    const xml = archive("Build").replace("<plist", `${declaration}<plist`);
    expect(() => parseXmlPropertyList(xml)).not.toThrow();
    expect(
      preflightPropertyListDecode(Buffer.from(xml), 16 * 1024 * 1024),
    ).toMatchObject({ binaryPrototypeKeyObserved: false });
  });
});
