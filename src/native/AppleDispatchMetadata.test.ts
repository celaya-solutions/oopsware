import { describe, expect, it } from "vitest";
import { machoWithPropertyAttributes } from "../../tests/fixtures/objcPropertyMacho.js";
import { objcRecordBudgetMacho } from "../../tests/fixtures/objcRecordBudgetMacho.js";
import { decodeAppleDispatchMetadata } from "./AppleDispatchMetadata.js";

const base = 0x100000000n;
const fixture = (
  relative = false,
  category?: "partial-method" | "unmapped-pointer" | "unmapped-class",
) => {
  const bytes = Buffer.alloc(4096);
  const u32 = (offset: number, value: number) =>
    bytes.writeUInt32LE(value, offset);
  const ptr = (offset: number, target: number) =>
    bytes.writeBigUInt64LE(base + BigInt(target), offset);
  u32(0, 0xfeedfacf);
  u32(4, 0x0100000c);
  u32(16, 1);
  u32(20, category === undefined ? 152 : 232);
  u32(32, 0x19);
  u32(36, category === undefined ? 152 : 232);
  bytes.write("__DATA", 40);
  ptr(56, 0);
  bytes.writeBigUInt64LE(4096n, 64);
  bytes.writeBigUInt64LE(4096n, 80);
  u32(92, 5);
  u32(96, category === undefined ? 1 : 2);
  bytes.write("__objc_classlist", 104);
  bytes.write("__DATA", 120);
  ptr(136, 0x180);
  bytes.writeBigUInt64LE(8n, 144);
  if (category !== undefined) {
    bytes.write("__objc_catlist", 184);
    bytes.write("__DATA", 200);
    ptr(216, 0xb00);
    bytes.writeBigUInt64LE(8n, 224);
    u32(232, 0xb00);
  }
  u32(152, 0x180);
  ptr(0x180, 0x200);
  ptr(0x200, 0x280);
  ptr(0x220, 0x300);
  ptr(0x2a0, 0x380);
  u32(0x308, 16);
  ptr(0x318, 0x450);
  ptr(0x320, 0x480);
  ptr(0x330, 0x500);
  ptr(0x328, 0x700);
  ptr(0x340, 0x600);
  u32(0x380, 1);
  ptr(0x398, 0x450);
  bytes.write("Fixture\0", 0x450);
  bytes.write("performAction:\0", 0x460);
  u32(0x480, relative ? 0xc000000c : 24);
  u32(0x484, 1);
  if (relative) {
    bytes.writeInt32LE(0x460 - 0x488, 0x488);
    bytes.writeInt32LE(0x5c0 - 0x48c, 0x48c);
    bytes.writeInt32LE(0x700 - 0x490, 0x490);
  } else {
    ptr(0x488, 0x460);
    ptr(0x490, 0x5c0);
    ptr(0x498, 0x700);
  }
  u32(0x500, 32);
  u32(0x504, 1);
  ptr(0x508, 0x580);
  ptr(0x510, 0x5a0);
  ptr(0x518, 0x5c0);
  u32(0x580, 8);
  bytes.write("state\0", 0x5a0);
  bytes.write("i\0", 0x5c0);
  u32(0x600, 16);
  u32(0x604, 3);
  ptr(0x608, 0x640);
  ptr(0x610, 0x650);
  ptr(0x618, 0x660);
  ptr(0x620, 0x670);
  ptr(0x628, 0x680);
  ptr(0x630, 0x690);
  bytes.write("atomicValue\0", 0x640);
  bytes.write("Tq\0", 0x650);
  bytes.write("nonatomicValue\0", 0x660);
  bytes.write("Tq,N\0", 0x670);
  bytes.write("unknownValue\0", 0x680);
  bytes.writeBigUInt64LE(1n, 0x700);
  ptr(0x708, 0x740);
  ptr(0x748, 0x900);
  ptr(0x758, 0x800);
  ptr(0x768, 0x840);
  u32(0x780, 72);
  u32(0x800, 24);
  u32(0x804, 1);
  ptr(0x808, 0x920);
  u32(0x840, 24);
  u32(0x844, 1);
  ptr(0x848, 0x940);
  bytes.write("FixtureProtocol\0", 0x900);
  bytes.write("requiredAction:\0", 0x920);
  bytes.write("optionalAction:\0", 0x940);
  if (category !== undefined) {
    if (category === "unmapped-pointer") {
      bytes.writeBigUInt64LE(0xffffffffffffffffn, 0xb00);
    } else {
      ptr(0xb00, 0xb40);
      ptr(0xb40, 0xbc0);
      if (category === "unmapped-class") ptr(0xb48, 0x5000);
      else ptr(0xb48, 0x200);
      ptr(0xb50, 0xb80);
      u32(0xb80, 24);
      u32(0xb84, 1);
      ptr(0xb88, 0x460);
      ptr(0xb90, 0x5c0);
      if (category === "unmapped-class") ptr(0xb98, 0x700);
      else bytes.writeBigUInt64LE(0xffffffffffffffffn, 0xb98);
      bytes.write("FixtureCategory\0", 0xbc0);
    }
  }
  return bytes;
};
const provenance = { path: "/fixture/app", sha256: "a".repeat(64) };

const withProtocolListSection = (bytes: Buffer): Buffer => {
  const pointer = (at: number, offset: number) =>
    bytes.writeBigUInt64LE(base + BigInt(offset), at);
  bytes.writeUInt32LE(232, 20);
  bytes.writeUInt32LE(232, 36);
  bytes.writeUInt32LE(2, 96);
  bytes.write("__objc_protolist", 184);
  bytes.write("__DATA", 200);
  pointer(216, 0x6c0);
  bytes.writeBigUInt64LE(8n, 224);
  pointer(0x6c0, 0x740);
  return bytes;
};

