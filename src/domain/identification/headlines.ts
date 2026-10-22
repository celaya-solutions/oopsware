import type { z } from "zod";

import { androidArtifactReportSchema } from "../android/androidArtifact.js";
import { containerImageReportSchema } from "../containerImage/containerImage.js";
import { desktopApplicationSchema } from "../desktopApplication.js";
import { structuredTextDocumentSchema } from "../document/structuredText.js";
import { formatEntry } from "../formatRegistry.js";
import { formatIdSchema } from "../formatIdentifiers.js";
import { goBinarySchema } from "../go/goBinary.js";
import { jvmArtifactReportSchema } from "../jvm/jvm.js";
import { linuxPackageReportSchema } from "../linuxPackage/linuxPackage.js";
import { managedArtifactInspectionSchema } from "../managed/managedArtifact.js";
import { peResourcesSchema } from "../native/peResources.js";
import { pythonArtifactReportSchema } from "../python/python.js";
import { rustBinarySchema } from "../rust/rustBinary.js";
import { wasmModuleReportSchema } from "../wasm/webAssembly.js";
import {
  OFFICE_KINDS,
  officeDocumentReportSchema,
} from "../officeDocument/officeDocument.js";
import { pdfDocumentReportSchema } from "../pdfDocument/pdfDocument.js";
import { msixPackageReportSchema } from "../windowsInstaller/msixPackage.js";
import { windowsInstallerReportSchema } from "../windowsInstaller/windowsInstaller.js";
import {
  MAX_HEADLINE_FACTS,
  type Headline,
  type HeadlineFact,
} from "./identification.js";

/**
 * One headline per reader, projected from that reader's own typed report.
 * A report that parses but describes a different kind of file (a JVM reader
 * that saw a plain ZIP) is a no-match with its reason, not a headline.
 */
export type HeadlineOutcome =
  | { readonly ok: true; readonly headline: Headline }
  | { readonly ok: false; readonly reason: string; readonly refuted: boolean };

type Value = string | number | null | undefined;

const MAX_VALUE = 160;

const clip = (value: string): string =>
  value.length <= MAX_VALUE ? value : `${value.slice(0, MAX_VALUE - 1)}…`;

const facts = (
  ...pairs: readonly (readonly [string, Value])[]
): HeadlineFact[] =>
  pairs
    .flatMap(([label, value]) => {
      if (value === null || value === undefined) return [];
      const text =
        typeof value === "number"
          ? value.toLocaleString("en-US")
          : value.trim();
      return text === "" ? [] : [{ label, value: clip(text) }];
    })
    .slice(0, MAX_HEADLINE_FACTS);

const title = (...parts: readonly Value[]): string =>
  clip(
    parts
      .flatMap((part) =>
        part === null || part === undefined || String(part).trim() === ""
          ? []
          : [String(part).trim()],
      )
      .join(" "),
  );

const list = (values: readonly string[], limit = 4): string | null =>
  values.length === 0
    ? null
    : values.length <= limit
      ? values.join(", ")
      : `${values.slice(0, limit).join(", ")} and ${String(values.length - limit)} more`;

const headline = (
  tool: string,
  text: string,
  found: HeadlineFact[],
): HeadlineOutcome => ({
  ok: true,
  headline: { tool, title: text, facts: found },
});

/** The reader read the file and says it is not its format. */
const noMatch = (reason: string): HeadlineOutcome => ({
  ok: false,
  reason,
  refuted: true,
});

/** Nothing was learned about the file itself. */
const unknown = (reason: string): HeadlineOutcome => ({
  ok: false,
  reason,
  refuted: false,
});

const parsed = <Schema extends z.ZodType>(
  schema: Schema,
  report: unknown,
  project: (value: z.infer<Schema>) => HeadlineOutcome,
): HeadlineOutcome => {
  const result = schema.safeParse(report);
  return result.success
    ? project(result.data)
    : unknown("The reader's report did not match its own schema.");
};

const LINUX_KIND = {
  deb: "Debian package",
  rpm: "RPM package",
  appimage: "AppImage",
  squashfs: "SquashFS image",
} as const;

