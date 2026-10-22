import { describe, expect, it } from "vitest";

import {
  structuredTextDocumentSchema,
  type StructuralNode,
} from "../../domain/document/structuredText.js";
import {
  DocumentFormatUnresolvedError,
  readStructuredText,
  type StructuredTextRequest,
} from "./readStructuredText.js";

const read = (
  name: string,
  content: string | Uint8Array,
  options: Partial<StructuredTextRequest> = {},
  segments = false,
) => {
  const result = readStructuredText(
    {
      bytes:
        typeof content === "string" ? Buffer.from(content, "utf8") : content,
      name,
      start: 0,
      limit: 2000,
      ...options,
    },
    { segments },
  );
  if (!result.ok) throw result.error;
  // Every reading must satisfy the public output contract.
  structuredTextDocumentSchema.parse({
    artifact: { path: `/fixtures/${name}`, sha256: "0".repeat(64), bytes: 0 },
    ...result.value.reading,
  });
  return result.value;
};

const nodes = (name: string, content: string | Uint8Array, options = {}) =>
  read(name, content, options).reading.nodes;

const byPath = (list: readonly StructuralNode[], path: string) =>
  list.find((node) => node.path === path);

describe("JSON", () => {
  it("keeps big integers as source text and lists duplicate keys", () => {
    const text =
      '{"id": 12345678901234567890, "id": 2, "é": [1.50, true, null]}';
    const { reading } = read("data.json", text);
    const second = text.indexOf('"id"', 2);
    const bracket = text.indexOf("[");
    expect(reading.parse.status).toBe("parsed");
    const ids = reading.nodes.filter((node) => node.path === "/id");
    expect(ids.map((node) => node.value)).toEqual([
      "12345678901234567890",
      "2",
    ]);
    expect(ids[0]?.details.float64_exact).toBe(false);
    expect(reading.diagnostics).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: "json_duplicate_key",
        location: { line: 1, column: second + 1, offset: second },
      }),
    ]);
    // "é" is two UTF-8 bytes: the array after it sits one byte later than its column.
    const array = byPath(reading.nodes, "/é");
    expect(array?.location).toEqual({
      line: 1,
      column: bracket + 1,
      offset: bracket + 1,
    });
    expect(byPath(reading.nodes, "/é/0")?.value).toBe("1.50");
    expect(array?.details.children).toBe(3);
  });

  it("reports the exact error location and keeps structure before it", () => {
    const { reading } = read("broken.json", '{\n  "a": 1,\n  "b": [2,,]\n}');
    expect(reading.parse.status).toBe("partial");
    expect(byPath(reading.nodes, "/a")?.value).toBe("1");
    const error = reading.diagnostics.find(
      ({ severity }) => severity === "error",
    );
    expect(error?.code).toBe("json_syntax");
    expect(error?.location?.line).toBe(3);
    expect(
      reading.coverage.find(({ facet }) => facet === "inspect")?.state,
    ).toBe("partial");
  });

  it("fails explicitly on comments and empty input", () => {
    expect(read("c.json", '{"a":1} // no').reading.parse.status).not.toBe(
      "parsed",
    );
    expect(read("empty.json", "").reading.parse.status).toBe("failed");
  });

  it("reports deep nesting instead of crashing", () => {
    const { reading } = read("deep.json", "[".repeat(200_000));
    expect(reading.parse.status).not.toBe("parsed");
    expect(
      reading.diagnostics.some(({ severity }) => severity === "error"),
    ).toBe(true);
  });
});

describe("JSON Lines", () => {
  it("names the bad record and keeps every valid record", () => {
    const { reading } = read(
      "events.jsonl",
      '{"n":1}\n{"n":2}\n{"n":\n{"n":4}\n',
    );
    expect(reading.parse).toMatchObject({ status: "partial", records: 4 });
    const records = reading.nodes.filter(({ kind }) => kind === "record");
    expect(records.map(({ details }) => details.valid)).toEqual([
      true,
      true,
      false,
      true,
    ]);
    const error = reading.diagnostics.find(
      ({ severity }) => severity === "error",
    );
    expect(error).toMatchObject({ record: 3, location: { line: 3 } });
    expect(
      reading.nodes
        .filter(({ path, kind }) => path === "/n" && kind === "number")
        .map(({ value }) => value),
    ).toEqual(["1", "2", "4"]);
  });
});

