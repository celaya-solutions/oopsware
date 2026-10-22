import { dependency } from "./dependencies.js";
import type { RpmScriptlet, RpmScriptletName, RpmTrigger } from "./facts.js";
import { scriptFlagNames } from "./flags.js";
import { rpmTagName } from "./header.js";
import type { Reader } from "./typedReader.js";

/** Body, program and flags tags per scriptlet, in `rpm --scripts` order. */
const SCRIPTLET_TAGS: readonly (readonly [
  RpmScriptletName,
  number,
  number,
  number,
])[] = [
  ["pretrans", 1151, 1153, 5024],
  ["pre", 1023, 1085, 5020],
  ["post", 1024, 1086, 5021],
  ["preun", 1025, 1087, 5022],
  ["postun", 1026, 1088, 5023],
  ["posttrans", 1152, 1154, 5025],
  ["preuntrans", 5103, 5105, 5107],
  ["postuntrans", 5104, 5106, 5108],
  ["verify", 1079, 1091, 5026],
];

export const scriptlets = (reader: Reader): RpmScriptlet[] =>
  SCRIPTLET_TAGS.flatMap(([name, bodyTag, progTag, flagsTag]) => {
    const body = reader.string(bodyTag);
    const interpreter = reader.strings(progTag);
    if (body === null && interpreter === null) return [];
    return [
      {
        name,
        interpreter: interpreter ?? [],
        body,
        flags: scriptFlagNames(reader.number(flagsTag) ?? 0),
      },
    ];
  });

interface TriggerTags {
  readonly prefix: "trigger" | "filetrigger" | "transfiletrigger";
  readonly name: number;
  readonly version: number;
  readonly flags: number;
  readonly index: number;
  readonly scripts: number;
  readonly prog: number;
  readonly scriptFlags: number;
  readonly priorities: number | null;
}

const TRIGGER_TAGS: readonly TriggerTags[] = [
  {
    prefix: "trigger",
    name: 1066,
    version: 1067,
    flags: 1068,
    index: 1069,
    scripts: 1065,
    prog: 1092,
    scriptFlags: 5027,
    priorities: null,
  },
  {
    prefix: "filetrigger",
    name: 5069,
    version: 5071,
    flags: 5072,
    index: 5070,
    scripts: 5066,
    prog: 5067,
    scriptFlags: 5068,
    priorities: 5084,
  },
  {
    prefix: "transfiletrigger",
    name: 5079,
    version: 5081,
    flags: 5082,
    index: 5080,
    scripts: 5076,
    prog: 5077,
    scriptFlags: 5078,
    priorities: 5085,
  },
];

/** rpm's triggertype extension: the first condition's TRIGGER* bit names the kind. */
const triggerSuffix = (flags: number): string =>
  flags & (1 << 25)
    ? "prein"
    : flags & (1 << 16)
      ? "in"
      : flags & (1 << 17)
        ? "un"
        : flags & (1 << 18)
          ? "postun"
          : "";

const triggerList = (reader: Reader, tags: TriggerTags): RpmTrigger[] => {
  const scripts = reader.strings(tags.scripts);
  if (scripts === null) return [];
  const label = rpmTagName(tags.scripts, "main");
  const names = reader.strings(tags.name) ?? [];
  const flags = reader.numbers(tags.flags) ?? [];
  const versions = reader.strings(tags.version) ?? [];
  const indexes = reader.numbers(tags.index) ?? [];
  const progs = reader.strings(tags.prog) ?? [];
  const scriptFlags = reader.numbers(tags.scriptFlags) ?? [];
  const priorities =
    tags.priorities === null ? null : (reader.numbers(tags.priorities) ?? []);
  if (
    [flags.length, versions.length, indexes.length].some(
      (length) => length !== names.length,
    )
  )
    reader.problems.push(
      `${label}: condition names, flags, versions and indexes differ in length.`,
    );
  for (const index of indexes)
    if (index >= scripts.length)
      reader.problems.push(
        `${label}: a condition points at script ${String(index)} of ${String(scripts.length)}.`,
      );
  return scripts.map((body, script) => {
    const members = indexes.flatMap((index, condition) =>
      index === script && condition < names.length ? [condition] : [],
    );
    const conditions = members.map((condition) =>
      dependency(
        names[condition] ?? "",
        flags[condition] ?? 0,
        versions[condition] ?? "",
        reader.problems,
      ),
    );
    const suffixes = new Set(
      members.map((condition) => triggerSuffix(flags[condition] ?? 0)),
    );
    if (suffixes.size > 1)
      reader.problems.push(
        `${label}: script ${String(script)} has conditions of different trigger kinds; the first is used.`,
      );
    const first = members[0];
    const prog = progs[script];
    return {
      kind: `${tags.prefix}${first === undefined ? "" : triggerSuffix(flags[first] ?? 0)}`,
      conditions,
      interpreter: prog === undefined ? [] : [prog],
      body,
      priority: priorities === null ? null : (priorities[script] ?? null),
      flags: scriptFlagNames(scriptFlags[script] ?? 0),
    };
  });
};

/** Classic, file and transaction file triggers, one entry per trigger script. */
export const triggers = (reader: Reader): RpmTrigger[] =>
  TRIGGER_TAGS.flatMap((tags) => triggerList(reader, tags));
