import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";

type Environment = Readonly<Record<string, string | undefined>>;

/** A model folder found on disk. Size counts only the files that were examined. */
export type DiskModel = {
  id: string;
  path: string;
  formats: string[];
  sizeBytes: number;
  weights: boolean;
  /** Set when part of the folder could not be read; size and formats then cover only what was read. */
  error?: string;
};
export type DiskScan = {
  directory: string;
  found: boolean;
  models: DiskModel[];
  truncated: boolean;
  error?: string;
};

const MAX_MODELS = 500;
const MAX_FILES_PER_MODEL = 400;
const weightFormats: Record<string, string> = {
  ".gguf": "gguf",
  ".safetensors": "safetensors",
  ".bin": "bin",
  ".onnx": "onnx",
  ".npz": "npz",
};

const isMissing = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error.code === "ENOENT" || error.code === "ENOTDIR");

/** Hugging Face's own cache rules: HF_HUB_CACHE, then HF_HOME/hub, then ~/.cache/huggingface/hub. */
export const huggingFaceHome = (environment: Environment) =>
  environment.HF_HOME ??
  join(
    environment.XDG_CACHE_HOME ?? join(environment.HOME ?? homedir(), ".cache"),
    "huggingface",
  );
export const huggingFaceHubCache = (environment: Environment) =>
  environment.HF_HUB_CACHE ?? join(huggingFaceHome(environment), "hub");

/** LM Studio keeps a home pointer file and an optional custom downloads folder in its settings. */
export const lmStudioModelsDirectory = async (
  environment: Environment,
): Promise<string> => {
  if (environment.LMSTUDIO_MODELS_DIR) return environment.LMSTUDIO_MODELS_DIR;
  const home = environment.HOME ?? homedir();
  let lmHome = join(home, ".lmstudio");
  try {
    const pointer = (
      await readFile(join(home, ".lmstudio-home-pointer"), "utf8")
    ).trim();
    if (pointer.startsWith("/")) lmHome = pointer;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  try {
    const settings = z
      .object({ downloadsFolder: z.string().startsWith("/").optional() })
      .passthrough()
      .safeParse(
        JSON.parse(await readFile(join(lmHome, "settings.json"), "utf8")),
      );
    if (settings.success && settings.data.downloadsFolder)
      return settings.data.downloadsFolder;
  } catch (error) {
    if (!isMissing(error) && !(error instanceof SyntaxError)) throw error;
  }
  return join(lmHome, "models");
};

/** Walk one model folder without following links, bounded by file count. */
const describeFolder = async (
  path: string,
): Promise<Omit<DiskModel, "id" | "path">> => {
  const formats = new Set<string>();
  let sizeBytes = 0;
  let files = 0;
  let unreadable = false;
  const pending = [path];
  while (pending.length && files < MAX_FILES_PER_MODEL) {
    const folder = pending.pop();
    if (!folder) break;
    let entries;
    try {
      entries = await readdir(folder, { withFileTypes: true });
    } catch (error) {
      // One unreadable folder must not hide every other model; report it on this model instead.
      if (!isMissing(error)) unreadable = true;
      continue;
    }
    for (const entry of entries) {
      if (++files > MAX_FILES_PER_MODEL) break;
      const child = join(folder, entry.name);
      if (entry.isDirectory()) {
        pending.push(child);
        continue;
      }
      // Hugging Face snapshots are links into blobs/; read their extensions here and sizes from blobs/.
      const format = Object.entries(weightFormats).find(([extension]) =>
        entry.name.endsWith(extension),
      )?.[1];
      if (format) formats.add(format);
      const counted =
        entry.isFile() ||
        // Newer hub caches link blobs to a shared store; count the target once, here.
        (entry.isSymbolicLink() && basename(folder) === "blobs");
      if (!counted) continue;
      try {
        const info = await stat(child);
        if (info.isFile()) sizeBytes += info.size;
      } catch (error) {
        if (!isMissing(error)) unreadable = true;
      }
    }
  }
  return {
    formats: [...formats].sort(),
    sizeBytes,
    weights: formats.size > 0,
    ...(unreadable
      ? { error: "Some files could not be read; size may be low." }
      : {}),
  };
};

const scan = async (
  directory: string,
  list: (directory: string) => Promise<{ id: string; path: string }[]>,
): Promise<DiskScan> => {
  let candidates;
  try {
    candidates = await list(directory);
  } catch (error) {
    if (isMissing(error))
      return { directory, found: false, models: [], truncated: false };
    return {
      directory,
      found: true,
      models: [],
      truncated: false,
      error:
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error.code === "EACCES" || error.code === "EPERM")
          ? "macOS denied access to this folder."
          : "The folder could not be read.",
    };
  }
  const models: DiskModel[] = [];
  for (const candidate of candidates.slice(0, MAX_MODELS))
    models.push({ ...candidate, ...(await describeFolder(candidate.path)) });
  return {
    directory,
    found: true,
    models: models.sort((a, b) => a.id.localeCompare(b.id)),
    truncated: candidates.length > MAX_MODELS,
  };
};

/** Hugging Face cache folders named models--owner--name. Datasets and spaces are skipped. */
export const scanHuggingFaceCache = (environment: Environment) =>
  scan(huggingFaceHubCache(environment), async (directory) =>
    (await readdir(directory, { withFileTypes: true }))
      .filter(
        (entry) => entry.isDirectory() && entry.name.startsWith("models--"),
      )
      .map((entry) => ({
        id: entry.name.slice("models--".length).split("--").join("/"),
        path: join(directory, entry.name),
      })),
  );

/** LM Studio's publisher/model folder layout. */
export const scanLmStudioFolder = async (
  environment: Environment,
): Promise<DiskScan> => {
  let directory: string;
  try {
    directory = await lmStudioModelsDirectory(environment);
  } catch {
    return {
      directory: join(environment.HOME ?? homedir(), ".lmstudio"),
      found: true,
      models: [],
      truncated: false,
      error: "LM Studio's settings could not be read.",
    };
  }
  return scan(directory, async (folder) => {
    const found: { id: string; path: string }[] = [];
    for (const publisher of await readdir(folder, { withFileTypes: true })) {
      if (!publisher.isDirectory() || publisher.name.startsWith(".")) continue;
      for (const model of await readdir(join(folder, publisher.name), {
        withFileTypes: true,
      }))
        if (model.isDirectory() && !model.name.startsWith("."))
          found.push({
            id: `${publisher.name}/${model.name}`,
            path: join(folder, publisher.name, model.name),
          });
      if (found.length > MAX_MODELS) break;
    }
    return found;
  });
};
