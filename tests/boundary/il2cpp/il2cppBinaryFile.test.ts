import { Il2cppBinaryFormatFailure } from "../../../src/il2cpp/Il2cppBinaryFormat.js";
import { expect, it } from "vitest";
import {
  linkIl2cppBinary,
  linkIl2cppBinarySteps,
} from "../../../src/il2cpp/Il2cppBinaryFile.js";
import { readIl2cppMetadataForLinking } from "../../../src/il2cpp/Il2cppMetadataFile.js";
import {
  createElfFixture,
  createIl2cppBinaryFixture,
  createUniversalFixture,
  createSplitPointerPeFixture,
  FIXTURE_BINARY_BASE,
  FIXTURE_METHOD_ADDRESSES,
  FIXTURE_RETURN_TYPE_NAME,
  type Il2cppBinaryFixtureOptions,
} from "../../fixtures/il2cpp/binary.js";
import { createIl2cppMetadataFixture } from "../../fixtures/il2cpp/metadata.js";

const { metadata, link: facts } = readIl2cppMetadataForLinking(
  createIl2cppMetadataFixture().bytes,
);
const expectedAddress = (value: bigint | "no-body" | "unknown") =>
  typeof value === "bigint"
    ? {
        state: "code",
        address: `0x${value.toString(16)}`,
        rva: `0x${(value - FIXTURE_BINARY_BASE).toString(16)}`,
      }
    : { state: value, address: null, rva: null };
const expectedAddresses = FIXTURE_METHOD_ADDRESSES.map(expectedAddress);
const link = (bytes: Buffer, architecture?: string) =>
  linkIl2cppBinary(bytes, metadata, facts, architecture);
const failure = (bytes: Buffer, architecture?: string) => {
  try {
    link(bytes, architecture);
  } catch (cause) {
    if (cause instanceof Il2cppBinaryFormatFailure)
      return { reason: cause.reason, kind: cause.kind };
    throw cause;
  }
  throw new Error("expected a link failure");
};

it("links methods to code through module tokens, not metadata order", () => {
  const linked = link(createIl2cppBinaryFixture());
  expect(linked).toMatchObject({
    format: "macho",
    architecture: "arm64",
    image_base: FIXTURE_BINARY_BASE,
    code_gen_modules_field: FIXTURE_BINARY_BASE + 0x600n,
    code_gen_modules_array: FIXTURE_BINARY_BASE + 0x500n,
    code_gen_modules: [
      {
        image: 0,
        address: FIXTURE_BINARY_BASE + 0x400n,
        method_pointer_count: 3,
      },
      {
        image: 1,
        address: FIXTURE_BINARY_BASE + 0x440n,
        method_pointer_count: 2,
      },
    ],
  });
  expect(linked.method_addresses).toEqual(expectedAddresses);
  expect(linked).toMatchObject({
    types_field: FIXTURE_BINARY_BASE + 0x830n,
    types_count: 4,
  });
  expect(linked.return_types).toEqual(
    Array.from({ length: 5 }, () => ({
      type: 0,
      name: FIXTURE_RETURN_TYPE_NAME,
    })),
  );
});

it("requires an explicit slice of a universal Mach-O and reads only that slice", () => {
  const thin = createIl2cppBinaryFixture();
  const universal = createUniversalFixture([
    { cpu: 0x01000007, bytes: Buffer.alloc(0x100) },
    { cpu: 0x0100000c, bytes: thin },
  ]);
  expect(failure(universal)).toEqual({
    reason: "slice-selection-required",
    kind: "unsupported",
  });
  expect(link(universal, "arm64").method_addresses).toEqual(expectedAddresses);
  expect(failure(universal, "ppc64").reason).toBe("slice-not-found");
  expect(failure(thin, "arm64").reason).toBe("slice-not-found");
});

it.each<
  [string, Il2cppBinaryFixtureOptions, string, "unsupported" | "malformed"]