const partialSiblingsFixture = (
  options: {
    readonly emptyMiddleClass?: boolean;
  } = {},
) => {
  const bytes = Buffer.alloc(4096);
  const imageBase = 0x100000000n;
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(0x0100000c, 4);
  bytes.writeUInt32LE(2, 12);
  bytes.writeUInt32LE(1, 16);
  bytes.writeUInt32LE(232, 20);
  bytes.writeUInt32LE(0x19, 32);
  bytes.writeUInt32LE(232, 36);
  bytes.write("__DATA", 40);
  bytes.writeBigUInt64LE(imageBase, 56);
  bytes.writeBigUInt64LE(4096n, 64);
  bytes.writeBigUInt64LE(4096n, 80);
  bytes.writeUInt32LE(5, 92);
  bytes.writeUInt32LE(2, 96);
  bytes.write("__objc_classlist", 104);
  bytes.writeBigUInt64LE(imageBase + 0x200n, 136);
  bytes.writeBigUInt64LE(24n, 144);
  bytes.write("__objc_protolist", 184);
  bytes.writeBigUInt64LE(imageBase + 0x300n, 216);
  bytes.writeBigUInt64LE(8n, 224);
  for (const [slot, record, ro, name] of [
    [0x200, 0x400, 0x500, 0x600],
    [0x208, 0x440, 0x540, 0x620],
    [0x210, 0x480, 0x580, 0x640],
  ] as const) {
    bytes.writeBigUInt64LE(imageBase + BigInt(record), slot);
    bytes.writeBigUInt64LE(imageBase + BigInt(ro), record + 32);
    bytes.writeUInt32LE(2, ro);
    bytes.writeUInt32LE(16, ro + 8);
    bytes.writeBigUInt64LE(imageBase + BigInt(name), ro + 24);
  }
  bytes.write("KeptClass\0", 0x600);
  if (!options.emptyMiddleClass) bytes.write("OtherClass\0", 0x620);
  bytes.write("LaterClass\0", 0x640);
  return bytes;
};

describe("Apple dispatch pointer fixup metadata", () => {
  it.each([
    { name: "unsupported opcode", operand: [0xd0] },
    {
      name: "oversized addend whose tail resembles DO_BIND",
      operand: [0x60, ...Array<number>(10).fill(0x80), 0x90, 0x00],
    },
  ])(
    "keeps decoded bindings when an independent stream has $name",
    ({ operand }) => {
      const bytes = fixture();
      bytes.writeUInt32LE(2, 16);
      bytes.writeUInt32LE(200, 20);
      bytes.writeUInt32LE(0x80000022, 184);
      bytes.writeUInt32LE(48, 188);
      const bindings = Buffer.from([
        0x40,
        ...Buffer.from("_OBJC_CLASS_$_NSObject\0"),
        0x70,
        0x88,
        0x04,
        0x90,
        0x00,
      ]);
      bindings.copy(bytes, 0xc00);
      const invalid = Buffer.from([...bindings.subarray(0, -2), ...operand]);
      invalid.copy(bytes, 0xc80);
      bytes.writeUInt32LE(0xc00, 200);
      bytes.writeUInt32LE(bindings.length, 204);
      bytes.writeUInt32LE(0xc80, 208);
      bytes.writeUInt32LE(invalid.length, 212);

      const result = decodeAppleDispatchMetadata(bytes, 100, provenance);
      expect(result.objc_classes[0]).toMatchObject({
        name: "Fixture",
        super_class: "NSObject",
      });
      expect(
        result.coverage.find(({ facet }) => facet === "pointer_fixups"),
      ).toMatchObject({ status: "partial", examined: 2, decoded: 1 });
    },
  );

  it("keeps absolute metadata pointers between declared chained fixups", () => {
    const bytes = fixture();
    bytes.writeUInt32LE(2, 16);
    bytes.writeUInt32LE(168, 20);
    bytes.writeUInt32LE(0x80000034, 184);
    bytes.writeUInt32LE(16, 188);
    bytes.writeUInt32LE(0xa00, 192);
    bytes.writeUInt32LE(64, 196);
    // Only the class-list pointer needs rebasing. All remaining metadata
    // pointers carry their stored absolute values, outside the single chain.
    bytes.writeBigUInt64LE(0x200n, 0x180);
    bytes.writeUInt32LE(28, 0xa04);
    bytes.writeUInt32LE(60, 0xa08);
    bytes.writeUInt32LE(60, 0xa0c);
    bytes.writeUInt32LE(1, 0xa14);
    bytes.writeUInt32LE(1, 0xa1c);
    bytes.writeUInt32LE(8, 0xa20);
    bytes.writeUInt32LE(24, 0xa24);
    bytes.writeUInt16LE(0x1000, 0xa28);
    bytes.writeUInt16LE(6, 0xa2a);
    bytes.writeUInt16LE(1, 0xa38);
    bytes.writeUInt16LE(0x180, 0xa3a);
    const result = decodeAppleDispatchMetadata(bytes, 100, provenance);
    expect(result.objc_classes[0]).toMatchObject({ name: "Fixture" });
    expect(result.objc_dispatch_implementations[0]).toMatchObject({
      selector: "performAction:",
      implementation_address: "0x100000700",
    });
    expect(
      result.coverage.find(({ facet }) => facet === "pointer_fixups"),
    ).toMatchObject({ status: "complete", examined: 1, decoded: 1 });
  });
});
describe("Apple dispatch binary metadata", () => {
  it.each([false, true])(
    "decodes stripped absolute/relative method lists (relative=%s) with exact offsets",
    (relative) => {
      const result = decodeAppleDispatchMetadata(
        fixture(relative),
        100,
        provenance,
      );
      expect(result.objc_classes).toMatchObject([
        {
          name: "Fixture",
          instance_size: 16,
          location: { address: "0x100000200", file_offset: 512 },
        },
        { name: "Fixture", is_meta_class: true },
      ]);
      expect(result.objc_dispatch_implementations).toMatchObject([
        {
          selector: "performAction:",
          implementation_address: "0x100000700",
          location: { file_offset: 0x488 },
          decode: { status: "decoded" },
        },
      ]);
      expect(result.objc_ivars).toMatchObject([
        {
          name: "state",
          type_encoding: "i",
          offset: 8,
          location: { file_offset: 0x508 },
        },
      ]);
      expect(result.objc_classes[0]?.properties).toEqual([
        {
          name: "atomicValue",
          type_encoding: "q",
          attributes: [{ name: "T", value: "q" }],
          atomicity: "atomic",
          is_readonly: false,
          getter: null,
          setter: null,
        },
        {
          name: "nonatomicValue",
          type_encoding: "q",
          attributes: [
            { name: "T", value: "q" },
            { name: "N", value: "" },
          ],
          atomicity: "nonatomic",
          is_readonly: false,
          getter: null,
          setter: null,
        },
        {
          name: "unknownValue",
          type_encoding: null,
          attributes: [],
          atomicity: null,
          is_readonly: null,
          getter: null,
          setter: null,
        },
      ]);
      expect(result.objc_classes[0]).toMatchObject({
        is_meta_class: false,
        is_root_class: false,
        ivar_count: 1,
      });
      expect(result.objc_classes[1]).toMatchObject({
        is_meta_class: true,
        is_root_class: false,
        ivar_count: null,
      });
      expect(result.objc_classes[0]?.methods[0]).toMatchObject({
        is_required: null,
        is_optional: null,
      });
      expect(result.objc_protocols[0]).toMatchObject({
        name: "FixtureProtocol",
        methods: [
          {
            selector: "requiredAction:",
            is_required: true,
            is_optional: false,
          },
        ],
        optional_methods: [
          {
            selector: "optionalAction:",
            is_required: false,
            is_optional: true,
          },
        ],
      });
    },
  );

  it.each([
    [0xffffffff, 8],
    [3, 8],
    [0xfffffffe, null],
  ])("decodes ivar alignment raw value %i as %s", (raw, alignment) => {
    const bytes = fixture();
    bytes.writeUInt32LE(raw, 0x520);
    const result = decodeAppleDispatchMetadata(bytes, 100, provenance);
    expect(result.objc_ivars).toMatchObject([
      { name: "state", alignment, decode: { status: "decoded" } },
    ]);
  });
});

