import { describe, expect, it } from "vitest";

import { detectFormatCandidates } from "../formatDetection.js";
import { assembleIdentification, sizeText } from "./assemble.js";
import { chooseFormat } from "./formatChoice.js";
import { headlineFromReport } from "./headlines.js";
import {
  identifyArtifactInputSchema,
  type IdentificationCounters,
  type IdentificationWalk,
  type WalkedPiece,
} from "./identification.js";
import { automaticRouteFor, readerRoutesFor } from "./readerRoutes.js";

const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, ...Array<number>(60).fill(0)]);
const ELF = Buffer.from([
  0x7f,
  0x45,
  0x4c,
  0x46,
  0x02,
  0x01,
  0x01,
  ...Array<number>(57).fill(0),
]);

const detect = (prefix: Buffer, name: string) =>
  detectFormatCandidates({ prefix, fileSize: prefix.length, name });

describe("choosing a piece's format", () => {
  it("takes a role the name names on observed storage, labelled as the name's", () => {
    expect(chooseFormat(detect(ZIP, "pkg-1.0-py3-none-any.whl"))).toMatchObject(
      {
        format: "wheel",
        basis: "name",
        fallback: "zip",
      },
    );
    expect(chooseFormat(detect(ZIP, "archive.zip"))).toMatchObject({
      format: "zip",
      basis: "bytes",
    });
  });

  it("lets a name decide only formats bytes cannot settle", () => {
    const text = Buffer.from("# Notes\n\nHello.\n");
    expect(chooseFormat(detect(text, "README.md"))).toMatchObject({
      format: "markdown",
      basis: "name",
      candidates: ["markdown"],
      nameConflict: null,
    });
    // ZIP bytes named .json: the bytes win and the conflict is kept.
    const conflicted = chooseFormat(detect(ZIP, "data.json"));
    expect(conflicted.format).toBe("zip");
    expect(conflicted.basis).toBe("bytes");
  });

  it("names a contradiction instead of trusting the name", () => {
    const choice = chooseFormat(detect(ELF, "photo.zip"));
    expect(choice.format).toBe("elf");
    expect(choice.nameConflict).toMatch(/\.zip name suggests zip/u);
  });

  it("leaves unrecognized bytes with no format", () => {
    expect(chooseFormat(detect(Buffer.from([1, 2, 3, 4]), "blob"))).toEqual({
      format: null,
      basis: null,
      candidates: [],
      nameConflict: null,
      fallback: null,
    });
  });
});

describe("reader routes", () => {
  it("runs the owning in-process reader first and offers engines as next steps", () => {
    expect(automaticRouteFor("pe", ["pe"])?.tool).toBe(
      "inspect_managed_artifact",
    );
    expect(automaticRouteFor("elf", ["elf"])?.tool).toBe("inspect_go_binary");
    expect(automaticRouteFor("wheel", ["zip", "wheel"])?.tool).toBe(
      "inspect_python_artifact",
    );
    expect(automaticRouteFor("directory", ["directory"])?.tool).toBe(
      "inspect_desktop_application",
    );
    expect(automaticRouteFor("zip", ["zip"])).toBeUndefined();
    // Source parsing needs an installed CPython, so it is only offered.
    expect(
      automaticRouteFor("python-source", ["python-source"]),
    ).toBeUndefined();
    expect(
      readerRoutesFor("python-source", ["python-source"])[0],
    ).toMatchObject({
      tool: "inspect_python_artifact",
      requires: expect.stringMatching(/CPython/u),
    });
    const elf = readerRoutesFor("elf", ["elf"]);
    expect(elf.map((route) => route.tool)).toContain("open_binary");
    expect(elf.find((route) => route.tool === "open_binary")).toMatchObject({
      automatic: false,
      requires: expect.stringMatching(/Hopper, Ghidra or IDA/u),
    });
  });

  it("runs the PDF and Office readers for a named or byte-established document", () => {
    const OLE = Buffer.from([
      0xd0,
      0xcf,
      0x11,
      0xe0,
      0xa1,
      0xb1,
      0x1a,
      0xe1,
      ...Array<number>(56).fill(0),
    ]);
    const PDF = Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n", "latin1");
    const pdf = chooseFormat(detect(PDF, "scan.bin"));
    expect(pdf).toMatchObject({ format: "pdf", basis: "bytes" });
    expect(automaticRouteFor(pdf.format, pdf.candidates)?.tool).toBe(
      "inspect_pdf_document",
    );
    for (const [bytes, name, format] of [
      [ZIP, "plan.docx", "ooxml-document"],
      [ZIP, "plan.xlsm", "ooxml-macro-document"],
      [OLE, "plan.doc", "ole-office-document"],
    ] as const) {
      const choice = chooseFormat(detect(bytes, name));
      expect(choice.format).toBe(format);
      expect(automaticRouteFor(choice.format, choice.candidates)?.tool).toBe(
        "inspect_office_document",
      );
    }
    // A plain archive is not routed to the Office reader by its bytes alone.
    const plain = chooseFormat(detect(ZIP, "archive.zip"));
    expect(automaticRouteFor(plain.format, plain.candidates)).toBeUndefined();
  });

  it("gives the document reader its profile when the name has no suffix", () => {
    const route = automaticRouteFor("json", ["json"]);
    expect(route?.summary("/tmp/p1/member", "json")).toEqual({
      path: "/tmp/p1/member",
      format: "json",
      limit: 1,
    });
    expect(route?.step("/data/a.json", "json")).toEqual({
      path: "/data/a.json",
      format: "json",
    });
  });
});