const linuxPackage = (report: unknown) =>
  parsed(linuxPackageReportSchema, report, (value) => {
    const { identity } = value;
    const version =
      identity.version === null
        ? null
        : `${identity.epoch === null ? "" : `${String(identity.epoch)}:`}${identity.version}${identity.release === null ? "" : `-${identity.release}`}`;
    return headline(
      "inspect_linux_package",
      title(LINUX_KIND[value.package.kind], identity.name, version),
      facts(
        [
          "Architecture",
          identity.architecture ?? value.appimage?.runtime.machine,
        ],
        ["Summary", identity.summary],
        ["Files", value.file_count],
        ["Dependencies", value.dependencies.length],
        ["Scripts", value.scripts.length],
        ["Compression", value.squashfs?.compression],
      ),
    );
  });

const IMAGE_KIND = {
  "oci-image-layout": "OCI image layout",
  "oci-image-archive": "OCI image archive",
  "docker-save-archive": "Docker save archive",
} as const;

const containerImage = (report: unknown) =>
  parsed(containerImageReportSchema, report, (value) => {
    const platform =
      value.manifests.find((manifest) => manifest.selected)?.platform ?? null;
    return headline(
      "inspect_container_image",
      title(
        IMAGE_KIND[value.image.format],
        value.manifests.flatMap((manifest) => manifest.ref_names)[0],
      ),
      facts(
        [
          "Platform",
          platform === null
            ? null
            : [platform.os, platform.architecture, platform.variant]
                .filter((part) => part !== null)
                .join("/"),
        ],
        ["Images", value.manifests.filter((m) => m.kind === "image").length],
        ["Layers", value.layers.length],
        ["Files", value.file_count],
        ["User", value.config?.user],
        ["Entrypoint", list(value.config?.entrypoint ?? [])],
      ),
    );
  });

const windowsInstaller = (report: unknown) =>
  parsed(windowsInstallerReportSchema, report, (value) =>
    headline(
      "inspect_windows_installer",
      title(
        "Windows Installer package",
        value.product.name,
        value.product.version,
      ),
      facts(
        ["Manufacturer", value.product.manufacturer],
        ["Product code", value.product.product_code],
        ["Platforms", list(value.summary?.platforms ?? [])],
        ["Language", value.product.language],
        ["Files", value.file_count],
        ["Made with", value.summary?.creating_application],
      ),
    ),
  );

const MSIX_KIND = {
  msix: "MSIX package",
  appx: "AppX package",
  msixbundle: "MSIX bundle",
  appxbundle: "AppX bundle",
} as const;

const msixPackage = (report: unknown) =>
  parsed(msixPackageReportSchema, report, (value) => {
    const manifest = value.parts?.manifest ?? null;
    const identity = manifest?.identity ?? value.bundle?.identity ?? null;
    return headline(
      "inspect_msix_package",
      title(MSIX_KIND[value.package.kind], identity?.name, identity?.version),
      facts(
        ["Display name", manifest?.properties.display_name],
        [
          "Publisher",
          manifest?.properties.publisher_display_name ?? identity?.publisher,
        ],
        [
          "Architecture",
          identity?.processor_architecture ??
            list(value.bundle?.architectures ?? []),
        ],
        ["Packages", value.bundle?.packages.length],
      ),
    );
  });

const ANDROID_KIND = {
  dex: "Dalvik executable (DEX)",
  apk: "Android app (APK)",
  aab: "Android App Bundle",
  apks: "Android APK set",
  xapk: "XAPK package",
} as const;

const androidArtifact = (report: unknown) =>
  parsed(androidArtifactReportSchema, report, (value) => {
    if (value.package.kind === "zip")
      return noMatch("It reads as a plain ZIP, not an Android package.");
    const manifest =
      value.apk?.manifest?.facts ??
      value.bundle?.modules.find((module) => module.manifest?.facts !== null)
        ?.manifest?.facts ??
      null;
    return headline(
      "inspect_android_artifact",
      title(
        ANDROID_KIND[value.package.kind],
        manifest?.package_name,
        manifest?.version_name,
      ),
      facts(
        ["Version code", manifest?.version_code],
        ["Min SDK", manifest?.min_sdk],
        ["Target SDK", manifest?.target_sdk],
        ["Classes", value.class_count],
        ["DEX files", value.summary.dex_files],
        ["Native ABIs", list(value.apk?.native_abis ?? [])],
      ),
    );
  });

