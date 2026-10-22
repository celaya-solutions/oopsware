import { copyFile, lstat, mkdir, readFile, rm } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, join } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { err, ok, type Result } from "../domain/result.js";
import { readBoundedFileBytes } from "../process/BoundedFileBytes.js";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";

import { PRODUCT_IDENTITY } from "../identity.js";
import {
  NonRegularFileReadError,
  RegularFileChangedError,
} from "../filesystem/RegularFile.js";
import {
  RegularFileCleanupFailure,
  withRegularFile,
} from "./RegularFileRead.js";
import { clientSkillDirectories } from "./SupportedClients.js";
import { preserveCurrentRecoveryBackup } from "./SetupRecoveryBackup.js";

export const MANAGED_SKILL_FILES = [
  "SKILL.md",
  "references/connection-and-recovery.md",
  "references/native-and-artifacts.md",
  "references/native-versions.md",
  "references/javascript-applications.md",
  "references/android-applications.md",
  "references/runtime-observation.md",
  "references/evidence-workflows.md",
] as const;

export const isManagedSkillManifest = (content: string): boolean =>
  content.startsWith(`---\nname: ${PRODUCT_IDENTITY.skillName}\n`) ||
  content.startsWith(`---\r\nname: ${PRODUCT_IDENTITY.skillName}\r\n`);

export const readSkillFile = (
  path: string,
  resources?: ArtifactResourceScope,
): Promise<string> =>
  readSkillFileState(path, resources).then(({ bytes }) =>
    bytes.toString("utf8"),
  );

interface SkillFileState {
  readonly bytes: Buffer;
  readonly mode: number;
}

const readSkillFileState = async (
  path: string,
  resources?: ArtifactResourceScope,
): Promise<SkillFileState> =>
  withRegularFile(
    path,
    async (handle, stats) => {
      const bytes = await readBoundedFileBytes(
        handle,
        stats.size,
        undefined,
        stats.size,
      );
      if (bytes === undefined || bytes.length !== stats.size)
        throw new RegularFileChangedError(path);
      return { bytes, mode: stats.mode & 0o7777 };
    },
    {
      symlinks: "reject",
      ...(resources === undefined ? {} : { resources }),
    },
  );

interface CanonicalSkillFile {
  readonly content: string;
  readonly destination: string;
  readonly original: SkillFileState | undefined;
}

const canonicalSkillContent = (relativePath: string): Promise<string> =>
  readFile(
    new URL(
      `../../skills/${PRODUCT_IDENTITY.skillName}/${relativePath}`,
      import.meta.url,
    ),
    "utf8",
  );

export interface SkillInstallFileOperations {
  readonly mkdir: (path: string) => Promise<void>;
  readonly backup: (source: string, destination: string) => Promise<void>;
  readonly write: (
    path: string,
    content: string | Buffer,
    mode: number,
  ) => Promise<void>;
  readonly remove: (path: string) => Promise<void>;
}

export interface SkillInstallRollbackFailure {
  readonly path: string;
  readonly reason: string;
}

/** Expected failure while replacing a managed skill bundle. */
export class SetupSkillInstallError extends Error {
  readonly _tag = "SetupSkillInstallError";
  readonly path: string;
  readonly stage: "prepare" | "backup" | "write" | "readback";
  readonly reason: string;
  readonly rollbackFailures: readonly SkillInstallRollbackFailure[];
  readonly recoveryBackupPaths: readonly string[];

