import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { DecodeBudget } from "../../artifacts/zipMemberView.js";
import { CompoundFile } from "../../windowsInstaller/cfb.js";
import {
  writeCompoundFile,
  type CfbNode,
} from "../../../tests/fixtures/cfbWriter.js";
import { ReaderCounters } from "../reader.js";
import { LegacyStreams } from "./legacy.js";
import {
  classifyLegacy,
  collectorSinks,
  newCollected,
  summarizeLegacy,
} from "./legacyPackage.js";
import { readLegacyProperties } from "./properties.js";

/** A property set encoder written from [MS-OLEPS], independent of the reader. */
const u16 = (n: number): Buffer => {
  const out = Buffer.alloc(2);
  out.writeUInt16LE(n);
  return out;
};
const u32 = (n: number): Buffer => {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(n >>> 0);
  return out;
};
const pad4 = (bytes: Buffer): Buffer =>
  Buffer.concat([bytes, Buffer.alloc((4 - (bytes.length % 4)) % 4)]);

const lpstr = (text: string): Buffer => {
  const body = Buffer.concat([Buffer.from(text, "latin1"), Buffer.from([0])]);
  return pad4(Buffer.concat([u16(0x1e), u16(0), u32(body.length), body]));
};
const lpwstr = (text: string): Buffer => {
  const body = Buffer.concat([Buffer.from(text, "utf16le"), Buffer.alloc(2)]);
  return pad4(Buffer.concat([u16(0x1f), u16(0), u32(body.length / 2), body]));
};
const i4 = (n: number): Buffer => Buffer.concat([u16(3), u16(0), u32(n)]);
const i2 = (n: number): Buffer => pad4(Buffer.concat([u16(2), u16(0), u16(n)]));
const filetime = (iso: string): Buffer => {
  const ticks = (BigInt(Date.parse(iso)) + 11_644_473_600_000n) * 10_000n;
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(ticks);
  return Buffer.concat([u16(0x40), u16(0), out]);
};
const duration = (minutes: bigint): Buffer => {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(minutes * 600_000_000n);
  return Buffer.concat([u16(0x40), u16(0), out]);
};
const lpstrVector = (items: string[]): Buffer =>
  Buffer.concat([
    u16(0x101e),
    u16(0),
    u32(items.length),
    ...items.map((item) => {
      // Code page strings in a vector are not padded (checked against real Office files).
      const body = Buffer.concat([
        Buffer.from(item, "latin1"),
        Buffer.from([0]),
      ]);
      return Buffer.concat([u32(body.length), body]);
    }),
  ]);

const guidBytes = (text: string): Buffer => {
  const parts = text.split("-");
  const out = Buffer.alloc(16);
  out.writeUInt32LE(parseInt(parts[0] ?? "0", 16), 0);
  out.writeUInt16LE(parseInt(parts[1] ?? "0", 16), 4);
  out.writeUInt16LE(parseInt(parts[2] ?? "0", 16), 6);
  Buffer.from((parts[3] ?? "") + (parts[4] ?? ""), "hex").copy(out, 8);
  return out;
};

interface Property {
  readonly id: number;
  readonly value: Buffer;
}

const section = (properties: readonly Property[]): Buffer => {
  const head = 8 + properties.length * 8;
  const offsets: number[] = [];
  let at = head;
  for (const property of properties) {
    offsets.push(at);
    at += property.value.length;
  }
  return Buffer.concat([
    u32(at),
    u32(properties.length),
    ...properties.flatMap((property, index) => [
      u32(property.id),
      u32(offsets[index] ?? 0),
    ]),
    ...properties.map((property) => property.value),
  ]);
};

const propertyStream = (
  sets: readonly { fmtid: string; properties: readonly Property[] }[],
): Uint8Array => {
  const header = Buffer.concat([
    u16(0xfffe),
    u16(0),
    u32(0x00020006),
    Buffer.alloc(16),
    u32(sets.length),
  ]);
  const bodies = sets.map((set) => section(set.properties));
  let offset = header.length + sets.length * 20;
  const table: Buffer[] = [];
  bodies.forEach((body, index) => {
    table.push(guidBytes(sets[index]?.fmtid ?? ""), u32(offset));
    offset += body.length;
  });
  return new Uint8Array(Buffer.concat([header, ...table, ...bodies]));
};

