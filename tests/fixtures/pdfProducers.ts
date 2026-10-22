import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

/**
 * PDF fixtures. Real files come from the producers on this host: macOS Quartz
 * through `cupsfilter` and `sips`, pdfTeX, Ghostscript (encryption) and
 * Poppler's `pdfattach`. Anything those tools never write (scripts, launch
 * actions, signature dictionaries, damaged cross-reference data, incremental
 * updates) is assembled byte by byte from the file format's own syntax.
 * Poppler's `pdfinfo`, `pdftotext`, `pdfdetach` and `pdfimages` are the oracles.
 */

const first = (...paths: string[]): string | null =>
  paths.find((path) => existsSync(path)) ?? null;

export const CUPSFILTER = first("/usr/sbin/cupsfilter");
export const SIPS = first("/usr/bin/sips");
export const PDFLATEX = first(
  "/opt/homebrew/bin/pdflatex",
  "/usr/local/bin/pdflatex",
);
export const GS = first("/opt/homebrew/bin/gs", "/usr/local/bin/gs");
export const PDFATTACH = first(
  "/opt/homebrew/bin/pdfattach",
  "/usr/local/bin/pdfattach",
);
export const PDFTOPPM = first(
  "/opt/homebrew/bin/pdftoppm",
  "/usr/local/bin/pdftoppm",
);
export const PDFINFO = first(
  "/opt/homebrew/bin/pdfinfo",
  "/usr/local/bin/pdfinfo",
);
export const PDFTOTEXT = first(
  "/opt/homebrew/bin/pdftotext",
  "/usr/local/bin/pdftotext",
);
export const PDFDETACH = first(
  "/opt/homebrew/bin/pdfdetach",
  "/usr/local/bin/pdfdetach",
);
export const PDFIMAGES = first(
  "/opt/homebrew/bin/pdfimages",
  "/usr/local/bin/pdfimages",
);

const run = (command: string, args: string[], cwd?: string): string =>
  execFileSync(command, args, {
    cwd,
    env: {
      PATH: "/usr/bin:/bin:/opt/homebrew/bin",
      SOURCE_DATE_EPOCH: "1700000000",
      FORCE_SOURCE_DATE: "1",
    },
    encoding: "latin1",
    maxBuffer: 64 * 1024 ** 2,
  });

export const scratch = async (): Promise<string> =>
  await mkdtemp(join(tmpdir(), "rea-pdf-"));
export const remove = async (path: string): Promise<void> => {
  await rm(path, { recursive: true, force: true });
};

/** Plain text through the macOS print filter: a one-font Quartz PDF with a text layer. */
export const quartzPdf = async (
  dir: string,
  name: string,
  text: string,
): Promise<string> => {
  if (CUPSFILTER === null) throw new Error("cupsfilter is not installed");
  const source = join(dir, `${name}.txt`);
  await writeFile(source, text);
  const out = execFileSync(CUPSFILTER, [source], {
    encoding: "buffer",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 64 * 1024 ** 2,
  });
  const path = join(dir, `${name}.pdf`);
  await writeFile(path, out);
  return path;
};

/** A pdfTeX document: PDF 1.5 object streams and a cross-reference stream. */
export const latexPdf = async (
  dir: string,
  name: string,
  body: string,
): Promise<string> => {
  if (PDFLATEX === null) throw new Error("pdflatex is not installed");
  const work = join(dir, name);
  await mkdir(work);
  await writeFile(
    join(work, `${name}.tex`),
    `\\documentclass{article}\\begin{document}${body}\\end{document}\n`,
  );
  run(
    PDFLATEX,
    ["-interaction=batchmode", "-no-shell-escape", `${name}.tex`],
    work,
  );
  return join(work, `${name}.pdf`);
};

export interface EncryptOptions {
  readonly user: string;
  readonly owner: string;
  /** Ghostscript's -dEncryptionR (2 RC4-40, 3 RC4-128, 4 AES-128, 5/6 AES-256). */
  readonly revision?: number;
  readonly keyLength?: number;
  /** Ghostscript's -dPermissions bit mask (a negative 32-bit value). */
  readonly permissions?: number;
}

