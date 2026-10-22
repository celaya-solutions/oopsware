import { createHash, randomUUID } from "node:crypto";
import {
  access,
  constants,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PdfLayoutPage } from "../domain/pdfDocument/pdfDocument.js";
import {
  OwnedCommandFailure,
  runOwnedCommand,
} from "../process/OwnedCommand.js";
import { printable } from "./text.js";

/**
 * Poppler `pdftotext` builds admitted for page text. A build is admitted by the
 * SHA-256 of its executable; any other digest is reported as unavailable, not
 * run on trust. The shared libpoppler it loads is not separately digested, so
 * the version string is a record, not a proof.
 */
export const ADMITTED_POPPLER_BUILDS: readonly {
  readonly sha256: string;
  readonly version: string;
  readonly build: string;
}[] = [
  {
    sha256: "52cb759b328134d667e0e9ba9142e952811473fba6caa3a053ff1e2605512fd9",
    version: "26.08.0",
    build: "Homebrew poppler 26.08.0 for macOS arm64",
  },
];

const candidates = (): string[] => [
  "/opt/homebrew/bin/pdftotext",
  "/usr/local/bin/pdftotext",
  "/usr/bin/pdftotext",
];

export interface ResolvedPdftotext {
  readonly path: string;
  readonly sha256: string;
  readonly version: string;
  readonly build: string;
}

/** Why page text cannot be read here; reported, never guessed around. */
export class PdftotextUnavailable extends Error {
  readonly _tag = "PdftotextUnavailable";
}

const executable = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

let resolving: Promise<ResolvedPdftotext> | null = null;

/** Locate an admitted pdftotext; cached per process, retried after a failure. */
export const resolvePdftotext = (): Promise<ResolvedPdftotext> => {
  if (resolving === null) {
    resolving = locate();
    resolving.catch(() => {
      resolving = null;
    });
  }
  return resolving;
};

const locate = async (): Promise<ResolvedPdftotext> => {
  const found: string[] = [];
  for (const candidate of candidates()) {
    if (!(await executable(candidate))) continue;
    const path = await realpath(candidate);
    const sha256 = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
    const admitted = ADMITTED_POPPLER_BUILDS.find(
      (build) => build.sha256 === sha256,
    );
    if (admitted === undefined) {
      found.push(`${path} (sha256 ${sha256})`);
      continue;
    }
    return { path, sha256, version: admitted.version, build: admitted.build };
  }
  throw new PdftotextUnavailable(
    found.length === 0
      ? `Poppler pdftotext is not installed at ${candidates().join(", ")}. Install poppler; the package and pages views still work without it.`
      : `No admitted pdftotext build was found; ${found.join(", ")} ${found.length === 1 ? "is" : "are"} not admitted. Admitted: ${ADMITTED_POPPLER_BUILDS.map((build) => `${build.build} (sha256 ${build.sha256})`).join(", ")}.`,
  );
};

/** Largest TSV read back; a larger page range is refused so memory stays bounded. */
export const MAX_TEXT_OUTPUT_BYTES = 64 * 1024 ** 2;
const DIAGNOSTIC_BYTES = 1024 ** 2;
const MAX_WARNINGS = 20;

export class PdftotextFailure extends Error {
  readonly _tag = "PdftotextFailure";
  constructor(
    readonly reason: "no-output" | "too-large" | "crashed" | "timeout",
    message: string,
  ) {
    super(message);
  }
}

/** Distinct stderr lines with the private scratch path removed. */
const warnings = (text: string, scratch: string): string[] =>
  [
    ...new Set(
      text
        .split("\n")
        .map((line) => line.trim().replaceAll(scratch, "<scratch>"))
        .filter((line) => line.length > 0),
    ),
  ].slice(0, MAX_WARNINGS);

/**
 * Run the admitted pdftotext on a private copy of the document for pages
 * `first` to `last` (1-based), with an empty environment. Returns the TSV it
 * wrote and what it printed to stderr.
 */
