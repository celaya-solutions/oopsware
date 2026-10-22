import { expect, it } from "vitest";
import { parseXmlDocument } from "./xmlDocument.js";

it.each([
  '<root attr="�">😀 � &amp; &#xFFFD;</root>',
  "<root><!-- � --><![CDATA[�]]></root>",
  '<?xml version="1.0"?><root>\r\n  �\rtext</root>',
  "<!DOCTYPE root><root>�</root>",
  '<!DOCTYPE root [<!ENTITY unused "�">]><root>�</root>',
])("preserves legal Unicode and source-located DOM nodes: %j", (source) => {
  const parsed = parseXmlDocument(source, {
    doctype: "allow",
    lineEndings: "preserve",
  });
  if (!parsed.ok) throw parsed.error;
  expect(parsed.value.documentElement?.tagName).toBe("root");
  expect(parsed.value.documentElement?.lineNumber).toBeDefined();
  expect(parsed.value.documentElement?.textContent).toContain("�");
});

it.each([
  "<root attr=unquoted>�</root>",
  '<root a="x"b="�"/>',
  '<root attr="a" attr="�"/>',
  "<root><broken>�</root>",
  "<root>� & unknown</root>",
  "<root>� &missing;</root>",
  "<root>�\u0000</root>",
  "<root>�&#xD800;</root>",
  "<root>�\uFFFF</root>",
  "<root>�]]></root>",
  "<root><!-- invalid -- comment � --></root>",
  "<root>�</root><second/>",
  "<!DOCTYPE root [BOGUS]><root>�</root>",
  "<!DOCTYPE root [<!ELEMENT broken>]><root>�</root>",
  "<!DOCTYPE root SYSTEM><root>�</root>",
])("rejects malformed XML without warning-message matching: %j", (source) => {
  const parsed = parseXmlDocument(source, {
    doctype: "allow",
    lineEndings: "preserve",
  });
  expect(parsed.ok).toBe(false);
  if (parsed.ok) throw new Error("Expected refusal");
  expect(parsed.error.reason).toBe("malformed");
  expect(parsed.error.cause).toBeDefined();
});

it("keeps literal line endings and character-reference values distinct", () => {
  const parsed = parseXmlDocument("<root>\r\n&#13;\r�</root>", {
    doctype: "allow",
    lineEndings: "preserve",
  });
  if (!parsed.ok) throw parsed.error;
  expect(parsed.value.documentElement?.textContent).toBe("\r\n\r\r�");
});

it("applies the consumer's explicit DTD policy", () => {
  const parsed = parseXmlDocument(
    '<!DOCTYPE root [<!ENTITY value "unused">]><root/>',
    { doctype: "reject", lineEndings: "preserve" },
  );
  expect(parsed.ok).toBe(false);
  if (parsed.ok) throw new Error("Expected unsupported DTD");
  expect(parsed.error.reason).toBe("doctype");
});

it("applies XML line-ending normalization only when the consumer selects it", () => {
  const parsed = parseXmlDocument('<root attr="a\r\nb">\r\nx</root>', {
    doctype: "allow",
    lineEndings: "normalize",
  });
  if (!parsed.ok) throw parsed.error;
  expect(parsed.value.documentElement?.getAttribute("attr")).toBe("a b");
  expect(parsed.value.documentElement?.textContent).toBe("\nx");
});
