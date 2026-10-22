import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  constants,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync, zstdDecompressSync } from "node:zlib";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { PositionalRead } from "../deb/ar.js";
import {
  checkHeaderDigests,
  rpmFacts,
  type RpmDependency,
  type RpmPackageFacts,
} from "./facts.js";
import {
  DEPENDENCY_FLAG_BITS,
  FILE_FLAG_BITS,
  SCRIPT_FLAG_BITS,
} from "./flags.js";
import {
  readRpm,
  RpmFormatError,
  type RpmFile,
  type RpmValue,
} from "./header.js";
import { RPM_TAGS } from "./tags.js";
import {
  buildLinuxFixtures,
  LINUX_TOOLS,
} from "../../../tests/fixtures/linuxProducers.js";
import { removeTestWorkspace } from "../../../tests/support/workspace/workspaceFixture.js";

/**
 * The RPM lead/header reader and the package facts checked against rpm
 * 6.1.0 itself: every stored tag of both headers against `rpm -qp --qf`,
 * facts against `--info`, the dependency queries, `--scripts`,
 * `--triggers`, `--filetriggers` and `--dump`, and header digests against
 * the values rpm prints for an edited header. Packages: the F05 fixtures
 * (rpm 6 format), a coverage spec built here in rpm 4 and rpm 6 formats,
 * and copies signed with a throwaway GnuPG key when gpg is installed.
 */

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const XZ = (await exists("/opt/homebrew/bin/xz"))
  ? "/opt/homebrew/bin/xz"
  : (await exists("/usr/bin/xz"))
    ? "/usr/bin/xz"
    : null;
const GPG = (await exists("/opt/homebrew/bin/gpg"))
  ? "/opt/homebrew/bin/gpg"
  : (await exists("/usr/local/bin/gpg"))
    ? "/usr/local/bin/gpg"
    : null;
const READY = LINUX_TOOLS !== null && XZ !== null;

interface Run {
  readonly code: number | null;
  readonly stdout: Buffer;
  readonly stderr: string;
}

const execute = (
  command: string,
  args: readonly string[],
  extra: Record<string, string> = {},
  input?: Uint8Array,
): Promise<Run> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      env: {
        PATH: "/opt/homebrew/bin:/usr/bin:/bin",
        HOME: process.env.HOME ?? "/tmp",
        LC_ALL: "C",
        ...(process.env.TZ === undefined ? {} : { TZ: process.env.TZ }),
        ...extra,
      },
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({
        code,
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err).toString(),
      }),
    );
    child.stdin.end(input ?? Buffer.alloc(0));
  });

const pipe = async (
  command: string,
  args: readonly string[],
  extra: Record<string, string> = {},
  input?: Uint8Array,
): Promise<Buffer> => {
  const result = await execute(command, args, extra, input);
  if (result.code !== 0)
    throw new Error(
      `${command} ${args.join(" ")} exited ${String(result.code)}: ${result.stderr}`,
    );
  return result.stdout;
};

const rpm = (): string => LINUX_TOOLS?.rpm ?? "rpm";
const query = async (path: string, ...args: string[]): Promise<string> =>
  (await pipe(rpm(), ["-qp", ...args, path])).toString("utf8");

const positional =
  (bytes: Uint8Array): PositionalRead =>
  async (offset, length) =>
    bytes.subarray(offset, offset + length);

