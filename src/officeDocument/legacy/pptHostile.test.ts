import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { deflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  inspectOfficeDocumentInputSchema,
  officeDocumentReportSchema,
  type OfficeDocumentReport,
  type OfficeSlide,
} from "../../domain/officeDocument/officeDocument.js";
import {
  AnalysisCancelledError,
  AnalysisUnsupportedTargetError,
} from "../../domain/analysisErrorCore.js";
import {
  assembleStream,
  buildPptStreams,
  chars,
  container,
  cstring,
  currentUser,
  documentOf,
  drawing,
  interactive,
  join,
  persistDirectory,
  pptFile,
  record,
  shape,
  slideRecord,
  textHeader,
  u32,
  userEdit,
  type PptSpec,
} from "../../../tests/fixtures/legacyPptProducers.js";
import { OfficeDocumentProvider } from "../OfficeDocumentProvider.js";

const provider = new OfficeDocumentProvider();
let root: string;
let counter = 0;

beforeAll(async () => {
  root = await mkdtemp(joinPath(tmpdir(), "rea-ppt-hostile-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Inspect a file and require it to finish within a second, as every hostile input must. */
const run = async (bytes: Uint8Array, input: object = {}) => {
  const path = joinPath(root, `${String((counter += 1))}.ppt`);
  await writeFile(path, bytes);
  const started = performance.now();
  const result = await provider.inspectDocument(
    inspectOfficeDocumentInputSchema.parse({
      path,
      view: "content",
      limit: 500,
      ...input,
    }),
  );
  expect(performance.now() - started).toBeLessThan(1000);
  return result;
};

const read = async (
  bytes: Uint8Array,
  input: object = {},
): Promise<OfficeDocumentReport> => {
  const result = await run(bytes, input);
  if (!result.ok) throw result.error;
  return officeDocumentReportSchema.parse(result.value);
};

const slides = (report: OfficeDocumentReport): OfficeSlide[] =>
  report.items.filter((item): item is OfficeSlide => item.kind === "slide");

const messages = (report: OfficeDocumentReport): string =>
  report.diagnostics.map((entry) => entry.message).join("\n");

const setU32 = (
  bytes: Uint8Array,
  offset: number,
  value: number,
): Uint8Array => {
  const copy = bytes.slice();
  new DataView(copy.buffer).setUint32(offset, value >>> 0, true);
  return copy;
};

/** Offsets of the top-level records of one type in a stream. */
const topLevel = (bytes: Uint8Array, type: number): number[] => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const found: number[] = [];
  for (
    let at = 0;
    at + 8 <= bytes.length;
    at += 8 + view.getUint32(at + 4, true)
  )
    if (view.getUint16(at + 2, true) === type) found.push(at);
  return found;
};

const TWO: PptSpec = {
  slides: [
    { title: "Alpha", body: "alpha body", textboxes: [{ text: "alpha box" }] },
    { title: "Beta", textboxes: [{ text: "beta box" }] },
  ],
  vba: new Uint8Array(9000).fill(7),
};

describe("hostile legacy PowerPoint structure", () => {
  it("reads or refuses every truncation of the stream, never failing another way", async () => {
    const built = buildPptStreams(TWO);
    for (let cut = 0; cut < built.document.length; cut += 97) {
      const result = await run(
        pptFile(built.document.subarray(0, cut), built.currentUser),
      );
      if (!result.ok)
        expect(result.error).toBeInstanceOf(AnalysisUnsupportedTargetError);
    }
  });

  it("falls back to outline text when a slide record claims 4 GiB, and still reads the next slide", async () => {
    const built = buildPptStreams(TWO);
    const broken = setU32(
      built.document,
      (built.offsets.slides[0] ?? 0) + 4,
      0xffffffff,
    );
    const report = await read(pptFile(broken, built.currentUser));
    const [first, second] = slides(report);
    expect(first).toMatchObject({
      title: "Alpha",
      texts: [{ shape: "body", text: "alpha body" }],
    });
    expect(first?.location).toBe("PowerPoint Document (slide list entry 1)");
    expect(second).toMatchObject({
      title: "Beta",
      texts: [{ text: "beta box" }],
    });
    expect(messages(report)).toContain(
      "comes from the slide list's outline text only",
    );
  });

  it("stops an edit chain that points forward or at itself", async () => {
    const built = buildPptStreams({
      ...TWO,
      edit: { index: 0, slide: { title: "Alpha 2" } },
    });
    // offsetLastEdit sits 8 bytes into the UserEditAtom's data.
    const looped = setU32(
      built.document,
      built.offsets.edit + 8 + 8,
      built.offsets.edit,
    );
    const report = await read(pptFile(looped, built.currentUser));
    expect(slides(report).map((slide) => slide.title)).toEqual([
      "Alpha 2",
      "Beta",
    ]);
    expect(messages(report)).toContain("points forward");
  });

  it("reports a persist directory entry that lists more offsets than its record holds", async () => {
    const built = buildPptStreams(TWO);
    const [directory = 0] = topLevel(built.document, 0x1772);
    const bad = setU32(built.document, directory + 8, 1 | (4095 << 20));
    const report = await read(pptFile(bad, built.currentUser));
    expect(messages(report)).toContain(
      "lists 4095 offsets, past the end of its record",
    );
  });

  it("says why slides whose directory offsets fall outside the stream or on the wrong record are not read", async () => {
    const doc = documentOf([
      { persistId: 2 },
      { persistId: 3 },
      { persistId: 9 },
    ]);
    const notSlide = record(0x0fba, u32(0));
    const built = assembleStream([
      { id: 1, bytes: doc },
      { id: 3, bytes: notSlide },
    ]);
    const report = await read(pptFile(built.document, built.currentUser));
    expect(slides(report)).toHaveLength(3);
    expect(messages(report)).toContain(
      "persist id 9) has no readable slide record",
    );
    expect(messages(report)).toContain(
      "persist id 3) has no readable slide record",
    );
  });

  it("falls back to a scan when the Current User stream is not a CurrentUserAtom or names an unknown token", async () => {
    const built = buildPptStreams(TWO);
    const garbage = await read(
      pptFile(built.document, new Uint8Array(40).fill(0x41)),
    );
    expect(slides(garbage).map((slide) => slide.title)).toEqual([
      "Alpha",
      "Beta",
    ]);
    expect(messages(garbage)).toContain(
      "does not start with a CurrentUserAtom",
    );
    const token = await read(
      pptFile(built.document, setU32(built.currentUser, 12, 0x12345678)),
    );
    expect(slides(token).map((slide) => slide.title)).toEqual([
      "Alpha",
      "Beta",
    ]);
    expect(messages(token)).toContain("header token is 0x12345678");
  });

  it("refuses a stream whose first record claims 4 GiB", async () => {
    const built = buildPptStreams(TWO);
    const result = await run(
      pptFile(setU32(built.document, 4, 0xffffffff), null),
    );
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toBeInstanceOf(AnalysisUnsupportedTargetError);
  });
});

describe("hostile legacy PowerPoint storages", () => {
  const vbaNote = async (
    patch: (document: Uint8Array, at: number) => Uint8Array,
    input: object = {},
  ) => {
    const built = buildPptStreams(TWO);
    const [storage = 0] = topLevel(built.document, 0x1011);
    const report = await read(
      pptFile(patch(built.document, storage), built.currentUser),
      { view: "package", ...input },
    );
    const vba = report.package.notable.find(
      (entry) => entry.kind === "macro-project",
    );
    expect(vba?.sha256).toBeNull();
    return { note: vba?.note ?? "", report };
  };

  it("does not inflate a storage that declares 4 GiB", async () => {
    const { note } = await vbaNote((document, at) =>
      setU32(document, at + 8, 0xffffffff),
    );
    expect(note).toContain(
      "declares 4294967295 bytes after decompression, over the",
    );
  });

  it("stops a storage that inflates past its declared size", async () => {
    const { note } = await vbaNote((document, at) =>
      setU32(document, at + 8, 10),
    );
    expect(note).toContain("does not inflate within its declared 10 bytes");
  });

  it("does not hash a storage whose compressed bytes are damaged", async () => {
    const { note } = await vbaNote((document, at) =>
      setU32(document, at + 12, 0xdeadbeef),
    );
    expect(note).toContain("does not inflate");
  });

  it("charges the inflated size to max_decoded_bytes before inflating", async () => {
    const bomb = new Uint8Array(16 * 1024 ** 2);
    expect(deflateSync(bomb).length).toBeLessThan(40_000);
    const built = buildPptStreams({ slides: [{ title: "Bomb" }], vba: bomb });
    const result = await run(pptFile(built.document, built.currentUser), {
      view: "package",
      max_decoded_bytes: 1024 ** 2,
    });
    if (!result.ok) throw result.error;
    const vba = result.value.package.notable.find(
      (entry) => entry.kind === "macro-project",
    );
    expect(vba).toMatchObject({ sha256: null, bytes: 16 * 1024 ** 2 });
    expect(vba?.note).toContain("max_decoded_bytes");
  });
});

describe("hostile legacy PowerPoint drawings and text", () => {
  it("stops at 64 nested groups and still reads the shapes above the limit", async () => {
    let group = container(0xf003, [
      shape(9, { type: 202, textbox: [textHeader(4), chars("too deep")] }),
    ]);
    for (let depth = 0; depth < 300; depth += 1)
      group = container(0xf003, [
        ...(depth === 250
          ? [
              shape(8, {
                type: 202,
                textbox: [textHeader(4), chars("reachable")],
              }),
            ]
          : []),
        group,
      ]);
    const slide = container(0x03ee, [drawing([group])]);
    const built = assembleStream([
      { id: 1, bytes: documentOf([{ persistId: 2 }]) },
      { id: 2, bytes: slide },
    ]);
    const report = await read(pptFile(built.document, built.currentUser));
    expect(slides(report)[0]?.texts.map((text) => text.text)).toEqual([
      "reachable",
    ]);
    expect(report.omissions).toContainEqual(
      expect.objectContaining({ kind: "nesting-limit" }),
    );
  });

  it("decodes bad UTF-16 with replacement characters and says when a text atom has an odd length", async () => {
    const odd = record(
      0x0fa0,
      Uint8Array.of(0x41, 0x00, 0x00, 0xd8, 0x42, 0x00, 0x43),
    );
    const slide = container(0x03ee, [
      drawing([shape(5, { type: 202, textbox: [textHeader(4), odd] })]),
    ]);
    const built = assembleStream([
      { id: 1, bytes: documentOf([{ persistId: 2 }]) },
      { id: 2, bytes: slide },
    ]);
    const report = await read(pptFile(built.document, built.currentUser));
    expect(slides(report)[0]?.texts).toEqual([
      { shape: "textbox 1", text: "A�B" },
    ]);
    expect(messages(report)).toContain("odd byte length");
  });

  it("reads a slide record shared by thousands of slide list entries once", async () => {
    const entries = Array.from({ length: 3000 }, () => ({ persistId: 2 }));
    const built = assembleStream([
      { id: 1, bytes: documentOf(entries) },
      { id: 2, bytes: slideRecord({ textboxes: [{ text: "once" }] }, 0) },
    ]);
    const report = await read(pptFile(built.document, built.currentUser), {
      limit: 5000,
    });
    const read3000 = slides(report);
    expect(read3000).toHaveLength(3000);
    expect(read3000.filter((slide) => slide.texts.length > 0)).toHaveLength(1);
    expect(messages(report)).toContain("already read for an earlier slide");
    expect(messages(report)).toContain("more diagnostics were not listed");
  });

  it("stops at the step limit when overlapping slide records make the same records reachable again and again", async () => {
    // Slide k's header, then an atom whose data holds slide k+1; every slide's records then run on through one shared tail.
    const levels = 3000;
    const tail = new Uint8Array(20_000 * 8);
    for (let at = 0; at < tail.length; at += 8)
      tail.set([0, 0, 0x22, 0x22], at);
    const blob = new Uint8Array(levels * 16 + tail.length);
    const view = new DataView(blob.buffer);
    for (let level = 0; level < levels; level += 1) {
      const at = level * 16;
      view.setUint16(at, 0x000f, true);
      view.setUint16(at + 2, 0x03ee, true);
      view.setUint32(at + 4, blob.length - at - 8, true);
      view.setUint16(at + 8, 0, true);
      view.setUint16(at + 10, 0x2222, true);
      view.setUint32(at + 12, levels * 16 - at - 16, true);
    }
    blob.set(tail, levels * 16);
    const doc = documentOf(
      Array.from({ length: levels }, (_, level) => ({ persistId: 2 + level })),
    );
    const entries = new Map<number, number>([[1, 0]]);
    for (let level = 0; level < levels; level += 1)
      entries.set(2 + level, doc.length + level * 16);
    const directory = persistDirectory(entries);
    const edit = doc.length + blob.length + directory.length;
    const stream = join([
      doc,
      blob,
      directory,
      userEdit(0, doc.length + blob.length, levels + 1),
    ]);
    const report = await read(pptFile(stream, currentUser(edit)), {
      limit: 5000,
    });
    expect(messages(report)).toContain("reading stopped at the step limit");
    expect(slides(report).length).toBeLessThan(levels);
  });
});

/** One slide with one text box whose characters carry `ranges`, and hyperlink id 1 pointing at `target`. */
const linkedDeck = (
  text: string,
  ranges: readonly Uint8Array[],
  target: string,
): Uint8Array => {
  const links = container(0x0409, [
    record(0x040a, u32(1)),
    container(0x0fd7, [record(0x0fd3, u32(1)), cstring(1, target)]),
  ]);
  const slide = container(0x03ee, [
    drawing([
      shape(5, { type: 202, textbox: [textHeader(4), chars(text), ...ranges] }),
    ]),
  ]);
  const built = assembleStream([
    { id: 1, bytes: documentOf([{ persistId: 2 }], [links]) },
    { id: 2, bytes: slide },
  ]);
  return pptFile(built.document, built.currentUser);
};

const anchored = (action: number, begin: number, end: number): Uint8Array =>
  join([
    interactive(action, 1, 8),
    record(0x0fdf, join([u32(begin), u32(end)])),
  ]);

describe("hostile legacy PowerPoint actions and cancellation", () => {
  it("cuts link text only for the links it lists, however many ranges cover a long text", async () => {
    const long = 1_000_000;
    const ranges = Array.from({ length: 40_000 }, (_, index) =>
      anchored(index % 2 === 0 ? 4 : 0, 0, long),
    );
    const report = await read(
      linkedDeck("x".repeat(long), ranges, "https://example.com/"),
    );
    const [slide] = slides(report);
    expect(slide?.links).toHaveLength(100);
    expect(slide?.links[0]?.text).toHaveLength(32_769);
    expect(report.package.statistics).toMatchObject({ hyperlinks: 20_000 });
    expect(report.omissions).toContainEqual(
      expect.objectContaining({ kind: "links-past-limit" }),
    );
  });

  it("declares a hyperlink once however many actions refer to it, and cuts a huge target", async () => {
    const target = `https://example.com/${"a".repeat(1_000_000)}`;
    const ranges = Array.from({ length: 20_000 }, () => anchored(4, 0, 4));
    const report = await read(linkedDeck("link", ranges, target), {
      view: "package",
    });
    expect(report.package.external_total).toBe(1);
    expect(report.package.external_references[0]?.target).toHaveLength(2_001);
    expect(report.package.statistics).toMatchObject({ hyperlinks: 20_000 });
  });

  it("reports a client textbox that overruns its shape", async () => {
    const slide = slideRecord(
      { textboxes: [{ text: "cut off" }, { text: "kept" }] },
      0,
    );
    const built = assembleStream([
      { id: 1, bytes: documentOf([{ persistId: 2 }]) },
      { id: 2, bytes: slide },
    ]);
    const header = [0x0f, 0x00, 0x0d, 0xf0];
    const textbox = built.document.findIndex((_, at) =>
      header.every((byte, index) => built.document[at + index] === byte),
    );
    const view = new DataView(built.document.buffer, built.document.byteOffset);
    const bad = setU32(
      built.document,
      textbox + 4,
      view.getUint32(textbox + 4, true) + 1,
    );
    const report = await read(pptFile(bad, built.currentUser));
    expect(slides(report)[0]?.texts.map((text) => text.text)).toEqual(["kept"]);
    expect(messages(report)).toMatch(
      /declares \d+ bytes, past the end of its container/u,
    );
  });

  it("stops promptly when the read is cancelled part way through", async () => {
    // A slide list of 240,000 entries (6.7 MB, inside the fixture writer's size limit) takes
    // a few hundred milliseconds to read; the cancelled read must end far sooner.
    const entries = 240_000;
    const list = new Uint8Array(entries * 28);
    const view = new DataView(list.buffer);
    for (let index = 0; index < entries; index += 1) {
      view.setUint16(index * 28 + 2, 0x03f3, true);
      view.setUint32(index * 28 + 4, 20, true);
      view.setUint32(index * 28 + 8, 2, true);
    }
    const doc = container(0x03e8, [record(0x0ff0, list, { version: 0xf })]);
    const built = assembleStream([{ id: 1, bytes: doc }]);
    const path = joinPath(root, "cancel.ppt");
    await writeFile(path, pptFile(built.document, built.currentUser));
    const input = inspectOfficeDocumentInputSchema.parse({
      path,
      view: "content",
    });
    // The first read warms the code; the second is the baseline the cancelled read is held to.
    expect((await provider.inspectDocument(input)).ok).toBe(true);
    const started = performance.now();
    const full = await provider.inspectDocument(input);
    const baseline = performance.now() - started;
    expect(full.ok).toBe(true);
    const controller = new AbortController();
    const begun = performance.now();
    setTimeout(() => controller.abort(), baseline / 3);
    const result = await provider.inspectDocument(input, {
      signal: controller.signal,
    });
    const elapsed = performance.now() - begun;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(AnalysisCancelledError);
    expect(elapsed).toBeLessThan(baseline * 0.7);
  });
});
