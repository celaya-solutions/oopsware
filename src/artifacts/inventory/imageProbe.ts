import type { FileHandle } from "node:fs/promises";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  hasValidTarChecksum,
  TAR_BLOCK_BYTES,
  type ContainerImageFormat,
} from "../../domain/archiveStreamFormat.js";
import { normalizeLayerPath } from "../../containerImage/layerPaths.js";
import { abortIfNeeded } from "../ArtifactHash.js";

/** Most member headers examined before a tar is called an ordinary tar. */
const MAX_PROBED_HEADERS = 8192;

const sizeOf = (header: Buffer): number | null => {
  const field = header.subarray(124, 136);
  if ((field[0] ?? 0) & 0x80) return null;
  const text = field.toString("latin1").replace(/\0.*$/su, "").trim();
  return /^[0-7]+$/u.test(text) ? Number.parseInt(text, 8) : null;
};

/** The marker files are small JSON; a larger one is not the marker. */
const MAX_MARKER_BYTES = 1024 * 1024;

const jsonOf = (bytes: Uint8Array): unknown => {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    return undefined;
  }
};

/** manifest.json is a common name; Docker's is an array of {Config, Layers}. */
const isDockerManifest = (bytes: Uint8Array): boolean => {
  const value = jsonOf(bytes);
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (entry: unknown) =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as Record<string, unknown>).Config === "string" &&
        Array.isArray((entry as Record<string, unknown>).Layers),
    )
  );
};

const isLayoutMarker = (bytes: Uint8Array): boolean => {
  const value = jsonOf(bytes);
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).imageLayoutVersion === "string"
  );
};

const readData = async (
  handle: FileHandle,
  offset: number,
  length: number,
): Promise<Buffer | null> => {
  if (length > MAX_MARKER_BYTES) return null;
  const bytes = Buffer.alloc(length);
  const { bytesRead } = await handle.read(bytes, 0, length, offset);
  return bytesRead === length ? bytes : null;
};

/** Records of a pax extended header: `<length> <key>=<value>\n`, as TarStream reads them. */
const paxRecords = (data: Buffer): Map<string, string> => {
  const records = new Map<string, string>();
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const length = Number.parseInt(
      data.toString("latin1", offset, space < 0 ? offset : space),
      10,
    );
    if (space < 0 || !Number.isInteger(length) || length <= 0) break;
    const record = data.toString("utf8", space + 1, offset + length - 1);
    const equals = record.indexOf("=");
    if (equals > 0)
      records.set(record.slice(0, equals), record.slice(equals + 1));
    offset += length;
  }
  return records;
};

/** Tar types whose data never follows the header, whatever the size field says. */
const NO_DATA = new Set(["1", "2", "3", "4", "5", "6"]);

const padded = (length: number): number =>
  Math.ceil(length / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;

/**
 * Decide from member names and their markers, not first bytes, whether a root
 * tar is a container image: a Docker save archive has a top-level
 * manifest.json that lists images (an array of Config and Layers), an OCI
 * archive an oci-layout with a layout version and an index.json. A tar
 * holding neither (a docker export, a source tree, a browser extension) stays
 * a plain tar. Headers are read by offset and data is skipped; pax and GNU
 * long-name records are applied as TarStream applies them. Only the first
 * 8192 members are examined.
 */
export const probeImageArchive = async (
  handle: FileHandle,
  size: number,
  signal?: AbortSignal,
): Promise<ContainerImageFormat | null> => {
  const found = new Set<string>();
  const header = Buffer.alloc(TAR_BLOCK_BYTES);
  let offset = 0;
  let longName: string | null = null;
  let paxName: string | null = null;
  let paxSize: number | null = null;
  for (let seen = 0; seen < MAX_PROBED_HEADERS; seen += 1) {
    abortIfNeeded(signal);
    if (offset + TAR_BLOCK_BYTES > size) break;
    const { bytesRead } = await handle.read(header, 0, TAR_BLOCK_BYTES, offset);
    if (bytesRead < TAR_BLOCK_BYTES || !hasValidTarChecksum(header)) break;
    const declared = sizeOf(header);
    if (declared === null) break;
    const typeflag =
      header[156] === 0 ? "0" : String.fromCharCode(header[156] ?? 0x30);
    const dataOffset = offset + TAR_BLOCK_BYTES;
    if (typeflag === "x" || typeflag === "L") {
      const data = await readData(handle, dataOffset, declared);
      if (data === null) break;
      if (typeflag === "L")
        longName = data.toString("utf8").replace(/\0.*$/su, "");
      else {
        const records = paxRecords(data);
        paxName = records.get("path") ?? null;
        const parsed = Number.parseInt(records.get("size") ?? "", 10);
        paxSize = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
      }
      offset = dataOffset + padded(declared);
      continue;
    }
    const dataLength = NO_DATA.has(typeflag) ? 0 : (paxSize ?? declared);
    if (typeflag === "0" || typeflag === "7") {
      const ustar = header.toString("latin1", 257, 263) === "ustar\0";
      const name = header.toString("utf8", 0, 100).replace(/\0.*$/su, "");
      const prefix = ustar
        ? header.toString("utf8", 345, 500).replace(/\0.*$/su, "")
        : "";
      const normalized = normalizeLayerPath(
        paxName ?? longName ?? (prefix === "" ? name : `${prefix}/${name}`),
      );
      if (normalized.kind === "path" && !normalized.path.includes("/")) {
        const data = await readData(handle, dataOffset, dataLength);
        if (
          normalized.path === "manifest.json" &&
          data !== null &&
          isDockerManifest(data)
        )
          return "docker-save-archive";
        if (
          normalized.path === "oci-layout" &&
          data !== null &&
          isLayoutMarker(data)
        )
          found.add("oci-layout");
        if (normalized.path === "index.json") found.add("index.json");
      }
      if (found.has("oci-layout") && found.has("index.json"))
        return "oci-image-archive";
    }
    longName = null;
    paxName = null;
    paxSize = null;
    offset = dataOffset + padded(dataLength);
  }
  return null;
};

/** A directory with an oci-layout file and an index.json is an OCI image layout. */
export const isImageLayoutDirectory = async (
  path: string,
): Promise<boolean> => {
  const regular = async (name: string): Promise<boolean> =>
    (await lstat(join(path, name)).catch(() => null))?.isFile() === true;
  if (!(await regular("oci-layout")) || !(await regular("index.json")))
    return false;
  const marker = await readFile(join(path, "oci-layout"))
    .then((bytes) => (bytes.length <= MAX_MARKER_BYTES ? bytes : null))
    .catch(() => null);
  return marker !== null && isLayoutMarker(marker);
};
