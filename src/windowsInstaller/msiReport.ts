import { createHash } from "node:crypto";
import { basename } from "node:path";

import type { WindowsInstallerReport } from "../domain/windowsInstaller/windowsInstaller.js";
import {
  CabFormatError,
  CabUnsupportedError,
  Cabinet,
  type CabFile,
} from "./cab.js";
import { CompoundFile } from "./cfb.js";
import { MsiDatabase } from "./msi/database.js";
import { msiFacts } from "./msi/facts.js";
import { summaryInformationOf } from "./msi/summaryInformation.js";

type Report = WindowsInstallerReport;
type FileRecord = Report["files"][number];

/** A cabinet the caller supplied, read once by the provider. */
export interface CabinetCompanion {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

const inMemory =
  (bytes: Uint8Array) =>
  (offset: number, length: number): Promise<Uint8Array> =>
    Promise.resolve(
      bytes.subarray(
        Math.min(bytes.length, offset),
        Math.min(bytes.length, offset + length),
      ),
    );

const sha256Hex = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Read freshly: the signal can abort while cabinets decode. */
const aborted = (signal?: AbortSignal): boolean => signal?.aborted === true;

const binaryKind = (bytes: Uint8Array): "pe" | "text" | "data" => {
  if (bytes[0] === 0x4d && bytes[1] === 0x5a) return "pe";
  if (bytes.includes(0)) return "data";
  try {
    utf8.decode(bytes);
    return "text";
  } catch {
    return "data";
  }
};

interface OpenedCabinet {
  readonly cabinet: Cabinet;
  readonly record: Report["cabinets"][number];
}

/** Every part of the report an MSI fills, without artifact identity, page, coverage or limitations. */
export type MsiParts = Omit<
  Report,
  | "artifact"
  | "package"
  | "file_count"
  | "page"
  | "files"
  | "coverage"
  | "limitations"
> & {
  readonly allFiles: FileRecord[];
};

/** Read an MSI: compound file, database, facts, cabinets (embedded and supplied), and each file's digest. */
export const readMsiInstaller = async (
  bytes: Uint8Array,
  companions: readonly CabinetCompanion[],
  budget: number,
  signal?: AbortSignal,
): Promise<MsiParts> => {
  const compound = await CompoundFile.open(inMemory(bytes), bytes.length);
  const database = await MsiDatabase.open(compound);
  const facts = msiFacts(database);
  const summary = await summaryInformationOf(compound);
  const diagnostics: Report["diagnostics"] = [
    ...compound.problems.map((message) => ({
      location: "compound file",
      message,
    })),
    ...facts.problems.map((message) => ({ location: "database", message })),
  ];
  const streams = new Map(
    database.streams.map((stream) => [stream.name, stream.entry]),
  );
  let remaining = budget;
  const cabinets = new Map<string, OpenedCabinet | null>();
  const open = async (
    name: string,
    source: "embedded" | "companion",
    path: string | null,
    cabinetBytes: Uint8Array,
    sha256: string,
  ): Promise<OpenedCabinet | null> => {
    try {
      const cabinet = await Cabinet.open(
        inMemory(cabinetBytes),
        cabinetBytes.length,
      );
      return {
        cabinet,
        record: {
          name,
          source,
          path,
          sha256,
          bytes: cabinetBytes.length,
          folders: cabinet.folders.map((folder) => ({
            compression: folder.compression,
            blocks: folder.blocks,
          })),
          files: cabinet.files.length,
          problems: [...cabinet.problems],
        },
      };
    } catch (cause) {
      diagnostics.push({
        location: name,
        message: `The cabinet could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
      });
      return null;
    }
  };
  const companionsByName = new Map(
    companions.map((companion) => [
      basename(companion.path).toLowerCase(),
      companion,
    ]),
  );
  const usedCompanions = new Set<string>();
  for (const media of facts.media) {
    const name = media.cabinet;
    if (name === null || cabinets.has(name.toLowerCase())) continue;
    if (media.embedded) {
      const entry = streams.get(name);
      if (entry === undefined) {
        diagnostics.push({
          location: "Media",
          message: `Disk ${String(media.disk_id)} names the embedded cabinet ${name}, which the database does not hold.`,
        });
        cabinets.set(name.toLowerCase(), null);
        continue;
      }
      const cabinetBytes = await compound.read(entry, entry.size);
      cabinets.set(
        name.toLowerCase(),
        await open(
          name,
          "embedded",
          null,
          cabinetBytes,
          sha256Hex(cabinetBytes),
        ),
      );
      continue;
    }
    const companion = companionsByName.get(basename(name).toLowerCase());
    if (companion === undefined) {
      diagnostics.push({
        location: "Media",
        message: `Disk ${String(media.disk_id)} names the external cabinet ${name}, which was not supplied; its files are not read.`,
      });
      cabinets.set(name.toLowerCase(), null);
      continue;
    }
    usedCompanions.add(companion.path);
    cabinets.set(
      name.toLowerCase(),
      await open(
        name,
        "companion",
        companion.path,
        companion.bytes,
        companion.sha256,
      ),
    );
  }
  for (const companion of companions)
    if (!usedCompanions.has(companion.path))
      diagnostics.push({
        location: companion.path,
        message:
          "The supplied cabinet is not named by any Media row; it was not read.",
      });
  const allFiles: FileRecord[] = [];
  for (const file of facts.files) {
    if (aborted(signal)) break;
    const media = file.media;
    const location: FileRecord["location"] =
      media === null
        ? "unknown"
        : media.cabinet === null
          ? "uncompressed"
          : media.embedded
            ? "embedded"
            : "external";
    let status: FileRecord["status"] = "not-read";
    let sha256: string | null = null;
    let md5: string | null = null;
    const opened =
      media?.cabinet == null
        ? undefined
        : cabinets.get(media.cabinet.toLowerCase());
    if (media?.cabinet != null && (opened === null || opened === undefined))
      status = "cabinet-missing";
    if (opened != null) {
      const member: CabFile | undefined = opened.cabinet.files.find(
        (entry) => entry.name === file.key,
      );
      if (member === undefined) status = "not-in-cabinet";
      else {
        const needed = opened.cabinet.decodedBytes(member);
        if (needed <= remaining) {
          remaining -= needed;
          try {
            const sha = createHash("sha256");
            const md = createHash("md5");
            for await (const piece of opened.cabinet.read(
              member,
              needed,
              signal,
            )) {
              sha.update(piece);
              md.update(piece);
            }
            sha256 = sha.digest("hex");
            md5 = md.digest("hex");
            status = "read";
          } catch (cause) {
            if (aborted(signal)) throw cause;
            if (cause instanceof CabUnsupportedError)
              status = "unsupported-compression";
            else if (cause instanceof CabFormatError) {
              // A damaged block spoils the files that need it; the report and other cabinets go on.
              status = "damaged";
              diagnostics.push({
                location: file.target_path,
                message: `The cabinet bytes could not be decoded: ${cause.message}`,
              });
            } else throw cause;
          }
        } else {
          status = "over-budget";
          diagnostics.push({
            location: file.target_path,
            message:
              "The decode budget (max_decoded_bytes) ran out before this file.",
          });
        }
      }
    }
    const declared = file.hash?.md5 ?? null;
    allFiles.push({
      key: file.key,
      component: file.component,
      name: file.name,
      short_name: file.short_name,
      size: file.size,
      version: file.version,
      language: file.language,
      attributes: [...file.attributes],
      sequence: file.sequence,
      target_path: file.target_path,
      disk_id: media?.disk_id ?? null,
      cabinet: media?.cabinet ?? null,
      location,
      status,
      sha256,
      md5:
        declared === null
          ? null
          : {
              declared,
              computed: md5,
              valid: md5 === null ? null : md5 === declared,
            },
    });
    if (declared !== null && md5 !== null && md5 !== declared)
      diagnostics.push({
        location: file.target_path,
        message: "The file's bytes do not match its MsiFileHash.",
      });
  }
  const binaries: Report["binaries"] = [];
  for (const binary of facts.binaries) {
    const entry = streams.get(binary.stream);
    const content =
      entry === undefined ? null : await compound.read(entry, entry.size);
    binaries.push({
      name: binary.name,
      stream: binary.stream,
      bytes: binary.size,
      sha256: content === null ? null : sha256Hex(content),
      kind: content === null ? null : binaryKind(content),
    });
  }
  const { properties: _stored, ...summaryFacts } = summary ?? {
    properties: [],
  };
  void _stored;
  return {
    compound: {
      version: compound.version,
      sector_size: compound.sectorSize,
      codepage: database.codepage,
      streams: database.streams.map((stream) => ({
        name: stream.name,
        bytes: stream.entry.size,
      })),
      storages: [...database.storages],
    },
    summary:
      summary === null
        ? null
        : {
            ...(summaryFacts as Omit<
              NonNullable<typeof summary>,
              "properties"
            >),
            platforms: [...summary.platforms],
            languages: [...summary.languages],
            source_flags: [...summary.source_flags],
            problems: [...summary.problems],
          },
    product: { ...facts.product },
    properties: facts.properties.map((entry) => ({ ...entry })),
    tables: [...database.tables.values()].map((table) => ({
      name: table.name,
      columns: table.columns.length,
      rows: table.rows.length,
    })),
    features: facts.features.map((entry) => ({
      ...entry,
      attributes: [...entry.attributes],
      components: [...entry.components],
      conditions: entry.conditions.map((condition) => ({ ...condition })),
    })),
    components: facts.components.map((entry) => ({
      ...entry,
      attributes: [...entry.attributes],
    })),
    directories: facts.directories.map((entry) => ({ ...entry })),
    media: facts.media.map((entry) => ({ ...entry })),
    cabinets: [...cabinets.values()].flatMap((entry) =>
      entry === null ? [] : [entry.record],
    ),
    registry: facts.registry.map((entry) => ({ ...entry })),
    services: facts.services.map((entry) => ({
      ...entry,
      type: [...entry.type],
      events: [...entry.events],
    })),
    shortcuts: facts.shortcuts.map((entry) => ({ ...entry })),
    environment: facts.environment.map((entry) => ({
      ...entry,
      flags: [...entry.flags],
    })),
    ini_files: facts.ini_files.map((entry) => ({ ...entry })),
    custom_actions: facts.custom_actions.map((entry) => ({
      ...entry,
      execution: [...entry.execution],
      scheduled: entry.scheduled.map((item) => ({ ...item })),
    })),
    sequences: facts.sequences.map((entry) => ({
      table: entry.table,
      actions: entry.actions.map((action) => ({ ...action })),
    })),
    launch_conditions: facts.launch_conditions.map((entry) => ({ ...entry })),
    upgrades: facts.upgrades.map((entry) => ({
      ...entry,
      attributes: [...entry.attributes],
    })),
    binaries,
    signature: {
      digital_signature: facts.signature.digital_signature,
      ex: facts.signature.ex,
      verified: false,
    },
    diagnostics,
    allFiles,
  };
};