  constructor(input: {
    readonly path: string;
    readonly stage: "prepare" | "backup" | "write" | "readback";
    readonly reason: string;
    readonly rollbackFailures: readonly SkillInstallRollbackFailure[];
    readonly recoveryBackupPaths: readonly string[];
    readonly cause: unknown;
  }) {
    const message = [
      `Oopsware skill ${input.stage} failed at ${input.path}: ${input.reason}.`,
      ...(input.rollbackFailures.length === 0
        ? []
        : [
            `Rollback also failed for ${input.rollbackFailures.map(({ path, reason }) => `${path} (${reason})`).join(", ")}.`,
            ...(input.recoveryBackupPaths.length === 0
              ? []
              : [
                  `Existing-file backups remain at ${input.recoveryBackupPaths.join(", ")}.`,
                ]),
          ]),
    ].join(" ");
    super(message, { cause: input.cause });
    this.path = input.path;
    this.stage = input.stage;
    this.reason = input.reason;
    this.rollbackFailures = input.rollbackFailures;
    this.recoveryBackupPaths = input.recoveryBackupPaths;
  }

  get remediation(): string {
    return `${this.message} Check permissions and rerun setup.`;
  }
}

export type SkillInstallValue = "installed" | "unchanged";
export type SkillInstallResult = Result<
  SkillInstallValue,
  SetupSkillInstallError
>;

const systemSkillInstallFileOperations: SkillInstallFileOperations = {
  mkdir: async (path) => {
    await mkdir(path, { recursive: true });
  },
  backup: (source, destination) =>
    copyFile(source, destination, fsConstants.COPYFILE_EXCL),
  write: (path, content, mode) =>
    writeFileAtomic(path, content, { encoding: "utf8", mode }),
  remove: (path) => rm(path, { force: true }),
};

/** Managed skill location selected for a client family. */
export interface SkillDestination {
  readonly client: string;
  readonly path: string;
}

/** Metadata and byte alignment observed in selected skill installations. */
export interface InstalledSkillIdentity {
  readonly version: string | null;
  readonly toolCount: number | null;
  readonly canonical: boolean;
  readonly issues?: readonly SkillPathIssue[];
}

/** Known management blockers and unresolved filesystem observations. */
export interface SkillPathIssue {
  readonly path: string;
  readonly kind: "symbolic_link" | "not_directory" | "unreadable";
  readonly detail: string;
}

/** Resolve the skill roots required by a client selection, or all owned roots. */
export const skillDestinations = (
  home: string,
  clientIds: readonly string[] | undefined,
  environment: Readonly<NodeJS.ProcessEnv> = {},
  platform: NodeJS.Platform = process.platform,
): readonly SkillDestination[] =>
  clientSkillDirectories(home, clientIds, environment, platform).map(
    ({ client, directory }) => ({
      client,
      path: join(directory, PRODUCT_IDENTITY.skillName),
    }),
  );

/** Resolve existing Oopsware-owned skill roots using setup's canonical destinations. */
export const existingSkillDestinations = async (
  home: string,
  environment: Readonly<NodeJS.ProcessEnv> = {},
  platform: NodeJS.Platform = process.platform,
  resources?: ArtifactResourceScope,
): Promise<readonly SkillDestination[]> => {
  const existing: SkillDestination[] = [];
  for (const destination of skillDestinations(
    home,
    undefined,
    environment,
    platform,
  )) {
    try {
      const issues = await skillDirectoryIssues([destination]);
      if (issues.some(({ kind }) => kind === "unreadable"))
        throw skillDirectoryFailure(issues);
      if (issues.length > 0) continue;
      const manifest = join(destination.path, "SKILL.md");
      const content = await readSkillFile(manifest, resources);
      if (isManagedSkillManifest(content)) existing.push(destination);
    } catch (cause: unknown) {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
        continue;
      if (
        cause instanceof RegularFileCleanupFailure ||
        cause instanceof ArtifactReaderFailure
      )
        throw cause;
      if (cause instanceof NonRegularFileReadError) continue;
      throw cause;
    }
  }
  return existing;
};

const readOptionalSkillState = async (
  path: string,
  resources?: ArtifactResourceScope,
): Promise<SkillFileState | undefined> => {
  try {
    return await readSkillFileState(path, resources);
  } catch (cause: unknown) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return undefined;
    throw cause;
  }
};

