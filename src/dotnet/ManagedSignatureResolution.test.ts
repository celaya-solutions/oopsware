import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  attachManagedDecodeBudget,
  ManagedDecodeBudget,
} from "./ManagedDecodeBudget.js";
import { inspectManagedMembersBytes } from "./ManagedMemberInspector.js";
import {
  parseTypes,
  signature,
  typeRanges,
} from "./ManagedMemberInspectorCore.js";
import {
  metadataRowOffset,
  readManagedMetadataLayout,
} from "./ManagedMetadataLayout.js";
import {
  buildManagedPeFixture,
  managedPeFixtureTarget,
} from "./ManagedPe.fixture.js";
import { readManagedPeLayout } from "./ManagedPeReader.js";
import { managedTypeNameDigests } from "./ManagedTypeNameDigests.js";
import { managedTypeReferences } from "./ManagedTypeReferences.js";
import { readTypeMemberListFacts } from "./ManagedTypeMemberLists.js";

// A top-level type's name digest, as ManagedTypeNameDigests forms it.
const nameDigest = (name: string): Buffer => {
  const dot = name.lastIndexOf(".");
  return createHash("sha256")
    .update(Buffer.from([0]))
    .update(dot === -1 ? "" : name.slice(0, dot))
    .update(Buffer.from([0]))
    .update(name.slice(dot + 1))
    .digest();
};

const metadataLayout = (bytes: Buffer) => {
  const pe = readManagedPeLayout(bytes);
  if (pe.cli === null) throw new Error("Fixture has no CLI metadata");
  return readManagedMetadataLayout(
    bytes,
    pe.rvaToOffset(pe.cli.metadata.rva, pe.cli.metadata.size, "cli.metadata"),
    pe.cli.metadata.size,
  );
};

const named =
  (names: Readonly<Record<number, string>>) =>
  (codedIndex: number): Buffer | null => {
    const name = names[codedIndex];
    return name === undefined ? null : nameDigest(name);
  };

