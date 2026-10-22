import { MemberReadFailure } from "../artifacts/zipMemberView.js";
import type {
  OfficeExternalReference,
  OfficeNotable,
  OfficePackage,
} from "../domain/officeDocument/officeDocument.js";
import {
  byKind,
  type OpcPackage,
  type PackagePart,
  type Relationship,
} from "./package.js";
import type { ReaderCounters } from "./reader.js";
import { attr, childrenOf, type XmlElement } from "./xml.js";

/** Notable parts and external references listed in full detail; the totals count the rest. */
const MAX_NOTABLE = 200;
const MAX_EXTERNAL = 500;
const MAX_CUSTOM_PROPERTIES = 200;
const MAX_PROPERTY_VALUE = 2_000;
/** Notable parts hashed per call, each inside the decoding budget. */
const MAX_HASHED = 64;

type Kind = OfficePackage["kind"];
type Family = NonNullable<OfficePackage["family"]>;

interface MainType {
  readonly kind: Kind;
  readonly family: Family | null;
  readonly macro: boolean;
}

const MAIN_TYPE_TABLE: Readonly<Record<string, MainType>> = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml":
    { kind: "docx", family: "word", macro: false },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml":
    { kind: "dotx", family: "word", macro: false },
  "application/vnd.ms-word.document.macroEnabled.main+xml": {
    kind: "docm",
    family: "word",
    macro: true,
  },
  "application/vnd.ms-word.template.macroEnabledTemplate.main+xml": {
    kind: "dotm",
    family: "word",
    macro: true,
  },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml":
    { kind: "xlsx", family: "excel", macro: false },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml":
    { kind: "xltx", family: "excel", macro: false },
  "application/vnd.ms-excel.sheet.macroEnabled.main+xml": {
    kind: "xlsm",
    family: "excel",
    macro: true,
  },
  "application/vnd.ms-excel.template.macroEnabled.main+xml": {
    kind: "xltm",
    family: "excel",
    macro: true,
  },
  "application/vnd.ms-excel.addin.macroEnabled.main+xml": {
    kind: "xlam",
    family: "excel",
    macro: true,
  },
  "application/vnd.ms-excel.sheet.binary.macroEnabled.main": {
    kind: "xlsb",
    family: "excel",
    macro: true,
  },
  "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml":
    { kind: "pptx", family: "powerpoint", macro: false },
  "application/vnd.openxmlformats-officedocument.presentationml.template.main+xml":
    { kind: "potx", family: "powerpoint", macro: false },
  "application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml":
    { kind: "ppsx", family: "powerpoint", macro: false },
  "application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml": {
    kind: "pptm",
    family: "powerpoint",
    macro: true,
  },
  "application/vnd.ms-powerpoint.template.macroEnabled.main+xml": {
    kind: "potm",
    family: "powerpoint",
    macro: true,
  },
  "application/vnd.ms-powerpoint.slideshow.macroEnabled.main+xml": {
    kind: "ppsm",
    family: "powerpoint",
    macro: true,
  },
  "application/vnd.ms-powerpoint.addin.macroEnabled.main+xml": {
    kind: "ppam",
    family: "powerpoint",
    macro: true,
  },
};

const NAME_KIND =
  /\.(docx|dotx|docm|dotm|xlsx|xltx|xlsm|xltm|xlam|xlsb|pptx|potx|pptm|potm|ppsx|ppsm|ppam)$/iu;

/** Media types compare ignoring case; a lookup never reaches an inherited object property. */
const MAIN_TYPES: ReadonlyMap<string, MainType> = new Map(
  Object.entries(MAIN_TYPE_TABLE).map(([type, main]) => [
    type.toLowerCase(),
    main,
  ]),
);

export const classifyMain = (contentType: string | null): MainType =>
  (contentType === null
    ? undefined
    : MAIN_TYPES.get(contentType.toLowerCase())) ?? {
    kind: "unknown",
    family: null,
    macro: false,
  };

const truncate = (value: string): string =>
  value.length > MAX_PROPERTY_VALUE
    ? `${value.slice(0, MAX_PROPERTY_VALUE)}…`
    : value;

const CORE_FIELD_TABLE: Readonly<Record<string, string>> = {
  title: "title",
  subject: "subject",
  creator: "creator",
  keywords: "keywords",
  description: "description",
  lastModifiedBy: "last_modified_by",
  revision: "revision",
  created: "created",
  modified: "modified",
  lastPrinted: "last_printed",
  category: "category",
  contentStatus: "content_status",
  language: "language",
  version: "version",
  identifier: "identifier",
};

const CORE_FIELDS: ReadonlyMap<string, string> = new Map(
  Object.entries(CORE_FIELD_TABLE),
);

const readCore = (root: XmlElement): Record<string, string> => {
  const core: Record<string, string> = {};
  for (const entry of root.children) {
    const name = CORE_FIELDS.get(entry.local);
    const text = entry.text.trim();
    if (name !== undefined && text !== "") core[name] = truncate(text);
  }
  return core;
};

