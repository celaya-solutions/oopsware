import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";

import { assertArtifactReadActive } from "./ArtifactFileOperation.js";
import { ArtifactReaderFailure } from "./ArtifactReader.js";
import { err, ok, type Result } from "../domain/result.js";

/** Shared resource budget for the eagerly decoded ASAR header, not member bytes. */
export const MAX_ASAR_HEADER_BYTES = 16 * 1024 * 1024;

/** Absolute archive prefix required to inspect an admitted header. */
export const MAX_ASAR_HEADER_PROBE_BYTES = MAX_ASAR_HEADER_BYTES + 8;

export interface AsarHeaderExtents {
  readonly archiveBytes: number;
  readonly headerBytes: number;
  readonly jsonBytes: number;
}

export type AsarHeaderProbeExtents = Pick<
  AsarHeaderExtents,
  "headerBytes" | "jsonBytes"
> & { readonly archiveBytes?: number };

export type AsarHeaderProbeObservation =
  | {
      readonly state: "pending";
      readonly extents?: AsarHeaderProbeExtents;
      readonly scannedJsonBytes: number;
    }
  | {
      /** The declared JSON begins with an object token; this does not validate JSON. */
      readonly state: "matched";
      readonly extents: AsarHeaderProbeExtents;
      readonly signatureOffset: number;
      readonly scannedJsonBytes: number;
    }
  | {
      readonly state: "rejected";
      readonly reason:
        | "invalid-pickle-extents"
        | "archive-too-short"
        | "json-not-object";
      readonly extents?: AsarHeaderProbeExtents;
      readonly scannedJsonBytes: number;
    }
  | {
      readonly state: "limit";
      readonly extents?: AsarHeaderProbeExtents;
      readonly scannedJsonBytes: number;
      readonly limitBytes: number;
    };

export type FinalAsarHeaderProbeObservation = Exclude<
  AsarHeaderProbeObservation,
  { readonly state: "pending" }
>;

/**
 * Parse the fixed two-Pickle prefix and optionally check it against the actual
 * observed archive size. This establishes byte extents only; JSON validity and
 * the ASAR header schema belong to the decoder at the interpretation boundary.
 */
export const parseAsarHeaderExtents = (
  prefix: Uint8Array,
  archiveBytes?: number,
): Result<Omit<AsarHeaderExtents, "archiveBytes">, ArtifactReaderFailure> => {
  if (prefix.byteLength < 16)
    return err(
      new ArtifactReaderFailure(
        "format",
        "Truncated ASAR Pickle extent prefix",
      ),
    );
  const bytes = Buffer.from(prefix.buffer, prefix.byteOffset, 16);
  const headerBytes = bytes.readUInt32LE(4);
  const payloadBytes = bytes.readUInt32LE(8);
  const jsonBytes = bytes.readUInt32LE(12);
  if (
    bytes.readUInt32LE(0) !== 4 ||
    headerBytes < 8 ||
    payloadBytes !== headerBytes - 4 ||
    jsonBytes > payloadBytes - 4
  )
    return err(
      new ArtifactReaderFailure(
        "format",
        "ASAR header has invalid Pickle extents",
      ),
    );
  if (
    archiveBytes !== undefined &&
    (!Number.isSafeInteger(archiveBytes) ||
      archiveBytes < 8 ||
      headerBytes > archiveBytes - 8)
  )
    return err(
      new ArtifactReaderFailure(
        "format",
        "ASAR header leaves its observed container",
      ),
    );
  return ok({ headerBytes, jsonBytes });
};

/**
 * Bounded ASAR signature probe. It retains only the 16-byte fixed prefix and
 * scans the declared JSON bytes until the first non-JSON-whitespace byte.
 */
export interface AsarHeaderSignatureProbe {
  readonly limit: number;
  readonly observation: AsarHeaderProbeObservation;
  write(input: Uint8Array): AsarHeaderProbeObservation;
  finish(archiveBytes: number): FinalAsarHeaderProbeObservation;
}

