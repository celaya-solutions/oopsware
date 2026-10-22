import type { RpmFileEntry } from "./facts.js";
import { fileFlagNames } from "./flags.js";
import { rpmTagName } from "./header.js";
import type { Reader } from "./typedReader.js";

const filePaths = (reader: Reader): string[] | null => {
  const basenames = reader.strings(1117);
  if (basenames === null) return reader.strings(1027)?.slice() ?? null;
  const dirIndexes = reader.numbers(1116);
  const dirNames = reader.strings(1118);
  if (
    dirIndexes === null ||
    dirNames === null ||
    dirIndexes.length !== basenames.length
  ) {
    reader.problems.push(
      "BASENAMES is present but DIRINDEXES or DIRNAMES is missing or a different length; files are not listed.",
    );
    return null;
  }
  const paths: string[] = [];
  for (const [index, basename] of basenames.entries()) {
    const directory = dirNames[dirIndexes[index] ?? -1];
    if (directory === undefined) {
      reader.problems.push(
        `File ${String(index)} names directory ${String(dirIndexes[index])} of ${String(dirNames.length)}; files are not listed.`,
      );
      return null;
    }
    paths.push(directory + basename);
  }
  return paths;
};

/** rpmfilesBuildNLink: regular, non-ghost files with an inode, grouped by device and inode. */
const linkCounts = (
  modes: readonly number[],
  flags: readonly number[],
  devices: readonly number[],
  inodes: readonly number[],
): number[] => {
  const groups = new Map<string, number>();
  const keys = modes.map((mode, index) =>
    (mode & 0o170000) === 0o100000 &&
    ((flags[index] ?? 0) & (1 << 6)) === 0 &&
    (inodes[index] ?? 0) > 0
      ? `${String(devices[index])}:${String(inodes[index])}`
      : null,
  );
  for (const key of keys)
    if (key !== null) groups.set(key, (groups.get(key) ?? 0) + 1);
  return keys.map((key) => (key === null ? 1 : (groups.get(key) ?? 1)));
};

export const files = (reader: Reader): RpmFileEntry[] => {
  const paths = filePaths(reader);
  if (paths === null || paths.length === 0) return [];
  const count = paths.length;
  const required = {
    sizes: reader.numbers(5008) ?? reader.numbers(1028),
    modes: reader.numbers(1030),
    mtimes: reader.numbers(1034),
    flags: reader.numbers(1037),
    rdevs: reader.numbers(1033),
    devices: reader.numbers(1095),
    inodes: reader.numbers(1096),
  };
  const missing = Object.entries(required).filter(
    ([, values]) => values?.length !== count,
  );
  if (missing.length > 0) {
    reader.problems.push(
      `File attribute arrays ${missing.map(([name]) => name).join(", ")} are missing or not ${String(count)} long; files are not listed.`,
    );
    return [];
  }
  const optional = (tag: number): readonly string[] | null => {
    const values = reader.strings(tag);
    if (values !== null && values.length !== count) {
      reader.problems.push(
        `${rpmTagName(tag, "main")} has ${String(values.length)} entries for ${String(count)} files; it is left out.`,
      );
      return null;
    }
    return values;
  };
  const users = optional(1039);
  const groups = optional(1040);
  const digests = optional(1035);
  const links = optional(1036);
  const langs = optional(1097);
  const { sizes, modes, mtimes, flags, rdevs, devices, inodes } = required as {
    [K in keyof typeof required]: readonly number[];
  };
  const nlinks = linkCounts(modes, flags, devices, inodes);
  const empty = (value: string | undefined): string | null =>
    value === undefined || value === "" ? null : value;
  return paths.map((path, index) => ({
    path,
    size: sizes[index] ?? 0,
    mode: modes[index] ?? 0,
    user: users?.[index] ?? null,
    group: groups?.[index] ?? null,
    mtime: mtimes[index] ?? 0,
    digest: empty(digests?.[index]),
    link_target: empty(links?.[index]),
    flags: fileFlagNames(flags[index] ?? 0),
    device: devices[index] ?? 0,
    inode: inodes[index] ?? 0,
    rdev: rdevs[index] ?? 0,
    links: nlinks[index] ?? 1,
    lang: empty(langs?.[index]),
  }));
};