describe("YAML", () => {
  it("never expands aliases, so alias amplification stays linear", () => {
    const levels = ["a: &a [x, x, x, x, x, x, x, x, x]"];
    for (let level = 1; level < 9; level += 1)
      levels.push(
        `${String.fromCharCode(97 + level)}: &${String.fromCharCode(97 + level)} [${Array(
          9,
        )
          .fill(`*${String.fromCharCode(96 + level)}`)
          .join(", ")}]`,
      );
    const { reading } = read("laughs.yaml", `${levels.join("\n")}\n`);
    expect(reading.parse.status).toBe("parsed");
    expect(reading.node_count).toBeLessThan(200);
    expect(reading.nodes.filter(({ kind }) => kind === "alias")).toHaveLength(
      72,
    );
    expect(
      reading.diagnostics.some(
        ({ code }) => code === "yaml_aliases_not_expanded",
      ),
    ).toBe(true);
  });

  it("reports executable tags without constructing them, and duplicate keys", () => {
    const { reading } = read(
      "evil.yml",
      "run: !!python/object/apply:os.system ['id']\nkey: 1\nkey: 2\n",
    );
    expect(reading.diagnostics.map(({ code }) => code)).toEqual(
      expect.arrayContaining(["yaml_unresolved_tag", "yaml_duplicate_key"]),
    );
    expect(reading.parse.status).toBe("partial");
  });

  it("keeps anchors, tags, documents and exact integers", () => {
    const { reading } = read(
      "multi.yaml",
      "--- &root\nbig: 12345678901234567890\nnothing:\n---\n- !!str 5\n",
    );
    expect(reading.parse.records).toBe(2);
    expect(byPath(reading.nodes, "/big")?.value).toBe("12345678901234567890");
    expect(byPath(reading.nodes, "/nothing")).toMatchObject({
      value: null,
      details: { type: "null" },
    });
    expect(byPath(reading.nodes, "/0")?.details.tag).toBe(
      "tag:yaml.org,2002:str",
    );
    expect(
      reading.nodes.find(({ kind }) => kind === "mapping")?.details.anchor,
    ).toBe("root");
  });
});

describe("TOML", () => {
  it("keeps integer and date types", () => {
    const { reading } = read(
      "config.toml",
      "big = 9007199254740993\nwhen = 1979-05-27T07:32:00-07:00\nday = 1979-05-27\nat = 07:32:00\n[server]\nports = [80, 443.5]\n",
    );
    expect(reading.parse.status).toBe("parsed");
    expect(byPath(reading.nodes, "/big")).toMatchObject({
      kind: "integer",
      value: "9007199254740993",
    });
    expect(byPath(reading.nodes, "/when")?.kind).toBe("offset-datetime");
    expect(byPath(reading.nodes, "/day")?.kind).toBe("local-date");
    expect(byPath(reading.nodes, "/at")?.kind).toBe("local-time");
    expect(byPath(reading.nodes, "/server/ports/1")?.kind).toBe("float");
    expect(
      reading.coverage.find(({ facet }) => facet === "inspect"),
    ).toMatchObject({
      state: "partial",
      omitted: "Source locations of TOML values.",
    });
  });

  it("reports duplicate keys with their location", () => {
    const { reading } = read("dup.toml", "a = 1\na = 2\n");
    expect(reading.parse.status).toBe("failed");
    expect(reading.diagnostics[0]).toMatchObject({
      code: "toml_syntax",
      location: { line: 2 },
    });
  });
});

