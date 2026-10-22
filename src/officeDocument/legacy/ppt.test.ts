import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  inspectOfficeDocumentInputSchema,
  officeDocumentReportSchema,
  type OfficeDocumentReport,
  type OfficeSlide,
} from "../../domain/officeDocument/officeDocument.js";
import {
  assembleStream,
  buildPpt,
  buildPptStreams,
  chars,
  container,
  cstring,
  documentOf,
  drawing,
  fsp,
  join as joinBytes,
  pptFile,
  record,
  shape,
  textHeader,
  u32,
  type PptSpec,
} from "../../../tests/fixtures/legacyPptProducers.js";
import { OfficeDocumentProvider } from "../OfficeDocumentProvider.js";

const provider = new OfficeDocumentProvider();
let root: string;
let counter = 0;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "rea-ppt-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const write = async (bytes: Uint8Array, name = "deck.ppt"): Promise<string> => {
  const path = join(root, `${String((counter += 1))}-${name}`);
  await writeFile(path, bytes);
  return path;
};

const inspect = async (
  path: string,
  input: object = {},
): Promise<OfficeDocumentReport> => {
  const result = await provider.inspectDocument(
    inspectOfficeDocumentInputSchema.parse({ path, ...input }),
  );
  if (!result.ok) throw result.error;
  return officeDocumentReportSchema.parse(result.value);
};

const failure = async (path: string) => {
  const result = await provider.inspectDocument(
    inspectOfficeDocumentInputSchema.parse({ path }),
  );
  if (result.ok) throw new Error("Expected the inspection to fail.");
  return result.error;
};

const slides = (report: OfficeDocumentReport): OfficeSlide[] =>
  report.items.filter((item): item is OfficeSlide => item.kind === "slide");

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const pattern = (length: number, seed: number): Uint8Array =>
  Uint8Array.from({ length }, (_, at) => (at * 31 + seed) & 0xff);

const VBA = pattern(9000, 3);
const OLE = pattern(700, 5);
const CONTROL = pattern(300, 7);

const DECK: PptSpec = {
  slides: [
    {
      title: "Quarterly Review",
      body: "First point\rSecond point\vline two",
      layout: 0,
      notes: "Speaker notes here",
      textboxes: [{ text: "Plain box" }],
      shapeLink: 2,
    },
    {
      title: "Links",
      layout: 0x10,
      hidden: true,
      picture: true,
      textboxes: [
        { text: "Visit example now", link: { id: 1, begin: 6, end: 13 } },
        { text: "Bytes café", bytes: true },
      ],
    },
    {
      title: "Group",
      titleLink: { id: 3, begin: 0, end: 5 },
      grouped: "Inside group",
      runProgram: "calc.exe",
    },
  ],
  hyperlinks: [
    { id: 1, friendly: "Example", target: "https://example.com/x" },
    { id: 2, location: "257,2,Slide 2" },
    { id: 3, target: "\\\\server\\share\\other.ppt" },
    { id: 4, target: "mailto:team@example.com" },
  ],
  vba: VBA,
  ole: { bytes: OLE, raw: true, progId: "Excel.Sheet.8" },
  control: CONTROL,
  moviePath: "C:\\media\\clip.avi",
};

