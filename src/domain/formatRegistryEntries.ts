import {
  dimensionOf,
  formatFacetSchema,
  formatFamilySchema,
  type CapabilityDeclaration,
  type FormatEntry,
  type SurfaceCapabilities,
} from "./formatIdentifiers.js";
import {
  PLANNED_FORMATS,
  type FormatFields,
  type PlannedFamily,
} from "./formatExpansionScope.js";
import {
  ZIP_NON_ENTRY_LIMITATION,
  type ZipPackageFormat,
} from "./zipPackageFormat.js";

/**
 * Registry data. Existing formats declare what the current artifact
 * pipeline does; planned formats declare every facet unsupported until
 * their milestone's acceptance checks pass.
 */

const declare = (
  state: CapabilityDeclaration["state"],
  reason: string | null = null,
  hostPlatform: NodeJS.Platform | null = null,
): CapabilityDeclaration => ({ state, reason, hostPlatform });

const SPEC_MILESTONE: Readonly<Record<PlannedFamily, string>> = {
  F01: "P2",
  F02: "P2",
  F03: "P2",
  F04: "P3",
  F05: "P3",
  F06: "P1",
  F07: "P4",
  F08: "P3",
  F09: "P4",
  F10: "P4",
  F11: "P1",
  F12: "P5",
};

const both = (
  capabilities: SurfaceCapabilities,
): FormatEntry["capabilities"] => ({
  local: capabilities,
  hosted: capabilities,
});

const HOSTED_SINGLE_FILE =
  "The hosted service accepts single uploaded files only.";
const ROLE_FROM_SUFFIX =
  "The package role is taken from the path suffix after the ZIP signature is verified; package metadata is not checked.";

const existing = (
  fields: FormatFields,
  capabilities: FormatEntry["capabilities"],
): FormatEntry => ({
  id: fields.id,
  dimension: dimensionOf(fields.id),
  family: "existing",
  label: fields.label,
  extensions: fields.extensions ?? [],
  storage: fields.storage ?? [],
  byteSignature: fields.byteSignature ?? false,
  capabilities,
});

/** A format the pipeline identifies but does not traverse. */
const identified = (
  fields: FormatFields,
  hosted: CapabilityDeclaration = declare("complete"),
): FormatEntry =>
  existing(fields, {
    local: { identify: declare("complete") },
    hosted: { identify: hosted },
  });

const zipPackage = (
  id: ZipPackageFormat,
  label: string,
  extension: string,
): FormatEntry =>
  existing(
    {
      id,
      label,
      extensions: [extension],
      storage: id === "zip" ? [] : ["zip"],
      byteSignature: id === "zip",
    },
    both({
      identify:
        id === "zip"
          ? declare("complete")
          : declare("partial", ROLE_FROM_SUFFIX),
      inventory: declare("partial", ZIP_NON_ENTRY_LIMITATION),
      extract: declare("complete"),
    }),
  );

const ARCHIVE_NO_INSPECTION =
  "Archives have no format-specific inspection beyond member inventory.";
const ARCHIVE_EXTRACTION =
  "Regular files are materialized with containment and digest checks; links are recorded, not created; an archive with omitted members is refused.";
const ARCHIVE_MEMBERS =
  "Sparse files, device and FIFO members, and names that are not UTF-8 are reported but not listed; duplicate member names are kept as distinct occurrences, and extraction refuses the colliding path.";
const HOSTED_NO_EXTERNAL_DECODER =
  "The hosted service does not run external decoders until its worker isolation boundary is verified.";

/** Shared archive facets; `inventory` names the profile-specific limits. */
const archiveFacets = (inventory: string): SurfaceCapabilities => ({
  identify: declare("complete"),
  inventory: declare("partial", inventory),
  extract: declare("partial", ARCHIVE_EXTRACTION),
  inspect: declare("unsupported", ARCHIVE_NO_INSPECTION),
  reconstruct: declare("unsupported", ARCHIVE_NO_INSPECTION),
});

/** A local-only archive whose decoder is an installed external program. */
const externallyDecoded = (inventory: string): FormatEntry["capabilities"] => ({
  local: archiveFacets(inventory),
  hosted: {
    ...archiveFacets(inventory),
    inventory: declare("unavailable", HOSTED_NO_EXTERNAL_DECODER),
    extract: declare("unavailable", HOSTED_NO_EXTERNAL_DECODER),
  },
});

const WASM_NO_MEMBERS =
  "A WebAssembly binary holds sections, not member files; inspection lists every section with its byte range.";
const WASM_COMPONENT_NO_SOURCE =
  "Component-model binaries are not translated; convert_wasm_to_c reads core modules only.";
const WASM_TO_C =
  "convert_wasm_to_c translates a core module to C with a digest-pinned wabt wasm2c 1.0.42 the owner installs (bring-your-own); it is unavailable without one. The C is a mechanical translation derived from the module, not readable source. Each result is checked: wasm2c's messages, clang -fsyntax-only against wabt's wasm-rt.h, and the header's exported functions against the module's.";
const WASM_HOSTED_NO_SOURCE = "The hosted service does not run wasm2c.";
const WASM_INSTRUCTIONS =
  "Every section is decoded; instructions are decoded for WebAssembly 2.0 without SIMD, plus tail calls. A body using SIMD, exception handling, GC, threads, typed function references or multi-memory stops at its first such instruction and says so; DWARF custom sections are listed, not read.";
const WASM_HOSTED_BUDGET =
  "The hosted reader decodes uploaded originals up to 32 MiB in a separate process with a 384 MiB memory budget and keeps the first 20,000 functions browsable.";

/** F01 facets shared by the binary storage, module and component entries. */
const wasmFacets = (
  inspect: CapabilityDeclaration,
  hosted: CapabilityDeclaration = inspect,
  reconstruct: CapabilityDeclaration = declare("partial", WASM_TO_C),
): FormatEntry["capabilities"] => {
  const shared = {
    identify: declare("complete"),
    inventory: declare("unsupported", WASM_NO_MEMBERS),
    extract: declare("unsupported", WASM_NO_MEMBERS),
  };
  return {
    local: { ...shared, inspect, reconstruct },
    hosted: {
      ...shared,
      inspect: hosted,
      reconstruct: declare("unsupported", WASM_HOSTED_NO_SOURCE),
    },
  };
};