describe("XML", () => {
  it("refuses DTD entity expansion and never fetches external entities", () => {
    const { reading } = read(
      "xxe.xml",
      '<?xml version="1.0"?>\n<!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd"><!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;">]>\n<r>&x;&b;</r>',
    );
    expect(reading.parse.status).toBe("partial");
    expect(reading.diagnostics.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        "xml_dtd_internal_subset_refused",
        "xml_undefined_entity",
      ]),
    );
    const text = reading.nodes.find(({ kind }) => kind === "text");
    expect(text?.value).not.toContain("root:");
    expect(text?.value).not.toContain("aaaaaaaaaa");
    expect(
      reading.nodes.find(({ kind }) => kind === "doctype")?.details,
    ).toMatchObject({
      internal_subset: true,
      fetched: false,
    });
  });

  it("records an external DTD without fetching it", () => {
    const { reading } = read(
      "ext.xml",
      '<!DOCTYPE r SYSTEM "http://example.invalid/r.dtd"><r/>',
    );
    expect(reading.parse.status).toBe("parsed");
    expect(reading.diagnostics[0]?.code).toBe("xml_external_dtd_not_fetched");
    // The identifier is the literal, without the quotes around it.
    expect(
      reading.nodes.find(({ kind }) => kind === "doctype")?.details.system_id,
    ).toBe("http://example.invalid/r.dtd");
  });

  it("keeps namespaces, attribute order and source positions", () => {
    const { reading } = read(
      "ns.xml",
      '<r xmlns:x="urn:x">\r\n  <x:a z="1" b="2">t&amp;<![CDATA[<c>]]></x:a><!--n--><?pi d?>\n  <xi:include xmlns:xi="http://www.w3.org/2001/XInclude" href="other.xml"/>\n</r>',
    );
    const element = byPath(reading.nodes, "/r[1]/x:a[1]");
    expect(element).toMatchObject({
      details: { namespace: "urn:x", prefix: "x", local_name: "a" },
      location: { line: 2, column: 3, offset: 23 },
    });
    expect(
      reading.nodes
        .filter(
          ({ kind, path }) =>
            kind === "attribute" && path.startsWith("/r[1]/x:a[1]/@"),
        )
        .map(({ name }) => name),
    ).toEqual(["z", "b"]);
    expect(reading.nodes.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining([
        "text",
        "cdata",
        "comment",
        "processing-instruction",
      ]),
    );
    expect(reading.diagnostics.map(({ code }) => code)).toContain(
      "xml_xinclude_not_resolved",
    );
  });

  it("fails with a location on malformed XML", () => {
    const { reading } = read("bad.xml", "<r>\n  <a></r>");
    expect(reading.parse.status).toBe("failed");
    expect(reading.diagnostics[0]).toMatchObject({
      code: "xml_not_well_formed",
      location: { line: 2 },
    });
  });
});

describe("CSV and TSV", () => {
  it("handles BOM, quoted delimiters and newlines, uneven rows and formulas", () => {
    const { reading } = read(
      "table.csv",
      '\uFEFFname,note\n"a,b","two\nlines"\n"=HYPERLINK(""http://x"")",-5,extra\n',
    );
    expect(reading.encoding).toMatchObject({ name: "utf-8", bom_bytes: 3 });
    expect(reading.parse).toMatchObject({ status: "parsed", records: 3 });
    const rows = reading.nodes;
    expect(rows[1]).toMatchObject({
      fields: ["a,b", "two\nlines"],
      location: { line: 2, column: 1, offset: 13 },
    });
    expect(rows[2]).toMatchObject({
      record: 3,
      location: { line: 4 },
      details: { field_count: 3, formula_like_cells: 1 },
    });
    expect(reading.diagnostics.map(({ code }) => code)).toEqual([
      "delimited_uneven_row",
      "delimited_formula_like_cell",
    ]);
  });

  it("stops at a malformed quote, naming the row and keeping rows before it", () => {
    const { reading } = read("bad.csv", 'a,b\n1,2\n"open,3\n4,5\n');
    expect(reading.parse.status).toBe("partial");
    expect(reading.nodes.map(({ fields }) => fields)).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(reading.diagnostics.at(-1)).toMatchObject({
      severity: "error",
      record: 3,
    });
  });

  it("uses tab for TSV and an explicit delimiter when chosen", () => {
    expect(nodes("t.tsv", "a\tb\n1\t2\n")[1]?.fields).toEqual(["1", "2"]);
    expect(
      nodes("semi.csv", "a;b\n1;2\n", { delimiter: ";" })[1]?.fields,
    ).toEqual(["1", "2"]);
  });
});

