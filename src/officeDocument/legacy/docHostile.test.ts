import { describe, expect, it } from "vitest";

import { officeDocumentReportSchema } from "../../domain/officeDocument/officeDocument.js";
import {
  FCLCB,
  SPRM,
  buildDoc,
  compound,
  diagnosticText as messages,
  inspectDoc as run,
  paragraphTexts as texts,
  prl,
  readDoc as read,
  type BuiltDoc,
  type DocParagraph,
  type DocSpec,
} from "../../../tests/fixtures/legacyDocProducers.js";

const refusal = async (bytes: Uint8Array): Promise<string> => {
  const result = await run(bytes);
  if (result.ok) throw new Error("Expected the inspection to fail.");
  expect(result.error._tag).toBe("AnalysisUnsupportedTargetError");
  return String((result.error as { reason?: string }).reason);
};

/** Edit copies of a built document's streams, then wrap them again. */
const patched = (
  built: BuiltDoc,
  edit: (
    word: DataView,
    table: DataView,
    at: (index: number) => { fc: number; lcb: number },
  ) => void,
  tableName: "0Table" | "1Table" = "1Table",
): Uint8Array => {
  const word = built.word.slice();
  const table = built.table.slice();
  edit(
    new DataView(word.buffer),
    new DataView(table.buffer),
    (index) => built.entries.get(index) ?? { fc: 0, lcb: 0 },
  );
  return compound(word, table, tableName);
};

const setEntry = (
  built: BuiltDoc,
  word: DataView,
  index: number,
  fc: number,
  lcb: number,
): void => {
  word.setUint32(built.blobAt + index * 8, fc, true);
  word.setUint32(built.blobAt + index * 8 + 4, lcb, true);
};

const PIECES: DocSpec = {
  body: [
    { runs: ["alpha one"] },
    { runs: ["beta two"] },
    { runs: ["gamma three"] },
  ],
  pieces: [
    { at: 0, compressed: true },
    { at: 10, compressed: false },
    { at: 19, compressed: true },
  ],
};

/** Offsets of piece i's CP and Pcd in the table stream (no property groups before the PlcPcd). */
const pcd = (built: BuiltDoc, count: number, piece: number) => {
  const clx = built.entries.get(FCLCB.clx)?.fc ?? 0;
  return {
    cp: clx + 5 + piece * 4,
    fc: clx + 5 + (count + 1) * 4 + piece * 8 + 2,
  };
};

