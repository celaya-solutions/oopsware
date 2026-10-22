import type { BigIntStats } from "node:fs";
import { lstat, readlink, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import { resolveTreePath } from "../../domain/apple/dyldPaths.js";
import {
  dylibResolutionInputSchema,
  dylibResolutionResultSchema,
  traceDylibLoading,
  type DylibResolutionResult,
  type DylibTreeEntry,
  type DylibTreeView,
  type MachoImageFacts,
} from "../../domain/apple/dylibResolution.js";
import { projectInputIssues } from "../../domain/inputIssueProjection.js";
import { ArtifactReaderFailure } from "../ArtifactReader.js";
import { DirectoryArtifactReader } from "../DirectoryArtifactReader.js";
import { consumeWithOrderedReads } from "../OrderedReads.js";
import {
  DylibFileAccess,
  classifyDylibReadFailure,
} from "./DylibFileAccess.js";
import { ArtifactResourceScope } from "../ArtifactResourceScope.js";
import { assertArtifactReadActive } from "../ArtifactFileOperation.js";

const OPERATION = "trace_dylib_resolution";
/** Concurrent four-byte magic reads while enumerating bundle roots. */
const MAGIC_READ_CONCURRENCY = 8;

/** Lazily probed, symlink-preserving view of one analyzed directory. */
class FilesystemTreeView implements DylibTreeView {
  readonly #entries = new Map<string, Promise<DylibTreeEntry | undefined>>();
  readonly #images = new Map<string, Promise<MachoImageFacts>>();
  readonly #identities = new Map<string, BigIntStats>();

  constructor(
    private readonly root: string,
    private readonly files: DylibFileAccess,
    private readonly signal?: AbortSignal,
  ) {}

  entry(path: string): Promise<DylibTreeEntry | undefined> {
    const cached = this.#entries.get(path);
    if (cached !== undefined) return cached;
    const pending = this.#readEntry(path);
    this.#entries.set(path, pending);
    return pending;
  }

  image(path: string): Promise<MachoImageFacts> {
    const cached = this.#images.get(path);
    if (cached !== undefined) return cached;
    const pending = this.files
      .image(join(this.root, path))
      .then(({ facts, identity }) => {
        this.#identities.set(path, identity);
        return facts;
      });
    this.#images.set(path, pending);
    return pending;
  }

  /** Identity of the file whose header bytes `image()` parsed. */
  identity(path: string): BigIntStats | undefined {
    return this.#identities.get(path);
  }

  async #readEntry(path: string): Promise<DylibTreeEntry | undefined> {
    assertArtifactReadActive(this.signal);
    const absolute = join(this.root, path);
    try {
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink())
        return { kind: "symlink", target: await readlink(absolute) };
      if (metadata.isDirectory()) return { kind: "directory" };
      return metadata.isFile() ? { kind: "file" } : undefined;
    } catch (cause: unknown) {
      if (missing(cause)) return undefined;
      throw cause;
    }
  }
}