const JVM_KIND = {
  class: "Java class file",
  jar: "Java archive (JAR)",
  aar: "Android library (AAR)",
} as const;

const jvmArtifact = (report: unknown) =>
  parsed(jvmArtifactReportSchema, report, (value) => {
    if (value.container.kind === "zip")
      return noMatch(
        "It reads as a plain ZIP with no Java classes or manifest.",
      );
    const module = value.modules[0];
    return headline(
      "inspect_jvm_artifact",
      title(
        JVM_KIND[value.container.kind],
        value.manifest?.automatic_module_name ?? module?.name,
      ),
      facts(
        ["Classes", value.class_count],
        ["Main class", value.manifest?.main_class],
        [
          "Java versions",
          list(
            value.summary.versions.map(
              (version) => `Java ${String(version.java)}`,
            ),
          ),
        ],
        ["Module version", module?.version],
        ["Android package", value.android?.manifest?.package],
        ["Created by", value.manifest?.created_by],
      ),
    );
  });

type PythonReport = z.infer<typeof pythonArtifactReportSchema>;

const pythonWheel = (value: PythonReport): HeadlineOutcome => {
  const metadata = value.wheel?.metadata ?? null;
  const filename = value.wheel?.filename ?? null;
  return headline(
    "inspect_python_artifact",
    title(
      "Python wheel",
      metadata?.name ?? filename?.distribution,
      metadata?.version ?? filename?.version,
    ),
    facts(
      ["Summary", metadata?.summary],
      ["Requires Python", metadata?.requires_python],
      ["Platforms", list(filename?.platform_tags ?? [])],
      ["Modules", value.module_count],
      ["Native extensions", value.native_count],
    ),
  );
};

const pythonBytecode = (value: PythonReport): HeadlineOutcome => {
  const release = value.header?.release ?? null;
  return headline(
    "inspect_python_artifact",
    title("Python bytecode", release === null ? null : `for Python ${release}`),
    facts(
      ["Magic number", value.header?.magic],
      ["Code modules", value.module_count],
    ),
  );
};

const pythonArtifact = (report: unknown) =>
  parsed(pythonArtifactReportSchema, report, (value) => {
    switch (value.container.kind) {
      case "zip":
        return noMatch(
          "It reads as a plain ZIP with no wheel or zip-application layout.",
        );
      case "wheel":
        return pythonWheel(value);
      case "bytecode":
        return pythonBytecode(value);
      case "zipapp":
        return headline(
          "inspect_python_artifact",
          "Python zip application",
          facts(
            ["Modules", value.module_count],
            ["Native extensions", value.native_count],
          ),
        );
      case "source":
        return headline(
          "inspect_python_artifact",
          "Python source",
          facts(["Modules", value.module_count]),
        );
    }
  });

const wasmModule = (report: unknown) =>
  parsed(wasmModuleReportSchema, report, (value) =>
    headline(
      "inspect_wasm_module",
      title(
        value.encoding.kind === "component"
          ? "WebAssembly component"
          : value.encoding.kind === "module"
            ? "WebAssembly module"
            : "WebAssembly file",
        value.module_name,
      ),
      facts(
        ["Functions", value.function_count],
        ["Imports", value.summary.imports],
        ["Exports", value.summary.exports],
        ["Validation", value.validation.state.replaceAll("_", " ")],
        [
          "Produced by",
          list(
            value.producers.flatMap((producer) =>
              producer.values.map((tool) => tool.name),
            ),
            3,
          ),
        ],
      ),
    ),
  );

const document = (report: unknown) =>
  parsed(structuredTextDocumentSchema, report, (value) => {
    const profile = formatIdSchema.safeParse(value.format.profile);
    const label = profile.success
      ? formatEntry(profile.data).label
      : value.format.profile;
    if (value.parse.status === "failed")
      return noMatch(`It does not parse as ${label}.`);
    return headline(
      "inspect_document",
      title(label, "document"),
      facts(
        ["Parse", value.parse.status],
        ["Records", value.parse.records],
        ["Lines", value.encoding.lines],
        ["Encoding", value.encoding.name],
        ["Nodes", value.node_count],
      ),
    );
  });