describe("headlines", () => {
  it("never invents a headline for an unknown tool or a mismatched report", () => {
    expect(headlineFromReport("inspect_nothing", {})).toEqual({
      ok: false,
      reason: "No headline is defined for inspect_nothing.",
      refuted: false,
    });
    expect(
      headlineFromReport("inspect_linux_package", { wrong: true }),
    ).toEqual({
      ok: false,
      reason: "The reader's report did not match its own schema.",
      refuted: false,
    });
  });
});

const counters = (
  overrides: Partial<IdentificationCounters> = {},
): IdentificationCounters => ({
  entries: 0,
  entryLimit: false,
  containersOpened: 0,
  containersNotOpened: 0,
  containersStopped: 0,
  readersRun: 0,
  readersNotRun: 0,
  spooledBytes: 0,
  spoolLimit: false,
  symlinks: 0,
  special: 0,
  unreadable: 0,
  diagnosticsOmitted: 0,
  ...overrides,
});

const piece = (
  index: number,
  fields: Partial<WalkedPiece> & Pick<WalkedPiece, "path" | "name">,
): WalkedPiece => ({
  id: `p${String(index)}`,
  parent: index === 0 ? null : "p0",
  depth: 0,
  kind: "file",
  bytes: 10,
  format: null,
  format_basis: null,
  label: null,
  candidates: [],
  name_conflict: null,
  container: { state: "not_container", members: null, reason: null },
  reader: { tool: null, state: "none", reason: null },
  headline: null,
  onDisk: null,
  outer: null,
  hinted: [],
  fallback: null,
  openable: false,
  ...fields,
});

const SHA = "0".repeat(64);

describe("assembling the answer", () => {
  it("summarizes a folder by format, most frequent first, and pages pieces", () => {
    const walk: IdentificationWalk = {
      kind: "directory",
      path: "/data",
      bytes: 3 * 1024 * 1024,
      sha256: SHA,
      detection: null,
      depth: 0,
      counters: counters({ entries: 4 }),
      diagnostics: [],
      limitations: [],
      pieces: [
        piece(0, {
          path: "",
          name: "data",
          kind: "directory",
          format: "directory",
          format_basis: "filesystem",
          label: "Directory tree",
          onDisk: "/data",
        }),
        piece(1, {
          path: "a.json",
          name: "a.json",
          format: "json",
          label: "JSON",
          onDisk: "/data/a.json",
          format_basis: "name",
        }),
        piece(2, {
          path: "b.json",
          name: "b.json",
          format: "json",
          label: "JSON",
          onDisk: "/data/b.json",
          format_basis: "name",
        }),
        piece(3, {
          path: "tool",
          name: "tool",
          format: "elf",
          label: "ELF image",
          onDisk: "/data/tool",
          format_basis: "bytes",
        }),
        piece(4, { path: "blob", name: "blob", onDisk: "/data/blob" }),
      ],
    };
    const input = identifyArtifactInputSchema.parse({
      path: "/data",
      limit: 2,
    });
    const answer = assembleIdentification(input, walk);
    expect(answer.answer.summary).toBe(
      "Folder with 4 files in 0 subfolders (3.0 MiB): JSON (2), ELF image (1), unrecognized (1).",
    );
    expect(answer.formats.map(({ label, count }) => [label, count])).toEqual([
      ["JSON", 2],
      ["ELF image", 1],
      ["Unrecognized", 1],
    ]);
    expect(answer.page).toEqual({ start: 0, limit: 2, returned: 2, next: 2 });
    expect(answer.pieces.map(({ id }) => id)).toEqual(["p0", "p1"]);
    // One step set per format: the second JSON file adds nothing.
    expect(
      answer.next_steps.filter((step) => step.tool === "inspect_document"),
    ).toEqual([
      expect.objectContaining({
        piece: "p1",
        arguments: { path: "/data/a.json", format: "json" },
        open_first: null,
      }),
    ]);
    expect(answer.next_steps.map((step) => step.tool)).toEqual(
      expect.arrayContaining([
        "inspect_desktop_application",
        "inspect_go_binary",
        "open_binary",
      ]),
    );
  });
});

