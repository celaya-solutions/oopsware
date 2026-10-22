import { randomUUID } from "node:crypto";
import { gunzipSync, zstdDecompressSync } from "node:zlib";

import type { ArtifactCommand } from "../domain/artifactGraph.js";
import { resolveArchiveDecoder } from "../artifacts/archives/ArchiveDecoderTools.js";
import type { PayloadCompression } from "../artifacts/archives/LinuxPackagePayload.js";
import { cleanupOwnedProcessGroup } from "../process/ProcessOwnership.js";
import {
  ProviderProcessSupervisor,
  spawnOwnedProviderProcess,
} from "../process/ProviderProcess.js";

/** Why a package member could not be decoded; the caller reports it, it never guesses. */
export class PayloadDecodeFailure extends Error {
  constructor(
    readonly reason: "budget" | "unavailable" | "format" | "cancelled",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PayloadDecodeFailure";
  }
}

export interface DecodedPayload {
  readonly bytes: Buffer;
  /** The decoder that ran, as provenance. */
  readonly command: ArtifactCommand | null;
}

const EXIT_WAIT_MS = 30_000;
const DIAGNOSTIC_BYTES = 16 * 1024;

const inProcess = (
  compression: "gzip" | "zstd",
  bytes: Uint8Array,
  limit: number,
): DecodedPayload => {
  try {
    const options = { maxOutputLength: limit };
    return {
      bytes:
        compression === "gzip"
          ? gunzipSync(bytes, options)
          : zstdDecompressSync(bytes, options),
      command: {
        tool: "node:zlib",
        arguments: [compression === "gzip" ? "gunzip" : "zstdDecompress"],
        tool_version:
          compression === "gzip"
            ? `zlib ${process.versions.zlib ?? "unknown"}`
            : `zstd ${process.versions.zstd ?? "unknown"}`,
        executable_sha256: null,
        exit_code: null,
        effects: ["read"],
      },
    };
  } catch (cause) {
    if (cause instanceof RangeError)
      throw new PayloadDecodeFailure(
        "budget",
        `Decoding passes the ${String(limit)}-byte budget (max_decoded_bytes).`,
        { cause },
      );
    throw new PayloadDecodeFailure(
      "format",
      `The ${compression} data is damaged: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
};

/** Run the installed xz (fixed install paths, digest recorded) over in-memory bytes. */
const withXz = async (
  compression: "xz" | "lzma",
  bytes: Uint8Array,
  limit: number,
  signal?: AbortSignal,
): Promise<DecodedPayload> => {
  const resolved = await resolveArchiveDecoder("xz", signal);
  if (!resolved.ok)
    throw new PayloadDecodeFailure("unavailable", resolved.error.message);
  const decoder = resolved.value;
  const args = [
    "--decompress",
    "--stdout",
    ...(compression === "lzma" ? ["--format=lzma"] : []),
  ];
  const spawned = await spawnOwnedProviderProcess({
    command: decoder.executable,
    arguments: args,
    runId: randomUUID(),
    hostEnvironment: {},
    env: { LC_ALL: process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8" },
    stdin: "pipe",
    ...(signal === undefined ? {} : { signal }),
  });
  const supervisor = new ProviderProcessSupervisor(
    {
      ...spawned,
      ownsProcessLifetime: true,
      cleanup:
        spawned.cleanup ?? (() => cleanupOwnedProcessGroup(spawned.ownership)),
    },
    { captureStdout: false, maxDiagnosticBytes: DIAGNOSTIC_BYTES },
  );
  try {
    const { stdin, stdout } = spawned.process;
    if (stdin === null || stdin === undefined || stdout === null)
      throw new PayloadDecodeFailure(
        "format",
        "xz has no input or output stream.",
      );
    stdin.on("error", () => undefined);
    stdin.end(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of stdout as AsyncIterable<Buffer>) {
      total += chunk.length;
      if (total > limit)
        throw new PayloadDecodeFailure(
          "budget",
          `Decoding passes the ${String(limit)}-byte budget (max_decoded_bytes).`,
        );
      chunks.push(chunk);
    }
    const exited = await supervisor.waitForExit(EXIT_WAIT_MS);
    const snapshot = supervisor.snapshot();
    const exitCode = snapshot.exitCode ?? null;
    if (signal?.aborted === true)
      throw new PayloadDecodeFailure("cancelled", "The decode was cancelled.");
    if (!exited || exitCode !== 0)
      throw new PayloadDecodeFailure(
        "format",
        `xz could not decode the data (${exited ? `exit ${String(exitCode)}` : "no exit"}): ${snapshot.stderr.text.trim()}`,
      );
    return {
      bytes: Buffer.concat(chunks, total),
      command: {
        tool: decoder.tool,
        arguments: args,
        tool_version: decoder.version,
        executable_sha256: decoder.executableSha256,
        exit_code: exitCode,
        effects: ["read"],
      },
    };
  } finally {
    await supervisor.stop().catch(() => undefined);
  }
};

/** Decode one compressed package member held in memory, inside `limit` decoded bytes. */
export const decodePayload = async (
  compression: PayloadCompression,
  bytes: Uint8Array,
  limit: number,
  signal?: AbortSignal,
): Promise<DecodedPayload> => {
  switch (compression) {
    case "none":
      if (bytes.length > limit)
        throw new PayloadDecodeFailure(
          "budget",
          `The member is larger than the ${String(limit)}-byte budget (max_decoded_bytes).`,
        );
      return { bytes: Buffer.from(bytes), command: null };
    case "gzip":
    case "zstd":
      return inProcess(compression, bytes, limit);
    case "xz":
    case "lzma":
      return withXz(compression, bytes, limit, signal);
    case "bzip2":
      throw new PayloadDecodeFailure(
        "unavailable",
        "bzip2 data is not decoded by this reader.",
      );
  }
};