/** One spec for everything the F05 fixture spec leaves out: epoch, i18n, every scriptlet and trigger kind, hard links, file flags. */
const COVERAGE_SPEC = `Name:           cov-demo
Epoch:          3
Version:        2.0~rc1
Release:        4.el9
Summary:        Coverage package
Summary(de):    Abdeckungspaket
License:        GPL-2.0-or-later AND MIT
URL:            https://example.invalid/cov
Vendor:         Oops Vendor
Packager:       Oops Packager <p@example.invalid>
Group:          Development/Tools
BugURL:         https://example.invalid/bugs
AutoReqProv:    no
Requires:       foo >= 1:2.3-4
Requires:       bar > 1
Requires:       baz < 2
Requires:       qux <= 3
Requires:       quux = 4
Requires:       (a if b else c)
Requires:       ((x and y) or z)
Requires(pre):  shadow-utils
Requires(preun): coreutils
Requires(postun): grep
Requires(pretrans): sed
Requires(posttrans): gawk
Requires(meta): metadep
OrderWithRequires: ordered-thing >= 1
Provides:       cov(api) = 2
Conflicts:      cov-old < 1
Obsoletes:      cov-ancient <= 0.9
Recommends:     (rec1 if rec2)
Suggests:       sugg
Supplements:    (sup1 and sup2)
Enhances:       enh

%description
Coverage description line one.

Second paragraph.

%description -l de
Deutsche Beschreibung.

%install
mkdir -p %{buildroot}/usr/share/cov %{buildroot}/usr/bin %{buildroot}/usr/lib/.build-id %{buildroot}/usr/share/locale/de/LC_MESSAGES
printf 'a\\n' > %{buildroot}/usr/share/cov/a.txt
ln %{buildroot}/usr/share/cov/a.txt %{buildroot}/usr/share/cov/a-hard.txt
ln %{buildroot}/usr/share/cov/a.txt %{buildroot}/usr/share/cov/a-hard2.txt
printf 'lic\\n' > %{buildroot}/usr/share/cov/LICENSE
printf 'readme\\n' > %{buildroot}/usr/share/cov/README
printf 'bb\\n' > %{buildroot}/usr/share/cov/b.txt
printf 'art\\n' > %{buildroot}/usr/lib/.build-id/art
printf 'mo\\n' > %{buildroot}/usr/share/locale/de/LC_MESSAGES/cov.mo
printf '#!/bin/sh\\n' > %{buildroot}/usr/bin/tool
chmod 4755 %{buildroot}/usr/bin/tool
ln -s tool %{buildroot}/usr/bin/tool-link

%pretrans
echo pretrans

%pre -e
echo "pre %{name}"

%post -q
echo "post %%{NAME}"

%preuntrans
echo preuntrans

%postuntrans -p /bin/sh
echo postuntrans

%verifyscript
echo verify

%triggerprein -- foo
echo prein

%triggerun -p /bin/bash -- bar < 2, baz
echo un

%triggerpostun -- qux >= 1:1
echo postun

%filetriggerin -P 1000 -- /usr/lib
echo filein

%filetriggerun -- /usr/share/cov
echo fileun

%transfiletriggerin -p <lua> -P 500 -- /usr/bin
print("transin")

%transfiletriggerpostun -- /etc
echo transpostun

%files
%license /usr/share/cov/LICENSE
%readme /usr/share/cov/README
/usr/share/cov/a.txt
/usr/share/cov/a-hard.txt
/usr/share/cov/a-hard2.txt
%config(missingok) /usr/share/cov/b.txt
%artifact /usr/lib/.build-id/art
%lang(de) /usr/share/locale/de/LC_MESSAGES/cov.mo
/usr/bin/tool
/usr/bin/tool-link
%ghost %config(noreplace) /etc/cov.conf
%dir /usr/share/cov

%changelog
* Mon Oct 19 2026 Oops Packager <p@example.invalid> - 3:2.0~rc1-4.el9
- Second entry

* Sun Oct 18 2026 Oops Packager <p@example.invalid> - 1.0-1
- First entry
`;

const PACKAGES = [
  "oops-v6-zstd",
  "oops-v6-xz",
  "oops-v6-gzip",
  "cov-v4",
  "cov-v6",
] as const;
type Label = (typeof PACKAGES)[number] | "signed-cov-v4" | "signed-oops-v6";

let root = "";
let gnupg = "";
const paths = new Map<Label, string>();
let queryTags = new Set<string>();

const buildCoverage = async (format: 4 | 6): Promise<string> => {
  const top = join(root, `cov-v${String(format)}`);
  await mkdir(join(top, "SPECS"), { recursive: true });
  await writeFile(join(top, "SPECS", "cov.spec"), COVERAGE_SPEC);
  await pipe(LINUX_TOOLS?.rpmbuild ?? "rpmbuild", [
    "-bb",
    "--target",
    "x86_64-linux",
    "--define",
    `_topdir ${top}`,
    "--define",
    "_build_id_links none",
    "--define",
    `_rpmformat ${String(format)}`,
    join(top, "SPECS", "cov.spec"),
  ]);
  return join(top, "RPMS", "x86_64", "cov-demo-2.0~rc1-4.el9.x86_64.rpm");
};

/** Sign copies with a throwaway key; leaves `paths` without signed entries when gpg cannot. */
const signCopies = async (): Promise<void> => {
  if (GPG === null) return;
  // gpg-agent's socket path must stay short, so the home lives directly under the temp directory.
  gnupg = await realpath(await mkdtemp(join(tmpdir(), "og-")));
  const environment = { GNUPGHOME: gnupg };
  const parameters = join(gnupg, "key.params");
  await writeFile(
    parameters,
    "%no-protection\nKey-Type: RSA\nKey-Length: 2048\nName-Real: Oops Fixture\nName-Email: fixture@example.invalid\nExpire-Date: 0\n%commit\n",
  );
  await pipe(GPG, ["--batch", "--gen-key", parameters], environment);
  const rpmsign = join(dirname(rpm()), "rpmsign");
  for (const [label, source] of [
    ["signed-cov-v4", paths.get("cov-v4")],
    ["signed-oops-v6", paths.get("oops-v6-zstd")],
  ] as const) {
    if (source === undefined) continue;
    const target = join(root, `${label}.rpm`);
    await writeFile(target, await readFile(source));
    await pipe(
      rpmsign,
      [
        "--addsign",
        "--define",
        "_gpg_name fixture@example.invalid",
        "--define",
        `_gpg_path ${gnupg}`,
        "--define",
        `__gpg ${GPG}`,
        target,
      ],
      environment,
    );
    paths.set(label, target);
  }
};

