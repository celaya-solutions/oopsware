/**
 * freedesktop.org Desktop Entry files (Desktop Entry Specification 1.5):
 * groups, `Key[locale]=value` entries, comments and blank lines. Values
 * keep their text with the string escapes decoded; nothing is launched.
 */

export interface DesktopEntryValue {
  readonly key: string;
  /** The `[locale]` suffix, e.g. "de_DE@euro"; null for the unlocalized key. */
  readonly locale: string | null;
  readonly value: string;
}

export interface DesktopEntryGroup {
  readonly name: string;
  readonly entries: readonly DesktopEntryValue[];
}

export interface DesktopEntryFile {
  readonly groups: readonly DesktopEntryGroup[];
  readonly problems: readonly string[];
}

/** Group names: printable ASCII except "[" and "]". */
const GROUP = /^\[([\x20-\x5a\x5c\x5e-\x7e]+)\]$/u;
/** Keys: A-Za-z0-9- with an optional [locale]; spaces around "=" are ignored. */
const ENTRY = /^([A-Za-z0-9-]+)(?:\[([^\]]+)\])?[ \t]*=[ \t]*(.*)$/u;

/** \s \n \t \r and \\ decode for string values; other escapes (such as \; in lists) are kept as written. */
const ESCAPES: Readonly<Record<string, string>> = {
  s: " ",
  n: "\n",
  t: "\t",
  r: "\r",
  "\\": "\\",
};

const unescape = (value: string): string =>
  value.replace(
    /\\(.)/gu,
    (escape, character: string) => ESCAPES[character] ?? escape,
  );

/** Parse a desktop entry file; malformed lines are reported and skipped. */
export const parseDesktopEntry = (text: string): DesktopEntryFile => {
  const groups: {
    name: string;
    entries: DesktopEntryValue[];
    keys: Set<string>;
  }[] = [];
  const problems: string[] = [];
  const names = new Set<string>();
  for (const [index, raw] of text.split("\n").entries()) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const number = index + 1;
    const content = line.trimStart();
    if (content === "" || content.startsWith("#")) continue;
    const group = GROUP.exec(content);
    if (group !== null) {
      const name = group[1] ?? "";
      if (groups.length === 0 && name !== "Desktop Entry")
        problems.push(
          `Line ${String(number)}: the first group is [${name}], not [Desktop Entry].`,
        );
      if (names.has(name))
        problems.push(
          `Line ${String(number)}: group [${name}] appears more than once.`,
        );
      names.add(name);
      groups.push({ name, entries: [], keys: new Set() });
      continue;
    }
    const entry = ENTRY.exec(content);
    if (entry === null) {
      problems.push(
        `Line ${String(number)}: "${content}" is not a group header, an entry or a comment.`,
      );
      continue;
    }
    const current = groups.at(-1);
    if (current === undefined) {
      problems.push(
        `Line ${String(number)}: an entry appears before any group.`,
      );
      continue;
    }
    const key = entry[1] ?? "";
    const locale = entry[2] ?? null;
    const identity = locale === null ? key : `${key}[${locale}]`;
    if (current.keys.has(identity))
      problems.push(
        `Line ${String(number)}: ${identity} appears more than once in [${current.name}].`,
      );
    current.keys.add(identity);
    current.entries.push({ key, locale, value: unescape(entry[3] ?? "") });
  }
  return {
    groups: groups.map(({ name, entries }) => ({ name, entries })),
    problems,
  };
};
