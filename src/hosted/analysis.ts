import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, rm, statfs, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isUtf8 } from "node:buffer";
import { z } from "zod";
import { scanArtifactInventory } from "../artifacts/inventory/ArtifactInventory.js";
import { materializeArtifactInventory } from "../artifacts/extraction/ArtifactExtraction.js";
import {
  formatCapabilities,
  HOSTED_CAPABILITY_CONTEXT,
} from "../domain/formatRegistry.js";
import { detectFormatCandidates } from "../domain/formatDetection.js";
import {
  FORMAT_SIGNATURE_PREFIX_BYTES,
  UDIF_TRAILER_BYTES,
} from "../domain/formatSignatures.js";
import { HostedStore } from "./Store.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import type { ArchiveReadPolicy } from "../artifacts/archives/StreamArchiveArtifactReader.js";
import { AnalysisUnsupportedTargetError } from "../domain/analysisErrorCore.js";
import {
  isRandomAccessContainerFormat,
  READABLE_ARCHIVE_STREAM_FORMATS,
} from "../domain/archiveStreamFormat.js";
import { writeDocumentView } from "./documentView.js";
import { writeWasmView } from "./wasmView.js";
import type { PublishedFile } from "./types.js";

/** Read bytes without interpreting them as markup or executing the uploaded file. */
export const previewFile = async (path: string, offset = 0, size = 16_384) => {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    const buffer = Buffer.alloc(
      Math.min(size, Math.max(0, info.size - offset)),
    );
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    const bytes = buffer.subarray(0, bytesRead);
    return {
      offset,
      size: info.size,
      bytes: bytesRead,
      nextOffset: offset + bytesRead < info.size ? offset + bytesRead : null,
      text: isUtf8(bytes) && !bytes.includes(0) ? bytes.toString("utf8") : null,
      hex: bytes.toString("hex"),
      strings: [...bytes.toString("latin1").matchAll(/[\x20-\x7e]{4,}/g)].map(
        (match) => ({ offset: offset + match.index, text: match[0] }),
      ),
    };
  } finally {
    await handle.close();
  }
};

/**
 * Byte-signature candidates and the hosted capability of each. Reads a
 * bounded prefix and trailer only; candidates are not support claims.
 */
const detectSourceFormat = async (path: string, name: string) => {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const prefix = Buffer.alloc(Math.min(size, FORMAT_SIGNATURE_PREFIX_BYTES));
    const head = await handle.read(prefix, 0, prefix.length, 0);
    let trailer: Buffer | null = null;
    if (size >= UDIF_TRAILER_BYTES) {
      const tail = Buffer.alloc(UDIF_TRAILER_BYTES);
      const read = await handle.read(
        tail,
        0,
        tail.length,
        size - UDIF_TRAILER_BYTES,
      );
      trailer = tail.subarray(0, read.bytesRead);
    }
    const detection = detectFormatCandidates({
      prefix: prefix.subarray(0, head.bytesRead),
      fileSize: size,
      name,
      trailer,
    });
    return {
      ...detection,
      capabilities: detection.candidates.map((candidate) =>
        formatCapabilities(candidate.format, HOSTED_CAPABILITY_CONTEXT),
      ),
    };
  } finally {
    await handle.close();
  }
};

/**
 * In-process decoding only: external decoders stay local until the hosted
 * worker isolation boundary is verified. The decoded budget bounds a
 * compression bomb before the 2 GiB extraction budget is even consulted.
 */
const HOSTED_ARCHIVE_POLICY: ArchiveReadPolicy = {
  externalDecoders: "deny",
  maximumDecodedBytes: 4 * 1024 ** 3,
  containerImages: "deny",
};

/**
 * A typed archive-reader or unsupported-target reason, safe to publish once
 * the private storage path is replaced by the visitor's own file name.
 */
const publicReason = (
  cause: unknown,
  source: string,
  name: string,
): string[] => {
  if (
    !(cause instanceof ArtifactReaderFailure) &&
    !(cause instanceof AnalysisUnsupportedTargetError)
  )
    return [];
  if (cause instanceof ArtifactReaderFailure && cause.reason === "io")
    return [];
  return [`Reason: ${cause.message.split(source).join(name)}`];
};

const hashFile = async (path: string) => {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
};

/**
 * Run the existing artifact parser in a bounded, disposable analysis process.
 * `worker` is the hosted worker script; structured-text reading runs it again
 * in its own budgeted process.
 */