const JVM_RECONSTRUCTION =
  "decompile_jvm_class reconstructs inferred Java source with a digest-pinned Vineflower 1.12.0 the owner installs (bring-your-own); it is unavailable without one. Methods whose bytecode does not decode, and invokedynamic calls it leaves unresolved (Java 21 pattern switches), are flagged rather than trusted.";
const JVM_HOSTED_NO_SOURCE = "The hosted service does not run a decompiler.";
const JVM_CLASS_INSPECTION =
  "The constant pool, fields, methods, annotations, records, modules, nest and bootstrap attributes and every instruction are decoded; StackMapTable, type annotations and SourceDebugExtension are located by byte range but not decoded. Nothing is loaded into a JVM.";
const JVM_ARCHIVE_INSPECTION =
  "Manifest, services, module descriptors, signature files (not verified), per-entry digests, multi-release variants and every class are read; JARs inside embedded JARs are not opened.";
const JVM_ARCHIVE_EXTRACTION =
  "The archive is extracted as a ZIP by extract_artifact; embedded JARs are extracted as files.";
const JVM_HOSTED_PENDING =
  "The hosted service does not decode JVM classes yet; uploads keep the ZIP member list and byte preview.";

/** F02 facets: local inspection and reconstruction are admitted; the hosted service keeps its ZIP and byte views. */
const jvmFacets = (
  inventory: CapabilityDeclaration,
  extract: CapabilityDeclaration,
  inspect: CapabilityDeclaration,
): FormatEntry["capabilities"] => {
  const shared = {
    identify: declare("complete"),
    inventory,
    extract,
  };
  return {
    local: {
      ...shared,
      inspect,
      reconstruct: declare("partial", JVM_RECONSTRUCTION),
    },
    hosted: {
      ...shared,
      inspect: declare("unsupported", JVM_HOSTED_PENDING),
      reconstruct: declare("unsupported", JVM_HOSTED_NO_SOURCE),
    },
  };
};

const PYTHON_RECONSTRUCTION =
  "decompile_python_code reconstructs inferred source for a .pyc of Python 2.7 or 3.5-3.13 with a digest-pinned pycdc the owner installs (bring-your-own); it is unavailable without one. Each result is checked: pycdc's warnings, whether a same-release CPython compiles it, and whether its code objects match the original's by name.";
const PYTHON_SOURCE_NO_RECONSTRUCTION =
  "Source is already source; there is nothing to reconstruct.";
const PYTHON_HOSTED_NO_SOURCE = "The hosted service does not run a decompiler.";
const PYTHON_HOSTED_PENDING =
  "The hosted service does not read Python artifacts yet; uploads keep the ZIP member list and byte preview.";
const PYTHON_NO_MEMBERS = "A module file holds code, not member files.";
const PYTHON_NAME_ONLY =
  "There is no byte signature for this in format detection: it is chosen by its name, and the Python tools confirm it from the bytes.";
const PYTHON_BYTECODE_INSPECTION =
  "Code objects, instructions, line and exception tables are decoded in process only for the exact magic numbers of CPython 3.9, 3.11, 3.12, 3.13, 3.14 and 3.15, each checked against that release's dis; other releases keep the header.";
const PYTHON_SOURCE_INSPECTION =
  "An installed CPython's ast module parses the file in an isolated process: imports, definitions, decorators, calls by written name and dynamic imports or reflection as unknowns. Run-time name resolution is not attempted.";
const PYTHON_ARCHIVE_INSPECTION =
  "Wheel metadata, entry points, RECORD digests, licenses, native extension headers and module headers are read; nothing is installed.";

/** F03 facets: local reading and .pyc reconstruction are admitted; the hosted service keeps its ZIP and byte views. */
const pythonFacets = (
  identify: CapabilityDeclaration,
  inventory: CapabilityDeclaration,
  extract: CapabilityDeclaration,
  inspect: CapabilityDeclaration,
  hostedInventory: CapabilityDeclaration = inventory,
  reconstruct: CapabilityDeclaration = declare(
    "partial",
    PYTHON_RECONSTRUCTION,
  ),
): FormatEntry["capabilities"] => ({
  local: { identify, inventory, extract, inspect, reconstruct },
  hosted: {
    identify,
    inventory: hostedInventory,
    extract,
    inspect: declare("unsupported", PYTHON_HOSTED_PENDING),
    reconstruct: declare("unsupported", PYTHON_HOSTED_NO_SOURCE),
  },
});

const ANDROID_HOSTED_PENDING =
  "The hosted service does not read Android packages yet; uploads keep the ZIP member list and byte preview.";
const ANDROID_RECONSTRUCTION =
  "decompile_dex_class reconstructs inferred Java source for one class without JADX: a digest-pinned dex2jar 2.4 converts the DEX file that defines it, and the digest-pinned Vineflower 1.12.0 decompiles it; both are bring-your-own and the tool is unavailable without them. Each result is checked against dex2jar's error report, Vineflower's own notes and the DEX method list.";
const ANDROID_HOSTED_NO_SOURCE =
  "The hosted service does not run a decompiler.";
const ANDROID_NO_MEMBERS = "A DEX file holds structures, not member files.";
const DEX_INSPECTION =
  "The header (Adler-32 checksum and SHA-1 signature recomputed), map list, index tables, class data, annotations, encoded values, code items, try blocks and debug info are decoded, and every instruction renders as dexdump (build-tools 37.0.0) renders it, checked for DEX 035 to 039. DEX 040 and 041 are read by their published layout; no producer here writes them.";
const ANDROID_PACKAGE_INSPECTION =
  "Manifests (binary and proto XML), resource tables, signature material (recorded, never verified), DEX files and native libraries are read; nothing is installed or run.";