/** Ghostscript's pdfwrite with a user and owner password. */
export const gsEncrypt = async (
  dir: string,
  source: string,
  name: string,
  options: EncryptOptions,
): Promise<string> => {
  if (GS === null) throw new Error("gs is not installed");
  const path = join(dir, `${name}.pdf`);
  const args = [
    "-q",
    "-dNOPAUSE",
    "-dBATCH",
    "-sDEVICE=pdfwrite",
    `-sOwnerPassword=${options.owner}`,
    `-sUserPassword=${options.user}`,
  ];
  if (options.revision !== undefined)
    args.push(`-dEncryptionR=${String(options.revision)}`);
  if (options.keyLength !== undefined)
    args.push(`-dKeyLength=${String(options.keyLength)}`);
  if (options.permissions !== undefined)
    args.push(`-dPermissions=${String(options.permissions)}`);
  args.push(`-sOutputFile=${path}`, source);
  run(GS, args);
  return path;
};

/** Poppler's pdfattach: an incremental update that embeds a file. */
export const attachFile = async (
  dir: string,
  source: string,
  attachment: string,
  name: string,
): Promise<string> => {
  if (PDFATTACH === null) throw new Error("pdfattach is not installed");
  const path = join(dir, `${name}.pdf`);
  run(PDFATTACH, [source, attachment, path]);
  return path;
};

/** A page that is one raster image and no text: rasterize with Poppler, wrap with sips. */
export const scannedPdf = async (
  dir: string,
  source: string,
  name: string,
): Promise<string> => {
  if (PDFTOPPM === null || SIPS === null)
    throw new Error("pdftoppm or sips is not installed");
  const prefix = join(dir, `${name}-raster`);
  run(PDFTOPPM, ["-png", "-r", "60", "-f", "1", "-l", "1", source, prefix]);
  const path = join(dir, `${name}.pdf`);
  run(SIPS, ["-s", "format", "pdf", `${prefix}-1.png`, "--out", path]);
  return path;
};

export const oracle = {
  info: (path: string, userPassword?: string): string =>
    run(
      PDFINFO as string,
      userPassword === undefined ? [path] : ["-upw", userPassword, path],
    ),
  text: (path: string, first: number, last: number): string =>
    run(PDFTOTEXT as string, [
      "-f",
      String(first),
      "-l",
      String(last),
      "-enc",
      "UTF-8",
      "-eol",
      "unix",
      path,
      "-",
    ]),
  attachments: (path: string): string =>
    run(PDFDETACH as string, ["-list", path]),
  images: (path: string): string => run(PDFIMAGES as string, ["-list", path]),
};

export const readBytes = async (path: string): Promise<Uint8Array> =>
  new Uint8Array(await readFile(path));

// ---- hand-assembled files ---------------------------------------------------

const latin1 = (text: string): Uint8Array =>
  Uint8Array.from(text, (char) => char.charCodeAt(0) & 0xff);

export interface PdfObject {
  readonly num: number;
  /** The object's text, or the stream dictionary's entries (without Length) when `stream` is set. */
  readonly body: string;
  readonly stream?: Uint8Array | string;
  /** Compress `stream` and add the filter entry. */
  readonly flate?: boolean;
}

export interface BuildOptions {
  readonly version?: string;
  readonly root?: number;
  readonly trailer?: string;
  /** Bytes in front of the %PDF- header; offsets then count from the header unless `absolute`. */
  readonly prefix?: string;
  readonly absolute?: boolean;
  /** Add this to every in-use offset in the table, to make them wrong. */
  readonly skew?: number;
  /** Leave out the xref table, trailer and startxref entirely. */
  readonly noXref?: boolean;
  /** Keep the xref table and trailer but point startxref at nothing. */
  readonly badStartxref?: boolean;
}