>([
  [
    "a method count mismatch",
    { firstModuleCount: 4 },
    "code-gen-modules-not-found",
    "malformed",
  ],
  [
    "two matching module records",
    { duplicateModule: true },
    "ambiguous-code-gen-module",
    "malformed",
  ],
  [
    "no CodeRegistration module table",
    { codeRegistration: false },
    "code-registration-not-found",
    "malformed",
  ],
  [
    "no MetadataRegistration type table",
    { metadataRegistration: false },
    "metadata-registration-not-found",
    "malformed",
  ],
  [
    "chained fixups",
    { chainedFixups: true },
    "unsupported-pointer-encoding",
    "unsupported",
  ],
])("rejects %s without partial addresses", (_, options, reason, kind) => {
  expect(failure(createIl2cppBinaryFixture(options))).toEqual({ reason, kind });
});

it("reports type indices without names for metadata version 27", () => {
  const linked = linkIl2cppBinary(
    createIl2cppBinaryFixture(),
    { ...metadata, metadata_version: 27 },
    facts,
  );
  const rows = [
    ...linked.return_types,
    ...linked.field_types,
    ...linked.parameter_types,
  ];
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.every((row) => row.name === null)).toBe(true);
  expect(link(createIl2cppBinaryFixture()).return_types[0]?.name).toBe(
    FIXTURE_RETURN_TYPE_NAME,
  );
});

it("does not search for an empty image name", () => {
  const unnamed = {
    ...metadata,
    images: metadata.images.map((image, index) =>
      index === 0 ? { ...image, name: "" } : image,
    ),
  };
  expect(() =>
    linkIl2cppBinary(createIl2cppBinaryFixture(), unnamed, facts),
  ).toThrow("code-gen-modules-not-found");
});

it("refuses an image name repeated past the search bound", () => {
  const fixture = createIl2cppBinaryFixture();
  const flooded = Buffer.concat([
    fixture,
    Buffer.from("\0mscorlib.dll".repeat(65537) + "\0", "utf8"),
  ]);
  // The Mach-O segment covers the original size; widen it to the new tail.
  flooded.writeBigUInt64LE(BigInt(flooded.length), 64);
  flooded.writeBigUInt64LE(BigInt(flooded.length), 80);
  expect(failure(flooded)).toEqual({
    reason: "native-index-capacity",
    kind: "capacity",
  });
});

it.each([
  [{ duplicateRela: true }],
  [{ relaEntry: 16n }],
  [{ relaSize: 25n }],
] as const)("rejects malformed ELF relocation tables (%o)", (options) => {
  expect(
    failure(createElfFixture(createIl2cppBinaryFixture(), options)),
  ).toEqual({ reason: "malformed-container", kind: "malformed" });
});

it("does not apply symbol relocations as RELATIVE ones", () => {
  // With every slot left zero, no module table can be found.
  expect(() =>
    link(
      createElfFixture(createIl2cppBinaryFixture(), {
        symbolRelocations: true,
      }),
    ),
  ).toThrow(Il2cppBinaryFormatFailure);
});

it("reads a method pointer array in zero-fill as methods without bodies", () => {
  // An iOS-only assembly in an Android build keeps its array in .bss.
  const linked = link(
    createElfFixture(createIl2cppBinaryFixture(), { zeroFilledTable: true }),
  );
  expect(linked.method_addresses).toEqual([
    ...expectedAddresses.slice(0, 3),
    expectedAddress("no-body"),
    expectedAddress("no-body"),
  ]);
});

it("reads a PE pointer array across file bytes and the declared zero-fill tail", () => {
  const bytes = createSplitPointerPeFixture();
  const original = Buffer.from(bytes);
  expect(link(bytes).method_addresses).toEqual(expectedAddresses);
  expect(bytes).toEqual(original);
  expect(failure(createSplitPointerPeFixture(false)).reason).toBe(
    "code-gen-modules-not-found",
  );
});

it("reports a method no image range claims as unknown, not as without a body", () => {
  // No type's method range holds this row, so no module slot describes it.
  const orphan = {
    ...metadata,
    methods: [...metadata.methods, { name: "Lost", declaring_type: -1 }],
  };
  const tokens = Uint32Array.from([...facts.methodTokens, 0x06000001]);
  const linked = linkIl2cppBinary(createIl2cppBinaryFixture(), orphan, {
    ...facts,
    methodTokens: tokens,
  });
  expect(linked.method_addresses).toEqual([
    ...expectedAddresses,
    expectedAddress("unknown"),
  ]);
});

