import {
  bitNames,
  componentAttributes,
  environmentName,
  featureAttributes,
  FILE_BITS,
  iniAction,
  registryRoot,
  serviceErrorControl,
  SERVICE_EVENT_BITS,
  SERVICE_TYPE_BITS,
  serviceStart,
  UPGRADE_BITS,
} from "./bits.js";
import type { MsiDatabase, MsiValue } from "./database.js";
import { longName, shortName, type MsiDirectory } from "./directories.js";
import type { MsiFacts, MsiFile, MsiMedia } from "./facts.js";

/** One fact list per installer table, rows in stored order. */

export const text = (value: MsiValue | undefined): string | null =>
  typeof value === "string" ? value : null;
export const integer = (value: MsiValue | undefined): number | null =>
  typeof value === "number" ? value : null;
/** A non-null column's string; "" when the row breaks that rule. */
export const required = (value: MsiValue | undefined): string =>
  typeof value === "string" ? value : "";

/** The 16 digest bytes of MsiFileHash's four signed 32-bit parts, each little-endian as Windows stores MSIFILEHASHINFO. */
export const msiFileHashHex = (parts: readonly (number | null)[]): string =>
  parts
    .map((part) => {
      const value = (part ?? 0) >>> 0;
      return [
        value & 0xff,
        (value >>> 8) & 0xff,
        (value >>> 16) & 0xff,
        value >>> 24,
      ]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
    })
    .join("");

export const readMedia = (database: MsiDatabase): MsiMedia[] =>
  database.rows("Media").map((row) => {
    const cabinet = text(row.Cabinet);
    const embedded = cabinet?.startsWith("#") ?? false;
    return Object.freeze({
      disk_id: integer(row.DiskId) ?? 0,
      last_sequence: integer(row.LastSequence) ?? 0,
      disk_prompt: text(row.DiskPrompt),
      cabinet: cabinet === null ? null : embedded ? cabinet.slice(1) : cabinet,
      embedded,
      volume_label: text(row.VolumeLabel),
      source: text(row.Source),
    });
  });

/** Files at their component's directory; media is the first Media row (by LastSequence) at or past the file's sequence. */
export const readFiles = (
  database: MsiDatabase,
  directories: readonly MsiDirectory[],
  media: readonly MsiMedia[],
  problems: string[],
): MsiFile[] => {
  const directoryPath = new Map(
    directories.map((directory) => [directory.id, directory.target_path]),
  );
  const componentDirectory = new Map(
    database
      .rows("Component")
      .map((row) => [required(row.Component), required(row.Directory_)]),
  );
  const hashes = new Map(
    database
      .rows("MsiFileHash")
      .map((row) => [
        required(row.File_),
        msiFileHashHex(
          [row.HashPart1, row.HashPart2, row.HashPart3, row.HashPart4].map(
            integer,
          ),
        ),
      ]),
  );
  const ordered = [...media].sort(
    (left, right) =>
      left.last_sequence - right.last_sequence || left.disk_id - right.disk_id,
  );
  return database.rows("File").map((row) => {
    const key = required(row.File);
    const component = required(row.Component_);
    const stored = required(row.FileName);
    const sequence = integer(row.Sequence);
    const directory = componentDirectory.get(component);
    if (directory === undefined)
      problems.push(
        `File ${key} names component ${component}, which the Component table does not hold.`,
      );
    else if (!directoryPath.has(directory))
      problems.push(
        `Component ${component} names directory ${directory}, which the Directory table does not hold.`,
      );
    const base =
      directory === undefined
        ? component
        : (directoryPath.get(directory) ?? directory);
    const covering =
      sequence === null
        ? undefined
        : ordered.find((entry) => entry.last_sequence >= sequence);
    if (sequence !== null && covering === undefined && media.length > 0)
      problems.push(
        `File ${key} has sequence ${String(sequence)}, past every Media row's LastSequence.`,
      );
    const md5 = hashes.get(key);
    return Object.freeze({
      key,
      component,
      name: longName(stored),
      short_name: shortName(stored),
      size: integer(row.FileSize),
      version: text(row.Version),
      language: text(row.Language),
      attributes: Object.freeze(bitNames(integer(row.Attributes), FILE_BITS)),
      sequence,
      target_path: `${base}/${longName(stored)}`,
      media:
        covering === undefined
          ? null
          : Object.freeze({
              disk_id: covering.disk_id,
              cabinet: covering.cabinet,
              embedded: covering.embedded,
            }),
      hash: md5 === undefined ? null : Object.freeze({ md5 }),
    });
  });
};

const grouped = (
  rows: readonly Readonly<Record<string, MsiValue>>[],
  key: string,
): Map<string, Readonly<Record<string, MsiValue>>[]> => {
  const groups = new Map<string, Readonly<Record<string, MsiValue>>[]>();
  for (const row of rows)
    groups.set(required(row[key]), [
      ...(groups.get(required(row[key])) ?? []),
      row,
    ]);
  return groups;
};

