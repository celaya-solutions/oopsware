import { createHash } from "node:crypto";

import { MemberReadFailure } from "../../artifacts/zipMemberView.js";
import type {
  OfficeExternalReference,
  OfficeNotable,
  OfficePackage,
} from "../../domain/officeDocument/officeDocument.js";
import type { CfbEntry } from "../../windowsInstaller/cfb.js";
import type { ReaderCounters } from "../reader.js";
import { decodeCodepage } from "./codepage.js";
import type { LegacyReaderArgs, LegacyStreams } from "./legacy.js";
import { MAX_CUSTOM, readLegacyProperties } from "./properties.js";

/** The file level facts of a legacy Office document: which kind it is, its properties and what it carries. */

export type LegacyKind = "doc" | "xls" | "ppt";

const FAMILY: Readonly<Record<LegacyKind, "word" | "excel" | "powerpoint">> = {
  doc: "word",
  xls: "excel",
  ppt: "powerpoint",
};

const MAIN_STREAMS: readonly [LegacyKind, readonly string[]][] = [
  ["doc", ["WordDocument"]],
  ["xls", ["Workbook", "Book"]],
  ["ppt", ["PowerPoint Document"]],
];

const NAME_KIND: Readonly<Record<string, LegacyKind>> = {
  doc: "doc",
  dot: "doc",
  xls: "xls",
  xlt: "xls",
  xla: "xls",
  ppt: "ppt",
  pot: "ppt",
  pps: "ppt",
  ppa: "ppt",
};

const MAX_NOTABLE = 200;
const MAX_EXTERNAL = 500;
const MAX_TARGET = 2_000;
const MAX_HASHED = 64;
const MAX_PROPERTY_STREAM = 8 * 1024 ** 2;
const MAX_COMPOUND_USER_TYPE = 512;

/** Control characters in stream names (\x01CompObj, \x05SummaryInformation) shown as \xNN escapes. */
export const displayName = (name: string): string =>
  // eslint-disable-next-line no-control-regex
  name.replace(
    /[\u0000-\u001f\u007f]/gu,
    (ch) => `\\x${ch.charCodeAt(0).toString(16).padStart(2, "0")}`,
  );

export const displayPath = (entry: CfbEntry): string =>
  entry.path.map(displayName).join("/");

/** The kind a compound file is, from its main stream; never from the file name. */
export const classifyLegacy = (
  streams: LegacyStreams,
): { kind: LegacyKind; mainPart: string } | null => {
  for (const [kind, names] of MAIN_STREAMS)
    for (const name of names) {
      const entry = streams.find([name]);
      if (entry?.type === "stream") return { kind, mainPart: entry.name };
    }
  return null;
};

const underStorage = (entry: CfbEntry, storage: CfbEntry): boolean =>
  entry.path.length > storage.path.length &&
  storage.path.every((name, at) => entry.path[at] === name);

/** ProgID and user type of an embedded object's \x01CompObj stream ([MS-OLEDS] 2.3.7); null when it does not parse. */
const compObjSummary = (bytes: Uint8Array): string | null => {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let at = 28;
    const ansi = (): string => {
      const length = view.getUint32(at, true);
      if (length > MAX_COMPOUND_USER_TYPE || at + 4 + length > bytes.length)
        throw new RangeError("string");
      const text =
        length === 0
          ? ""
          : (decodeCodepage(
              1252,
              bytes.subarray(at + 4, at + 4 + length - 1),
            ) ?? "");
      at += 4 + length;
      return text;
    };
    const userType = ansi();
    // The clipboard format is 0 (none), 0xFFFFFFFF/0xFFFFFFFE (a standard format, 4 more bytes) or a name.
    const marker = view.getUint32(at, true);
    at += 4;
    if (marker >= 0xfffffffe) at += 4;
    else at += marker;
    const progId = at + 4 <= bytes.length ? ansi() : "";
    const parts = [
      userType === "" ? null : `type "${userType}"`,
      progId === "" ? null : `ProgID ${progId}`,
    ].filter((part): part is string => part !== null);
    return parts.length === 0 ? null : parts.join(", ");
  } catch {
    return null;
  }
};

interface Unit {
  readonly kind: OfficeNotable["kind"];
  readonly entry: CfbEntry;
  readonly note: string;
}

const NOT_RUN =
  "Its presence is a declaration; nothing is extracted or run, and this is not a safety verdict.";

