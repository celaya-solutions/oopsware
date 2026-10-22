import { STRUCTURED_TEXT_FORMATS } from "../document/structuredText.js";
import type { FormatId } from "../formatIdentifiers.js";
import type { JsonValue } from "../jsonValue.js";

type JsonObject = { readonly [key: string]: JsonValue };
type Arguments = (path: string, format: FormatId | null) => JsonObject;

/**
 * Which existing tool reads a format more deeply. Automatic routes are
 * in-process readers that need no installed engine; identification runs the
 * first automatic route of a piece in its cheapest mode for a headline. Every
 * route, automatic or not, is offered as a next step with what it needs.
 */
export interface ReaderRoute {
  readonly tool: string;
  readonly label: string;
  readonly formats: readonly FormatId[];
  readonly automatic: boolean;
  /** What must be installed or opened first; null when nothing is. */
  readonly requires: string | null;
  /** The tool reads the session's opened target, so the file is opened first. */
  readonly opensFirst: boolean;
  readonly why: string;
  /** Arguments for the cheapest run identification makes for a headline. */
  readonly summary: Arguments;
  /** Arguments for the full call a next step offers. */
  readonly step: Arguments;
}

const path: Arguments = (value) => ({ path: value });
const firstPage: Arguments = (value) => ({ path: value, limit: 1 });

const STRUCTURED_TEXT: readonly FormatId[] = STRUCTURED_TEXT_FORMATS;

/** The document reader needs its profile when the name has no known suffix. */
const documentArguments =
  (limit: number | null): Arguments =>
  (value, format) => ({
    path: value,
    ...(format !== null && STRUCTURED_TEXT.includes(format) ? { format } : {}),
    ...(limit === null ? {} : { limit }),
  });

interface RouteFields {
  readonly tool: string;
  readonly label: string;
  readonly formats: readonly FormatId[];
  readonly why: string;
}

/** An in-process reader identification may run for a headline. */
const automatic = (
  fields: RouteFields & {
    readonly summary?: Arguments;
    readonly step?: Arguments;
  },
): ReaderRoute => ({
  ...fields,
  automatic: true,
  requires: null,
  opensFirst: false,
  summary: fields.summary ?? path,
  step: fields.step ?? path,
});

/** A reader offered only as a next step, with what it needs. */
const offered = (
  fields: RouteFields & {
    readonly requires: string | null;
    readonly step?: Arguments;
    readonly opensFirst?: boolean;
  },
): ReaderRoute => ({
  ...fields,
  automatic: false,
  opensFirst: fields.opensFirst ?? false,
  summary: fields.step ?? path,
  step: fields.step ?? path,
});

const THIN_NATIVE: readonly FormatId[] = ["elf", "pe", "mach-o"];
const OPEN_FIRST = "Open the file first with open_binary (same path).";