beforeAll(async () => {
  if (!READY) return;
  root = await realpath(await mkdtemp(join(tmpdir(), "oops-rpm-")));
  const fixtures = await buildLinuxFixtures(root);
  paths.set("oops-v6-zstd", fixtures.rpm.zstd);
  paths.set("oops-v6-xz", fixtures.rpm.xz);
  paths.set("oops-v6-gzip", fixtures.rpm.gzip);
  paths.set("cov-v4", await buildCoverage(4));
  paths.set("cov-v6", await buildCoverage(6));
  queryTags = new Set(
    (await pipe(rpm(), ["--querytags"])).toString().trim().split("\n"),
  );
  await signCopies();
}, 180_000);

afterAll(async () => {
  if (gnupg !== "") {
    await execute("gpgconf", ["--kill", "gpg-agent"], { GNUPGHOME: gnupg });
    await removeTestWorkspace(gnupg);
  }
  if (root !== "") await removeTestWorkspace(root);
});

const load = async (label: Label) => {
  const path = paths.get(label);
  if (path === undefined) throw new Error(`no package ${label}`);
  const bytes = await readFile(path);
  const read = positional(bytes);
  const file = await readRpm(read, bytes.length);
  return { path, bytes, read, file, facts: rpmFacts(file) };
};

/** Signature tags as rpm merges them into the queryable header (headerMergeLegacySigs). */
const SIGNATURE_QUERY: ReadonlyMap<number, string> = new Map([
  [1000, "SIGSIZE"],
  [1002, "SIGPGP"],
  [1004, "SIGMD5"],
  [1005, "SIGGPG"],
  [1007, "ARCHIVESIZE"],
  [267, "DSAHEADER"],
  [268, "RSAHEADER"],
  [269, "SHA1HEADER"],
  [270, "LONGSIGSIZE"],
  [271, "LONGARCHIVESIZE"],
  [273, "SHA256HEADER"],
  [274, "FILESIGNATURES"],
  [275, "FILESIGNATURELENGTH"],
  [276, "VERITYSIGNATURES"],
  [277, "VERITYSIGNATUREALGO"],
  [278, "OPENPGP"],
  [279, "SHA3_256HEADER"],
]);
/** The signature region, rpm 6's RESERVED space and rpm 4's RESERVEDSPACE have no query name. */
const SIGNATURE_UNQUERYABLE = new Set([62, 999, 1008]);

const render = (value: RpmValue, locale: number): string[] => {
  switch (value.type) {
    case "null":
      return [];
    case "bin":
      return [Buffer.from(value.bytes).toString("hex")];
    case "int64":
      return value.values.map(String);
    case "i18nstring":
      return [value.values[locale] ?? ""];
    default:
      return value.values.map(String);
  }
};

/** One rpm call printing every requested tag between markers, elements split by a sentinel. */
const queryTagValues = async (
  path: string,
  names: readonly string[],
): Promise<Map<string, string[]>> => {
  const format =
    names.map((name) => `@@${name}@@[%{${name}}<<#>>]`).join("") + "@@END@@";
  const output = await query(path, "--qf", format);
  const values = new Map<string, string[]>();
  for (const [index, name] of names.entries()) {
    const start = output.indexOf(`@@${name}@@`) + name.length + 4;
    const end = output.indexOf(`@@${names[index + 1] ?? "END"}@@`, start);
    values.set(name, output.slice(start, end).split("<<#>>").slice(0, -1));
  }
  return values;
};