describe("Apple dispatch coverage ownership", () => {
  it("keeps unsupported pointers and record truncation explicit", () => {
    const bytes = fixture();
    bytes.writeBigUInt64LE(0xffffffffffffffffn, 0x498);
    const result = decodeAppleDispatchMetadata(bytes, 100, provenance);
    expect(result.objc_dispatch_implementations[0]).toMatchObject({
      implementation_address: null,
      decode: { status: "partial" },
    });
    expect(
      result.coverage.find(
        ({ facet }) => facet === "objc_class_method_ivar_metadata",
      ),
    ).toMatchObject({
      status: "partial",
      reason: expect.stringContaining("method Fixture instance performAction:"),
    });
    const truncated = decodeAppleDispatchMetadata(fixture(), 1, provenance);
    expect(truncated.coverage[0]?.reason).toContain("max_records_reached");
    expect(
      truncated.coverage.find(
        ({ facet }) => facet === "objc_properties_categories",
      ),
    ).toMatchObject({ status: "partial", reason: "max_records_reached" });
  });
  it("keeps partial category methods in category coverage only", () => {
    const baseline = decodeAppleDispatchMetadata(fixture(), 100, provenance);
    const result = decodeAppleDispatchMetadata(
      fixture(false, "partial-method"),
      100,
      provenance,
    );

    expect(result.objc_dispatch_implementations).toContainEqual(
      expect.objectContaining({
        category: "FixtureCategory",
        decode: {
          status: "partial",
          reason: "implementation_pointer_unmapped_or_encoded",
        },
      }),
    );
    const baselineClassCoverage = baseline.coverage.find(
      ({ facet }) => facet === "objc_class_method_ivar_metadata",
    );
    const classCoverage = result.coverage.find(
      ({ facet }) => facet === "objc_class_method_ivar_metadata",
    );
    expect(baselineClassCoverage).toBeDefined();
    expect(classCoverage).toEqual(baselineClassCoverage);
    expect(
      result.coverage.find(
        ({ facet }) => facet === "objc_properties_categories",
      ),
    ).toMatchObject({
      status: "partial",
      reason: expect.stringContaining("category method FixtureCategory"),
    });
  });
  it("keeps a category whose class reference is unmapped", () => {
    const result = decodeAppleDispatchMetadata(
      fixture(false, "unmapped-class"),
      100,
      provenance,
    );
    expect(result.objc_categories).toMatchObject([
      {
        name: "FixtureCategory",
        class_name: null,
        class_source: "unresolved",
        decode: { status: "partial", reason: "category_class_unresolved" },
      },
    ]);
    expect(result.objc_categories[0]?.instance_methods).toHaveLength(1);
    expect(result.objc_dispatch_implementations).toContainEqual(
      expect.objectContaining({
        category: "FixtureCategory",
        class_name: "(FixtureCategory)",
        implementation_address: "0x100000700",
      }),
    );
    expect(
      result.coverage.find(
        ({ facet }) => facet === "objc_properties_categories",
      ),
    ).toMatchObject({
      status: "partial",
      reason: expect.stringContaining(
        "category_class_unresolved at 0x100000b48: Category FixtureCategory class reference 0x100005000",
      ),
    });
  });
  it("keeps malformed category pointers out of class failure coverage", () => {
    const baseline = decodeAppleDispatchMetadata(fixture(), 100, provenance);
    const result = decodeAppleDispatchMetadata(
      fixture(false, "unmapped-pointer"),
      100,
      provenance,
    );
    const baselineClassCoverage = baseline.coverage.find(
      ({ facet }) => facet === "objc_class_method_ivar_metadata",
    );
    const classCoverage = result.coverage.find(
      ({ facet }) => facet === "objc_class_method_ivar_metadata",
    );
    expect(baselineClassCoverage).toBeDefined();
    expect(classCoverage).toEqual(baselineClassCoverage);
    expect(
      result.coverage.find(
        ({ facet }) => facet === "objc_properties_categories",
      ),
    ).toMatchObject({
      status: "partial",
      reason: expect.stringContaining("category_decode_failed"),
    });
  });
});

