import type { Submission } from "./types.js";
import { artifactFormatSchema } from "../domain/artifactGraph.js";
import {
  ARTIFACT_GRAPH_FORMAT_IDS,
  formatEntry,
} from "../domain/formatRegistry.js";

export const CATEGORIES = [
  "archives",
  "apps",
  "source",
  "data",
  "documents",
  "media",
  "models",
  "other",
] as const;
export type Category = (typeof CATEGORIES)[number];

const BY_CATEGORY: Record<Exclude<Category, "other">, readonly string[]> = {
  archives: ["zip", "tar", "gz", "tgz", "xz", "txz", "7z", "rar", "asar"],
  apps: [
    "apk",
    "ipa",
    "aab",
    "apks",
    "xapk",
    "appx",
    "msix",
    "appxbundle",
    "msixbundle",
    "msi",
    "exe",
    "dll",
    "sys",
    "dylib",
    "so",
    "dmg",
    "pkg",
    "jar",
    "aar",
    "class",
    "dex",
    "wasm",
    "wat",
    "deb",
    "rpm",
    "appimage",
    "bin",
  ],
  source: [
    "js",
    "jsx",
    "ts",
    "tsx",
    "mjs",
    "cjs",
    "py",
    "pyc",
    "go",
    "rs",
    "c",
    "cc",
    "cpp",
    "h",
    "hpp",
    "swift",
    "kt",
    "java",
    "rb",
    "php",
    "sh",
    "ps1",
    "html",
    "htm",
    "css",
  ],
  data: [
    "json",
    "jsonl",
    "yaml",
    "yml",
    "toml",
    "xml",
    "csv",
    "tsv",
    "sql",
    "sqlite",
    "sqlite3",
    "db",
    "map",
  ],
  documents: [
    "md",
    "markdown",
    "txt",
    "rst",
    "pdf",
    "docx",
    "doc",
    "xlsx",
    "xls",
    "pptx",
    "ppt",
  ],
  media: [
    "png",
    "jpg",
    "jpeg",
    "gif",
    "webp",
    "heic",
    "svg",
    "ico",
    "bmp",
    "mp3",
    "m4a",
    "wav",
    "flac",
    "ogg",
    "mp4",
    "mov",
    "mkv",
    "webm",
    "avi",
  ],
  models: [
    "gguf",
    "safetensors",
    "onnx",
    "pt",
    "pth",
    "ckpt",
    "tflite",
    "pb",
    "stl",
    "step",
    "stp",
    "dwg",
    "obj",
    "glb",
    "gltf",
  ],
};

/** Browse categories are filename hints, never claims about inspected format. */
export const categoryFor = (name: string): Category => {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  for (const key of Object.keys(BY_CATEGORY) as (keyof typeof BY_CATEGORY)[])
    if (BY_CATEGORY[key].includes(extension)) return key;
  return "other";
};

/**
 * The format an inspection observed from bytes, as a registry identity and
 * label. `unrecognized` is explicit; `null` means no inspection recorded one.
 */
export const observedFormatFor = (
  format: string | undefined,
): { readonly id: string; readonly label: string } | null => {
  if (format === undefined) return null;
  const parsed = artifactFormatSchema.safeParse(format);
  const id = parsed.success ? ARTIFACT_GRAPH_FORMAT_IDS[parsed.data] : null;
  return id === null
    ? { id: "unrecognized", label: "Unrecognized format" }
    : { id, label: formatEntry(id).label };
};

/** Plain summaries derived from published facts, without model inference. */
export const summaryFor = (submission: Submission) => {
  if (submission.status === "failed")
    return "Inspection could not finish. Open the details for the reason and any available files.";
  if (submission.status !== "ready")
    return "Inspection is in progress. Findings and available files will appear when it finishes.";
  const extracted = submission.files.filter(
    (file) => file.id !== submission.id,
  ).length;
  if (extracted)
    return `${extracted.toLocaleString("en-US")} extracted ${extracted === 1 ? "file" : "files"} to explore, with an inspection report and the original download.`;
  if (/\.(md|markdown)$/i.test(submission.name))
    return "A Markdown document you can read in a formatted view, inspect as source, or download.";
  return "Original file available to download, with a static inspection report and text, byte, and string views.";
};
