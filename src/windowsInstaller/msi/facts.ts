import {
  readCustomActions,
  readSequences,
  type MsiCustomAction,
  type MsiSequence,
} from "./customActions.js";
import type { MsiDatabase } from "./database.js";
import { resolveDirectories, type MsiDirectory } from "./directories.js";
import {
  readBinaries,
  readComponents,
  readEnvironment,
  readFeatures,
  readFiles,
  readIniFiles,
  readMedia,
  readRegistry,
  readServices,
  readShortcuts,
  readUpgrades,
  required,
  text,
} from "./factReaders.js";

export type { MsiCustomAction, MsiSequence } from "./customActions.js";
export type { MsiDirectory } from "./directories.js";

/**
 * Typed installer facts from a Windows Installer database. Values are as
 * stored: conditions and formatted text ([INSTALLDIR], [~]) are kept as
 * written and never evaluated; paths come from the Directory table alone
 * (directories.ts); bit names follow the Windows Installer SDK (bits.ts,
 * customActions.ts).
 */

export interface MsiMedia {
  readonly disk_id: number;
  readonly last_sequence: number;
  readonly disk_prompt: string | null;
  /** The cabinet name without the "#" that marks an embedded one. */
  readonly cabinet: string | null;
  /** The cabinet is a stream of this database (Cabinet "#name"). */
  readonly embedded: boolean;
  readonly volume_label: string | null;
  readonly source: string | null;
}

export interface MsiFile {
  readonly key: string;
  readonly component: string;
  /** The long name of "short|long". */
  readonly name: string;
  readonly short_name: string | null;
  readonly size: number | null;
  readonly version: string | null;
  readonly language: string | null;
  readonly attributes: readonly string[];
  readonly sequence: number | null;
  readonly target_path: string;
  /** The Media row whose LastSequence is the first at or past this file's sequence. */
  readonly media: {
    readonly disk_id: number;
    readonly cabinet: string | null;
    readonly embedded: boolean;
  } | null;
  /** MsiFileHash: the four parts as the MD5 digest's bytes (each part little-endian). */
  readonly hash: { readonly md5: string } | null;
}

export interface MsiFacts {
  /** The Property table in stored order. */
  readonly properties: readonly {
    readonly name: string;
    readonly value: string;
  }[];
  readonly product: {
    readonly name: string | null;
    readonly version: string | null;
    readonly manufacturer: string | null;
    readonly product_code: string | null;
    readonly upgrade_code: string | null;
    readonly language: string | null;
    readonly all_users: string | null;
  };
  readonly directories: readonly MsiDirectory[];
  readonly features: readonly {
    readonly id: string;
    readonly parent: string | null;
    readonly title: string | null;
    readonly description: string | null;
    readonly level: number | null;
    readonly display: number | null;
    readonly attributes: readonly string[];
    readonly components: readonly string[];
    readonly conditions: readonly {
      readonly level: number;
      readonly condition: string;
    }[];
  }[];
  readonly components: readonly {
    readonly id: string;
    readonly guid: string | null;
    readonly directory: string;
    readonly attributes: readonly string[];
    readonly condition: string | null;
    readonly key_path: string | null;
  }[];
  readonly files: readonly MsiFile[];
  readonly media: readonly MsiMedia[];
  /** Registry rows (write), then RemoveRegistry rows (remove). */
  readonly registry: readonly {
    readonly id: string;
    readonly root: string;
    readonly key: string;
    readonly name: string | null;
    readonly value: string | null;
    readonly component: string;
    readonly action: "write" | "remove";
  }[];
  /** ServiceInstall rows, then ServiceControl rows. */
  readonly services: readonly {
    readonly kind: "install" | "control";
    readonly id: string;
    readonly name: string;
    readonly display_name: string | null;
    readonly type: readonly string[];
    readonly start: string | null;
    readonly error_control: string | null;
    readonly arguments: string | null;
    readonly account: string | null;
    readonly events: readonly string[];
    readonly component: string;
  }[];
  readonly shortcuts: readonly {
    readonly id: string;
    readonly directory: string;
    readonly name: string;
    readonly target: string;
    readonly arguments: string | null;
    readonly component: string;
  }[];
  readonly environment: readonly {
    readonly id: string;
    /** The name without its =, +, -, ! and * prefixes, which become flags. */
    readonly name: string;
    readonly flags: readonly string[];
    readonly value: string | null;
    readonly component: string;
  }[];
  /** IniFile rows, then RemoveIniFile rows (whose Value may be null). */
  readonly ini_files: readonly {
    readonly id: string;
    readonly file: string;
    readonly directory: string | null;
    readonly section: string;
    readonly key: string;
    readonly value: string | null;
    readonly action: string;
    readonly component: string;
  }[];
  readonly custom_actions: readonly MsiCustomAction[];
  /** Every *Sequence table, actions ordered by sequence (nulls last). */
  readonly sequences: readonly MsiSequence[];
  readonly launch_conditions: readonly {
    readonly condition: string;
    readonly message: string | null;
  }[];
  readonly upgrades: readonly {
    readonly upgrade_code: string;
    readonly version_min: string | null;
    readonly version_max: string | null;
    readonly language: string | null;
    readonly attributes: readonly string[];
    readonly remove: string | null;
    readonly action_property: string;
  }[];
  readonly binaries: readonly {
    readonly name: string;
    readonly stream: string;
    readonly size: number;
  }[];
  /** Bytes of the \u0005DigitalSignature and \u0005MsiDigitalSignatureEx streams; never verified. */
  readonly signature: {
    readonly digital_signature: number | null;
    readonly ex: number | null;
  };
  /** The database's problems, then problems found while reading facts. */
  readonly problems: readonly string[];
}