const SUMMARY = "f29f85e0-4ff9-1068-ab91-08002b27b3d9";
const DOCUMENT = "d5cdd502-2e9c-101b-9397-08002b2cf9ae";
const USER = "d5cdd505-2e9c-101b-9397-08002b2cf9ae";

describe("legacy property sets", () => {
  it("maps SummaryInformation, DocumentSummaryInformation and user-defined properties", () => {
    const summary = propertyStream([
      {
        fmtid: SUMMARY,
        properties: [
          { id: 1, value: i2(1252) },
          { id: 2, value: lpstr("Quarterly café plan") },
          { id: 3, value: lpstr("Budget") },
          { id: 4, value: lpstr("A. Writer") },
          { id: 5, value: lpstr("plan; budget") },
          { id: 6, value: lpstr("first draft") },
          { id: 7, value: lpstr("Normal.dot") },
          { id: 8, value: lpstr("B. Editor") },
          { id: 9, value: lpstr("7") },
          { id: 10, value: duration(125n) },
          { id: 12, value: filetime("2024-03-04T05:06:07.000Z") },
          { id: 13, value: filetime("2024-05-06T07:08:09.000Z") },
          { id: 14, value: i4(3) },
          { id: 15, value: i4(1200) },
          { id: 18, value: lpstr("Microsoft Word") },
          { id: 19, value: i4(1) },
        ],
      },
    ]);
    const documentSummary = propertyStream([
      {
        fmtid: DOCUMENT,
        properties: [
          { id: 1, value: i2(1252) },
          { id: 2, value: lpstr("Finance") },
          { id: 14, value: lpstr("C. Manager") },
          { id: 15, value: lpwstr("Example Co") },
          { id: 23, value: i4((11 << 16) | 8) },
          { id: 13, value: lpstrVector(["Sheet one", "Sheet", "Sheet three"]) },
        ],
      },
      {
        fmtid: USER,
        properties: [
          { id: 1, value: i2(1252) },
          {
            id: 0,
            value: Buffer.concat([
              u32(2),
              u32(2),
              u32(8),
              Buffer.from("Project\0", "latin1"),
              u32(3),
              u32(5),
              Buffer.from("Code\0", "latin1"),
            ]),
          },
          { id: 2, value: lpstr("Falcon") },
          { id: 3, value: i4(42) },
        ],
      },
    ]);
    const read = readLegacyProperties(summary, documentSummary);
    expect(read.problems).toEqual([]);
    expect(read.core).toEqual({
      title: "Quarterly café plan",
      subject: "Budget",
      creator: "A. Writer",
      keywords: "plan; budget",
      description: "first draft",
      last_modified_by: "B. Editor",
      revision: "7",
      created: "2024-03-04T05:06:07.000Z",
      modified: "2024-05-06T07:08:09.000Z",
      category: "Finance",
    });
    expect(read.app).toEqual({
      Template: "Normal.dot",
      TotalTime: "125",
      Pages: "3",
      Words: "1200",
      Application: "Microsoft Word",
      DocSecurity: "1",
      Manager: "C. Manager",
      Company: "Example Co",
      AppVersion: "11.0008",
      TitlesOfParts: "Sheet one; Sheet; Sheet three",
    });
    expect(read.custom).toEqual([
      { name: "Project", type: "lpstr", value: "Falcon" },
      { name: "Code", type: "i4", value: "42" },
    ]);
    expect(read.customTotal).toBe(2);
  });

  it("reports damage as problems and never throws or allocates by a declared count", () => {
    const truncated = new Uint8Array(
      propertyStream([
        { fmtid: SUMMARY, properties: [{ id: 2, value: lpstr("Title") }] },
      ]).subarray(0, 60),
    );
    expect(() => readLegacyProperties(truncated, undefined)).not.toThrow();

    // A string whose declared length is far beyond the stream.
    const lying = propertyStream([
      {
        fmtid: SUMMARY,
        properties: [
          { id: 2, value: Buffer.concat([u16(0x1e), u16(0), u32(0x7fffffff)]) },
          { id: 4, value: lpstr("Still read") },
        ],
      },
    ]);
    const read = readLegacyProperties(lying, undefined);
    expect(read.core["creator"]).toBe("Still read");
    expect(read.core["title"]).toBeUndefined();
    expect(read.problems.join(" ")).toContain("Property 2");

    // A property count the section cannot hold.
    const many = Buffer.from(
      propertyStream([{ fmtid: SUMMARY, properties: [] }]),
    );
    many.writeUInt32LE(0x7fffffff, 28 + 20 + 4);
    expect(
      readLegacyProperties(new Uint8Array(many), undefined).problems.join(" "),
    ).toContain("declares");

    expect(
      readLegacyProperties(new Uint8Array(10), undefined).problems,
    ).toHaveLength(1);
    expect(
      readLegacyProperties(new Uint8Array(64), undefined).problems.join(" "),
    ).toContain("byte order");
  });

  it("treats a zero FILETIME as not set", () => {
    const zero = Buffer.concat([u16(0x40), u16(0), Buffer.alloc(8)]);
    const read = readLegacyProperties(
      propertyStream([
        { fmtid: SUMMARY, properties: [{ id: 12, value: zero }] },
      ]),
      undefined,
    );
    expect(read.core).toEqual({});
  });
});