/** Replace a document's piece table: `region` is appended to the WordDocument stream and pieces point into it. */
describe("legacy Word reader on damaged input", () => {
  it("refuses a WordDocument stream it cannot read at all", async () => {
    const built = buildDoc({ body: [{ runs: ["x"] }] });
    expect(
      await refusal(compound(built.word.slice(0, 20), built.table)),
    ).toContain("too short");
    expect(
      await refusal(patched(built, (word) => word.setUint16(0, 0x1234, true))),
    ).toContain("wIdent");
    expect(
      await refusal(compound(built.word.slice(0, 200), built.table)),
    ).toContain("cut off");
    expect(await refusal(patched(built, () => {}, "0Table"))).toContain(
      "names the 1Table stream",
    );
    expect(
      await refusal(
        buildDoc({ body: [{ runs: ["x"] }], omit: [FCLCB.clx] }).bytes,
      ),
    ).toContain("no piece table");
    const clx = built.entries.get(FCLCB.clx) ?? { fc: 0, lcb: 0 };
    expect(
      await refusal(
        patched(built, (_w, table) => table.setUint8(clx.fc, 0x07)),
      ),
    ).toContain("unexpected byte");
    expect(
      await refusal(
        patched(built, (word) =>
          setEntry(built, word, FCLCB.clx, clx.fc, 0xffffffff),
        ),
      ),
    ).toContain("runs past");
    expect(
      await refusal(
        patched(built, (_w, table) => table.setUint32(clx.fc + 1, 15, true)),
      ),
    ).toContain("whole number of pieces");
  });

  it("leaves out damaged pieces and keeps the rest of the text", async () => {
    const built = buildDoc(PIECES);
    const outside = await read(
      patched(built, (_w, table) =>
        table.setUint32(pcd(built, 3, 1).fc, 0x3fff0000, true),
      ),
    );
    expect(texts(outside)).toEqual(["alpha one", "gamma three"]);
    expect(messages(outside)).toContain(
      "outside the WordDocument stream or share bytes",
    );
    expect(messages(outside)).toContain("not in the piece table");

    const shared = await read(
      patched(built, (_w, table) => {
        const first = table.getUint32(pcd(built, 3, 0).fc, true);
        table.setUint32(pcd(built, 3, 2).fc, first, true);
      }),
    );
    expect(texts(shared)).toEqual(["alpha one", "beta two"]);
    expect(messages(shared)).toContain("share bytes");

    const disorder = await read(
      patched(built, (_w, table) =>
        table.setUint32(pcd(built, 3, 2).cp, 5, true),
      ),
    );
    expect(texts(disorder)).toEqual(["alpha one"]);
    expect(messages(disorder)).toContain("2 of 3 pieces are out of order");

    const longer = await read(
      patched(built, (word) => word.setUint32(76, 0x7fffffff, true)),
    );
    expect(texts(longer)).toEqual(["alpha one", "beta two", "gamma three"]);
    expect(messages(longer)).toContain("covers 31 characters");
  });

  it("uses default properties when property pages are damaged and falls back to plain paragraphs without PAPX", async () => {
    const table: DocParagraph[] = [
      { runs: ["A1"], pap: prl(SPRM.inTable, 1), end: "\u0007" },
      {
        runs: [],
        pap: [...prl(SPRM.inTable, 1), ...prl(SPRM.ttp, 1)],
        end: "\u0007",
      },
      { runs: [{ text: "hidden", chp: prl(SPRM.vanish, 1) }] },
    ];
    const built = buildDoc({ body: table });
    const chpx = built.entries.get(FCLCB.plcfBteChpx) ?? { fc: 0, lcb: 0 };
    const pnAt = chpx.fc + 8;
    const pn = new DataView(built.table.buffer).getUint32(pnAt, true);
    const pastEnd = await read(
      patched(built, (_w, t) => t.setUint32(pnAt, 0x3fffff, true)),
    );
    expect(texts(pastEnd)).toEqual(["hidden"]);
    expect(pastEnd.items[1]).toMatchObject({
      kind: "paragraph",
      hidden: false,
    });
    expect(messages(pastEnd)).toContain("outside the WordDocument stream");

    const badCrun = await read(
      patched(built, (word) => word.setUint8(pn * 512 + 511, 0)),
    );
    expect(messages(badCrun)).toContain("crun 0 is out of range");
    const badOffset = await read(
      patched(built, (word) =>
        word.setUint8(pn * 512 + 4 * (word.getUint8(pn * 512 + 511) + 1), 1),
      ),
    );
    expect(messages(badOffset)).toContain("lies outside the page");

    const noPapx = await read(
      buildDoc({ body: table, omit: [FCLCB.plcfBtePapx] }).bytes,
    );
    expect(noPapx.items.map((item) => item.kind)).toEqual([
      "paragraph",
      "paragraph",
      "paragraph",
    ]);
    expect(texts(noPapx)).toEqual(["A1", "", "hidden"]);
    expect(messages(noPapx)).toContain(
      "Paragraph properties are not available",
    );

    const papx = built.entries.get(FCLCB.plcfBtePapx) ?? { fc: 0, lcb: 0 };
    const papPn = new DataView(built.table.buffer).getUint32(papx.fc + 8, true);
    const badCpara = await read(
      patched(built, (word) => word.setUint8(papPn * 512 + 511, 0x7f)),
    );
    expect(messages(badCpara)).toContain("cpara 127 is out of range");
    expect(texts(badCpara)).toEqual(["A1", "", "hidden"]);
  });
});

