import { Il2cppBinaryFormatFailure } from "./Il2cppBinaryFormat.js";
import {
  isMapped,
  hasPointerArrayCoverage,
  readPointer,
  type NativeImage,
} from "./Il2cppBinaryImage.js";
import type { Il2cppMetadataDecoded } from "./Il2cppMetadataFile.js";
import type { Il2cppCodeGenModule } from "./Il2cppBinaryFile.js";
// Bound the retained name-address index independently of binary size. No
// repeated name is evidence of ambiguous module ownership by itself.
const TOTAL_NAME_OCCURRENCES = 65536;
const SCAN_BYTES = 65536;

interface NameTrie {
  readonly next: Map<number, NameTrie>;
  readonly owners: number[];
}

/** Reverse byte matching permits C-string suffix sharing. Only a module's
 * declared pointer later establishes which exact candidate it actually names.
 * No decoding/alphabet guess or per-name binary rescan is needed.
 */
function* nameAddresses(
  image: NativeImage,
  names: readonly string[],
): Generator<void, Map<bigint, readonly number[]>> {
  const root: NameTrie = { next: new Map(), owners: [] };
  let nodes = 1,
    work = 0;
  for (const [index, name] of names.entries()) {
    if (++work % 256 === 0) yield;
    if (name === "") continue;
    if (Buffer.byteLength(name) > TOTAL_NAME_OCCURRENCES)
      throw new Il2cppBinaryFormatFailure(
        "native-index-capacity",
        "module-name trie exceeds its65536-node workspace",
      );
    let node = root;
    const bytes = Buffer.from(name, "utf8");
    for (let at = bytes.length - 1; at >= 0; at--) {
      if (++work % 4096 === 0) yield;
      let next = node.next.get(bytes[at]!);
      if (next === undefined) {
        if (nodes >= TOTAL_NAME_OCCURRENCES)
          throw new Il2cppBinaryFormatFailure(
            "native-index-capacity",
            "module-name trie exceeds its65536-node workspace",
          );
        next = { next: new Map(), owners: [] };
        node.next.set(bytes[at]!, next);
        nodes++;
      }
      node = next;
    }
    node.owners.push(index);
  }
  const found = new Map<bigint, readonly number[]>();
  for (const mapping of image.container.mappings) {
    const region = image.bytes.subarray(
      mapping.offset,
      mapping.offset + mapping.size,
    );
    for (let chunk = 0; chunk < region.length; chunk += SCAN_BYTES) {
      yield;
      const part = region.subarray(
        chunk,
        Math.min(chunk + SCAN_BYTES, region.length),
      );
      for (
        let end = part.indexOf(0);
        end >= 0;
        end = part.indexOf(0, end + 1)
      ) {
        let node: NameTrie | undefined = root;
        for (let at = chunk + end - 1; at >= 0; at--) {
          if (++work % 4096 === 0) yield;
          node = node.next.get(region[at]!);
          if (node === undefined) break;
          if (node.owners.length === 0) continue;
          const address = mapping.address + BigInt(at);
          if (!found.has(address) && found.size >= TOTAL_NAME_OCCURRENCES)
            throw new Il2cppBinaryFormatFailure(
              "native-index-capacity",
              `native name-address index exceeds ${TOTAL_NAME_OCCURRENCES} entries`,
            );
          found.set(address, node.owners);
        }
      }
    }
  }
  return found;
}

/** Method count per image from its contiguous type-definition range. */
function* imageMethodCounts(
  metadata: Il2cppMetadataDecoded,
): Generator<void, number[]> {
  const counts: number[] = [];
  for (const image of metadata.images) {
    yield;
    let total = 0;
    for (let offset = 0; offset < image.type_count; offset++) {
      if (offset % 256 === 0) yield;
      total += metadata.types[image.type_start + offset]!.method_count;
    }
    counts.push(total);
  }
  return counts;
}

/**
 * Find Il2CppCodeGenModule records: a moduleName pointer to an image name
 * followed by methodPointerCount equal to that image's method count.
 */
