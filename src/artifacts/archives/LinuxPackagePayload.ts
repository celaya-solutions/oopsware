import type { FileHandle } from "node:fs/promises";

import {
  rpmStrippedFiles,
  type CpioStrippedLookup,
} from "../../linuxPackage/cpio.js";
import { debLayout, readArMembers } from "../../linuxPackage/deb/ar.js";
import { readRpm } from "../../linuxPackage/rpm/header.js";
import { rpmFacts } from "../../linuxPackage/rpm/facts.js";

/** Compressors a Debian member or an RPM payload may declare. */
export type PayloadCompression =
  | "none"
  | "gzip"
  | "zstd"
  | "xz"
  | "lzma"
  | "bzip2";

/** Where the installable contents of a .deb or .rpm are, and how they are encoded. */
export interface LinuxPayload {
  /** Byte range of the (compressed) payload in the package file. */
  readonly start: number;
  readonly end: number;
  readonly compression: PayloadCompression;
  readonly container: "tar" | "cpio";
  readonly observations: readonly string[];
  /** For an RPM, what each stripped cpio member's file index names, by rpm's own rule (a hard link's bytes travel with its last link). */
  readonly files: CpioStrippedLookup | null;
}

/** Why the contents cannot be listed; the package is still identified. */
export interface LinuxPayloadOmission {
  readonly omission: string;
}

const positional =
  (handle: FileHandle) =>
  async (offset: number, length: number): Promise<Uint8Array> => {
    const buffer = Buffer.alloc(length);
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await handle.read(
        buffer,
        filled,
        length - filled,
        offset + filled,
      );
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return buffer.subarray(0, filled);
  };

const RPM_COMPRESSORS: Readonly<Record<string, PayloadCompression>> = {
  gzip: "gzip",
  zstd: "zstd",
  xz: "xz",
  lzma: "lzma",
  bzip2: "bzip2",
  identity: "none",
};

/** Locate data.tar.* in a Debian package; the control archive is read by inspect_linux_package. */
const debPayload = async (
  handle: FileHandle,
  size: number,
): Promise<LinuxPayload | LinuxPayloadOmission> => {
  const read = positional(handle);
  const { members, trailing_bytes } = await readArMembers(read, size);
  const first = members[0];
  const binary =
    first?.name === "debian-binary"
      ? await read(first.data_offset, Math.min(first.size, 64))
      : null;
  const layout = debLayout(members, binary);
  const data = layout.data;
  if (data === null)
    return {
      omission: `The Debian package has no data.tar member; its contents cannot be listed.${layout.problems.length > 0 ? ` ${layout.problems.join(" ")}` : ""}`,
    };
  return {
    start: data.member.data_offset,
    end: data.member.data_offset + data.member.size,
    compression: data.compression,
    container: "tar",
    files: null,
    observations: [
      `Debian package format ${JSON.stringify(layout.format_version ?? "unknown")}: contents are the ${String(data.member.size)}-byte ${data.member.name} member at byte ${String(data.member.data_offset)}; the control archive and maintainer scripts are read by inspect_linux_package, not listed here.`,
      ...layout.problems,
      ...(trailing_bytes > 0
        ? [
            `${String(trailing_bytes)} bytes follow the last ar member and were not read.`,
          ]
        : []),
    ],
  };
};

/** Locate the payload after an RPM's lead, signature header and main header. */
const rpmPayload = async (
  handle: FileHandle,
  size: number,
): Promise<LinuxPayload | LinuxPayloadOmission> => {
  const file = await readRpm(positional(handle), size);
  const facts = rpmFacts(file);
  const format = facts.payload.format ?? "cpio";
  if (format !== "cpio")
    return {
      omission: `The RPM payload format is ${JSON.stringify(format)}; only cpio payloads are listed.`,
    };
  const declared = facts.payload.compressor ?? "gzip";
  const compression = RPM_COMPRESSORS[declared];
  if (compression === undefined)
    return {
      omission: `The RPM payload compressor ${JSON.stringify(declared)} is not one this reader decodes.`,
    };
  return {
    start: file.payload_offset,
    end: size,
    compression,
    container: "cpio",
    files: rpmStrippedFiles(facts.files),
    observations: [
      `RPM ${String(file.lead.major)}.${String(file.lead.minor)} package: the ${declared} cpio payload starts at byte ${String(file.payload_offset)}; scriptlets and declared dependencies are read by inspect_linux_package, not run.`,
      ...file.signature.problems,
      ...file.header.problems,
    ],
  };
};

/** Find the installable payload of a Debian or RPM package without running anything. */
export const locateLinuxPayload = (
  handle: FileHandle,
  size: number,
  format: "deb" | "rpm",
): Promise<LinuxPayload | LinuxPayloadOmission> =>
  format === "deb" ? debPayload(handle, size) : rpmPayload(handle, size);