/** Find the storages that hold macros, embedded objects and signatures, from the directory alone. */
const units = (entries: readonly CfbEntry[]): Unit[] => {
  const found: Unit[] = [];
  for (const entry of entries) {
    if (entry.type === "root") continue;
    const top = entry.path[0]?.toUpperCase() ?? "";
    if (entry.path.length === 1 && entry.type === "storage") {
      if (top === "MACROS" || top === "_VBA_PROJECT_CUR" || top === "VBA")
        found.push({
          kind: "macro-project",
          entry,
          note: `A VBA project storage. ${NOT_RUN}`,
        });
      else if (/^MBD[0-9A-F]{8}$/u.test(top))
        found.push({
          kind: "ole-object",
          entry,
          note: "An embedded OLE object (Excel object storage); its contents are not read.",
        });
    }
    // VBA project signature streams sit in the project's storage, at any depth.
    if (
      entry.type === "stream" &&
      entry.name.toUpperCase().startsWith("\u0005DIGITALSIGNATURE")
    )
      found.push({
        kind: "macro-signature",
        entry,
        note: "Signature data for the VBA project; not verified.",
      });
    // Binary document signatures ([MS-OFFCRYPTO] 2.5): root-level _xmlsignatures and _signatures.
    if (
      entry.path.length === 1 &&
      (top === "_XMLSIGNATURES" || top === "_SIGNATURES")
    )
      found.push({
        kind: "digital-signature",
        entry,
        note: "Document signature data; not verified.",
      });
    if (
      entry.path.length === 2 &&
      entry.type === "storage" &&
      top === "OBJECTPOOL"
    )
      found.push({
        kind: "ole-object",
        entry,
        note: "An embedded OLE object (Word object pool); its contents are not read.",
      });
  }
  return found;
};

export interface LegacySummary {
  readonly kind: LegacyKind;
  readonly mainPart: string;
  /** The package facts as they stand now: readers add notable items and references while they open and walk the document. */
  finish(): Omit<OfficePackage, "decoded_bytes" | "statistics">;
}

export interface LegacyCollected {
  readonly notable: OfficeNotable[];
  notableTotal: number;
  readonly external: OfficeExternalReference[];
  externalTotal: number;
  /** A reader found macros that the directory does not show (a PowerPoint VBA object, an Excel 4.0 macro sheet). */
  macroFound: boolean;
  readonly seen: Set<string>;
}

export const newCollected = (): LegacyCollected => ({
  notable: [],
  notableTotal: 0,
  external: [],
  externalTotal: 0,
  macroFound: false,
  seen: new Set(),
});

/** What the readers call to declare notable items and external references; capped, deduplicated, counted. */
export const collectorSinks = (
  collected: LegacyCollected,
  counters: ReaderCounters,
): Pick<LegacyReaderArgs, "notable" | "external"> => ({
  notable: (notable) => {
    collected.notableTotal += 1;
    counters.add(`${notable.kind.replaceAll("-", "_")}_parts`);
    if (notable.kind === "macro-project" || notable.kind === "macro-sheet")
      collected.macroFound = true;
    if (collected.notable.length < MAX_NOTABLE) collected.notable.push(notable);
  },
  external: (reference) => {
    // Cap before keying: a hostile target must not be copied into the dedup set at full length.
    const target =
      reference.target.length > MAX_TARGET
        ? `${reference.target.slice(0, MAX_TARGET)}…`
        : reference.target;
    const key = `${reference.source ?? ""}\u0000${reference.kind}\u0000${target}`;
    if (collected.seen.has(key)) return;
    collected.seen.add(key);
    collected.externalTotal += 1;
    if (collected.external.length < MAX_EXTERNAL)
      collected.external.push({ ...reference, target });
  },
});

/**
 * Describe the file as a package: its kind, properties, the storages that carry
 * macros or embedded objects (hashed inside the decoding budget) and the
 * problems the container reader found. Readers add their own notable items and
 * external references to `collected` as they open and walk the document.
 */
