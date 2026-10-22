/** One control field: name as written, value per its field type, 1-based line of the name. */
export interface ControlField {
  readonly name: string;
  readonly value: string;
  readonly line: number;
}

export interface DebianControl {
  readonly fields: readonly ControlField[];
  readonly problems: readonly string[];
}

/**
 * Multiline fields keep their continuation lines verbatim (deb822(5)); in a
 * binary package only Description is one. Every other field is folded:
 * deb-control(5) says tools join its lines, so whitespace runs including
 * newlines become one space.
 */
const MULTILINE_FIELDS = new Set([
  "description",
  "changes",
  "files",
  "checksums-sha1",
  "checksums-sha256",
  "package-list",
  "conffiles",
]);

/** Fields Debian Policy 5.6 defines as folded; other known fields are simple. */
const FOLDED_FIELDS = new Set([
  "depends",
  "pre-depends",
  "recommends",
  "suggests",
  "enhances",
  "breaks",
  "conflicts",
  "provides",
  "replaces",
  "built-using",
  "static-built-using",
  "uploaders",
  "binary",
  "build-depends",
  "build-depends-indep",
  "build-depends-arch",
  "build-conflicts",
  "build-conflicts-indep",
  "build-conflicts-arch",
  "built-for-profiles",
  "tag",
]);

/** deb822(5): U+0021..U+0039 and U+003B..U+007E, not starting with "#" or "-". */
const FIELD_NAME = /^[!-9;-~]+$/u;

interface OpenField {
  readonly name: string;
  readonly line: number;
  readonly first: string;
  readonly continuation: string[];
}

const closeField = (field: OpenField, problems: string[]): ControlField => {
  const lower = field.name.toLowerCase();
  if (field.first === "" && field.continuation.length === 0)
    problems.push(
      `Field ${field.name} (line ${String(field.line)}) has an empty value.`,
    );
  if (MULTILINE_FIELDS.has(lower))
    return {
      name: field.name,
      value: [field.first, ...field.continuation].join("\n"),
      line: field.line,
    };
  if (field.continuation.length > 0 && !FOLDED_FIELDS.has(lower))
    problems.push(
      `Field ${field.name} (line ${String(field.line)}) is folded over ${String(field.continuation.length + 1)} lines; Debian Policy defines it as a single line.`,
    );
  const value = [field.first, ...field.continuation]
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .join(" ");
  return { name: field.name, value, line: field.line };
};

/** Line-by-line deb822 stanza reader; `fields` keeps the first stanza only. */
class StanzaReader {
  readonly problems: string[] = [];
  readonly fields: ControlField[] = [];
  readonly #seen = new Map<string, number>();
  #open: OpenField | null = null;
  #stanzaEnded = false;
  /** Line where a second stanza starts, once one does. */
  extraStanzaLine: number | null = null;

  finish(): void {
    const open = this.#open;
    if (open === null) return;
    this.#open = null;
    const field = closeField(open, this.problems);
    const lower = field.name.toLowerCase();
    const earlier = this.#seen.get(lower);
    if (earlier === undefined) {
      this.#seen.set(lower, field.line);
      this.fields.push(field);
    } else
      this.problems.push(
        `Field ${field.name} (line ${String(field.line)}) repeats the field on line ${String(earlier)}; only the first is kept.`,
      );
  }

  /** Read one line; false once a second stanza begins. */
  line(line: string, number: number): boolean {
    if (/^[ \t]*$/u.test(line)) {
      if (line !== "")
        this.problems.push(
          `Line ${String(number)} holds only spaces or tabs; it is read as a stanza separator.`,
        );
      this.finish();
      if (this.fields.length > 0) this.#stanzaEnded = true;
    } else if (line.startsWith("#"))
      this.problems.push(
        `Line ${String(number)} is a comment, which deb822(5) allows only in source control files; it is ignored.`,
      );
    else if (this.#stanzaEnded) {
      this.extraStanzaLine = number;
      return false;
    } else if (line.startsWith(" ") || line.startsWith("\t")) {
      if (this.#open === null)
        this.problems.push(
          `Line ${String(number)} is a continuation line with no field before it.`,
        );
      else this.#open.continuation.push(line);
    } else this.#field(line, number);
    return true;
  }

  #field(line: string, number: number): void {
    this.finish();
    const colon = line.indexOf(":");
    const name = colon < 0 ? line : line.slice(0, colon);
    if (
      colon <= 0 ||
      !FIELD_NAME.test(name) ||
      name.startsWith("#") ||
      name.startsWith("-")
    ) {
      this.problems.push(
        `Line ${String(number)} is not a "Name: value" field (${JSON.stringify(line.slice(0, 80))}).`,
      );
      return;
    }
    this.#open = {
      name,
      line: number,
      first: line.slice(colon + 1).replace(/^[ \t]+|[ \t]+$/gu, ""),
      continuation: [],
    };
  }
}

