import { open, realpath, stat, readdir } from "node:fs/promises";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { isUtf8 } from "node:buffer";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createDirectAnalysis } from "../composition/directAnalysis.js";
import { createLogger } from "../logger.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { WebFailure } from "./WebFailure.js";
import { resolveAppBundleExecutable } from "../application/AppBundleExecutable.js";

const PAGE_BYTES = 65_536;
const DIRECTORY_PAGE = 300;
const logger = createLogger("cli", "silent");

/** Browser-facing file views; every read is scoped to an explicit local path. */
export class Workspace {
  #analysis: ReturnType<typeof createDirectAnalysis>;
  constructor(environment: Readonly<Record<string, string | undefined>>) {
    this.#analysis = createDirectAnalysis(environment);
  }

  async browse(input: string, offset = 0) {
    const path = await realpath(expandPath(input));
    const info = await stat(path);
    if (!info.isDirectory())
      throw new WebFailure(
        400,
        "not_directory",
        "Choose a folder to browse, or use Open path to open a file.",
      );
    const all = (await readdir(path, { withFileTypes: true })).sort(
      (a, b) =>
        Number(b.isDirectory()) - Number(a.isDirectory()) ||
        a.name.localeCompare(b.name),
    );
    const entries = await Promise.all(
      all.slice(offset, offset + DIRECTORY_PAGE).map(async (entry) => {
        let directory = entry.isDirectory();
        if (entry.isSymbolicLink())
          directory =
            (
              await stat(join(path, entry.name)).catch(() => undefined)
            )?.isDirectory() ?? false;
        return {
          name: entry.name,
          path: join(path, entry.name),
          directory,
          application: directory && /\.app$/i.test(entry.name),
        };
      }),
    );
    return {
      path,
      parent: dirname(path),
      entries,
      total: all.length,
      offset,
      nextOffset:
        offset + entries.length < all.length ? offset + entries.length : null,
    };
  }

  async view(input: string, offset = 0) {
    const path = await realpath(expandPath(input));
    const info = await stat(path);
    if (!info.isFile() && !info.isDirectory())
      throw new WebFailure(
        400,
        "unsupported_file",
        "Open a regular file or folder. Devices and sockets are not readable in this interface.",
      );
    const base = {
      name: basename(path),
      path,
      originalPath: input,
      directory: info.isDirectory(),
      application: info.isDirectory() && /\.app$/i.test(path),
      size: info.size,
      modified: info.mtime.toISOString(),
    };
    let executablePath: string | undefined;
    if (base.application) {
      const bundle = await resolveAppBundleExecutable(path);
      if (!bundle.ok)
        return {
          ...base,
          preview: null,
          applicationError: projectAnalysisError(bundle.error),
        };
      executablePath = bundle.value.executable;
    } else if (info.isDirectory()) return { ...base, preview: null };
    const handle = await open(executablePath ?? path, "r");
    try {
      const current = await handle.stat();
      if (!current.isFile())
        throw new WebFailure(
          400,
          "file_changed",
          "The selected path is no longer a regular file.",
        );
      const buffer = Buffer.alloc(
        Math.min(PAGE_BYTES, Math.max(0, current.size - offset)),
      );
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      const bytes = buffer.subarray(0, bytesRead);
      const text =
        isUtf8(bytes) && !bytes.includes(0) ? bytes.toString("utf8") : null;
      const strings = [
        ...bytes.toString("latin1").matchAll(/[\x20-\x7e]{4,}/g),
      ].map((match) => ({ offset: offset + match.index, text: match[0] }));
      return {
        ...base,
        ...(executablePath === undefined ? {} : { executablePath }),
        size: current.size,
        preview: {
          offset,
          bytes: bytesRead,
          hasMore: offset + bytesRead < current.size,
          text,
          hex: bytes.toString("hex"),
          strings,
        },
      };
    } finally {
      await handle.close();
    }
  }

  async inspect(path: string) {
    const canonical = await realpath(expandPath(path));
    return this.#analysis.runProviderAnalysis(
      canonical,
      "inspect_artifact",
      { integrity_policy: "record-and-continue" },
      logger,
    );
  }

  async analyze(
    path: string,
    mode: "binary" | "javascript",
    signal: AbortSignal,
  ) {
    const canonical = await realpath(expandPath(path));
    if (mode === "javascript") {
      const scope = new ArtifactResourceScope();
      try {
        // Lazy so the CLI keeps JavaScript analysis in its own startup chunk.
        const { analyzeJavaScriptApplication } =
          await import("../application/javascript/JavaScriptApplicationService.js");
        const result = await analyzeJavaScriptApplication(
          { input_path: canonical, integrity_policy: "record-and-continue" },
          scope,
          { signal },
        );
        return result.ok ? result.value : projectAnalysisError(result.error);
      } finally {
        await scope.close();
      }
    }
    return this.#analysis.runDirectAnalysis(
      canonical,
      "binary_overview",
      {},
      { logger },
    );
  }
}
const expandPath = (path: string): string =>
  path === "~"
    ? homedir()
    : path.startsWith("~/")
      ? join(homedir(), path.slice(2))
      : resolve(path);