const ANDROID_EXTRACTION =
  "The package is extracted as a ZIP by extract_artifact; nested APKs and native libraries are extracted as files.";
const ANDROID_ROLE_FROM_NAME =
  "The hosted service sees a ZIP; the package role is taken from the name suffix.";

/** F04 facets: local reading and class reconstruction are admitted; the hosted service keeps its ZIP and byte views. */
const androidFacets = (
  identify: CapabilityDeclaration,
  inventory: CapabilityDeclaration,
  extract: CapabilityDeclaration,
  inspect: CapabilityDeclaration,
  hostedIdentify: CapabilityDeclaration = identify,
): FormatEntry["capabilities"] => {
  return {
    local: {
      identify,
      inventory,
      extract,
      inspect,
      reconstruct: declare("partial", ANDROID_RECONSTRUCTION),
    },
    hosted: {
      identify: hostedIdentify,
      inventory,
      extract,
      inspect: declare("unsupported", ANDROID_HOSTED_PENDING),
      reconstruct: declare("unsupported", ANDROID_HOSTED_NO_SOURCE),
    },
  };
};

const LINUX_NO_SOURCE =
  "Packages hold files and declarations, not code to reconstruct; native members go to the native tools after extraction.";
const LINUX_PACKAGE_INSPECTION =
  "inspect_linux_package reads identity, every dependency declaration, maintainer scripts or scriptlets as text (never run), triggers, conffiles, declared digests rechecked against the bytes, and signature material (recorded, never verified).";
const LINUX_MEMBERS =
  "Device, FIFO and socket members, hard-link placeholders without bytes and names that are not UTF-8 are reported but not listed; declared setuid/setgid bits are stated, never restored.";
const LINUX_HOSTED_NO_XZ =
  "The hosted service decodes gzip, zstd and uncompressed payloads in process; xz and lzma need the external decoder it does not run.";
const IMAGE_COMPRESSION =
  "SquashFS 4.0 images compressed with gzip, zstd or lz4 are read in process; xz, lzma and lzo images are identified only.";
const IMAGE_HOSTED_PENDING =
  "The hosted service lists a filesystem image's members but does not extract them or read package metadata yet.";

/** F05 facets for .deb and .rpm, whose contents stream through the archive reader. */
const linuxPackageFacets = (
  inventory: string,
  inspect: string,
): FormatEntry["capabilities"] => {
  const shared = {
    identify: declare("complete"),
    reconstruct: declare("unsupported", LINUX_NO_SOURCE),
  };
  return {
    local: {
      ...shared,
      inventory: declare("partial", `${inventory} ${LINUX_MEMBERS}`),
      extract: declare("partial", `${inventory} ${LINUX_MEMBERS}`),
      inspect: declare("partial", `${inspect} ${LINUX_PACKAGE_INSPECTION}`),
    },
    hosted: {
      ...shared,
      inventory: declare("partial", `${inventory} ${LINUX_HOSTED_NO_XZ}`),
      extract: declare("partial", `${inventory} ${LINUX_HOSTED_NO_XZ}`),
      inspect: declare(
        "unsupported",
        "The hosted service does not read package metadata yet.",
      ),
    },
  };
};

/** F05 facets for SquashFS images and the AppImages that carry them; local only. */
const imageFacets = (
  identify: CapabilityDeclaration,
  inspect: string,
): FormatEntry["capabilities"] => {
  const reconstruct = declare("unsupported", LINUX_NO_SOURCE);
  return {
    local: {
      identify,
      inventory: declare("partial", `${IMAGE_COMPRESSION} ${LINUX_MEMBERS}`),
      extract: declare("partial", `${IMAGE_COMPRESSION} ${LINUX_MEMBERS}`),
      inspect: declare("partial", `${inspect} ${IMAGE_COMPRESSION}`),
      reconstruct,
    },
    hosted: {
      identify,
      inventory: declare("partial", `${IMAGE_COMPRESSION} ${LINUX_MEMBERS}`),
      extract: declare("unsupported", IMAGE_HOSTED_PENDING),
      inspect: declare("unsupported", IMAGE_HOSTED_PENDING),
      reconstruct,
    },
  };
};

const WINDOWS_NO_SOURCE =
  "Installers hold files and declarations, not code to reconstruct; native members go to the native tools after extraction.";
const MSI_INVENTORY =
  "Files are laid out at their resolved target directories from embedded cabinets (stored or MSZIP; LZX and Quantum are listed, not decoded); Binary table streams are listed too. External cabinets are not searched for, and files stored beside the package are reported, not listed.";
const MSI_INSPECTION =
  "inspect_windows_installer reads the compound file, string pool and every table, summary information, product, features, components, directories, files with MsiFileHash rechecked, registry, services, shortcuts, environment, INI changes, custom actions decoded by type and the sequences that schedule them, launch conditions and upgrades. Conditions stay as written; nothing is evaluated, installed or run, and signatures are recorded, never verified. External cabinets are read only when supplied as companions.";
const MSI_HOSTED =
  "The hosted service lists and extracts an installer's files in process but does not read its tables yet.";
const BUNDLE_INSPECTION =
  "inspect_msix_package reads the bundle manifest (application and resource packages, architectures, offsets), each package's AppxManifest (identity, dependencies, applications, extensions and capabilities as declarations), block maps verified block by block, and signature parts (recorded, never verified). No MSIX packaging tool exists on this host: fixtures are hand-assembled from the published schemas.";

const IMAGE_NO_SOURCE =
  "Container images hold files and declarations, not code to reconstruct; native members go to the native tools after extraction.";
const IMAGE_INVENTORY =
  "The composed filesystem of a single-image archive or layout is listed and extracted (whiteouts, opaque directories and replacements applied in layer order); a multi-platform image, or one with a missing, foreign or mismatching layer, needs inspect_container_image and is not extracted. Devices, FIFOs and sockets are reported, not listed.";
