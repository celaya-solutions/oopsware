import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { DecodeBudget, MemberReadFailure } from "../artifacts/zipMemberView.js";
import { decodeFilters } from "./filters.js";
import {
  asArray,
  asDict,
  asName,
  asString,
  END,
  isKeyword,
  Lexer,
  OBJECT_LIMITS,
  PdfSyntaxError,
  readIndirectObject,
  type PdfValue,
} from "./syntax.js";
import { textString } from "./text.js";

const bytes = (text: string): Uint8Array =>
  Uint8Array.from(text, (char) => char.charCodeAt(0) & 0xff);
const value = (text: string): PdfValue => {
  const parsed = new Lexer(bytes(text)).readValue();
  if (parsed === END || isKeyword(parsed))
    throw new Error(`no value in ${text}`);
  return parsed;
};
const budget = () => new DecodeBudget(1024 ** 3, 256 * 1024 ** 2);

describe("PDF syntax", () => {
  it("reads numbers, references and keywords apart", () => {
    expect(value("42")).toBe(42);
    expect(value("-3.5")).toBe(-3.5);
    expect(value(".5")).toBe(0.5);
    expect(value("12 0 R")).toEqual({ t: "ref", num: 12, gen: 0 });
    expect(asArray(value("[1 2 3 R 4]"))?.items).toEqual([
      1,
      { t: "ref", num: 2, gen: 3 },
      4,
    ]);
  });

  it("does not take 1 0 RG for a reference", () => {
    const lexer = new Lexer(bytes("1 0 0 RG"));
    expect([
      lexer.readValue(),
      lexer.readValue(),
      lexer.readValue(),
      lexer.readValue(),
    ]).toEqual([1, 0, 0, { t: "kw", v: "RG" }]);
  });

  it("decodes names with #xx escapes and keeps invalid ones", () => {
    expect(asName(value("/A#20B"))).toBe("A B");
    expect(asName(value("/Name#zz"))).toBe("Name#zz");
    expect(asName(value("/"))).toBe("");
  });

  it("decodes literal strings: escapes, octal, continuations, nesting and EOL folding", () => {
    const text = (source: string) =>
      Buffer.from(asString(value(source))?.bytes ?? []).toString("latin1");
    expect(text("(a\\nb\\)c)")).toBe("a\nb)c");
    expect(text("(\\101\\60\\7)")).toBe("A0\u0007");
    expect(text("(a\\\r\nb)")).toBe("ab");
    expect(text("(a(b)c)")).toBe("a(b)c");
    expect(text("(a\r\nb)")).toBe("a\nb");
    expect(text("(\\400)")).toBe("\u0000");
  });

  it("decodes hex strings, ignoring white space and padding an odd digit", () => {
    expect([...(asString(value("<48 65 6C6c 6F7>"))?.bytes ?? [])]).toEqual([
      0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x70,
    ]);
  });

  it("skips comments and keeps the last of duplicate dictionary keys", () => {
    const dict = asDict(value("<< /A 1 % ignored\n /A 2 /B (x) >>"));
    expect(dict?.map.get("A")).toBe(2);
    expect(dict?.map.size).toBe(2);
  });

  it("closes a dictionary that runs into endobj and marks the lexer truncated", () => {
    const lexer = new Lexer(bytes("<< /A 1 /B [1 2 endobj"));
    const parsed = lexer.readValue();
    expect(asDict(parsed as PdfValue)?.map.get("A")).toBe(1);
    expect(lexer.truncated).toBe(true);
  });

  it("refuses containers nested past the depth limit and tokens past the node limit", () => {
    expect(() => new Lexer(bytes("[".repeat(500))).readValue()).toThrow(
      PdfSyntaxError,
    );
    const small = { ...OBJECT_LIMITS, maxNodes: 50 };
    expect(() =>
      new Lexer(
        bytes(`[${"1 ".repeat(100)}]`),
        0,
        undefined,
        small,
      ).readValue(),
    ).toThrow(PdfSyntaxError);
  });

  it("refuses a string longer than the limit", () => {
    const small = { ...OBJECT_LIMITS, maxStringBytes: 8 };
    expect(() =>
      new Lexer(bytes("(0123456789abcdef)"), 0, undefined, small).readValue(),
    ).toThrow(PdfSyntaxError);
    expect(() =>
      new Lexer(
        bytes("<303132333435363738394041424344>"),
        0,
        undefined,
        small,
      ).readValue(),
    ).toThrow(PdfSyntaxError);
  });

  it("reads an indirect object and its stream start", () => {
    const parsed = readIndirectObject(
      bytes("7 0 obj\n<< /Length 3 >>\nstream\r\nabc\nendstream\nendobj"),
      0,
    );
    expect(parsed?.num).toBe(7);
    expect(parsed?.value).toMatchObject({ t: "stream", start: 32, num: 7 });
    expect(readIndirectObject(bytes("7 0 object"), 0)).toBeNull();
    expect(readIndirectObject(bytes("seven 0 obj"), 0)).toBeNull();
    expect(readIndirectObject(bytes("3 0 obj null endobj"), 0)).toMatchObject({
      value: null,
      damaged: false,
    });
    expect(readIndirectObject(bytes("3 0 obj << /A 1 >> "), 0)?.damaged).toBe(
      true,
    );
  });
});