export const summarizeLegacy = async (
  streams: LegacyStreams,
  fileName: string,
  containerProblems: readonly string[],
  counters: ReaderCounters,
  collected: LegacyCollected,
  signal: AbortSignal | undefined,
): Promise<LegacySummary | null> => {
  const classified = classifyLegacy(streams);
  if (classified === null) return null;
  const problems = [...containerProblems];
  const others = MAIN_STREAMS.filter(
    ([kind, names]) =>
      kind !== classified.kind &&
      names.some((name) => streams.find([name])?.type === "stream"),
  );
  if (others.length > 0)
    problems.push(
      `The file also has the main stream of a legacy ${others.map(([kind]) => kind).join(" and ")} document; it is read as a ${classified.kind}.`,
    );

  const extension = /\.([A-Za-z0-9]+)$/u.exec(fileName)?.[1]?.toLowerCase();
  const hinted = extension === undefined ? undefined : NAME_KIND[extension];
  const nameConflict =
    extension !== undefined &&
    /^(?:docx|docm|dotx|dotm|xlsx|xlsm|xltx|xltm|xlam|xlsb|pptx|pptm|potx|potm|ppsx|ppsm|ppam)$/u.test(
      extension,
    )
      ? `The file name says .${extension}; the content is a legacy ${classified.kind} compound file, not an Open XML package.`
      : hinted !== undefined && hinted !== classified.kind
        ? `The file name says .${extension ?? ""}; the content is a legacy ${classified.kind} file.`
        : null;

  const readProperty = async (
    name: string,
  ): Promise<Uint8Array | undefined> => {
    const entry = streams.find([name]);
    if (entry === undefined || entry.type !== "stream") return undefined;
    if (entry.size > MAX_PROPERTY_STREAM) {
      problems.push(
        `The ${displayName(name)} stream is ${String(entry.size)} bytes, over the ${String(MAX_PROPERTY_STREAM)}-byte property limit; it is not read.`,
      );
      return undefined;
    }
    try {
      return await streams.read(entry);
    } catch (cause) {
      if (cause instanceof MemberReadFailure && cause.reason === "cancelled")
        throw cause;
      problems.push(
        `The ${displayName(name)} stream was not read: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      return undefined;
    }
  };
  const properties = readLegacyProperties(
    await readProperty("\u0005SummaryInformation"),
    await readProperty("\u0005DocumentSummaryInformation"),
  );
  for (const problem of properties.problems) problems.push(problem);

  let hasVba = false;
  let hashed = 0;
  for (const unit of units(streams.entries)) {
    signal?.throwIfAborted();
    collected.notableTotal += 1;
    counters.add(`${unit.kind.replaceAll("-", "_")}_parts`);
    if (unit.kind === "macro-project") hasVba = true;
    if (collected.notable.length >= MAX_NOTABLE) continue;
    const members = streams.entries.filter(
      (entry) =>
        entry.type === "stream" &&
        (entry === unit.entry || underStorage(entry, unit.entry)),
    );
    const bytes = members.reduce((sum, entry) => sum + entry.size, 0);
    let sha256: string | null = null;
    let note = unit.note;
    if (hashed >= MAX_HASHED)
      note = `${note} Not hashed: more than ${String(MAX_HASHED)} items.`;
    else {
      hashed += 1;
      try {
        const hash = createHash("sha256");
        for (const member of members) hash.update(await streams.read(member));
        sha256 = hash.digest("hex");
        note = `${note} SHA-256 is of its streams' bytes in directory order.`;
      } catch (cause) {
        if (cause instanceof MemberReadFailure && cause.reason === "cancelled")
          throw cause;
        note = `${note} Not hashed: ${cause instanceof Error ? cause.message : String(cause)}`;
      }
    }
    if (unit.kind === "ole-object") {
      const compObj = members.find(
        (entry) => entry.name === "\u0001CompObj" && entry.size < 4096,
      );
      if (compObj !== undefined) {
        try {
          const described = compObjSummary(await streams.read(compObj));
          if (described !== null) note = `${note} Declared as ${described}.`;
        } catch (cause) {
          if (
            cause instanceof MemberReadFailure &&
            cause.reason === "cancelled"
          )
            throw cause;
        }
      }
      if (members.some((entry) => entry.name === "\u0001Ole10Native"))
        note = `${note} It holds an Ole10Native package (an embedded file or link).`;
    }
    collected.notable.push({
      kind:
        unit.kind === "ole-object" &&
        members.some((entry) => entry.name === "\u0001Ole10Native")
          ? "embedded-package"
          : unit.kind,
      part: displayPath(unit.entry),
      content_type: null,
      bytes,
      sha256,
      note,
    });
  }

  const partCount = streams.entries.filter(
    (entry) => entry.type !== "root",
  ).length;
  return {
    kind: classified.kind,
    mainPart: classified.mainPart,
    finish: () => ({
      kind: classified.kind,
      family: FAMILY[classified.kind],
      macro_enabled: hasVba || collected.macroFound,
      main_part: classified.mainPart,
      main_content_type: null,
      name_conflict: nameConflict,
      conformance: "unknown",
      part_count: partCount,
      properties: {
        core: properties.core,
        app: properties.app,
        custom: properties.custom.slice(0, MAX_CUSTOM),
        custom_total: properties.customTotal,
      },
      notable: collected.notable,
      notable_total: collected.notableTotal,
      external_references: collected.external,
      external_total: collected.externalTotal,
      problems,
    }),
  };
};