const IMAGE_INSPECTION =
  "inspect_container_image reads every image the index lists, the configuration as declarations, each layer's digests recomputed and its diff id checked, and one layer's own entries with its whiteouts. Nothing is pulled, started or run; foreign layers are named, never fetched.";
const CONTAINER_IMAGE_HOSTED_PENDING =
  "The hosted service does not open container images; uploads keep the byte preview.";

/** F09 facets for container images; local only. */
const containerImageFacets = (
  identify: CapabilityDeclaration,
): FormatEntry["capabilities"] => {
  const reconstruct = declare("unsupported", IMAGE_NO_SOURCE);
  return {
    local: {
      identify,
      inventory: declare("partial", IMAGE_INVENTORY),
      extract: declare("partial", IMAGE_INVENTORY),
      inspect: declare("partial", IMAGE_INSPECTION),
      reconstruct,
    },
    hosted: {
      identify,
      inventory: declare("unsupported", CONTAINER_IMAGE_HOSTED_PENDING),
      extract: declare("unsupported", CONTAINER_IMAGE_HOSTED_PENDING),
      inspect: declare("unsupported", CONTAINER_IMAGE_HOSTED_PENDING),
      reconstruct,
    },
  };
};

const DWARF_IDENTIFY =
  "DWARF is a profile of ELF and Mach-O files, not a container of its own: detection names the container and inspect_debug_symbols reports whether DWARF sections are present and readable.";
const DWARF_NO_MEMBERS =
  "Debug symbols hold records, not member files; a .dSYM bundle is a directory the debug symbols tool opens by path.";
const DWARF_INSPECTION =
  "inspect_debug_symbols reads ELF files and Mach-O files (thin or universal) and .dSYM bundles: identifiers (Mach-O UUID, GNU build id, debug link CRC-32), then DWARF 2 to 5 compilation units, functions with address ranges and declaration sites, and line tables, with compressed sections decoded. A debug file is paired with an explicit binary by identifier only. Object files, split DWARF and supplementary files are named, not read; types, variables and location expressions are counted, not described.";
const DWARF_HOSTED_PENDING =
  "The hosted service does not read debug symbols; uploads keep the byte preview.";
const DWARF_NO_SOURCE =
  "Symbols name and locate things in a binary; they do not restore the original program.";

/** F10 part 1 facets: DWARF in ELF and Mach-O, local only. */
const dwarfFacets = (): FormatEntry["capabilities"] => {
  const reconstruct = declare("unsupported", DWARF_NO_SOURCE);
  return {
    local: {
      identify: declare("unsupported", DWARF_IDENTIFY),
      inventory: declare("unsupported", DWARF_NO_MEMBERS),
      extract: declare("unsupported", DWARF_NO_MEMBERS),
      inspect: declare("partial", DWARF_INSPECTION),
      reconstruct,
    },
    hosted: {
      identify: declare("unsupported", DWARF_IDENTIFY),
      inventory: declare("unsupported", DWARF_NO_MEMBERS),
      extract: declare("unsupported", DWARF_NO_MEMBERS),
      inspect: declare("unsupported", DWARF_HOSTED_PENDING),
      reconstruct,
    },
  };
};

const OOXML_IDENTIFY =
  "Office Open XML files are ZIP packages: detection names the ZIP and the file name; inspect_office_document decides the kind from the main part's content type and reports a name that disagrees.";
const OOXML_MEMBERS =
  "inspect_artifact lists an Office file as a plain ZIP; the parts view of inspect_office_document lists each part with its declared content type.";
const OOXML_INSPECTION =
  "inspect_office_document reads Word, Excel and PowerPoint documents, templates and add-ins in process: properties, a macro, OLE, ActiveX and signature inventory (listed and hashed, never run), external relationships (never followed), then paragraphs and tables, worksheet rows with formulas kept apart from cached values, or slides with notes, and the same content as Markdown. Password-protected files and .xlsb workbooks are refused or named, not read; pictures, charts, text boxes and equation structure are counted, not described.";
const OOXML_HOSTED_PENDING =
  "The hosted service does not read Office documents; uploads keep the byte preview.";
const OOXML_NO_SOURCE =
  "A document is read, not reconstructed from another form.";

const PDF_IDENTIFY =
  "A %PDF- header within the first 1,024 bytes names a PDF; inspect_pdf_document reads the structure behind it and reports a header that disagrees with the rest of the file.";
const PDF_NO_MEMBERS =
  "inspect_pdf_document lists a PDF's embedded files with their hashes but does not extract them; a PDF is not opened as an archive.";
const PDF_INSPECTION =
  "inspect_pdf_document reads a PDF in process: header, cross-reference chain (rebuilt by scanning when its offsets are wrong), encryption facts, Info and XMP metadata, embedded files, JavaScript, launch, URI and form-submission actions as written, signatures with their byte-range reach, per-page kinds (text, image-only, hidden-text layer) and every indirect object. Page text and word boxes come from an admitted Poppler pdftotext run on a private copy, in its own layout order. Encrypted files are described and refused for content; nothing is rendered, decrypted, verified, run or fetched, and OCR is not run.";
const PDF_HOSTED_PENDING =
  "The hosted service does not read PDFs; uploads keep the byte preview.";
const PDF_NO_SOURCE =
  "A document is read, not reconstructed from another form.";

/** F12 part 2 facets: PDF, local only. */
const pdfFacets = (): FormatEntry["capabilities"] => {
  const reconstruct = declare("unsupported", PDF_NO_SOURCE);
  return {
    local: {
      identify: declare("complete", PDF_IDENTIFY),
      inventory: declare("unsupported", PDF_NO_MEMBERS),
      extract: declare("unsupported", PDF_NO_MEMBERS),
      inspect: declare("partial", PDF_INSPECTION),
      reconstruct,
    },
    hosted: {
      identify: declare("complete", PDF_IDENTIFY),
      inventory: declare("unsupported", PDF_NO_MEMBERS),
      extract: declare("unsupported", PDF_NO_MEMBERS),
      inspect: declare("unsupported", PDF_HOSTED_PENDING),
      reconstruct,
    },
  };
};