describe("legacy PowerPoint slides", () => {
  it("reads titles, outline and textbox text, layout, hidden flag, notes and links in slide order", async () => {
    const path = await write(buildPpt(DECK));
    const report = await inspect(path, { view: "content" });
    expect(report.content_parts).toEqual([
      { id: "slides", label: "Slides", kind: "slides", hidden: false },
    ]);
    const [first, second, third] = slides(report);
    expect(first).toMatchObject({
      index: 0,
      number: 1,
      hidden: false,
      layout: "Title Slide",
      title: "Quarterly Review",
      texts: [
        { shape: "body", text: "First point\nSecond point\nline two" },
        { shape: "textbox 3", text: "Plain box" },
      ],
      tables: [],
      notes: "Speaker notes here",
      links: [
        { text: "Quarterly Review", target: "257,2,Slide 2", external: false },
      ],
    });
    expect(second).toMatchObject({
      number: 2,
      hidden: true,
      layout: "Blank",
      title: "Links",
      texts: [
        { shape: "textbox 2", text: "Visit example now" },
        { shape: "textbox 3", text: "Bytes café" },
      ],
      notes: null,
      links: [
        { text: "example", target: "https://example.com/x", external: true },
      ],
    });
    expect(third).toMatchObject({
      number: 3,
      title: "Group",
      texts: [{ shape: "textbox 2", text: "Inside group" }],
      links: [
        {
          text: "Group",
          target: "\\\\server\\share\\other.ppt",
          external: true,
        },
      ],
    });
    expect(first?.location).toMatch(/^PowerPoint Document@\d+$/u);
    expect(report.diagnostics).toEqual([]);
    expect(report.omissions).toContainEqual(
      expect.objectContaining({ kind: "picture", count: 1 }),
    );
  });

  it("declares the VBA project, OLE object, ActiveX control and external references with exact hashes", async () => {
    const report = await inspect(await write(buildPpt(DECK)));
    const pkg = report.package;
    expect(pkg).toMatchObject({
      kind: "ppt",
      family: "powerpoint",
      macro_enabled: true,
    });
    const byPart = new Map(pkg.notable.map((entry) => [entry.part, entry]));
    expect(byPart.get("PowerPoint Document (VBA project)")).toMatchObject({
      kind: "macro-project",
      bytes: VBA.length,
      sha256: sha256(VBA),
    });
    expect(byPart.get("PowerPoint Document (OLE object 7)")).toMatchObject({
      kind: "ole-object",
      bytes: OLE.length,
      sha256: sha256(OLE),
    });
    expect(byPart.get("PowerPoint Document (OLE object 7)")?.note).toContain(
      "ProgID Excel.Sheet.8",
    );
    expect(byPart.get("PowerPoint Document (ActiveX control 8)")).toMatchObject(
      {
        kind: "activex",
        bytes: CONTROL.length,
        sha256: sha256(CONTROL),
      },
    );
    expect(pkg.external_references).toEqual(
      expect.arrayContaining([
        {
          source: "PowerPoint Document",
          kind: "linked-media",
          target: "C:\\media\\clip.avi",
          id: "9",
        },
        {
          source: "slide 2",
          kind: "hyperlink",
          target: "https://example.com/x",
          id: "1",
        },
        { source: "slide 3", kind: "run-program", target: "calc.exe", id: "" },
        {
          source: "slide 3",
          kind: "hyperlink",
          target: "\\\\server\\share\\other.ppt",
          id: "3",
        },
        {
          source: "PowerPoint Document",
          kind: "hyperlink",
          target: "mailto:team@example.com",
          id: "4",
        },
      ]),
    );
    expect(pkg.external_total).toBe(5);
    expect(pkg.statistics).toMatchObject({
      slides: 3,
      hidden_slides: 1,
      hyperlinks: 3,
      action_programs: 1,
      pictures: 1,
      edits: 1,
      notes_slides: 1,
      slides_with_notes: 1,
      master_slides: 1,
      macro_project_parts: 1,
      ole_object_parts: 1,
      activex_parts: 1,
    });
  });

  it("renders slides as Markdown in the text view", async () => {
    const report = await inspect(await write(buildPpt(DECK)), {
      view: "text",
      limit: 100,
    });
    expect(report.text).toEqual(
      expect.arrayContaining([
        "## Slide 1: Quarterly Review",
        "- First point",
        "- line two",
        "> Notes: Speaker notes here",
        "## Slide 2: Links (hidden)",
        "> link: example -> https://example.com/x (external)",
      ]),
    );
  });
});