describe("legacy property set regressions from real files", () => {
  it("cuts a string at its first NUL, so padding and all-NUL values leave no residue", () => {
    const padded = Buffer.concat([
      u16(0x1e),
      u16(0),
      u32(6),
      Buffer.from("Ann\0\0\0", "latin1"),
    ]);
    const allNul = Buffer.concat([u16(0x1e), u16(0), u32(3), Buffer.alloc(3)]);
    const read = readLegacyProperties(
      propertyStream([
        { fmtid: SUMMARY, properties: [{ id: 4, value: pad4(padded) }] },
      ]),
      propertyStream([
        { fmtid: DOCUMENT, properties: [{ id: 15, value: pad4(allNul) }] },
      ]),
    );
    expect(read.core["creator"]).toBe("Ann");
    expect(read.app["Company"]).toBeUndefined();
  });

  it("reads an LPSTR in a UTF-16 set as UTF-16 with a two-byte terminator", () => {
    const hi = Buffer.concat([
      u16(0x1e),
      u16(0),
      u32(6),
      Buffer.from("Hi", "utf16le"),
      Buffer.alloc(2),
    ]);
    const read = readLegacyProperties(
      propertyStream([
        {
          fmtid: SUMMARY,
          properties: [
            { id: 1, value: i2(1200) },
            { id: 2, value: pad4(hi) },
            { id: 4, value: lpwstr("Next") },
          ],
        },
      ]),
      undefined,
    );
    expect(read.core["title"]).toBe("Hi");
    expect(read.core["creator"]).toBe("Next");
  });

  it("names a code page it cannot decode instead of guessing silently", () => {
    const read = readLegacyProperties(
      propertyStream([
        {
          fmtid: SUMMARY,
          properties: [
            { id: 1, value: i2(54936 - 65536 * 0) },
            { id: 2, value: lpstr("abc") },
          ],
        },
      ]),
      undefined,
    );
    expect(read.problems.join(" ")).toContain("code page 54936");
  });

  it("maps the MS-OSHARED ids from 0x13 up", () => {
    const read = readLegacyProperties(
      undefined,
      propertyStream([
        {
          fmtid: DOCUMENT,
          properties: [
            {
              id: 0x13,
              value: Buffer.concat([u16(11), u16(0), u16(0xffff), u16(0)]),
            },
            { id: 0x14, value: lpstr("http://base/") },
            {
              id: 0x16,
              value: Buffer.concat([u16(11), u16(0), u16(0), u16(0)]),
            },
            { id: 0x17, value: i4((12 << 16) | 0) },
          ],
        },
      ]),
    );
    expect(read.app).toMatchObject({
      SharedDoc: "true",
      HyperlinkBase: "http://base/",
      HyperlinksChanged: "false",
      AppVersion: "12.0000",
    });
  });
});

