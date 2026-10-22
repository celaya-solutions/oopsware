import { describe, expect, it } from "vitest";

import { DecodeBudget } from "../../artifacts/zipMemberView.js";
import { CompoundFile } from "../../windowsInstaller/cfb.js";
import { ReaderCounters } from "../reader.js";
import { openDoc } from "./doc.js";
import { LegacyStreams } from "./legacy.js";
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
} from "../../../tests/fixtures/legacyDocProducers.js";

/**
 * Limits of the legacy Word reader under load (piece-table floods, overlapping
 * pieces, cancellation, Data-stream reads) and the references it lists.
 */

const inspectDocCancelled = async (
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<string> => {
  const result = await run(bytes, { view: "content" }, signal);
  return result.ok ? "ok" : result.error._tag;
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

const withPieces = (
  built: BuiltDoc,
  region: Uint8Array,
  pieces: readonly { cp: number; end: number; at: number; prm?: number }[],
  grpprl: readonly number[] = [],
): Uint8Array => {
  const word = new Uint8Array(built.word.length + region.length);
  word.set(built.word);
  word.set(region, built.word.length);
  const count = pieces.length;
  const plc = (count + 1) * 4 + count * 8;
  const clx = new Uint8Array(
    (grpprl.length > 0 ? 3 + grpprl.length : 0) + 5 + plc,
  );
  const view = new DataView(clx.buffer);
  let at = 0;
  if (grpprl.length > 0) {
    clx[0] = 1;
    view.setUint16(1, grpprl.length, true);
    clx.set(grpprl, 3);
    at = 3 + grpprl.length;
  }
  clx[at] = 2;
  view.setUint32(at + 1, plc, true);
  at += 5;
  for (const [index, piece] of pieces.entries()) {
    view.setUint32(at + index * 4, piece.cp, true);
    if (index === count - 1) view.setUint32(at + count * 4, piece.end, true);
    const pcdAt = at + (count + 1) * 4 + index * 8;
    view.setUint32(
      pcdAt + 2,
      ((built.word.length + piece.at) * 2) | 0x40000000,
      true,
    );
    view.setUint16(pcdAt + 6, piece.prm ?? 0, true);
  }
  const table = new Uint8Array(built.table.length + clx.length);
  table.set(built.table);
  table.set(clx, built.table.length);
  const fib = new DataView(word.buffer);
  setEntry(built, fib, FCLCB.clx, built.table.length, clx.length);
  fib.setUint32(76, pieces[count - 1]?.end ?? 0, true);
  return compound(word, table);
};

const openBytes = async (bytes: Uint8Array, signal: AbortSignal) => {
  const file = await CompoundFile.open(
    async (offset, length) => bytes.subarray(offset, offset + length),
    bytes.length,
  );
  return await openDoc({
    streams: new LegacyStreams(file, new DecodeBudget(1 << 30, 1 << 30)),
    counters: new ReaderCounters(),
    signal,
    notable: () => {},
    external: () => {},
  });
};

describe("legacy Word reader under load", () => {
  it("checks pieces before parsing their properties: 400,000 pieces on one byte with a 32 KB property group", async () => {
    const base = buildDoc({ body: [{ runs: ["x"] }] });
    const pieces = Array.from({ length: 400_000 }, (_, cp) => ({
      cp,
      end: cp + 1,
      at: 0,
      prm: 1,
    }));
    const grpprl = Array.from({ length: 10_666 }, () => prl(0x0835, 1)).flat();
    const bytes = withPieces(base, Uint8Array.of(0x78), pieces, grpprl);
    const started = performance.now();
    const report = await read(bytes, { view: "package" });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(messages(report)).toContain("399999 of 400000 pieces");
  });

  it("drops a piece whose bytes overlap any piece kept before it, even when the overlap is with a dropped one", async () => {
    // A (1 byte), then K pieces that overlap each other but not A, then B over all of them.
    const base = buildDoc({ body: [{ runs: ["x"] }] });
    const n = 100_000;
    const k = 300;
    const region = new Uint8Array(n + k + 1).fill(0x61);
    const pieces = [
      { cp: 0, end: 1, at: 0 },
      ...Array.from({ length: k }, (_, i) => ({
        cp: 1 + i * n,
        end: 1 + (i + 1) * n,
        at: 1 + i,
      })),
      { cp: 1 + k * n, end: 1 + k * n + n, at: 0 },
    ];
    const started = performance.now();
    const report = await read(withPieces(base, region, pieces));
    expect(performance.now() - started).toBeLessThan(1000);
    // One paragraph of A and the first overlapping piece (cut at the item limit); the rest is never decoded.
    expect(texts(report).map((text) => text.length)).toEqual([32_769]);
    expect(report.package.decoded_bytes).toBeLessThan(1024 * 1024);
    expect(messages(report)).toContain(
      `${String(k)} of ${String(k + 2)} pieces`,
    );
  });

  it("stops at the next checkpoint when the call is cancelled, while opening and while walking", async () => {
    const many = buildDoc({
      body: [{ runs: ["y".repeat(49_999)] }],
      pieces: Array.from({ length: 50_000 }, (_, at) => ({
        at,
        compressed: true,
      })),
    });
    const opening = new AbortController();
    setImmediate(() => opening.abort());
    await expect(openBytes(many.bytes, opening.signal)).rejects.toThrow();

    const big = buildDoc({
      body: Array.from({ length: 20_000 }, (_, at) => ({
        runs: [`p${String(at)}`],
      })),
    });
    const walking = new AbortController();
    const reader = await openBytes(big.bytes, walking.signal);
    let seen = 0;
    const body = reader.contentParts()[0];
    if (body === undefined) throw new Error("no body part");
    await expect(
      reader.forEach(body, () => {
        seen += 1;
        walking.abort();
      }),
    ).rejects.toThrow();
    expect(seen).toBeLessThanOrEqual(4096);

    const controller = new AbortController();
    const pending = inspectDocCancelled(many.bytes, controller.signal);
    controller.abort();
    expect(await pending).toBe("AnalysisCancelledError");
  });

  it("reads only the Data stream blocks paragraph properties name, charged for those bytes", async () => {
    const built = buildDoc({
      dataPrefix: 2 * 1024 * 1024,
      body: [
        { runs: ["A1"], pap: prl(SPRM.inTable, 1), end: "\u0007", huge: true },
        {
          runs: [],
          pap: [...prl(SPRM.inTable, 1), ...prl(SPRM.ttp, 1)],
          end: "\u0007",
          huge: true,
        },
      ],
    });
    const report = await read(built.bytes, {
      view: "content",
      max_decoded_bytes: 512 * 1024,
    });
    expect(report.items).toMatchObject([{ kind: "table", cells: [["A1"]] }]);
    expect(report.package.decoded_bytes).toBeLessThan(64 * 1024);
  });
});

describe("legacy Word references and header text boxes", () => {
  it("lists outside files named by fields and the attached template, never following them", async () => {
    const report = await read(
      buildDoc({
        attachedTemplate: "C:\\Templates\\Corporate.dot",
        body: [
          {
            runs: [
              '\u0013 INCLUDEPICTURE "C:\\\\pics\\\\a.png" \\d \u0014\u0015',
              '\u0013 INCLUDETEXT \\c MSWord "notes.doc" part \u0014\u0015',
              '\u0013 LINK Excel.Sheet.8 "book.xls" Sheet1!R1C1 \\a \u0014\u0015',
              '\u0013 DDEAUTO WinWord "other.doc" place \u0014\u0015',
              '\u0013 DDE app "f.txt" \u0014\u0015',
            ],
          },
        ],
      }).bytes,
      { view: "package" },
    );
    expect(
      report.package.external_references.map((entry) => [
        entry.kind,
        entry.target,
      ]),
    ).toEqual([
      ["attached-template", "C:\\Templates\\Corporate.dot"],
      ["includepicture", "C:\\\\pics\\\\a.png"],
      ["includetext", "notes.doc"],
      ["link", "book.xls"],
      ["ddeauto", "other.doc"],
      ["dde", "f.txt"],
    ]);
  });

  it("counts header text boxes once, from a footer-only document or with no header story at all", async () => {
    const boxes = [[{ runs: ["boxed"] }]];
    const footerOnly = buildDoc({
      headers: [[[], [], [], [{ runs: ["Foot"] }], [], []]],
      headerTextBoxes: boxes,
      body: [{ runs: ["b"] }],
    });
    // Omissions are reported by the views that read content; the package view walks every part too.
    for (const input of [{ view: "content", part: "footer" }]) {
      const report = await read(footerOnly.bytes, input);
      expect(
        report.omissions.filter((entry) => entry.kind === "text-box"),
      ).toEqual([expect.objectContaining({ count: 1 })]);
    }
    const noHeaders = await read(
      buildDoc({ headerTextBoxes: boxes, body: [{ runs: ["b"] }] }).bytes,
    );
    expect(noHeaders.omissions).toEqual([
      expect.objectContaining({ kind: "text-box", count: 1 }),
    ]);
  });
});