/** Leaf elements of docProps/app.xml as written (Application, AppVersion, Company, Pages, Words ...). */
const readApp = (root: XmlElement): Record<string, string> => {
  const app: Record<string, string> = {};
  for (const entry of root.children) {
    if (entry.children.length > 0) continue;
    const text = entry.text.trim();
    if (text !== "") app[entry.local] = truncate(text);
  }
  return app;
};

const readCustom = (
  root: XmlElement,
): { list: OfficePackage["properties"]["custom"]; total: number } => {
  const properties = childrenOf(
    root,
    "http://schemas.openxmlformats.org/officeDocument/2006/custom-properties",
    "property",
  );
  return {
    total: properties.length,
    list: properties.slice(0, MAX_CUSTOM_PROPERTIES).map((property) => {
      const value = property.children[0];
      return {
        name: truncate(attr(property, "name") ?? ""),
        type: value?.local ?? "unknown",
        value: truncate(value?.text ?? ""),
      };
    }),
  };
};

const hasContentType = (part: PackagePart, needle: string): boolean =>
  part.contentType?.toLowerCase().includes(needle) === true;

interface Classified {
  readonly kind: OfficeNotable["kind"];
  readonly note: string | null;
}

const classifyPart = (part: PackagePart): Classified | null => {
  const lowerPath = part.path.toLowerCase();
  if (lowerPath.endsWith(".rels")) return null;
  const type = (part.contentType ?? "").toLowerCase();
  if (type === "application/vnd.ms-office.vbaproject")
    return {
      kind: "macro-project",
      note: "A VBA project binary. Its presence is a declaration; the macro source is not extracted or run, and this is not a safety verdict.",
    };
  if (type === "application/vnd.ms-office.vbaprojectsignature")
    return {
      kind: "macro-signature",
      note: "Signature data for the VBA project; not verified.",
    };
  if (type.includes("vbadata")) return { kind: "macro-data", note: null };
  if (type.includes("macrosheet"))
    return {
      kind: "macro-sheet",
      note: "An Excel 4.0 (XLM) macro sheet; its formulas are text, not run.",
    };
  if (type.includes("activex"))
    return {
      kind: "activex",
      note: "An ActiveX control declaration or its data; not loaded.",
    };
  if (type.includes("digital-signature"))
    return {
      kind: "digital-signature",
      note: "Package signature data; not verified.",
    };
  if (hasContentType(part, "comments") || hasContentType(part, "persons"))
    return { kind: "comments", note: null };
  if (/^[^/]+\/embeddings\//u.test(lowerPath)) {
    return type === "application/vnd.openxmlformats-officedocument.oleobject"
      ? {
          kind: "ole-object",
          note: "An embedded OLE object; its contents are not read.",
        }
      : {
          kind: "embedded-package",
          note: "An embedded file; it is not opened by this tool.",
        };
  }
  if (type === "application/vnd.openxmlformats-officedocument.oleobject")
    return {
      kind: "ole-object",
      note: "An embedded OLE object; its contents are not read.",
    };
  if (lowerPath.startsWith("customxml/") && !lowerPath.includes("itemprops"))
    return { kind: "custom-xml", note: null };
  if (lowerPath.startsWith("docprops/thumbnail"))
    return { kind: "thumbnail", note: null };
  return null;
};

/** The part a relationships part describes: null for the package, undefined when the name is not in `_rels/`. */
const derivedSource = (relsPath: string): string | null | undefined => {
  if (/^_rels\/\.rels$/iu.test(relsPath)) return null;
  const match = /^(?:(.*)\/)?_rels\/([^/]+)\.rels$/iu.exec(relsPath);
  if (match === null) return undefined;
  return match[1] === undefined
    ? (match[2] ?? undefined)
    : `${match[1]}/${match[2] ?? ""}`;
};

export interface PackageSummary {
  readonly package: Omit<OfficePackage, "statistics">;
  readonly mainPart: string | null;
  readonly kind: Kind;
  readonly family: Family | null;
}

const rootProperties = async (
  pack: OpcPackage,
  rels: readonly Relationship[],
  kind: string,
  signal: AbortSignal | undefined,
): Promise<XmlElement | undefined> => {
  const relationship = byKind(rels, kind);
  if (relationship?.part == null) return undefined;
  const parsed = await pack.readXml(relationship.part, signal);
  if (!parsed.ok) {
    pack.problem(parsed.reason);
    return undefined;
  }
  return parsed.root;
};

