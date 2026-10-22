import { createHash } from "node:crypto";
import { access, constants, readFile, realpath } from "node:fs/promises";
import { platform } from "node:os";
import { dirname, join } from "node:path";

/**
 * wabt `wasm2c` builds admitted for WebAssembly-to-C translation. A build is
 * admitted by the digest of its exact executable after the F01 fixtures and
 * lane passed on it; any other digest is reported as unavailable rather than
 * run on trust.
 */
export const ADMITTED_WASM2C_BUILDS: readonly {
  readonly sha256: string;
  readonly version: string;
  readonly build: string;
}[] = [
  {
    sha256: "b87264b60f879bd0162ffdb054e993dace984e96e81ad3de4a0777b5ec7e22bf",
    version: "1.0.42",
    build: "Homebrew wabt 1.0.42_1 for macOS arm64",
  },
];

/** Conventional install locations; the first match on PATH is never used. */
const CANDIDATES = [
  "/opt/homebrew/bin/wasm2c",
  "/usr/local/bin/wasm2c",
  "/usr/bin/wasm2c",
];

export interface ResolvedWasm2c {
  readonly path: string;
  readonly sha256: string;
  readonly version: string;
  readonly build: string;
  /** wabt's runtime headers (`wasm-rt.h`) next to this build, when present. */
  readonly include: string | null;
}

/** Why translation cannot run here; reported, never guessed around. */
export class Wasm2cUnavailable extends Error {
  readonly _tag = "Wasm2cUnavailable";
}

const can = async (path: string, mode: number): Promise<boolean> => {
  try {
    await access(path, mode);
    return true;
  } catch {
    return false;
  }
};

let resolving: Promise<ResolvedWasm2c> | null = null;

/** Locate an admitted wasm2c executable; cached per process, retried after a failure. */
export const resolveWasm2c = (): Promise<ResolvedWasm2c> => {
  if (resolving === null) {
    resolving = locate();
    resolving.catch(() => {
      resolving = null;
    });
  }
  return resolving;
};

const locate = async (): Promise<ResolvedWasm2c> => {
  const found: string[] = [];
  for (const candidate of CANDIDATES) {
    if (!(await can(candidate, constants.X_OK))) continue;
    const path = await realpath(candidate);
    const sha256 = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
    const admitted = ADMITTED_WASM2C_BUILDS.find(
      (build) => build.sha256 === sha256,
    );
    if (admitted === undefined) {
      found.push(`${path} (sha256 ${sha256})`);
      continue;
    }
    // wabt installs its runtime headers at <prefix>/include beside <prefix>/bin.
    const include = join(dirname(dirname(path)), "include");
    return {
      path,
      sha256,
      version: admitted.version,
      build: admitted.build,
      include: (await can(join(include, "wasm-rt.h"), constants.R_OK))
        ? include
        : null,
    };
  }
  throw new Wasm2cUnavailable(
    found.length === 0
      ? `wasm2c is not installed at ${CANDIDATES.join(", ")}. Install wabt (brew install wabt); convert_wasm_to_text still gives the WAT.`
      : `No admitted wasm2c build was found; ${found.join(", ")} ${found.length === 1 ? "is" : "are"} not admitted. Admitted: ${ADMITTED_WASM2C_BUILDS.map((build) => `${build.build} (sha256 ${build.sha256})`).join(", ")}.`,
  );
};

/**
 * clang builds that find the system headers with an empty environment. The
 * macOS /usr/bin/clang shim is used only when the Command Line Tools or
 * Xcode are installed, since otherwise it opens an install dialog.
 */
export const findClang = async (): Promise<string | null> => {
  const darwinShim =
    (await can(
      "/Library/Developer/CommandLineTools/usr/bin/clang",
      constants.X_OK,
    )) ||
    (await can(
      "/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang",
      constants.X_OK,
    ));
  for (const candidate of [
    "/opt/homebrew/opt/llvm/bin/clang",
    "/usr/local/opt/llvm/bin/clang",
    ...(platform() !== "darwin" || darwinShim ? ["/usr/bin/clang"] : []),
  ])
    if (await can(candidate, constants.X_OK)) return candidate;
  return null;
};