const inspectSkillDirectory = async (
  path: string,
): Promise<Result<void, SkillPathIssue>> => {
  try {
    const directory = await lstat(path);
    if (directory.isSymbolicLink())
      return err({
        path,
        kind: "symbolic_link",
        detail: "Skill directory is a symbolic link.",
      });
    if (!directory.isDirectory())
      return err({
        path,
        kind: "not_directory",
        detail: "Skill path is not a directory.",
      });
    return ok(undefined);
  } catch (cause: unknown) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return ok(undefined);
    return err({
      path,
      kind: "unreadable",
      detail: cause instanceof Error ? cause.message : String(cause),
    });
  }
};

const skillDirectoryIssues = async (
  destinations: readonly SkillDestination[],
): Promise<readonly SkillPathIssue[]> => {
  const issues: SkillPathIssue[] = [];
  for (const { path } of destinations) {
    const root = await inspectSkillDirectory(path);
    if (!root.ok) {
      issues.push(root.error);
      continue;
    }
    const references = await inspectSkillDirectory(join(path, "references"));
    if (!references.ok) issues.push(references.error);
  }
  return issues;
};

const skillDirectoryFailure = (
  issues: readonly SkillPathIssue[],
): SetupSkillInstallError =>
  new SetupSkillInstallError({
    path: issues[0]?.path ?? "skill bundle",
    stage: "prepare",
    reason: `${issues.map(({ path, detail }) => `${detail} (${path})`).join(" ")} Use a regular skill directory, or run setup with --skill=false to configure the client without installing the skill`,
    rollbackFailures: [],
    recoveryBackupPaths: [],
    cause: issues,
  });

/** Validate only final selected roots; permission to install is separate from freshness. */
export const validateCanonicalSkillDirectories = async (
  home: string,
  clientIds: readonly string[],
  environment: Readonly<NodeJS.ProcessEnv> = {},
  platform: NodeJS.Platform = process.platform,
): Promise<Result<void, SetupSkillInstallError>> => {
  const issues = await skillDirectoryIssues(
    skillDestinations(home, clientIds, environment, platform),
  );
  return issues.length === 0
    ? ok(undefined)
    : err(skillDirectoryFailure(issues));
};

const canonicalSkillFiles = async (
  home: string,
  clientIds: readonly string[],
  environment: Readonly<NodeJS.ProcessEnv> = {},
  platform: NodeJS.Platform = process.platform,
  resources?: ArtifactResourceScope,
): Promise<readonly CanonicalSkillFile[]> => {
  const destinations = skillDestinations(
    home,
    clientIds,
    environment,
    platform,
  );
  const admission = await validateCanonicalSkillDirectories(
    home,
    clientIds,
    environment,
    platform,
  );
  if (!admission.ok) throw admission.error;
  return Promise.all(
    destinations.flatMap(({ path: root }) =>
      MANAGED_SKILL_FILES.map(async (relativePath) => {
        const destination = join(root, relativePath);
        return {
          destination,
          content: await canonicalSkillContent(relativePath),
          original: await readOptionalSkillState(destination, resources),
        };
      }),
    ),
  );
};

interface CanonicalSkillInspection {
  readonly canonical: boolean;
  readonly manifest: string | undefined;
  readonly installedDestination: boolean;
}

interface SkillInspectionFailure {
  readonly _tag: "SkillInspectionFailure";
  readonly issues: readonly SkillPathIssue[];
  readonly cause: unknown;
  readonly manifest: string | undefined;
}