const expectTagsMatchRpm = async (label: Label): Promise<void> => {
  const { path, bytes, file } = await load(label);
  expect(file.problems).toEqual([]);
  expect(file.signature.problems).toEqual([]);
  expect(file.header.problems).toEqual([]);
  expect(file.header.undecodable.size).toBe(0);
  const i18n = file.header.entries.get(100);
  const locale =
    i18n !== undefined && i18n.type === "string_array"
      ? Math.max(0, i18n.values.indexOf("C"))
      : 0;
  const expected = new Map<string, string[]>();
  const unqueryable: number[] = [];
  for (const [tag, value] of file.header.entries) {
    const name = (RPM_TAGS.get(tag) ?? "").toUpperCase();
    const classes = file.header.entries.get(1142);
    if (tag === 63)
      // rpm prints the immutable region itself: index count, data size, index and data.
      expected.set(name, [
        Buffer.from(
          bytes.subarray(
            file.header.offset + 8,
            file.header.offset + file.header.length,
          ),
        ).toString("hex"),
      ]);
    else if (
      tag === 1141 &&
      value.type === "int32" &&
      classes?.type === "string_array"
    ) {
      // %{FILECLASS} is rpm's fileclass extension: the CLASSDICT entry each index names,
      // and "symbolic link to `target'" for a symlink whose class is empty.
      const modes = file.header.entries.get(1030);
      const targets = file.header.entries.get(1036);
      expected.set(
        name,
        value.values.map((index, file) => {
          const symlink =
            modes?.type === "int16" &&
            ((modes.values[file] ?? 0) & 0o170000) === 0o120000;
          const target =
            targets?.type === "string_array" ? targets.values[file] : undefined;
          const stored = classes.values[index] ?? "";
          return stored === "" && symlink
            ? `symbolic link to \`${target ?? ""}'`
            : stored;
        }),
      );
    } else if (queryTags.has(name)) expected.set(name, render(value, locale));
    else unqueryable.push(tag);
  }
  for (const [tag, value] of file.signature.entries) {
    const name = SIGNATURE_QUERY.get(tag);
    if (name === undefined)
      expect(
        SIGNATURE_UNQUERYABLE.has(tag),
        `signature tag ${String(tag)}`,
      ).toBe(true);
    else if (!(tag === 1007 && file.header.entries.has(1046)))
      expected.set(name, render(value, 0));
  }
  expect(unqueryable).toEqual([]);
  const actual = await queryTagValues(path, [...expected.keys()]);
  for (const [name, values] of expected)
    expect(actual.get(name), name).toEqual(values);
  expect(expected.size).toBeGreaterThan(60);
};

describe.skipIf(!READY)("every stored header tag against rpm -qp --qf", () => {
  it.each(PACKAGES)("%s", expectTagsMatchRpm);
});

const COMPARISON_BITS = { "<": 2, ">": 4, "=": 8, "<=": 10, ">=": 12 } as const;

/** The comparison and RPMSENSE bits a dependency was built from. */
const dependencyBits = (dependency: RpmDependency): number =>
  (dependency.operator === null ? 0 : COMPARISON_BITS[dependency.operator]) +
  dependency.flags.reduce(
    (sum, flag) => sum + 2 ** (DEPENDENCY_FLAG_BITS.get(flag) ?? Number.NaN),
    0,
  );

/** rpm's deptype format: our flag order already matches it; find-requires/find-provides print as "auto". */
const DEPTYPE_NAMES = new Set([
  "pre",
  "post",
  "preun",
  "postun",
  "verify",
  "interp",
  "rpmlib",
  "find-requires",
  "find-provides",
  "prereq",
  "pretrans",
  "posttrans",
  "preuntrans",
  "postuntrans",
  "config",
  "missingok",
  "meta",
]);
const deptype = (dependency: RpmDependency): string => {
  const names = [
    ...new Set(
      dependency.flags
        .filter((flag) => DEPTYPE_NAMES.has(flag))
        .map((flag) => (flag.startsWith("find-") ? "auto" : flag)),
    ),
  ];
  return names.length === 0 ? "manual" : names.join(",");
};

const C_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const C_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** strftime("%c") in the C locale, local time, as `%{BUILDTIME:date}` prints it. */
const cDate = (seconds: number): string => {
  const date = new Date(seconds * 1000);
  const two = (value: number): string => String(value).padStart(2, "0");
  return `${C_DAYS[date.getDay()] ?? ""} ${C_MONTHS[date.getMonth()] ?? ""} ${String(date.getDate()).padStart(2, " ")} ${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())} ${String(date.getFullYear())}`;
};

/** `rpm -qp --info` from the facts, with the signature block left as the marker SIGNATURE. */
const infoText = (facts: RpmPackageFacts): string =>
  [
    `Name         : ${facts.name ?? ""}`,
    ...(facts.epoch === null ? [] : [`Epoch        : ${String(facts.epoch)}`]),
    `Version      : ${facts.version ?? ""}`,
    `Release      : ${facts.release ?? ""}`,
    `Architecture : ${facts.arch ?? ""}`,
    "Install Date : (not installed)",
    `Group        : ${facts.group ?? ""}`,
    `Size         : ${String(facts.installed_size)}`,
    facts.license === null ? "" : `License      : ${facts.license}`,
    "SIGNATURE",
    `Source RPM   : ${facts.source_rpm ?? ""}`,
    `Build Date   : ${cDate(facts.build_time ?? 0)}`,
    `Build Host   : ${facts.build_host ?? ""}`,
    ...(facts.packager === null ? [] : [`Packager     : ${facts.packager}`]),
    ...(facts.vendor === null ? [] : [`Vendor       : ${facts.vendor}`]),
    ...(facts.url === null ? [] : [`URL          : ${facts.url}`]),
    ...(facts.bug_url === null ? [] : [`Bug URL      : ${facts.bug_url}`]),
    `Summary      : ${facts.summary ?? ""}`,
    "Description  :",
    `${facts.description ?? ""}`,
    "",
  ].join("\n");

