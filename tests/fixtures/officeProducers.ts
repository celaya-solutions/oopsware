import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TextReader,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipWriter,
} from "@zip.js/zip.js";

/**
 * Office fixtures. Word files come from the real macOS producer (`textutil`);
 * no Excel or PowerPoint producer exists on this host, so those packages are
 * assembled from the schemas' own markup, the way the format specifies them.
 */

export const TEXTUTIL = existsSync("/usr/bin/textutil")
  ? "/usr/bin/textutil"
  : null;

export const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
export const R =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
export const S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
export const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
export const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
export const PKG_REL =
  "http://schemas.openxmlformats.org/package/2006/relationships";
const REL_TYPE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const CORE_TYPE =
  "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties";

export const XML_DECL =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

export const MAIN_TYPES = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
  docm: "application/vnd.ms-word.document.macroEnabled.main+xml",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
  xlsm: "application/vnd.ms-excel.sheet.macroEnabled.main+xml",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
} as const;

export const zip = async (
  entries: Readonly<Record<string, string | Uint8Array>>,
): Promise<Uint8Array> => {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  for (const [name, data] of Object.entries(entries))
    await writer.add(
      name,
      typeof data === "string"
        ? new TextReader(data)
        : new Uint8ArrayReader(data),
    );
  return await writer.close();
};

export interface Part {
  readonly type?: string;
  readonly data: string | Uint8Array;
}

export interface Link {
  readonly id: string;
  readonly type: string;
  readonly target: string;
  readonly external?: boolean;
}

const relsXml = (links: readonly Link[]): string =>
  `${XML_DECL}<Relationships xmlns="${PKG_REL}">${links
    .map(
      (link) =>
        `<Relationship Id="${link.id}" Type="${link.type}" Target="${link.target}"${link.external === true ? ' TargetMode="External"' : ""}/>`,
    )
    .join("")}</Relationships>`;

export const relType = (kind: string): string => `${REL_TYPE}/${kind}`;

export interface PackageSpec {
  readonly mainPath: string;
  readonly mainType: string;
  readonly main: string | Uint8Array;
  readonly mainLinks?: readonly Link[];
  readonly parts?: Readonly<Record<string, Part>>;
  readonly rootLinks?: readonly Link[];
  /** Extra links on other parts, keyed by part path. */
  readonly partLinks?: Readonly<Record<string, readonly Link[]>>;
  readonly core?: string;
  readonly app?: string;
  readonly custom?: string;
}

/** Assemble an Open Packaging Conventions package from parts and relationships. */
export const buildPackage = async (spec: PackageSpec): Promise<Uint8Array> => {
  const overrides = new Map<string, string>([
    [`/${spec.mainPath}`, spec.mainType],
  ]);
  const entries: Record<string, string | Uint8Array> = {};
  for (const [path, part] of Object.entries(spec.parts ?? {})) {
    entries[path] = part.data;
    if (part.type !== undefined) overrides.set(`/${path}`, part.type);
  }
  const rootLinks: Link[] = [
    { id: "rId1", type: relType("officeDocument"), target: spec.mainPath },
    ...(spec.rootLinks ?? []),
  ];
  if (spec.core !== undefined) {
    entries["docProps/core.xml"] = spec.core;
    rootLinks.push({
      id: "rIdCore",
      type: CORE_TYPE,
      target: "docProps/core.xml",
    });
    overrides.set(
      "/docProps/core.xml",
      "application/vnd.openxmlformats-package.core-properties+xml",
    );
  }
  if (spec.app !== undefined) {
    entries["docProps/app.xml"] = spec.app;
    rootLinks.push({
      id: "rIdApp",
      type: relType("extended-properties"),
      target: "docProps/app.xml",
    });
  }
  if (spec.custom !== undefined) {
    entries["docProps/custom.xml"] = spec.custom;
    rootLinks.push({
      id: "rIdCustom",
      type: relType("custom-properties"),
      target: "docProps/custom.xml",
    });
  }
  entries[spec.mainPath] = spec.main;
  entries["_rels/.rels"] = relsXml(rootLinks);
  const slash = spec.mainPath.lastIndexOf("/");
  const dir = spec.mainPath.slice(0, slash);
  const file = spec.mainPath.slice(slash + 1);
  if ((spec.mainLinks ?? []).length > 0)
    entries[`${dir}/_rels/${file}.rels`] = relsXml(spec.mainLinks ?? []);
  for (const [path, links] of Object.entries(spec.partLinks ?? {})) {
    const at = path.lastIndexOf("/");
    entries[`${path.slice(0, at)}/_rels/${path.slice(at + 1)}.rels`] =
      relsXml(links);
  }
  const content = `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${[
    ...overrides,
  ]
    .map(
      ([name, type]) => `<Override PartName="${name}" ContentType="${type}"/>`,
    )
    .join("")}</Types>`;
  return await zip({ "[Content_Types].xml": content, ...entries });
};

export const wordDocument = (body: string, extraNamespaces = ""): string =>
  `${XML_DECL}<w:document xmlns:w="${W}" xmlns:r="${R}" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"${extraNamespaces}><w:body>${body}</w:body></w:document>`;

