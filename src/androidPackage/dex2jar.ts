import { createHash, randomUUID } from "node:crypto";
import {
  access,
  constants,
  mkdir,
  readdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { delimiter, join } from "node:path";

import { OwnedCommandFailure } from "../process/OwnedCommand.js";

import { withDecompilerScratch } from "../jvm/decompilerScratch.js";
/**
 * dex2jar installs admitted for DEX to class-file conversion. dex2jar ships
 * as a directory of jars run on one classpath, so an install is admitted by
 * the SHA-256 of its whole jar set: the sorted `name:sha256` line of every
 * `*.jar` in lib/, joined with newlines. Any other set is reported as
 * unavailable with what was found, never run on trust.
 */
export const ADMITTED_DEX2JAR_SETS: readonly {
  readonly sha256: string;
  readonly version: string;
  readonly build: string;
  readonly jars: number;
}[] = [
  {
    sha256: "9c4a0601d09147826fff8c7e1af7d489cd6d23832d9df7be95bbf6d1e50f9fae",
    version: "2.4",
    build: "Homebrew dex2jar 2.4 (pxb1988/dex2jar v2.4, 23 jars)",
    jars: 23,
  },
];

/** Conventional install locations of dex2jar's lib/ directory; PATH is never searched. */
const LIB_CANDIDATES = [
  "/opt/homebrew/opt/dex2jar/libexec/lib",
  "/usr/local/opt/dex2jar/libexec/lib",
  "/usr/share/dex2jar/lib",
  "/usr/share/java/dex2jar",
];

const MAIN_CLASS = "com.googlecode.dex2jar.tools.Dex2jarCmd";
/** `-d` keeps debug info (local names, lines); `-f` lets it write into the scratch. */
export const DEX2JAR_OPTIONS = ["-f", "-d"];
const OUTPUT_BYTES = 1024 ** 2;
/** An error report past this size is not read; the check says so. */
const MAX_ERROR_FILE_BYTES = 64 * 1024 ** 2;

export interface ResolvedDex2jar {
  readonly lib: string;
  readonly jars: readonly string[];
  readonly setSha256: string;
  readonly version: string;
  readonly build: string;
}

/** Why conversion cannot run here; reported, never guessed around. */
export class Dex2jarUnavailable extends Error {
  readonly _tag = "Dex2jarUnavailable";
}

const readable = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
};

const sha256 = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");

