import { elfHeader } from "../jvm/jarMetadata.js";
import type { ArtifactCommand } from "../domain/artifactGraph.js";
import {
  MAX_LINUX_SCRIPT_BYTES,
  type LinuxPackageReport,
} from "../domain/linuxPackage/linuxPackage.js";
import { hasAppImageMagic, readAppImageRuntime } from "./appimage.js";
import { parseDesktopEntry } from "./desktopEntry.js";
import {
  parseSquashfsSuperblock,
  SquashfsImage,
  SquashfsUnsupportedError,
  SUPERBLOCK_BYTES,
  type SquashfsEntry,
  type SquashfsSuperblock,
} from "./squashfs/squashfs.js";
import {
  diagnostic,
  modeFacts,
  positional,
  sha256Hex,
  type FileRecord,
} from "./report.js";

type Report = LinuxPackageReport;

/** The parts of the report an AppImage or bare SquashFS image fills. */
export interface ImageParts {
  readonly identity: Report["identity"];
  readonly dependencies: Report["dependencies"];
  readonly scripts: Report["scripts"];
  readonly triggers: Report["triggers"];
  readonly appimage: Report["appimage"];
  readonly squashfs: Report["squashfs"];
  readonly files: FileRecord[];
  readonly commands: (ArtifactCommand | null)[];
  readonly diagnostics: Report["diagnostics"];
  /** False when the filesystem is identified but not read (Type 1, unsupported compression). */
  readonly listed: boolean;
}

/** Bytes AppRun's head is read to name its interpreter or ELF machine. */
const HEAD_BYTES = 4096;

/** At most `cap` bytes of a file, stopping the image read there. */
const readCapped = async (
  image: SquashfsImage,
  entry: SquashfsEntry,
  cap: number,
  signal?: AbortSignal,
): Promise<{ bytes: Buffer; truncated: boolean }> => {
  const pieces: Uint8Array[] = [];
  let total = 0;
  for await (const piece of image.read(entry, signal)) {
    pieces.push(piece);
    total += piece.length;
    if (total >= cap) break;
  }
  const bytes = Buffer.concat(pieces);
  return { bytes: bytes.subarray(0, cap), truncated: entry.size > cap };
};

const superblockFacts = (
  superblock: SquashfsSuperblock,
): NonNullable<Report["squashfs"]> => ({
  version: superblock.version,
  compression: superblock.compression,
  block_size: superblock.block_size,
  inode_count: superblock.inode_count,
  fragment_count: superblock.fragment_count,
  bytes_used: superblock.bytes_used,
  mkfs_time: superblock.mkfs_time,
  flags: [...superblock.flags],
});

const fileRecord = (entry: SquashfsEntry): FileRecord => ({
  path: `/${entry.path}`,
  type: entry.type,
  ...modeFacts(entry.mode),
  uid: entry.uid,
  gid: entry.gid,
  user: null,
  group: null,
  size: entry.type === "file" ? entry.size : null,
  mtime: entry.mtime,
  link_target: entry.link_target,
  flags: entry.hard_links > 1 && entry.type === "file" ? ["hard-link"] : [],
  digest: null,
});

const NO_DECLARATIONS = {
  dependencies: [],
  scripts: [],
  triggers: [],
  commands: [],
};

