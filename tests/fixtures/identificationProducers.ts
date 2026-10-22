import { execFile } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { GZIP, TAR } from "./archiveProducers.js";

const run = promisify(execFile);

/** The real Info-ZIP `zip`, when the host has it. */
export const ZIP = await access("/usr/bin/zip").then(
  () => "/usr/bin/zip",
  () => null,
);

/** macOS tar adds AppleDouble members unless told not to. */
const TAR_ENVIRONMENT = { ...process.env, COPYFILE_DISABLE: "1" };

/** Zip `members` (relative to `cwd`) into `output` with the real zip. */
export const produceZip = async (
  cwd: string,
  output: string,
  members: readonly string[],
): Promise<string> => {
  if (ZIP === null) throw new Error("zip is not installed");
  await run(ZIP, ["-q", "-X", "-r", output, ...members], { cwd });
  return output;
};

/** Zip `members` without compression, so tests can change stored bytes. */
export const produceStoredZip = async (
  cwd: string,
  output: string,
  members: readonly string[],
): Promise<string> => {
  if (ZIP === null) throw new Error("zip is not installed");
  await run(ZIP, ["-q", "-X", "-0", output, ...members], { cwd });
  return output;
};

/** Tar and gzip `members` (relative to `cwd`) into `output` with the real tar. */
export const produceTarGz = async (
  cwd: string,
  output: string,
  members: readonly string[],
): Promise<string> => {
  await run(TAR, ["-czf", output, "-C", cwd, ...members], {
    env: TAR_ENVIRONMENT,
  });
  return output;
};

/** bundle.tar.gz holding app.zip (notes.json, second.json) and readme.md. */
export const produceNestedBundle = async (root: string): Promise<string> => {
  const stage = join(root, "stage");
  await mkdir(join(stage, "zipped"), { recursive: true });
  await writeFile(join(stage, "zipped", "notes.json"), '{"a": 1}\n');
  await writeFile(join(stage, "zipped", "second.json"), '{"b": 2}\n');
  await produceZip(join(stage, "zipped"), join(stage, "app.zip"), [
    "notes.json",
    "second.json",
  ]);
  await writeFile(join(stage, "readme.md"), "# Read me\n");
  const tar = join(root, "bundle.tar");
  await run(TAR, ["-cf", tar, "-C", stage, "app.zip", "readme.md"], {
    env: TAR_ENVIRONMENT,
  });
  if (GZIP === null) throw new Error("gzip is not installed");
  await run(GZIP, ["-n", "-f", tar]);
  return `${tar}.gz`;
};

/** A small pure-Python wheel built with the real zip; RECORD lists no digests. */
export const produceDemoWheel = async (root: string): Promise<string> => {
  const source = join(root, "wheel-src");
  await mkdir(join(source, "demo"), { recursive: true });
  await mkdir(join(source, "demo-1.2.0.dist-info"));
  await writeFile(join(source, "demo", "__init__.py"), "VALUE = 1\n");
  await writeFile(
    join(source, "demo-1.2.0.dist-info", "METADATA"),
    "Metadata-Version: 2.1\nName: demo\nVersion: 1.2.0\nSummary: A demo wheel\n",
  );
  await writeFile(
    join(source, "demo-1.2.0.dist-info", "WHEEL"),
    "Wheel-Version: 1.0\nGenerator: test\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
  );
  await writeFile(
    join(source, "demo-1.2.0.dist-info", "RECORD"),
    "demo/__init__.py,,\ndemo-1.2.0.dist-info/METADATA,,\ndemo-1.2.0.dist-info/WHEEL,,\ndemo-1.2.0.dist-info/RECORD,,\n",
  );
  return produceZip(source, join(root, "demo-1.2.0-py3-none-any.whl"), [
    "demo",
    "demo-1.2.0.dist-info",
  ]);
};