const objectBytes = (object: PdfObject): Uint8Array => {
  if (object.stream === undefined)
    return latin1(`${String(object.num)} 0 obj\n${object.body}\nendobj\n`);
  const raw =
    typeof object.stream === "string" ? latin1(object.stream) : object.stream;
  const data = object.flate === true ? new Uint8Array(deflateSync(raw)) : raw;
  const dict = `<< ${object.body} ${object.flate === true ? "/Filter /FlateDecode " : ""}/Length ${String(data.length)} >>`;
  return concat([
    latin1(`${String(object.num)} 0 obj\n${dict}\nstream\n`),
    data,
    latin1("\nendstream\nendobj\n"),
  ]);
};

export const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

const pad = (value: number, width: number): string =>
  String(value).padStart(width, "0");

/** A classic cross-reference table over the objects, in the order given. */
export const buildPdf = (
  objects: readonly PdfObject[],
  options: BuildOptions = {},
): Uint8Array => {
  const prefix = options.prefix ?? "";
  const parts: Uint8Array[] = [
    latin1(prefix),
    latin1(`%PDF-${options.version ?? "1.7"}\n%\xe2\xe3\xcf\xd3\n`),
  ];
  const base = options.absolute === true ? 0 : prefix.length;
  let size = parts[0]!.length + parts[1]!.length;
  const offsets = new Map<number, number>();
  for (const object of objects) {
    offsets.set(object.num, size - base);
    const bytes = objectBytes(object);
    parts.push(bytes);
    size += bytes.length;
  }
  if (options.noXref === true) return concat(parts);
  const highest = Math.max(...objects.map((object) => object.num));
  let table = `xref\n0 ${String(highest + 1)}\n0000000000 65535 f \n`;
  for (let num = 1; num <= highest; num += 1) {
    const offset = offsets.get(num);
    table +=
      offset === undefined
        ? "0000000000 00000 f \n"
        : `${pad(offset + (options.skew ?? 0), 10)} 00000 n \n`;
  }
  const xrefAt = size - base;
  const trailer = `trailer\n<< /Size ${String(highest + 1)} /Root ${String(options.root ?? 1)} 0 R ${options.trailer ?? ""} >>\n`;
  parts.push(
    latin1(
      `${table}${trailer}startxref\n${options.badStartxref === true ? "99999999" : String(xrefAt)}\n%%EOF\n`,
    ),
  );
  return concat(parts);
};

/** An incremental update: new or replaced objects, a second table that points back with Prev. */
export const appendUpdate = (
  base: Uint8Array,
  objects: readonly PdfObject[],
  options: {
    readonly root?: number;
    readonly trailer?: string;
    readonly size: number;
  },
): Uint8Array => {
  const text = new TextDecoder("latin1").decode(base);
  const previous = Number(/startxref\s+(\d+)\s+%%EOF\s*$/u.exec(text)?.[1]);
  const parts: Uint8Array[] = [base];
  let size = base.length;
  const offsets = new Map<number, number>();
  for (const object of objects) {
    offsets.set(object.num, size);
    const bytes = objectBytes(object);
    parts.push(bytes);
    size += bytes.length;
  }
  let table = "xref\n";
  for (const num of [...offsets.keys()].sort((a, b) => a - b))
    table += `${String(num)} 1\n${pad(offsets.get(num) as number, 10)} 00000 n \n`;
  parts.push(
    latin1(
      `${table}trailer\n<< /Size ${String(options.size)} /Root ${String(options.root ?? 1)} 0 R /Prev ${String(previous)} ${options.trailer ?? ""} >>\nstartxref\n${String(size)}\n%%EOF\n`,
    ),
  );
  return concat(parts);
};

/** One page with a content stream: the smallest valid document. */
export const onePage = (
  content: string,
  extra: {
    readonly resources?: string;
    readonly page?: string;
    readonly catalog?: string;
  } = {},
): PdfObject[] => [
  { num: 1, body: `<< /Type /Catalog /Pages 2 0 R ${extra.catalog ?? ""} >>` },
  { num: 2, body: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
  {
    num: 3,
    body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << ${extra.resources ?? "/Font << /F1 5 0 R >>"} >> ${extra.page ?? ""} >>`,
  },
  { num: 4, body: "", stream: content, flate: true },
  { num: 5, body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" },
];
