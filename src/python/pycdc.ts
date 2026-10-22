import { createHash } from "node:crypto";
import { access, constants, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * pycdc (Decompyle++) builds admitted for .pyc reconstruction. pycdc has no
 * releases and is built from source, so a build is admitted by the digest of
 * its exact executable after the F03 lane passed on it; any other digest is
 * reported as unavailable rather than run on trust.
 */
export const ADMITTED_PYCDC_BUILDS: readonly {
  readonly sha256: string;
  readonly version: string;
  readonly build: string;
}[] = [
  {
    sha256: "e0c7709354f051d0b76b29ff5677e6c10890f7e4c31c6c9d9a039873f6faab06",
    version: "b4289760970dbc399684f1e155ec6d1ea1cc787e",
    build: "zrax/pycdc at b4289760, built from source for macOS arm64",
  },
];

/** Conventional install locations; the first match on PATH is never used. */
const candidates = (): string[] => [
  join(homedir(), ".local/bin/pycdc"),
  "/opt/homebrew/bin/pycdc",
  "/usr/local/bin/pycdc",
  "/usr/bin/pycdc",
];

export interface ResolvedPycdc {
  readonly path: string;
  readonly sha256: string;
  readonly version: string;
  readonly build: string;
}

/** Why reconstruction cannot run here; reported, never guessed around. */
export class PycdcUnavailable extends Error {
  readonly _tag = "PycdcUnavailable";
}

const executable = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

let resolving: Promise<ResolvedPycdc> | null = null;

/** Locate an admitted pycdc executable; cached per process, retried after a failure. */
export const resolvePycdc = (): Promise<ResolvedPycdc> => {
  if (resolving === null) {
    resolving = locate();
    resolving.catch(() => {
      resolving = null;
    });
  }
  return resolving;
};

const locate = async (): Promise<ResolvedPycdc> => {
  const found: string[] = [];
  for (const candidate of candidates()) {
    if (!(await executable(candidate))) continue;
    const path = await realpath(candidate);
    const sha256 = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
    const admitted = ADMITTED_PYCDC_BUILDS.find(
      (build) => build.sha256 === sha256,
    );
    if (admitted === undefined) {
      found.push(`${path} (sha256 ${sha256})`);
      continue;
    }
    return { path, sha256, version: admitted.version, build: admitted.build };
  }
  throw new PycdcUnavailable(
    found.length === 0
      ? `pycdc is not installed at ${candidates().join(", ")}. Build zrax/pycdc and install the pycdc executable there; inspect_python_code still gives the bytecode.`
      : `No admitted pycdc build was found; ${found.join(", ")} ${found.length === 1 ? "is" : "are"} not admitted. Admitted: ${ADMITTED_PYCDC_BUILDS.map((build) => `${build.build} (sha256 ${build.sha256})`).join(", ")}.`,
  );
};