export const msiFacts = (database: MsiDatabase): MsiFacts => {
  const problems: string[] = [];
  const properties = database.rows("Property").map((row) =>
    Object.freeze({
      name: required(row.Property),
      value: text(row.Value) ?? "",
    }),
  );
  const property = (name: string): string | null =>
    properties.find((entry) => entry.name === name)?.value ?? null;
  const directories = resolveDirectories(
    database.rows("Directory").map((row) => ({
      id: required(row.Directory),
      parent: text(row.Directory_Parent),
      default_dir: required(row.DefaultDir),
    })),
    problems,
  );
  const media = readMedia(database);
  const sequences = readSequences(database);
  const files = readFiles(database, directories, media, problems);
  const binaries = readBinaries(database, problems);
  return Object.freeze({
    properties: Object.freeze(properties),
    product: Object.freeze({
      name: property("ProductName"),
      version: property("ProductVersion"),
      manufacturer: property("Manufacturer"),
      product_code: property("ProductCode"),
      upgrade_code: property("UpgradeCode"),
      language: property("ProductLanguage"),
      all_users: property("ALLUSERS"),
    }),
    directories: Object.freeze(directories),
    features: Object.freeze(readFeatures(database)),
    components: Object.freeze(readComponents(database)),
    files: Object.freeze(files),
    media: Object.freeze(media),
    registry: Object.freeze(readRegistry(database)),
    services: Object.freeze(readServices(database)),
    shortcuts: Object.freeze(readShortcuts(database)),
    environment: Object.freeze(readEnvironment(database)),
    ini_files: Object.freeze(readIniFiles(database)),
    custom_actions: Object.freeze(readCustomActions(database, sequences)),
    sequences: Object.freeze(sequences),
    launch_conditions: Object.freeze(
      database.rows("LaunchCondition").map((row) =>
        Object.freeze({
          condition: required(row.Condition),
          message: text(row.Description),
        }),
      ),
    ),
    upgrades: Object.freeze(readUpgrades(database)),
    binaries: Object.freeze(binaries),
    signature: Object.freeze({
      digital_signature:
        database.stream("\u0005DigitalSignature")?.size ?? null,
      ex: database.stream("\u0005MsiDigitalSignatureEx")?.size ?? null,
    }),
    problems: Object.freeze([...database.problems, ...problems]),
  });
};
