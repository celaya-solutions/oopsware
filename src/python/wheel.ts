import { createHash } from "node:crypto";

import { parse } from "csv-parse/sync";

/**
 * Wheel (PEP 427 / binary distribution format) metadata read as text. The
 * wheel is never installed: METADATA and WHEEL are RFC 822-style headers,
 * entry_points.txt is INI-style, and RECORD is CSV whose digests are checked
 * against the member bytes with the algorithm each row names.
 */

const utf8 = new TextDecoder("utf-8", { fatal: false });

export interface HeaderFields {
  readonly fields: ReadonlyMap<string, readonly string[]>;
  readonly body: string;
}

/** Core-metadata headers: case-insensitive names, folded continuation lines, a body after the first blank line. */
export const parseHeaders = (bytes: Uint8Array): HeaderFields => {
  const text = utf8.decode(bytes).replace(/\r\n?/gu, "\n");
  const fields = new Map<string, string[]>();
  const lines = text.split("\n");
  let index = 0;
  let last: { key: string; position: number } | null = null;
  for (; index < lines.length; index += 1) {
    const current = lines[index] ?? "";
    if (current === "") {
      index += 1;
      break;
    }
    if (/^[ \t]/u.test(current) && last !== null) {
      const values = fields.get(last.key) ?? [];
      values[last.position] =
        `${values[last.position] ?? ""}\n${current.trim()}`;
      continue;
    }
    const colon = current.indexOf(":");
    if (colon <= 0) continue;
    const key = current.slice(0, colon).trim().toLowerCase();
    const values = fields.get(key) ?? [];
    values.push(current.slice(colon + 1).trim());
    fields.set(key, values);
    last = { key, position: values.length - 1 };
  }
  return { fields, body: lines.slice(index).join("\n") };
};

const first = (headers: HeaderFields, key: string): string | null =>
  headers.fields.get(key)?.[0] ?? null;
const all = (headers: HeaderFields, key: string): string[] => [
  ...(headers.fields.get(key) ?? []),
];

export const metadataOf = (bytes: Uint8Array) => {
  const headers = parseHeaders(bytes);
  return {
    metadata_version: first(headers, "metadata-version"),
    name: first(headers, "name"),
    version: first(headers, "version"),
    summary: first(headers, "summary"),
    requires_python: first(headers, "requires-python"),
    requires_dist: all(headers, "requires-dist"),
    provides_extra: all(headers, "provides-extra"),
    license: first(headers, "license"),
    license_expression: first(headers, "license-expression"),
    license_files: all(headers, "license-file"),
    classifiers: all(headers, "classifier"),
    project_urls: all(headers, "project-url"),
    author: first(headers, "author"),
    author_email: first(headers, "author-email"),
    has_description:
      headers.body.trim() !== "" || first(headers, "description") !== null,
  };
};

export const wheelFileOf = (bytes: Uint8Array) => {
  const headers = parseHeaders(bytes);
  const purelib = first(headers, "root-is-purelib")?.toLowerCase();
  return {
    wheel_version: first(headers, "wheel-version"),
    generator: first(headers, "generator"),
    root_is_purelib:
      purelib === "true" ? true : purelib === "false" ? false : null,
    tags: all(headers, "tag"),
    build: first(headers, "build"),
  };
};

/** entry_points.txt: `[group]` sections of `name = object.reference` lines. */
export const entryPointsOf = (
  bytes: Uint8Array,
): { group: string; name: string; value: string }[] => {
  const result: { group: string; name: string; value: string }[] = [];
  let group: string | null = null;
  for (const raw of utf8.decode(bytes).split(/\r\n?|\n/u)) {
    const current = raw.trim();
    if (current === "" || current.startsWith("#") || current.startsWith(";"))
      continue;
    const section = /^\[(.+)\]$/u.exec(current);
    if (section !== null) {
      group = (section[1] ?? "").trim();
      continue;
    }
    const equals = current.indexOf("=");
    if (group === null || equals <= 0) continue;
    result.push({
      group,
      name: current.slice(0, equals).trim(),
      value: current.slice(equals + 1).trim(),
    });
  }
  return result;
};

/** PEP 427 `{distribution}-{version}(-{build})?-{python}-{abi}-{platform}.whl`. */
export const wheelFilename = (path: string) => {
  const base = path.split("/").pop() ?? path;
  if (!base.toLowerCase().endsWith(".whl")) return null;
  const parts = base.slice(0, -4).split("-");
  if (parts.length !== 5 && parts.length !== 6) return null;
  const [distribution, version] = parts;
  const build = parts.length === 6 ? (parts[2] ?? null) : null;
  const [python, abi, platform] = parts.slice(-3);
  if (
    distribution === undefined ||
    version === undefined ||
    python === undefined ||
    abi === undefined ||
    platform === undefined
  )
    return null;
  return {
    distribution,
    version,
    build,
    python_tags: python.split("."),
    abi_tags: abi.split("."),
    platform_tags: platform.split("."),
  };
};

