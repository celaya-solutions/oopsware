import { createHash } from "node:crypto";
import {
  access,
  constants,
  readdir,
  readFile,
  realpath,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * ilspycmd builds admitted for .NET reconstruction. The tool is a folder of
 * assemblies run by `dotnet`, so a build is admitted by one SHA-256 over the
 * sorted `relative/path:sha256` lines of every file in that folder; a folder
 * with any other content is reported as unavailable rather than run.
 */
export const ADMITTED_ILSPYCMD_BUILDS: readonly {
  readonly sha256: string;
  readonly files: number;
  readonly version: string;
  readonly build: string;
}[] = [
  {
    sha256: "37f7db9d13aca7e1f345969fce6862c75c0fabefba36e6f8572f89202cc1ce16",
    files: 59,
    version: "9.1.0.7988",
    build: "ilspycmd 9.1.0.7988 (NuGet dotnet tool, net8.0)",
  },
];

/** The runtime major the admitted builds target (their runtimeconfig names net8.0). */
const RUNTIME_MAJOR = "8";

/** Conventional .NET install roots; `dotnet` on PATH is never used. */
const DOTNET_ROOTS = [
  "/opt/homebrew/opt/dotnet@8/libexec",
  "/opt/homebrew/opt/dotnet/libexec",
  "/usr/local/share/dotnet",
  "/usr/share/dotnet",
  "/usr/lib/dotnet",
];

/** Where `dotnet tool install --global ilspycmd` puts each version. */
const toolStore = () => join(homedir(), ".dotnet/tools/.store/ilspycmd");

export interface ResolvedIlspy {
  /** The folder holding ilspycmd.dll. */
  readonly directory: string;
  readonly dll: string;
  readonly files: number;
  readonly sha256: string;
  readonly version: string;
  readonly build: string;
  /** The `dotnet` host and the runtime folder it runs the tool with. */
  readonly dotnet: string;
  readonly runtimeVersion: string;
}

export class IlspyUnavailable extends Error {
  readonly _tag = "IlspyUnavailable";
}

const exists = async (path: string, mode = constants.R_OK) => {
  try {
    await access(path, mode);
    return true;
  } catch {
    return false;
  }
};

const subdirectories = async (path: string): Promise<string[]> => {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
};

/** Folders `<store>/<version>/ilspycmd/<version>/tools/<tfm>/any` holding ilspycmd.dll. */
const toolFolders = async (): Promise<string[]> => {
  const store = toolStore();
  const found: string[] = [];
  for (const version of await subdirectories(store)) {
    const tools = join(store, version, "ilspycmd", version, "tools");
    for (const framework of await subdirectories(tools)) {
      const folder = join(tools, framework, "any");
      if (await exists(join(folder, "ilspycmd.dll"))) found.push(folder);
    }
  }
  return found;
};

/** One digest over every regular file under the folder, by sorted relative path. */
export const folderDigest = async (
  folder: string,
): Promise<{ files: number; sha256: string }> => {
  const names = (await readdir(folder, { recursive: true })).map(String).sort();
  const lines: string[] = [];
  for (const name of names) {
    const path = join(folder, name);
    if (!(await stat(path)).isFile()) continue;
    lines.push(
      `${name}:${createHash("sha256")
        .update(await readFile(path))
        .digest("hex")}`,
    );
  }
  return {
    files: lines.length,
    sha256: createHash("sha256").update(lines.join("\n")).digest("hex"),
  };
};

/** A `dotnet` host with a Microsoft.NETCore.App runtime of the admitted major. */
const runtime = async (): Promise<{
  dotnet: string;
  version: string;
} | null> => {
  for (const root of DOTNET_ROOTS) {
    const dotnet = join(root, "dotnet");
    if (!(await exists(dotnet, constants.X_OK))) continue;
    const versions = (
      await subdirectories(join(root, "shared/Microsoft.NETCore.App"))
    ).filter((version) => version.split(".")[0] === RUNTIME_MAJOR);
    const newest = versions.sort((left, right) =>
      right.localeCompare(left, "en", { numeric: true }),
    )[0];
    if (newest !== undefined)
      return { dotnet: await realpath(dotnet), version: newest };
  }
  return null;
};

/**
 * Locate an admitted ilspycmd and a .NET runtime for it. Not cached: the tool
 * is a folder the user can change, so its digest is checked again for every
 * run (about 11 MB of hashing).
 */
export const resolveIlspy = (): Promise<ResolvedIlspy> => locate();

const locate = async (): Promise<ResolvedIlspy> => {
  const folders = await toolFolders();
  if (folders.length === 0)
    throw new IlspyUnavailable(
      `ilspycmd is not installed under ${toolStore()}. Install it with \`dotnet tool install --global ilspycmd --version 9.1.0.7988\`; inspect_managed_members still gives the metadata and IL hashes.`,
    );
  const found: string[] = [];
  for (const folder of folders) {
    const directory = await realpath(folder);
    const digest = await folderDigest(directory);
    const admitted = ADMITTED_ILSPYCMD_BUILDS.find(
      (build) => build.sha256 === digest.sha256 && build.files === digest.files,
    );
    if (admitted === undefined) {
      found.push(
        `${directory} (${String(digest.files)} files, sha256 ${digest.sha256})`,
      );
      continue;
    }
    const host = await runtime();
    if (host === null)
      throw new IlspyUnavailable(
        `ilspycmd ${admitted.version} needs a .NET ${RUNTIME_MAJOR} runtime, and none was found under ${DOTNET_ROOTS.join(", ")}.`,
      );
    return {
      directory,
      dll: join(directory, "ilspycmd.dll"),
      files: digest.files,
      sha256: digest.sha256,
      version: admitted.version,
      build: admitted.build,
      dotnet: host.dotnet,
      runtimeVersion: host.version,
    };
  }
  throw new IlspyUnavailable(
    `No admitted ilspycmd build was found; ${found.join(", ")} ${found.length === 1 ? "is" : "are"} not admitted. Admitted: ${ADMITTED_ILSPYCMD_BUILDS.map((build) => `${build.build} (${String(build.files)} files, sha256 ${build.sha256})`).join(", ")}.`,
  );
};

/** The folder holding the `dotnet` host; ILSpy finds framework references through it. */
export const dotnetDirectory = (tool: ResolvedIlspy) => dirname(tool.dotnet);