it("finds an x86-64 module array through the instruction that loads it", () => {
  const inlined = createElfFixture(
    createIl2cppBinaryFixture({ codeRegistration: false, codeReference: true }),
    { machine: 62 },
  );
  const linked = link(inlined);
  expect(linked.code_gen_modules_field).toBeNull();
  expect(linked.code_gen_modules_array).toBe(FIXTURE_BINARY_BASE + 0x500n);
  expect(linked.method_addresses).toEqual(
    link(createElfFixture(createIl2cppBinaryFixture(), { machine: 62 }))
      .method_addresses,
  );
});

it.each([
  ["no instruction loads the array", { machine: 62 }, { codeReference: false }],
  ["the image is not x86-64", { machine: 183 }, { codeReference: true }],
] as const)("keeps code-registration-not-found when %s", (_, elf, binary) => {
  expect(
    failure(
      createElfFixture(
        createIl2cppBinaryFixture({ codeRegistration: false, ...binary }),
        elf,
      ),
    ).reason,
  ).toBe("code-registration-not-found");
});

it("refuses to choose among too many candidate module arrays", () => {
  const base = createIl2cppBinaryFixture({
    codeRegistration: false,
    codeReference: true,
  });
  // Copy the two-slot module array (16 bytes at 0x500) 80 times after the image.
  const copies = Buffer.concat(
    Array.from({ length: 80 }, () => base.subarray(0x500, 0x510)),
  );
  const crafted = Buffer.concat([base, copies]);
  crafted.writeBigUInt64LE(BigInt(crafted.length), 64);
  crafted.writeBigUInt64LE(BigInt(crafted.length), 80);
  // Mach-O is arm64 in the fixture; relabel it x86-64 so the fallback runs.
  crafted.writeUInt32LE(0x01000007, 4);
  crafted.writeUInt32LE(3, 8);
  expect(failure(crafted).reason).toBe("native-index-capacity");
});

it("retains overlapping fallback arrays when only the later window is referenced", () => {
  const bytes = createIl2cppBinaryFixture({
    codeRegistration: false,
    codeReference: true,
  });
  bytes.writeUInt32LE(0x01000007, 4);
  bytes.writeUInt32LE(3, 8);
  // [B, A, B] contains both [B, A] and [A, B]; code references only [A, B].
  bytes.writeBigUInt64LE(FIXTURE_BINARY_BASE + 0x440n, 0x500);
  bytes.writeBigUInt64LE(FIXTURE_BINARY_BASE + 0x400n, 0x508);
  bytes.writeBigUInt64LE(FIXTURE_BINARY_BASE + 0x440n, 0x510);
  bytes.writeInt32LE(0x508 - (0xc00 + 7), 0xc03);
  const linked = link(bytes);
  expect(linked.code_gen_modules_field).toBeNull();
  expect(linked.code_gen_modules_array).toBe(FIXTURE_BINARY_BASE + 0x508n);
  expect(linked.method_addresses).toEqual(expectedAddresses);
});

it("finds image names padded with 0xFF as MSVC writes them", () => {
  expect(link(createIl2cppBinaryFixture({ namePadding: 0xff }))).toEqual(
    link(createIl2cppBinaryFixture()),
  );
});

it("does not match a longer string merely because its suffix names an image", () => {
  const bytes = createIl2cppBinaryFixture({ namePrefix: "Mono." });
  const suffix = bytes.readBigUInt64LE(0x440);
  bytes.writeBigUInt64LE(suffix - 5n, 0x440); // The record actually names Mono.mscorlib.dll.
  expect(failure(bytes).reason).toBe("code-gen-modules-not-found");
});
it("accepts a module's declared pointer into a suffix-shared C string", () => {
  expect(
    link(createIl2cppBinaryFixture({ namePrefix: "Mono." })).method_addresses,
  ).toEqual(expectedAddresses);
});