/** F12 part 1 facets: Office Open XML, local only. */
const ooxmlFacets = (): FormatEntry["capabilities"] => {
  const reconstruct = declare("unsupported", OOXML_NO_SOURCE);
  return {
    local: {
      identify: declare("unsupported", OOXML_IDENTIFY),
      inventory: declare("unsupported", OOXML_MEMBERS),
      extract: declare("unsupported", OOXML_MEMBERS),
      inspect: declare("partial", OOXML_INSPECTION),
      reconstruct,
    },
    hosted: {
      identify: declare("unsupported", OOXML_IDENTIFY),
      inventory: declare("unsupported", OOXML_MEMBERS),
      extract: declare("unsupported", OOXML_MEMBERS),
      inspect: declare("unsupported", OOXML_HOSTED_PENDING),
      reconstruct,
    },
  };
};

const LEGACY_IDENTIFY =
  "An OLE compound file signature names the container; inspect_office_document decides Word, Excel or PowerPoint from the WordDocument, Workbook or PowerPoint Document stream and reports a file name that disagrees.";
const LEGACY_MEMBERS =
  "inspect_office_document's parts view lists a legacy file's storages and streams; the compound file is not opened as an archive.";
const LEGACY_INSPECTION =
  "inspect_office_document reads Word, Excel and PowerPoint 97-2003 files in process: SummaryInformation and DocumentSummaryInformation properties, a VBA project, Excel 4.0 macro sheet, embedded OLE object and signature inventory (listed and hashed, never run), external references (never followed), then paragraphs, tables, comments, footnotes and headers, worksheet rows with formulas kept apart from cached values, or slides with notes, and the same content as Markdown. Password-protected files and Word 6/95 and Excel 5/95 files are refused or named, not read; pictures, drawings, charts and text boxes are counted, not described.";

/** F12 part 3 facets: legacy Word, Excel and PowerPoint, local only. */
const legacyOfficeFacets = (): FormatEntry["capabilities"] => {
  const reconstruct = declare("unsupported", OOXML_NO_SOURCE);
  return {
    local: {
      identify: declare("unsupported", LEGACY_IDENTIFY),
      inventory: declare("unsupported", LEGACY_MEMBERS),
      extract: declare("unsupported", LEGACY_MEMBERS),
      inspect: declare("partial", LEGACY_INSPECTION),
      reconstruct,
    },
    hosted: {
      identify: declare("unsupported", LEGACY_IDENTIFY),
      inventory: declare("unsupported", LEGACY_MEMBERS),
      extract: declare("unsupported", LEGACY_MEMBERS),
      inspect: declare("unsupported", OOXML_HOSTED_PENDING),
      reconstruct,
    },
  };
};

/**
 * Planned formats whose milestone acceptance checks pass. Facets absent here
 * stay unsupported with their milestone reason.
 */
const ADMITTED: Partial<
  Record<FormatFields["id"], FormatEntry["capabilities"]>