describe("legacy Word reader on damaged indexes and styles", () => {
  it("survives broken text PLCs, a cyclic stylesheet and declared sizes far beyond the stream", async () => {
    const spec: DocSpec = {
      body: [
        {
          runs: ["Body", { text: "\u0005", chp: prl(SPRM.spec, 1) }],
          istd: 15,
        },
      ],
      comments: [
        { author: "A", initials: "A", paragraphs: [{ runs: ["note"] }] },
      ],
      headers: [[[], [{ runs: ["Head"] }], [], [], [], []]],
      styles: [
        ...Array.from({ length: 15 }, () => null),
        { name: "Loop A", base: 16 },
        { name: "Loop B", base: 15, chp: prl(SPRM.vanish, 1) },
      ],
    };
    const built = buildDoc(spec);
    const report = await read(
      patched(built, (word, table, at) => {
        setEntry(built, word, FCLCB.plcfHdd, at(FCLCB.plcfHdd).fc, 3);
        table.setUint32(at(FCLCB.plcfandTxt).fc + 4, 0, true);
        setEntry(built, word, FCLCB.plcfSed, 0x7fff0000, 0x7fff0000);
      }),
      { view: "package" },
    );
    expect(report.content_parts.map((part) => [part.id, part.label])).toEqual([
      ["body", "Document body"],
      ["comments", "Comments"],
      ["header", "Headers and footers"],
    ]);
    const all = messages(report);
    expect(all).toContain("header story index cannot be read");
    expect(all).toContain("inherits from itself");
    expect(all).toContain("runs past the");
    const comments = await read(
      patched(built, (_w, table, at) =>
        table.setUint32(at(FCLCB.plcfandTxt).fc + 4, 0, true),
      ),
      { view: "content", part: "comments" },
    );
    // Without its index the comment story reads as paragraphs, its closing extra mark included.
    expect(comments.items.map((item) => item.kind)).toEqual([
      "paragraph",
      "paragraph",
    ]);
    expect(texts(comments)).toEqual(["note", ""]);
    const body = await read(built.bytes);
    expect(body.items[0]).toMatchObject({ style: "Loop A", hidden: true });

    const stsh = built.entries.get(FCLCB.stshf) ?? { fc: 0, lcb: 0 };
    const brokenStyles = await read(
      patched(built, (_w, table) =>
        table.setUint16(stsh.fc + 20, 0xfff0, true),
      ),
    );
    expect(texts(brokenStyles)).toEqual(["Body"]);
    expect(messages(brokenStyles)).toContain(
      "style definitions could not be read",
    );
  });

  it("reads paragraphs whose Data stream properties are missing or loop", async () => {
    const built = buildDoc({
      body: [
        { runs: ["A1"], pap: prl(SPRM.inTable, 1), end: "\u0007", huge: true },
        { runs: ["tail"] },
      ],
    });
    const missing = await read(compound(built.word, built.table));
    expect(texts(missing)).toEqual(["A1", "tail"]);
    expect(messages(missing)).toContain("which the file does not have");
    // A PrcData whose only Prl is sprmPHugePapx pointing back at itself.
    const loop = Uint8Array.of(6, 0, 0x46, 0x66, 0, 0, 0, 0);
    const looped = await read(
      compound(built.word, built.table, "1Table", [
        { name: "Data", data: loop },
      ]),
    );
    expect(texts(looped)).toEqual(["A1", "tail"]);
    expect(messages(looped)).toContain("does not hold them as declared");
  });
});

describe("legacy Word reader on hostile fields, encodings and sizes", () => {
  it("bounds deep and unclosed fields and reads bad UTF-16 as replacement characters", async () => {
    const deep = "\u0013".repeat(200) + "x" + "\u0014y\u0015".repeat(200);
    const report = await read(
      buildDoc({
        body: [
          { runs: [deep] },
          { runs: ["bad \ud800 pair \udc00 end"] },
          { runs: ["open \u0013 HYPERLINK unclosed"] },
        ],
        pieces: [{ at: 0, compressed: false }],
      }).bytes,
    );
    // Each inner result belongs to the instruction around it; only the outermost result is text.
    expect(texts(report)).toEqual(["y", "bad \ufffd pair \ufffd end", "open "]);
    expect(report.omissions.map((entry) => entry.kind)).toContain(
      "nesting-limit",
    );
    expect(messages(report)).toContain("1 fields are not closed");
  });

  it("reads large and randomly damaged documents in bounded time", async () => {
    const paragraphs: DocParagraph[] = Array.from(
      { length: 20_000 },
      (_, at) => ({
        runs: [
          `Paragraph ${String(at)} `,
          { text: "bold", chp: prl(0x0835, 1) },
        ],
        ...(at % 50 === 0 ? { istd: 1 } : {}),
      }),
    );
    let started = performance.now();
    const big = await read(buildDoc({ body: paragraphs }).bytes, {
      view: "package",
    });
    expect(big.package.statistics).toMatchObject({ paragraphs: 20_000 });
    expect(performance.now() - started).toBeLessThan(3000);

    const base = buildDoc({
      body: [
        {
          runs: [
            "Fuzz ",
            '\u0013 HYPERLINK "https://e.example" \u0014',
            "link",
            "\u0015",
          ],
          istd: 1,
        },
        { runs: ["A"], pap: prl(SPRM.inTable, 1), end: "\u0007" },
        {
          runs: [],
          pap: [...prl(SPRM.inTable, 1), ...prl(SPRM.ttp, 1)],
          end: "\u0007",
        },
        { runs: [{ text: "gone", chp: prl(SPRM.del, 1) }, "Ελλάδα"] },
      ],
      footnotes: [[{ runs: ["n"] }]],
      comments: [{ author: "B", initials: "B", paragraphs: [{ runs: ["c"] }] }],
      headers: [[[], [{ runs: ["h"] }], [], [], [], []]],
    });
    let seed = 0x2545f491;
    const random = (limit: number): number => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) % limit;
    };
    // A reader bug would surface as ArtifactOperationError; only typed refusals are allowed.
    const allowed = new Set([
      "AnalysisUnsupportedTargetError",
      "AnalysisResourceConstraintError",
    ]);
    started = performance.now();
    for (let round = 0; round < 120; round += 1) {
      const word = base.word.slice();
      const table = base.table.slice();
      for (let edit = 0; edit < 8; edit += 1) {
        const target = random(2) === 0 ? table : word;
        // Keep the FIB's first bytes so most rounds reach the deeper structures.
        const at =
          target === word
            ? 34 + random(word.length - 34)
            : random(table.length);
        target[at] = random(256);
      }
      for (const view of ["package", "content", "text"] as const) {
        const result = await run(compound(word, table), { view });
        if (!result.ok) expect(allowed.has(result.error._tag)).toBe(true);
        else officeDocumentReportSchema.parse(result.value);
      }
    }
    expect(performance.now() - started).toBeLessThan(20_000);
  });
});