const inspectCanonicalSkill = async (
  home: string,
  clientIds: readonly string[] | undefined,
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
  resources?: ArtifactResourceScope,
): Promise<Result<CanonicalSkillInspection, SkillInspectionFailure>> => {
  const destinations = skillDestinations(
    home,
    clientIds,
    environment,
    platform,
  );
  const issues =
    clientIds === undefined
      ? []
      : [...(await skillDirectoryIssues(destinations))];
  if (issues.length > 0)
    return err({
      _tag: "SkillInspectionFailure",
      issues,
      cause: issues,
      manifest: undefined,
    });
  let canonical = true;
  let manifest: string | undefined;
  let failureCause: unknown;
  let installedDestination = false;
  for (const destination of destinations) {
    const { path: root } = destination;
    const pathIssues =
      clientIds === undefined ? await skillDirectoryIssues([destination]) : [];
    if (pathIssues.length > 0) {
      issues.push(...pathIssues);
      if (failureCause === undefined) failureCause = pathIssues;
      installedDestination = true;
      canonical = false;
      continue;
    }
    let rootCanonical = true;
    let rootHasFiles = false;
    const rootIssues: SkillPathIssue[] = [];
    for (const relativePath of MANAGED_SKILL_FILES) {
      const destination = join(root, relativePath);
      let original: SkillFileState | undefined;
      try {
        original = await readOptionalSkillState(destination, resources);
      } catch (cause: unknown) {
        if (
          cause instanceof RegularFileCleanupFailure ||
          cause instanceof ArtifactReaderFailure
        )
          throw cause;
        rootIssues.push({
          path: destination,
          kind: "unreadable",
          detail: causeReason(cause),
        });
        if (failureCause === undefined) failureCause = cause;
        rootCanonical = false;
        rootHasFiles = true;
        continue;
      }
      if (original !== undefined) rootHasFiles = true;
      if (relativePath === "SKILL.md" && manifest === undefined)
        manifest = original?.bytes.toString("utf8");
      // A mismatch settles freshness, but not coverage of later read failures.
      if (original === undefined) rootCanonical = false;
      else if (rootCanonical) {
        const content = await canonicalSkillContent(relativePath);
        rootCanonical = original.bytes.equals(Buffer.from(content, "utf8"));
      }
    }
    if (clientIds !== undefined || rootHasFiles || rootIssues.length > 0) {
      installedDestination ||= rootHasFiles;
      canonical = canonical && rootCanonical;
      issues.push(...rootIssues);
    }
  }
  return issues.length === 0
    ? ok({ canonical, manifest, installedDestination })
    : err({
        _tag: "SkillInspectionFailure",
        issues,
        cause: failureCause,
        manifest,
      });
};

/** Report whether setup would change any file in the managed Oopsware skill bundle. */
export const canonicalSkillNeedsInstall = async (
  home: string,
  clientIds: readonly string[] = [],
  environment: Readonly<NodeJS.ProcessEnv> = {},
  platform: NodeJS.Platform = process.platform,
  resources?: ArtifactResourceScope,
): Promise<boolean> => {
  try {
    const inspection = await inspectCanonicalSkill(
      home,
      clientIds,
      environment,
      platform,
      resources,
    );
    return !inspection.ok || !inspection.value.canonical;
  } catch (cause: unknown) {
    if (
      cause instanceof RegularFileCleanupFailure ||
      cause instanceof ArtifactReaderFailure
    )
      throw cause;
    // A copy needs attention; selected-root admission decides whether it may be installed.
    void cause;
    return true;
  }
};

const causeReason = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const causePath = (cause: unknown): string | undefined =>
  cause instanceof Error && "path" in cause && typeof cause.path === "string"
    ? cause.path
    : undefined;

const restoreSkillFiles = async (
  attempted: readonly CanonicalSkillFile[],
  operations: SkillInstallFileOperations,
): Promise<readonly SkillInstallRollbackFailure[]> => {
  const failures: SkillInstallRollbackFailure[] = [];
  for (const { destination, original } of [...attempted].reverse()) {
    try {
      if (original === undefined) await operations.remove(destination);
      else await operations.write(destination, original.bytes, original.mode);
    } catch (cause: unknown) {
      failures.push({ path: destination, reason: causeReason(cause) });
    }
  }
  return failures;
};