export function* findModules(
  image: NativeImage,
  metadata: Il2cppMetadataDecoded,
): Generator<void, Il2cppCodeGenModule[]> {
  const names = yield* nameAddresses(
    image,
    metadata.images.map((entry) => entry.name),
  );
  const counts = yield* imageMethodCounts(metadata);
  const candidates = new Map<number, Il2cppCodeGenModule[]>();
  for (const mapping of image.container.mappings) {
    const start = Number((8n - (mapping.address % 8n)) % 8n);
    for (let at = start; at + 24 <= mapping.size; at += 8) {
      if ((at & 0xffff) < 8) yield;
      const offset = mapping.offset + at;
      const target = image.bytes.readBigUInt64LE(offset);
      const indices = names.get(target);
      if (indices === undefined) continue;
      let work = 0;
      for (const index of indices) {
        if (++work % 256 === 0) yield;
        const count = image.bytes.readUInt32LE(offset + 8);
        if (count !== counts[index]) continue;
        const pointers = image.bytes.readBigUInt64LE(offset + 16);
        if (!hasPointerArrayCoverage(image, pointers, count)) continue;
        const list = candidates.get(index) ?? [];
        if (list.length !== 0)
          throw new Il2cppBinaryFormatFailure(
            "ambiguous-code-gen-module",
            `multiple records match code generation module ${metadata.images[index]!.name}`,
          );
        list.push({
          image: index,
          address: mapping.address + BigInt(at),
          method_pointer_count: count,
          method_pointers: pointers,
        });
        candidates.set(index, list);
      }
    }
  }
  return metadata.images.map((entry, index) => {
    const list = candidates.get(index) ?? [];
    if (list.length === 0)
      throw new Il2cppBinaryFormatFailure(
        "code-gen-modules-not-found",
        `no code generation module names ${entry.name} with ${counts[index]} method pointers`,
      );
    if (list.length > 1)
      throw new Il2cppBinaryFormatFailure(
        "ambiguous-code-gen-module",
        `${list.length} records match code generation module ${entry.name}`,
      );
    return list[0]!;
  });
}

/**
 * Find the CodeRegistration codeGenModulesCount/codeGenModules pair: a count
 * equal to the image count followed by a pointer to an array holding exactly
 * the located module records.
 */
export function* findCodeRegistration(
  image: NativeImage,
  modules: readonly Il2cppCodeGenModule[],
): Generator<void, { readonly field: bigint | null; readonly array: bigint }> {
  const expected = new Set(modules.map((module) => module.address));
  const total = BigInt(modules.length);
  const matches: { field: bigint; array: bigint }[] = [];
  for (const mapping of image.container.mappings) {
    const start = Number((8n - (mapping.address % 8n)) % 8n);
    for (let at = start; at + 16 <= mapping.size; at += 8) {
      if ((at & 0xffff) < 8) yield;
      const offset = mapping.offset + at;
      if (image.bytes.readBigUInt64LE(offset) !== total) continue;
      const array = image.bytes.readBigUInt64LE(offset + 8);
      if (!isMapped(image, array, modules.length * 8)) continue;
      const seen = new Set<bigint>();
      for (let slot = 0; slot < modules.length; slot++) {
        if (slot % 256 === 0) yield;
        const pointer = readPointer(image, array + BigInt(slot * 8));
        if (pointer === null || !expected.has(pointer)) break;
        seen.add(pointer);
      }
      if (seen.size === modules.length) {
        if (matches.length !== 0)
          throw new Il2cppBinaryFormatFailure(
            "code-registration-not-found",
            "multiple CodeRegistration module tables match",
          );
        matches.push({ field: mapping.address + BigInt(at), array });
      }
    }
  }
  if (matches.length === 0 && image.container.architecture === "amd64") {
    const array = yield* findModuleArrayByCode(image, expected);
    if (array !== null) return { field: null, array };
  }
  if (matches.length !== 1)
    throw new Il2cppBinaryFormatFailure(
      "code-registration-not-found",
      `${matches.length} CodeRegistration module tables list the ${modules.length} located modules`,
    );
  return matches[0]!;
}

/**
 * Some x86-64 builds (a Unity 2023.2 Linux GameAssembly.so) keep no static
 * CodeRegistration: the compiler folded the module array and its count into
 * the one loop that walks it, so no data word points at the array. Find every
 * pointer array that lists exactly the located modules, then require exactly
 * one of them to be the target of a RIP-relative `lea`/`mov` (REX.W 8D/8B with
 * a disp32 operand). Anything else stays code-registration-not-found.
 */
const MODULE_ARRAY_CANDIDATES = 64;

