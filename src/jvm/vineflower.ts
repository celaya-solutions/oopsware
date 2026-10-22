import { createHash, randomUUID } from "node:crypto";
import {
  access,
  constants,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { platform } from "node:os";

import { runOwnedCommand } from "../process/OwnedCommand.js";
import { DecodeBudget, ZipView } from "../artifacts/zipMemberView.js";
import { attribute, parseManifest } from "./jarMetadata.js";

/**
 * Vineflower builds admitted for JVM reconstruction. A build is admitted only
 * after its exact jar passed the F02 fixtures and lane; a different digest is
 * reported as unavailable rather than run on trust.
 */
export const ADMITTED_VINEFLOWER_BUILDS: readonly {
  readonly sha256: string;
  readonly version: string;
  readonly build: string;
}[] = [
  {
    sha256: "a72cdc807e6e539eb467906f2576569eda618a57e6701c32021a5018e62932af",
    version: "1.12.0",
    build: "Homebrew vineflower 1.12.0 (built from source)",
  },
];

/** Conventional install locations; the first match on PATH is never used. */
const JAR_CANDIDATES = [
  "/opt/homebrew/opt/vineflower/libexec/vineflower.jar",
  "/usr/local/opt/vineflower/libexec/vineflower.jar",
  "/usr/share/java/vineflower.jar",
];

/** Vineflower 1.12 needs Java 17 or newer to run. */
const MINIMUM_JAVA = 17;

const javaCandidates = (): string[] => [
  "/opt/homebrew/opt/openjdk/bin/java",
  "/opt/homebrew/opt/openjdk@21/bin/java",
  "/opt/homebrew/opt/openjdk@17/bin/java",
  "/usr/local/opt/openjdk/bin/java",
  "/usr/lib/jvm/default-java/bin/java",
  "/usr/lib/jvm/java-21-openjdk-amd64/bin/java",
  "/usr/lib/jvm/java-17-openjdk-amd64/bin/java",
  // macOS /usr/bin/java is a stub that can open an install dialog.
  ...(platform() === "darwin" ? [] : ["/usr/bin/java"]),
];

export interface ResolvedVineflower {
  readonly jar: string;
  readonly jarSha256: string;
  readonly version: string;
  readonly build: string;
  readonly java: string;
  readonly javaVersion: string;
}

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

const executable = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const readable = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
};

/** First line of `java -version` (printed on stderr) and its feature release. */
const javaVersion = async (
  java: string,
  signal?: AbortSignal,
): Promise<{ line: string; release: number } | null> => {
  try {
    const snapshot = await runOwnedCommand(
      {
        command: java,
        arguments: ["-version"],
        runId: randomUUID(),
        hostEnvironment: {},
        ...(signal === undefined ? {} : { signal }),
      },
      { timeoutMs: 20_000, diagnosticBytes: 4096 },
      signal === undefined ? {} : { signal },
    );
    const line =
      `${snapshot.stderr.text}\n${snapshot.stdout.text}`
        .split("\n")
        .map((entry) => entry.trim())
        .find((entry) => entry.length > 0) ?? "";
    const release = Number(/version "(?:1\.)?(\d+)/u.exec(line)?.[1]);
    return Number.isInteger(release) ? { line, release } : null;
  } catch {
    return null;
  }
};

/** Why reconstruction cannot run here; reported, never guessed around. */
export class VineflowerUnavailable extends Error {
  readonly _tag = "VineflowerUnavailable";
}

const resolving = new Map<string, Promise<ResolvedVineflower>>();

/** Locate an admitted Vineflower jar and a Java runtime for it; cached per process. */
export const resolveVineflower = (
  signal?: AbortSignal,
): Promise<ResolvedVineflower> => {
  const key = "vineflower";
  let pending = resolving.get(key);
  if (pending === undefined) {
    pending = locate(signal);
    resolving.set(key, pending);
    pending.catch(() => resolving.delete(key));
  }
  return pending;
};

const locate = async (signal?: AbortSignal): Promise<ResolvedVineflower> => {
  const found: string[] = [];
  for (const candidate of JAR_CANDIDATES) {
    if (!(await readable(candidate))) continue;
    const jar = await realpath(candidate);
    const bytes = await readFile(jar);
    const digest = sha256(bytes);
    const admitted = ADMITTED_VINEFLOWER_BUILDS.find(
      (build) => build.sha256 === digest,
    );
    if (admitted === undefined) {
      found.push(`${jar} (sha256 ${digest})`);
      continue;
    }
    // The version comes from the jar's manifest, read as data.
    const zip = await ZipView.open(bytes);
    let version: string | null = null;
    try {
      version = attribute(
        parseManifest(
          await zip.read(
            "META-INF/MANIFEST.MF",
            new DecodeBudget(1024 ** 2, 1024 ** 2),
          ),
        ).main,
        "Implementation-Version",
      );
    } finally {
      await zip.close();
    }
    if (version !== admitted.version) {
      found.push(`${jar} (manifest version ${version ?? "missing"})`);
      continue;
    }
    for (const java of javaCandidates()) {
      if (!(await executable(java))) continue;
      const probed = await javaVersion(java, signal);
      if (probed === null || probed.release < MINIMUM_JAVA) continue;
      return {
        jar,
        jarSha256: digest,
        version,
        build: admitted.build,
        java: await realpath(java),
        javaVersion: probed.line,
      };
    }
    throw new VineflowerUnavailable(
      `Vineflower ${version} is installed at ${jar}, but no Java ${String(MINIMUM_JAVA)}+ runtime was found at the fixed locations.`,
    );
  }
  throw new VineflowerUnavailable(
    found.length === 0
      ? `Vineflower is not installed (looked for ${JAR_CANDIDATES.join(", ")}). Install it (for example \`brew install vineflower\`) to reconstruct Java source.`
      : `Vineflower was found but is not an admitted build: ${found.join("; ")}. Admitted: ${ADMITTED_VINEFLOWER_BUILDS.map((build) => `${build.build} ${build.sha256}`).join("; ")}.`,
  );
};

/** Admit the exact private copy used by Java, even after a cached discovery. */
export const stageVineflower = async (
  tool: ResolvedVineflower,
  destination: string,
): Promise<void> => {
  try {
    const bytes = await readFile(tool.jar);
    const digest = sha256(bytes);
    if (
      digest !== tool.jarSha256 ||
      !ADMITTED_VINEFLOWER_BUILDS.some((build) => build.sha256 === digest)
    )
      throw new Error("the jar changed or is not admitted");
    await writeFile(destination, bytes, { flag: "wx" });
  } catch (cause) {
    throw new VineflowerUnavailable(
      `Cannot verify Vineflower for this run: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
};
