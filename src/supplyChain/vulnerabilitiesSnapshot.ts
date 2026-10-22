import { createHash } from "node:crypto";
import { lstat, opendir, realpath } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import { z } from "zod";
import { ArtifactOperationError } from "../domain/artifactOperationError.js";
import { withOwnedRegularFile } from "../filesystem/OwnedRegularFile.js";
import { readStableFileBytes } from "../filesystem/readStableFileBytes.js";

export const VULNERABILITY_LIMITS = {
  inputBytes: 16 * 1024 ** 2,
  databaseBytes: 128 * 1024 ** 2,
  files: 20_000,
  records: 100_000,
  components: 10_000,
  findings: 5_000,
  outputBytes: 8 * 1024 ** 2,
  comparisons: 2_000_000,
};
const shortText = z.string().max(16_384);
const timestamp = z.iso.datetime({ offset: true });
const affectedSchema = z.object({
  package: z.object({ ecosystem: shortText, name: shortText }).optional(),
  versions: z.array(shortText).max(100_000).optional(),
  // Preserve invalid ranges as unknown; one damaged range cannot turn into a clean result.
  ranges: z.array(z.unknown()).max(10_000).optional(),
});
export const osvRecordSchema = z.object({
  id: shortText.min(1),
  modified: timestamp,
  published: timestamp.optional(),
  withdrawn: timestamp.optional(),
  summary: shortText.optional(),
  aliases: z.array(shortText).max(100).optional(),
  affected: z.array(affectedSchema).max(10_000),
  severity: z
    .array(z.object({ type: shortText, score: shortText }))
    .max(100)
    .optional(),
  references: z
    .array(z.object({ type: shortText, url: shortText }))
    .max(100)
    .optional(),
});
export type OsvRecord = z.infer<typeof osvRecordSchema>;
export interface SnapshotRecord {
  record: OsvRecord;
  source: { file: string; sha256: string; record_index: number };
}
const manifestSchema = z.object({
  schema: z.literal("oopsware-osv-snapshot-v1"),
  generated_at: timestamp.optional(),
});
const snapshotSchema = manifestSchema.extend({
  records: z.array(z.unknown()).max(VULNERABILITY_LIMITS.records),
});
export const vulnerabilityFailure = (
  reason: ArtifactOperationError["reason"],
  detail: string,
) =>
  new ArtifactOperationError(
    "check_vulnerabilities",
    reason,
    undefined,
    detail,
  );
export const checkVulnerabilityCancellation = (signal?: AbortSignal) => {
  if (signal?.aborted)
    throw vulnerabilityFailure("cancelled", "Vulnerability check cancelled");
};
export const vulnerabilityDigest = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
export const readVulnerabilityFile = async (
  path: string,
  maximum: number,
  signal?: AbortSignal,
) => {
  checkVulnerabilityCancellation(signal);
  const selected = resolve(path);
  if ((await lstat(selected)).isSymbolicLink())
    throw vulnerabilityFailure("path", "Symbolic links are not accepted");
  const canonical = await realpath(selected);
  const options = {
    symlinks: "reject" as const,
    ...(signal ? { signal } : {}),
  };
  const bytes = await withOwnedRegularFile(canonical, options, (file) =>
    readStableFileBytes(file, canonical, maximum, options),
  );
  if (
    (await realpath(selected)) !== canonical ||
    (await lstat(selected)).isSymbolicLink()
  )
    throw vulnerabilityFailure("integrity", "Selected file identity changed");
  return { path: canonical, bytes, sha256: vulnerabilityDigest(bytes) };
};
export const parseVulnerabilityJson = (bytes: Uint8Array): unknown => {
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
  } catch {
    throw vulnerabilityFailure("format", "Expected valid UTF-8 JSON");
  }
};