export const summarizePackage = async (
  pack: OpcPackage,
  fileName: string,
  counters: ReaderCounters,
  signal: AbortSignal | undefined,
): Promise<PackageSummary> => {
  const rootRels = await pack.relationships(null, signal);
  const mainRel = byKind(rootRels, "officeDocument");
  const mainPart = mainRel?.part ?? null;
  const mainType = mainPart === null ? null : pack.contentTypeOf(mainPart);
  const main = classifyMain(mainType);
  const problems: string[] = [];
  if (mainRel === undefined)
    problems.push(
      "The package has no officeDocument relationship, so its main part is unknown.",
    );
  else if (mainPart === null)
    problems.push(
      `The officeDocument relationship points at ${mainRel.target}, which is not a part of the package.`,
    );
  else if (main.kind === "unknown")
    problems.push(
      `The main part ${mainPart} has content type ${mainType ?? "none"}, which is not a Word, Excel or PowerPoint document type.`,
    );

  const hinted = NAME_KIND.exec(fileName)?.[1]?.toLowerCase();
  const nameConflict =
    hinted !== undefined && main.kind !== "unknown" && hinted !== main.kind
      ? `The file name says .${hinted}; the main part's content type is ${main.kind}.`
      : null;

  const [coreRoot, appRoot, customRoot] = await Promise.all([
    rootProperties(pack, rootRels, "core-properties", signal),
    rootProperties(pack, rootRels, "extended-properties", signal),
    rootProperties(pack, rootRels, "custom-properties", signal),
  ]);
  const custom =
    customRoot === undefined ? { list: [], total: 0 } : readCustom(customRoot);

  const notable: OfficeNotable[] = [];
  let notableTotal = 0;
  let hashed = 0;
  let hasVba = false;
  for (const part of pack.parts) {
    const classified = classifyPart(part);
    if (classified === null) continue;
    notableTotal += 1;
    counters.add(`${classified.kind.replaceAll("-", "_")}_parts`);
    if (classified.kind === "macro-project") hasVba = true;
    if (notable.length >= MAX_NOTABLE) continue;
    let sha256: string | null = null;
    let note = classified.note;
    const hashable =
      classified.kind === "macro-project" ||
      classified.kind === "macro-signature" ||
      classified.kind === "ole-object" ||
      classified.kind === "embedded-package" ||
      classified.kind === "activex";
    if (hashable && hashed >= MAX_HASHED)
      note =
        `${note ?? ""} Not hashed: more than ${String(MAX_HASHED)} code-bearing parts.`.trim();
    if (hashable && hashed < MAX_HASHED && !part.encrypted) {
      hashed += 1;
      try {
        sha256 = await pack.sha256(part.path, signal);
      } catch (cause) {
        if (cause instanceof MemberReadFailure && cause.reason === "cancelled")
          throw cause;
        note =
          `${note ?? ""} Not hashed: ${cause instanceof Error ? cause.message : String(cause)}`.trim();
      }
    }
    notable.push({
      kind: classified.kind,
      part: part.path,
      content_type: part.contentType,
      bytes: part.bytes,
      sha256,
      note,
    });
  }
  if (hasVba && !main.macro && main.kind !== "unknown")
    problems.push(
      `The package declares a ${main.kind} but carries a VBA project; macros are not declared by its content type.`,
    );
  if (main.macro && !hasVba && main.kind !== "xlsb")
    problems.push(
      `The package declares a macro-enabled ${main.kind} but has no VBA project part.`,
    );
  if (pack.duplicates.length > 0)
    problems.push(
      `The ZIP repeats ${String(pack.duplicates.length)} member name${pack.duplicates.length === 1 ? "" : "s"} (first: ${pack.duplicates[0] ?? ""}); only the first of each is read.`,
    );

  const external: OfficeExternalReference[] = [];
  let externalTotal = 0;
  for (const part of pack.parts) {
    if (!part.path.toLowerCase().endsWith(".rels")) continue;
    const source = derivedSource(part.path);
    if (source === undefined) {
      problems.push(
        `${part.path} is named like a relationships part but is not under _rels/ as <part>.rels; it is not read.`,
      );
      continue;
    }
    if (source !== null && !pack.has(source)) {
      problems.push(`${part.path} describes ${source}, which is not a part.`);
      continue;
    }
    for (const relationship of await pack.relationships(source, signal)) {
      if (!relationship.external) continue;
      externalTotal += 1;
      if (external.length < MAX_EXTERNAL)
        external.push({
          source,
          kind: relationship.kind,
          target: truncate(relationship.target),
          id: relationship.id,
        });
    }
  }
  const conformance: OfficePackage["conformance"] =
    mainRel === undefined
      ? "unknown"
      : mainRel.type.startsWith("http://purl.oclc.org/ooxml/")
        ? "strict"
        : mainRel.type.startsWith("http://schemas.openxmlformats.org/")
          ? "transitional"
          : "unknown";

  return {
    package: {
      kind: main.kind,
      family: main.family,
      macro_enabled: main.macro,
      main_part: mainPart,
      main_content_type: mainType,
      name_conflict: nameConflict,
      conformance,
      part_count: pack.parts.length,
      decoded_bytes: 0,
      properties: {
        core: coreRoot === undefined ? {} : readCore(coreRoot),
        app: appRoot === undefined ? {} : readApp(appRoot),
        custom: custom.list,
        custom_total: custom.total,
      },
      notable,
      notable_total: notableTotal,
      external_references: external,
      external_total: externalTotal,
      problems,
    },
    mainPart,
    kind: main.kind,
    family: main.family,
  };
};