const DEPENDENCY_QUERIES = [
  ["requires", "REQUIRE"],
  ["provides", "PROVIDE"],
  ["conflicts", "CONFLICT"],
  ["obsoletes", "OBSOLETE"],
  ["recommends", "RECOMMEND"],
  ["suggests", "SUGGEST"],
  ["supplements", "SUPPLEMENT"],
  ["enhances", "ENHANCE"],
  ["order_with_requires", "ORDER"],
] as const;

describe.skipIf(!READY)(
  "package facts against rpm --info and the dependency queries",
  () => {
    it.each(PACKAGES)("%s", async (label) => {
      const { path, facts } = await load(label);
      expect(facts.problems).toEqual([]);
      const info = (await query(path, "--info")).replace(
        /^Signature    :.*\n(?: {15}.*\n)*/mu,
        "SIGNATURE\n",
      );
      expect(info).toBe(infoText(facts));
      for (const [kind, prefix] of DEPENDENCY_QUERIES) {
        const list = facts.dependencies[kind];
        if (kind !== "order_with_requires")
          expect(
            list.map((dependency) => `${dependency.text}\n`).join(""),
            kind,
          ).toBe(await query(path, `--${kind}`));
        const raw = await query(
          path,
          "--qf",
          `[%{${prefix}NAME}|%{${prefix}FLAGS}|%{${prefix}VERSION}\n]`,
        );
        expect(
          list
            .map(
              (dependency) =>
                `${dependency.name}|${String(dependencyBits(dependency))}|${dependency.version ?? ""}\n`,
            )
            .join(""),
          kind,
        ).toBe(raw);
        for (const dependency of list)
          expect(dependency.rich).toBe(dependency.name.startsWith("("));
      }
      expect(
        facts.dependencies.requires
          .map((dependency) => `${deptype(dependency)}\n`)
          .join(""),
      ).toBe(await query(path, "--qf", "[%{REQUIREFLAGS:deptype}\n]"));
      const changelog = await query(path, "--qf", "[%{CHANGELOGTIME}\n]");
      expect(facts.changelog_entries).toBe(
        changelog.trim() === "" ? 0 : changelog.trim().split("\n").length,
      );
    });
  },
);

const SCRIPT_TITLES = {
  pretrans: "pretrans",
  pre: "preinstall",
  post: "postinstall",
  preun: "preuninstall",
  postun: "postuninstall",
  posttrans: "posttrans",
  preuntrans: "preuntrans",
  postuntrans: "postuntrans",
  verify: "verify",
} as const;

const SCRIPT_FLAG_TAGS = {
  pretrans: "PRETRANS",
  pre: "PREIN",
  post: "POSTIN",
  preun: "PREUN",
  postun: "POSTUN",
  posttrans: "POSTTRANS",
  preuntrans: "PREUNTRANS",
  postuntrans: "POSTUNTRANS",
  verify: "VERIFYSCRIPT",
} as const;

const bits = (
  names: readonly string[],
  table: ReadonlyMap<string, number>,
): number =>
  names.reduce((sum, name) => sum + 2 ** (table.get(name) ?? Number.NaN), 0);

describe.skipIf(!READY)(
  "scriptlets and triggers against rpm --scripts, --triggers and --filetriggers",
  () => {
    it.each(PACKAGES)("%s", async (label) => {
      const { path, facts } = await load(label);
      const scripts = facts.scriptlets
        .map((scriptlet) => {
          const title = SCRIPT_TITLES[scriptlet.name];
          const using = scriptlet.interpreter
            .map((part) => ` ${part}`)
            .join("");
          return scriptlet.body === null
            ? `${title} program:${using}\n`
            : `${title} scriptlet${using === "" ? "" : ` (using${using})`}:\n${scriptlet.body}\n`;
        })
        .join("");
      expect(scripts).toBe(await query(path, "--scripts"));
      const flagFormat = Object.values(SCRIPT_FLAG_TAGS)
        .map((tag) => `%{${tag}FLAGS}`)
        .join("|");
      const flagValues = (await query(path, "--qf", flagFormat))
        .split("|")
        .map((value) => (value === "(none)" ? 0 : Number(value)));
      expect(
        Object.keys(SCRIPT_FLAG_TAGS).map((name) =>
          bits(
            facts.scriptlets.find((scriptlet) => scriptlet.name === name)
              ?.flags ?? [],
            SCRIPT_FLAG_BITS,
          ),
        ),
      ).toEqual(flagValues);
      const render = (prefix: string): string =>
        facts.triggers
          .filter((trigger) => trigger.kind.startsWith(prefix))
          .map(
            (trigger) =>
              `${trigger.kind} scriptlet (using ${trigger.interpreter.join(" ")}) -- ${trigger.conditions.map((condition) => condition.text).join(", ")}\n${trigger.body ?? ""}\n`,
          )
          .join("");
      expect(render("trigger")).toBe(await query(path, "--triggers"));
      expect(render("filetrigger") + render("transfiletrigger")).toBe(
        await query(path, "--filetriggers"),
      );
      for (const [prefix, tag] of [
        ["filetrigger", "FILETRIGGER"],
        ["transfiletrigger", "TRANSFILETRIGGER"],
        ["trigger", "TRIGGER"],
      ] as const) {
        const ours = facts.triggers.filter((trigger) =>
          trigger.kind.startsWith(prefix),
        );
        // rpm prints nothing for an absent flags tag; the facts then carry no flags.
        const flags = (await query(path, "--qf", `[%{${tag}SCRIPTFLAGS} ]`))
          .trim()
          .split(" ")
          .filter(Boolean)
          .map(Number);
        expect(
          ours.map((trigger) => bits(trigger.flags, SCRIPT_FLAG_BITS)),
        ).toEqual(flags.length === 0 ? ours.map(() => 0) : flags);
        if (prefix !== "trigger")
          expect(
            ours.map((trigger) => `${String(trigger.priority)} `).join(""),
          ).toBe(await query(path, "--qf", `[%{${tag}PRIORITIES} ]`));
      }
    });
  },
);

