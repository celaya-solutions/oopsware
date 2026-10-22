import { createHash } from "node:crypto";

import type { Element } from "@xmldom/xmldom";

import { ok, type Result } from "../../domain/result.js";
import {
  type AppxXmlProblem,
  attribute,
  elements,
  parseAppxXml,
  unsigned,
} from "./xml.js";

export const APPX_BLOCK_MAP_NAMESPACE =
  "http://schemas.microsoft.com/appx/2010/blockmap";

/** Every file is hashed in 64 KiB blocks of its uncompressed bytes. */
export const APPX_BLOCK_BYTES = 64 * 1024;

/**
 * About 17 GiB of package content at 64 KiB per block; a larger map is
 * refused as too_large rather than built into a DOM.
 */
export const MAX_APPX_BLOCK_MAP_BYTES = 16 * 1024 ** 2;
const MAX_BLOCK_MAP_MARKUP = 600_000;

const HASH_METHODS: Readonly<
  Record<string, { readonly hash: AppxHashName; readonly bytes: number }>
> = {
  "http://www.w3.org/2001/04/xmlenc#sha256": { hash: "sha256", bytes: 32 },
  "http://www.w3.org/2001/04/xmldsig-more#sha384": {
    hash: "sha384",
    bytes: 48,
  },
  "http://www.w3.org/2001/04/xmlenc#sha512": { hash: "sha512", bytes: 64 },
};

/** Parts a block map never lists: itself, the signature and the content types (OPC names ignore ASCII case). */
const UNLISTED_PARTS = new Set([
  "appxblockmap.xml",
  "appxsignature.p7x",
  "[content_types].xml",
]);

export type AppxHashName = "sha256" | "sha384" | "sha512";

export interface AppxBlockMapBlock {
  /** Base64 digest as written. */
  readonly hash: string;
  /** Compressed size of the block in the ZIP, present only for compressed members. */
  readonly size: number | null;
}

export interface AppxBlockMapFile {
  /** Name as written, with backslash separators. */
  readonly name: string;
  /** The same name with forward slashes, as ZIP paths use. */
  readonly path: string;
  readonly size: number | null;
  /** Size of the member's ZIP local file header. */
  readonly lfh_size: number | null;
  readonly blocks: readonly AppxBlockMapBlock[];
}

export interface AppxBlockMap {
  readonly hash_method: string | null;
  readonly hash: AppxHashName | null;
  readonly files: readonly AppxBlockMapFile[];
  readonly problems: readonly string[];
}

const readFile = (
  node: Element,
  digestBytes: number | null,
  problems: string[],
): AppxBlockMapFile => {
  const name = attribute(node, "Name") ?? "";
  const what = `File "${name}"`;
  if (name === "") problems.push("A File element has no Name.");
  const size = unsigned(attribute(node, "Size"), `${what} Size`, problems);
  const blocks = elements(node, "Block").map((block, index) => {
    const hash = attribute(block, "Hash") ?? "";
    const decoded = Buffer.from(hash, "base64");
    if (
      digestBytes !== null &&
      (decoded.length !== digestBytes || decoded.toString("base64") !== hash)
    )
      problems.push(
        `${what} block ${String(index)} hash is not a base64 ${String(digestBytes)}-byte digest.`,
      );
    return {
      hash,
      size: unsigned(
        attribute(block, "Size"),
        `${what} block ${String(index)} Size`,
        problems,
      ),
    };
  });
  if (size !== null && blocks.length !== Math.ceil(size / APPX_BLOCK_BYTES))
    problems.push(
      `${what} is ${String(size)} bytes but lists ${String(blocks.length)} blocks; ${String(Math.ceil(size / APPX_BLOCK_BYTES))} are needed.`,
    );
  return {
    name,
    path: name.replaceAll("\\", "/"),
    size,
    lfh_size: unsigned(attribute(node, "LfhSize"), `${what} LfhSize`, problems),
    blocks,
  };
};

/** Read AppxBlockMap.xml: the hash method and every File with its blocks. */
export const parseAppxBlockMap = (
  bytes: Uint8Array,
): Result<AppxBlockMap, AppxXmlProblem> => {
  const parsed = parseAppxXml(
    bytes,
    "AppxBlockMap.xml",
    { max_bytes: MAX_APPX_BLOCK_MAP_BYTES, max_markup: MAX_BLOCK_MAP_MARKUP },
    [{ namespace: APPX_BLOCK_MAP_NAMESPACE, name: "BlockMap" }],
  );
  if (!parsed.ok) return parsed;
  const { root, warnings } = parsed.value;
  const problems = [...warnings];
  const hash_method = attribute(root, "HashMethod");
  const method = hash_method === null ? undefined : HASH_METHODS[hash_method];
  if (method === undefined)
    problems.push(
      `HashMethod "${hash_method ?? ""}" is not SHA-256, SHA-384 or SHA-512; blocks cannot be checked.`,
    );
  const files = elements(root, "File").map((node) =>
    readFile(node, method?.bytes ?? null, problems),
  );
  const seen = new Set<string>();
  for (const file of files) {
    const key = file.path.toLowerCase();
    if (seen.has(key)) problems.push(`File "${file.name}" is listed twice.`);
    seen.add(key);
  }
  return ok({ hash_method, hash: method?.hash ?? null, files, problems });
};

