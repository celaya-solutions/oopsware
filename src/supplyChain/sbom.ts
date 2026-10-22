import { lstat } from "node:fs/promises";
import { basename } from "node:path";
import { TomlError } from "smol-toml";
import type { ExecutionOptions } from "../application/AnalysisProvider.js";
import {
  ArtifactReaderFailure,
  type ArtifactEntry,
} from "../artifacts/ArtifactReader.js";
import { DirectoryArtifactReader } from "../artifacts/DirectoryArtifactReader.js";
import { assertArtifactReadActive } from "../artifacts/ArtifactFileOperation.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { readArtifactFileChunks } from "../artifacts/readArtifactFileChunks.js";
import { readStableArtifact } from "../artifacts/readStableArtifact.js";
import { stableReadFailure } from "../artifacts/stableReadFailure.js";
import {
  DecodeBudget,
  MemberReadFailure,
  ZipView,
} from "../artifacts/zipMemberView.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";
import { ArtifactOperationError } from "../domain/artifactOperationError.js";
import { classifyArtifactBytes } from "../domain/formatSignatures.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  generateSbomInputSchema,
  sbomReportSchema,
  type GenerateSbomInput,
  type SbomReport,
} from "../domain/supplyChain/sbom.js";
import { GoBinaryResourceFailure } from "../go/GoBinaryImage.js";
import { RustAuditableResourceFailure } from "../rust/RustAuditableReader.js";
import { inspectNative } from "./sbomNative.js";
import { inspectLicenseText, isLicenseFile } from "./licenses.js";
import {
  cargoMetadata,
  jarManifest,
  mavenProperties,
  npmMetadata,
  SbomBuilder,
  sourceOf,
  wheelMetadata,
  type SbomSource,
} from "./sbomMetadata.js";

const OPERATION = "generate_sbom";
const METADATA_BYTES = 8 * 1024 * 1024;
const metadataName = (path: string): boolean =>
  [
    "package.json",
    "package-lock.json",
    "Cargo.lock",
    "METADATA",
    "pom.properties",
    "MANIFEST.MF",
  ].includes(basename(path)) || isLicenseFile(path);
const selectedFile = (entry: ArtifactEntry): boolean =>
  metadataName(entry.path) ||
  /\.(?:whl|jar|zip|aar|exe|dll|dylib|so)(?:\.[\d.]+)?$/iu.test(entry.path) ||
  entry.executable ||
  !basename(entry.path).includes(".");

interface ReadCounts {
  signal?: AbortSignal | undefined;
  examined: number;
  read: number;
  bytes: number;
  decoded: number;
}
const inputLimit = (maximum: number) =>
  new AnalysisResourceConstraintError(
    OPERATION,
    "file-size",
    "SBOM aggregate input and decoded metadata exceed max_input_bytes.",
    { maximum_input_bytes: maximum },
  );

const inspectMetadata = (
  builder: SbomBuilder,
  source: SbomSource,
  bytes: Buffer,
): void => {
  if (bytes.length > METADATA_BYTES) throw inputLimit(METADATA_BYTES);
  const name = basename(source.path);
  try {
    if (name === "package.json" || name === "package-lock.json")
      npmMetadata(builder, source, bytes, name === "package-lock.json");
    else if (name === "Cargo.lock") cargoMetadata(builder, source, bytes);
    else if (name === "METADATA") wheelMetadata(builder, source, bytes);
    else if (name === "pom.properties") mavenProperties(builder, source, bytes);
    else if (name === "MANIFEST.MF") jarManifest(builder, source, bytes);
    if (isLicenseFile(source.path)) {
      const finding = inspectLicenseText(source.path, source.sha256, bytes);
      builder.retain(finding);
      builder.licenses.push(finding);
    }
  } catch (cause) {
    if (!(cause instanceof SyntaxError) && !(cause instanceof TomlError))
      throw cause;
    builder.limitation(
      `${source.path}: malformed metadata; no package identity was inferred from the filename.`,
    );
  }
};