describe("resolved member signature digests", () => {
  it("names modifier, class, and generic type operands instead of their rows", () => {
    // modreq(M) G<P> on the left and the same types at other rows on the right.
    const left = signature(
      Buffer.from([0x06, 0x1f, 0x05, 0x15, 0x12, 0x09, 0x01, 0x11, 0x0d]),
      undefined,
      named({ 0x05: "N.Mod", 0x09: "N.G`1", 0x0d: "N.P" }),
    );
    const right = signature(
      Buffer.from([0x06, 0x1f, 0x15, 0x15, 0x12, 0x19, 0x01, 0x11, 0x1d]),
      undefined,
      named({ 0x15: "N.Mod", 0x19: "N.G`1", 0x1d: "N.P" }),
    );

    expect(left.raw_sha256).not.toBe(right.raw_sha256);
    expect(left.resolved_sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(left.resolved_sha256).toBe(right.resolved_sha256);
  });

  it("keeps the raw digest for a signature without type operands", () => {
    const decoded = signature(Buffer.from([0x00, 0x01, 0x08, 0x0e]));

    expect(decoded.resolved_sha256).toBe(decoded.raw_sha256);
  });

  it("withholds the digest when an operand has no name", () => {
    expect(
      signature(Buffer.from([0x06, 0x12, 0x05]), undefined, named({}))
        .resolved_sha256,
    ).toBeNull();
  });

  it("leaves a blob forged from a resolved preimage undecoded", () => {
    // The resolved preimage of class "A": 0xff, then the name digest. 0xff
    // never starts a compressed coded index, so the forged blob does not
    // decode and has only a raw digest, equal to the resolved one; comparison
    // tags the two kinds apart.
    const forged = signature(
      Buffer.concat([Buffer.from([0x06, 0x12, 0xff]), nameDigest("A")]),
    );
    const resolved = signature(
      Buffer.from([0x06, 0x12, 0x05]),
      undefined,
      named({ 0x05: "A" }),
    );

    expect(forged.parse_status).toBe("malformed");
    expect(forged.resolved_sha256).toBeNull();
    expect(forged.raw_sha256).toBe(resolved.resolved_sha256);
  });

  it.each([
    ["a TypeSpec, whose blob member inspection does not decode", (1 << 2) | 2],
    ["a TypeRef row outside its table", (9 << 2) | 1],
  ])("does not name %s", (_name, codedIndex) => {
    const bytes = buildManagedPeFixture({
      fieldSignature: Buffer.from([0x06, 0x12, codedIndex]),
    });
    const field = inspectManagedMembersBytes(
      bytes,
      managedPeFixtureTarget(bytes),
    ).fields[0];

    expect(field?.signature.parse_status).toBe("decoded");
    expect(field?.signature.resolved_sha256).toBeNull();
  });

  it("names each type operand once, so repeated operands are not charged again", () => {
    const bytes = buildManagedPeFixture({
      typeReferences: [{ namespace: "System", name: "Uri" }],
    });
    const layout = metadataLayout(bytes);
    const budget = new ManagedDecodeBudget();
    attachManagedDecodeBudget(layout, budget);
    const typeName = managedTypeNameDigests(
      layout,
      [],
      {
        types: [],
        nesting: { enclosing: new Map(), complete: true },
      },
      managedTypeReferences(bytes, layout, []),
    );
    const uri = (2 << 2) | 1;

    expect(typeName(uri)).toEqual(nameDigest("System.Uri"));
    const reserve = vi.spyOn(budget, "reserve");
    expect(typeName(uri)).toEqual(nameDigest("System.Uri"));
    expect(reserve).not.toHaveBeenCalled();
  });

  it("bounds name loading before resolving a deep real TypeRef scope chain", () => {
    const name = "X".repeat(2048);
    const rows = 10_000;
    const bytes = buildManagedPeFixture({
      fieldSignature: Buffer.from([0x06, 0x12, (2 << 2) | 1]),
      typeReferences: Array.from({ length: rows }, (_, index) => ({
        namespace: "",
        name,
        ...(index + 1 === rows ? {} : { enclosingRow: index + 3 }),
      })),
    });
    const layout = metadataLayout(bytes);
    const first =
      metadataRowOffset(layout, 1, 2) +
      layout.codedIndexSize("ResolutionScope");
    const sharedName =
      layout.stringIndexSize === 4
        ? bytes.readUInt32LE(first)
        : bytes.readUInt16LE(first);
    for (let row = 3; row <= rows + 1; row += 1) {
      const offset =
        metadataRowOffset(layout, 1, row) +
        layout.codedIndexSize("ResolutionScope");
      if (layout.stringIndexSize === 4) bytes.writeUInt32LE(sharedName, offset);
      else bytes.writeUInt16LE(sharedName, offset);
    }
    const issues: Parameters<typeof managedTypeReferences>[2] = [];
    const parsedTypes = parseTypes(
      bytes,
      layout,
      typeRanges(bytes, layout, issues, readTypeMemberListFacts(bytes, layout)),
    );
    const resolve = managedTypeNameDigests(
      layout,
      issues,
      parsedTypes,
      managedTypeReferences(bytes, layout, issues),
    );
    expect(() => resolve((2 << 2) | 1)).not.toThrow();
    expect(resolve((2 << 2) | 1)).toBeNull();
    expect(issues).toEqual([]);
    const inspection = inspectManagedMembersBytes(
      bytes,
      managedPeFixtureTarget(bytes),
    );
    expect(inspection.coverage).toEqual({ state: "complete", issues: [] });
    expect(inspection.fields[0]).toBeDefined();
    expect(inspection.fields[0]?.signature.resolved_sha256).toBeNull();
  });
});

const fieldOf = (options: Parameters<typeof buildManagedPeFixture>[0]) => {
  const bytes = buildManagedPeFixture(options);
  return inspectManagedMembersBytes(bytes, managedPeFixtureTarget(bytes));
};

describe("type operand names", () => {
  it("keeps a TypeRef's namespace and name apart", () => {
    const resolved = (namespace: string, name: string) =>
      fieldOf({
        typeReferences: [{ namespace, name }],
        fieldSignature: Buffer.from([0x06, 0x12, (2 << 2) | 1]),
      }).fields[0]?.signature.resolved_sha256;

    expect(resolved("A", "B.C")).toMatch(/^[0-9a-f]{64}$/u);
    expect(resolved("A", "B.C")).not.toBe(resolved("A.B", "C"));
  });

  it("keeps a TypeDef's namespace and name apart", () => {
    const resolved = (typeNamespace: string, typeName: string) =>
      fieldOf({
        typeNamespace,
        typeName,
        fieldSignature: Buffer.from([0x06, 0x12, 1 << 2]),
      }).fields[0]?.signature.resolved_sha256;

    expect(resolved("A", "B.C")).toMatch(/^[0-9a-f]{64}$/u);
    expect(resolved("A", "B.C")).not.toBe(resolved("A.B", "C"));
  });

  it("names a TypeDef and a TypeRef of one namespace and name alike", () => {
    const definition = fieldOf({
      fieldSignature: Buffer.from([0x06, 0x12, 1 << 2]),
    }).fields[0]?.signature.resolved_sha256;
    const reference = fieldOf({
      typeReferences: [{ namespace: "Fixture", name: "Program" }],
      fieldSignature: Buffer.from([0x06, 0x12, (2 << 2) | 1]),
    }).fields[0]?.signature.resolved_sha256;

    expect(definition).toMatch(/^[0-9a-f]{64}$/u);
    expect(definition).toBe(reference);
  });

  it("reports an unreadable TypeRef operand row once in coverage", () => {
    const uri = (2 << 2) | 1;
    const bytes = buildManagedPeFixture({
      typeReferences: [{ namespace: "System", name: "Uri" }],
      fieldSignature: Buffer.from([0x06, 0x12, uri]),
      methodSignature: Buffer.from([0x00, 0x00, 0x12, uri]),
    });
    const layout = metadataLayout(bytes);
    // An out-of-range name index makes TypeRef row 2 unreadable.
    bytes.writeUInt16LE(
      0xffff,
      metadataRowOffset(layout, 1, 2) +
        layout.codedIndexSize("ResolutionScope"),
    );
    const inspection = inspectManagedMembersBytes(
      bytes,
      managedPeFixtureTarget(bytes),
    );

    expect(inspection.fields[0]?.signature.resolved_sha256).toBeNull();
    expect(inspection.coverage.state).toBe("partial");
    expect(inspection.coverage.issues).toEqual([
      expect.objectContaining({
        code: "invalid-heap-index",
        scope: "metadata.#Strings",
      }),
    ]);
  });

  it("retains an operand outside its type table as incomplete coverage", () => {
    const inspection = fieldOf({
      fieldSignature: Buffer.from([0x06, 0x12, (9 << 2) | 1]),
    });

    expect(inspection.fields[0]?.signature.resolved_sha256).toBeNull();
    expect(inspection.coverage.state).toBe("partial");
    expect(inspection.coverage.issues).toEqual([
      expect.objectContaining({ code: "invalid-row" }),
    ]);
  });

  it("preserves readable TypeRef names while withholding an invalid scope's signature identity", () => {
    const inspection = fieldOf({
      typeRefScopeRaw: (99 << 2) | 2,
      fieldSignature: Buffer.from([0x06, 0x12, (1 << 2) | 1]),
      memberRefParentRaw: (1 << 3) | 1,
    });
    expect(inspection.fields[0]?.signature.resolved_sha256).toBeNull();
    expect(inspection.member_refs[0]?.parent_name).toBe(
      "System.Runtime.Versioning.TargetFrameworkAttribute",
    );
    expect(inspection.coverage.state).toBe("partial");
    expect(inspection.coverage.issues).toEqual([
      expect.objectContaining({
        code: "invalid-row",
        scope: "metadata.TypeRef:0x01000001",
      }),
    ]);
  });

  it.each([
    {
      rows: [
        [1, 2],
        [1, 2],
      ],
    },
    {
      rows: [
        [1, 2],
        [1, 3],
      ],
    },
    { rows: [[1, 1]] },
    { rows: [[1, 0]] },
    { rows: [[0, 2]] },
    { rows: [[1, 4]] },
  ] as const)(
    "withholds TypeDef identity for invalid nesting $rows",
    ({ rows }) => {
      const inspection = fieldOf({
        additionalEmptyTypes: 2,
        nestedTypes: rows,
        fieldSignature: Buffer.from([0x06, 0x12, 1 << 2]),
      });
      expect(inspection.fields[0]?.signature.resolved_sha256).toBeNull();
      expect(inspection.coverage.state).toBe("partial");
      expect(inspection.coverage.issues).toEqual([
        expect.objectContaining({ code: "invalid-row" }),
      ]);
    },
  );
});