class AsarHeaderSignatureProbeImpl implements AsarHeaderSignatureProbe {
  readonly limit = MAX_ASAR_HEADER_PROBE_BYTES;
  readonly #fixed = Buffer.alloc(16);
  #fixedBytes = 0;
  #scannedJsonBytes = 0;
  #extents: Omit<AsarHeaderExtents, "archiveBytes"> | undefined;
  #stop: ProbeStop = { state: "pending" };

  get observation(): AsarHeaderProbeObservation {
    return this.#observation();
  }

  /** Consume sequential archive bytes without retaining JSON or member data. */
  write(input: Uint8Array): AsarHeaderProbeObservation {
    if (this.#stop.state === "finalized") return this.#stop.observation;
    const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    let offset = 0;
    while (offset < bytes.length && !this.#isTerminal()) {
      if (this.#fixedBytes < this.#fixed.length) {
        const count = Math.min(
          this.#fixed.length - this.#fixedBytes,
          bytes.length - offset,
        );
        bytes.copy(this.#fixed, this.#fixedBytes, offset, offset + count);
        this.#fixedBytes += count;
        offset += count;
        if (this.#fixedBytes === this.#fixed.length) this.#parseFixed();
        continue;
      }
      const extents = this.#extents;
      if (extents === undefined || this.#stop.state === "matched") break;
      const jsonRemaining = extents.jsonBytes - this.#scannedJsonBytes;
      if (jsonRemaining <= 0) {
        this.#stop = { state: "rejected", reason: "json-not-object" };
        break;
      }
      const archiveBytesScanned = 16 + this.#scannedJsonBytes;
      if (archiveBytesScanned >= this.limit) {
        this.#stop = { state: "limit" };
        break;
      }
      const count = Math.min(
        bytes.length - offset,
        jsonRemaining,
        this.limit - archiveBytesScanned,
      );
      for (let index = 0; index < count; index += 1) {
        const value = bytes[offset + index]!;
        if (!isJsonWhitespace(value)) {
          if (value === 0x7b)
            this.#stop = {
              state: "matched",
              signatureOffset: 16 + this.#scannedJsonBytes,
              extents,
            };
          else this.#stop = { state: "rejected", reason: "json-not-object" };
          break;
        }
        this.#scannedJsonBytes += 1;
      }
      offset += count;
      if (this.#stop.state !== "pending") break;
      if (this.#scannedJsonBytes >= extents.jsonBytes) {
        this.#stop = { state: "rejected", reason: "json-not-object" };
        break;
      }
      if (16 + this.#scannedJsonBytes >= this.limit)
        this.#stop = { state: "limit" };
    }
    return this.#observation();
  }

  /** Finalize against the actual byte count; a signature alone is not validity. */
  finish(archiveBytes: number): FinalAsarHeaderProbeObservation {
    if (this.#stop.state === "finalized") return this.#stop.observation;
    if (this.#fixedBytes < this.#fixed.length) {
      this.#stop = { state: "rejected", reason: "invalid-pickle-extents" };
    } else if (this.#extents !== undefined) {
      if (
        !Number.isSafeInteger(archiveBytes) ||
        archiveBytes < 8 ||
        this.#extents.headerBytes > archiveBytes - 8
      ) {
        this.#stop = { state: "rejected", reason: "archive-too-short" };
      } else if (
        this.#extents.headerBytes > MAX_ASAR_HEADER_BYTES &&
        this.#stop.state === "matched"
      ) {
        this.#stop = { state: "limit" };
      }
    }
    const observation = this.#observation(archiveBytes);
    this.#stop = { state: "finalized", observation };
    return observation;
  }

  #parseFixed(): void {
    const result = parseAsarHeaderExtents(this.#fixed);
    if (!result.ok) {
      this.#stop = { state: "rejected", reason: "invalid-pickle-extents" };
      return;
    }
    this.#extents = result.value;
    if (this.#extents.jsonBytes === 0)
      this.#stop = { state: "rejected", reason: "json-not-object" };
  }

  #isTerminal(): boolean {
    return this.#stop.state !== "pending";
  }

  #observation(): AsarHeaderProbeObservation;
  #observation(archiveBytes: number): FinalAsarHeaderProbeObservation;
  #observation(
    archiveBytes?: number,
  ): AsarHeaderProbeObservation | FinalAsarHeaderProbeObservation {
    if (this.#stop.state === "finalized") return this.#stop.observation;
    const extents: AsarHeaderProbeExtents | undefined =
      this.#extents === undefined
        ? undefined
        : archiveBytes === undefined
          ? this.#extents
          : { archiveBytes, ...this.#extents };
    switch (this.#stop.state) {
      case "rejected":
        return {
          state: "rejected",
          reason: this.#stop.reason,
          ...(extents === undefined ? {} : { extents }),
          scannedJsonBytes: this.#scannedJsonBytes,
        };
      case "limit":
        return {
          state: "limit",
          ...(extents === undefined ? {} : { extents }),
          scannedJsonBytes: this.#scannedJsonBytes,
          limitBytes: this.limit,
        };
      case "matched":
        return {
          state: "matched",
          extents:
            archiveBytes === undefined
              ? this.#stop.extents
              : { archiveBytes, ...this.#stop.extents },
          signatureOffset: this.#stop.signatureOffset,
          scannedJsonBytes: this.#scannedJsonBytes,
        };
      case "pending":
        if (archiveBytes !== undefined && this.#extents !== undefined) {
          const finalizedExtents = {
            archiveBytes,
            ...this.#extents,
          };
          if (this.#scannedJsonBytes >= this.#extents.jsonBytes)
            return {
              state: "rejected",
              reason: "json-not-object",
              extents: finalizedExtents,
              scannedJsonBytes: this.#scannedJsonBytes,
            };
          return {
            state: "limit",
            extents: finalizedExtents,
            scannedJsonBytes: this.#scannedJsonBytes,
            limitBytes: this.limit,
          };
        }
        return {
          state: "pending",
          ...(extents === undefined ? {} : { extents }),
          scannedJsonBytes: this.#scannedJsonBytes,
        };
    }
  }
}

type ProbeStop =
  | { readonly state: "pending" }
  | {
      readonly state: "matched";
      readonly signatureOffset: number;
      readonly extents: Omit<AsarHeaderExtents, "archiveBytes">;
    }
  | {
      readonly state: "rejected";
      readonly reason:
        | "invalid-pickle-extents"
        | "archive-too-short"
        | "json-not-object";
    }
  | { readonly state: "limit" }
  | {
      readonly state: "finalized";
      readonly observation: FinalAsarHeaderProbeObservation;
    };

const isJsonWhitespace = (value: number): boolean =>
  value === 0x20 || value === 0x09 || value === 0x0a || value === 0x0d;

/** Admit Pickle extents before an upstream decoder allocates them. */
export const admitAsarHeader = async (
  handle: Pick<FileHandle, "read"> & { stat(): Promise<Stats> },
  signal?: AbortSignal,
): Promise<AsarHeaderExtents> => {
  assertArtifactReadActive(signal);
  const observed = await handle.stat();
  assertArtifactReadActive(signal);
  if (!observed.isFile())
    throw new ArtifactReaderFailure(
      "format",
      "ASAR container is not a regular file",
    );
  const prefix = Buffer.alloc(16);
  let bytesRead = 0;
  while (bytesRead < prefix.length) {
    assertArtifactReadActive(signal);
    const read = await handle.read(
      prefix,
      bytesRead,
      prefix.length - bytesRead,
      bytesRead,
    );
    assertArtifactReadActive(signal);
    if (read.bytesRead === 0)
      throw new ArtifactReaderFailure("format", "Truncated ASAR size pickle");
    bytesRead += read.bytesRead;
  }
  const parsed = parseAsarHeaderExtents(prefix, observed.size);
  if (!parsed.ok) throw parsed.error;
  if (parsed.value.headerBytes > MAX_ASAR_HEADER_BYTES)
    throw new ArtifactReaderFailure(
      "limit",
      `ASAR header exceeds the ${String(MAX_ASAR_HEADER_BYTES)} byte decode budget`,
    );
  return {
    archiveBytes: observed.size,
    ...parsed.value,
  };
};

export const createAsarHeaderSignatureProbe = (): AsarHeaderSignatureProbe =>
  new AsarHeaderSignatureProbeImpl();