const inspectZip = async (
  builder: SbomBuilder,
  source: SbomSource,
  bytes: Buffer,
  counts: ReadCounts,
): Promise<void> => {
  const signal = counts.signal;
  let zip: ZipView;
  try {
    zip = await ZipView.open(bytes, builder.input.max_files - counts.examined);
  } catch (cause) {
    if (cause instanceof MemberReadFailure && cause.reason === "budget")
      throw new AnalysisResourceConstraintError(
        OPERATION,
        "capacity",
        cause.message,
        { maximum_files: builder.input.max_files },
        { cause },
      );
    throw new ArtifactOperationError(
      OPERATION,
      "format",
      undefined,
      "ZIP metadata could not be opened.",
      { cause },
    );
  }
  try {
    const memberCount = zip.members.length + zip.duplicates.length;
    if (memberCount + counts.examined > builder.input.max_files)
      throw new AnalysisResourceConstraintError(
        OPERATION,
        "capacity",
        "ZIP members exceed max_files.",
        { maximum_files: builder.input.max_files },
      );
    counts.examined += memberCount;
    if (zip.duplicates.length > 0) {
      builder.limitation(
        `${source.path}: duplicate ZIP member names make metadata identity ambiguous; this archive was not interpreted.`,
      );
      return;
    }
    const budget = new DecodeBudget(
      builder.input.max_input_bytes - counts.bytes - counts.decoded,
      METADATA_BYTES,
    );
    for (const member of zip.members) {
      assertArtifactReadActive(signal);
      if (member.directory || !metadataName(member.path)) continue;
      if (
        member.path.startsWith("/") ||
        member.path.split(/[\\/]/u).includes("..")
      ) {
        builder.limitation(
          `${source.path}: unsafe ZIP metadata path was not interpreted.`,
        );
        continue;
      }
      const claimedBefore = budget.used;
      try {
        const decoded = Buffer.from(
          await zip.read(member.path, budget, signal),
        );
        inspectMetadata(
          builder,
          sourceOf(`${source.path}!/${member.path}`, decoded),
          decoded,
        );
      } catch (cause) {
        if (!(cause instanceof MemberReadFailure)) throw cause;
        if (cause.reason === "cancelled")
          throw new AnalysisCancelledError(OPERATION, { cause });
        if (cause.reason === "budget" || cause.reason === "size")
          throw inputLimit(builder.input.max_input_bytes);
        builder.limitation(
          `${source.path}!/${member.path}: metadata unreadable (${cause.reason}); identity unknown.`,
        );
      } finally {
        counts.decoded += budget.used - claimedBefore;
      }
    }
  } finally {
    await zip.close();
  }
};

const inspectFile = async (
  builder: SbomBuilder,
  path: string,
  bytes: Buffer,
  counts: ReadCounts,
): Promise<void> => {
  const signal = counts.signal;
  assertArtifactReadActive(signal);
  const source = sourceOf(path, bytes);
  counts.read += 1;
  counts.bytes += bytes.length;
  if (counts.bytes + counts.decoded > builder.input.max_input_bytes)
    throw inputLimit(builder.input.max_input_bytes);
  const format = classifyArtifactBytes(bytes);
  if (format === "zip") await inspectZip(builder, source, bytes, counts);
  else if (["elf", "pe", "mach-o"].includes(format))
    inspectNative(builder, source, bytes);
  else if (metadataName(path)) inspectMetadata(builder, source, bytes);
};

const inspectDirectory = async (
  builder: SbomBuilder,
  counts: ReadCounts,
): Promise<void> => {
  const signal = counts.signal;
  const reader = new DirectoryArtifactReader(builder.input.path);
  const resources = new ArtifactResourceScope();
  let outcome: { kind: "completed" } | { kind: "failed"; cause: unknown } = {
    kind: "completed",
  };
  try {
    for await (const entry of reader.entries(signal, {
      maximumEntries: builder.input.max_files,
      onOmission: ({ path, kind }) =>
        builder.limitation(`${path}: directory entry omitted (${kind}).`),
    })) {
      counts.examined += 1;
      if (counts.examined > builder.input.max_files)
        throw new AnalysisResourceConstraintError(
          OPERATION,
          "capacity",
          "Directory entries and ZIP members exceed max_files.",
          { maximum_files: builder.input.max_files },
        );
      if (entry.kind === "symlink")
        builder.limitation(`${entry.path}: symbolic link was not followed.`);
      if (entry.kind !== "file" || !selectedFile(entry)) continue;
      const remaining =
        builder.input.max_input_bytes - counts.bytes - counts.decoded;
      if (entry.declaredSize === null || entry.declaredSize > remaining)
        throw inputLimit(builder.input.max_input_bytes);
      const bytes = await reader.inspectFile(
        entry,
        async (file) => {
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of readArtifactFileChunks(
            file,
            signal === undefined ? {} : { signal },
          )) {
            size += chunk.length;
            if (size > remaining)
              throw inputLimit(builder.input.max_input_bytes);
            chunks.push(chunk);
          }
          return Buffer.concat(chunks, size);
        },
        signal,
      );
      await inspectFile(builder, entry.path, bytes, counts);
    }
  } catch (cause) {
    outcome = { kind: "failed", cause };
  }
  const cleanup = await resources.release({
    kind: "reader",
    reader,
    resource: builder.input.path,
  });
  if (cleanup.kind === "failed")
    throw resources.cleanupFailure(outcome, [cleanup]);
  if (outcome.kind === "failed") throw outcome.cause;
};