/** Read an AppImage (runtime, then its SquashFS image) or a bare SquashFS image; nothing is executed or mounted. */
export const readImagePackage = async (
  bytes: Uint8Array,
  kind: "appimage" | "squashfs",
  signal?: AbortSignal,
): Promise<ImageParts> => {
  const diagnostics: Report["diagnostics"] = [];
  let base = 0;
  let runtimeFacts: Omit<
    NonNullable<Report["appimage"]>,
    "desktop" | "app_run" | "icon"
  > | null = null;
  if (kind === "appimage") {
    const type = hasAppImageMagic(bytes) ?? 2;
    const runtime = await readAppImageRuntime(positional(bytes), bytes.length);
    diagnostics.push(
      ...runtime.problems.map((problem) => diagnostic("runtime", problem)),
    );
    base = runtime.payload_offset;
    runtimeFacts = {
      type,
      runtime: {
        bytes: Math.min(base, bytes.length),
        sha256: sha256Hex(bytes.subarray(0, Math.min(base, bytes.length))),
        elf_class: runtime.elf.class,
        machine: runtime.elf.machine,
      },
      update_information: runtime.update_information,
      signature_bytes: runtime.signature?.bytes ?? null,
      signing_key_bytes: runtime.signing_key?.bytes ?? null,
      digest_md5: runtime.digest_md5,
      squashfs_offset: type === 2 && base < bytes.length ? base : null,
    };
    if (type === 1) {
      diagnostics.push(
        diagnostic(
          "runtime",
          "A Type 1 AppImage (ISO 9660 payload) is identified only; its files are not listed.",
        ),
      );
      return {
        identity: {
          name: null,
          version: null,
          release: null,
          epoch: null,
          architecture: runtime.elf.machine,
          summary: null,
        },
        ...NO_DECLARATIONS,
        appimage: { ...runtimeFacts, desktop: null, app_run: null, icon: null },
        squashfs: null,
        files: [],
        diagnostics,
        listed: false,
      };
    }
  }
  const size = bytes.length - base;
  let superblock: Report["squashfs"] = null;
  try {
    superblock = superblockFacts(
      parseSquashfsSuperblock(
        bytes.subarray(base, base + SUPERBLOCK_BYTES),
        size,
      ).superblock,
    );
  } catch {
    // SquashfsImage.open below reports the same problem as a typed error.
  }
  let image: SquashfsImage;
  try {
    image = await SquashfsImage.open(positional(bytes, base), size);
  } catch (cause) {
    if (!(cause instanceof SquashfsUnsupportedError)) throw cause;
    diagnostics.push(
      diagnostic(
        "squashfs",
        `The SquashFS image is identified but not read: ${cause.message}`,
        base,
      ),
    );
    return {
      identity: {
        name: null,
        version: null,
        release: null,
        epoch: null,
        architecture: runtimeFacts?.runtime.machine ?? null,
        summary: null,
      },
      ...NO_DECLARATIONS,
      appimage:
        runtimeFacts === null
          ? null
          : { ...runtimeFacts, desktop: null, app_run: null, icon: null },
      squashfs: superblock,
      files: [],
      diagnostics,
      listed: false,
    };
  }
  const entries: SquashfsEntry[] = [];
  for await (const entry of image.entries(signal)) entries.push(entry);
  diagnostics.push(
    ...image.problems.map((problem) =>
      diagnostic(
        "squashfs",
        problem.message,
        problem.offset === null ? null : base + problem.offset,
      ),
    ),
  );
  const files = entries.map(fileRecord);
  if (runtimeFacts === null)
    return {
      identity: {
        name: null,
        version: null,
        release: null,
        epoch: null,
        architecture: null,
        summary: null,
      },
      ...NO_DECLARATIONS,
      appimage: null,
      squashfs: superblockFacts(image.superblock),
      files,
      diagnostics,
      listed: true,
    };
  const root = entries.filter((entry) => !entry.path.includes("/"));
  const desktops = root.filter(
    (entry) => entry.type === "file" && entry.path.endsWith(".desktop"),
  );
  if (desktops.length !== 1)
    diagnostics.push(
      diagnostic(
        "squashfs",
        `The AppImage root holds ${String(desktops.length)} desktop entries; the format expects one.`,
      ),
    );
  let desktop: NonNullable<Report["appimage"]>["desktop"] = null;
  const desktopEntry = desktops[0];
  if (desktopEntry !== undefined) {
    const { bytes: text, truncated } = await readCapped(
      image,
      desktopEntry,
      MAX_LINUX_SCRIPT_BYTES,
      signal,
    );
    const parsed = parseDesktopEntry(text.toString("utf8"));
    desktop = {
      path: `/${desktopEntry.path}`,
      entries: (
        parsed.groups.find((group) => group.name === "Desktop Entry")
          ?.entries ?? []
      ).map((entry) => ({ ...entry })),
      problems: [
        ...parsed.problems,
        ...(truncated
          ? [
              `Only the first ${String(MAX_LINUX_SCRIPT_BYTES)} bytes were read.`,
            ]
          : []),
      ],
    };
  }
  const value = (key: string): string | null =>
    desktop?.entries.find((entry) => entry.key === key && entry.locale === null)
      ?.value ?? null;
  const appRun = root.find((entry) => entry.path === "AppRun");
  let app_run: NonNullable<Report["appimage"]>["app_run"] = null;
  if (appRun === undefined)
    diagnostics.push(
      diagnostic("squashfs", "The AppImage root has no AppRun entry point."),
    );
  else if (appRun.type === "file") {
    const { bytes: head } = await readCapped(image, appRun, HEAD_BYTES, signal);
    const text = head.toString("latin1");
    app_run = {
      type: "file",
      interpreter: text.startsWith("#!")
        ? (text.slice(2).split("\n")[0] ?? "").trim()
        : null,
      elf_machine: elfHeader(head)?.machine ?? null,
      link_target: null,
    };
  } else
    app_run = {
      type: appRun.type,
      interpreter: null,
      elf_machine: null,
      link_target: appRun.link_target,
    };
  const icon = root.find((entry) => entry.path === ".DirIcon");
  return {
    identity: {
      name: value("Name"),
      version: value("X-AppImage-Version"),
      release: null,
      epoch: null,
      architecture: runtimeFacts.runtime.machine,
      summary: value("Comment"),
    },
    ...NO_DECLARATIONS,
    appimage: {
      ...runtimeFacts,
      desktop,
      app_run,
      icon: icon === undefined ? null : (icon.link_target ?? `/${icon.path}`),
    },
    squashfs: superblockFacts(image.superblock),
    files,
    diagnostics,
    listed: true,
  };
};
