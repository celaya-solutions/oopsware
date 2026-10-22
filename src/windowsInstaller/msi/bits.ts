/**
 * Named bits of Windows Installer columns, as the Windows Installer SDK
 * (msidefs.h and the table reference pages) defines them. Set bits without
 * a name are reported as `0x...`.
 */

export type BitNames = readonly (readonly [number, string])[];

export const bitNames = (value: number | null, names: BitNames): string[] => {
  if (value === null) return [];
  const out: string[] = [];
  let rest = value >>> 0;
  for (const [bit, name] of names)
    if ((rest & bit) === bit && bit !== 0) {
      out.push(name);
      rest &= ~bit >>> 0;
    }
  if (rest !== 0) out.push(`0x${rest.toString(16)}`);
  return out;
};

/** Component.Attributes; bits 0-1 choose local-only (0), source-only (1) or optional (2). */
export const componentAttributes = (value: number | null): string[] => {
  if (value === null) return [];
  const location =
    ["local-only", "source-only", "optional", "0x3"][value & 0x3] ?? "0x3";
  return [location, ...bitNames(value & ~0x3, COMPONENT_BITS)];
};

const COMPONENT_BITS: BitNames = [
  [0x4, "registry-keypath"],
  [0x8, "shared-dll-refcount"],
  [0x10, "permanent"],
  [0x20, "odbc-datasource"],
  [0x40, "transitive"],
  [0x80, "never-overwrite"],
  [0x100, "64-bit"],
  [0x200, "disable-registry-reflection"],
  [0x400, "uninstall-on-supersedence"],
  [0x800, "shared"],
];

export const FILE_BITS: BitNames = [
  [0x1, "read-only"],
  [0x2, "hidden"],
  [0x4, "system"],
  [0x200, "vital"],
  [0x400, "checksum"],
  [0x1000, "patch-added"],
  [0x2000, "noncompressed"],
  [0x4000, "compressed"],
];

/** Feature.Attributes; bits 0-1 choose favor-local (0), favor-source (1) or follow-parent (2). */
export const featureAttributes = (value: number | null): string[] => {
  if (value === null) return [];
  const location =
    ["favor-local", "favor-source", "follow-parent", "0x3"][value & 0x3] ??
    "0x3";
  return [location, ...bitNames(value & ~0x3, FEATURE_BITS)];
};

const FEATURE_BITS: BitNames = [
  [0x4, "favor-advertise"],
  [0x8, "disallow-advertise"],
  [0x10, "ui-disallow-absent"],
  [0x20, "no-unsupported-advertise"],
];

export const UPGRADE_BITS: BitNames = [
  [0x1, "migrate-features"],
  [0x2, "only-detect"],
  [0x4, "ignore-remove-failure"],
  [0x100, "version-min-inclusive"],
  [0x200, "version-max-inclusive"],
  [0x400, "languages-exclusive"],
];

export const SERVICE_TYPE_BITS: BitNames = [
  [0x1, "kernel-driver"],
  [0x2, "file-system-driver"],
  [0x10, "own-process"],
  [0x20, "share-process"],
  [0x100, "interactive"],
];

export const SERVICE_EVENT_BITS: BitNames = [
  [0x1, "install-start"],
  [0x2, "install-stop"],
  [0x8, "install-delete"],
  [0x10, "uninstall-start"],
  [0x20, "uninstall-stop"],
  [0x80, "uninstall-delete"],
];

const SERVICE_STARTS = ["boot", "system", "auto", "demand", "disabled"];

export const serviceStart = (value: number | null): string | null =>
  value === null ? null : (SERVICE_STARTS[value] ?? String(value));

/** ServiceInstall.ErrorControl: ignore 0, normal 1, critical 3, plus the vital flag 0x8000. */
export const serviceErrorControl = (value: number | null): string | null => {
  if (value === null) return null;
  const level =
    { 0: "ignore", 1: "normal", 3: "critical" }[value & 0xff] ??
    String(value & 0xff);
  return (value & 0x8000) !== 0 ? `${level}+vital` : level;
};

/** Registry.Root: -1 is per-user or per-machine by ALLUSERS (HKMU). */
export const registryRoot = (value: number | null): string =>
  value === -1
    ? "per-user/per-machine (-1)"
    : (["HKCR", "HKCU", "HKLM", "HKU"][value ?? -2] ?? String(value));

const INI_ACTIONS = [
  "add-line",
  "create-line",
  "remove-line",
  "add-tag",
  "remove-tag",
];

export const iniAction = (value: number | null): string =>
  value === null ? "null" : (INI_ACTIONS[value] ?? String(value));

/** Environment.Name prefixes, read until the first other character. */
const ENVIRONMENT_PREFIXES: Readonly<Record<string, string>> = {
  "=": "set",
  "+": "create-if-absent",
  "-": "remove-on-uninstall",
  "!": "remove-on-install",
  "*": "system",
};

export const environmentName = (
  stored: string,
  value: string | null,
): { readonly name: string; readonly flags: string[] } => {
  const flags: string[] = [];
  let at = 0;
  for (; at < stored.length; at += 1) {
    const flag = ENVIRONMENT_PREFIXES[stored[at] ?? ""];
    if (flag === undefined) break;
    if (!flags.includes(flag)) flags.push(flag);
  }
  if (value !== null && value.length > 3 && value.startsWith("[~]"))
    flags.push("append");
  if (value !== null && value.length > 3 && value.endsWith("[~]"))
    flags.push("prepend");
  return { name: stored.slice(at), flags };
};
