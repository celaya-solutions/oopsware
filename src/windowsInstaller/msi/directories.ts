/**
 * The Directory table resolved into paths without evaluating properties.
 * DefaultDir is "target[:source]", each part "name" or "short|long"; the
 * long name is used and "." means the parent itself. A root (no parent, or
 * itself as parent) and a system folder property (ProgramFiles64Folder, ...)
 * start a target path under their own ID, because Windows sets both before
 * costing; source paths start at the root's source name (e.g. SourceDir).
 * msiextract lays the same tree out with roots and "." dropped and
 * ProgramFilesFolder written as "Program Files".
 */

export interface MsiDirectory {
  readonly id: string;
  readonly parent: string | null;
  readonly default_dir: string;
  readonly target_path: string;
  readonly source_path: string;
}

/** Windows Installer's system folder properties (the "System Folder Properties" reference). */
export const SYSTEM_FOLDERS: ReadonlySet<string> = new Set([
  "AdminToolsFolder",
  "AppDataFolder",
  "CommonAppDataFolder",
  "CommonFiles64Folder",
  "CommonFilesFolder",
  "DesktopFolder",
  "FavoritesFolder",
  "FontsFolder",
  "LocalAppDataFolder",
  "MyPicturesFolder",
  "NetHoodFolder",
  "PersonalFolder",
  "PrintHoodFolder",
  "ProgramFiles64Folder",
  "ProgramFilesFolder",
  "ProgramMenuFolder",
  "RecentFolder",
  "SendToFolder",
  "StartMenuFolder",
  "StartupFolder",
  "System16Folder",
  "System64Folder",
  "SystemFolder",
  "TempFolder",
  "TemplateFolder",
  "WindowsFolder",
  "WindowsVolume",
]);

/** The long name of "short|long", or the name itself. */
export const longName = (value: string): string => {
  const bar = value.indexOf("|");
  return bar < 0 ? value : value.slice(bar + 1);
};

/** The short name of "short|long", or null when only one name is stored. */
export const shortName = (value: string): string | null => {
  const bar = value.indexOf("|");
  return bar < 0 ? null : value.slice(0, bar);
};

const sides = (defaultDir: string): { target: string; source: string } => {
  const colon = defaultDir.indexOf(":");
  return colon < 0
    ? { target: defaultDir, source: defaultDir }
    : {
        target: defaultDir.slice(0, colon),
        source: defaultDir.slice(colon + 1),
      };
};

const join = (parent: string, name: string): string =>
  name === "." || name === "" ? parent : `${parent}/${name}`;

export const resolveDirectories = (
  rows: readonly {
    readonly id: string;
    readonly parent: string | null;
    readonly default_dir: string;
  }[],
  problems: string[],
): MsiDirectory[] => {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const target = new Map<string, string>();
  const source = new Map<string, string>();
  const resolve = (id: string): void => {
    const chain: string[] = [];
    const onChain = new Set<string>();
    let at: string | null = id;
    let base: { target: string; source: string } | null = null;
    while (at !== null) {
      const known = target.get(at);
      if (known !== undefined) {
        base = { target: known, source: source.get(at) ?? known };
        break;
      }
      if (onChain.has(at)) {
        problems.push(
          `Directory ${at} is its own ancestor; its path starts at its ID.`,
        );
        base = { target: at, source: at };
        for (const member of chain.splice(chain.indexOf(at))) {
          target.set(member, member);
          source.set(member, member);
        }
        break;
      }
      const row = byId.get(at);
      if (row === undefined) {
        problems.push(
          `Directory ${chain.at(-1) ?? id} names parent ${at}, which the Directory table does not hold.`,
        );
        base = { target: at, source: at };
        break;
      }
      onChain.add(at);
      chain.push(at);
      at = row.parent === null || row.parent === row.id ? null : row.parent;
    }
    for (let index = chain.length - 1; index >= 0; index -= 1) {
      const row = byId.get(chain[index] ?? "");
      if (row === undefined) continue;
      const names = sides(row.default_dir);
      if (base === null) {
        base = {
          target: row.id,
          source:
            longName(names.source) === "." ? row.id : longName(names.source),
        };
      } else {
        base = {
          target: SYSTEM_FOLDERS.has(row.id)
            ? row.id
            : join(base.target, longName(names.target)),
          source: join(base.source, longName(names.source)),
        };
      }
      target.set(row.id, base.target);
      source.set(row.id, base.source);
    }
  };
  for (const row of rows) if (!target.has(row.id)) resolve(row.id);
  return rows.map((row) =>
    Object.freeze({
      id: row.id,
      parent: row.parent === row.id ? null : row.parent,
      default_dir: row.default_dir,
      target_path: target.get(row.id) ?? row.id,
      source_path: source.get(row.id) ?? row.id,
    }),
  );
};
