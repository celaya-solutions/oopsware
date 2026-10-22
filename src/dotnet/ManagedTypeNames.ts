import type { ManagedTypeReferenceLookup } from "./ManagedTypeReferences.js";
import type { ManagedParseIssue } from "../domain/managed/managedArtifact.js";
import {
  fullName,
  readCompressed,
  specSignature,
  type TypeRange,
} from "./ManagedMemberInspectorCore.js";
import {
  metadataRowOffset,
  type ManagedMetadataLayout,
} from "./ManagedMetadataLayout.js";
import {
  metadataRowCursor,
  metadataToken,
  readMetadataBlob,
} from "./ManagedMetadataHeaps.js";
import { managedFailure, readManagedValue } from "./ManagedReaderFailure.js";

/**
 * Name the type a TypeDef, TypeRef, or generic-instantiation TypeSpec token
 * denotes, in the namespace-qualified form TypeDef `full_name` uses, once per
 * token. Other decoded TypeSpecs stay null: the type is unknown. Malformed or
 * unsupported rows and blobs are reported to `issues` and also stay null,
 * except that a TypeRef with an invalid ResolutionScope keeps its readable name.
 */
export const typeNameLookup = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  ranges: readonly TypeRange[],
  issues: ManagedParseIssue[],
  references: ManagedTypeReferenceLookup,
): ((token: string | null) => string | null) => {
  const names = new Map<string, string | null>();
  const definitionName = (table: 1 | 2, row: number): string | null => {
    if (table === 2) {
      metadataRowOffset(layout, 2, row);
      return ranges[row - 1]?.fullName ?? null;
    }
    const reference = references(row);
    return reference === null
      ? null
      : fullName(reference.namespace, reference.name);
  };
  const specName = (row: number): string | null => {
    const cursor = metadataRowCursor(bytes, layout, 27, row);
    const spec = readMetadataBlob(
      bytes,
      layout,
      cursor.readIndex(layout.blobIndexSize),
      layout.blob.size,
    );
    const owner = {
      form: "type",
      scope: `metadata.TypeSpec:${metadataToken(27, row)}`,
      offset: cursor.start,
    } as const;
    specSignature(layout, spec, owner);
    if (spec[0] !== 0x15) return null;
    // GENERICINST (CLASS | VALUETYPE) TypeDefOrRefEncoded: never a TypeSpec,
    // so naming never recurses.
    const encoded = readCompressed(spec, 2).value;
    const table = ([2, 1] as const)[encoded & 3];
    if (table === undefined)
      throw managedFailure(
        "invalid-blob",
        owner.scope,
        "Generic instantiation does not name a TypeDef or TypeRef",
        owner.offset,
      );
    return definitionName(table, Math.floor(encoded / 4));
  };
  return (token) => {
    if (token === null) return null;
    if (names.has(token)) return names.get(token) ?? null;
    const table = Number.parseInt(token.slice(2, 4), 16);
    const row = Number.parseInt(token.slice(4), 16);
    const name =
      readManagedValue(
        () =>
          table === 27
            ? specName(row)
            : table === 1 || table === 2
              ? definitionName(table, row)
              : null,
        issues,
      ) ?? null;
    names.set(token, name);
    return name;
  };
};