describe("encodings and plain text", () => {
  it("counts each newline style and keeps line offsets", () => {
    const { reading } = read("notes.txt", "one\r\ntwo\rthree\nfour");
    expect(reading.encoding.newlines).toEqual({ lf: 1, crlf: 1, cr: 1 });
    expect(reading.encoding).toMatchObject({ lines: 4, final_newline: false });
    expect(
      reading.nodes.map(({ value, details }) => [value, details.newline]),
    ).toEqual([
      ["one", "crlf"],
      ["two", "cr"],
      ["three", "lf"],
      ["four", null],
    ]);
    expect(reading.nodes[3]?.location).toEqual({
      line: 4,
      column: 1,
      offset: 15,
    });
  });

  it("identifies undecodable UTF-8 bytes and their offsets", () => {
    const bytes = Buffer.concat([
      Buffer.from("ok "),
      Buffer.from([0xff]),
      Buffer.from(" é "),
      Buffer.from([0xe2, 0x82]),
      Buffer.from("\nnext"),
    ]);
    const { reading } = read("mixed.txt", bytes);
    expect(reading.encoding.undecodable).toEqual([
      { offset: 3, bytes: 1 },
      { offset: 8, bytes: 2 },
    ]);
    expect(reading.parse.status).toBe("partial");
    expect(reading.nodes[1]?.location?.offset).toBe(11);
  });

  it("does not parse a strict format whose bytes do not decode", () => {
    const { reading } = read("bad.json", Buffer.from([0x7b, 0xff, 0x7d]));
    expect(reading.parse.status).toBe("failed");
    expect(reading.node_count).toBe(0);
  });

  it("decodes an explicit Windows-1252 choice and UTF-16 with a BOM", () => {
    expect(
      nodes("latin.txt", Buffer.from([0x63, 0x61, 0x66, 0xe9]), {
        encoding: "windows-1252",
      })[0]?.value,
    ).toBe("café");
    const utf16 = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from("a\nbé", "utf16le"),
    ]);
    const { reading } = read("wide.txt", utf16);
    expect(reading.encoding).toMatchObject({
      name: "utf-16le",
      basis: "byte-order-mark",
    });
    expect(reading.nodes[1]).toMatchObject({
      value: "bé",
      location: { line: 2, offset: 6 },
    });
  });

  it("honours an XML encoding declaration", () => {
    const bytes = Buffer.concat([
      Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?><r>caf'),
      Buffer.from([0xe9]),
      Buffer.from("</r>"),
    ]);
    const { reading } = read("latin.xml", bytes);
    expect(reading.encoding).toMatchObject({
      name: "windows-1252",
      basis: "xml-declaration",
      declared: "ISO-8859-1",
    });
    expect(reading.nodes.find(({ kind }) => kind === "text")?.value).toBe(
      "café",
    );
  });
});

describe("Markdown", () => {
  it("outlines blocks and refuses unsafe links and remote images", () => {
    const { reading } = read(
      "README.md",
      "# Title\n\nText <script>alert(1)</script> [ok](https://example.com) [bad](javascript:alert(1))\n\n## Part\n\n![pixel](https://tracker.invalid/p.gif)\n\n```sh\nrm -rf /\n```\n",
    );
    expect(reading.parse.status).toBe("parsed");
    const links = reading.nodes.filter(({ kind }) => kind === "link");
    expect(
      links.map(({ value, details }) => [value, details.rendered_as_link]),
    ).toEqual([
      ["https://example.com", true],
      ["javascript:alert(1)", false],
    ]);
    expect(
      reading.nodes.find(({ kind }) => kind === "image")?.details.fetched,
    ).toBe(false);
    expect(
      reading.nodes.find(({ kind }) => kind === "code-block"),
    ).toMatchObject({
      path: "Title › Part",
      value: "rm -rf /\n",
      location: { line: 9 },
    });
    expect(reading.diagnostics.map(({ code }) => code)).toEqual([
      "markdown_raw_html_as_text",
      "markdown_link_refused",
    ]);
  });
});