const finishReport = (
  builder: SbomBuilder,
  artifact: SbomReport["artifact"],
  counts: ReadCounts,
): SbomReport => {
  builder.limitation(
    "Only npm package metadata/lock v2-v3, wheel METADATA, JAR manifest/Maven properties, Cargo.lock and Go/Rust embedded metadata are interpreted. Archives are inspected one level deep. Other ecosystems and undeclared dependencies remain unknown.",
  );
  builder.limitation(
    "Directory candidates are recognized metadata/license filenames, JAR/wheel/ZIP/native-library names, executables and extensionless files; other files are not read. A directory has no aggregate content hash and can change during traversal.",
  );
  builder.limitation(
    "License declarations are unverified source claims. Text matches are inferences for a small set of common licenses; modified terms, exceptions, obligations and package-to-license-file ownership are not established. Unknown/custom text remains identified by its source and hash.",
  );
  builder.limitation(
    "Component source hashes identify metadata bytes, not the full contents of a package. Multiple metadata records may describe the same package; components retain separate source occurrences.",
  );
  builder.limitation(
    "Decoded ZIP byte counts charge declared member sizes, including failed reads; metadata members are limited to 8 MiB each.",
  );
  const report: SbomReport = {
    artifact,
    sbom: {
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      version: 1,
      components: builder.components,
      dependencies: builder.dependencies,
    },
    licenses: builder.licenses,
    coverage: {
      state: builder.components.length > 0 ? "partial" : "unknown",
      files_examined: counts.examined,
      files_read: counts.read,
      bytes_read: counts.bytes,
      decoded_bytes: counts.decoded,
      ecosystems: [...builder.ecosystems],
      dependency_relationships:
        builder.dependencies.length > 0 ? "partial" : "unknown",
      license_detection: "partial",
    },
    limitations: builder.limitations,
  };
  if (
    Buffer.byteLength(JSON.stringify(report)) > builder.input.max_output_bytes
  )
    throw new AnalysisResourceConstraintError(
      OPERATION,
      "transport",
      "SBOM exceeds max_output_bytes.",
      { maximum_output_bytes: builder.input.max_output_bytes },
    );
  const validated = sbomReportSchema.safeParse(report);
  if (!validated.success)
    throw new AnalysisOutputError(
      OPERATION,
      "Generated SBOM did not match its contract.",
      { cause: validated.error },
    );

  return validated.data;
};

/** Generate a bounded, local SBOM from metadata; no package is installed, resolved online or executed. */
export const generateSbom = async (
  input: GenerateSbomInput,
  options?: ExecutionOptions,
): Promise<Result<SbomReport, AnalysisError>> => {
  const parsed = generateSbomInputSchema.safeParse(input);
  if (!parsed.success)
    return err(
      new AnalysisInputError(OPERATION, { cause: parsed.error }, [
        {
          path: [],
          reason: "invalid_value",
          message:
            "Expected a nonempty local path and positive resource limits within the advertised bounds.",
        },
      ]),
    );
  const builder = new SbomBuilder(parsed.data);
  const counts: ReadCounts = {
    examined: 0,
    read: 0,
    bytes: 0,
    decoded: 0,
    signal: options?.signal,
  };
  try {
    assertArtifactReadActive(options?.signal);
    const stat = await lstat(parsed.data.path);
    if (stat.isSymbolicLink())
      throw new ArtifactReaderFailure(
        "path",
        "The selected SBOM root must not be a symbolic link.",
      );
    let artifact: SbomReport["artifact"] = {
      path: parsed.data.path,
      sha256: null,
      bytes: null,
    };
    if (stat.isDirectory()) await inspectDirectory(builder, counts);
    else {
      const snapshot = await readStableArtifact(
        parsed.data.path,
        parsed.data.max_input_bytes,
        options?.signal,
      );
      artifact = {
        path: parsed.data.path,
        sha256: snapshot.sha256,
        bytes: snapshot.bytes.length,
      };
      counts.examined = 1;
      await inspectFile(builder, parsed.data.path, snapshot.bytes, counts);
    }
    const report = finishReport(builder, artifact, counts);
    assertArtifactReadActive(options?.signal);
    return ok(report);
  } catch (cause) {
    if (cause instanceof AnalysisError) return err(cause);
    if (cause instanceof GoBinaryResourceFailure)
      return err(
        new AnalysisResourceConstraintError(
          OPERATION,
          "memory",
          cause.message,
          { maximum_bytes: cause.maximum_bytes },
          { cause },
        ),
      );
    if (cause instanceof RustAuditableResourceFailure)
      return err(
        new AnalysisResourceConstraintError(
          OPERATION,
          cause.constraint.resource,
          cause.message,
          cause.constraint.reported_limits,
          { cause },
        ),
      );
    if (cause instanceof MemberReadFailure)
      return err(
        new ArtifactOperationError(
          OPERATION,
          "format",
          undefined,
          cause.message,
          { cause },
        ),
      );
    return err(
      stableReadFailure(OPERATION, parsed.data.path, cause, {
        cancelled: options?.signal?.aborted === true,
        maxFileBytes: parsed.data.max_input_bytes,
        remediationAction:
          "Select a smaller input or raise the relevant resource limit within the advertised range.",
      }),
    );
  }
};