/**
 * Parse binary package control data (deb-control(5), deb822(5), Debian
 * Policy 5.1): one stanza of "Name: value" fields with continuation lines
 * starting with a space or tab. Field order is kept; a later stanza,
 * comment lines, duplicate names and malformed lines are problems, never
 * silently merged.
 */
export const parseControl = (text: string): DebianControl => {
  const reader = new StanzaReader();
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  else if (text !== "")
    reader.problems.push("Control data does not end with a newline.");
  if (text.includes("\r"))
    reader.problems.push("Control data contains carriage returns.");
  for (const [index, line] of lines.entries())
    if (!reader.line(line, index + 1)) break;
  reader.finish();
  if (reader.extraStanzaLine !== null)
    reader.problems.push(
      `A second stanza starts on line ${String(reader.extraStanzaLine)}; binary control data holds one stanza and only the first is read.`,
    );
  if (reader.fields.length === 0)
    reader.problems.push("Control data has no fields.");
  return { fields: reader.fields, problems: reader.problems };
};

export type RelationOperator = "<<" | "<=" | "=" | ">=" | ">>";

export interface DebianRelation {
  readonly name: string;
  readonly arch_qualifier: string | null;
  readonly version: {
    readonly operator: RelationOperator;
    readonly version: string;
  } | null;
  readonly architectures: readonly string[];
  readonly profiles: readonly string[];
  readonly text: string;
}

/** Relationship fields of Debian Policy 7 that parseRelations reads. */
export const RELATION_FIELDS: readonly string[] = [
  "Depends",
  "Pre-Depends",
  "Recommends",
  "Suggests",
  "Enhances",
  "Breaks",
  "Conflicts",
  "Provides",
  "Replaces",
  "Built-Using",
  "Static-Built-Using",
];

/** Policy 7.1/7.3/7.4/7.6: these fields may not list alternatives. */
const NO_ALTERNATIVES = new Set([
  "breaks",
  "conflicts",
  "provides",
  "replaces",
  "built-using",
  "static-built-using",
]);

/** dpkg's pkg_name_is_illegal: an alphanumeric first, then letters, digits, "+", "-", "." or "_". */
const PACKAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9+._-]*$/u;
const ARCH_NAME = /^!?[a-z0-9][a-z0-9-]*$/u;

/** deb-version(7) checks dpkg makes; each failure is a problem, never a fix. */
export const versionProblems = (version: string): string[] => {
  const problems: string[] = [];
  if (/\s/u.test(version)) problems.push("contains whitespace");
  const colon = version.indexOf(":");
  const epoch = colon < 0 ? null : version.slice(0, colon);
  const rest = colon < 0 ? version : version.slice(colon + 1);
  if (epoch !== null && !/^[0-9]+$/u.test(epoch))
    problems.push(`epoch ${JSON.stringify(epoch)} is not a number`);
  if (rest === "") problems.push("nothing after the epoch");
  const hyphen = rest.lastIndexOf("-");
  const upstream = hyphen < 0 ? rest : rest.slice(0, hyphen);
  const revision = hyphen < 0 ? null : rest.slice(hyphen + 1);
  if (upstream !== "" && !/^[0-9]/u.test(upstream))
    problems.push("upstream version does not start with a digit");
  if (!/^[A-Za-z0-9.+~:-]*$/u.test(upstream))
    problems.push("upstream version has a character outside [A-Za-z0-9.+~:-]");
  if (revision !== null) {
    if (revision === "") problems.push("revision is empty");
    else if (!/^[A-Za-z0-9.+~]+$/u.test(revision))
      problems.push("revision has a character outside [A-Za-z0-9.+~]");
  }
  return problems;
};