function* findModuleArrayByCode(
  image: NativeImage,
  expected: ReadonlySet<bigint>,
): Generator<void, bigint | null> {
  const arrays = new Set<bigint>();
  for (const mapping of image.container.mappings) {
    const start = Number((8n - (mapping.address % 8n)) % 8n);
    let runStart = start;
    const lastPosition = new Map<bigint, number>();
    for (let at = start; at + 8 <= mapping.size; at += 8) {
      if ((at & 0xffff) < 8) yield;
      const value = image.bytes.readBigUInt64LE(mapping.offset + at);
      if (!expected.has(value)) {
        runStart = at + 8;
        lastPosition.clear();
        continue;
      }
      const previous = lastPosition.get(value);
      if (previous !== undefined && previous >= runStart)
        runStart = previous + 8;
      lastPosition.set(value, at);
      if (at - runStart === (expected.size - 1) * 8) {
        arrays.add(mapping.address + BigInt(runStart));
        // Retain overlapping windows; at most one position per expected module.
        if (arrays.size > MODULE_ARRAY_CANDIDATES)
          throw new Il2cppBinaryFormatFailure(
            "native-index-capacity",
            `module-array index exceeds ${MODULE_ARRAY_CANDIDATES} entries`,
          );
      }
    }
  }
  if (arrays.size === 0) return null;
  const referenced = new Set<bigint>();
  for (const mapping of image.container.executable_mappings ?? []) {
    const bytes = image.bytes;
    const end = mapping.offset + mapping.size - 7;
    for (let at = mapping.offset; at <= end; at++) {
      if ((at & 0xffff) < 8) yield;
      const rex = bytes[at]!;
      if ((rex & 0xfb) !== 0x48) continue; // REX.W, optionally REX.R
      const opcode = bytes[at + 1]!;
      if (opcode !== 0x8d && opcode !== 0x8b) continue;
      if ((bytes[at + 2]! & 0xc7) !== 0x05) continue; // mod 00, rm 101: RIP + disp32
      const next = mapping.address + BigInt(at - mapping.offset + 7);
      const target = next + BigInt(bytes.readInt32LE(at + 3));
      if (arrays.has(target)) referenced.add(target);
    }
  }
  return referenced.size === 1 ? [...referenced][0]! : null;
}

/**
 * Find MetadataRegistration by its two TypeDefinitionIndex-sized counts:
 * fieldOffsetsCount and typeDefinitionsSizesCount (words 10 and 12) both equal
 * the metadata type-definition count and are followed by mapped pointers.
 * typesCount and types are words 6 and 7. Counts are int32 in 8-byte slots.
 */
export function* findMetadataRegistration(
  image: NativeImage,
  typeDefinitions: number,
): Generator<
  void,
  {
    readonly field: bigint;
    readonly count: number;
    readonly types: bigint;
  }
> {
  const matches: { field: bigint; count: number; types: bigint }[] = [];
  const low = (offset: number) => image.bytes.readUInt32LE(offset);
  const word = (offset: number) => image.bytes.readBigUInt64LE(offset);
  for (const mapping of image.container.mappings) {
    const start = Number((8n - (mapping.address % 8n)) % 8n);
    for (let at = start; at + 128 <= mapping.size; at += 8) {
      if ((at & 0xffff) < 8) yield;
      const base = mapping.offset + at;
      if (low(base + 80) !== typeDefinitions) continue;
      if (low(base + 96) !== typeDefinitions) continue;
      const count = low(base + 48);
      const types = word(base + 56);
      if (
        count === 0 ||
        count > 0x7fffffff ||
        !isMapped(image, word(base + 88), 8) ||
        !isMapped(image, word(base + 104), 8) ||
        !isMapped(image, types, count * 8)
      )
        continue;
      if (matches.length !== 0)
        throw new Il2cppBinaryFormatFailure(
          "metadata-registration-not-found",
          "multiple MetadataRegistration candidates match",
        );
      matches.push({
        field: mapping.address + BigInt(at + 48),
        count,
        types,
      });
    }
  }
  if (matches.length !== 1)
    throw new Il2cppBinaryFormatFailure(
      "metadata-registration-not-found",
      `${matches.length} MetadataRegistration candidates count ${typeDefinitions} type definitions`,
    );
  return matches[0]!;
}