describe("paging and reading segments", () => {
  it("returns a node page with an exact continuation", () => {
    const text = Array.from(
      { length: 30 },
      (_, index) => `line ${String(index)}`,
    ).join("\n");
    const { reading } = read("many.txt", text, { start: 10, limit: 5 });
    expect(reading.node_count).toBe(30);
    expect(reading.page).toEqual({
      start: 10,
      limit: 5,
      returned: 5,
      next: 15,
    });
    expect(reading.nodes.map(({ index }) => index)).toEqual([
      10, 11, 12, 13, 14,
    ]);
  });

  it("aligns segments to whole records and falls back to bytes for one huge line", () => {
    const record = `{"value":"${"x".repeat(1000)}"}\n`;
    const { segments } = read("big.jsonl", record.repeat(40), {}, true);
    expect(segments?.length).toBeGreaterThan(1);
    for (const segment of segments ?? []) {
      expect(segment.unit).toBe("record");
      expect(segment.complete_units).toBe(true);
      expect((segment.end - segment.start) % record.length).toBe(0);
    }
    const huge = read("one.txt", "y".repeat(100_000), {}, true).segments ?? [];
    expect(huge.map(({ unit }) => unit)).toContain("bytes");
    expect(huge.at(-1)?.end).toBe(100_000);
  });
});

describe("format selection", () => {
  it("requires a format when the name hints none, and keeps a disagreeing hint", () => {
    const missing = readStructuredText({
      bytes: Buffer.from("x"),
      name: "notes.bin",
      start: 0,
      limit: 10,
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok)
      expect(missing.error).toBeInstanceOf(DocumentFormatUnresolvedError);
    const { reading } = read("data.json", "a,b\n", { format: "csv" });
    expect(reading.format).toEqual({
      profile: "csv",
      basis: "requested",
      extension: ".json",
      name_hint: "json",
    });
  });
});

describe("wide, deep and long-named structure", () => {
  // More children than one function call accepts as spread arguments.
  const WIDE = 200_000;

  it("reads collections wider than a call's argument limit", () => {
    for (const [name, content, count] of [
      ["wide.yaml", "- 1\n".repeat(WIDE), WIDE + 2],
      ["wide.xml", `<r>${"<a/>".repeat(WIDE)}</r>`, WIDE + 1],
      ["wide.toml", `a = [${"1,".repeat(WIDE)}1]\n`, WIDE + 3],
    ] as const) {
      const { reading } = read(name, content, { limit: 1 });
      expect(reading.parse.status).toBe("parsed");
      expect(reading.node_count).toBe(count);
    }
  });

  it("stops at the depth limit with a located error, in linear time", () => {
    const xml = read(
      "deep.xml",
      `${"<a>".repeat(50_000)}${"</a>".repeat(50_000)}`,
      { limit: 1 },
    ).reading;
    expect(xml.parse.status).toBe("partial");
    expect(xml.node_count).toBe(1001);
    expect(xml.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "nesting_too_deep",
        location: { line: 1, column: 3004, offset: 3003 },
      }),
    );
    const json = read(
      "deep.json",
      `${"[".repeat(1500)}${"]".repeat(1500)}`,
    ).reading;
    expect(json.node_count).toBe(1001);
    expect(json.diagnostics[0]?.code).toBe("nesting_too_deep");
  });

  it("fails only the JSON Lines record that nests too deeply", () => {
    const { reading } = read(
      "deep.jsonl",
      `${"[".repeat(1500)}${"]".repeat(1500)}\n{"ok":1}\n`,
    );
    const records = reading.nodes.filter(({ kind }) => kind === "record");
    expect(records.map(({ details }) => details.valid)).toEqual([false, true]);
    expect(reading.diagnostics[0]).toMatchObject({
      code: "nesting_too_deep",
      record: 1,
    });
  });

  it("cuts and marks paths so one long key is not copied into every descendant", () => {
    const key = "k".repeat(5000);
    const { reading } = read("long.json", `{"${key}":[1,2,3]}`);
    const array = reading.nodes.find(({ kind }) => kind === "array");
    expect(array?.name).toBe(key);
    const leaves = reading.nodes.filter(({ kind }) => kind === "number");
    expect(leaves).toHaveLength(3);
    for (const leaf of [array, ...leaves]) {
      expect(leaf?.path).toHaveLength(1024);
      expect(leaf?.details.path_cut).toBe(true);
    }
    const markdown = read("long.md", `# ${"h".repeat(5000)}\n\ntext\n`).reading
      .nodes;
    expect(markdown.map(({ details }) => details.path_cut)).toEqual([
      true,
      true,
    ]);
    expect(
      read("short.json", '{"a":[1]}').reading.nodes.some(
        ({ details }) => details.path_cut !== undefined,
      ),
    ).toBe(false);
  });
});