const RELATION =
  /^([^\s:([<]+)(?::([^\s([<]+))?\s*(?:\(\s*(<<|<=|=|>=|>>|<|>)?\s*([^\s)]*)\s*\))?\s*(?:\[([^\]]*)\])?\s*((?:<[^>]*>\s*)*)$/u;

/** The "(op version)" part; obsolete "<" and ">" read as dpkg reads them, and named. */
const relationVersion = (
  rawOperator: string | undefined,
  rawVersion: string | undefined,
  where: string,
  problems: string[],
): DebianRelation["version"] => {
  if (rawVersion === undefined) return null;
  if (rawOperator === undefined || rawVersion === "") {
    problems.push(
      `${where}: a version restriction needs an operator and a version.`,
    );
    return null;
  }
  let operator = rawOperator as RelationOperator;
  if (rawOperator === "<" || rawOperator === ">") {
    operator = rawOperator === "<" ? "<=" : ">=";
    problems.push(
      `${where}: obsolete operator "${rawOperator}"; dpkg reads it as "${operator}".`,
    );
  }
  for (const problem of versionProblems(rawVersion))
    problems.push(
      `${where}: version ${JSON.stringify(rawVersion)} ${problem}.`,
    );
  return { operator, version: rawVersion };
};

/** The "[arch !arch]" list: valid names, never empty, all negated or none. */
const relationArchitectures = (
  archText: string | undefined,
  where: string,
  problems: string[],
): string[] => {
  if (archText === undefined) return [];
  const architectures = archText.trim().split(/\s+/u).filter(Boolean);
  if (architectures.length === 0)
    problems.push(`${where}: empty architecture list.`);
  for (const architecture of architectures)
    if (!ARCH_NAME.test(architecture))
      problems.push(
        `${where}: architecture ${JSON.stringify(architecture)} is not valid.`,
      );
  if (new Set(architectures.map((arch) => arch.startsWith("!"))).size > 1)
    problems.push(
      `${where}: architecture list ${JSON.stringify(archText)} mixes negated and plain entries.`,
    );
  return architectures;
};

const parseRelation = (
  text: string,
  label: string,
  problems: string[],
): DebianRelation | null => {
  const where = `${label}: ${JSON.stringify(text)}`;
  const match = RELATION.exec(text);
  if (match === null) {
    problems.push(`${where} is not a relation.`);
    return null;
  }
  const [
    ,
    name = "",
    qualifier,
    rawOperator,
    rawVersion,
    archText,
    profileText = "",
  ] = match;
  if (!PACKAGE_NAME.test(name))
    problems.push(
      `${where}: package name ${JSON.stringify(name)} is not valid.`,
    );
  if (qualifier !== undefined && !/^[a-z0-9][a-z0-9-]*$/u.test(qualifier))
    problems.push(
      `${where}: architecture qualifier ${JSON.stringify(qualifier)} is not valid.`,
    );
  const profiles = [...profileText.matchAll(/<([^>]*)>/gu)].map((group) =>
    (group[1] ?? "").trim().split(/\s+/u).filter(Boolean).join(" "),
  );
  if (profiles.includes(""))
    problems.push(`${where}: empty build profile list.`);
  return {
    name,
    arch_qualifier: qualifier ?? null,
    version: relationVersion(rawOperator, rawVersion, where, problems),
    architectures: relationArchitectures(archText, where, problems),
    profiles,
    text,
  };
};

/**
 * AND of OR-groups: "Depends: a | b, c" gives [[a, b], [c]]. Pass `field` to
 * check field rules (no alternatives in Conflicts, Breaks, Provides,
 * Replaces, Built-Using). Problems for malformed parts, never a guess:
 * an unreadable relation is left out and named.
 */
export const parseRelations = (
  value: string,
  field?: string,
): {
  readonly groups: readonly (readonly DebianRelation[])[];
  readonly problems: readonly string[];
} => {
  const problems: string[] = [];
  const groups: DebianRelation[][] = [];
  const label = field ?? "relation";
  const parts = value.split(",");
  for (const [index, part] of parts.entries()) {
    const trimmed = part.trim();
    if (trimmed === "") {
      // A trailing comma is tolerated by dpkg; an empty middle entry is not.
      if (index !== parts.length - 1 || parts.length === 1)
        problems.push(`${label}: empty entry ${String(index + 1)}.`);
      continue;
    }
    const alternatives = trimmed
      .split("|")
      .map((alternative) => alternative.trim());
    if (
      alternatives.length > 1 &&
      field !== undefined &&
      NO_ALTERNATIVES.has(field.toLowerCase())
    )
      problems.push(
        `${label}: entry ${JSON.stringify(trimmed)} lists alternatives, which ${field} does not allow.`,
      );
    const group: DebianRelation[] = [];
    for (const alternative of alternatives) {
      if (alternative === "") {
        problems.push(
          `${label}: empty alternative in ${JSON.stringify(trimmed)}.`,
        );
        continue;
      }
      const relation = parseRelation(alternative, label, problems);
      if (relation !== null) group.push(relation);
    }
    if (group.length > 0) groups.push(group);
  }
  return { groups, problems };
};

/** deb-conffiles(5): an absolute path per line, optionally after a flag. */
export const parseConffiles = (
  text: string,
): {
  readonly paths: readonly {
    readonly path: string;
    readonly flags: readonly string[];
  }[];
  readonly problems: readonly string[];
} => {
  const problems: string[] = [];
  const paths: { path: string; flags: string[] }[] = [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  else if (text !== "") problems.push("conffiles does not end with a newline.");
  for (const [index, raw] of lines.entries()) {
    const line = raw.replace(/\s+$/u, "");
    if (line === "") {
      problems.push(
        `conffiles line ${String(index + 1)} is empty, which dpkg does not accept.`,
      );
      continue;
    }
    const flags: string[] = [];
    let path = line;
    if (!line.startsWith("/")) {
      const space = line.search(/\s/u);
      if (space > 0) {
        flags.push(line.slice(0, space));
        path = line.slice(space).trimStart();
      }
    }
    if (!path.startsWith("/")) {
      problems.push(
        `conffiles line ${String(index + 1)} is not an absolute path (${JSON.stringify(line)}).`,
      );
      continue;
    }
    for (const flag of flags)
      if (flag !== "remove-on-upgrade")
        problems.push(
          `conffiles line ${String(index + 1)} has unknown flag ${JSON.stringify(flag)}.`,
        );
    paths.push({ path, flags });
  }
  return { paths, problems };
};

/** md5sum(1) lines as dh_md5sums writes them: 32 hex digits, two spaces (or " *"), a relative path. */
export const parseMd5sums = (
  text: string,
): {
  readonly entries: readonly { readonly path: string; readonly md5: string }[];
  readonly problems: readonly string[];
} => {
  const problems: string[] = [];
  const entries: { path: string; md5: string }[] = [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  else if (text !== "") problems.push("md5sums does not end with a newline.");
  for (const [index, line] of lines.entries()) {
    const match = /^([0-9a-fA-F]{32}) [ *](.+)$/u.exec(line);
    if (match === null) {
      problems.push(
        `md5sums line ${String(index + 1)} is not "<md5>  <path>" (${JSON.stringify(line.slice(0, 80))}).`,
      );
      continue;
    }
    const [, md5 = "", path = ""] = match;
    if (md5 !== md5.toLowerCase())
      problems.push(`md5sums line ${String(index + 1)} uses upper-case hex.`);
    entries.push({ path, md5: md5.toLowerCase() });
  }
  return { entries, problems };
};

const TRIGGER_DIRECTIVES = new Set([
  "interest",
  "interest-await",
  "interest-noawait",
  "activate",
  "activate-await",
  "activate-noawait",
]);

/** deb-triggers(5): "directive name" lines; text after "#" and blank lines are ignored. */
export const parseTriggers = (
  text: string,
): {
  readonly triggers: readonly {
    readonly directive: string;
    readonly name: string;
  }[];
  readonly problems: readonly string[];
} => {
  const problems: string[] = [];
  const triggers: { directive: string; name: string }[] = [];
  for (const [index, raw] of text.split("\n").entries()) {
    const hash = raw.indexOf("#");
    const line = (hash < 0 ? raw : raw.slice(0, hash)).trim();
    if (line === "") continue;
    const words = line.split(/\s+/u);
    const [directive = "", name] = words;
    if (name === undefined || words.length !== 2) {
      problems.push(
        `triggers line ${String(index + 1)} is not "directive name" (${JSON.stringify(line)}).`,
      );
      continue;
    }
    if (!TRIGGER_DIRECTIVES.has(directive))
      problems.push(
        `triggers line ${String(index + 1)} has unknown directive ${JSON.stringify(directive)}.`,
      );
    // dpkg rejects trigger names with characters <= ' ' or >= DEL.
    if (
      [...name].some((character) => character <= " " || character >= "\u007f")
    )
      problems.push(
        `triggers line ${String(index + 1)} names a trigger with an invalid character.`,
      );
    triggers.push({ directive, name });
  }
  return { triggers, problems };
};