describe("legacy PowerPoint edit history", () => {
  const EDITED: PptSpec = {
    slides: [
      { title: "Kept", textboxes: [{ text: "unchanged" }] },
      { title: "Before", textboxes: [{ text: "older text" }] },
    ],
    edit: {
      index: 1,
      slide: {
        title: "After",
        textboxes: [{ text: "newer text" }],
        hidden: true,
      },
    },
  };

  it("reads the newest version of a slide replaced by an incremental save", async () => {
    const built = buildPptStreams(EDITED);
    const report = await inspect(
      await write(pptFile(built.document, built.currentUser)),
      { view: "content" },
    );
    const read = slides(report);
    expect(read.map((slide) => slide.title)).toEqual(["Kept", "After"]);
    expect(read[1]).toMatchObject({
      hidden: true,
      texts: [{ shape: "textbox 2", text: "newer text" }],
      location: `PowerPoint Document@${String(built.offsets.slides[2])}`,
    });
    expect(JSON.stringify(read)).not.toContain("older text");
    expect(report.package.statistics).toMatchObject({
      edits: 2,
      slides: 2,
      hidden_slides: 1,
    });
    expect(report.diagnostics).toEqual([]);
  });

  it("rebuilds the persist directory from a scan when the Current User stream is missing, newest record winning", async () => {
    const built = buildPptStreams(EDITED);
    const report = await inspect(await write(pptFile(built.document, null)), {
      view: "content",
    });
    expect(slides(report).map((slide) => slide.title)).toEqual([
      "Kept",
      "After",
    ]);
    expect(
      report.diagnostics.map((entry) => entry.message).join(" "),
    ).toContain("rebuilt from the directory records found by scanning");
    expect(report.package.statistics).toMatchObject({ edits: 2 });
  });

  it("refuses an encrypted presentation by its header token or its encryption session, trying no password", async () => {
    for (const spec of [
      { slides: [{ title: "Secret" }], encryptedToken: true },
      { slides: [{ title: "Secret" }], encryptSession: true },
    ] satisfies PptSpec[]) {
      const error = await failure(await write(buildPpt(spec)));
      expect(error.message).toContain("password-protected");
      expect(error.message).toContain(
        "No password is tried and nothing is decrypted",
      );
    }
  });
});

describe("legacy PowerPoint without a document record", () => {
  it("lists slide containers in stream order when only slides remain, and says why", async () => {
    const built = buildPptStreams({
      slides: [
        {
          title: "One",
          textboxes: [{ text: "first box" }],
          notes: "lost notes",
        },
        { title: "Two", textboxes: [{ text: "second box" }], layout: 7 },
      ],
    });
    // Drop the DocumentContainer at offset 0 and the edit records; keep slides and notes.
    const first = built.offsets.slides[0] ?? 0;
    const report = await inspect(
      await write(pptFile(built.document.subarray(first), null)),
      { view: "content" },
    );
    const read = slides(report);
    expect(read.map((slide) => slide.texts.map((text) => text.text))).toEqual([
      ["first box"],
      ["second box"],
    ]);
    expect(read[1]?.layout).toBe("Title Only");
    expect(read.every((slide) => slide.title === null)).toBe(true);
    expect(
      report.diagnostics.map((entry) => entry.message).join(" "),
    ).toContain("No document record was found");
    expect(report.omissions).toContainEqual(
      expect.objectContaining({ kind: "unlinked-notes", count: 1 }),
    );
  });

  it("refuses a PowerPoint Document stream with no readable record", async () => {
    const error = await failure(
      await write(pptFile(pattern(64, 9).fill(0xff, 2, 4), null)),
    );
    expect(error.message).toContain("no document, slide or notes record");
  });

  it("refuses an empty PowerPoint Document stream", async () => {
    const error = await failure(await write(pptFile(new Uint8Array(0), null)));
    expect(error.message).toContain("too short");
  });
});

/** A one-slide stream: the document (with optional outline text) and the given slide container. */
const oneSlide = (
  slide: Uint8Array,
  outline: readonly Uint8Array[] = [],
): Uint8Array => {
  const built = assembleStream([
    { id: 1, bytes: documentOf([{ persistId: 2, outline }]) },
    { id: 2, bytes: slide },
  ]);
  return pptFile(built.document, built.currentUser);
};

