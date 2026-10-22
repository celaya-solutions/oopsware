import { execFile } from "node:child_process";
import {
  access,
  chmod,
  constants,
  link,
  mkdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Real archive producers for F06 fixtures. Every archive is built by the
 * installed tool at test time; no binary fixture is committed.
 */
const firstExecutable = async (
  candidates: readonly string[],
): Promise<string | null> => {
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next conventional location.
    }
  }
  return null;
};

export const TAR = "/usr/bin/tar";
export const GZIP = await firstExecutable(["/usr/bin/gzip", "/bin/gzip"]);
export const XZ = await firstExecutable([
  "/usr/bin/xz",
  "/bin/xz",
  "/usr/local/bin/xz",
  "/opt/homebrew/bin/xz",
]);
export const SEVEN_ZIP = await firstExecutable([
  "/opt/homebrew/bin/7zz",
  "/usr/local/bin/7zz",
  "/usr/bin/7zz",
  "/usr/bin/7z",
]);
export const BSDTAR = await firstExecutable([
  "/usr/bin/bsdtar",
  "/usr/local/bin/bsdtar",
  "/opt/homebrew/bin/bsdtar",
  "/opt/homebrew/opt/libarchive/bin/bsdtar",
]);

/** Whether /usr/bin/tar is libarchive bsdtar (macOS) rather than GNU tar. */
const tarIsBsd = async (): Promise<boolean> => {
  const { stdout } = await run(TAR, ["--version"]);
  return stdout.includes("bsdtar");
};

export const TAR_IS_BSD = await tarIsBsd();

/** macOS tar otherwise adds AppleDouble `._` members for extended attributes. */
const TAR_ENVIRONMENT = { ...process.env, COPYFILE_DISABLE: "1" };

/** Tar header dialects both bsdtar and GNU tar can write. */
export type TarDialect = "ustar" | "pax" | "gnu";

const dialectArguments = (dialect: TarDialect): string[] =>
  TAR_IS_BSD
    ? ["--format", dialect === "gnu" ? "gnutar" : dialect]
    : [`--format=${dialect}`];

export const LONG_NAME = `${"long-directory-name-".repeat(6)}/${"file-with-a-long-name-".repeat(4)}.txt`;
export const UNICODE_NAME = "café-日本.txt";

/** A source tree with nested, long, Unicode, executable, and linked members. */
export const createArchiveSourceTree = async (
  root: string,
  options: { readonly links?: boolean } = {},
): Promise<{ readonly files: Readonly<Record<string, string>> }> => {
  const files: Record<string, string> = {
    "a.txt": "alpha\n",
    "dir/b.txt": "bravo in a directory\n",
    [UNICODE_NAME]: "unicode name\n",
    [LONG_NAME]: "long name\n",
    "tool.sh": "#!/bin/sh\necho tool\n",
  };
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(root, name, ".."), { recursive: true });
    await writeFile(join(root, name), text);
  }
  await chmod(join(root, "tool.sh"), 0o755);
  if (options.links === true) {
    await symlink("../outside/secret", join(root, "escape-link"));
    await link(join(root, "a.txt"), join(root, "hard.txt"));
  }
  return { files };
};

/** Run the system tar to create an archive of `members` under `root`. */
export const produceTar = async (
  root: string,
  output: string,
  members: readonly string[],
  dialect: TarDialect,
): Promise<void> => {
  await run(
    TAR,
    [...dialectArguments(dialect), "-cf", output, "-C", root, ...members],
    {
      env: TAR_ENVIRONMENT,
    },
  );
};

/** Append members to an existing tar, producing duplicate names when repeated. */
export const appendTar = async (
  root: string,
  archive: string,
  members: readonly string[],
): Promise<void> => {
  await run(TAR, ["-rf", archive, "-C", root, ...members], {
    env: TAR_ENVIRONMENT,
  });
};

/** Compress a file in place with the real gzip; `-n` omits the stored name. */
export const produceGzip = async (
  path: string,
  options: { readonly storeName?: boolean } = {},
): Promise<string> => {
  if (GZIP === null) throw new Error("gzip is not installed");
  await run(GZIP, [options.storeName === false ? "-n" : "-N", "-f", path]);
  return `${path}.gz`;
};

/** Compress a file in place with the real xz. */
export const produceXz = async (path: string): Promise<string> => {
  if (XZ === null) throw new Error("xz is not installed");
  await run(XZ, ["-z", "-f", path]);
  return `${path}.xz`;
};

/** Build a 7z archive with the real 7-Zip, optionally with a password. */
export const produce7z = async (
  root: string,
  output: string,
  members: readonly string[],
  options: {
    readonly password?: string;
    readonly encryptHeaders?: boolean;
    /** Split into volumes of this 7-Zip size, such as `8k`. */
    readonly volumeBytes?: string;
  } = {},
): Promise<void> => {
  if (SEVEN_ZIP === null) throw new Error("7-Zip is not installed");
  await run(
    SEVEN_ZIP,
    [
      "a",
      "-bd",
      "-y",
      ...(options.password === undefined ? [] : [`-p${options.password}`]),
      ...(options.encryptHeaders === true ? ["-mhe=on"] : []),
      ...(options.volumeBytes === undefined
        ? []
        : [`-v${options.volumeBytes}`]),
      output,
      ...members,
    ],
    { cwd: root },
  );
};
