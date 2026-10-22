import {
  createAsarHeaderSignatureProbe,
  type FinalAsarHeaderProbeObservation,
} from "./AsarHeader.js";
import {
  createXmlPlistSignatureProbe,
  MAX_XML_PLIST_PROBE_BYTES,
} from "../domain/apple/appleArchiveFormat.js";
import {
  readFatContainerHeader,
  readFatContainerTable,
  readMachoHeaderPrefixFacts,
  type FatContainerTable,
  type MachoHeaderPrefixFacts,
  type FatSliceHeaderEvidence,
} from "../domain/apple/machoContainer.js";

/** Initial bytes required by the other bounded format classifiers. */
export const ARTIFACT_CLASSIFICATION_PREFIX_BYTES = 8_192;

/** Retained prefix plus bounded format-specific observations from the stream. */
export interface ArtifactClassificationEvidence {
  readonly prefix: Buffer;
  readonly asarHeader: FinalAsarHeaderProbeObservation;
  readonly fatSliceHeaders?: FatSliceHeaderEvidence;
}

const observeFatSliceHeaders = (input: {
  readonly table: FatContainerTable | undefined;
  readonly observedHeaders: Map<number, MachoHeaderPrefixFacts>;
  readonly partialHeaders: Map<
    number,
    { readonly bytes: Buffer; count: number }
  >;
  readonly streamOffset: number;
  readonly bytes: Uint8Array;
}): void => {
  const { table, observedHeaders, partialHeaders, streamOffset, bytes } = input;
  if (table?.state !== "parsed") return;
  for (const slice of table.slices) {
    if (observedHeaders.has(slice.offset) && !partialHeaders.has(slice.offset))
      continue;
    const headerLength = Math.min(12, slice.size);
    const headerEnd = slice.offset + headerLength;
    if (!Number.isSafeInteger(headerEnd)) continue;
    const start = Math.max(slice.offset, streamOffset);
    const end = Math.min(headerEnd, streamOffset + bytes.length);
    if (start >= end) continue;
    let pending = partialHeaders.get(slice.offset);
    if (pending === undefined) {
      pending = { bytes: Buffer.alloc(12), count: 0 };
      partialHeaders.set(slice.offset, pending);
    }
    Buffer.from(bytes.subarray(start - streamOffset, end - streamOffset)).copy(
      pending.bytes,
      start - slice.offset,
    );
    pending.count += end - start;
    observedHeaders.set(
      slice.offset,
      readMachoHeaderPrefixFacts(
        pending.bytes.subarray(0, Math.min(pending.count, headerLength)),
      ),
    );
    if (pending.count === headerLength) {
      partialHeaders.delete(slice.offset);
    }
  }
};

const finishClassificationEvidence = (
  prefix: Buffer,
  archiveBytes: number,
  finishAsar: (archiveBytes: number) => FinalAsarHeaderProbeObservation,
  sliceHeadersByOffset: Map<number, MachoHeaderPrefixFacts>,
): ArtifactClassificationEvidence => {
  const finalHeader = readFatContainerHeader(prefix, archiveBytes);
  if (finalHeader.state === "parsed") {
    for (let index = 0; index < finalHeader.slices.length; index += 1) {
      const slice = finalHeader.slices[index];
      if (slice === undefined || sliceHeadersByOffset.has(slice.offset))
        continue;
      const available = Math.max(
        0,
        Math.min(slice.size, prefix.length - slice.offset),
      );
      if (available === 0) continue;
      sliceHeadersByOffset.set(
        slice.offset,
        readMachoHeaderPrefixFacts(
          prefix.subarray(slice.offset, slice.offset + available),
        ),
      );
    }
  }
  const fatSliceHeaders =
    finalHeader.state === "parsed"
      ? { header: finalHeader, sliceHeadersByOffset }
      : undefined;
  return {
    prefix,
    asarHeader: finishAsar(archiveBytes),
    ...(fatSliceHeaders === undefined ? {} : { fatSliceHeaders }),
  };
};

/** Share acquisition bounds and signature observations across files and streams. */
export const createArtifactClassificationProbe = () => {
  const xml = createXmlPlistSignatureProbe();
  const asar = createAsarHeaderSignatureProbe();
  const blocks: Buffer[] = [];
  let retainedBytes = 0;
  let observedBytes = 0;
  let fatTable: FatContainerTable | undefined;
  const fatSliceHeadersByOffset = new Map<number, MachoHeaderPrefixFacts>();
  const partialFatHeaders = new Map<
    number,
    { readonly bytes: Buffer; count: number }
  >();
  const retain = (bytes: Uint8Array): void => {
    let offset = 0;
    while (offset < bytes.length) {
      const blockOffset = retainedBytes % ARTIFACT_CLASSIFICATION_PREFIX_BYTES;
      if (blockOffset === 0)
        blocks.push(Buffer.allocUnsafe(ARTIFACT_CLASSIFICATION_PREFIX_BYTES));
      const count = Math.min(
        ARTIFACT_CLASSIFICATION_PREFIX_BYTES - blockOffset,
        bytes.length - offset,
      );
      blocks[blocks.length - 1]!.set(
        bytes.subarray(offset, offset + count),
        blockOffset,
      );
      retainedBytes += count;
      offset += count;
    }
  };
  const retainedPrefix = (): Buffer => {
    const prefix = Buffer.allocUnsafe(retainedBytes);
    let copied = 0;
    for (const block of blocks) {
      const count = Math.min(block.length, retainedBytes - copied);
      prefix.set(block.subarray(0, count), copied);
      copied += count;
    }
    return prefix;
  };
  return {
    get length(): number {
      return observedBytes;
    },
    get limit(): number {
      if (observedBytes < ARTIFACT_CLASSIFICATION_PREFIX_BYTES)
        return ARTIFACT_CLASSIFICATION_PREFIX_BYTES;
      return Math.max(
        ARTIFACT_CLASSIFICATION_PREFIX_BYTES,
        xml.state === "pending" ? MAX_XML_PLIST_PROBE_BYTES : 0,
        asar.observation.state === "pending" ? asar.limit : 0,
      );
    },
    write(bytes: Uint8Array): void {
      const streamOffset = observedBytes;
      asar.write(bytes);
      let offset = 0;
      while (offset < bytes.length) {
        const limit =
          retainedBytes < ARTIFACT_CLASSIFICATION_PREFIX_BYTES
            ? ARTIFACT_CLASSIFICATION_PREFIX_BYTES
            : xml.state === "pending"
              ? MAX_XML_PLIST_PROBE_BYTES
              : retainedBytes;
        if (retainedBytes >= limit) break;
        const selected = bytes.subarray(
          offset,
          offset + Math.min(limit - retainedBytes, bytes.length - offset),
        );
        retain(selected);
        xml.write(selected);
        offset += selected.length;
      }
      if (
        (fatTable === undefined || fatTable.state === "needs-data") &&
        retainedBytes >= 8
      )
        fatTable = readFatContainerTable(retainedPrefix());
      observeFatSliceHeaders({
        table: fatTable,
        observedHeaders: fatSliceHeadersByOffset,
        partialHeaders: partialFatHeaders,
        streamOffset,
        bytes,
      });
      observedBytes += bytes.length;
    },
    finish(archiveBytes: number): ArtifactClassificationEvidence {
      return finishClassificationEvidence(
        retainedPrefix(),
        archiveBytes,
        (bytes) => asar.finish(bytes),
        fatSliceHeadersByOffset,
      );
    },
  };
};