export const readFeatures = (database: MsiDatabase): MsiFacts["features"] => {
  const components = grouped(database.rows("FeatureComponents"), "Feature_");
  const conditions = grouped(database.rows("Condition"), "Feature_");
  return database.rows("Feature").map((row) => {
    const id = required(row.Feature);
    return Object.freeze({
      id,
      parent: text(row.Feature_Parent),
      title: text(row.Title),
      description: text(row.Description),
      level: integer(row.Level),
      display: integer(row.Display),
      attributes: Object.freeze(featureAttributes(integer(row.Attributes))),
      components: Object.freeze(
        (components.get(id) ?? []).map((entry) => required(entry.Component_)),
      ),
      conditions: Object.freeze(
        (conditions.get(id) ?? []).map((entry) =>
          Object.freeze({
            level: integer(entry.Level) ?? 0,
            condition: text(entry.Condition) ?? "",
          }),
        ),
      ),
    });
  });
};

export const readComponents = (database: MsiDatabase): MsiFacts["components"] =>
  database.rows("Component").map((row) =>
    Object.freeze({
      id: required(row.Component),
      guid: text(row.ComponentId),
      directory: required(row.Directory_),
      attributes: Object.freeze(componentAttributes(integer(row.Attributes))),
      condition: text(row.Condition),
      key_path: text(row.KeyPath),
    }),
  );

export const readServices = (database: MsiDatabase): MsiFacts["services"] => [
  ...database.rows("ServiceInstall").map((row) =>
    Object.freeze({
      kind: "install" as const,
      id: required(row.ServiceInstall),
      name: required(row.Name),
      display_name: text(row.DisplayName),
      type: Object.freeze(
        bitNames(integer(row.ServiceType), SERVICE_TYPE_BITS),
      ),
      start: serviceStart(integer(row.StartType)),
      error_control: serviceErrorControl(integer(row.ErrorControl)),
      arguments: text(row.Arguments),
      account: text(row.StartName),
      events: Object.freeze([]),
      component: required(row.Component_),
    }),
  ),
  ...database.rows("ServiceControl").map((row) =>
    Object.freeze({
      kind: "control" as const,
      id: required(row.ServiceControl),
      name: required(row.Name),
      display_name: null,
      type: Object.freeze([]),
      start: null,
      error_control: null,
      arguments: text(row.Arguments),
      account: null,
      events: Object.freeze(bitNames(integer(row.Event), SERVICE_EVENT_BITS)),
      component: required(row.Component_),
    }),
  ),
];

/** Registry rows are writes; RemoveRegistry rows are removals (they have no Value). */
export const readRegistry = (database: MsiDatabase): MsiFacts["registry"] =>
  (["Registry", "RemoveRegistry"] as const).flatMap((table) =>
    database.rows(table).map((row) =>
      Object.freeze({
        id: required(row[table]),
        root: registryRoot(integer(row.Root)),
        key: required(row.Key),
        name: text(row.Name),
        value: table === "Registry" ? text(row.Value) : null,
        component: required(row.Component_),
        action: table === "Registry" ? ("write" as const) : ("remove" as const),
      }),
    ),
  );

export const readIniFiles = (database: MsiDatabase): MsiFacts["ini_files"] =>
  (["IniFile", "RemoveIniFile"] as const).flatMap((table) =>
    database.rows(table).map((row) =>
      Object.freeze({
        id: required(row[table]),
        file: longName(required(row.FileName)),
        directory: text(row.DirProperty),
        section: required(row.Section),
        key: required(row.Key),
        value: text(row.Value),
        action: iniAction(integer(row.Action)),
        component: required(row.Component_),
      }),
    ),
  );

export const readShortcuts = (database: MsiDatabase): MsiFacts["shortcuts"] =>
  database.rows("Shortcut").map((row) =>
    Object.freeze({
      id: required(row.Shortcut),
      directory: required(row.Directory_),
      name: longName(required(row.Name)),
      target: required(row.Target),
      arguments: text(row.Arguments),
      component: required(row.Component_),
    }),
  );

export const readEnvironment = (
  database: MsiDatabase,
): MsiFacts["environment"] =>
  database.rows("Environment").map((row) => {
    const value = text(row.Value);
    const decoded = environmentName(required(row.Name), value);
    return Object.freeze({
      id: required(row.Environment),
      name: decoded.name,
      flags: Object.freeze(decoded.flags),
      value,
      component: required(row.Component_),
    });
  });

export const readUpgrades = (database: MsiDatabase): MsiFacts["upgrades"] =>
  database.rows("Upgrade").map((row) =>
    Object.freeze({
      upgrade_code: required(row.UpgradeCode),
      version_min: text(row.VersionMin),
      version_max: text(row.VersionMax),
      language: text(row.Language),
      attributes: Object.freeze(
        bitNames(integer(row.Attributes), UPGRADE_BITS),
      ),
      remove: text(row.Remove),
      action_property: required(row.ActionProperty),
    }),
  );

/** Binary rows with the size of the stream their Data cell names; a row without one is a problem. */
export const readBinaries = (
  database: MsiDatabase,
  problems: string[],
): MsiFacts["binaries"] =>
  database.rows("Binary").flatMap((row) => {
    const name = required(row.Name);
    const data = row.Data;
    const entry =
      data !== null && typeof data === "object"
        ? database.stream(data.stream)
        : null;
    if (data === null || typeof data !== "object" || entry === null) {
      problems.push(`Binary ${name} has no stream in the database.`);
      return [];
    }
    return [Object.freeze({ name, stream: data.stream, size: entry.size })];
  });
