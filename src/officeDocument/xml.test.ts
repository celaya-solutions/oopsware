import { describe, expect, it } from "vitest";

import {
  attr,
  child,
  decodeXmlBytes,
  parseXml,
  scanXml,
  type XmlElement,
} from "./xml.js";

const parse = (text: string): XmlElement => {
  const result = parseXml(text);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

const problem = (text: string) => {
  const result = parseXml(text);
  if (result.ok) throw new Error("Expected a problem.");
  return result.error;
};

describe("Office XML reader", () => {
  it("resolves prefixes, default namespaces and prefixed attributes", () => {
    const root = parse(
      `<?xml version="1.0"?><a:root xmlns:a="urn:a" xmlns="urn:d" xmlns:q="urn:q" q:id="7" plain="x"><item/><a:item>t</a:item></a:root>`,
    );
    expect(root).toMatchObject({ ns: "urn:a", local: "root" });
    expect(attr(root, "id", "urn:q")).toBe("7");
    expect(attr(root, "plain")).toBe("x");
    expect(root.children.map((entry) => `${entry.ns}|${entry.local}`)).toEqual([
      "urn:d|item",
      "urn:a|item",
    ]);
    expect(child(root, "urn:a", "item")?.text).toBe("t");
  });

  it("maps strict namespaces to the transitional ones", () => {
    const root = parse(
      `<w:p xmlns:w="http://purl.oclc.org/ooxml/wordprocessingml/main"/>`,
    );
    expect(root.ns).toBe(
      "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    );
  });

  it("decodes predefined entities and character references, and normalizes line ends", () => {
    const root = parse(
      `<r a="1&amp;2&#x41;&#66;&#10;">&lt;x&gt; &quot;&apos;\r\nz<![CDATA[<raw>&]]></r>`,
    );
    expect(attr(root, "a")).toBe("1&2AB ");
    expect(root.text).toBe(`<x> "'\nz<raw>&`);
  });

  it("refuses a DOCTYPE and any entity it would declare", () => {
    const bomb = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;&a;">]><lolz>&b;</lolz>`;
    expect(problem(bomb).code).toBe("doctype");
    expect(problem(`<r>&b;</r>`)).toMatchObject({ code: "not_well_formed" });
    expect(problem(`<r>&#0;</r>`)).toMatchObject({ code: "not_well_formed" });
    expect(problem(`<!ENTITY x "y"><r/>`).code).toBe("doctype");
  });

  it("reports malformed markup instead of recovering", () => {
    for (const text of [
      `<a><b></a></b>`,
      `<a>`,
      `<a/><b/>`,
      `text<a/>`,
      `<a/>tail`,
      `<q:a/>`,
      `<a x="1" x="2"/>`,
      `<a x=1/>`,
      `<a x="<"/>`,
      `<a><!-- open</a>`,
      ``,
    ])
      expect(problem(text).code, text).toBe("not_well_formed");
  });

  it("stops at the depth and element limits", () => {
    const deep = `${"<a>".repeat(300)}${"</a>".repeat(300)}`;
    expect(problem(deep).code).toBe("too_deep");
    const wide = `<r>${"<c/>".repeat(100)}</r>`;
    const limited = parseXml(wide, {
      maxBytes: 1_000_000,
      maxNodes: 50,
      maxDepth: 8,
    });
    expect(limited.ok).toBe(false);
    if (!limited.ok) expect(limited.error.code).toBe("too_many_nodes");
  });

  it("decodes UTF-8 and UTF-16 with a byte order mark and refuses other bytes", () => {
    const utf8 = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode("<r>é</r>"),
    ]);
    const decoded8 = decodeXmlBytes(utf8);
    expect(decoded8.ok && decoded8.value).toBe("<r>é</r>");
    const utf16 = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from("<r>é</r>", "utf16le"),
    ]);
    const decoded16 = decodeXmlBytes(utf16);
    expect(decoded16.ok && decoded16.value).toBe("<r>é</r>");
    const bad = decodeXmlBytes(new Uint8Array([0x3c, 0xff, 0xfe, 0x3e]));
    expect(bad.ok).toBe(false);
    const big = decodeXmlBytes(new Uint8Array(20), {
      maxBytes: 10,
      maxNodes: 1,
      maxDepth: 1,
    });
    expect(big.ok).toBe(false);
  });

  it("scans without keeping children so a large part stays flat", () => {
    let seen = 0;
    const root: { value?: XmlElement } = {};
    const result = scanXml(
      `<r>${"<c>1</c>".repeat(1000)}</r>`,
      {
        start(element) {
          root.value ??= element;
        },
        end(element) {
          if (element.local === "c") seen += 1;
        },
      },
      undefined,
      false,
    );
    expect(result.ok && result.value.elements).toBe(1001);
    expect(seen).toBe(1000);
    expect(root.value?.children).toHaveLength(0);
  });
});