/** Resolve dyld load paths for the active Mach-O or every executable in its bundle. */
export const traceDylibResolution = async (options: {
  readonly rootPath: string;
  readonly targetPath: string;
  readonly targetSha256: string;
  readonly enumerateRoots: boolean;
  readonly parameters: unknown;
  readonly resourceScope?: ArtifactResourceScope;
  readonly signal?: AbortSignal;
}): Promise<DylibResolutionResult> => {
  const parsed = dylibResolutionInputSchema.safeParse(options.parameters);
  if (!parsed.success)
    throw new AnalysisInputError(
      OPERATION,
      { cause: parsed.error },
      projectInputIssues(parsed.error.issues, options.parameters),
    );
  const resources = options.resourceScope ?? new ArtifactResourceScope();
  return await resources.run(async () => {
    // Canonicalization is inside the translated region: a revoked permission
    // keeps its reason and path.
    let root = options.rootPath;
    try {
      assertArtifactReadActive(options.signal);
      root = await realpath(options.rootPath);
      assertArtifactReadActive(options.signal);
      const files = new DylibFileAccess(resources, root, options.signal);
      const target = relative(root, await realpath(options.targetPath))
        .split(sep)
        .join("/");
      assertArtifactReadActive(options.signal);
      const view = new FilesystemTreeView(root, files, options.signal);
      const { roots: requested, unclassified } =
        parsed.data.roots !== undefined
          ? { roots: parsed.data.roots, unclassified: [] }
          : options.enumerateRoots
            ? await executableRoots(root, view, files, options.signal)
            : { roots: [target], unclassified: [] };
      const roots = await requireMachoRoots(
        view,
        requested,
        parsed.data.roots !== undefined,
      );
      const trace = await traceDylibLoading(view, {
        roots,
        unclassified,
        ...(parsed.data.architecture === undefined
          ? {}
          : { architecture: parsed.data.architecture }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      // Each digest must describe the same file whose headers were parsed.
      const digests = new Map<string, string>();
      for (const { path } of trace.images)
        digests.set(
          path,
          await files.sha256(join(root, path), view.identity(path)),
        );
      const targetDigest =
        digests.get(target) ??
        (await files.sha256(join(root, target), undefined));
      if (targetDigest !== options.targetSha256)
        throw new ArtifactReaderFailure(
          "integrity",
          `Active target digest changed: expected ${options.targetSha256}, observed ${targetDigest}`,
        );
      assertArtifactReadActive(options.signal);
      return dylibResolutionResultSchema.parse({
        ...trace,
        root_path: options.rootPath,
        target_sha256: options.targetSha256,
        images: trace.images.map((image) => ({
          ...image,
          sha256: digests.get(image.path),
        })),
      });
    } catch (cause: unknown) {
      throw classifyDylibReadFailure(root, cause);
    }
  });
};

/**
 * Every Mach-O in the bundle with an executable slice is its own process root.
 * Mach-O files that do not parse are returned separately: whether they are
 * executables is unknown, so they make coverage partial instead of vanishing.
 */
const executableRoots = async (
  root: string,
  view: FilesystemTreeView,
  files: DylibFileAccess,
  signal?: AbortSignal,
): Promise<{ readonly roots: string[]; readonly unclassified: string[] }> => {
  const roots: string[] = [];
  const unclassified: string[] = [];
  // Bundles hold tens of thousands of files and few Mach-O images, so the
  // magic reads overlap the walk while results are classified in walk order.
  await consumeWithOrderedReads(
    new DirectoryArtifactReader(root).entries(signal),
    MAGIC_READ_CONCURRENCY,
    (entry) =>
      entry.kind === "file" ? files.startsWithMachoMagic(entry) : undefined,
    async (entry, macho) => {
      if (!macho) return;
      const facts = await view.image(entry.path);
      if (facts.status === "malformed" || facts.status === "unsupported")
        unclassified.push(entry.path);
      else if (
        facts.status === "parsed" &&
        facts.slices.some(({ file_type: type }) => type === "execute")
      )
        roots.push(entry.path);
    },
  );
  return {
    roots: roots.sort(compare),
    unclassified: unclassified.sort(compare),
  };
};

const compare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/**
 * Resolve each root segment by segment, as dependency candidates are, so a
 * symlink in an intermediate directory cannot lead outside the analyzed root.
 * A root the caller selected that fails is an input error on that root; a
 * root Oopsware derived itself keeps reporting an artifact failure.
 */
const requireMachoRoots = async (
  view: FilesystemTreeView,
  roots: readonly string[],
  callerSelected: boolean,
): Promise<string[]> => {
  const resolved: string[] = [];
  for (const [index, path] of roots.entries()) {
    const reject = (
      reason: "path" | "format",
      message: string,
    ): AnalysisInputError | ArtifactReaderFailure =>
      callerSelected
        ? new AnalysisInputError(OPERATION, undefined, [
            { path: ["roots", index], reason: "invalid_value", message },
          ])
        : new ArtifactReaderFailure(reason, message);
    const lookup = await resolveTreePath(view, path);
    if (lookup.kind === "escapes")
      throw reject("path", `Root ${path} resolves outside the analyzed root`);
    if (lookup.kind !== "file")
      throw reject(
        "path",
        `Root ${path} is not a regular file in the analyzed root`,
      );
    if ((await view.image(lookup.path)).status === "not-mach-o")
      throw reject("format", `Root ${path} is not a Mach-O image`);
    if (!resolved.includes(lookup.path)) resolved.push(lookup.path);
  }
  return resolved;
};

const missing = (cause: unknown): boolean =>
  cause instanceof Error &&
  "code" in cause &&
  (cause.code === "ENOENT" || cause.code === "ENOTDIR");