const managedArtifact = (report: unknown) =>
  parsed(managedArtifactInspectionSchema, report, (value) => {
    const { classification } = value;
    if (classification.status === "not-managed")
      return headline(
        "inspect_managed_artifact",
        "Native PE image (no .NET metadata)",
        facts(["Architecture", value.pe.architecture]),
      );
    return headline(
      "inspect_managed_artifact",
      classification.status === "malformed"
        ? ".NET image with malformed metadata"
        : title(".NET assembly", value.assembly?.name, value.assembly?.version),
      facts(
        ["Runtime", classification.runtime_family],
        ["Target frameworks", list(value.target_frameworks)],
        ["Architecture", value.pe.architecture],
        ["Runtime version", value.pe.cli?.runtime_version],
        ["Module", value.module?.name],
      ),
    );
  });

const IMAGE = { elf: "ELF", pe: "PE", macho: "Mach-O" } as const;

const goBinary = (report: unknown) =>
  parsed(goBinarySchema, report, (value) => {
    const image = `${IMAGE[value.format]} image (${value.architecture}, ${String(value.bits)}-bit)`;
    const build = value.build_info;
    if (build === null)
      return headline(
        "inspect_go_binary",
        image,
        facts(["Go build", "No Go build information"]),
      );
    return headline(
      "inspect_go_binary",
      title("Go program", build.module.main?.path ?? build.module.path),
      facts(
        ["Go version", build.go_version],
        ["Module version", build.module.main?.version],
        ["Dependencies", build.module.dependencies.length],
        ["Image", image],
      ),
    );
  });

const rustBinary = (report: unknown) =>
  parsed(rustBinarySchema, report, (value) => {
    const packages = value.auditable_metadata?.packages ?? [];
    const root =
      packages.find((candidate) => candidate.root) ??
      (value.auditable_metadata?.root_package_index === null ||
      value.auditable_metadata === null
        ? undefined
        : packages[value.auditable_metadata.root_package_index]);
    return headline(
      "inspect_rust_binary",
      root === undefined
        ? `${IMAGE[value.format]} image (${value.architecture})`
        : title("Rust program", root.name, root.version),
      facts(
        ["rustc commit", value.rustc_commit?.hashes[0]?.hash.slice(0, 12)],
        ["Crates", packages.length === 0 ? null : packages.length],
        [
          "Rust",
          root === undefined && value.rustc_commit === null
            ? "No rustc commit or crate list found"
            : null,
        ],
      ),
    );
  });

const peResources = (report: unknown) =>
  parsed(peResourcesSchema, report, (value) =>
    headline(
      "inspect_pe_resources",
      `${value.format === "pe32-plus" ? "PE32+" : "PE32"} image with ${value.resources.length.toLocaleString("en-US")} resources`,
      facts(
        ["Icon groups", value.icon_groups.length],
        ["Machine", `0x${value.machine.toString(16).padStart(4, "0")}`],
      ),
    ),
  );

const FAMILY = {
  dotnet: ".NET",
  "unity-mono": "Unity (Mono)",
  "unity-il2cpp": "Unity (IL2CPP)",
  unreal: "Unreal",
  godot: "Godot",
  gamemaker: "GameMaker",
  electron: "Electron",
} as const;

const desktopApplication = (report: unknown) =>
  parsed(desktopApplicationSchema, report, (value) => {
    const families = [
      ...new Set(value.candidates.map((candidate) => FAMILY[candidate.family])),
    ];
    return headline(
      "inspect_desktop_application",
      families.length === 0
        ? "No app or game layout found"
        : `${list(families) ?? ""} application folder`,
      facts(
        [
          "Components",
          list(value.components.map((component) => component.name)),
        ],
        ["Entries examined", value.coverage.entries_examined],
        ["Files probed", value.coverage.files_probed],
      ),
    );
  });