describe("legacy Word versions and refusals", () => {
  it("reads every Word 97-2003 FIB version, a template flag and a 0Table stream", async () => {
    for (const nFib of [0x00c1, 0x00d9, 0x0101, 0x010c, 0x0112]) {
      const report = await read(
        buildDoc({ nFib, body: [{ runs: [`version ${String(nFib)}`] }] }).bytes,
      );
      expect(texts(report)).toEqual([`version ${String(nFib)}`]);
      expect(report.diagnostics).toEqual([]);
    }
    const template = await read(
      buildDoc({
        template: true,
        tableStream: "0Table",
        body: [{ runs: ["t"] }],
      }).bytes,
      { view: "package" },
    );
    expect(template.package.statistics).toMatchObject({
      template: 1,
      paragraphs: 1,
    });
  });

  it("names Word 6/95 files and refuses encrypted or obfuscated files without trying a password", async () => {
    expect(
      await refusal(buildDoc({ nFib: 0x0068, body: [{ runs: ["x"] }] }).bytes),
    ).toContain("Word 6.0 or Word 95");
    for (const obfuscated of [false, true]) {
      const reason = await refusal(
        buildDoc({ encrypted: true, obfuscated, body: [{ runs: ["x"] }] })
          .bytes,
      );
      expect(reason).toContain("password-protected");
      expect(reason).toContain("No password is tried and nothing is decrypted");
      expect(reason).toContain(
        obfuscated ? "XOR obfuscation" : "RC4 encryption",
      );
    }
  });
});

describe("legacy Word note and comment indexes", () => {
  it("reads a note or comment story whole when its index does not cover it, and caps long note text", async () => {
    const spec: DocSpec = {
      body: [{ runs: ["Body", { text: "\u0002", chp: prl(SPRM.spec, 1) }] }],
      footnotes: [[{ runs: ["x".repeat(40_000)] }]],
    };
    const built = buildDoc(spec);
    const capped = await read(built.bytes, {
      view: "content",
      part: "footnotes",
    });
    const [note] = capped.items;
    expect(note?.kind === "note" ? note.text.length : 0).toBe(32_769);
    expect(capped.omissions.map((entry) => entry.kind)).toContain(
      "truncated-text",
    );
    for (const edit of [
      (table: DataView, fc: number) => table.setUint32(fc, 1, true),
      (_table: DataView, _fc: number, word: DataView) =>
        setEntry(
          built,
          word,
          FCLCB.plcffndTxt,
          built.entries.get(FCLCB.plcffndTxt)?.fc ?? 0,
          8,
        ),
    ]) {
      const report = await read(
        patched(built, (word, table, at) =>
          edit(table, at(FCLCB.plcffndTxt).fc, word),
        ),
        { view: "content", part: "footnotes" },
      );
      expect(report.items.map((item) => item.kind)).toContain("paragraph");
      expect(messages(report)).toContain("do not cover their story");
    }
  });
});
