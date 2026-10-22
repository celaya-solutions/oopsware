import { ZipView } from "../artifacts/zipMemberView.js";
import type { PythonContainerKind } from "../domain/python/python.js";
import { looksLikePyc } from "./bytecode/pyc.js";
import { releaseForMagic } from "./bytecode/profiles.js";

/**
 * What a caller-selected file is, decided from its bytes first: a .pyc
 * header, a ZIP (optionally after a `#!` line, as zipapp writes it) or text.
 * A ZIP is a wheel when it has a `.dist-info/WHEEL` member and a zip
 * application when it has a root `__main__.py`.
 */

export type PythonSource =
  | {
      readonly kind: "source" | "bytecode";
      readonly basis: "magic" | "text" | "name-hint";
      readonly nameConflict: string | null;
      readonly bytes: Uint8Array;
    }
  | {
      readonly kind: "wheel" | "zipapp" | "zip";
      readonly basis: "layout" | "name-hint";
      readonly nameConflict: string | null;
      readonly zip: ZipView;
      /** Bytes before the ZIP data, e.g. a shebang line. */
      readonly prefix: Uint8Array;
      readonly distInfo: string | null;
    };

const suffixKind = (path: string): PythonContainerKind | null => {
  const lower = path.toLowerCase();
  if (lower.endsWith(".py") || lower.endsWith(".pyw")) return "source";
  if (lower.endsWith(".pyc")) return "bytecode";
  if (lower.endsWith(".whl")) return "wheel";
  if (lower.endsWith(".pyz") || lower.endsWith(".pyzw")) return "zipapp";
  return null;
};

const conflict = (path: string, kind: PythonContainerKind): string | null => {
  const hinted = suffixKind(path);
  return hinted === null || hinted === kind
    ? null
    : `The name suggests ${hinted}, but the bytes are ${kind === "zip" ? "a plain ZIP" : kind}.`;
};

const isZipAt = (bytes: Uint8Array, at: number): boolean =>
  bytes[at] === 0x50 &&
  bytes[at + 1] === 0x4b &&
  ((bytes[at + 2] === 0x03 && bytes[at + 3] === 0x04) ||
    (bytes[at + 2] === 0x05 && bytes[at + 3] === 0x06));

/** Length of a leading `#!` line when ZIP data follows it, else 0 for a plain ZIP, else null. */
export const zipPrefix = (bytes: Uint8Array): number | null => {
  if (isZipAt(bytes, 0)) return 0;
  if (bytes[0] !== 0x23 || bytes[1] !== 0x21) return null;
  const newline = bytes.indexOf(0x0a);
  if (newline < 0 || newline > 4096) return null;
  return isZipAt(bytes, newline + 1) ? newline + 1 : null;
};

/** A .pyc is recognised by its magic number; an unknown one only with a .pyc name. */
export const isBytecode = (bytes: Uint8Array, path: string): boolean => {
  if (!looksLikePyc(bytes) || bytes.length < 8) return false;
  const magic = (bytes[0] ?? 0) | ((bytes[1] ?? 0) << 8);
  return releaseForMagic(magic) !== null || suffixKind(path) === "bytecode";
};

const DIST_INFO = /^([^/]+\.dist-info)\/WHEEL$/u;

const textLike = (bytes: Uint8Array): boolean => {
  const sample = bytes.subarray(0, 8192);
  return !sample.includes(0);
};

/** Open bytes as Python input; null when they are none of the supported kinds. */
export const openPythonSource = async (
  bytes: Uint8Array,
  path: string,
): Promise<PythonSource | null> => {
  if (isBytecode(bytes, path))
    return {
      kind: "bytecode",
      basis: "magic",
      nameConflict: conflict(path, "bytecode"),
      bytes,
    };
  const prefix = zipPrefix(bytes);
  if (prefix !== null) {
    const zip = await ZipView.open(bytes);
    const distInfo =
      zip.members
        .map((member) => DIST_INFO.exec(member.path)?.[1])
        .find((match): match is string => match !== undefined) ?? null;
    let kind: "wheel" | "zipapp" | "zip";
    let basis: "layout" | "name-hint" = "layout";
    if (distInfo !== null) kind = "wheel";
    else if (zip.has("__main__.py") || zip.has("__main__.pyc")) kind = "zipapp";
    else {
      const hinted = suffixKind(path);
      if (hinted === "wheel" || hinted === "zipapp") {
        kind = hinted;
        basis = "name-hint";
      } else kind = "zip";
    }
    return {
      kind,
      basis,
      nameConflict: basis === "name-hint" ? null : conflict(path, kind),
      zip,
      prefix: bytes.subarray(0, prefix),
      distInfo,
    };
  }
  if (suffixKind(path) === "source" && textLike(bytes))
    return { kind: "source", basis: "text", nameConflict: null, bytes };
  return null;
};

export const closePythonSource = async (
  source: PythonSource | null,
): Promise<void> => {
  if (source === null || !("zip" in source)) return;
  await source.zip.close().catch(() => undefined);
};

/** Members that hold Python modules. */
export const moduleKind = (path: string): "source" | "bytecode" | null => {
  const lower = path.toLowerCase();
  if (lower.endsWith(".py") || lower.endsWith(".pyw")) return "source";
  if (lower.endsWith(".pyc")) return "bytecode";
  return null;
};

const IDENTIFIER = /^[\p{L}\p{Nl}_][\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}_]*$/u;

/**
 * The dotted module name an import system would use for a member path:
 * wheel `.data/purelib|platlib/` prefixes are dropped, `__pycache__/x.tag.pyc`
 * becomes `x`, and a path with a non-identifier part has no name.
 */
export const moduleName = (
  path: string,
  distInfo: string | null,
): string | null => {
  let rest = path;
  if (distInfo !== null) {
    const data = `${distInfo.slice(0, -".dist-info".length)}.data/`;
    if (rest.startsWith(data)) {
      const scheme = /^(purelib|platlib)\//u.exec(rest.slice(data.length));
      if (scheme === null) return null;
      rest = rest.slice(data.length + (scheme[0]?.length ?? 0));
    }
    if (rest.startsWith(`${distInfo}/`)) return null;
  }
  const parts = rest.split("/");
  const file = parts.pop() ?? "";
  if (parts.at(-1) === "__pycache__") {
    parts.pop();
    const match = /^([^.]+)\.[^.]+(?:\.opt-\d+)?\.pyc$/u.exec(file);
    if (match === null) return null;
    parts.push(match[1] ?? "");
  } else parts.push(file.replace(/\.(?:pyw?|pyc)$/iu, ""));
  if (parts.at(-1) === "__init__") parts.pop();
  if (parts.length === 0 || !parts.every((part) => IDENTIFIER.test(part)))
    return null;
  return parts.join(".");
};