const OFFICE_KIND: Readonly<Record<(typeof OFFICE_KINDS)[number], string>> = {
  docx: "Word document",
  dotx: "Word template",
  docm: "Word macro-enabled document",
  dotm: "Word macro-enabled template",
  xlsx: "Excel workbook",
  xltx: "Excel template",
  xlsm: "Excel macro-enabled workbook",
  xltm: "Excel macro-enabled template",
  xlam: "Excel add-in",
  xlsb: "Excel binary workbook",
  doc: "Word 97-2003 document",
  xls: "Excel 97-2003 workbook",
  ppt: "PowerPoint 97-2003 presentation",
  pptx: "PowerPoint presentation",
  potx: "PowerPoint template",
  pptm: "PowerPoint macro-enabled presentation",
  potm: "PowerPoint macro-enabled template",
  ppsx: "PowerPoint slide show",
  ppsm: "PowerPoint macro-enabled slide show",
  ppam: "PowerPoint add-in",
  unknown: "Office package",
};

const EMBEDDED_KINDS: ReadonlySet<string> = new Set([
  "ole-object",
  "embedded-package",
  "activex",
]);

/** A count worth a fact only when something was found. */
const found = (count: number): number | null => (count > 0 ? count : null);

const officeDocument = (report: unknown) =>
  parsed(officeDocumentReportSchema, report, (value) => {
    const { package: office } = value;
    if (office.kind === "unknown")
      return noMatch(
        "It is a package, but not a Word, Excel or PowerPoint one.",
      );
    const name = office.properties.core["title"];
    const notable = new Set(office.notable.map((part) => part.kind));
    return headline(
      "inspect_office_document",
      title(OFFICE_KIND[office.kind], name === undefined ? null : `"${name}"`),
      facts(
        ["Author", office.properties.core["creator"]],
        ["Modified", office.properties.core["modified"]],
        ["Macros", office.macro_enabled ? "Yes" : null],
        [
          "Embedded objects",
          found(
            office.notable.filter((part) => EMBEDDED_KINDS.has(part.kind))
              .length,
          ),
        ],
        ["External references", found(office.external_total)],
        ["Signed", notable.has("digital-signature") ? "Yes" : null],
        ["Parts", office.part_count],
      ),
    );
  });

const infoValue = (
  info: readonly { readonly key: string; readonly value: string }[] | undefined,
  key: string,
): string | undefined => info?.find((entry) => entry.key === key)?.value;

const pdfDocument = (report: unknown) =>
  parsed(pdfDocumentReportSchema, report, (value) => {
    const { document } = value;
    const version = document.header_version ?? document.catalog_version;
    const info = value.metadata?.info;
    const scanned = value.content_sample?.by_kind["image-only"] ?? 0;
    return headline(
      "inspect_pdf_document",
      title("PDF", version, "document"),
      facts(
        ["Pages", document.page_count],
        ["Title", infoValue(info, "Title")],
        [
          "Encryption",
          document.encryption === null
            ? null
            : (document.encryption.method ?? "unknown method"),
        ],
        ["Active content", found(value.action_total)],
        ["Attachments", found(value.attachment_total)],
        ["Signatures", found(value.signature_total)],
        ["Producer", infoValue(info, "Producer")],
        [
          "Scanned pages",
          scanned === 0
            ? null
            : `${String(scanned)} of ${String(value.content_sample?.pages_examined ?? scanned)} examined`,
        ],
      ),
    );
  });

const PROJECTIONS: Readonly<
  Record<string, (report: unknown) => HeadlineOutcome>
> = {
  inspect_linux_package: linuxPackage,
  inspect_container_image: containerImage,
  inspect_windows_installer: windowsInstaller,
  inspect_msix_package: msixPackage,
  inspect_android_artifact: androidArtifact,
  inspect_jvm_artifact: jvmArtifact,
  inspect_python_artifact: pythonArtifact,
  inspect_wasm_module: wasmModule,
  inspect_document: document,
  inspect_pdf_document: pdfDocument,
  inspect_office_document: officeDocument,
  inspect_managed_artifact: managedArtifact,
  inspect_go_binary: goBinary,
  inspect_rust_binary: rustBinary,
  inspect_pe_resources: peResources,
  inspect_desktop_application: desktopApplication,
};

/** Tools identification can run itself; every other route is a next step only. */
export const HEADLINE_TOOLS: readonly string[] = Object.keys(PROJECTIONS);

/** Project one reader's report into a headline, or say why it is not a match. */
export const headlineFromReport = (
  tool: string,
  report: unknown,
): HeadlineOutcome => {
  const project = PROJECTIONS[tool];
  return project === undefined
    ? unknown(`No headline is defined for ${tool}.`)
    : project(report);
};
