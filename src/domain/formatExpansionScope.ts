import type {
  FormatFamily,
  FormatId,
  StorageFormatId,
} from "./formatIdentifiers.js";

/** A family from the format expansion specification, not yet implemented. */
export type PlannedFamily = Exclude<FormatFamily, "existing">;

/** Identity fields of one registry record. */
export interface FormatFields {
  readonly id: FormatId;
  readonly label: string;
  readonly extensions?: readonly string[];
  readonly storage?: readonly StorageFormatId[];
  readonly byteSignature?: boolean;
}

/** Section 3 of the format expansion specification, by family. */
export const PLANNED_FORMATS: Readonly<
  Record<PlannedFamily, readonly FormatFields[]>
> = {
  F01: [
    {
      id: "wasm-binary",
      label: "WebAssembly binary",
      extensions: [".wasm"],
      byteSignature: true,
    },
    {
      id: "wasm-module",
      label: "WebAssembly core module",
      extensions: [".wasm"],
      storage: ["wasm-binary"],
      byteSignature: true,
    },
    {
      id: "wasm-component",
      label: "WebAssembly component",
      extensions: [".wasm"],
      storage: ["wasm-binary"],
      byteSignature: true,
    },
    { id: "wasm-text", label: "WebAssembly text", extensions: [".wat"] },
  ],
  F02: [
    {
      id: "jvm-classfile",
      label: "JVM class file",
      extensions: [".class"],
      byteSignature: true,
    },
    {
      id: "jar",
      label: "Java archive",
      extensions: [".jar"],
      storage: ["zip"],
    },
    {
      id: "aar",
      label: "Android library archive",
      extensions: [".aar"],
      storage: ["zip"],
    },
  ],
  F03: [
    { id: "python-source", label: "Python source", extensions: [".py"] },
    { id: "cpython-bytecode", label: "CPython bytecode", extensions: [".pyc"] },
    {
      id: "wheel",
      label: "Python wheel",
      extensions: [".whl"],
      storage: ["zip"],
    },
    {
      id: "pyz",
      label: "Python zip application",
      extensions: [".pyz"],
      storage: ["zip"],
    },
  ],
  F04: [
    {
      id: "dalvik-dex",
      label: "Dalvik executable",
      extensions: [".dex"],
      byteSignature: true,
    },
    {
      id: "android-app-bundle",
      label: "Android App Bundle",
      extensions: [".aab"],
      storage: ["zip"],
    },
    {
      id: "apks",
      label: "Android split APK set",
      extensions: [".apks"],
      storage: ["zip"],
    },
    {
      id: "xapk",
      label: "XAPK package",
      extensions: [".xapk"],
      storage: ["zip"],
    },
  ],
  F05: [
    {
      id: "ar",
      label: "Unix ar archive",
      extensions: [".a", ".ar"],
      byteSignature: true,
    },
    {
      id: "deb",
      label: "Debian package",
      extensions: [".deb"],
      storage: ["ar"],
      byteSignature: true,
    },
    {
      id: "rpm",
      label: "RPM package",
      extensions: [".rpm"],
      byteSignature: true,
    },
    {
      id: "appimage",
      label: "AppImage",
      extensions: [".appimage"],
      storage: ["elf"],
      byteSignature: true,
    },
    {
      id: "squashfs",
      label: "SquashFS filesystem",
      extensions: [".squashfs", ".sqsh"],
      byteSignature: true,
    },
  ],
  F06: [
    {
      id: "iso",
      label: "ISO 9660 disc image",
      extensions: [".iso"],
      byteSignature: true,
    },
    {
      id: "tar",
      label: "Tar archive",
      extensions: [".tar"],
      byteSignature: true,
    },
    {
      id: "gzip",
      label: "Gzip stream",
      extensions: [".gz", ".tgz", ".tar.gz"],
      byteSignature: true,
    },
    {
      id: "bzip2",
      label: "Bzip2 stream",
      extensions: [".bz2", ".tbz2", ".tar.bz2"],
      byteSignature: true,
    },
    {
      id: "xz",
      label: "XZ stream",
      extensions: [".xz", ".txz", ".tar.xz"],
      byteSignature: true,
    },
    {
      id: "zstd",
      label: "Zstandard frame",
      extensions: [".zst", ".tar.zst"],
      byteSignature: true,
    },
    {
      id: "7z",
      label: "7-Zip archive",
      extensions: [".7z"],
      byteSignature: true,
    },
    {
      id: "rar",
      label: "RAR archive",
      extensions: [".rar"],
      byteSignature: true,
    },
  ],
  F07: [
    {
      id: "sqlite",
      label: "SQLite database",
      extensions: [".sqlite", ".sqlite3", ".db"],
      byteSignature: true,
    },
  ],
  F08: [
    { id: "ole-compound", label: "OLE compound file", byteSignature: true },
    {
      id: "msi",
      label: "Windows Installer package",
      extensions: [".msi"],
      storage: ["ole-compound"],
    },
    {
      id: "msixbundle",
      label: "MSIX bundle",
      extensions: [".msixbundle"],
      storage: ["zip"],
    },
    {
      id: "appxbundle",
      label: "AppX bundle",
      extensions: [".appxbundle"],
      storage: ["zip"],
    },
  ],
  F09: [
    {
      id: "oci-image-layout",
      label: "OCI image layout directory",
      storage: ["directory"],
    },
    {
      id: "oci-image-archive",
      label: "OCI image archive",
      extensions: [".tar"],
      storage: ["tar"],
    },
    {
      id: "docker-save-archive",
      label: "Docker save archive",
      extensions: [".tar"],
      storage: ["tar"],
    },
  ],
  F10: [
    {
      id: "pdb-msf",
      label: "PDB (MSF 7.0)",
      extensions: [".pdb"],
      byteSignature: true,
    },
    {
      id: "dwarf",
      label: "DWARF debug information",
      extensions: [".debug", ".dsym"],
      storage: ["elf", "mach-o", "directory"],
    },
  ],
  F11: [
    { id: "markdown", label: "Markdown", extensions: [".md", ".markdown"] },
    { id: "json", label: "JSON", extensions: [".json"] },
    { id: "jsonl", label: "JSON Lines", extensions: [".jsonl"] },
    { id: "yaml", label: "YAML", extensions: [".yaml", ".yml"] },
    { id: "toml", label: "TOML", extensions: [".toml"] },
    { id: "xml", label: "XML", extensions: [".xml"] },
    { id: "csv", label: "CSV", extensions: [".csv"] },
    { id: "tsv", label: "TSV", extensions: [".tsv"] },
    { id: "plain-text", label: "Plain text", extensions: [".txt"] },
  ],
  F12: [
    {
      id: "pdf",
      label: "PDF document",
      extensions: [".pdf"],
      byteSignature: true,
    },
    {
      id: "ooxml-document",
      label: "Office Open XML document",
      extensions: [".docx", ".xlsx", ".pptx"],
      storage: ["zip"],
    },
    {
      id: "ooxml-macro-document",
      label: "Macro-enabled Office Open XML document",
      extensions: [".docm", ".xlsm", ".pptm"],
      storage: ["zip"],
    },
    {
      id: "ole-office-document",
      label: "Legacy Office document",
      extensions: [".doc", ".xls", ".ppt"],
      storage: ["ole-compound"],
    },
  ],
};
