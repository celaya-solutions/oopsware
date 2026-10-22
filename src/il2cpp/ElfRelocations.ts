import {
  GoBinaryFormatFailure,
  mappedFileOffset,
  isZeroFilledSpan,
  type GoFileMapping,
  type GoZeroFillMapping,
} from "../go/GoBinaryContainer.js";
import { Il2cppBinaryFormatFailure } from "./Il2cppBinaryFormat.js";

const DT_RELA = 7n,
  DT_RELASZ = 8n,
  DT_RELAENT = 9n;
const DT_PLTRELSZ = 2n,
  DT_PLTREL = 20n,
  DT_JMPREL = 23n;
const MAX_OVERLAY_ENTRIES = 65536;
const malformed = (message: string) =>
  new Il2cppBinaryFormatFailure("malformed-container", message);
const unsupported = (message: string) =>
  new Il2cppBinaryFormatFailure("unsupported-pointer-encoding", message);

interface RelocatedImage {
  readonly bytes: Buffer;
  readonly unresolved: Set<bigint>;
  readonly zeroFillPointers: Map<bigint, bigint>;
}
interface RelocationSource {
  readonly image: Buffer;
  readonly mappings: readonly GoFileMapping[];
  readonly zeroFills: readonly GoZeroFillMapping[];
  readonly relative: number;
  readonly unknownPointerKinds: ReadonlySet<number>;
}

/** Standard dynamic relocations whose destination spans at most eight bytes.
 * Other encodings (including COPY and TLS descriptors) need their own width
 * semantics; do not silently apply them or turn their stored zero into absence.
 */
const RELOCATION_KINDS = new Map([
  [
    183,
    {
      relative: 1027,
      unknownPointerKinds: new Set([
        257, 258, 259, 260, 261, 262, 1025, 1026, 1028, 1029, 1030, 1032,
      ]),
    },
  ],
  [
    62,
    {
      relative: 8,
      unknownPointerKinds: new Set([1, 2, 6, 7, 10, 11, 16, 17, 18, 24, 37]),
    },
  ],
]);

function* dynamicTags(image: Buffer): Generator<void, Map<bigint, bigint>> {
  if (image.length < 64) throw malformed("ELF header is truncated");
  const offset = Number(image.readBigUInt64LE(32)),
    width = image.readUInt16LE(54),
    count = image.readUInt16LE(56);
  if (width < 56 || offset + count * width > image.length)
    throw malformed("ELF program headers extend beyond the file");
  let dynamic: { offset: number; size: number } | undefined;
  for (let index = 0; index < count; index++) {
    if (index % 256 === 0) yield;
    const at = offset + index * width;
    if (image.readUInt32LE(at) !== 2) continue;
    if (dynamic !== undefined) throw malformed("multiple PT_DYNAMIC segments");
    dynamic = {
      offset: Number(image.readBigUInt64LE(at + 8)),
      size: Number(image.readBigUInt64LE(at + 32)),
    };
  }
  if (dynamic === undefined)
    throw new Il2cppBinaryFormatFailure(
      "unsupported-container",
      "ELF image has no PT_DYNAMIC segment",
    );
  if (dynamic.size % 16 !== 0 || dynamic.offset + dynamic.size > image.length)
    throw malformed("PT_DYNAMIC is truncated or outside the file");
  const tags = new Map<bigint, bigint>();
  const unique = new Set([
    DT_RELA,
    DT_RELASZ,
    DT_RELAENT,
    DT_JMPREL,
    DT_PLTRELSZ,
    DT_PLTREL,
  ]);
  for (let at = dynamic.offset; at < dynamic.offset + dynamic.size; at += 16) {
    if ((at - dynamic.offset) % 65536 === 0) yield;
    const tag = image.readBigInt64LE(at);
    if (tag === 0n) return tags;
    if (tags.has(tag) && unique.has(tag))
      throw malformed(`duplicate dynamic tag ${tag}`);
    tags.set(tag, image.readBigUInt64LE(at + 8));
  }
  throw malformed("PT_DYNAMIC has no DT_NULL terminator");
}

const fileOffset = (
  mappings: readonly GoFileMapping[],
  address: bigint,
  size: number,
): number | null => {
  try {
    return mappedFileOffset(mappings, address, size);
  } catch (cause) {
    if (cause instanceof GoBinaryFormatFailure) return null;
    throw cause;
  }
};