const DIGEST_HEX_LENGTH: Readonly<Record<string, number>> = {
  md5: 32,
  sha1: 40,
  sha256: 64,
  sha384: 96,
  sha512: 128,
  sha224: 56,
};

describe.skipIf(!READY)("files against rpm --dump", () => {
  it.each(PACKAGES)("%s", async (label) => {
    const { path, facts } = await load(label);
    const zeros = "0".repeat(
      DIGEST_HEX_LENGTH[facts.file_digest_algorithm ?? ""] ?? 0,
    );
    const dump = facts.files
      .map(
        (file) =>
          `${file.path} ${String(file.size)} ${String(file.mtime)} ${file.digest ?? zeros} 0${file.mode.toString(8)} ${file.user ?? ""} ${file.group ?? ""} ${file.flags.includes("config") ? 1 : 0} ${file.flags.includes("doc") ? 1 : 0} ${String(file.rdev)} ${file.link_target ?? "X"}\n`,
      )
      .join("");
    expect(dump).toBe(await query(path, "--dump"));
    const columns = await query(
      path,
      "--qf",
      "[%{FILENLINKS}|%{FILEINODES}|%{FILEDEVICES}|%{FILEFLAGS}|%{FILELANGS}\n]",
    );
    expect(
      facts.files
        .map(
          (file) =>
            `${String(file.links)}|${String(file.inode)}|${String(file.device)}|${String(bits(file.flags, FILE_FLAG_BITS))}|${file.lang ?? ""}\n`,
        )
        .join(""),
    ).toBe(columns);
    expect(facts.file_digest_algorithm).toBe("sha256");
  });

  it("names every file flag and the hard-link set of the coverage package", async () => {
    const { facts } = await load("cov-v4");
    const flags = new Map(facts.files.map((file) => [file.path, file.flags]));
    expect(flags.get("/etc/cov.conf")).toEqual([
      "config",
      "noreplace",
      "ghost",
    ]);
    expect(flags.get("/usr/share/cov/LICENSE")).toEqual(["license"]);
    expect(flags.get("/usr/share/cov/README")).toEqual(["readme"]);
    expect(flags.get("/usr/lib/.build-id/art")).toEqual(["artifact"]);
    expect(flags.get("/usr/share/cov/b.txt")).toEqual(["config", "missingok"]);
    expect(
      facts.files.filter((file) => file.links === 3).map((file) => file.path),
    ).toEqual([
      "/usr/share/cov/a-hard.txt",
      "/usr/share/cov/a-hard2.txt",
      "/usr/share/cov/a.txt",
    ]);
  });
});

const payloadBytes = async (
  file: RpmFile,
  bytes: Uint8Array,
  compressor: string | null,
): Promise<Buffer> => {
  const compressed = bytes.subarray(file.payload_offset);
  if (compressor === "zstd") return zstdDecompressSync(compressed);
  if (compressor === "gzip") return gunzipSync(compressed);
  if (compressor === "xz") return pipe(XZ ?? "xz", ["-dc"], {}, compressed);
  throw new Error(`no decompressor for ${String(compressor)}`);
};

const sha = (algorithm: string, bytes: Uint8Array): string =>
  createHash(algorithm).update(bytes).digest("hex");