> = {
  tar: both({
    ...archiveFacets(ARCHIVE_MEMBERS),
    identify: declare(
      "partial",
      "POSIX ustar, pax, and GNU headers are identified by magic and checksum; pre-POSIX v7 headers carry no magic and stay unrecognized.",
    ),
  }),
  gzip: both(
    archiveFacets(
      `Gzip is decoded in process; a decoded tar archive is listed, any other payload is one file. Concatenated members are joined; bytes after the last member are refused as malformed. ${ARCHIVE_MEMBERS}`,
    ),
  ),
  xz: externallyDecoded(
    `XZ is decoded by the installed xz program; without it members are reported as not read. A decoded tar archive is listed, any other payload is one file. ${ARCHIVE_MEMBERS}`,
  ),
  "7z": externallyDecoded(
    `Plain 7z archives are converted to a pax stream by the installed libarchive bsdtar. Encrypted headers are reported without listing; encrypted member data and codecs libarchive lacks are refused; no password is attempted. ${ARCHIVE_MEMBERS}`,
  ),
  "wasm-binary": wasmFacets(
    declare(
      "complete",
      "The preamble's version and layer decide between a core module and a component.",
    ),
  ),
  "wasm-module": wasmFacets(
    declare("partial", WASM_INSTRUCTIONS),
    declare("partial", `${WASM_INSTRUCTIONS} ${WASM_HOSTED_BUDGET}`),
  ),
  "wasm-component": wasmFacets(
    declare(
      "unsupported",
      "Component-model binaries are identified but not decoded.",
    ),
    undefined,
    declare("unsupported", WASM_COMPONENT_NO_SOURCE),
  ),
  "wasm-text": {
    local: {
      ...wasmFacets(declare("unsupported")).local,
      identify: declare(
        "partial",
        "WebAssembly text has no byte signature: it is chosen by the .wat suffix or an explicit format, and a successful assembly confirms it.",
      ),
      inspect: declare(
        "partial",
        `WAT is assembled by wabt.js into a separate derived module; facts carry offsets in that module, not text lines. ${WASM_INSTRUCTIONS}`,
      ),
    },
    hosted: {
      ...wasmFacets(declare("unsupported")).hosted,
      identify: declare(
        "unsupported",
        "The hosted service decodes binary modules only; WebAssembly text keeps the structured-text and byte previews.",
      ),
      inspect: declare(
        "unsupported",
        "The hosted service decodes binary modules only; WebAssembly text keeps the structured-text and byte previews.",
      ),
    },
  },
  "jvm-classfile": jvmFacets(
    declare("unsupported", "A class file holds structures, not member files."),
    declare("unsupported", "A class file holds structures, not member files."),
    declare("partial", JVM_CLASS_INSPECTION),
  ),
  jar: jvmFacets(
    declare("complete"),
    declare("complete", JVM_ARCHIVE_EXTRACTION),
    declare("partial", `${JVM_ARCHIVE_INSPECTION} ${JVM_CLASS_INSPECTION}`),
  ),
  aar: jvmFacets(
    declare("complete"),
    declare("complete", JVM_ARCHIVE_EXTRACTION),
    declare(
      "partial",
      `The text AndroidManifest.xml (package and SDK levels), classes.jar and libs/*.jar, JNI libraries per ABI and resource counts are read; compiled binary XML is not decoded. ${JVM_CLASS_INSPECTION}`,
    ),
  ),
  "python-source": pythonFacets(
    declare("partial", PYTHON_NAME_ONLY),
    declare("unsupported", PYTHON_NO_MEMBERS),
    declare("unsupported", PYTHON_NO_MEMBERS),
    declare("partial", PYTHON_SOURCE_INSPECTION),
    declare("unsupported", PYTHON_NO_MEMBERS),
    declare("unsupported", PYTHON_SOURCE_NO_RECONSTRUCTION),
  ),
  "cpython-bytecode": pythonFacets(
    declare("partial", PYTHON_NAME_ONLY),
    declare("unsupported", PYTHON_NO_MEMBERS),
    declare("unsupported", PYTHON_NO_MEMBERS),
    declare("partial", PYTHON_BYTECODE_INSPECTION),
  ),
  wheel: pythonFacets(
    declare("complete"),
    declare("complete"),
    declare(
      "complete",
      "The wheel is extracted as a ZIP by extract_artifact; nothing is installed.",
    ),
    declare(
      "partial",
      `${PYTHON_ARCHIVE_INSPECTION} ${PYTHON_BYTECODE_INSPECTION}`,
    ),
  ),
  pyz: pythonFacets(
    declare("complete"),
    declare(
      "complete",
      "inspect_python_artifact lists the members, including after a #! line.",
    ),
    declare(
      "unsupported",
      "extract_artifact does not open ZIP data that follows a #! line.",
    ),
    declare(
      "partial",
      `The shebang and __main__.py are declared, not run. ${PYTHON_BYTECODE_INSPECTION}`,
    ),
    declare(
      "unsupported",
      "The hosted service does not open ZIP data that follows a #! line.",
    ),
  ),
  "dalvik-dex": androidFacets(
    declare("complete", "The DEX magic, version and endian tag are checked."),
    declare("unsupported", ANDROID_NO_MEMBERS),
    declare("unsupported", ANDROID_NO_MEMBERS),
    declare("partial", DEX_INSPECTION),
  ),
  "android-app-bundle": androidFacets(
    declare(
      "complete",
      "BundleConfig.pb or a module's manifest/AndroidManifest.xml establishes a bundle.",
    ),
    declare("complete"),
    declare("complete", ANDROID_EXTRACTION),
    declare(
      "partial",
      `Each module's proto manifest (with dist:module delivery), resources.pb, DEX files and native libraries, BundleConfig.pb and BUNDLE-METADATA are read; which APKs a device receives is not evaluated. ${ANDROID_PACKAGE_INSPECTION} ${DEX_INSPECTION}`,
    ),
    declare("partial", ANDROID_ROLE_FROM_NAME),
  ),
  apks: androidFacets(
    declare("complete", "bundletool's toc.pb establishes an APK set."),
    declare("complete"),
    declare("complete", ANDROID_EXTRACTION),
    declare(
      "partial",
      `toc.pb variants, modules and APK targeting are decoded and every APK is opened; device matching is not evaluated. ${ANDROID_PACKAGE_INSPECTION} ${DEX_INSPECTION}`,
    ),
    declare("partial", ANDROID_ROLE_FROM_NAME),
  ),
  xapk: androidFacets(
    declare(
      "partial",
      "XAPK has no formal specification: a root manifest.json beside APK members establishes it, and only APKPure's version 2 layout gives APK roles.",
    ),
    declare("complete"),
    declare("complete", ANDROID_EXTRACTION),
    declare(
      "partial",
      `APKPure's manifest.json (xapk_version 2, split_apks, expansions) is read and every APK is opened; other layouts keep generic ZIP facts. No producer-made XAPK was available to check the layout. ${ANDROID_PACKAGE_INSPECTION}`,
    ),
    declare("partial", ANDROID_ROLE_FROM_NAME),
  ),
  ar: both({
    identify: declare(
      "complete",
      "The ar global header is identified; only a Debian package's ar layout is read.",
    ),
    inventory: declare(
      "unsupported",
      "Other ar archives, such as static libraries, are identified only.",
    ),
  }),
  deb: linuxPackageFacets(
    "The data.tar member (uncompressed, gzip, zstd or xz) is listed and extracted; the control archive is read by inspect_linux_package; bzip2 and lzma members are not decoded.",
    "The ar layout, control fields in order, Debian relation syntax, conffiles and md5sums are read.",
  ),
  rpm: linuxPackageFacets(
    "The cpio payload (newc or stripped, uncompressed, gzip, zstd, xz or lzma) is listed and extracted; bzip2 payloads and non-cpio payload formats are not decoded.",
    "The lead, signature and main headers, every tag, dependencies with sense flags (rich dependencies as written) and file lists are read; header, payload and file digests are recomputed.",
  ),
  appimage: imageFacets(
    declare(
      "complete",
      "The AppImage magic in the ELF identification padding gives the type; Type 1 (ISO 9660) AppImages are identified only.",
    ),
    "The runtime ELF, its update information and signature sections (recorded, never verified), the desktop entry and AppRun are read; the runtime is never executed or mounted.",
  ),
  squashfs: imageFacets(
    declare(
      "complete",
      "The SquashFS superblock magic and version are checked.",
    ),
    "The superblock, inodes, directories, file data and fragments are read in process.",
  ),
  "ole-compound": both({
    identify: declare(
      "complete",
      "The compound file signature is checked; its root CLSID tells a Windows Installer package apart.",
    ),
    inventory: declare(
      "unsupported",
      "Only Windows Installer compound files are read; Office documents belong to F12.",
    ),
  }),
  dwarf: dwarfFacets(),
  pdf: pdfFacets(),
  "ooxml-document": ooxmlFacets(),
  "ooxml-macro-document": ooxmlFacets(),
  "ole-office-document": legacyOfficeFacets(),
  "oci-image-layout": containerImageFacets(
    declare(
      "complete",
      "A directory holding an oci-layout file and an index.json.",
    ),
  ),
  "oci-image-archive": containerImageFacets(
    declare(
      "complete",
      "A tar whose members include oci-layout and index.json and no manifest.json.",
    ),
  ),
  "docker-save-archive": containerImageFacets(
    declare(
      "complete",
      "A tar whose members include a manifest.json, as docker save writes it; a plain tar or docker export root filesystem is not an image.",
    ),
  ),
  msi: {
    local: {
      identify: declare(
        "complete",
        "A compound file whose root CLSID is the Windows Installer package class.",
      ),
      inventory: declare("partial", MSI_INVENTORY),
      extract: declare("partial", MSI_INVENTORY),
      inspect: declare("partial", MSI_INSPECTION),
      reconstruct: declare("unsupported", WINDOWS_NO_SOURCE),
    },
    hosted: {
      identify: declare(
        "complete",
        "A compound file whose root CLSID is the Windows Installer package class.",
      ),
      inventory: declare("partial", MSI_INVENTORY),
      extract: declare("partial", MSI_INVENTORY),
      inspect: declare("unsupported", MSI_HOSTED),
      reconstruct: declare("unsupported", WINDOWS_NO_SOURCE),
    },
  },
  msixbundle: {
    local: {
      identify: declare("partial", ROLE_FROM_SUFFIX),
      inventory: declare("complete"),
      extract: declare("complete"),
      inspect: declare("partial", BUNDLE_INSPECTION),
      reconstruct: declare("unsupported", WINDOWS_NO_SOURCE),
    },
    hosted: {
      identify: declare("partial", ROLE_FROM_SUFFIX),
      inventory: declare("partial", ZIP_NON_ENTRY_LIMITATION),
      extract: declare("complete"),
      inspect: declare(
        "unsupported",
        "The hosted service does not read bundle manifests yet.",
      ),
      reconstruct: declare("unsupported", WINDOWS_NO_SOURCE),
    },
  },
  appxbundle: {
    local: {
      identify: declare("partial", ROLE_FROM_SUFFIX),
      inventory: declare("complete"),
      extract: declare("complete"),
      inspect: declare("partial", BUNDLE_INSPECTION),
      reconstruct: declare("unsupported", WINDOWS_NO_SOURCE),
    },
    hosted: {
      identify: declare("partial", ROLE_FROM_SUFFIX),
      inventory: declare("partial", ZIP_NON_ENTRY_LIMITATION),
      extract: declare("complete"),
      inspect: declare(
        "unsupported",
        "The hosted service does not read bundle manifests yet.",
      ),
      reconstruct: declare("unsupported", WINDOWS_NO_SOURCE),
    },
  },
  rar: both({
    identify: declare("complete"),
    inventory: declare(
      "unsupported",
      "No real RAR producer was available to build verification fixtures, so no RAR reader is admitted.",
    ),
    extract: declare(
      "unsupported",
      "No real RAR producer was available to build verification fixtures, so no RAR reader is admitted.",
    ),
    inspect: declare("unsupported", ARCHIVE_NO_INSPECTION),
    reconstruct: declare("unsupported", ARCHIVE_NO_INSPECTION),
  }),
};