describe("Objective-C declaration-local record-budget coverage", () => {
  it.each(["protocol", "class"] as const)(
    "preserves the decoded $0 method at a sufficient budget",
    (owner) => {
      const result = decodeAppleDispatchMetadata(
        objcRecordBudgetMacho(owner),
        100,
        provenance,
      );
      if (owner === "protocol")
        expect(result.objc_protocol_records).toMatchObject([
          {
            name: "FixtureProtocol",
            methods: [{ selector: "protocolMethod" }],
            decode: { status: "decoded", reason: null },
          },
        ]);
      else
        expect(result.objc_classes).toMatchObject([
          {
            name: "FixtureClass",
            methods: [{ selector: "classMethod", method_type: "instance" }],
            decode: { status: "decoded", reason: null },
          },
        ]);
    },
  );

  it("marks an omitted protocol method list partial while preserving known emptiness", () => {
    const truncated = decodeAppleDispatchMetadata(
      withProtocolListSection(fixture()),
      1,
      provenance,
    );
    expect(truncated.objc_protocol_records).toMatchObject([
      {
        name: "FixtureProtocol",
        methods: [],
        decode: { status: "partial", reason: "max_records_reached" },
      },
    ]);

    const emptyBytes = withProtocolListSection(fixture());
    emptyBytes.writeBigUInt64LE(0n, 0x758);
    emptyBytes.writeBigUInt64LE(0n, 0x768);
    const empty = decodeAppleDispatchMetadata(emptyBytes, 1, provenance);
    expect(empty.objc_protocol_records).toMatchObject([
      {
        name: "FixtureProtocol",
        methods: [],
        optional_methods: [],
        decode: { status: "decoded", reason: null },
      },
    ]);
  });

  it("marks omitted class methods, ivars, properties, and adopted protocols partial", () => {
    const methodBytes = fixture();
    methodBytes.writeUInt32LE(2, 0x300);
    methodBytes.writeBigUInt64LE(0n, 0x330);
    methodBytes.writeBigUInt64LE(0n, 0x340);
    const methodLimited = decodeAppleDispatchMetadata(
      methodBytes,
      1,
      provenance,
    );
    expect(methodLimited.objc_classes[0]).toMatchObject({
      name: "Fixture",
      methods: [],
      decode: { status: "partial", reason: "max_records_reached" },
    });

    const ivarBytes = fixture();
    ivarBytes.writeBigUInt64LE(0n, 0x320);
    ivarBytes.writeBigUInt64LE(0n, 0x328);
    ivarBytes.writeBigUInt64LE(0n, 0x340);
    ivarBytes.writeUInt32LE(2, 0x300);
    const ivarsLimited = decodeAppleDispatchMetadata(ivarBytes, 1, provenance);
    expect(ivarsLimited.objc_classes[0]).toMatchObject({
      name: "Fixture",
      ivar_count: 1,
      decode: { status: "partial", reason: "max_records_reached" },
    });
    expect(ivarsLimited.objc_ivars).toEqual([]);

    const propertyBytes = fixture();
    propertyBytes.writeBigUInt64LE(0n, 0x320);
    propertyBytes.writeBigUInt64LE(0n, 0x328);
    propertyBytes.writeBigUInt64LE(0n, 0x330);
    propertyBytes.writeUInt32LE(2, 0x300);
    const propertiesLimited = decodeAppleDispatchMetadata(
      propertyBytes,
      1,
      provenance,
    );
    expect(propertiesLimited.objc_classes[0]).toMatchObject({
      name: "Fixture",
      properties: [],
      decode: { status: "partial", reason: "max_records_reached" },
    });

    const adoptedBytes = fixture();
    adoptedBytes.writeBigUInt64LE(0n, 0x320);
    adoptedBytes.writeBigUInt64LE(0n, 0x330);
    adoptedBytes.writeBigUInt64LE(0n, 0x340);
    adoptedBytes.writeUInt32LE(2, 0x300);
    const adoptedLimited = decodeAppleDispatchMetadata(
      adoptedBytes,
      1,
      provenance,
    );
    expect(adoptedLimited.objc_classes[0]).toMatchObject({
      name: "Fixture",
      protocols: [],
      decode: { status: "partial", reason: "max_records_reached" },
    });
  });

  it("keeps genuinely empty class method lists decoded at the record limit", () => {
    const bytes = fixture();
    bytes.writeBigUInt64LE(0n, 0x320);
    bytes.writeBigUInt64LE(0n, 0x328);
    bytes.writeBigUInt64LE(0n, 0x330);
    bytes.writeBigUInt64LE(0n, 0x340);
    bytes.writeUInt32LE(2, 0x300);
    const result = decodeAppleDispatchMetadata(bytes, 1, provenance);
    expect(result.objc_classes[0]).toMatchObject({
      name: "Fixture",
      methods: [],
      decode: { status: "decoded", reason: null },
    });
  });
});

describe("Objective-C category-local record-budget coverage", () => {
  it.each(["instance", "class"] as const)(
    "marks category %s methods partial only when a declared entry is omitted",
    (methodType) => {
      const bytes = fixture(false, "partial-method");
      const listField = methodType === "instance" ? 0xb50 : 0xb58;
      const methodList = bytes.readBigUInt64LE(0xb50);
      bytes.writeBigUInt64LE(0n, 0xb50);
      bytes.writeBigUInt64LE(methodList, listField);
      bytes.writeUInt32LE(2, 0x300);
      bytes.writeBigUInt64LE(0n, 0x320);
      const truncated = decodeAppleDispatchMetadata(bytes, 11, provenance);
      expect(truncated.objc_categories).toMatchObject([
        {
          name: "FixtureCategory",
          [`${methodType}_methods`]: [],
          decode: { status: "partial", reason: "max_records_reached" },
        },
      ]);

      bytes.writeBigUInt64LE(0n, listField);
      const empty = decodeAppleDispatchMetadata(bytes, 11, provenance);
      expect(empty.objc_categories).toMatchObject([
        {
          name: "FixtureCategory",
          [`${methodType}_methods`]: [],
          decode: { status: "decoded", reason: null },
        },
      ]);
    },
  );
});

describe("malformed Objective-C property records", () => {
  it.each([
    ["an unmapped name", { secondNameOffset: 0x2000 }, "first", "0x100000518"],
    ["an empty name", { firstName: "" }, "second", "0x100000508"],
  ] as const)(
    "retains the valid sibling of a property with %s",
    (_, layout, kept, location) => {
      const result = decodeAppleDispatchMetadata(
        machoWithPropertyAttributes("Tq,N", layout),
        100,
        provenance,
      );
      expect(
        result.objc_classes.map(({ name, properties }) => ({
          name,
          properties: properties.map((property) => property.name),
        })),
      ).toEqual([{ name: "Fixture", properties: [kept] }]);
      expect(
        result.coverage.find(
          ({ facet }) => facet === "objc_properties_categories",
        ),
      ).toMatchObject({
        status: "partial",
        reason: expect.stringContaining(
          `property_decode_failed at ${location}: Fixture: property`,
        ),
      });
    },
  );
});