export const para = (text: string, properties = ""): string =>
  `<w:p>${properties === "" ? "" : `<w:pPr>${properties}</w:pPr>`}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

export const workbook = (
  sheets: readonly { name: string; id: string; state?: string }[],
  extra = "",
  properties = "",
): string =>
  `${XML_DECL}<workbook xmlns="${S}" xmlns:r="${R}">${properties}<sheets>${sheets
    .map(
      (sheet, at) =>
        `<sheet name="${sheet.name}" sheetId="${String(at + 1)}"${sheet.state === undefined ? "" : ` state="${sheet.state}"`} r:id="${sheet.id}"/>`,
    )
    .join("")}</sheets>${extra}</workbook>`;

export const worksheet = (rows: string, extra = ""): string =>
  `${XML_DECL}<worksheet xmlns="${S}" xmlns:r="${R}"><sheetData>${rows}</sheetData>${extra}</worksheet>`;

export const sharedStrings = (...strings: readonly string[]): string =>
  `${XML_DECL}<sst xmlns="${S}" count="${String(strings.length)}" uniqueCount="${String(strings.length)}">${strings
    .map((value) =>
      value.startsWith("<") ? `<si>${value}</si>` : `<si><t>${value}</t></si>`,
    )
    .join("")}</sst>`;

export const slide = (shapes: string, attributes = ""): string =>
  `${XML_DECL}<p:sld xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}"${attributes}><p:cSld><p:spTree>${shapes}</p:spTree></p:cSld></p:sld>`;

export const shape = (
  name: string,
  paragraphs: readonly string[],
  placeholder?: string,
): string =>
  `<p:sp><p:nvSpPr><p:cNvPr id="2" name="${name}"/><p:cNvSpPr/><p:nvPr>${placeholder === undefined ? "" : `<p:ph type="${placeholder}"/>`}</p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/>${paragraphs
    .map((text) => `<a:p><a:r><a:t>${text}</a:t></a:r></a:p>`)
    .join("")}</p:txBody></p:sp>`;

export interface TextutilDocx {
  readonly docx: string;
  readonly text: string;
}

/** A real .docx written by macOS textutil, with textutil's own plain-text reading as the oracle. */
export const textutilDocx = async (
  directory: string,
  name: string,
  html: string,
): Promise<TextutilDocx> => {
  if (TEXTUTIL === null) throw new Error("textutil is not available.");
  await mkdir(directory, { recursive: true });
  const source = join(directory, `${name}.html`);
  const docx = join(directory, `${name}.docx`);
  const text = join(directory, `${name}.txt`);
  await writeFile(source, html);
  execFileSync(TEXTUTIL, ["-convert", "docx", source, "-output", docx]);
  execFileSync(TEXTUTIL, ["-convert", "txt", docx, "-output", text]);
  return { docx, text: await readFile(text, "utf8") };
};

const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;

/** A minimal version-3 compound file whose root holds the named empty streams. */
export const compoundFile = (streams: readonly string[]): Uint8Array => {
  const out = Buffer.alloc(512 * 3);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(out, 0);
  out.writeUInt16LE(0x3e, 24);
  out.writeUInt16LE(3, 26);
  out.writeUInt16LE(0xfffe, 28);
  out.writeUInt16LE(9, 30);
  out.writeUInt16LE(6, 32);
  out.writeUInt32LE(1, 44); // one FAT sector
  out.writeUInt32LE(1, 48); // directory starts at sector 1
  out.writeUInt32LE(4096, 56);
  out.writeUInt32LE(ENDOFCHAIN, 60);
  out.writeUInt32LE(ENDOFCHAIN, 68);
  for (let at = 0; at < 109; at += 1)
    out.writeUInt32LE(at === 0 ? 0 : FREESECT, 76 + at * 4);
  // Sector 0: the FAT. Sector 0 is the FAT itself, sector 1 the directory.
  for (let at = 0; at < 128; at += 1)
    out.writeUInt32LE(
      at === 0 ? 0xfffffffd : at === 1 ? ENDOFCHAIN : FREESECT,
      512 + at * 4,
    );
  const entry = (
    index: number,
    name: string,
    type: number,
    child: number,
    sibling: number,
  ): void => {
    const base = 1024 + index * 128;
    Buffer.from(name, "utf16le").copy(out, base);
    out.writeUInt16LE((name.length + 1) * 2, base + 64);
    out.writeUInt8(type, base + 66);
    out.writeUInt8(1, base + 67);
    out.writeUInt32LE(sibling, base + 68);
    out.writeUInt32LE(FREESECT, base + 72);
    out.writeUInt32LE(child, base + 76);
    out.writeUInt32LE(ENDOFCHAIN, base + 116);
  };
  const names = streams.slice(0, 3);
  entry(0, "Root Entry", 5, names.length === 0 ? FREESECT : 1, FREESECT);
  names.forEach((name, at) =>
    entry(at + 1, name, 2, FREESECT, at + 1 < names.length ? at + 2 : FREESECT),
  );
  for (let at = names.length + 1; at < 4; at += 1) {
    const base = 1024 + at * 128;
    out.writeUInt32LE(FREESECT, base + 68);
    out.writeUInt32LE(FREESECT, base + 72);
    out.writeUInt32LE(FREESECT, base + 76);
  }
  return out;
};