it("links an ELF shared object after applying its RELATIVE relocations", () => {
  const elf = createElfFixture(createIl2cppBinaryFixture());
  const fromMacho = link(createIl2cppBinaryFixture());
  expect(link(elf)).toEqual({ ...fromMacho, format: "elf" });
});

it.each([
  [{ dynamic: false }, "unsupported-container"],
  [{ machine: 243 }, "unsupported-container"],
  [{ androidPacked: true }, "unsupported-pointer-encoding"],
] as const)(
  "refuses ELF relocations it cannot apply (%o)",
  (options, reason) => {
    expect(
      failure(createElfFixture(createIl2cppBinaryFixture(), options)),
    ).toEqual({
      reason,
      kind: "unsupported",
    });
  },
);

it.each([
  ["Assembly CSharp.dll", "mscorlib.dll"],
  ["程序集.dll", "mscorlib.dll"],
  ["shared.dll", "shared.dll"],
] as const)(
  "preserves module names and all candidate owners: %s / %s",
  (first, second) => {
    const imageNames = [first, second] as const;
    const selected = {
      ...metadata,
      images: metadata.images.map((image, index) => ({
        ...image,
        name: imageNames[index]!,
      })),
    };
    const linked = linkIl2cppBinary(
      createIl2cppBinaryFixture({ imageNames }),
      selected,
      facts,
    );
    expect(linked.method_addresses).toEqual(expectedAddresses);
  },
);

it("requires executable loader coverage before calling a mapped pointer code", () => {
  const bytes = createIl2cppBinaryFixture();
  bytes.writeUInt32LE(3, 92); // __TEXT is mapped read/write, with no execute permission.
  expect(failure(bytes).reason).toBe("invalid-method-pointer");
});

it("does not treat RIP-relative-looking data as executable registration evidence", () => {
  const bytes = createIl2cppBinaryFixture({
    codeRegistration: false,
    codeReference: true,
  });
  bytes.writeUInt32LE(0x01000007, 4);
  bytes.writeUInt32LE(3, 92);
  expect(failure(bytes).reason).toBe("code-registration-not-found");
});

it("yields throughout a large scan before reaching a later invalid method token", () => {
  const bytes = Buffer.alloc(16 * 1024 * 1024, 0xaa);
  createIl2cppBinaryFixture().copy(bytes);
  bytes.writeBigUInt64LE(BigInt(bytes.length), 64);
  bytes.writeBigUInt64LE(BigInt(bytes.length), 80);
  const steps = linkIl2cppBinarySteps(bytes, metadata, {
    ...facts,
    methodTokens: Uint32Array.from([0, ...facts.methodTokens.slice(1)]),
  });
  for (let index = 0; index < 200; index++)
    expect(steps.next().done).toBe(false);
  // Abandoning the cooperatively cancellable scan owns no external resources.
  steps.return(undefined as never);
});

it("rejects a recursive binary type graph without overflowing the JavaScript stack", () => {
  const bytes = createIl2cppBinaryFixture();
  bytes.writeBigUInt64LE(FIXTURE_BINARY_BASE + 0x980n, 0x980);
  expect(failure(bytes).reason).toBe("invalid-type");
});

it("guards a shared generic expansion before concatenating unchecked text", () => {
  const bytes = Buffer.alloc(0x4000);
  createIl2cppBinaryFixture().copy(bytes);
  bytes.writeBigUInt64LE(BigInt(bytes.length), 64);
  bytes.writeBigUInt64LE(BigInt(bytes.length), 80);
  let prior = FIXTURE_BINARY_BASE + 0x9b0n; // int
  for (let level = 0; level < 12; level++) {
    const at = 0x1000 + level * 96,
      address = FIXTURE_BINARY_BASE + BigInt(at);
    bytes.writeBigUInt64LE(address + 16n, at);
    bytes.writeUInt32LE(0x15 << 16, at + 8);
    bytes.writeBigUInt64LE(FIXTURE_BINARY_BASE + 0x9a0n, at + 16);
    bytes.writeBigUInt64LE(address + 32n, at + 24);
    bytes.writeUInt32LE(2, at + 32);
    bytes.writeBigUInt64LE(address + 48n, at + 40);
    bytes.writeBigUInt64LE(prior, at + 48);
    bytes.writeBigUInt64LE(prior, at + 56);
    prior = address;
  }
  bytes.writeBigUInt64LE(prior, 0x900);
  const stopped = new Error("type text admission");
  const steps = linkIl2cppBinarySteps(bytes, metadata, facts, undefined, {
    beforeText: (size) => {
      if (size > 1024) throw stopped;
    },
  });
  expect(() => {
    for (;;) {
      if (steps.next().done) break;
    }
  }).toThrow(stopped);
});