export const analyzeSubmission = async (
  directory: string,
  id: string,
  worker: string,
) => {
  const store = new HostedStore(directory);
  const submission = await store.get(id);
  const folder = store.path(id);
  const source = join(folder, "source", submission.name);
  const sha256 = await hashFile(source);
  const files: PublishedFile[] = [
    {
      id: submission.id,
      name: submission.name,
      relative: `source/${submission.name}`,
      size: submission.size,
      sha256,
    },
  ];
  await store.save({ ...submission, files });
  await rm(join(folder, "extracted"), { recursive: true, force: true });
  const limitations = [
    "Static analysis only. Uploaded code is never executed. No malware-free or safety verdict is implied.",
    "Deep disassembly and runtime behavior are not available on this hosted service.",
  ];
  let inventory: unknown = null;
  let format = "unrecognized";
  const signal = AbortSignal.timeout(8 * 60_000);
  const resourceScope = new ArtifactResourceScope();
  try {
    const snapshot = await scanArtifactInventory(source, {
      resourceScope,
      environment: {},
      signal,
      integrity: { mode: "record-and-continue" },
      archive: HOSTED_ARCHIVE_POLICY,
    });
    inventory = snapshot;
    format = snapshot.manifest.root_format;
    limitations.push(...snapshot.limitations);
    const entries = snapshot.occurrences.filter(
      (entry) =>
        entry.logical_path !== "." &&
        (entry.entry_kind === "file" || entry.entry_kind === "slice"),
    );
    const expanded = entries.reduce(
      (sum, entry) => sum + (entry.declared_size ?? 0),
      0,
    );
    const disk = await statfs(directory);
    if (isRandomAccessContainerFormat(format) && format !== "msi") {
      // Filesystem images are listed in the report; only a local install extracts them.
      limitations.push(
        "This filesystem image's members are listed in the report; the hosted service does not extract them.",
      );
    } else if (
      entries.length > 10_000 ||
      expanded > 2 * 1024 ** 3 ||
      disk.bavail * disk.bsize < expanded + 512 * 1024 ** 2
    ) {
      limitations.push(
        "Extraction was skipped: the archive exceeds the hosted budget of 10,000 entries, 2 GiB expanded bytes, or available disk space. The original remains downloadable.",
      );
    } else if (entries.length) {
      try {
        const inputFormat = z
          .enum([
            "zip",
            "apk",
            "ipa",
            "appx",
            "msix",
            "msixbundle",
            "appxbundle",
            "asar",
            "mach-o",
            "msi",
            ...READABLE_ARCHIVE_STREAM_FORMATS,
          ])
          .parse(snapshot.manifest.root_format);
        const extraction = await materializeArtifactInventory(
          {
            inputPath: source,
            inputFormat,
            outputRoot: join(folder, "extracted"),
            environment: {},
            integrityPolicy: "record-and-continue",
            archive: HOSTED_ARCHIVE_POLICY,
            resourceScope,
          },
          source,
          snapshot,
          signal,
        );
        for (const artifact of extraction.artifacts)
          files.push({
            id: randomUUID(),
            name: artifact.relative_path,
            relative: `extracted/${artifact.relative_path}`,
            size: artifact.bytes_written,
            sha256: artifact.sha256,
          });
        limitations.push(...extraction.limitations);
      } catch (cause: unknown) {
        await rm(join(folder, "extracted"), { recursive: true, force: true });
        limitations.push(
          "This container could be inspected but could not be safely extracted. Encrypted, linked, malformed, or unsupported members are not published separately.",
          ...publicReason(cause, source, submission.name),
        );
      }
    }
  } catch (cause: unknown) {
    limitations.push(
      "REA could not build a complete artifact graph for this input. Its original bytes, hash, hex view, and printable strings remain available.",
      ...publicReason(cause, source, submission.name),
    );
  } finally {
    await resourceScope.close();
  }
  const formatDetection = await detectSourceFormat(source, submission.name);
  const preview = await previewFile(source);
  // Structured text (F11): parsed once here; the server only serves stored pages.
  const document = await writeDocumentView(
    source,
    submission.name,
    folder,
    sha256,
    worker,
  ).catch(() => {
    limitations.push(
      "The structured-text reader could not finish for this file. Its original bytes, text, hex, and strings remain available.",
    );
    return null;
  });
  const documentObservations =
    document === null
      ? []
      : document.status === "skipped"
        ? []
        : [
            `Structured text: ${document.profile} (${document.encoding}), ${document.status}; ${document.node_count.toLocaleString("en-US")} structural nodes.`,
          ];
  if (document?.status === "skipped") limitations.push(document.reason);
  else if (document !== null && document.first_error !== null)
    limitations.push(`Structured text: ${document.first_error}`);
  // WebAssembly (F01): decoded once here in its own process; the server only serves stored pages.
  const wasm = await writeWasmView(
    source,
    submission.name,
    folder,
    sha256,
    worker,
  ).catch(() => {
    limitations.push(
      "The WebAssembly reader could not finish for this file. Its original bytes, hex, and strings remain available.",
    );
    return null;
  });
  if (wasm?.status === "skipped") limitations.push(wasm.reason);
  const wasmObservations =
    wasm === null || wasm.status === "skipped"
      ? []
      : [
          wasm.kind === "module"
            ? `WebAssembly core module: ${wasm.function_count.toLocaleString("en-US")} functions, validation ${wasm.validation}${wasm.unsupported_proposals.length ? `; not decoded: ${wasm.unsupported_proposals.join(", ")}` : ""}.`
            : `WebAssembly ${wasm.kind} binary: identified, not decoded.`,
        ];
  const report = {
    version: 1,
    generatedAt: new Date().toISOString(),
    name: submission.name,
    size: submission.size,
    sha256,
    format,
    format_detection: formatDetection,
    files: files.map(({ relative: _path, ...file }) => file),
    observations: [
      `Received ${submission.size.toLocaleString("en-US")} bytes.`,
      `SHA-256: ${sha256}`,
      `Artifact format: ${format}.`,
      `${files.length - 1} extracted files published.`,
      ...documentObservations,
      ...wasmObservations,
    ],
    limitations,
    preview,
    inventory,
    document,
    wasm,
  };
  const serialized = JSON.stringify(report);
  if (Buffer.byteLength(serialized) > 64 * 1024 ** 2)
    throw new Error("Artifact report exceeds the hosted 64 MiB output budget.");
  await writeFile(join(folder, "report.json"), serialized, { mode: 0o600 });
  await store.save({ ...submission, status: "ready", files, format });
};