describe("Objective-C malformed identity recovery", () => {
  it.each(["class selector", "category name"] as const)(
    "isolates an empty %s before result validation",
    (malformed) => {
      const bytes = fixture(false, "unmapped-class");
      bytes[malformed === "class selector" ? 0x460 : 0xbc0] = 0;
      const result = decodeAppleDispatchMetadata(bytes, 100, provenance);
      expect(result.objc_categories).toEqual([]);
      if (malformed === "category name") {
        expect(result.objc_classes).toHaveLength(2);
        expect(result.objc_protocols).toMatchObject([
          { name: "FixtureProtocol" },
        ]);
      }
      expect(
        result.coverage.find(
          ({ facet }) => facet === "objc_properties_categories",
        ),
      ).toMatchObject({
        status: "partial",
        reason: expect.stringContaining(
          malformed === "class selector" ? "empty selector" : "empty name",
        ),
      });
    },
  );

  it("keeps an unresolved superclass address when its class name is empty", () => {
    const bytes = fixture();
    bytes.writeBigUInt64LE(base + 0xc00n, 0x208);
    bytes.writeBigUInt64LE(base + 0xc40n, 0xc20);
    bytes.writeBigUInt64LE(base + 0xc80n, 0xc58);
    const result = decodeAppleDispatchMetadata(bytes, 100, provenance);
    expect(result.objc_classes[0]).toMatchObject({
      name: "Fixture",
      super_class: null,
    });
    expect(
      result.coverage.find(
        ({ facet }) => facet === "objc_class_method_ivar_metadata",
      ),
    ).toMatchObject({
      status: "partial",
      reason: expect.stringContaining("Superclass pointer 0x100000c00"),
    });
  });

  it("keeps a category whose local owner has an empty name", () => {
    const bytes = fixture(false, "unmapped-class");
    bytes.writeBigUInt64LE(base + 0xc00n, 0xb48);
    bytes.writeBigUInt64LE(base + 0xc40n, 0xc20);
    bytes.writeBigUInt64LE(base + 0xc80n, 0xc58);
    const result = decodeAppleDispatchMetadata(bytes, 100, provenance);
    expect(result.objc_classes.map(({ name }) => name)).toEqual([
      "Fixture",
      "Fixture",
    ]);
    expect(result.objc_categories).toMatchObject([
      {
        name: "FixtureCategory",
        class_name: null,
        class_source: "unresolved",
        instance_methods: ["performAction:"],
        decode: { status: "partial", reason: "category_class_unresolved" },
      },
    ]);
    expect(result.objc_dispatch_implementations).toContainEqual(
      expect.objectContaining({
        category: "FixtureCategory",
        class_name: "(FixtureCategory)",
        selector: "performAction:",
        implementation_address: "0x100000700",
      }),
    );
    expect(
      result.coverage.find(
        ({ facet }) => facet === "objc_properties_categories",
      ),
    ).toMatchObject({
      status: "partial",
      reason: expect.stringContaining("empty name"),
    });
  });

  it.each([0x920, 0x940])(
    "isolates an empty protocol selector at %i while keeping adopted declarations and classes",
    (selector) => {
      const bytes = fixture();
      bytes[selector] = 0;
      // Decode the independent adopted declaration before the malformed parent.
      bytes.writeBigUInt64LE(base + 0xa00n, 0x750);
      bytes.writeBigUInt64LE(1n, 0xa00);
      bytes.writeBigUInt64LE(base + 0xa40n, 0xa08);
      bytes.writeBigUInt64LE(base + 0xac0n, 0xa48);
      bytes.writeUInt32LE(72, 0xa80);
      bytes.write("AdoptedProtocol\0", 0xac0);
      const result = decodeAppleDispatchMetadata(bytes, 100, provenance);
      expect(result.objc_classes.map(({ name }) => name)).toEqual([
        "Fixture",
        "Fixture",
      ]);
      expect(result.objc_protocols.map(({ name }) => name)).toEqual([
        "AdoptedProtocol",
        "FixtureProtocol",
      ]);
      expect(result.objc_protocol_records.map(({ name }) => name)).toEqual([
        "AdoptedProtocol",
        "FixtureProtocol",
      ]);
      expect(result.objc_protocol_records[1]).toMatchObject({
        adopted_protocols: ["AdoptedProtocol"],
        methods: selector === 0x920 ? [] : [{ selector: "requiredAction:" }],
        optional_methods:
          selector === 0x940 ? [] : [{ selector: "optionalAction:" }],
        decode: { status: "partial", reason: "protocol_method_selector_empty" },
      });
      expect(
        result.coverage.find(
          ({ facet }) => facet === "objc_class_method_ivar_metadata",
        ),
      ).toMatchObject({
        status: "partial",
        reason: expect.stringContaining("empty selector"),
      });
    },
  );
});

describe("malformed Apple dispatch metadata", () => {
  it("retains valid class siblings when one class has an empty ivar name", () => {
    const bytes = partialSiblingsFixture();
    bytes.writeBigUInt64LE(base + 0x700n, 0x570);
    bytes.writeUInt32LE(32, 0x700);
    bytes.writeUInt32LE(1, 0x704);
    bytes.writeBigUInt64LE(base + 0x800n, 0x708);
    bytes.writeBigUInt64LE(base + 0x820n, 0x710);
    bytes.writeBigUInt64LE(base + 0x840n, 0x718);
    bytes.write("i\0", 0x840);
    const result = decodeAppleDispatchMetadata(bytes, 100, provenance);
    expect(result.objc_classes.map(({ name }) => name)).toEqual([
      "KeptClass",
      "LaterClass",
    ]);
    expect(result.objc_ivars).toEqual([]);
    expect(
      result.coverage.find(
        ({ facet }) => facet === "objc_class_method_ivar_metadata",
      ),
    ).toMatchObject({
      status: "partial",
      reason: expect.stringContaining("empty name"),
    });
  });

  it("retains valid class siblings when one class has an empty name", () => {
    const result = decodeAppleDispatchMetadata(
      partialSiblingsFixture({ emptyMiddleClass: true }),
      100,
      provenance,
    );
    expect(result.objc_classes.map(({ name }) => name)).toEqual([
      "KeptClass",
      "LaterClass",
    ]);
    expect(
      result.coverage.find(
        ({ facet }) => facet === "objc_class_method_ivar_metadata",
      ),
    ).toMatchObject({ status: "partial", examined: 3 });
  });

  it("retains valid Swift class vtable siblings when one descriptor has an empty class name", () => {
    const bytes = Buffer.alloc(4096);
    const base = 0x100000000n;
    const u32 = (at: number, n: number) => bytes.writeUInt32LE(n, at);
    const ptr = (at: number, n: number) =>
      bytes.writeBigUInt64LE(base + BigInt(n), at);
    const rel = (at: number, n: number) => bytes.writeInt32LE(n - at, at);
    u32(0, 0xfeedfacf);
    u32(4, 0x0100000c);
    u32(12, 2);
    u32(16, 1);
    u32(20, 152);
    u32(32, 0x19);
    u32(36, 152);
    bytes.write("__TEXT", 40);
    ptr(56, 0);
    bytes.writeBigUInt64LE(4096n, 64);
    bytes.writeBigUInt64LE(4096n, 80);
    u32(88, 5);
    u32(92, 5);
    u32(96, 1);
    bytes.write("__swift5_types", 104);
    bytes.write("__TEXT", 120);
    ptr(136, 0x200);
    bytes.writeBigUInt64LE(12n, 144);
    u32(152, 0x200);
    const entries: readonly (readonly [number, number, number, number])[] = [
      [0x200, 0x300, 0x500, 0x800],
      [0x204, 0x380, 0x520, 0x810],
      [0x208, 0x400, 0x540, 0x820],
    ];
    for (const [field, descriptor, name, implementation] of entries) {
      rel(field, descriptor);
      u32(descriptor, 0x80000010);
      rel(descriptor + 8, name);
      u32(descriptor + 28, 1);
      u32(descriptor + 44, 0);
      u32(descriptor + 48, 1);
      u32(descriptor + 52, 0);
      rel(descriptor + 56, implementation);
    }
    bytes.write("EarlierClass\0", 0x500);
    bytes.write("LaterClass\0", 0x540);

    const result = decodeAppleDispatchMetadata(bytes, 100, provenance);
    expect(result.swift_dispatch_slots.map(({ owner }) => owner)).toEqual([
      "EarlierClass",
      "LaterClass",
    ]);
    const coverage = result.coverage.find(
      ({ facet }) => facet === "swift_class_vtable_descriptors",
    );
    expect(coverage).toMatchObject({ status: "partial", examined: 3 });
  });

  it("rejects malformed command and section boundaries", () => {
    const bytes = fixture();
    bytes.writeUInt32LE(7, 36);
    expect(() => decodeAppleDispatchMetadata(bytes, 100, provenance)).toThrow(
      "command size",
    );
    expect(() =>
      decodeAppleDispatchMetadata(Buffer.alloc(10), 100, provenance),
    ).toThrow("Truncated");
  });
});