it("reports a symbol-relocated method slot as unknown rather than no-body", () => {
  const bytes = createElfFixture(createIl2cppBinaryFixture());
  const dynamic = Number(bytes.readBigUInt64LE(128));
  const relocationBytes = Number(bytes.readBigUInt64LE(dynamic + 24));
  for (let at = 0x1000; at < 0x1000 + relocationBytes; at += 24) {
    if (bytes.readBigUInt64LE(at) !== FIXTURE_BINARY_BASE + 0x300n) continue;
    bytes.writeBigUInt64LE((1n << 32n) | 1025n, at + 8); // unresolved symbol, not RELATIVE
  }
  const linked = link(bytes);
  expect(linked.method_addresses[1]).toEqual(expectedAddress("unknown"));
  expect(linked.method_addresses[0]).toEqual(expectedAddresses[0]);
});

it("reads a relative relocation into a zero-filled pointer array as a known value", () => {
  const bytes = createElfFixture(createIl2cppBinaryFixture(), {
    zeroFilledTable: true,
  });
  const dynamic = Number(bytes.readBigUInt64LE(128));
  const relocationBytes = Number(bytes.readBigUInt64LE(dynamic + 24));
  // Reuse the now-unused second module's file-backed first slot relocation.
  for (let at = 0x1000; at < 0x1000 + relocationBytes; at += 24) {
    if (bytes.readBigUInt64LE(at) === FIXTURE_BINARY_BASE + 0x318n)
      bytes.writeBigUInt64LE(FIXTURE_BINARY_BASE + BigInt(bytes.length), at);
  }
  expect(link(bytes).method_addresses).toEqual([
    ...expectedAddresses.slice(0, 4),
    expectedAddress("no-body"),
  ]);
});

it("refuses an ambiguous architecture instead of choosing the first FAT slice", () => {
  const bytes = createUniversalFixture([
    { cpu: 0x0100000c, bytes: createIl2cppBinaryFixture() },
    { cpu: 0x0100000c, bytes: createIl2cppBinaryFixture() },
  ]);
  expect(failure(bytes, "arm64").reason).toBe("ambiguous-slice-selection");
});
it("checks the observed slice header against the caller-selected FAT architecture", () => {
  const bytes = createUniversalFixture([
    { cpu: 0x01000007, bytes: createIl2cppBinaryFixture() },
  ]);
  expect(failure(bytes, "amd64").reason).toBe("malformed-container");
});
it("still validates version 27 type indices when rendered names are unavailable", () => {
  const decoded = readIl2cppMetadataForLinking(
    createIl2cppMetadataFixture({ version: 27 }).bytes,
  );
  const input = {
    ...decoded.link,
    returnTypes: Int32Array.from([999, ...decoded.link.returnTypes.slice(1)]),
  };
  expect(() =>
    linkIl2cppBinary(createIl2cppBinaryFixture(), decoded.metadata, input),
  ).toThrow("invalid-type");
});

it("reads type attributes without requiring file-backed alignment padding", () => {
  const bytes = createIl2cppBinaryFixture().subarray(0, 0xffc);
  bytes.writeBigUInt64LE(BigInt(bytes.length), 80);
  bytes.writeBigUInt64LE(FIXTURE_BINARY_BASE + 0xff0n, 0x900);
  bytes.writeBigUInt64LE(0n, 0xff0);
  bytes.writeUInt32LE(0x08 << 16, 0xff8);
  expect(link(bytes).return_types.map((row) => row.name)).toEqual(
    Array.from({ length: 5 }, () => "int"),
  );
});