describe("assembling the answer for nested pieces", () => {
  it("joins pieces inside one container into one extract step on the file that holds them", () => {
    const walk: IdentificationWalk = {
      kind: "file",
      path: "/data/bundle.tar.gz",
      bytes: 2048,
      sha256: SHA,
      detection: null,
      depth: 3,
      counters: counters({ entries: 3, containersOpened: 2, entryLimit: true }),
      diagnostics: [],
      limitations: [],
      pieces: [
        piece(0, {
          path: "",
          name: "bundle.tar.gz",
          format: "gzip",
          label: "Gzip stream",
          format_basis: "bytes",
          onDisk: "/data/bundle.tar.gz",
          openable: true,
          container: { state: "opened", members: 2, reason: null },
        }),
        piece(1, {
          path: "app.whl",
          name: "app.whl",
          depth: 1,
          format: "wheel",
          label: "Python wheel",
          format_basis: "reader",
          outer: "p0",
          openable: true,
          container: { state: "opened", members: 1, reason: null },
        }),
        piece(2, {
          path: "app.whl/mod.py",
          name: "mod.py",
          depth: 2,
          parent: "p1",
          format: "python-source",
          label: "Python source",
          format_basis: "name",
          outer: "p0",
        }),
      ],
    };
    const answer = assembleIdentification(
      identifyArtifactInputSchema.parse({ path: "/data/bundle.tar.gz" }),
      walk,
    );
    expect(answer.answer.summary).toBe(
      "Gzip stream (2.0 KiB). It holds 2 files across 2 opened containers: Python source (1), Python wheel (1). The walk stopped at the 3-entry budget (max_entries), so the counts are partial.",
    );
    const extract = answer.next_steps.filter(
      (step) => step.tool === "extract_artifact",
    );
    expect(extract).toHaveLength(1);
    expect(extract[0]).toMatchObject({
      piece: "p0",
      open_first: "/data/bundle.tar.gz",
      arguments: { integrity_policy: "record-and-continue" },
    });
    expect(extract[0]?.why).toContain("app.whl (inspect_python_artifact)");
    expect(extract[0]?.why).toContain(
      "app.whl/mod.py (inspect_python_artifact)",
    );
    expect(extract[0]?.why).toContain("more than one container deep");
    expect(
      answer.next_steps.find((step) => step.tool === "inspect_artifact"),
    ).toMatchObject({
      piece: "p0",
      open_first: "/data/bundle.tar.gz",
    });
  });

  it("states sizes in binary units", () => {
    expect(sizeText(1)).toBe("1 byte");
    expect(sizeText(1023)).toBe("1,023 bytes");
    expect(sizeText(1536)).toBe("1.5 KiB");
    expect(sizeText(5 * 1024 ** 3)).toBe("5.0 GiB");
  });
});

describe("assembling what the answer leaves out", () => {
  it("names unrecognized extensions, says when a root container stopped, and counts steps it left out", () => {
    const files = Array.from({ length: 20 }, (_, index) =>
      piece(index + 1, {
        path: `f${String(index)}.${index < 15 ? "ts" : "rs"}`,
        name: `f${String(index)}.${index < 15 ? "ts" : "rs"}`,
        depth: 1,
        outer: "p0",
      }),
    );
    // Eleven formats with routes on disk need more than sixteen steps.
    const kinds = [
      "json",
      "yaml",
      "toml",
      "xml",
      "csv",
      "tsv",
      "markdown",
      "jsonl",
      "plain-text",
      "elf",
      "pe",
    ] as const;
    const formatted = kinds.map((format, index) =>
      piece(index + 21, {
        path: `doc${String(index)}`,
        name: `doc${String(index)}`,
        onDisk: `/data/doc${String(index)}`,
        format,
        label: "Text",
        format_basis: "name",
        openable: false,
      }),
    );
    const walk: IdentificationWalk = {
      kind: "file",
      path: "/data/broken.zip",
      bytes: 100,
      sha256: SHA,
      detection: null,
      depth: 3,
      counters: counters({ containersOpened: 1, containersStopped: 1 }),
      diagnostics: [],
      limitations: [],
      pieces: [
        piece(0, {
          path: "",
          name: "broken.zip",
          format: "zip",
          label: "ZIP archive",
          format_basis: "bytes",
          onDisk: "/data/broken.zip",
          openable: true,
          container: {
            state: "opened",
            members: 20,
            reason: "Stopped reading after 20 members: invalid deflate data",
          },
        }),
        ...files,
        ...formatted,
      ],
    };
    const answer = assembleIdentification(
      identifyArtifactInputSchema.parse({ path: "/data/broken.zip" }),
      walk,
    );
    expect(answer.answer.summary).toContain(
      "Stopped reading after 20 members: invalid deflate data.",
    );
    expect(answer.answer.summary).not.toContain(
      "nested containers could not be read",
    );
    expect(answer.unrecognized_extensions).toEqual([
      { extension: ".ts", count: 15 },
      { extension: ".rs", count: 5 },
    ]);
    expect(answer.next_steps.length).toBeLessThanOrEqual(16);
    expect(answer.next_steps_omitted).toBeGreaterThan(0);
    expect(answer.next_steps[0]).toMatchObject({
      piece: "p0",
      tool: "inspect_artifact",
    });
  });
});