const open = async (
  nodes: readonly CfbNode[],
): Promise<{ streams: LegacyStreams; file: CompoundFile }> => {
  const bytes = writeCompoundFile(nodes);
  const file = await CompoundFile.open(
    async (offset, length) => bytes.subarray(offset, offset + length),
    bytes.length,
  );
  return {
    file,
    streams: new LegacyStreams(
      file,
      new DecodeBudget(64 * 1024 ** 2, 64 * 1024 ** 2),
    ),
  };
};

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("legacy package summary", () => {
  it("decides the kind from the main stream and not from the file name", async () => {
    const word = await open([{ name: "WordDocument", data: bytesOf("w") }]);
    const excel = await open([{ name: "Book", data: bytesOf("b") }]);
    const slides = await open([
      { name: "PowerPoint Document", data: bytesOf("p") },
    ]);
    const other = await open([{ name: "Contents", data: bytesOf("c") }]);
    expect(classifyLegacy(word.streams)?.kind).toBe("doc");
    expect(classifyLegacy(excel.streams)?.kind).toBe("xls");
    expect(classifyLegacy(slides.streams)?.kind).toBe("ppt");
    expect(classifyLegacy(other.streams)).toBeNull();
  });

  it("lists macros, objects and signatures with a hash of their streams and flags a disagreeing name", async () => {
    const vbaA = bytesOf('Attribute VB_Name = "ThisDocument"');
    const vbaB = bytesOf("project stream");
    const native = bytesOf("packager bytes");
    const { streams, file } = await open([
      { name: "WordDocument", data: bytesOf("word") },
      {
        name: "Macros",
        children: [
          { name: "PROJECT", data: vbaB },
          { name: "VBA", children: [{ name: "ThisDocument", data: vbaA }] },
        ],
      },
      {
        name: "ObjectPool",
        children: [
          {
            name: "_1234",
            children: [{ name: "\u0001Ole10Native", data: native }],
          },
        ],
      },
      { name: "\u0005DigitalSignature", data: bytesOf("sig") },
    ]);
    const counters = new ReaderCounters();
    const collected = newCollected();
    const summary = await summarizeLegacy(
      streams,
      "report.docx",
      file.problems,
      counters,
      collected,
      undefined,
    );
    const facts = summary?.finish();
    expect(summary?.kind).toBe("doc");
    expect(facts?.macro_enabled).toBe(true);
    expect(facts?.name_conflict).toContain(".docx");
    expect(facts?.notable_total).toBe(3);
    const byKind = new Map(facts?.notable.map((item) => [item.kind, item]));
    const project = byKind.get("macro-project");
    expect(project?.part).toBe("Macros");
    expect(project?.bytes).toBe(vbaA.length + vbaB.length);
    // Directory order sorts shorter names first: the VBA storage (3 letters) before PROJECT (7).
    expect(project?.sha256).toBe(
      createHash("sha256").update(vbaA).update(vbaB).digest("hex"),
    );
    expect(byKind.get("embedded-package")?.part).toBe("ObjectPool/_1234");
    expect(byKind.get("macro-signature")?.part).toBe("\\x05DigitalSignature");
    expect(counters.counts["macro_project_parts"]).toBe(1);
  });

  it("collects reader declarations once each and counts what it cannot list", () => {
    const counters = new ReaderCounters();
    const collected = newCollected();
    const sinks = collectorSinks(collected, counters);
    sinks.external({
      source: "body",
      kind: "hyperlink",
      target: "https://example.com/a",
      id: "1",
    });
    sinks.external({
      source: "body",
      kind: "hyperlink",
      target: "https://example.com/a",
      id: "2",
    });
    sinks.notable({
      kind: "macro-sheet",
      part: "Macro1",
      content_type: null,
      bytes: 0,
      sha256: null,
      note: null,
    });
    expect(collected.externalTotal).toBe(1);
    expect(collected.macroFound).toBe(true);
    expect(collected.notableTotal).toBe(1);
  });
  it("declares document signature storages and project signature streams at any depth", async () => {
    const { streams, file } = await open([
      { name: "WordDocument", data: bytesOf("word") },
      {
        name: "_xmlsignatures",
        children: [{ name: "sig1", data: bytesOf("x") }],
      },
      { name: "_signatures", data: bytesOf("y") },
      {
        name: "Macros",
        children: [
          { name: "VBA", children: [{ name: "Mod", data: bytesOf("m") }] },
          { name: "\u0005DigitalSignatureEx", data: bytesOf("s") },
        ],
      },
    ]);
    const summary = await summarizeLegacy(
      streams,
      "signed.doc",
      file.problems,
      new ReaderCounters(),
      newCollected(),
      undefined,
    );
    const kinds = (summary?.finish().notable ?? []).map(
      (item) => `${item.kind}:${item.part}`,
    );
    expect(kinds).toContain("digital-signature:_xmlsignatures");
    expect(kinds).toContain("digital-signature:_signatures");
    expect(kinds).toContain("macro-signature:Macros/\\x05DigitalSignatureEx");
    expect(kinds).toContain("macro-project:Macros");
  });
});