/** A planned format: every facet unsupported until its milestone passes. */
const planned = (family: PlannedFamily, fields: FormatFields): FormatEntry => {
  const reason = `Format expansion ${family} is planned for milestone ${SPEC_MILESTONE[family]} and not implemented.`;
  const all: SurfaceCapabilities = Object.fromEntries(
    formatFacetSchema.options.map((facet) => [
      facet,
      declare("unsupported", reason),
    ]),
  );
  const admitted = ADMITTED[fields.id];
  return {
    ...existing(
      fields,
      admitted === undefined
        ? both(all)
        : {
            local: { ...all, ...admitted.local },
            hosted: { ...all, ...admitted.hosted },
          },
    ),
    family,
  };
};

const TEXT_IDENTIFY =
  "Structured text has no byte signature: the profile comes from the name suffix or an explicit choice, and a complete parse confirms it.";
const TEXT_HOSTED_BUDGET =
  "The hosted reader parses uploaded originals up to 16 MiB (JSON, JSON Lines, CSV, TSV, text) or 4 MiB (Markdown, YAML, XML, TOML) in a separate process with a 384 MiB memory budget, and keeps the first 100,000 structural nodes browsable; a file over that budget, and files inside archives, keep the byte preview.";
const TOML_LOCATIONS =
  "smol-toml reports locations for errors only, so TOML values carry no source location.";

/**
 * F11 structured text, implemented in process by the structured-text reader
 * (P1). Inventory, extraction and reconstruction do not apply to a single
 * text document and stay undeclared.
 */
const structuredText = (fields: FormatFields): FormatEntry => {
  const toml = fields.id === "toml";
  return {
    ...existing(fields, {
      local: {
        identify: declare("partial", TEXT_IDENTIFY),
        inspect: toml
          ? declare("partial", TOML_LOCATIONS)
          : declare("complete"),
      },
      hosted: {
        identify: declare("partial", TEXT_IDENTIFY),
        inspect: declare(
          "partial",
          toml ? `${TOML_LOCATIONS} ${TEXT_HOSTED_BUDGET}` : TEXT_HOSTED_BUDGET,
        ),
      },
    }),
    family: "F11",
  };
};