export interface RecordRow {
  readonly path: string;
  readonly algorithm: string | null;
  readonly digest: string | null;
  readonly size: number | null;
}

export const parseRecord = (
  bytes: Uint8Array,
): { rows: RecordRow[]; problem: string | null } => {
  let records: string[][];
  try {
    records = parse(utf8.decode(bytes), {
      relax_column_count: true,
      skip_empty_lines: true,
    }) as string[][];
  } catch (cause) {
    return {
      rows: [],
      problem: `RECORD is not readable CSV: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
  const rows: RecordRow[] = [];
  const problems: string[] = [];
  for (const [index, record] of records.entries()) {
    const [path = "", hash = "", size = ""] = record;
    if (record.length !== 3)
      problems.push(
        `Row ${String(index + 1)} has ${String(record.length)} fields, not 3.`,
      );
    const equals = hash.indexOf("=");
    const digestSize = size === "" ? null : Number(size);
    rows.push({
      path,
      algorithm: equals > 0 ? hash.slice(0, equals) : null,
      digest: equals > 0 ? hash.slice(equals + 1) : null,
      size:
        digestSize !== null &&
        Number.isSafeInteger(digestSize) &&
        digestSize >= 0
          ? digestSize
          : null,
    });
  }
  return { rows, problem: problems.length === 0 ? null : problems.join(" ") };
};

/** Algorithms PEP 376/427 tools accept; md5 and sha1 are refused by installers. */
const ACCEPTED = new Set([
  "sha256",
  "sha384",
  "sha512",
  "sha3_256",
  "sha3_384",
  "sha3_512",
  "blake2b",
  "blake2s",
]);
const NODE_NAME: Readonly<Record<string, string>> = {
  sha3_256: "sha3-256",
  sha3_384: "sha3-384",
  sha3_512: "sha3-512",
  blake2b: "blake2b512",
  blake2s: "blake2s256",
};

export const recordAlgorithmAccepted = (algorithm: string): boolean =>
  ACCEPTED.has(algorithm);

/** urlsafe base64 without padding, as RECORD writes it. */
export const recordDigest = (algorithm: string, bytes: Uint8Array): string =>
  createHash(NODE_NAME[algorithm] ?? algorithm)
    .update(bytes)
    .digest("base64url");

const NATIVE = /\.(?:so|pyd|dylib|dll)$/iu;

export const isNativeMember = (path: string): boolean =>
  NATIVE.test(path) || /\.so\.\d[\d.]*$/u.test(path);

/** `mod.cpython-312-darwin.so` -> cpython-312-darwin; `mod.abi3.so` -> abi3; `mod.cp312-win_amd64.pyd` -> cp312-win_amd64. */
export const extensionTag = (path: string): string | null => {
  const base = path.split("/").pop() ?? path;
  const match = /^[^.]+\.([^.]+)\.(?:so|pyd)$/iu.exec(base);
  return match?.[1] ?? null;
};

export const binaryKind = (
  bytes: Uint8Array,
): "elf" | "mach-o" | "pe" | "unknown" => {
  const word =
    (bytes[0] ?? 0) * 2 ** 24 +
    (bytes[1] ?? 0) * 2 ** 16 +
    (bytes[2] ?? 0) * 256 +
    (bytes[3] ?? 0);
  if (word === 0x7f454c46) return "elf";
  if (
    [
      0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca,
    ].includes(word)
  )
    return "mach-o";
  if (bytes[0] === 0x4d && bytes[1] === 0x5a) return "pe";
  return "unknown";
};

const LICENSE_NAME = /^(?:licen[cs]e|copying|notice|authors)(?:[._-].*)?$/iu;

/** License files: PEP 639 `.dist-info/licenses/`, or legacy LICENSE-like files directly in .dist-info. */
export const isLicenseMember = (
  path: string,
  distInfo: string | null,
): boolean => {
  if (distInfo === null || !path.startsWith(`${distInfo}/`)) return false;
  const rest = path.slice(distInfo.length + 1);
  if (rest.startsWith("licenses/")) return !rest.endsWith("/");
  return !rest.includes("/") && LICENSE_NAME.test(rest);
};