export const runPdftotext = async (request: {
  readonly tool: ResolvedPdftotext;
  readonly bytes: Uint8Array;
  readonly first: number;
  readonly last: number;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | undefined;
}): Promise<{ tsv: string; warnings: string[] }> => {
  const { tool, bytes, first, last, timeoutMs, signal } = request;
  const scratch = await mkdtemp(join(tmpdir(), "oopsware-pdftotext-"));
  try {
    const input = join(scratch, "in.pdf");
    const output = join(scratch, "out.tsv");
    await writeFile(input, bytes, { flag: "wx" });
    let printed: string;
    try {
      const snapshot = await runOwnedCommand(
        {
          command: tool.path,
          arguments: [
            "-f",
            String(first),
            "-l",
            String(last),
            "-tsv",
            "-enc",
            "UTF-8",
            "-eol",
            "unix",
            "-remove-hyphens",
            "none",
            input,
            output,
          ],
          runId: randomUUID(),
          cwd: scratch,
          hostEnvironment: {},
          ...(signal === undefined ? {} : { signal }),
        },
        { timeoutMs, diagnosticBytes: DIAGNOSTIC_BYTES },
        signal === undefined ? {} : { signal },
      );
      printed = `${snapshot.stderr.text}\n${snapshot.stdout.text}`;
    } catch (cause) {
      if (
        !(cause instanceof OwnedCommandFailure) ||
        cause.reason === "cancelled"
      )
        throw cause;
      const last3 = warnings(cause.snapshot?.stderr.text ?? "", scratch).slice(
        -3,
      );
      if (cause.reason === "timeout")
        throw new PdftotextFailure(
          "timeout",
          `pdftotext did not finish within ${String(timeoutMs)} ms.`,
        );
      const stop = cause.snapshot?.signal ?? null;
      throw new PdftotextFailure(
        "crashed",
        `${stop === null ? `pdftotext exited with code ${String(cause.snapshot?.exitCode ?? "unknown")}` : `pdftotext crashed (${stop}) on this document`}${last3.length === 0 ? "." : `; its last messages: ${last3.join(" ")}`}`,
      );
    }
    let size: number;
    try {
      size = (await stat(output)).size;
    } catch {
      throw new PdftotextFailure(
        "no-output",
        `pdftotext wrote no text. ${warnings(printed, scratch).slice(0, 3).join(" ")}`.trim(),
      );
    }
    if (size > MAX_TEXT_OUTPUT_BYTES)
      throw new PdftotextFailure(
        "too-large",
        `The text for pages ${String(first)} to ${String(last)} is ${String(size)} bytes, over the ${String(MAX_TEXT_OUTPUT_BYTES)}-byte limit; read fewer pages.`,
      );
    return {
      tsv: new TextDecoder("utf-8").decode(await readFile(output)),
      warnings: warnings(printed, scratch),
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
};

const round = (value: number): number => Math.round(value * 100) / 100;

/** Pages, lines and word counts from `pdftotext -tsv`; a line's box is the union of its words'. */
export const parseTsv = (tsv: string): PdfLayoutPage[] => {
  const pages: PdfLayoutPage[] = [];
  interface Building {
    page: PdfLayoutPage;
    lines: Map<
      string,
      {
        flow: number;
        block: number;
        line: number;
        box: [number, number, number, number];
        words: string[];
      }
    >;
  }
  let current: Building | null = null;
  const finish = () => {
    if (current === null) return;
    const lines = [...current.lines.values()].map((line) => ({
      flow: line.flow,
      block: line.block,
      line: line.line,
      bbox: line.box.map(round) as [number, number, number, number],
      text: line.words.join(" "),
    }));
    pages.push({ ...current.page, lines });
    current = null;
  };
  const rows = tsv.split("\n");
  for (let at = 1; at < rows.length; at += 1) {
    const cells = (rows[at] as string).split("\t");
    if (cells.length < 12) continue;
    const level = Number(cells[0]);
    // Poppler's own output is trusted for shape but not for finiteness: a bad cell becomes 0, never NaN.
    const count = (index: number) => {
      const value = Number(cells[index]);
      return Number.isSafeInteger(value) && value >= 0 ? value : 0;
    };
    const number = (index: number) => {
      const value = Number(cells[index]);
      return Number.isFinite(value) ? value : 0;
    };
    if (level === 1) {
      finish();
      current = {
        page: {
          page: Math.max(0, count(1) - 1),
          width: round(number(8)),
          height: round(number(9)),
          words: 0,
          lines: [],
        },
        lines: new Map(),
      };
    } else if (level === 5 && current !== null) {
      const text = printable(cells.slice(11).join(" "));
      if (text.length === 0) continue;
      // One line is one (flow, block, line): Poppler numbers lines within their block, blocks within their flow.
      const key = `${String(count(2))}:${String(count(3))}:${String(count(4))}`;
      const left = number(6);
      const top = number(7);
      const right = left + number(8);
      const bottom = top + number(9);
      const line = current.lines.get(key);
      if (line === undefined)
        current.lines.set(key, {
          flow: count(2),
          block: count(3),
          line: count(4),
          box: [left, top, right, bottom],
          words: [text],
        });
      else {
        line.box = [
          Math.min(line.box[0], left),
          Math.min(line.box[1], top),
          Math.max(line.box[2], right),
          Math.max(line.box[3], bottom),
        ];
        line.words.push(text);
      }
      current.page = { ...current.page, words: current.page.words + 1 };
    }
  }
  finish();
  return pages;
};