const EXISTING_FORMATS: readonly FormatEntry[] = [
  zipPackage("zip", "ZIP archive", ".zip"),
  zipPackage("ipa", "iOS application archive", ".ipa"),
  {
    ...zipPackage("apk", "Android application package", ".apk"),
    // F04 adds in-process reading of the manifest, resources, DEX and signatures locally.
    capabilities: {
      local: {
        ...zipPackage("apk", "Android application package", ".apk").capabilities
          .local,
        inspect: declare(
          "partial",
          `${ANDROID_PACKAGE_INSPECTION} ${DEX_INSPECTION}`,
        ),
        reconstruct: declare("partial", ANDROID_RECONSTRUCTION),
      },
      hosted: zipPackage("apk", "Android application package", ".apk")
        .capabilities.hosted,
    },
  },
  zipPackage("msix", "MSIX package", ".msix"),
  zipPackage("appx", "AppX package", ".appx"),
  zipPackage("hap", "HarmonyOS ability package", ".hap"),
  zipPackage("hsp", "HarmonyOS shared package", ".hsp"),
  zipPackage("app-pack", "HarmonyOS app pack", ".app"),
  existing(
    {
      id: "raw-binary",
      label: "Raw binary (caller-declared architecture and entry)",
      extensions: [],
      byteSignature: false,
    },
    both({
      identify: declare(
        "unsupported",
        "Raw binaries have no signature; the caller declares them when opening a native target.",
      ),
    }),
  ),
  existing(
    {
      id: "godot-pck",
      label: "Godot PCK archive",
      extensions: [".pck"],
      byteSignature: true,
    },
    both({
      identify: declare("complete"),
      inventory: declare("complete"),
      extract: declare("complete"),
    }),
  ),
  existing(
    {
      id: "asar",
      label: "Electron ASAR archive",
      extensions: [".asar"],
      byteSignature: true,
    },
    both({
      identify: declare(
        "partial",
        "An ASAR header is accepted only when the path also ends in .asar.",
      ),
      inventory: declare("complete"),
      extract: declare("complete"),
    }),
  ),
  existing(
    {
      id: "udif",
      label: "Apple disk image (UDIF)",
      extensions: [".dmg"],
      byteSignature: true,
    },
    both({
      identify: declare(
        "partial",
        "A UDIF trailer is accepted only when the path also ends in .dmg.",
      ),
      inventory: declare(
        "complete",
        "Child inventory uses a native macOS adapter and is unavailable on other hosts.",
        "darwin",
      ),
      extract: declare("unsupported", "Disk images have no extraction reader."),
    }),
  ),
  existing(
    {
      id: "xar",
      label: "XAR archive",
      extensions: [".xar"],
      byteSignature: true,
    },
    both({
      identify: declare(
        "partial",
        "The XAR signature is checked only as the storage of a .pkg installer package; any other XAR file is recorded as a plain file.",
      ),
    }),
  ),
  existing(
    {
      id: "apple-installer-package",
      label: "Apple installer package",
      extensions: [".pkg"],
      storage: ["xar"],
    },
    both({
      identify: declare(
        "partial",
        "The installer role is taken from the .pkg suffix after the XAR signature is verified.",
      ),
      inventory: declare(
        "unsupported",
        "Only the root hash is observed; installer packages have no child inventory reader.",
      ),
      extract: declare(
        "unsupported",
        "Installer packages have no extraction reader.",
      ),
    }),
  ),
  existing(
    { id: "mach-o-universal", label: "Universal Mach-O", byteSignature: true },
    both({
      identify: declare("complete"),
      inventory: declare(
        "complete",
        "Slice inventory uses the native macOS lipo adapter.",
        "darwin",
      ),
      extract: declare(
        "complete",
        "Slice extraction uses the native macOS lipo adapter.",
        "darwin",
      ),
    }),
  ),
  identified({
    id: "mach-o",
    label: "Mach-O image",
    extensions: [".dylib"],
    byteSignature: true,
  }),
  identified({
    id: "elf",
    label: "ELF image",
    extensions: [".so"],
    byteSignature: true,
  }),
  identified({
    id: "pe",
    label: "PE image",
    extensions: [".exe", ".dll"],
    byteSignature: true,
  }),
  identified({
    id: "dos-mz",
    label: "DOS MZ executable",
    extensions: [".exe"],
    byteSignature: true,
  }),
  existing(
    { id: "dos-com", label: "DOS COM program", extensions: [".com"] },
    {
      local: {
        identify: declare(
          "partial",
          "COM programs have no signature; one is accepted only when the caller selects the dos-com target format, never from its name or bytes.",
        ),
      },
      hosted: {
        identify: declare(
          "unsupported",
          "The hosted service takes no caller format selection, and COM programs have no signature.",
        ),
      },
    },
  ),
  identified({
    id: "binary-plist",
    label: "Binary property list",
    extensions: [".plist"],
    byteSignature: true,
  }),
  existing(
    { id: "directory", label: "Directory tree" },
    {
      local: {
        identify: declare("complete"),
        inventory: declare("complete"),
        extract: declare("complete"),
      },
      hosted: { identify: declare("unsupported", HOSTED_SINGLE_FILE) },
    },
  ),
  identified({
    id: "javascript",
    label: "JavaScript",
    extensions: [".js", ".mjs", ".cjs"],
  }),
  identified({ id: "source-map", label: "Source map", extensions: [".map"] }),
  identified({
    id: "property-list",
    label: "Property list",
    extensions: [".plist"],
  }),
  identified({
    id: "entitlements",
    label: "Code-signing entitlements",
    extensions: [".entitlements"],
  }),
  identified(
    {
      id: "analysis-database",
      label: "Analysis database",
      extensions: [".i64", ".idb"],
    },
    declare("unsupported", HOSTED_SINGLE_FILE),
  ),
  identified(
    { id: "hopper-database", label: "Hopper document", extensions: [".hop"] },
    declare("unsupported", HOSTED_SINGLE_FILE),
  ),
];

/** The registry, in a stable documentation order. */
export const FORMAT_REGISTRY: readonly FormatEntry[] = [
  ...EXISTING_FORMATS,
  ...formatFamilySchema.options
    .filter((family): family is PlannedFamily => family !== "existing")
    .flatMap((family) =>
      PLANNED_FORMATS[family].map((fields) =>
        family === "F11" ? structuredText(fields) : planned(family, fields),
      ),
    ),
];
