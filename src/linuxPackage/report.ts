import { createHash } from "node:crypto";

import type { ArtifactCommand } from "../domain/artifactGraph.js";
import {
  MAX_LINUX_SCRIPT_BYTES,
  type LinuxDiagnostic,
  type LinuxPackageReport,
} from "../domain/linuxPackage/linuxPackage.js";

export type FileRecord = LinuxPackageReport["files"][number];
export type ScriptRecord = LinuxPackageReport["scripts"][number];

/** Positional read over the stable bytes the provider read once. */
export const positional =
  (bytes: Uint8Array, base = 0) =>
  (offset: number, length: number): Promise<Uint8Array> =>
    Promise.resolve(
      bytes.subarray(
        Math.min(bytes.length, base + offset),
        Math.min(bytes.length, base + offset + length),
      ),
    );

const FILE_TYPES: Readonly<Record<number, FileRecord["type"]>> = {
  0o100000: "file",
  0o040000: "directory",
  0o120000: "symlink",
  0o020000: "char-device",
  0o060000: "block-device",
  0o010000: "fifo",
  0o140000: "socket",
};

/** File type from a full st_mode value. */
export const typeOfMode = (mode: number): FileRecord["type"] =>
  FILE_TYPES[mode & 0o170000] ?? "unknown";

/** Permission bits as four octal digits and the special bits they set; never applied. */
export const modeFacts = (
  mode: number | null,
): Pick<FileRecord, "mode" | "special"> => {
  if (mode === null) return { mode: null, special: [] };
  const special: FileRecord["special"] = [];
  if ((mode & 0o4000) !== 0) special.push("setuid");
  if ((mode & 0o2000) !== 0) special.push("setgid");
  if ((mode & 0o1000) !== 0) special.push("sticky");
  return { mode: (mode & 0o7777).toString(8).padStart(4, "0"), special };
};

/** The install path of a package member: "./usr/bin/x" and "usr/bin/x" become "/usr/bin/x". */
export const installPath = (name: string): string =>
  `/${name.replace(/^(?:\.\/)+/u, "").replace(/^\/+/u, "")}`;

export const sha256Hex = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** A script as data: interpreter from its #! line, digest, and text when it is UTF-8. */
export const scriptRecord = (
  name: string,
  bytes: Uint8Array,
  declaredInterpreter: string | null = null,
): ScriptRecord => {
  let text: string | null = null;
  try {
    text = utf8.decode(bytes.subarray(0, MAX_LINUX_SCRIPT_BYTES));
  } catch {
    text = null;
  }
  const shebang =
    text?.startsWith("#!") === true
      ? (text.slice(2).split("\n")[0] ?? "").trim()
      : null;
  return {
    name,
    interpreter: declaredInterpreter ?? (shebang === "" ? null : shebang),
    bytes: bytes.length,
    sha256: sha256Hex(bytes),
    text,
    truncated: bytes.length > MAX_LINUX_SCRIPT_BYTES,
  };
};

/** One page of files plus the totals the service checks. */
export const filePage = (
  files: readonly FileRecord[],
  start: number,
  limit: number,
): Pick<LinuxPackageReport, "file_count" | "page" | "files"> => {
  const slice = files.slice(start, start + limit);
  const next = start + slice.length;
  return {
    file_count: files.length,
    page: {
      start,
      limit,
      returned: slice.length,
      next: next < files.length ? next : null,
    },
    files: slice,
  };
};

/** Decoder provenance in the report's shape, once per distinct tool. */
export const decoderRecords = (
  commands: readonly (ArtifactCommand | null)[],
): LinuxPackageReport["decoders"] => {
  const seen = new Map<string, LinuxPackageReport["decoders"][number]>();
  for (const command of commands)
    if (command !== null && !seen.has(command.tool))
      seen.set(command.tool, {
        tool: command.tool,
        version: command.tool_version,
        executable_sha256: command.executable_sha256,
      });
  return [...seen.values()];
};

export const diagnostic = (
  location: string | null,
  message: string,
  offset: number | null = null,
): LinuxDiagnostic => ({ location, offset, message });

/** Every package kind states these. */
export const SHARED_LIMITATIONS = [
  "Nothing is installed, unpacked onto the system, mounted or run: no maintainer script, scriptlet, trigger or AppImage executes.",
  "Declared signatures are recorded as present; no signature is verified and no key or signer is trusted.",
  "Dependencies, scripts and conffiles are declarations; whether a system satisfies or runs them is not evaluated.",
];
