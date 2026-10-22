import { dependencyFlagNames } from "./flags.js";
import type { RpmDependencies, RpmDependency, RpmOperator } from "./facts.js";
import { rpmTagName } from "./header.js";
import type { Reader } from "./typedReader.js";

/** rpmdsNewDNEVR: name, the comparison letters, then the EVR, space separated. */
const dependencyText = (
  name: string,
  flags: number,
  version: string,
): string => {
  let text = name;
  if ((flags & 0xf) !== 0) {
    const letters = `${flags & 2 ? "<" : ""}${flags & 4 ? ">" : ""}${flags & 8 ? "=" : ""}`;
    text = text === "" ? letters : `${text} ${letters}`;
  }
  if (version !== "") text = text === "" ? version : `${text} ${version}`;
  return text;
};

const OPERATORS: ReadonlyMap<number, RpmOperator> = new Map([
  [2, "<"],
  [10, "<="],
  [8, "="],
  [12, ">="],
  [4, ">"],
]);

export const dependency = (
  name: string,
  flags: number,
  version: string,
  problems: string[],
): RpmDependency => {
  const sense = flags & 0xe;
  const operator = sense === 0 ? null : (OPERATORS.get(sense) ?? null);
  if (sense !== 0 && operator === null)
    problems.push(
      `Dependency ${JSON.stringify(name)} has both "<" and ">" comparison bits set.`,
    );
  if ((flags & 1) !== 0)
    problems.push(
      `Dependency ${JSON.stringify(name)} sets RPMSENSE bit 0, which rpm does not define.`,
    );
  return {
    name,
    operator,
    version: version === "" ? null : version,
    flags: dependencyFlagNames(flags),
    rich: name.startsWith("("),
    text: dependencyText(name, flags, version),
  };
};

const dependencyList = (
  reader: Reader,
  [nameTag, flagsTag, versionTag]: readonly [number, number, number],
): RpmDependency[] => {
  const names = reader.strings(nameTag);
  if (names === null) return [];
  const label = rpmTagName(nameTag, "main");
  const flags = reader.numbers(flagsTag);
  const versions = reader.strings(versionTag);
  // rpm before 3.0.2 could omit flags and versions; rpmds reads them as 0 and "".
  if (flags !== null && flags.length !== names.length)
    reader.problems.push(
      `${label} has ${String(names.length)} names but ${String(flags.length)} flags; only matching entries are listed.`,
    );
  if (versions !== null && versions.length !== names.length)
    reader.problems.push(
      `${label} has ${String(names.length)} names but ${String(versions.length)} versions; only matching entries are listed.`,
    );
  const count = Math.min(
    names.length,
    flags?.length ?? names.length,
    versions?.length ?? names.length,
  );
  return names
    .slice(0, count)
    .map((name, index) =>
      dependency(
        name,
        flags?.[index] ?? 0,
        versions?.[index] ?? "",
        reader.problems,
      ),
    );
};

/** Name, flags and version tags per dependency kind (rpmtag.h). */
const DEPENDENCY_TAGS = {
  requires: [1049, 1048, 1050],
  provides: [1047, 1112, 1113],
  conflicts: [1054, 1053, 1055],
  obsoletes: [1090, 1114, 1115],
  recommends: [5046, 5048, 5047],
  suggests: [5049, 5051, 5050],
  supplements: [5052, 5054, 5053],
  enhances: [5055, 5057, 5056],
  order_with_requires: [5035, 5037, 5036],
} as const;

/** Every dependency kind, in the order rpm's header keeps each list. */
export const dependencies = (reader: Reader): RpmDependencies =>
  Object.fromEntries(
    Object.entries(DEPENDENCY_TAGS).map(([kind, tags]) => [
      kind,
      dependencyList(reader, tags),
    ]),
  ) as unknown as RpmDependencies;
