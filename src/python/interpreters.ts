import { randomUUID } from "node:crypto";
import { access, constants, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { runOwnedCommand } from "../process/OwnedCommand.js";

/**
 * Installed CPython interpreters, found only at fixed install locations (never
 * the first `python` on PATH). An interpreter is used to parse source text
 * with its own `ast` module; it never imports or runs the target. macOS's
 * /usr/bin/python3 is a shim that can open an installer dialog, so the
 * developer-tools copy behind it is used only when xcode-select names one.
 */

export interface Interpreter {
  readonly path: string;
  readonly realpath: string;
  /** Feature release, e.g. "3.13". */
  readonly version: string;
  /** Full release, e.g. "3.13.16". */
  readonly release: string;
}

const MINORS = [9, 10, 11, 12, 13, 14, 15, 16];

const executable = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const developerDirectory = async (): Promise<string | null> => {
  if (process.platform !== "darwin") return null;
  try {
    const snapshot = await runOwnedCommand(
      {
        command: "/usr/bin/xcode-select",
        arguments: ["-p"],
        runId: randomUUID(),
        hostEnvironment: {},
      },
      { timeoutMs: 10_000, diagnosticBytes: 4096 },
    );
    const directory = snapshot.stdout.text.trim();
    return directory.startsWith("/") ? directory : null;
  } catch {
    return null;
  }
};

const candidates = async (): Promise<string[]> => {
  const paths: string[] = [];
  for (const minor of [...MINORS].reverse()) {
    const name = `python3.${String(minor)}`;
    paths.push(
      `/opt/homebrew/bin/${name}`,
      `/usr/local/bin/${name}`,
      `/Library/Frameworks/Python.framework/Versions/3.${String(minor)}/bin/${name}`,
      `/usr/bin/${name}`,
      join(homedir(), ".local/bin", name),
    );
  }
  const developer = await developerDirectory();
  if (developer !== null) paths.push(join(developer, "usr/bin/python3"));
  if (process.platform !== "darwin") paths.push("/usr/bin/python3");
  return paths;
};

/** Ask an interpreter for its release without importing anything but `sys`. */
const releaseOf = async (path: string): Promise<string | null> => {
  try {
    const snapshot = await runOwnedCommand(
      {
        command: path,
        arguments: [
          "-I",
          "-S",
          "-c",
          "import sys; print('%d.%d.%d' % sys.version_info[:3])",
        ],
        runId: randomUUID(),
        hostEnvironment: {},
      },
      { timeoutMs: 20_000, diagnosticBytes: 4096 },
    );
    const release = snapshot.stdout.text.trim();
    return /^3\.\d+\.\d+$/u.test(release) ? release : null;
  } catch {
    return null;
  }
};

let discovered: Promise<Interpreter[]> | null = null;

/**
 * Every distinct installed interpreter, newest release first; cached per
 * process. Not cancellable, so a cancelled call never caches a partial list.
 */
export const discoverInterpreters = (): Promise<Interpreter[]> => {
  if (discovered === null) {
    discovered = (async () => {
      const found = new Map<string, Interpreter>();
      for (const path of await candidates()) {
        if (!(await executable(path))) continue;
        const real = await realpath(path).catch(() => path);
        if (found.has(real)) continue;
        const release = await releaseOf(path);
        if (release === null) continue;
        found.set(real, {
          path,
          realpath: real,
          version: release.split(".").slice(0, 2).join("."),
          release,
        });
      }
      return [...found.values()].sort((left, right) =>
        right.release.localeCompare(left.release, "en", { numeric: true }),
      );
    })();
    discovered.catch(() => {
      discovered = null;
    });
  }
  return discovered;
};