describe("universal Apple dispatch metadata", () => {
  it.each([false, true])("decodes selected FAT slices (fat64=%s)", (fat64) => {
    const thin = fixture();
    const offset = 256;
    const bytes = Buffer.alloc(offset + thin.length);
    bytes.writeUInt32BE(fat64 ? 0xcafebabf : 0xcafebabe, 0);
    bytes.writeUInt32BE(1, 4);
    bytes.writeUInt32BE(0x0100000c, 8);
    if (fat64) {
      bytes.writeBigUInt64BE(BigInt(offset), 16);
      bytes.writeBigUInt64BE(BigInt(thin.length), 24);
    } else {
      bytes.writeUInt32BE(offset, 16);
      bytes.writeUInt32BE(thin.length, 20);
    }
    thin.copy(bytes, offset);
    const result = decodeAppleDispatchMetadata(bytes, 100, provenance);
    expect(result.objc_classes[0]).toMatchObject({
      name: "Fixture",
      location: { address: "0x100000200", file_offset: offset + 512 },
    });
    expect(result.objc_dispatch_implementations[0]).toMatchObject({
      implementation_address: "0x100000700",
      location: { file_offset: offset + 0x488 },
    });
  });
});

describe("FAT64 dispatch slice validation", () => {
  const wrapped = () => {
    const thin = fixture();
    const bytes = Buffer.alloc(256 + thin.length);
    bytes.writeUInt32BE(0xcafebabf, 0);
    bytes.writeUInt32BE(1, 4);
    bytes.writeUInt32BE(0x0100000c, 8);
    bytes.writeBigUInt64BE(256n, 16);
    bytes.writeBigUInt64BE(BigInt(thin.length), 24);
    thin.copy(bytes, 256);
    return bytes;
  };

  it("rejects a truncated architecture table", () => {
    expect(() =>
      decodeAppleDispatchMetadata(wrapped().subarray(0, 32), 100, provenance),
    ).toThrow("Malformed FAT architecture table");
  });

  it.each([16, 24])(
    "checks the full 64-bit slice extent at field %i",
    (field) => {
      const bytes = wrapped();
      bytes.writeBigUInt64BE(0x100000000n, field);
      expect(() => decodeAppleDispatchMetadata(bytes, 100, provenance)).toThrow(
        "FAT architecture 0 slice range extends beyond the file",
      );
    },
  );

  it("rejects ambiguous matching architectures", () => {
    const bytes = wrapped();
    bytes.writeUInt32BE(2, 4);
    bytes.copy(bytes, 40, 8, 40);
    expect(() => decodeAppleDispatchMetadata(bytes, 100, provenance)).toThrow(
      "Ambiguous FAT architecture slice",
    );
  });

  it("rejects a missing selected architecture", () => {
    expect(() =>
      decodeAppleDispatchMetadata(wrapped(), 100, provenance, "x86_64"),
    ).toThrow("Requested FAT architecture is absent");
  });
});

describe("byte-swapped universal Apple dispatch metadata", () => {
  const wrapped = (fat64: boolean) => {
    const thin = fixture();
    const offset = 256;
    const bytes = Buffer.alloc(offset + thin.length);
    bytes.writeUInt32LE(fat64 ? 0xcafebabf : 0xcafebabe, 0);
    bytes.writeUInt32LE(1, 4);
    bytes.writeUInt32LE(0x0100000c, 8);
    if (fat64) {
      bytes.writeBigUInt64LE(BigInt(offset), 16);
      bytes.writeBigUInt64LE(BigInt(thin.length), 24);
    } else {
      bytes.writeUInt32LE(offset, 16);
      bytes.writeUInt32LE(thin.length, 20);
    }
    thin.copy(bytes, offset);
    return bytes;
  };

  it.each([false, true])(
    "decodes selected little-endian FAT slices (fat64=%s)",
    (fat64) => {
      const result = decodeAppleDispatchMetadata(
        wrapped(fat64),
        100,
        provenance,
      );
      expect(result.objc_classes[0]).toMatchObject({
        name: "Fixture",
        location: { address: "0x100000200", file_offset: 256 + 512 },
      });
      expect(result.objc_dispatch_implementations[0]).toMatchObject({
        implementation_address: "0x100000700",
        location: { file_offset: 256 + 0x488 },
      });
    },
  );

  it.each([6, 16])(
    "states the header byte order when its architecture table is truncated at %i bytes",
    (length) => {
      expect(() =>
        decodeAppleDispatchMetadata(
          wrapped(false).subarray(0, length),
          100,
          provenance,
        ),
      ).toThrow(
        "Malformed FAT architecture table (FAT header byte order: little-endian)",
      );
    },
  );

  it("validates the selected thin slice's own byte order", () => {
    const bytes = wrapped(false);
    bytes.writeUInt32BE(0xfeedfacf, 256);
    expect(() => decodeAppleDispatchMetadata(bytes, 100, provenance)).toThrow(
      "Only little-endian 64-bit Mach-O metadata is supported",
    );
  });

  it("rejects a 32-bit slice payload inside a little-endian container", () => {
    const bytes = wrapped(false);
    bytes.writeUInt32BE(0xfeedface, 256);
    expect(() => decodeAppleDispatchMetadata(bytes, 100, provenance)).toThrow(
      "Unsupported 32-bit Mach-O metadata for requested CPU type arm64 (FAT header byte order: little-endian)",
    );
  });

  it("checks the full little-endian FAT64 slice extent", () => {
    const bytes = wrapped(true);
    bytes.writeBigUInt64LE(0x100000000n, 16);
    expect(() => decodeAppleDispatchMetadata(bytes, 100, provenance)).toThrow(
      "FAT architecture 0 slice range extends beyond the file (FAT header byte order: little-endian)",
    );
  });
});