const textbox = (spid: number, text: string, flags?: number): Uint8Array =>
  container(0xf004, [
    fsp(202, spid, flags),
    container(0xf00d, [textHeader(4), chars(text)]),
  ]);

describe("legacy PowerPoint content that is counted, not read", () => {
  it("counts slide comments and header and footer text", async () => {
    const comment = container(0x2ee0, [
      cstring(0, "Reviewer"),
      cstring(1, "Please check"),
      record(0x2ee1, new Uint8Array(28)),
    ]);
    const tags = container(0x1388, [
      container(0x138a, [
        cstring(0, "___PPT10"),
        record(0x138b, joinBytes([comment, comment])),
      ]),
    ]);
    const footer = container(0x0fd9, [
      record(0x0fda, new Uint8Array(4)),
      cstring(2, "Footer text"),
    ]);
    const slide = container(0x03ee, [
      drawing([textbox(5, "visible")]),
      footer,
      tags,
    ]);
    const report = await inspect(await write(oneSlide(slide)), {
      view: "content",
    });
    expect(slides(report)[0]?.texts).toEqual([
      { shape: "textbox 1", text: "visible" },
    ]);
    expect(report.omissions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "comments", count: 2 }),
        expect.objectContaining({ kind: "headers-footers", count: 1 }),
      ]),
    );
    expect(JSON.stringify(report.items)).not.toContain("Please check");
  });

  it("skips deleted shapes: the FSP fDeleted flag and the drawing's trailing deleted blocks", async () => {
    const group = (shapes: readonly Uint8Array[]): Uint8Array =>
      container(0xf003, [
        container(0xf004, [
          record(0xf009, new Uint8Array(16), { version: 1 }),
          fsp(0, 1024, 0x0005),
        ]),
        ...shapes,
      ]);
    const slide = container(0x03ee, [
      container(0x040c, [
        container(0xf002, [
          record(0xf008, new Uint8Array(8)),
          group([textbox(1025, "live"), textbox(1026, "flagged", 0x0a08)]),
          container(0xf004, [fsp(1, 1027, 0x0c00)]),
          group([textbox(1028, "deleted group")]),
          textbox(1029, "deleted shape"),
        ]),
      ]),
    ]);
    const report = await inspect(await write(oneSlide(slide)), {
      view: "content",
    });
    expect(slides(report)[0]?.texts.map((text) => text.text)).toEqual(["live"]);
    expect(report.omissions).toContainEqual(
      expect.objectContaining({ kind: "deleted-shapes", count: 3 }),
    );
  });
});

describe("legacy PowerPoint outline indexes and old formats", () => {
  it("indexes outline text by TextHeaderAtom only; characters before the first header are flagged and kept", async () => {
    const slide = container(0x03ee, [
      drawing([shape(5, { textbox: [record(0x0f9e, u32(0))] })]),
    ]);
    const outline = [chars("stray"), textHeader(0), chars("Real title")];
    const report = await inspect(await write(oneSlide(slide, outline)), {
      view: "content",
    });
    expect(slides(report)[0]).toMatchObject({
      title: "Real title",
      texts: [{ shape: "textbox 2", text: "stray" }],
    });
    expect(
      report.diagnostics.map((entry) => entry.message).join(" "),
    ).toContain("before any TextHeaderAtom");
  });

  it("refuses a PowerPoint 4.0/95 file by its size-prefixed Current User stream or its document file version", async () => {
    const built = buildPptStreams({ slides: [{ title: "Old" }] });
    const sized = joinBytes([u32(12), new Uint8Array(12).fill(0x41)]);
    const old = built.currentUser.slice();
    new DataView(old.buffer).setUint16(22, 0x03f3, true);
    for (const user of [sized, old]) {
      const error = await failure(await write(pptFile(built.document, user)));
      expect(error.message).toContain("PowerPoint 4.0/95 binary file");
    }
  });
});
