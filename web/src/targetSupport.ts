import type { Obj, Target, Tool } from "./types.js";
import { object } from "./json.js";
import { resolve } from "./schema.js";

export type TargetAction = { tool: string; label: string };
export type TargetSupport = {
  family: string;
  basis: string;
  note: string;
  actions: TargetAction[];
};

const inventory: TargetAction = {
  tool: "inspect_artifact",
  label: "Inspect file",
};
const native: TargetAction = { tool: "open_binary", label: "Analyze binary" };
const apple: TargetAction = {
  tool: "project_apple_application_graph",
  label: "Apple app graph",
};
const android: TargetAction = {
  tool: "project_android_application_graph",
  label: "Android app graph",
};

/** Offer entry points from observed headers or explicitly labeled filename hints. */
export function targetSupport(target: Target): TargetSupport {
  const name = target.name.toLowerCase();
  const header =
    target.preview?.offset === 0 ? target.preview.hex.toLowerCase() : "";
  const hint = "Filename hint · inspection verifies the format";
  const nativeHeader =
    /^(cffaedfe|cefaedfe|feedfacf|feedface|bebafeca|bfbafeca|cafebabf|7f454c46|4d5a)/.test(
      header,
    );
  const binaryProfile: TargetSupport = {
    family: /\.(exe|dll)$/.test(name)
      ? "Native / managed candidate"
      : "Native binary",
    basis: nativeHeader ? "Executable header observed" : hint,
    note: "Inventory is built in. Decompilation needs a configured Hopper, Ghidra, or IDA engine. PE files may also contain .NET metadata.",
    actions: [inventory, native],
  };
  if (target.application)
    return {
      family: "Apple application",
      basis: "Application bundle",
      note: "Inspect package contents or open its executable in your configured native engine.",
      actions: [inventory, native, apple],
    };
  if (target.directory)
    return {
      family: "Project folder",
      basis: "Local directory",
      note: "Inventory the folder or analyze a JavaScript / Electron project.",
      actions: [
        inventory,
        { tool: "analyze_javascript_application", label: "Analyze JavaScript" },
      ],
    };
  if (nativeHeader) return binaryProfile;
  if (name.endsWith(".apk") && !header.startsWith("6465780a"))
    return {
      family: "Android APK",
      basis: hint,
      note: "Inventory and app graph are built in. Class and method analysis requires your own JADX engine and Java.",
      actions: [
        inventory,
        android,
        { tool: "inspect_android_package", label: "Analyze with JADX" },
      ],
    };
  if (/\.(aab|apks|xapk)$/.test(name))
    return {
      family: "Android bundle",
      basis: hint,
      note: "App Bundles, APK sets and XAPKs are read in process (inspect_android_artifact): manifests, splits, DEX classes and resources. JADX decompilation needs one standalone APK. Use What is this? for a checked answer.",
      actions: [inventory],
    };
  if (name.endsWith(".dex") || header.startsWith("6465780a"))
    return {
      family: "Android DEX",
      basis: header.startsWith("6465780a") ? "DEX header observed" : hint,
      note: "Classes, methods and Dalvik bytecode are read in process (inspect_android_artifact, inspect_dex_class, inspect_dex_method). decompile_dex_class reconstructs Java with an installed dex2jar and Vineflower. Use What is this? for a checked answer.",
      actions: [inventory],
    };
  if (name.endsWith(".ipa"))
    return {
      family: "Apple package",
      basis: hint,
      note: "Inventory the IPA and project its app graph. Encrypted executables may limit deeper analysis.",
      actions: [inventory, apple],
    };
  if (/\.(exe|dll|so|dylib|o|a)$/.test(name)) return binaryProfile;
  if (name.endsWith(".asar"))
    return {
      family: "Electron archive",
      basis: hint,
      note: "Inspect package contents or analyze its JavaScript application.",
      actions: [
        inventory,
        { tool: "analyze_javascript_application", label: "Analyze JavaScript" },
      ],
    };
  if (/\.(?:[cm]?[jt]sx?|map|html?|css|json)$/.test(name))
    return {
      family: "Web / source",
      basis: hint,
      note: "Read source, inspect contents, or choose a browser and JavaScript tool for deeper questions.",
      actions: [inventory],
    };
  if (/\.(jar|class)$/.test(name))
    return {
      family: "Java bytecode",
      basis: hint,
      note: "Class files, JARs and AARs are read in process (inspect_jvm_artifact, inspect_jvm_class, inspect_jvm_method); decompile_jvm_class uses an installed Vineflower. Use What is this? for a checked answer.",
      actions: [inventory],
    };
  if (
    /\.(zip|tar|tgz|gz|dmg|pkg|deb|rpm|msix|msixbundle|appx|appxbundle|7z|rar)$/.test(
      name,
    ) ||
    header.startsWith("504b")
  )
    return {
      family: "Archive / installer",
      basis: header.startsWith("504b") ? "ZIP header candidate" : hint,
      note: "Inspect recognized containers and nested artifacts. The report names unavailable readers and incomplete coverage; 7z and RAR do not imply built-in extraction.",
      actions: [inventory],
    };
  if (name.endsWith(".wasm") || header.startsWith("0061736d"))
    return {
      family: "WebAssembly",
      basis: header.startsWith("0061736d")
        ? "WebAssembly header observed"
        : hint,
      note: "Preview and artifact inspection are available. Native engine support depends on its loader.",
      actions: [inventory],
    };
  return {
    family: "File",
    basis: "Format not yet verified",
    note: "Every regular file can be previewed as hex or strings. Inspection reports the format and available analysis without executing the file.",
    actions: [inventory],
  };
}