describe.skipIf(!READY)("payload facts and header digests", () => {
  it.each(PACKAGES)("%s", async (label) => {
    const { path, bytes, read, file, facts } = await load(label);
    const payload = facts.payload;
    expect(
      `${payload.format ?? ""} ${payload.compressor ?? ""} ${payload.flags ?? ""}`,
    ).toBe(
      await query(
        path,
        "--qf",
        "%{PAYLOADFORMAT} %{PAYLOADCOMPRESSOR} %{PAYLOADFLAGS}",
      ),
    );
    const compressed = bytes.subarray(file.payload_offset);
    const decompressed = await payloadBytes(file, bytes, payload.compressor);
    expect(payload.digest_algorithm).toBe("sha256");
    expect(payload.digest).toBe(sha("sha256", compressed));
    expect(payload.digest_alt).toBe(sha("sha256", decompressed));
    if (facts.rpm_format === 6) {
      expect([
        payload.sha512,
        payload.sha512_alt,
        payload.sha3_256,
        payload.sha3_256_alt,
      ]).toEqual([
        sha("sha512", compressed),
        sha("sha512", decompressed),
        sha("sha3-256", compressed),
        sha("sha3-256", decompressed),
      ]);
      expect([payload.size, payload.size_alt]).toEqual([
        compressed.length,
        decompressed.length,
      ]);
    } else {
      expect(facts.signatures.size).toBe(bytes.length - file.header.offset);
      expect(facts.signatures.payload_size).toBe(decompressed.length);
      expect(facts.signatures.md5).toBe(
        createHash("md5")
          .update(bytes.subarray(file.header.offset))
          .digest("hex"),
      );
    }
    const digests = await checkHeaderDigests(file, read);
    expect(digests.map((digest) => digest.algorithm)).toEqual(
      facts.rpm_format === 6 ? ["sha256", "sha3-256"] : ["sha1", "sha256"],
    );
    expect(digests.every((digest) => digest.valid)).toBe(true);
    // One byte of the main header's data store (100 bytes in) changed to 0x41.
    const edited = Buffer.from(bytes);
    const at = file.header.offset + 16 + file.header.index_count * 16 + 100;
    edited[at] = edited[at] === 0x41 ? 0x42 : 0x41;
    const target = join(root, `${label}-edited.rpm`);
    await writeFile(target, edited);
    const broken = await checkHeaderDigests(
      await readRpm(positional(edited), edited.length),
      positional(edited),
    );
    expect(broken.every((digest) => !digest.valid)).toBe(true);
    const verdict = await execute(rpm(), ["-qp", "--qf", "%{NAME}", target]);
    expect(verdict.code).not.toBe(0);
    for (const digest of broken.filter((entry) => entry.algorithm !== "sha1")) {
      const name = digest.algorithm === "sha256" ? "SHA256" : "SHA3-256";
      expect(verdict.stderr).toContain(
        `Header ${name} digest: BAD (Expected ${digest.declared} != ${digest.computed})`,
      );
    }
  });
});

/** Byte offset of the main header index entry for `tag`. */
const entryOffset = (bytes: Uint8Array, file: RpmFile, tag: number): number => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < file.header.index_count; index += 1) {
    const at = file.header.offset + 16 + index * 16;
    if (view.getUint32(at) === tag) return at;
  }
  throw new Error(`no index entry for tag ${String(tag)}`);
};

/** Write an edited copy, confirm rpm refuses it, and read it back. */
const edited = async (
  label: string,
  bytes: Uint8Array,
  edit: (copy: Buffer) => void,
) => {
  const copy = Buffer.from(bytes);
  edit(copy);
  const target = join(root, `${label}.rpm`);
  await writeFile(target, copy);
  const verdict = await execute(rpm(), ["-qp", "--qf", "%{NAME}", target]);
  expect(verdict.code, `rpm accepted ${label}`).not.toBe(0);
  return { copy, read: positional(copy), verdict };
};

const formatError = async (bytes: Uint8Array): Promise<RpmFormatError> => {
  const error = await readRpm(positional(bytes), bytes.length).then(
    () => null,
    (caught: unknown) => caught,
  );
  if (!(error instanceof RpmFormatError))
    throw new Error(`expected an RpmFormatError, got ${String(error)}`);
  return error;
};