/** Transactionally install the canonical skill bundle and optional references. */
export const installCanonicalSkill = async (
  home: string,
  clientIds: readonly string[] = [],
  environment: Readonly<NodeJS.ProcessEnv> = {},
  platform: NodeJS.Platform = process.platform,
  operations: SkillInstallFileOperations = systemSkillInstallFileOperations,
  resources?: ArtifactResourceScope,
): Promise<SkillInstallResult> => {
  let attempted: CanonicalSkillFile[] = [];
  let stage: "prepare" | "backup" | "write" | "readback" = "prepare";
  let failingPath = "skill bundle";
  const recoveryPaths = new Map<string, string>();
  try {
    const canonical = await canonicalSkillFiles(
      home,
      clientIds,
      environment,
      platform,
      resources,
    );
    const changed = canonical.filter(
      ({ content, original }) =>
        original?.bytes.equals(Buffer.from(content, "utf8")) !== true,
    );
    if (changed.length === 0) return ok("unchanged");

    stage = "backup";
    for (const { destination, original } of changed) {
      failingPath = destination;
      await operations.mkdir(dirname(destination));
      if (original !== undefined) {
        const preserved = await preserveCurrentRecoveryBackup(
          `${destination}.rea.backup`,
          destination,
          original.bytes,
          {
            copy: operations.backup,
            ...(resources === undefined ? {} : { resources }),
          },
        );
        if (!preserved.ok) throw new Error(preserved.error.detail);
        recoveryPaths.set(destination, preserved.value);
      }
    }
    stage = "write";
    for (const file of changed) {
      failingPath = file.destination;
      // An atomic writer can publish and then reject; include the target before
      // entering it so rollback covers that ambiguous outcome.
      attempted.push(file);
      await operations.write(
        file.destination,
        file.content,
        file.original?.mode ?? 0o600,
      );
    }
    stage = "readback";
    for (const { destination, content } of changed) {
      failingPath = destination;
      if (
        !(await readSkillFileState(destination, resources)).bytes.equals(
          Buffer.from(content, "utf8"),
        )
      )
        throw new Error(`skill readback mismatch: ${destination}`);
    }
    return ok("installed");
  } catch (cause: unknown) {
    if (stage === "prepare" && cause instanceof SetupSkillInstallError)
      return err(cause);
    failingPath = causePath(cause) ?? failingPath;
    const rollbackFailures = await restoreSkillFiles(attempted, operations);
    return err(
      new SetupSkillInstallError({
        path: failingPath,
        stage,
        reason: causeReason(cause),
        rollbackFailures,
        recoveryBackupPaths: attempted.flatMap(({ destination, original }) =>
          original === undefined || recoveryPaths.get(destination) === undefined
            ? []
            : [recoveryPaths.get(destination)!],
        ),
        cause,
      }),
    );
  }
};

/** Read installed skill metadata and compare every managed location. */
export const readInstalledSkillIdentity = async (
  home: string,
  clientIds: readonly string[] | undefined,
  environment: Readonly<NodeJS.ProcessEnv> = {},
  platform: NodeJS.Platform = process.platform,
  resources?: ArtifactResourceScope,
): Promise<InstalledSkillIdentity | undefined> => {
  const inspection = await inspectCanonicalSkill(
    home,
    clientIds,
    environment,
    platform,
    resources,
  );
  if (inspection.ok && !inspection.value.installedDestination) return undefined;
  const content = inspection.ok
    ? inspection.value.manifest
    : inspection.error.manifest;
  const issues = inspection.ok ? [] : inspection.error.issues;
  const toolCount =
    content === undefined
      ? undefined
      : /^\s{2}tool_count:\s*(\d+)\s*$/mu.exec(content)?.[1];
  return {
    canonical: inspection.ok && inspection.value.canonical,
    version:
      content === undefined
        ? null
        : (/^\s{2}version:\s*"([^"]+)"\s*$/mu.exec(content)?.[1] ?? null),
    toolCount: toolCount === undefined ? null : Number.parseInt(toolCount, 10),
    ...(issues.length === 0 ? {} : { issues }),
  };
};