const unmappedProtocolSectionBase = 0x100000000n;
const unmappedProtocolImage = (bad: "protocol" | "class" | "neither") => {
  const bytes = Buffer.alloc(4096);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(0x0100000c, 4);
  bytes.writeUInt32LE(2, 12);
  bytes.writeUInt32LE(1, 16);
  bytes.writeUInt32LE(232, 20);
  bytes.writeUInt32LE(0x19, 32);
  bytes.writeUInt32LE(232, 36);
  bytes.write("__DATA", 40);
  bytes.writeBigUInt64LE(unmappedProtocolSectionBase, 56);
  bytes.writeBigUInt64LE(4096n, 64);
  bytes.writeBigUInt64LE(4096n, 80);
  bytes.writeUInt32LE(5, 92);
  bytes.writeUInt32LE(2, 96);
  bytes.write("__objc_classlist", 104);
  bytes.writeBigUInt64LE(
    unmappedProtocolSectionBase + (bad === "class" ? 0x9000n : 0x200n),
    136,
  );
  bytes.writeBigUInt64LE(8n, 144);
  bytes.write("__objc_protolist", 184);
  bytes.writeBigUInt64LE(
    unmappedProtocolSectionBase + (bad === "protocol" ? 0x9000n : 0x300n),
    216,
  );
  bytes.writeBigUInt64LE(8n, 224);
  bytes.writeBigUInt64LE(unmappedProtocolSectionBase + 0x400n, 0x200);
  bytes.writeBigUInt64LE(unmappedProtocolSectionBase + 0x500n, 0x420);
  bytes.writeUInt32LE(2, 0x500);
  bytes.writeUInt32LE(16, 0x508);
  bytes.writeBigUInt64LE(unmappedProtocolSectionBase + 0x600n, 0x518);
  bytes.write("RetainedClass\0", 0x600);
  return bytes;
};
const unmappedProtocolClassCoverage = (result: {
  coverage: { facet: string; status: string; reason: string | null }[];
}) =>
  result.coverage.find(
    ({ facet }) => facet === "objc_class_method_ivar_metadata",
  );

describe("Apple dispatch unmapped protocol-list slot", () => {
  it("returns the class when every list slot is mapped", () => {
    const result = decodeAppleDispatchMetadata(
      unmappedProtocolImage("neither"),
      100,
      provenance,
    );
    expect(result.objc_classes).toMatchObject([{ name: "RetainedClass" }]);
    expect(unmappedProtocolClassCoverage(result)).toMatchObject({
      status: "complete",
    });
  });

  it("records partial coverage when the class-list slot is unmapped", () => {
    const result = decodeAppleDispatchMetadata(
      unmappedProtocolImage("class"),
      100,
      provenance,
    );
    expect(unmappedProtocolClassCoverage(result)).toMatchObject({
      status: "partial",
      reason: expect.stringContaining("0x100009000"),
    });
  });

  it("retains the class and partial coverage when the protocol-list slot is unmapped", () => {
    const result = decodeAppleDispatchMetadata(
      unmappedProtocolImage("protocol"),
      100,
      provenance,
    );
    expect(result.objc_classes).toMatchObject([{ name: "RetainedClass" }]);
    expect(unmappedProtocolClassCoverage(result)).toMatchObject({
      status: "partial",
      reason: expect.stringContaining("0x100009000"),
    });
  });
});