const targetPathFields: Readonly<Record<string, string>> = {
  open_binary: "path",
  analyze_javascript_application: "input_path",
  inspect_android_package: "path",
  search_android_classes: "path",
  inspect_android_class: "path",
  inspect_android_method: "path",
  trace_android_references: "path",
};

/** Fill verified input bindings only; never guess that an output path is a target. */
export function targetArguments(
  tool: Tool,
  target: Target | undefined,
  input: Obj = {},
): Obj {
  if (!target || !object(tool.inputSchema.properties)) return input;
  const properties = tool.inputSchema.properties;
  const field = targetPathFields[tool.name];
  const property = field ? properties[field] : undefined;
  return field &&
    object(property) &&
    resolve(property, tool.inputSchema).type === "string"
    ? { [field]: target.path, ...input }
    : input;
}

export const FILE_SUPPORT = [
  {
    family: "Native binaries",
    formats: "Mach-O · PE · ELF · libraries",
    coverage: "Inventory + engine analysis",
    detail:
      "Open binaries and Apple app executables with your configured Hopper, Ghidra, or IDA. Host, architecture, and loader coverage vary.",
    query: "binary",
  },
  {
    family: "Android",
    formats: "APK · DEX · AAB · APKS · XAPK",
    coverage: "APK analysis · bundle preview",
    detail:
      "APK inventory, app graph, JADX classes and methods, plus separate Apktool, JEB, and ADB tools. Raw DEX and bundles have preview / inventory only; deep analysis needs a standalone APK.",
    query: "android",
  },
  {
    family: "Apple apps",
    formats: "APP · IPA · frameworks · dylib",
    coverage: "Package + application graph",
    detail:
      "Inspect bundle resources, entitlements, and app relationships. Native analysis depends on executable access and engine support; encrypted iOS binaries remain limited.",
    query: "apple",
  },
  {
    family: "Web & Electron",
    formats: "JS · TS · HTML · source maps · ASAR",
    coverage: "Source + runtime tools",
    detail:
      "Read source files, analyze project folders and Electron archives, or connect browser and runtime capture tools to an explicit target.",
    query: "javascript",
  },
  {
    family: ".NET & Java",
    formats: "EXE · DLL · JAR · CLASS",
    coverage: ".NET and JVM analysis",
    detail:
      "Managed tools inspect .NET metadata, members, IL, and native boundaries. JVM tools read class files, JARs and AARs in process; Java source needs an installed Vineflower.",
    query: "managed",
  },
  {
    family: "Archives & installers",
    formats: "ZIP · TAR · GZIP · DMG · MSIX · APPX",
    coverage: "Recognized container inventory",
    detail:
      "Inspect entries, nested artifacts, and evidence. Disk images and other formats depend on the available reader; partial reports retain their limits.",
    query: "artifact",
  },
  {
    family: "Firmware & bytecode",
    formats: "BIN · ROM · WASM · EVM inputs",
    coverage: "Preview + specialist tools",
    detail:
      "Inspect firmware regions and supported EVM inputs with their dedicated contracts. Raw byte preview is available even when a format has no deep-analysis adapter.",
    query: "firmware",
  },
  {
    family: "Any regular file",
    formats: "Extensionless · unknown · text · binary",
    coverage: "Text · hex · strings",
    detail:
      "Open local paths without an upload size limit, or upload individual files up to 128 MiB. Use a local path for folders and application bundles.",
    query: "inspect",
  },
] as const;