describe("PDF text strings", () => {
  it("decodes UTF-16, UTF-8 and PDFDocEncoding", () => {
    const str = (...codes: number[]) => ({
      t: "str" as const,
      bytes: Uint8Array.from(codes),
    });
    expect(textString(str(0xfe, 0xff, 0x00, 0x41, 0x26, 0x3a))).toBe("A☺");
    expect(textString(str(0xff, 0xfe, 0x41, 0x00))).toBe("A");
    expect(textString(str(0xef, 0xbb, 0xbf, 0xe2, 0x98, 0xba))).toBe("☺");
    expect(textString(str(0x41, 0x80, 0xa0, 0x18))).toBe("A•€˘");
  });
});

describe("PDF filters", () => {
  const raw = bytes("hello hello hello hello");

  it("inflates Flate data and tolerates a truncated stream", () => {
    const packed = new Uint8Array(deflateSync(raw));
    expect(
      decodeFilters(packed, ["FlateDecode"], [], budget(), "x"),
    ).toMatchObject({ state: "complete" });
    expect(
      Buffer.from(
        decodeFilters(packed, ["Fl"], [], budget(), "x").bytes,
      ).toString("latin1"),
    ).toBe("hello hello hello hello");
    const cut = decodeFilters(
      packed.subarray(0, packed.length - 6),
      ["FlateDecode"],
      [],
      budget(),
      "x",
    );
    // A cut-off stream keeps what decoded before the cut and says it is not whole.
    expect(cut.state).toBe("truncated");
    expect(cut.note).toContain("ends early");
    expect(cut.bytes.length).toBeGreaterThan(0);
    expect(cut.bytes.length).toBeLessThan(raw.length + 1);
  });

  it("reports damaged Flate data without throwing", () => {
    const decoded = decodeFilters(
      bytes("not zlib at all"),
      ["FlateDecode"],
      [],
      budget(),
      "x",
    );
    expect(decoded.state).toBe("damaged");
    expect(decoded.note).toContain("FlateDecode");
  });

  it("stops a Flate bomb at the decoding budget", () => {
    const bomb = new Uint8Array(deflateSync(new Uint8Array(8 * 1024 ** 2)));
    expect(() =>
      decodeFilters(
        bomb,
        ["FlateDecode"],
        [],
        new DecodeBudget(1024 ** 2, 256 * 1024 ** 2),
        "bomb",
      ),
    ).toThrow(MemberReadFailure);
  });

  it("decodes ASCIIHex, ASCII85 and RunLength", () => {
    expect(
      Buffer.from(
        decodeFilters(
          bytes("48 65 6C 6C 6F>"),
          ["ASCIIHexDecode"],
          [],
          budget(),
          "x",
        ).bytes,
      ).toString(),
    ).toBe("Hello");
    expect(
      Buffer.from(
        decodeFilters(
          bytes('87cURD]i,"Ebo80~>'),
          ["ASCII85Decode"],
          [],
          budget(),
          "x",
        ).bytes,
      ).toString(),
    ).toBe("Hello World!");
    expect([
      ...decodeFilters(
        Uint8Array.from([2, 1, 2, 3, 254, 9, 128]),
        ["RunLengthDecode"],
        [],
        budget(),
        "x",
      ).bytes,
    ]).toEqual([1, 2, 3, 9, 9, 9]);
  });

  it("decodes the LZW example from the specification", () => {
    const encoded = Uint8Array.from([
      0x80, 0x0b, 0x60, 0x50, 0x22, 0x0c, 0x0c, 0x85, 0x01,
    ]);
    expect(
      Buffer.from(
        decodeFilters(encoded, ["LZWDecode"], [], budget(), "x").bytes,
      ).toString(),
    ).toBe("-----A---B");
  });

  it("applies PNG up and TIFF predictors", () => {
    const parms = {
      t: "dict" as const,
      map: new Map<string, PdfValue>([
        ["Predictor", 12],
        ["Columns", 3],
      ]),
    };
    // Two rows of three bytes, each stored with the "Up" filter byte 2.
    const packed = new Uint8Array(
      deflateSync(Uint8Array.from([2, 1, 2, 3, 2, 1, 1, 1])),
    );
    expect([
      ...decodeFilters(packed, ["FlateDecode"], [parms], budget(), "x").bytes,
    ]).toEqual([1, 2, 3, 2, 3, 4]);
    const tiff = {
      t: "dict" as const,
      map: new Map<string, PdfValue>([
        ["Predictor", 2],
        ["Columns", 3],
      ]),
    };
    const flat = new Uint8Array(
      deflateSync(Uint8Array.from([1, 1, 1, 5, 1, 1])),
    );
    expect([
      ...decodeFilters(flat, ["FlateDecode"], [tiff], budget(), "x").bytes,
    ]).toEqual([1, 2, 3, 5, 6, 7]);
  });

  it("stops at image filters and unknown filters, and says which", () => {
    expect(
      decodeFilters(bytes("jpeg"), ["DCTDecode"], [], budget(), "x"),
    ).toMatchObject({ state: "image", filters: ["DCTDecode"] });
    expect(
      decodeFilters(bytes("x"), ["Crypt"], [], budget(), "x"),
    ).toMatchObject({ state: "unsupported" });
  });
});
