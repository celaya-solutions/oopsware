import {
  androidManifestFactsSchema,
  MAX_MANIFEST_XML_CHARS,
  type AndroidArtifactReport,
} from "../../domain/android/androidArtifact.js";
import { readManifestFacts } from "../manifest.js";
import {
  readArscTable,
  readProtoTable,
  type ResourceTable,
} from "../resources/resourceTable.js";
import {
  AndroidXmlFormatError,
  type AndroidXmlDocument,
} from "../xml/androidXml.js";
import { decodeBinaryXml } from "../xml/binaryXml.js";
import { decodeProtoXml } from "../xml/protoXml.js";
import { renderAndroidXml } from "../xml/renderXml.js";

export type XmlEncoding = "binary-xml" | "proto-xml";

type Apk = NonNullable<AndroidArtifactReport["apk"]>;
export type ManifestView = NonNullable<Apk["manifest"]>;
export type ResourceTableView = NonNullable<Apk["resources"]>;

const message = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** Decode a resource table; a damaged table is reported with what was read, never guessed. */
export const readResourceTable = (
  container: string | null,
  entry: string,
  encoding: "arsc" | "proto",
  bytes: Uint8Array,
): { view: ResourceTableView; table: ResourceTable | null } => {
  try {
    const table =
      encoding === "arsc" ? readArscTable(bytes) : readProtoTable(bytes);
    return {
      table,
      view: {
        container,
        entry,
        encoding,
        string_count: table.summary.string_count,
        packages: table.summary.packages.map((entry) => ({
          id: entry.id,
          name: entry.name,
          types: entry.types.map((type) => ({
            ...type,
            configs: [...type.configs],
          })),
        })),
        error: null,
        problems: table.summary.problems.map((problem) => ({
          container,
          entry,
          offset: problem.offset,
          message: problem.message,
        })),
      },
    };
  } catch (cause) {
    const offset =
      cause instanceof Error &&
      "offset" in cause &&
      typeof cause.offset === "number"
        ? cause.offset
        : null;
    return {
      table: null,
      view: {
        container,
        entry,
        encoding,
        string_count: null,
        packages: [],
        error: message(cause),
        problems:
          offset === null
            ? []
            : [{ container, entry, offset, message: message(cause) }],
      },
    };
  }
};

/** Resolve through `primary` first, then `fallback` (a feature module refers to its base module's resources). */
export const layeredTable = (
  primary: ResourceTable | null,
  fallback: ResourceTable | null,
): ResourceTable | null =>
  primary === null || fallback === null || primary === fallback
    ? (primary ?? fallback)
    : {
        summary: primary.summary,
        resolve: (id) => primary.resolve(id) ?? fallback.resolve(id),
      };

/** `type/name` of a resource ID, for rendering references in XML. */
const nameResolver =
  (table: ResourceTable | null) =>
  (id: number): string | null => {
    const found = table?.resolve(id);
    return found === null || found === undefined
      ? null
      : `${found.type}/${found.name}`;
  };

/** Default-configuration text of a resource ID (the first value when there is no default). */
const textResolver =
  (table: ResourceTable | null) =>
  (id: number): string | null => {
    const found = table?.resolve(id);
    if (found === null || found === undefined) return null;
    const text =
      (found.values.find((value) => value.config === "") ?? found.values[0])
        ?.text ?? null;
    // String values print quoted, as aapt2 prints them; facts hold the string itself.
    return text !== null &&
      text.length >= 2 &&
      text.startsWith('"') &&
      text.endsWith('"')
      ? text.slice(1, -1)
      : text;
  };

/** Decode a manifest in the encoding its location implies, with facts and rendered XML. */
export const readManifest = (
  container: string | null,
  entry: string,
  encoding: XmlEncoding,
  bytes: Uint8Array,
  table: ResourceTable | null,
): ManifestView => {
  let document: AndroidXmlDocument;
  try {
    document =
      encoding === "binary-xml"
        ? decodeBinaryXml(bytes)
        : decodeProtoXml(bytes);
  } catch (cause) {
    return {
      container,
      entry,
      encoding,
      facts: null,
      xml: null,
      xml_truncated: false,
      error: `The manifest could not be decoded: ${message(cause)}`,
      problems:
        cause instanceof AndroidXmlFormatError
          ? [{ container, entry, offset: cause.offset, message: cause.message }]
          : [],
    };
  }
  const rendered = renderAndroidXml(document, nameResolver(table));
  return {
    container,
    entry,
    encoding,
    // The schema parse also checks the decoder's output against the report contract.
    facts: androidManifestFactsSchema.parse(
      readManifestFacts(document.root, textResolver(table)),
    ),
    xml: rendered.slice(0, MAX_MANIFEST_XML_CHARS),
    xml_truncated: rendered.length > MAX_MANIFEST_XML_CHARS,
    error: null,
    problems: document.problems.map((problem) => ({
      container,
      entry,
      offset: problem.offset,
      message: problem.message,
    })),
  };
};