/** Ordered: a piece's first automatic route is the one run for its headline. */
export const READER_ROUTES: readonly ReaderRoute[] = [
  automatic({
    tool: "inspect_linux_package",
    label: "Read the Linux package",
    formats: ["deb", "rpm", "appimage", "squashfs"],
    why: "Package identity, dependencies, maintainer scripts and every file, without installing or running anything.",
    summary: firstPage,
  }),
  automatic({
    tool: "inspect_container_image",
    label: "Read the container image",
    formats: ["oci-image-layout", "oci-image-archive", "docker-save-archive"],
    why: "Images, configuration, layers with digests checked, and the composed filesystem, without pulling or running anything.",
    summary: firstPage,
  }),
  automatic({
    tool: "inspect_windows_installer",
    label: "Read the Windows Installer package",
    formats: ["msi"],
    why: "Product facts, tables, cabinets, files and custom actions, without msiexec.",
    summary: firstPage,
  }),
  automatic({
    tool: "inspect_msix_package",
    label: "Read the MSIX or AppX package",
    formats: ["msix", "appx", "msixbundle", "appxbundle"],
    why: "Package identity, manifest, capabilities and block map, without installing it.",
  }),
  automatic({
    tool: "inspect_android_artifact",
    label: "Read the Android package",
    formats: ["apk", "android-app-bundle", "apks", "xapk", "dalvik-dex"],
    why: "Manifest facts, DEX classes, resources, splits and native libraries, without installing anything.",
    summary: firstPage,
  }),
  automatic({
    tool: "inspect_jvm_artifact",
    label: "Read the Java classes",
    formats: ["jar", "aar", "jvm-classfile"],
    why: "Manifest, modules, services and every class with its version, without loading anything.",
    summary: firstPage,
  }),
  automatic({
    tool: "inspect_python_artifact",
    label: "Read the Python package",
    formats: ["wheel", "pyz", "cpython-bytecode"],
    why: "Wheel metadata with RECORD digests rechecked, modules, bytecode versions and native extensions, without importing anything.",
    summary: firstPage,
  }),
  automatic({
    tool: "inspect_wasm_module",
    label: "Read the WebAssembly module",
    formats: ["wasm-module", "wasm-binary", "wasm-text"],
    why: "Imports, exports, functions, memories and validation, without instantiating it.",
    summary: firstPage,
  }),
  automatic({
    tool: "inspect_document",
    label: "Read the document",
    formats: STRUCTURED_TEXT,
    why: "Parsed structure with line and byte locations and every parse problem.",
    summary: documentArguments(1),
    step: documentArguments(null),
  }),
  automatic({
    tool: "inspect_pdf_document",
    label: "Read the PDF",
    formats: ["pdf"],
    why: "Cross-reference structure, encryption, metadata, attachments, actions and signatures, and which pages are scanned, without rendering or running anything.",
  }),
  automatic({
    tool: "inspect_office_document",
    label: "Read the Office document",
    formats: ["ooxml-document", "ooxml-macro-document", "ole-office-document"],
    why: "Word, Excel or PowerPoint kind from the bytes, properties, macros, embedded objects and external references, without opening it in an application.",
  }),
  automatic({
    tool: "inspect_managed_artifact",
    label: "Read the .NET metadata",
    formats: ["pe"],
    why: "Whether the PE carries .NET metadata, its assembly identity, target frameworks and architecture, without loading it.",
  }),
  automatic({
    tool: "inspect_go_binary",
    label: "Read the Go build facts",
    formats: THIN_NATIVE,
    why: "Image format and architecture, and for a Go build its Go version, main module and dependencies.",
  }),
  automatic({
    tool: "inspect_rust_binary",
    label: "Read the Rust build facts",
    formats: THIN_NATIVE,
    why: "The rustc commit and any cargo-auditable crate list embedded in the image.",
  }),
  automatic({
    tool: "inspect_pe_resources",
    label: "List the PE resources",
    formats: ["pe"],
    why: "The bounded resource tree: icons, manifests, version data and other resources by type, name and language.",
  }),
  automatic({
    tool: "inspect_desktop_application",
    label: "Check for an app or game folder",
    formats: ["directory"],
    why: "Whether the folder looks like a .NET, Unity, Unreal, Godot, GameMaker or Electron application, from bounded listings and headers.",
  }),
  offered({
    tool: "inspect_macho",
    label: "Read the Mach-O load commands",
    formats: ["mach-o", "mach-o-universal"],
    requires: `${OPEN_FIRST} Runs Apple's command-line tools on macOS.`,
    why: "Slices, load commands, imports, exports, dependencies, build versions, segments and code signing.",
    step: () => ({}),
    opensFirst: true,
  }),
  offered({
    tool: "inspect_python_artifact",
    label: "Parse the Python source",
    formats: ["python-source"],
    requires:
      "An installed CPython; its ast module parses the source in an isolated child process.",
    why: "Imports, definitions and dynamic code sites from the source, without importing it.",
  }),
  offered({
    tool: "inspect_binary_layout",
    label: "Read the ELF layout with pwntools",
    formats: ["elf"],
    requires: "A Linux x64 host with pwntools (REA_PWNTOOLS_PYTHON).",
    why: "Sections, segments, linkage and protections from the file.",
  }),
  offered({
    tool: "inspect_android_package",
    label: "Decompile with JADX",
    formats: ["apk"],
    requires: "An installed JADX and Java.",
    why: "Decompiled classes and methods with smali fallback.",
  }),
  offered({
    tool: "analyze_javascript_application",
    label: "Rebuild the JavaScript application",
    formats: ["asar", "javascript"],
    requires: null,
    why: "Modules, entry points, IPC and network surfaces from the shipped JavaScript, without running it.",
    step: (value) => ({ input_path: value }),
  }),
  offered({
    tool: "inspect_sqlite_database",
    label: "Read the SQLite database",
    formats: ["sqlite"],
    requires: null,
    why: "Tables, indexes, views and triggers from a read-only snapshot.",
  }),
  offered({
    tool: "open_binary",
    label: "Open in a native engine",
    formats: [...THIN_NATIVE, "mach-o-universal", "dos-mz"],
    requires:
      "A configured Hopper, Ghidra or IDA engine for functions and decompilation.",
    why: "Functions, strings, cross-references and pseudo-code.",
  }),
];

/** Routes for a piece: its best format first, then its other candidates. */
export const readerRoutesFor = (
  format: FormatId | null,
  candidates: readonly FormatId[],
): readonly ReaderRoute[] => {
  const order = format === null ? candidates : [format, ...candidates];
  const found: ReaderRoute[] = [];
  for (const id of order)
    for (const candidate of READER_ROUTES)
      if (candidate.formats.includes(id) && !found.includes(candidate))
        found.push(candidate);
  return found;
};

/** The reader identification runs for a headline, when there is one. */
export const automaticRouteFor = (
  format: FormatId | null,
  candidates: readonly FormatId[],
): ReaderRoute | undefined =>
  readerRoutesFor(format, candidates).find((candidate) => candidate.automatic);