describe("Apple dispatch list scan budget", () => {
  it("bounds failed protocol-list slots by the record budget", () => {
    // The section size is file-declared, so a crafted image can claim an
    // arbitrarily large unmapped protocol list. Failed slots must spend the
    // record budget like decoded ones, otherwise the loop runs unbounded.
    const bytes = unmappedProtocolImage("protocol");
    bytes.writeBigUInt64LE(80000n, 224);
    const result = decodeAppleDispatchMetadata(bytes, 100, provenance);
    const coverage = unmappedProtocolClassCoverage(result);
    expect(coverage).toMatchObject({ status: "partial" });
    expect(coverage?.reason).toContain("max_records_reached");
    const failures =
      coverage?.reason?.match(/Unmapped or ambiguous metadata pointer/g) ?? [];
    expect(failures.length).toBeLessThanOrEqual(100);
  });

  it("keeps independent facets complete when only zero-pointer list scanning is capped", () => {
    const bytes = unmappedProtocolImage("neither");
    bytes.writeBigUInt64LE(0n, 144);
    bytes.writeBigUInt64LE(16n, 224);
    const result = decodeAppleDispatchMetadata(bytes, 1, provenance);
    expect(unmappedProtocolClassCoverage(result)).toMatchObject({
      status: "partial",
      reason: expect.stringContaining("max_records_reached"),
    });
    for (const facet of [
      "objc_properties_categories",
      "binary_relative_pointers",
    ])
      expect(
        result.coverage.find((item) => item.facet === facet),
      ).toMatchObject({
        status: "complete",
        reason: null,
      });
  });

  it("marks class-dependent coverage partial when zero slots hide a later class", () => {
    const bytes = unmappedProtocolImage("neither");
    bytes.writeBigUInt64LE(0n, 224);
    bytes.writeBigUInt64LE(16n, 144);
    bytes.writeBigUInt64LE(0n, 0x200);
    bytes.writeBigUInt64LE(unmappedProtocolSectionBase + 0x400n, 0x208);
    const result = decodeAppleDispatchMetadata(bytes, 1, provenance);
    expect(result.objc_classes).toEqual([]);
    for (const facet of [
      "objc_class_method_ivar_metadata",
      "objc_properties_categories",
      "binary_relative_pointers",
    ])
      expect(
        result.coverage.find((item) => item.facet === facet),
      ).toMatchObject({
        status: "partial",
        reason: expect.stringContaining("max_records_reached"),
      });
    for (const facet of [
      "swift_class_vtable_descriptors",
      "swift_conformances_static_witness_slots",
    ])
      expect(
        result.coverage.find((item) => item.facet === facet),
      ).toMatchObject({ status: "complete" });
  });

  it("bounds failed class-list slots by the record budget", () => {
    // Same file-declared-size hazard as the protocol list: a crafted image
    // can declare an arbitrarily large unmapped class list. Failed class
    // slots must spend the record budget like decoded ones, otherwise the
    // loop runs unbounded (each failed read produced an unbounded failure
    // string with no budget spend).
    const bytes = unmappedProtocolImage("class");
    bytes.writeBigUInt64LE(80000n, 144);
    const result = decodeAppleDispatchMetadata(bytes, 100, provenance);
    const coverage = unmappedProtocolClassCoverage(result);
    expect(coverage).toMatchObject({ status: "partial" });
    expect(coverage?.reason).toContain("max_records_reached");
    const failures =
      coverage?.reason?.match(/Unmapped or ambiguous metadata pointer/g) ?? [];
    expect(failures.length).toBeLessThanOrEqual(100);
  });

  it("reports the real failure for a mapped-but-malformed class at the budget boundary", () => {
    // The class-list slot itself is mapped, so readClass admits the record
    // budget and only then throws on the unmapped class_ro pointer. The
    // failure must be recorded as-is: it already spent one budget unit, so
    // admitting again would break before the reason is appended and report
    // only max_records_reached.
    const bytes = unmappedProtocolImage("neither");
    bytes.writeBigUInt64LE(unmappedProtocolSectionBase + 0x700n, 0x200);
    bytes.writeBigUInt64LE(unmappedProtocolSectionBase + 0x9000n, 0x720);
    const result = decodeAppleDispatchMetadata(bytes, 1, provenance);
    const coverage = unmappedProtocolClassCoverage(result);
    expect(coverage).toMatchObject({ status: "partial" });
    expect(coverage?.reason).toContain(
      "Unmapped or ambiguous metadata pointer 0x100009018",
    );
    expect(coverage?.reason).not.toContain("max_records_reached");
  });

  it("does not skip a valid class after a mapped-but-malformed class", () => {
    // With two slots and a budget of two, the corrupt first slot must spend
    // exactly one unit: admitting twice would exhaust the budget and skip
    // the valid class behind it.
    const bytes = unmappedProtocolImage("neither");
    bytes.writeBigUInt64LE(16n, 144);
    bytes.writeBigUInt64LE(unmappedProtocolSectionBase + 0x700n, 0x200);
    bytes.writeBigUInt64LE(unmappedProtocolSectionBase + 0x9000n, 0x720);
    bytes.writeBigUInt64LE(unmappedProtocolSectionBase + 0x400n, 0x208);
    const result = decodeAppleDispatchMetadata(bytes, 2, provenance);
    expect(result.objc_classes).toMatchObject([{ name: "RetainedClass" }]);
    expect(unmappedProtocolClassCoverage(result)?.reason).toContain(
      "Unmapped or ambiguous metadata pointer 0x100009018",
    );
  });

  it("reports the real failure for a mapped-but-truncated protocol slot", () => {
    // The protocol slot is mapped, so protocolReader.record admits the
    // budget itself before throwing on the truncated declaration. The loop
    // must not admit a second time; the recorded reason stays the
    // declaration failure, not max_records_reached.
    const bytes = unmappedProtocolImage("neither");
    bytes.writeBigUInt64LE(unmappedProtocolSectionBase + 0x700n, 0x300);
    const result = decodeAppleDispatchMetadata(bytes, 100, provenance);
    const coverage = unmappedProtocolClassCoverage(result);
    expect(coverage).toMatchObject({ status: "partial" });
    expect(coverage?.reason).toContain(
      "Truncated Objective-C protocol declaration",
    );
    expect(coverage?.reason).not.toContain("max_records_reached");
  });

  it.each([
    ["RetainedProtocol", ["RetainedProtocol"], "complete"],
    ["", [], "partial"],
  ])(
    "keeps the class when the protocol name is %j",
    (protocolName, protocols, status) => {
      const bytes = unmappedProtocolImage("neither");
      bytes.writeBigUInt64LE(unmappedProtocolSectionBase + 0x700n, 0x300);
      bytes.writeBigUInt64LE(unmappedProtocolSectionBase + 0x800n, 0x708);
      bytes.writeUInt32LE(72, 0x740);
      bytes.write(`${protocolName}\0`, 0x800);
      const result = decodeAppleDispatchMetadata(bytes, 100, provenance);
      expect(result.objc_classes).toMatchObject([{ name: "RetainedClass" }]);
      expect(result.objc_protocols.map(({ name }) => name)).toEqual(protocols);
      const coverage = unmappedProtocolClassCoverage(result);
      expect(coverage).toMatchObject({ status });
      if (status === "partial")
        expect(coverage?.reason).toBe(
          "Protocol 0x100000700: Objective-C protocol has an empty name",
        );
    },
  );

  it("keeps a protocol adopted only by an empty-named protocol", () => {
    const bytes = unmappedProtocolImage("neither");
    const at = (offset: bigint) => unmappedProtocolSectionBase + offset;
    bytes.writeBigUInt64LE(at(0x700n), 0x300);
    bytes.writeBigUInt64LE(at(0x800n), 0x708); // empty parent name
    bytes.writeBigUInt64LE(at(0x900n), 0x710); // adopted protocol list
    bytes.writeUInt32LE(72, 0x740);
    bytes.writeBigUInt64LE(1n, 0x900);
    bytes.writeBigUInt64LE(at(0xa00n), 0x908);
    bytes.writeBigUInt64LE(at(0xb00n), 0xa08);
    bytes.writeUInt32LE(72, 0xa40);
    bytes.write("ChildProtocol\0", 0xb00);
    const result = decodeAppleDispatchMetadata(bytes, 100, provenance);
    expect(result.objc_classes).toMatchObject([{ name: "RetainedClass" }]);
    expect(result.objc_protocols.map(({ name }) => name)).toEqual([
      "ChildProtocol",
    ]);
    expect(unmappedProtocolClassCoverage(result)).toMatchObject({
      status: "partial",
      reason: "Protocol 0x100000700: Objective-C protocol has an empty name",
    });
  });
});

describe("malformed Objective-C protocol method lists", () => {
  it("reports an empty protocol method selector without discarding the protocol or its other methods", () => {
    const bytes = fixture();
    bytes.writeUInt32LE(2, 0x804);
    // The first required method names an empty string; the second is valid.
    bytes.writeBigUInt64LE(base + 0x930n, 0x808);
    bytes.writeBigUInt64LE(base + 0x920n, 0x820);
    const result = decodeAppleDispatchMetadata(bytes, 100, provenance);
    expect(result.objc_protocols).toMatchObject([
      {
        name: "FixtureProtocol",
        methods: [{ selector: "requiredAction:", is_required: true }],
        optional_methods: [{ selector: "optionalAction:", is_optional: true }],
      },
    ]);
    expect(result.objc_protocol_records).toMatchObject([
      {
        name: "FixtureProtocol",
        methods: [{ selector: "requiredAction:" }],
        decode: { status: "partial", reason: "protocol_method_selector_empty" },
      },
    ]);
    expect(result.objc_classes.map(({ name }) => name)).toEqual([
      "Fixture",
      "Fixture",
    ]);
    expect(result.objc_dispatch_implementations).toMatchObject([
      { selector: "performAction:" },
    ]);
    expect(
      result.coverage.find(
        ({ facet }) => facet === "objc_class_method_ivar_metadata",
      ),
    ).toMatchObject({
      status: "partial",
      reason: expect.stringContaining(
        "Protocol 0x100000740: Objective-C protocol FixtureProtocol required instance method 0 at 0x100000808 has an empty selector",
      ),
    });
  });
});