const listSnapshotFiles = async (
  root: string,
  signal?: AbortSignal,
): Promise<string[]> => {
  const files: string[] = [];
  let entries = 0;
  const visit = async (directory: string, depth: number): Promise<void> => {
    checkVulnerabilityCancellation(signal);
    if (depth > 16)
      throw vulnerabilityFailure(
        "limit",
        "Snapshot directory depth exceeds 16",
      );
    const before = await lstat(directory);
    if (
      !before.isDirectory() ||
      before.isSymbolicLink() ||
      (await realpath(directory)) !== directory
    )
      throw vulnerabilityFailure(
        "path",
        "Snapshot directories must not contain symbolic links",
      );
    for await (const entry of await opendir(directory)) {
      checkVulnerabilityCancellation(signal);
      if (++entries > VULNERABILITY_LIMITS.files)
        throw vulnerabilityFailure(
          "limit",
          "Snapshot has too many directory entries",
        );
      const path = join(directory, entry.name);
      const stat = await lstat(path);
      if (stat.isSymbolicLink())
        throw vulnerabilityFailure(
          "path",
          "Snapshot symbolic links are not accepted",
        );
      if (stat.isDirectory()) await visit(path, depth + 1);
      else if (!stat.isFile())
        throw vulnerabilityFailure(
          "path",
          "Snapshot contains a non-regular file",
        );
      else if (entry.name.endsWith(".json")) files.push(path);
    }
    const after = await lstat(directory);
    if (
      !after.isDirectory() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw vulnerabilityFailure(
        "integrity",
        "Snapshot directory changed while listing",
      );
  };
  await visit(root, 0);
  return files.sort();
};

const snapshotDocument = (
  value: unknown,
  name: string,
  directory: boolean,
): { records: unknown[]; generatedAt?: string | null } => {
  if (directory && name === "manifest.json") {
    const manifest = manifestSchema.safeParse(value);
    if (
      !manifest.success ||
      (typeof value === "object" && value !== null && "records" in value)
    )
      throw vulnerabilityFailure(
        "format",
        "Invalid OSV snapshot manifest.json",
      );
    return { records: [], generatedAt: manifest.data.generated_at ?? null };
  }
  if (
    !directory &&
    typeof value === "object" &&
    value !== null &&
    "schema" in value
  ) {
    const snapshot = snapshotSchema.safeParse(value);
    if (!snapshot.success)
      throw vulnerabilityFailure("format", "Invalid OSV snapshot wrapper");
    return {
      records: snapshot.data.records,
      generatedAt: snapshot.data.generated_at ?? null,
    };
  }
  return { records: Array.isArray(value) ? value : [value] };
};
const appendRecords = async (
  records: SnapshotRecord[],
  values: unknown[],
  source: { file: string; sha256: string },
  signal?: AbortSignal,
) => {
  if (records.length + values.length > VULNERABILITY_LIMITS.records)
    throw vulnerabilityFailure(
      "limit",
      "Snapshot exceeds the OSV record limit",
    );
  for (const [index, value] of values.entries()) {
    if (index % 128 === 0) {
      await setImmediate();
      checkVulnerabilityCancellation(signal);
    }
    const parsed = osvRecordSchema.safeParse(value);
    if (!parsed.success)
      throw vulnerabilityFailure(
        "format",
        `Invalid OSV record in ${source.file} at index ${index}`,
      );
    records.push({
      record: parsed.data,
      source: { ...source, record_index: index },
    });
  }
};

export const readVulnerabilitySnapshot = async (
  path: string,
  signal?: AbortSignal,
) => {
  const selected = resolve(path);
  const stat = await lstat(selected);
  if (stat.isSymbolicLink())
    throw vulnerabilityFailure(
      "path",
      "Snapshot symbolic links are not accepted",
    );
  const root = await realpath(selected);
  const directory = stat.isDirectory();
  const paths = directory ? await listSnapshotFiles(root, signal) : [root];
  const files: { path: string; sha256: string; bytes: number }[] = [];
  const records: SnapshotRecord[] = [];
  let generatedAt: string | null = null;
  let totalBytes = 0;
  for (const file of paths) {
    checkVulnerabilityCancellation(signal);
    const read = await readVulnerabilityFile(
      file,
      VULNERABILITY_LIMITS.databaseBytes - totalBytes,
      signal,
    );
    if (read.path !== file)
      throw vulnerabilityFailure(
        "path",
        "Snapshot record escaped its selected directory",
      );
    totalBytes += read.bytes.length;
    const name = directory
      ? relative(root, file).split("\\").join("/")
      : basename(file);
    files.push({ path: file, sha256: read.sha256, bytes: read.bytes.length });
    const document = snapshotDocument(
      parseVulnerabilityJson(read.bytes),
      name,
      directory,
    );
    if (document.generatedAt !== undefined) generatedAt = document.generatedAt;
    await appendRecords(
      records,
      document.records,
      { file: name, sha256: read.sha256 },
      signal,
    );
  }
  const verify = async () => {
    checkVulnerabilityCancellation(signal);
    if (
      (await realpath(selected)) !== root ||
      (await lstat(selected)).isSymbolicLink()
    )
      throw vulnerabilityFailure(
        "integrity",
        "Snapshot identity changed during checking",
      );
    if (
      directory &&
      JSON.stringify(await listSnapshotFiles(root, signal)) !==
        JSON.stringify(paths)
    )
      throw vulnerabilityFailure(
        "integrity",
        "Snapshot membership changed during checking",
      );
    for (const file of files) {
      const current = await readVulnerabilityFile(
        file.path,
        VULNERABILITY_LIMITS.databaseBytes,
        signal,
      );
      if (
        current.path !== file.path ||
        current.sha256 !== file.sha256 ||
        current.bytes.length !== file.bytes
      )
        throw vulnerabilityFailure(
          "integrity",
          "Snapshot bytes changed during checking",
        );
    }
  };
  const sha256 = snapshotDigest(root, directory, files);
  return {
    path: root,
    sha256,
    bytes: totalBytes,
    files: files.length,
    records,
    generatedAt,
    digest_basis: directory
      ? ("sorted-relative-path-sha256-bytes" as const)
      : ("file-bytes" as const),
    verify,
  };
};

const snapshotDigest = (
  root: string,
  directory: boolean,
  files: { path: string; sha256: string; bytes: number }[],
) =>
  directory
    ? vulnerabilityDigest(
        JSON.stringify(
          files.map((file) => [
            relative(root, file.path).split("\\").join("/"),
            file.sha256,
            file.bytes,
          ]),
        ),
      )
    : files[0]!.sha256;