/** Digest of a lib/ directory's jar set, as ADMITTED_DEX2JAR_SETS records it. */
export const jarSetDigest = async (
  lib: string,
): Promise<{ sha256: string; jars: string[] }> => {
  const names = (await readdir(lib, { withFileTypes: true }))
    .filter((entry) => entry.name.endsWith(".jar"))
    .map((entry) => entry.name)
    .sort();
  const lines: string[] = [];
  for (const name of names) {
    const file = join(lib, name);
    try {
      if (!(await stat(file)).isFile()) throw new Error("not a regular file");
      lines.push(`${name}:${sha256(await readFile(file))}`);
    } catch (cause) {
      throw new Dex2jarUnavailable(
        `Cannot read dex2jar jar ${file}: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }
  }
  return {
    sha256: sha256(lines.join("\n")),
    jars: names.map((name) => join(lib, name)),
  };
};

const resolving = new Map<string, Promise<ResolvedDex2jar>>();

/** Locate an admitted dex2jar jar set; cached per process. */
export const resolveDex2jar = (): Promise<ResolvedDex2jar> => {
  const key = "dex2jar";
  let pending = resolving.get(key);
  if (pending === undefined) {
    pending = locate();
    resolving.set(key, pending);
    pending.catch(() => resolving.delete(key));
  }
  return pending;
};

const locate = async (): Promise<ResolvedDex2jar> => {
  const found: string[] = [];
  for (const candidate of LIB_CANDIDATES) {
    if (!(await readable(candidate))) continue;
    const lib = await realpath(candidate);
    const digest = await jarSetDigest(lib);
    const admitted = ADMITTED_DEX2JAR_SETS.find(
      (set) => set.sha256 === digest.sha256,
    );
    if (admitted === undefined) {
      found.push(
        `${lib} (${String(digest.jars.length)} jars, set sha256 ${digest.sha256})`,
      );
      continue;
    }
    return {
      lib,
      jars: digest.jars,
      setSha256: digest.sha256,
      version: admitted.version,
      build: admitted.build,
    };
  }
  throw new Dex2jarUnavailable(
    found.length === 0
      ? `dex2jar is not installed (looked for ${LIB_CANDIDATES.join(", ")}). Install it (for example \`brew install dex2jar\`) to decompile DEX classes.`
      : `dex2jar was found but is not an admitted install: ${found.join("; ")}. Admitted: ${ADMITTED_DEX2JAR_SETS.map((set) => `${set.build} ${set.sha256}`).join("; ")}.`,
  );
};

/** A method dex2jar could not translate; its body in the JAR only throws. */
export interface Dex2jarFailure {
  /** Type descriptor, e.g. Lcom/example/Main; */
  readonly owner: string;
  readonly name: string;
  readonly descriptor: string;
}

export interface Dex2jarConversion {
  readonly jar: Uint8Array;
  /** Null when dex2jar wrote no error report (nothing failed). */
  readonly errors: {
    readonly methods: readonly Dex2jarFailure[];
    /** Whole-file failures dex2jar counted ("There are N fails."). */
    readonly fileFailures: number;
  } | null;
  /** Set when the error report exists but could not be read. */
  readonly errorsUnread: string | null;
  readonly messages: readonly string[];
}

/** Copy first, then admit the exact bytes Java will read, including the complete jar set. */
export const stageDex2jar = async (
  tool: ResolvedDex2jar,
  destination: string,
): Promise<string[]> => {
  try {
    await mkdir(destination);
    const names = (await readdir(tool.lib)).filter((name) =>
      name.endsWith(".jar"),
    );
    for (const name of names) {
      const file = join(tool.lib, name);
      if (!(await stat(file)).isFile())
        throw new Error(`${file} is not a regular file`);
      await writeFile(join(destination, name), await readFile(file), {
        flag: "wx",
      });
    }
    const digest = await jarSetDigest(destination);
    if (
      digest.sha256 !== tool.setSha256 ||
      !ADMITTED_DEX2JAR_SETS.some((set) => set.sha256 === digest.sha256)
    )
      throw new Error("the jar set changed or is not admitted");
    return digest.jars;
  } catch (cause) {
    throw new Dex2jarUnavailable(
      `Cannot verify dex2jar for this run: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
};
const METHOD_LINE = /^(L[^;]+;)->([^(]+)(\(.*)$/u;

/** dex2jar's text error report: each failed method follows a `===== N =====` line. */
export const parseDex2jarErrors = (
  text: string,
): NonNullable<Dex2jarConversion["errors"]> => {
  const lines = text.split(/\r?\n/u);
  const methods: Dex2jarFailure[] = [];
  for (let index = 0; index + 1 < lines.length; index += 1) {
    if (!/^=+ \d+ =+$/u.test(lines[index] ?? "")) continue;
    const match = METHOD_LINE.exec(lines[index + 1] ?? "");
    if (match?.[1] !== undefined && match[2] !== undefined && match[3])
      methods.push({ owner: match[1], name: match[2], descriptor: match[3] });
  }
  const fails = /^There are (\d+) fails\.$/mu.exec(text);
  return { methods, fileFailures: Number(fails?.[1] ?? 0) };
};

/** dex2jar did not leave a usable JAR; `reason` follows the owned-process outcome. */
export class Dex2jarRunFailure extends Error {
  readonly _tag = "Dex2jarRunFailure";
  constructor(
    readonly reason: OwnedCommandFailure["reason"] | "no-output",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** Convert one DEX file to a JAR in a private scratch that is removed afterwards. */
export const convertDex = async (request: {
  readonly dex: Uint8Array;
  readonly tool: ResolvedDex2jar;
  readonly java: string;
  readonly heapMib: number;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | undefined;
}): Promise<Dex2jarConversion> => {
  const { tool, signal } = request;
  return withDecompilerScratch("dex2jar", async (scratch, run) => {
    const scrub = (text: string) => text.replaceAll(scratch, "<scratch>");
    const jars = await stageDex2jar(tool, join(scratch, "tool"));
    await mkdir(join(scratch, "home"));
    await mkdir(join(scratch, "tmp"));
    const input = join(scratch, "classes.dex");
    const output = join(scratch, "classes.jar");
    const errorFile = join(scratch, "errors.txt");
    await writeFile(input, request.dex, { flag: "wx" });
    const snapshot = await run(
      {
        command: request.java,
        arguments: [
          `-Xmx${String(request.heapMib)}m`,
          "-XX:+UseSerialGC",
          "-Djava.awt.headless=true",
          `-Duser.home=${join(scratch, "home")}`,
          `-Djava.io.tmpdir=${join(scratch, "tmp")}`,
          "-classpath",
          jars.join(delimiter),
          MAIN_CLASS,
          ...DEX2JAR_OPTIONS,
          "-o",
          output,
          "-e",
          errorFile,
          input,
        ],
        runId: randomUUID(),
        cwd: scratch,
        // No inherited JAVA_TOOL_OPTIONS, classpath or agent settings reach dex2jar.
        hostEnvironment: {},
        ...(signal === undefined ? {} : { signal }),
      },
      { timeoutMs: request.timeoutMs, diagnosticBytes: OUTPUT_BYTES },
      signal === undefined ? {} : { signal },
    ).catch((cause: unknown) => {
      if (
        !(cause instanceof OwnedCommandFailure) ||
        cause.processError !== undefined
      )
        throw new Dex2jarUnavailable(
          `Cannot start dex2jar with ${request.java}: ${scrub(cause instanceof Error ? cause.message : String(cause))}`,
          { cause },
        );
      const stderr = scrub(
        cause.snapshot?.stderr.text.trim().split("\n").slice(-3).join(" ") ??
          "",
      );
      throw new Dex2jarRunFailure(
        cause.reason,
        cause.reason === "process"
          ? `dex2jar exited with code ${String(cause.snapshot?.exitCode ?? "unknown")}${stderr === "" ? "" : `: ${stderr}`}`
          : `dex2jar stopped (${cause.reason}).`,
        { cause },
      );
    });
    const messages = `${snapshot.stderr.text}\n${snapshot.stdout.text}`
      .split("\n")
      .map((line) => scrub(line.trim()))
      .filter((line) => line.length > 0 && !line.startsWith("dex2jar "))
      .slice(0, 200);
    let jar: Uint8Array;
    try {
      jar = await readFile(output);
    } catch {
      throw new Dex2jarRunFailure(
        "no-output",
        `dex2jar wrote no JAR${messages.length > 0 ? `: ${messages.slice(0, 3).join(" ")}` : "."}`,
      );
    }
    let errors: Dex2jarConversion["errors"] = null;
    let errorsUnread: string | null = null;
    const size = await stat(errorFile).then(
      (info) => info.size,
      () => null,
    );
    if (size !== null && size > MAX_ERROR_FILE_BYTES)
      errorsUnread = `dex2jar's error report is ${String(size)} bytes, over the ${String(MAX_ERROR_FILE_BYTES)} read limit.`;
    else if (size !== null)
      errors = parseDex2jarErrors(await readFile(errorFile, "utf8"));
    return { jar, errors, errorsUnread, messages };
  });
};