const admitOverlay = (output: RelocatedImage) => {
  if (
    output.unresolved.size + output.zeroFillPointers.size >=
    MAX_OVERLAY_ENTRIES
  )
    throw new Il2cppBinaryFormatFailure(
      "native-index-capacity",
      `ELF relocation overlay exceeds ${MAX_OVERLAY_ENTRIES} entries`,
    );
};

/** Each admitted record is interpreted once from the original immutable bytes. */
function* applyRelaTable(
  source: RelocationSource,
  output: RelocatedImage,
  address: bigint,
  size: bigint | undefined,
  entry: bigint,
): Generator<void> {
  if (
    size === undefined ||
    size < 0n ||
    entry !== 24n ||
    size % entry !== 0n ||
    size > BigInt(source.image.length)
  )
    throw malformed("invalid DT_RELASZ or DT_RELAENT");
  const start = fileOffset(source.mappings, address, Number(size));
  if (start === null) throw malformed("RELA table is not file-backed");
  for (let at = start; at < start + Number(size); at += 24) {
    if ((at - start) % (24 * 4096) === 0) yield;
    const info = source.image.readBigUInt64LE(at + 8),
      kind = Number(info & 0xffffffffn);
    if (kind === 0) continue;
    const destination = source.image.readBigUInt64LE(at);
    const target = fileOffset(source.mappings, destination, 8);
    if (kind !== source.relative || info >> 32n !== 0n) {
      if (!source.unknownPointerKinds.has(kind))
        throw unsupported(`ELF relocation kind ${kind} is not decoded`);
      if (!output.unresolved.has(destination)) {
        admitOverlay(output);
        output.unresolved.add(destination);
      }
      // Registration scans read this private image directly. Clear unknown
      // fields so their stored bytes cannot masquerade as resolved pointers.
      if (target !== null) output.bytes.fill(0, target, target + 8);
      continue;
    }
    const value = source.image.readBigInt64LE(at + 16) & 0xffffffffffffffffn;
    if (target !== null) output.bytes.writeBigUInt64LE(value, target);
    else if (
      isZeroFilledSpan(source.mappings, source.zeroFills, destination, 8)
    ) {
      if (!output.zeroFillPointers.has(destination)) admitOverlay(output);
      output.zeroFillPointers.set(destination, value);
    } else
      throw malformed(
        "RELATIVE relocation target is outside unambiguous loaded memory",
      );
  }
}

/** Materialize relative pointers in a private copy, preserving unknown and .bss facts. */
export function* applyElfRelativeRelocationsSteps(
  image: Buffer,
  mappings: readonly GoFileMapping[],
  zeroFills: readonly GoZeroFillMapping[],
): Generator<void, RelocatedImage> {
  if (image.length < 64) throw malformed("ELF header is truncated");
  const kinds = RELOCATION_KINDS.get(image.readUInt16LE(18));
  if (kinds === undefined)
    throw new Il2cppBinaryFormatFailure(
      "unsupported-container",
      "ELF relocations require AArch64 or x86-64",
    );
  const tags = yield* dynamicTags(image);
  if (tags.has(0x6000000fn) || tags.has(0x60000011n) || tags.has(17n))
    throw unsupported(
      "Android packed (APS2) or REL relocations are not decoded",
    );
  yield;
  const output: RelocatedImage = {
    bytes: Buffer.from(image),
    unresolved: new Set(),
    zeroFillPointers: new Map(),
  };
  const source = { image, mappings, zeroFills, ...kinds };
  const rela = tags.get(DT_RELA);
  if (rela !== undefined)
    yield* applyRelaTable(
      source,
      output,
      rela,
      tags.get(DT_RELASZ),
      tags.get(DT_RELAENT) ?? 24n,
    );
  else if ((tags.get(DT_RELASZ) ?? 0n) !== 0n)
    throw malformed("DT_RELASZ has no DT_RELA");
  const plt = tags.get(DT_JMPREL);
  if (plt !== undefined) {
    if (tags.get(DT_PLTREL) !== DT_RELA)
      throw unsupported("PLT relocations require RELA encoding");
    yield* applyRelaTable(source, output, plt, tags.get(DT_PLTRELSZ), 24n);
  }
  return output;
}