/** A member's uncompressed bytes, whole or streamed. */
export type BlockMapMember = Uint8Array | AsyncIterable<Uint8Array>;

export interface BlockMapFileCheck {
  readonly name: string;
  readonly path: string;
  readonly missing: boolean;
  readonly size: {
    readonly declared: number | null;
    readonly actual: number | null;
  };
  readonly block_count: {
    readonly declared: number;
    readonly expected: number | null;
  };
  /** Indexes of listed blocks whose digest differs from the member's bytes. */
  readonly mismatched_blocks: readonly number[];
  /** Present, sizes and block count agree, and every digest matches. */
  readonly verified: boolean;
}

export interface BlockMapVerification {
  readonly hash: AppxHashName | null;
  readonly files: readonly BlockMapFileCheck[];
  /** Members not in the map, other than the three parts it never lists. */
  readonly unlisted: readonly string[];
  readonly verified: boolean;
}

async function* chunks(member: BlockMapMember): AsyncGenerator<Uint8Array> {
  if (member instanceof Uint8Array) yield member;
  else yield* member;
}

/** Base64 digests of each 64 KiB block of the member, and its length. */
const blockDigests = async (
  member: BlockMapMember,
  hash: AppxHashName,
  signal: AbortSignal | undefined,
): Promise<{ digests: string[]; size: number }> => {
  const digests: string[] = [];
  let size = 0;
  let current = createHash(hash);
  let filled = 0;
  for await (const chunk of chunks(member)) {
    signal?.throwIfAborted();
    for (let at = 0; at < chunk.length;) {
      const take = Math.min(APPX_BLOCK_BYTES - filled, chunk.length - at);
      current.update(chunk.subarray(at, at + take));
      at += take;
      filled += take;
      size += take;
      if (filled === APPX_BLOCK_BYTES) {
        digests.push(current.digest("base64"));
        current = createHash(hash);
        filled = 0;
      }
    }
  }
  if (filled > 0) digests.push(current.digest("base64"));
  return { digests, size };
};

/** A ZIP item name (OPC part name) with %XX escapes decoded; kept as written when they are invalid. */
const partPath = (name: string): string => {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
};

const checkFile = async (
  file: AppxBlockMapFile,
  member: BlockMapMember | null,
  hash: AppxHashName | null,
  signal: AbortSignal | undefined,
): Promise<BlockMapFileCheck> => {
  const base = { name: file.name, path: file.path };
  const declared = file.blocks.length;
  if (member === null)
    return {
      ...base,
      missing: true,
      size: { declared: file.size, actual: null },
      block_count: { declared, expected: null },
      mismatched_blocks: [],
      verified: false,
    };
  const computed =
    hash === null ? null : await blockDigests(member, hash, signal);
  const actual = computed?.size ?? null;
  const expected =
    actual === null ? null : Math.ceil(actual / APPX_BLOCK_BYTES);
  const mismatched_blocks = file.blocks.flatMap((block, index) => {
    const digest = computed?.digests[index];
    return digest === undefined || digest === block.hash ? [] : [index];
  });
  return {
    ...base,
    missing: false,
    size: { declared: file.size, actual },
    block_count: { declared, expected },
    mismatched_blocks,
    verified:
      computed !== null &&
      file.size === actual &&
      declared === expected &&
      mismatched_blocks.length === 0,
  };
};

/**
 * Recompute every listed file's 64 KiB block digests over its uncompressed
 * bytes. `members` is asked for each File by its forward-slash path and
 * returns null when the package has no such member; `names` (ZIP item
 * names, %-escapes allowed) finds members the map does not list. Block
 * Size attributes and LfhSize are recorded by the parser, not checked here.
 */
export const verifyBlockMap = async (
  blockMap: AppxBlockMap,
  members: (
    path: string,
  ) => BlockMapMember | null | Promise<BlockMapMember | null>,
  options: {
    readonly names?: readonly string[];
    readonly signal?: AbortSignal;
  } = {},
): Promise<BlockMapVerification> => {
  const files: BlockMapFileCheck[] = [];
  for (const file of blockMap.files) {
    options.signal?.throwIfAborted();
    files.push(
      await checkFile(
        file,
        await members(file.path),
        blockMap.hash,
        options.signal,
      ),
    );
  }
  const listed = new Set(blockMap.files.map((file) => file.path.toLowerCase()));
  const unlisted = (options.names ?? []).filter((name) => {
    const path = partPath(name).toLowerCase();
    return (
      !name.endsWith("/") && !UNLISTED_PARTS.has(path) && !listed.has(path)
    );
  });
  return {
    hash: blockMap.hash,
    files,
    unlisted,
    verified:
      blockMap.hash !== null &&
      unlisted.length === 0 &&
      files.every((file) => file.verified),
  };
};