describe.skipIf(!READY)("malformed RPMs from real package bytes", () => {
  it("throws at the offset where the structure stops being readable", async () => {
    const { bytes, file } = await load("oops-v6-zstd");
    // Lead magic byte 0 set to NUL.
    const badLead = (
      await edited("bad-lead", bytes, (copy) => void (copy[0] = 0))
    ).copy;
    expect((await formatError(badLead)).offset).toBe(0);
    // Main header index count rewritten to 0xff00: index and data run past the file.
    const indexPast = await edited("index-past-end", bytes, (copy) =>
      copy.writeUInt32BE(0xff00, file.header.offset + 8),
    );
    expect((await formatError(indexPast.copy)).offset).toBe(
      file.header.offset + 8,
    );
    // Signature header index count rewritten to 33, above rpm's 32-entry signature limit.
    const signatureTags = await edited("signature-tags", bytes, (copy) =>
      copy.writeUInt32BE(33, 96 + 8),
    );
    expect((await formatError(signatureTags.copy)).offset).toBe(96 + 8);
    // The file cut in the middle of the main header.
    expect(
      (await formatError(bytes.subarray(0, file.header.offset + 100))).offset,
    ).toBe(file.header.offset + 8);
  });

  it("keeps the other entries when one entry is unreadable, as a named problem", async () => {
    const { bytes, file } = await load("oops-v6-zstd");
    const dataStart = file.header.offset + 16 + file.header.index_count * 16;
    const name = entryOffset(bytes, file, 1000);
    const cases: [
      string,
      (copy: Buffer) => void,
      RegExp,
      keyof RpmPackageFacts,
    ][] = [
      // NAME's data offset moved 100 bytes past the data store.
      [
        "offset-past-store",
        (copy) => copy.writeUInt32BE(file.header.data_size + 100, name + 8),
        /data offset \d+ is past the \d+-byte data store/u,
        "name",
      ],
      // NAME's data offset moved to the last byte of the store (the region trailer's count byte, 0x10).
      [
        "string-without-nul",
        (copy) => copy.writeUInt32BE(file.header.data_size - 1, name + 8),
        /has no NUL terminator inside the data store/u,
        "name",
      ],
      // NAME's type rewritten to 12, which rpm does not define.
      [
        "unknown-type",
        (copy) => copy.writeUInt32BE(12, name + 4),
        /unknown data type 12/u,
        "name",
      ],
      // VERSION's tag rewritten to 1000, repeating NAME.
      [
        "repeated-tag",
        (copy) => copy.writeUInt32BE(1000, entryOffset(bytes, file, 1001)),
        /tag repeated in the index/u,
        "version",
      ],
      // SUMMARY's first byte set to 0xff, which is not UTF-8.
      [
        "invalid-utf8",
        (copy) =>
          void (copy[
            dataStart +
              new DataView(bytes.buffer, bytes.byteOffset).getUint32(
                entryOffset(bytes, file, 1004) + 8,
              )
          ] = 0xff),
        /not valid UTF-8/u,
        "summary",
      ],
    ];
    for (const [label, edit, problem, fact] of cases) {
      const { copy, read } = await edited(label, bytes, edit);
      const parsed = await readRpm(read, copy.length);
      expect(
        parsed.header.problems.some((entry) => problem.test(entry)),
        `${label}: ${parsed.header.problems.join("; ")}`,
      ).toBe(true);
      const facts = rpmFacts(parsed);
      expect(facts[fact], label).toBeNull();
      expect(facts.release, label).toBe("1");
      expect(facts.files.length, label).toBe(rpmFacts(file).files.length);
    }
    const { copy } = await edited(
      "summary-bytes",
      bytes,
      (target) =>
        void (target[
          dataStart +
            new DataView(bytes.buffer, bytes.byteOffset).getUint32(
              entryOffset(bytes, file, 1004) + 8,
            )
        ] = 0xff),
    );
    expect(
      (await readRpm(positional(copy), copy.length)).header.undecodable.get(
        1004,
      )?.[0]?.[0],
    ).toBe(0xff);
    // The region trailer's tag rewritten to 62: rpm says "region trailer: BAD".
    const trailer = await edited("region-trailer", bytes, (target) =>
      target.writeUInt32BE(62, dataStart + file.header.data_size - 16),
    );
    expect(trailer.verdict.stderr).toContain("region trailer: BAD");
    expect(
      (await readRpm(trailer.read, trailer.copy.length)).header.problems,
    ).toEqual([
      "main header region headerimmutable: trailer does not repeat the region tag.",
    ]);
  });
});

describe.skipIf(!READY || GPG === null)(
  "packages signed with a throwaway key",
  () => {
    it.each(["signed-cov-v4", "signed-oops-v6"] as const)(
      "%s",
      async (label) => {
        await expectTagsMatchRpm(label);
        const { path, read, file, facts } = await load(label);
        expect(
          (await checkHeaderDigests(file, read)).every(
            (digest) => digest.valid,
          ),
        ).toBe(true);
        // rpm lists every OpenPGP signature packet as base64 under OPENPGP, a v4 RSA header signature included.
        const packets = (await query(path, "--qf", "[%{OPENPGP}\n]"))
          .trim()
          .split("\n")
          .map((text) => Buffer.from(text, "base64").length);
        const ours = [
          ...(facts.signatures.rsa === null ? [] : [facts.signatures.rsa]),
          ...facts.signatures.openpgp,
        ];
        expect(ours).toEqual(packets);
        expect(ours.length).toBeGreaterThan(0);
        expect(await query(path, "--info")).toMatch(
          /^Signature    :\n {15}RSA\/SHA256, .*, Key ID [0-9a-f]{16}$/mu,
        );
      },
    );
  },
);
