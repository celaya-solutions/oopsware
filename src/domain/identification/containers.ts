import { isArchiveStreamFormat } from "../archiveStreamFormat.js";
import { formatCapability, formatEntry } from "../formatRegistry.js";
import type { FormatId } from "../formatIdentifiers.js";
import { isZipPackageFormat } from "../zipPackageFormat.js";

/**
 * Storage formats that hold other files even where no reader lists them yet.
 * Package roles and archive streams hold files by definition; a WebAssembly
 * binary or a class file does not, whatever its registry facet says.
 */
const OTHER_HOLDING_STORAGE: ReadonlySet<FormatId> = new Set([
  "xar",
  "udif",
  "asar",
  "godot-pck",
  "mach-o-universal",
  "bzip2",
  "zstd",
  "ole-compound",
]);

const holdsFiles = (format: FormatId): boolean =>
  formatEntry(format).dimension === "package-role" ||
  isArchiveStreamFormat(format) ||
  isZipPackageFormat(format) ||
  OTHER_HOLDING_STORAGE.has(format);

/** Whether a piece can be opened here, and why not when it holds files that cannot be. */
export interface ContainerPlan {
  readonly openable: boolean;
  readonly reason: string | null;
}

/**
 * The registry's local inventory facet decides what opens; a format that
 * holds files but cannot be listed here says why, and anything else is not a
 * container at all.
 */
export const containerPlan = (
  candidates: readonly FormatId[],
  platform: NodeJS.Platform,
): ContainerPlan => {
  const context = { surface: "local", platform } as const;
  let reason: string | null = null;
  for (const format of candidates) {
    const capability = formatCapability(format, "inventory", context);
    if (capability.state === "complete" || capability.state === "partial")
      return { openable: true, reason: null };
    if (holdsFiles(format))
      reason ??=
        capability.reason ??
        `${formatEntry(format).label} contents are not listed here.`;
  }
  return { openable: false, reason };
};
