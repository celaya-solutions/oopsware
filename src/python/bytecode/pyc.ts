import {
  MarshalError,
  MarshalReader,
  type CodeObject,
  type PyValue,
} from "./marshal.js";
import {
  admittedProfile,
  releaseForMagic,
  type BytecodeProfile,
} from "./profiles.js";

/**
 * The .pyc header (PEP 552 layout from 3.7) and its top-level code object.
 * Only the magic number decides the release; a profile decodes the code
 * object only when that exact magic number was admitted.
 */

export type PycInvalidation =
  | {
      readonly kind: "timestamp";
      readonly sourceMtime: number;
      readonly sourceSize: number;
    }
  | {
      readonly kind: "checked-hash" | "unchecked-hash";
      readonly sourceHash: string;
    };

export interface PycHeader {
  readonly magic: number;
  /** The release a known final-release magic number belongs to. */
  readonly release: string | null;
  readonly admitted: boolean;
  /** Raw flags word (3.7+); null for older 12-byte headers. */
  readonly flags: number | null;
  readonly invalidation: PycInvalidation | null;
  readonly headerBytes: number;
  readonly problem: string | null;
}

export const looksLikePyc = (bytes: Uint8Array): boolean =>
  bytes.length >= 4 && bytes[2] === 0x0d && bytes[3] === 0x0a;

const u32 = (bytes: Uint8Array, at: number): number =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    at,
    true,
  );

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** Read the header; null when the bytes do not end the magic with \r\n. */
export const readPycHeader = (bytes: Uint8Array): PycHeader | null => {
  if (!looksLikePyc(bytes)) return null;
  const magic = (bytes[0] ?? 0) | ((bytes[1] ?? 0) << 8);
  const release = releaseForMagic(magic);
  const admitted = admittedProfile(magic) !== null;
  const minor = release === null ? null : Number(release.split(".")[1]);
  const major = release === null ? null : Number(release.split(".")[0]);
  // PEP 552 (3.7+) headers are 16 bytes; 3.3-3.6 are 12; 2.7 is 8. Unknown magic numbers are assumed PEP 552.
  const pep552 = major === null || (major === 3 && (minor ?? 0) >= 7);
  if (!pep552) {
    const headerBytes = major === 2 ? 8 : 12;
    return {
      magic,
      release,
      admitted,
      flags: null,
      invalidation:
        bytes.length >= headerBytes
          ? {
              kind: "timestamp",
              sourceMtime: u32(bytes, 4),
              sourceSize: major === 2 ? 0 : u32(bytes, 8),
            }
          : null,
      headerBytes,
      problem: bytes.length < headerBytes ? "The header is truncated." : null,
    };
  }
  if (bytes.length < 16)
    return {
      magic,
      release,
      admitted,
      flags: null,
      invalidation: null,
      headerBytes: 16,
      problem: "The header is truncated.",
    };
  const flags = u32(bytes, 4);
  const problem =
    (flags & ~0b11) !== 0
      ? `Flags 0x${flags.toString(16)} set bits importlib rejects.`
      : (flags & 1) === 0 && (flags & 2) !== 0
        ? "check_source is set without hash-based invalidation; importlib rejects this header."
        : null;
  return {
    magic,
    release,
    admitted,
    flags,
    invalidation:
      (flags & 1) === 0
        ? {
            kind: "timestamp",
            sourceMtime: u32(bytes, 8),
            sourceSize: u32(bytes, 12),
          }
        : {
            kind: (flags & 2) !== 0 ? "checked-hash" : "unchecked-hash",
            sourceHash: hex(bytes.subarray(8, 16)),
          },
    headerBytes: 16,
    problem,
  };
};

/** One code object in pre-order, with the path that reaches it. */
export interface CodeEntry {
  /** Pre-order index; 0 is the module. */
  readonly index: number;
  readonly parent: number | null;
  readonly depth: number;
  /** co_qualname from 3.11; an assembled dotted path before that. */
  readonly qualname: string;
  readonly code: CodeObject;
}

const nested = (value: PyValue, into: CodeObject[]): void => {
  switch (value.t) {
    case "code":
      into.push(value.code);
      return;
    case "tuple":
    case "list":
    case "set":
    case "frozenset":
      for (const item of value.items) nested(item, into);
      return;
    case "dict":
    case "frozendict":
      for (const [key, item] of value.entries) {
        nested(key, into);
        nested(item, into);
      }
      return;
    default:
      return;
  }
};

/** Every code object reachable from the module, in pre-order; a shared object is listed once per place. */
export const codeEntries = (module: CodeObject, limit: number): CodeEntry[] => {
  const entries: CodeEntry[] = [];
  const visit = (code: CodeObject, parent: CodeEntry | null) => {
    if (entries.length >= limit) return;
    // Before 3.11 there is no co_qualname: join the names below the module.
    const qualname =
      code.qualname ??
      (parent === null
        ? code.name
        : parent.parent === null
          ? code.name
          : `${parent.qualname}.${code.name}`);
    const entry: CodeEntry = {
      index: entries.length,
      parent: parent?.index ?? null,
      depth: parent === null ? 0 : parent.depth + 1,
      qualname,
      code,
    };
    entries.push(entry);
    const children: CodeObject[] = [];
    for (const value of code.consts) nested(value, children);
    for (const child of children) visit(child, entry);
  };
  visit(module, null);
  return entries;
};

export type LoadedPyc =
  | {
      readonly kind: "decoded";
      readonly profile: BytecodeProfile;
      readonly module: CodeObject;
      readonly trailing: number;
    }
  | { readonly kind: "not-admitted" }
  | {
      readonly kind: "failed";
      readonly profile: BytecodeProfile;
      readonly problem: string;
      readonly offset: number;
    };

/** Decode the code object after the header with the admitted profile. */
export const loadPyc = (
  bytes: Uint8Array,
  header: PycHeader,
  maxObjects: number,
): LoadedPyc => {
  const profile = admittedProfile(header.magic);
  if (profile === null) return { kind: "not-admitted" };
  try {
    const reader = new MarshalReader(bytes, header.headerBytes, profile, {
      maxObjects,
    });
    const value = reader.read();
    if (value.t !== "code")
      return {
        kind: "failed",
        profile,
        problem: `The marshalled object is a ${value.t}, not a code object.`,
        offset: header.headerBytes,
      };
    return {
      kind: "decoded",
      profile,
      module: value.code,
      trailing: bytes.length - reader.offset,
    };
  } catch (cause) {
    if (!(cause instanceof MarshalError)) throw cause;
    return {
      kind: "failed",
      profile,
      problem: cause.message,
      offset: cause.offset,
    };
  }
};
