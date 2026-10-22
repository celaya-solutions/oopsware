import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  compareManagedMembers,
  managedMemberComparisonResultSchema,
} from "../../../../src/domain/managed/managedMemberComparison.js";
import { managedMemberInspectionSchema } from "../../../../src/domain/managed/managedArtifact.js";
import { inspectManagedMembersBytes } from "../../../../src/dotnet/ManagedMemberInspector.js";
import {
  buildManagedPeFixture,
  managedPeFixtureTarget,
} from "../../../../src/dotnet/ManagedPe.fixture.js";

describe("managed operand-free instruction structural matching", () => {
  it("preserves operand-free opcode order when remapping renamed methods", () => {
    const observe = (
      methodName: string,
      fieldToken: number,
      swapImplicitConstants: boolean,
      path: string,
    ) => {
      const il = Buffer.from([
        0x7b,
        0,
        0,
        0,
        0, // ldfld token
        0x26, // pop
        swapImplicitConstants ? 0x18 : 0x17, // ldc.i4.1 or ldc.i4.2
        0x26, // pop
        swapImplicitConstants ? 0x17 : 0x18, // the other implicit constant
        0x26, // pop
        0x2a, // ret
      ]);
      il.writeUInt32LE(fieldToken, 1);
      return inspect(
        buildManagedPeFixture({
          methodName,
          ilBody: Buffer.concat([Buffer.from([(il.length << 2) | 2]), il]),
        }),
        path,
      );
    };
    const left = observe(
      "OldMethod",
      0x04000001,
      false,
      "/tmp/implicit-order-left.dll",
    );
    const sameOrder = observe(
      "NewMethod",
      0x04000002,
      false,
      "/tmp/implicit-order-same.dll",
    );
    const swapped = observe(
      "NewMethod",
      0x04000002,
      true,
      "/tmp/implicit-order-swapped.dll",
    );

    expect(left.result.methods[0]?.body.opcode_counts).toEqual(
      swapped.result.methods[0]?.body.opcode_counts,
    );
    expect(left.result.methods[0]?.body.il_sha256).not.toBe(
      sameOrder.result.methods[0]?.body.il_sha256,
    );
    expect(left.result.methods[0]?.body.il_sha256).not.toBe(
      swapped.result.methods[0]?.body.il_sha256,
    );
    const sameOrderComparison = compareManagedMembers(left, sameOrder);
    expect(sameOrderComparison.methods).toContainEqual(
      expect.objectContaining({
        status: "changed",
        match: expect.objectContaining({
          status: "matched",
          basis: "structural-method-shape",
        }),
      }),
    );

    const swappedComparison = compareManagedMembers(left, swapped);
    expect(swappedComparison.methods.map(({ status }) => status)).toEqual([
      "removed",
      "added",
    ]);
    expect(
      swappedComparison.methods.some(
        ({ match }) => match.basis === "structural-method-shape",
      ),
    ).toBe(false);
    expect(
      left.result.methods[0]?.body.anchors.map(({ opcode }) => opcode),
    ).toEqual(["ldfld", "pop", "ldc.i4.1", "pop", "ldc.i4.2", "pop", "ret"]);
    expect(
      swapped.result.methods[0]?.body.anchors.map(({ opcode }) => opcode),
    ).toEqual(["ldfld", "pop", "ldc.i4.2", "pop", "ldc.i4.1", "pop", "ret"]);
  });
});

describe("managed member structural matching", () => {
  it("keeps unequal constants from becoming a structural remap", () => {
    const observe = (
      typeName: string,
      methodName: string,
      constant: number,
      branchOffset: number,
    ) =>
      inspect(
        buildManagedPeFixture({
          typeName,
          methodName,
          ilBody: Buffer.from([
            0x1e,
            0x1f,
            constant,
            0x26,
            0x2b,
            branchOffset,
            0x00,
            0x2a,
          ]),
        }),
        `/tmp/${typeName}-${constant}.dll`,
      );
    const left = observe("OldType", "OldMethod", 5, 1);
    const differentConstant = observe("NewType", "NewMethod", 7, 1);
    const sameConstant = observe("NewType", "NewMethod", 5, 0);
    for (const [observed, constant] of [
      [left, 5],
      [differentConstant, 7],
      [sameConstant, 5],
    ] as const) {
      expect(observed.result.methods[0]?.body).toMatchObject({
        status: "present",
        normalized_il_sha256: expect.any(String),
        anchors: expect.arrayContaining([
          expect.objectContaining({
            operand_kind: "constant",
            operand: String(constant),
          }),
        ]),
      });
    }

    const different = compareManagedMembers(left, differentConstant);
    expect(different.methods.map(({ status }) => status)).toEqual([
      "removed",
      "added",
    ]);
    expect(
      different.methods.some(
        ({ match }) => match.basis === "structural-method-shape",
      ),
    ).toBe(false);

    expect(compareManagedMembers(left, sameConstant).methods).toContainEqual(
      expect.objectContaining({
        status: "changed",
        match: expect.objectContaining({
          status: "matched",
          basis: "structural-method-shape",
          confidence: "high",
        }),
      }),
    );
  });
});

describe("managed member comparison", () => {
  it("remaps renamed methods by exact CIL/signature without using names", () => {
    const leftBytes = buildManagedPeFixture();
    const rightBytes = buildManagedPeFixture({
      mvid: Buffer.from("00112233445566778899aabbccddeefe", "hex"),
      typeName: "A",
      typeNamespace: "X",
      methodName: "b",
      fieldName: "c",
    });
    const left = inspect(leftBytes, "/tmp/left.dll");
    const right = inspect(rightBytes, "/tmp/right.dll");
    const result = compareManagedMembers(
      { evidenceId: left.evidenceId, result: left.result },
      { evidenceId: right.evidenceId, result: right.result },
    );

    expect(result.algorithm.name_matching).toBe("exact-signature-fallback");
    expect(result.left.mvid).toBe("00112233-4455-6677-8899-aabbccddeeff");
    expect(result.right.mvid).toBe("33221100-5544-7766-8899-aabbccddeefe");
    expect(result.matching.exact_il_signature).toBe(1);
    expect(result.methods).toEqual([
      expect.objectContaining({
        status: "unchanged",
        left: expect.objectContaining({ token: "0x06000001", name: "Main" }),
        right: expect.objectContaining({ token: "0x06000001", name: "b" }),
        match: expect.objectContaining({
          status: "matched",
          basis: "exact-il-signature",
          confidence: "exact",
        }),
        dimensions: [],
      }),
    ]);
    expect(result.limitations).toContain(
      "Methods pair within one declared type and name by exact CIL/signature, then signature, then structural shape; only then may exact CIL/signature or structural shape alone remap across declared types or names, never taking a member whose own declared type and name remain unpaired on the other side or whose declaring type is unresolved. Names alone are never a matching basis.",
    );
    expect(
      managedMemberComparisonResultSchema.safeParse({
        ...result,
        limitations: Array.from({ length: 101 }, () => "x".repeat(4_097)),
      }).success,
    ).toBe(true);
  });

  it("compares changed CIL after pairing by exact signature", () => {
    const leftBytes = buildManagedPeFixture();
    const rightBytes = buildManagedPeFixture({
      ilBody: Buffer.from([
        0x32, 0x02, 0x7b, 0x02, 0x00, 0x00, 0x04, 0x28, 0x02, 0x00, 0x00, 0x0a,
        0x2a,
      ]),
    });
    const left = inspect(leftBytes, "/tmp/left.dll");
    const right = inspect(rightBytes, "/tmp/right.dll");
    const result = compareManagedMembers(
      { evidenceId: left.evidenceId, result: left.result },
      { evidenceId: right.evidenceId, result: right.result },
    );

    expect(result.matching.exact_il_signature).toBe(0);
    expect(result.matching.exact_signature).toBe(1);
    expect(result.methods[0]).toMatchObject({
      status: "changed",
      match: { status: "matched", basis: "exact-signature" },
      dimensions: ["cil"],
    });
  });

  it("rejects member states that disagree with their observed sides or match", () => {
    const left = inspect(buildManagedPeFixture(), "/tmp/left.dll");
    const right = inspect(buildManagedPeFixture(), "/tmp/right.dll");
    const result = compareManagedMembers(
      { evidenceId: left.evidenceId, result: left.result },
      { evidenceId: right.evidenceId, result: right.result },
    );
    const method = result.methods[0];
    expect(method).toBeDefined();
    if (method === undefined) return;

    expect(
      managedMemberComparisonResultSchema.safeParse({
        ...result,
        methods: [{ ...method, status: "unchanged", right: null }],
      }).success,
    ).toBe(false);
    expect(
      managedMemberComparisonResultSchema.safeParse({
        ...result,
        methods: [
          {
            ...method,
            match: {
              ...method.match,
              basis: "none",
              confidence: "unknown",
            },
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("managed member comparison with equal decoded fingerprints", () => {
  it.each([
    { name: "Main", basis: "exact-signature" },
    { name: "Renamed", basis: "structural-method-shape" },
  ])("detects reordered switch targets in $name", ({ name, basis }) => {
    const observe = (targets: readonly number[], methodName: string) => {
      // ldarg.0; switch (case 0, case 1); ldc.i4.0; ret; ldc.i4.1; ret.
      // Both cases target instruction starts, relative to the end of the table.
      const il = Buffer.alloc(18);
      il[0] = 0x02;
      il[1] = 0x45;
      il.writeUInt32LE(2, 2);
      targets.forEach((target, index) =>
        il.writeInt32LE(target, 6 + index * 4),
      );
      Buffer.from([0x16, 0x2a, 0x17, 0x2a]).copy(il, 14);
      return inspect(
        buildManagedPeFixture({
          methodName,
          methodSignature: Buffer.from([0x00, 0x01, 0x08, 0x08]),
          ilBody: Buffer.concat([Buffer.from([(il.length << 2) | 2]), il]),
        }),
        `/tmp/${methodName}-${targets.join("-")}.dll`,
      );
    };
    const left = observe([0, 2], "Main");
    const right = observe([2, 0], name);
    const leftBody = left.result.methods[0]?.body;
    const rightBody = right.result.methods[0]?.body;
    expect(leftBody?.status).toBe("present");
    expect(rightBody?.status).toBe("present");
    expect(leftBody?.normalized_il_sha256).toBe(
      rightBody?.normalized_il_sha256,
    );
    expect(leftBody?.il_sha256).not.toBe(rightBody?.il_sha256);

    const result = compareManagedMembers(left, right);
    expect(result.matching.exact_il_signature).toBe(0);
    expect(result.methods[0]).toMatchObject({
      status: "changed",
      match: { status: "matched", basis },
      dimensions: ["cil"],
    });
    expect(
      compareManagedMembers(right, observe([2, 0], name)).methods[0],
    ).toMatchObject({
      status: "unchanged",
      match: {
        status: "matched",
        basis: "exact-il-signature",
        confidence: "exact",
      },
      dimensions: [],
    });
  });
});

describe("managed member comparison floating-point constants", () => {
  it.each([
    {
      opcode: "ldc.r4",
      positive: "22000000002a",
      negative: "22000000802a",
      type: 0x0c,
    },
    {
      opcode: "ldc.r8",
      positive: "2300000000000000002a",
      negative: "2300000000000000802a",
      type: 0x0d,
    },
  ])(
    "detects a change from positive to negative zero in $opcode",
    ({ opcode, positive, negative, type }) => {
      const observe = (hex: string, path: string) => {
        const il = Buffer.from(hex, "hex");
        return inspect(
          buildManagedPeFixture({
            methodSignature: Buffer.from([0x00, 0x00, type]),
            ilBody: Buffer.concat([Buffer.from([(il.length << 2) | 2]), il]),
          }),
          path,
        );
      };
      const left = observe(positive, "/tmp/positive-zero.dll");
      const right = observe(negative, "/tmp/negative-zero.dll");
      const comparison = compareManagedMembers(left, right);

      expect(comparison.methods[0]).toMatchObject({
        status: "changed",
        match: { status: "matched", basis: "exact-signature" },
        dimensions: ["cil"],
      });
      for (const [observation, operand] of [
        [left, "0"],
        [right, "-0"],
      ] as const) {
        expect(observation.result.methods[0]?.body).toMatchObject({
          status: "present",
          anchors: [
            { il_offset: 0, opcode, operand_kind: "constant", operand },
            // ldc.r4 spans 5 bytes and ldc.r8 spans 9 before the ret.
            {
              il_offset: opcode === "ldc.r4" ? 5 : 9,
              opcode: "ret",
              operand_kind: "none",
              operand: null,
            },
          ],
        });
      }
      expect(left.result.methods[0]?.body.normalized_il_sha256).not.toBe(
        right.result.methods[0]?.body.normalized_il_sha256,
      );
      const repeated = observe(negative, "/tmp/negative-zero-copy.dll");
      expect(compareManagedMembers(right, repeated).methods[0]).toMatchObject({
        status: "unchanged",
        match: { status: "matched", basis: "exact-il-signature" },
        dimensions: [],
      });
    },
  );
});

describe("managed member comparison uncertainty", () => {
  it("does not infer a structural method match from undecoded signature fields", () => {
    const left = inspect(
      buildManagedPeFixture({ methodSignature: Buffer.from([0xff]) }),
      "/tmp/unknown-left.dll",
    );
    const right = inspect(
      buildManagedPeFixture({ methodSignature: Buffer.from([0xfe]) }),
      "/tmp/unknown-right.dll",
    );
    expect(left.result.methods[0]?.signature.parse_status).not.toBe("decoded");
    expect(right.result.methods[0]?.signature.parse_status).not.toBe("decoded");
    const result = compareManagedMembers(
      {
        evidenceId: left.evidenceId,
        result: {
          ...left.result,
          coverage: { ...left.result.coverage, state: "partial" },
        },
      },
      {
        evidenceId: right.evidenceId,
        result: {
          ...right.result,
          coverage: { ...right.result.coverage, state: "partial" },
        },
      },
    );
    expect(result.matching.structural_method_shape).toBe(0);
    expect(result.methods).toHaveLength(2);
    expect(
      result.methods.every(
        ({ status, match }) =>
          status === "unknown" && match.status === "unmatched",
      ),
    ).toBe(true);
  });

  it("keeps unmatched members unknown when opposite metadata is incomplete", () => {
    const left = inspect(buildManagedPeFixture(), "/tmp/left-partial.dll");
    const right = inspect(buildManagedPeFixture(), "/tmp/right-partial.dll");
    const leftPartial = {
      ...left.result,
      fields: [],
      metadata: { ...left.result.metadata, status: "partial" as const },
      coverage: { ...left.result.coverage, state: "partial" as const },
    };
    const rightPartial = {
      ...right.result,
      methods: [],
      metadata: { ...right.result.metadata, status: "partial" as const },
      coverage: { ...right.result.coverage, state: "partial" as const },
    };
    const result = compareManagedMembers(
      { evidenceId: left.evidenceId, result: leftPartial },
      { evidenceId: right.evidenceId, result: rightPartial },
    );

    expect(result.summary).toMatchObject({
      added: 0,
      removed: 0,
      unknown: 2,
    });
    expect(result.methods[0]).toMatchObject({
      status: "unknown",
      left: { token: "0x06000001" },
      right: null,
      limitations: [
        expect.stringContaining("unknown-within-incomplete-metadata"),
      ],
    });
    expect(result.fields[0]).toMatchObject({
      status: "unknown",
      left: null,
      right: { token: "0x04000001" },
      limitations: [
        expect.stringContaining("unknown-within-incomplete-metadata"),
      ],
    });
    expect(result.coverage).toEqual({
      status: "partial",
      left_status: "partial",
      right_status: "partial",
    });
  });

  it("does not guess ambiguous field signature matches", () => {
    const left = inspect(buildManagedPeFixture(), "/tmp/left.dll");
    const leftField = left.result.fields[0];
    expect(leftField).toBeDefined();
    if (leftField === undefined) return;
    const duplicatedLeft = {
      ...left.result,
      fields: [
        leftField,
        {
          ...leftField,
          token: "0x04000002",
          name: "other",
        },
      ],
    };
    const right = inspect(buildManagedPeFixture(), "/tmp/right.dll");
    const rightField = right.result.fields[0];
    expect(rightField).toBeDefined();
    if (rightField === undefined) return;
    // Both right fields are renamed, so neither left field keeps its declared
    // identity and only the shared signature links them.
    const duplicatedRight = {
      ...right.result,
      fields: [
        { ...rightField, name: "moved" },
        {
          ...rightField,
          token: "0x04000002",
          name: "renamed",
        },
      ],
    };
    const result = compareManagedMembers(
      { evidenceId: left.evidenceId, result: duplicatedLeft },
      { evidenceId: right.evidenceId, result: duplicatedRight },
    );

    expect(result.matching.ambiguous).toBe(1);
    expect(result.fields).toEqual([
      expect.objectContaining({
        status: "unknown",
        match: expect.objectContaining({
          status: "ambiguous",
          basis: "field-signature",
          candidate_left_tokens: ["0x04000001", "0x04000002"],
          candidate_right_tokens: ["0x04000001", "0x04000002"],
        }),
        limitations: [
          "Multiple managed fields share the same signature; Oopsware did not guess a token remap.",
        ],
      }),
    ]);
  });
});

describe("managed member comparison beside user strings", () => {
  it("keeps member deltas and coverage when only #US literals are nonconforming", () => {
    // The method loads "ok", stored with flag 1 where ECMA-335 expects 0.
    const options = {
      ilBody: Buffer.from([(7 << 2) | 2, 0x72, 1, 0, 0, 0x70, 0x26, 0x2a]),
      userStringHeap: Buffer.from([0, 5, 0x6f, 0, 0x6b, 0, 1]),
    };
    const left = inspect(buildManagedPeFixture(options), "/tmp/left-us.dll");
    const right = inspect(buildManagedPeFixture(options), "/tmp/right-us.dll");
    const result = compareManagedMembers(
      { evidenceId: left.evidenceId, result: { ...left.result, fields: [] } },
      {
        evidenceId: right.evidenceId,
        result: { ...right.result, methods: [] },
      },
    );

    expect(left.result.metadata.status).toBe("complete");
    expect(left.result.coverage.state).toBe("complete");
    expect(left.result.user_strings?.state).toBe("partial");
    expect(result.summary).toMatchObject({ added: 1, removed: 1, unknown: 0 });
  });
});

describe("managed member comparison of undecoded signatures", () => {
  it("remaps renamed methods only when raw signatures and complete normalized IL match", () => {
    const signature = Buffer.from([0x00, 0x00, 0x7f]);
    const left = inspect(
      buildManagedPeFixture({ methodSignature: signature }),
      "/tmp/undecoded-method-before.dll",
    );
    const renamed = inspect(
      buildManagedPeFixture({
        methodSignature: signature,
        methodName: "renamed",
      }),
      "/tmp/undecoded-method-renamed.dll",
    );
    expect(left.result.methods[0]?.signature.parse_status).toBe("unsupported");
    expect(renamed.result.metadata.status).toBe("complete");
    expect(renamed.result.coverage.state).toBe("partial");

    const exact = compareManagedMembers(left, renamed);
    expect(exact.methods).toEqual([
      expect.objectContaining({
        status: "unchanged",
        match: expect.objectContaining({
          status: "matched",
          basis: "exact-il-signature",
          confidence: "exact",
        }),
      }),
    ]);
    expect(exact.summary).toMatchObject({ added: 0, removed: 0, unknown: 0 });

    const changedRaw = inspect(
      buildManagedPeFixture({
        methodSignature: Buffer.from([0x00, 0x00, 0x7e]),
        methodName: "renamed",
      }),
      "/tmp/undecoded-method-raw-changed.dll",
    );
    const changedBody = inspect(
      buildManagedPeFixture({
        methodSignature: signature,
        methodName: "renamed",
        ilBody: Buffer.from([0x2a]),
      }),
      "/tmp/undecoded-method-il-changed.dll",
    );
    for (const negative of [changedRaw, changedBody]) {
      const result = compareManagedMembers(left, negative);
      expect(result.methods).toHaveLength(2);
      expect(
        result.methods.every((method) => method.match.status !== "matched"),
      ).toBe(true);
    }
  });

  it("pairs undecoded signatures by exact declared type, name, and raw bytes", () => {
    const undecoded = {
      methodSignature: Buffer.from([0x00, 0x00, 0x7f]),
      fieldSignature: Buffer.from([0x06, 0x7f]),
    };
    const left = inspect(
      buildManagedPeFixture(undecoded),
      "/tmp/undecoded-left.dll",
    );
    const right = inspect(
      buildManagedPeFixture(undecoded),
      "/tmp/undecoded-right.dll",
    );
    expect(left.result.metadata.status).toBe("complete");
    expect(left.result.coverage.state).toBe("partial");
    expect(left.result.methods[0]?.signature.parse_status).toBe("unsupported");
    expect(left.result.fields[0]?.signature.parse_status).toBe("unsupported");
    const result = compareManagedMembers(left, right);
    expect(result.summary).toMatchObject({
      unchanged: 2,
      added: 0,
      removed: 0,
      unknown: 0,
    });
    expect(result.methods[0]?.match).toMatchObject({
      status: "matched",
      basis: "exact-il-signature",
    });
    expect(result.fields[0]?.match).toMatchObject({
      status: "matched",
      basis: "exact-signature",
    });
  });

  it("keeps unmatched undecoded members unknown with complete metadata inventories", () => {
    const left = inspect(
      buildManagedPeFixture({
        methodSignature: Buffer.from([0x00, 0x00, 0x7f]),
        fieldSignature: Buffer.from([0x06, 0x7f]),
      }),
      "/tmp/undecoded-before.dll",
    );
    const right = inspect(
      buildManagedPeFixture({
        methodSignature: Buffer.from([0x00, 0x00, 0x7e]),
        fieldSignature: Buffer.from([0x06, 0x7e]),
      }),
      "/tmp/undecoded-after.dll",
    );
    expect(right.result.metadata.status).toBe("complete");
    expect(right.result.coverage.state).toBe("partial");
    const result = compareManagedMembers(left, right);
    expect(result.summary).toMatchObject({ added: 0, removed: 0, unknown: 4 });
    for (const item of [...result.methods, ...result.fields])
      expect(item).toMatchObject({
        status: "unknown",
        match: { status: "unmatched" },
        limitations: [expect.stringContaining("signature-not-decoded")],
      });
  });

  it("keeps a decoded member unknown beside a same-named undecoded counterpart", () => {
    const left = inspect(buildManagedPeFixture(), "/tmp/decoded-before.dll");
    const right = inspect(
      buildManagedPeFixture({
        methodSignature: Buffer.from([0x00, 0x00, 0x7f]),
        fieldSignature: Buffer.from([0x06, 0x7f]),
      }),
      "/tmp/undecoded-after.dll",
    );
    expect(left.result.methods[0]?.signature.parse_status).toBe("decoded");
    expect(left.result.fields[0]?.signature.parse_status).toBe("decoded");
    expect(right.result.metadata.status).toBe("complete");
    expect(right.result.coverage.state).toBe("partial");
    const result = compareManagedMembers(left, right);
    expect(result.summary).toMatchObject({ added: 0, removed: 0, unknown: 4 });
    for (const item of [...result.methods, ...result.fields])
      expect(item).toMatchObject({
        status: "unknown",
        match: { status: "unmatched" },
        limitations: [
          expect.stringMatching(
            item.left === null
              ? /^signature-not-decoded:/
              : /^counterpart-signature-not-decoded: The right (method|field) inventory/,
          ),
        ],
      });
  });
});

describe("managed member comparison of ambiguous undecoded signatures", () => {
  it("keeps a decoded member unknown beside an ambiguous same-named undecoded group", () => {
    const undecoded = { methodSignature: Buffer.from([0x00, 0x00, 0x7f]) };
    const decoded = inspect(buildManagedPeFixture(), "/tmp/decoded.dll");
    const left = inspect(buildManagedPeFixture(undecoded), "/tmp/left.dll");
    const right = inspect(buildManagedPeFixture(undecoded), "/tmp/right.dll");
    const [undecodedMethod] = left.result.methods;
    const [decodedMethod] = decoded.result.methods;
    if (undecodedMethod === undefined || decodedMethod === undefined)
      throw new Error("Expected fixture methods");
    expect(decodedMethod.name).toBe(undecodedMethod.name);
    // One undecoded T.M on the left meets two identical undecoded T.M on the
    // right, so that group stays ambiguous; the left also has a decoded T.M.
    const result = compareManagedMembers(
      {
        ...left,
        result: {
          ...left.result,
          methods: [undecodedMethod, { ...decodedMethod, token: "0x06000002" }],
        },
      },
      {
        ...right,
        result: {
          ...right.result,
          methods: [
            undecodedMethod,
            { ...undecodedMethod, token: "0x06000002" },
          ],
        },
      },
    );

    expect(result.methods).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "unknown",
          match: expect.objectContaining({
            status: "ambiguous",
            basis: "exact-il-signature",
          }),
          limitations: [
            "Multiple managed methods share the same CIL and signature; Oopsware did not guess a token remap.",
          ],
        }),
        expect.objectContaining({
          status: "unknown",
          left: expect.objectContaining({ token: "0x06000002" }),
          limitations: [
            expect.stringMatching(
              /^counterpart-signature-not-decoded: The right method inventory has an unpaired member/u,
            ),
          ],
        }),
      ]),
    );
    expect(result.summary).toMatchObject({ removed: 0, added: 0 });
  });
});

describe("managed member comparison of selected types", () => {
  it("keeps members outside the other side's selection unknown", () => {
    const left = inspect(buildManagedPeFixture(), "/tmp/left-all.dll");
    const right = inspect(buildManagedPeFixture(), "/tmp/right-selected.dll", [
      "Missing.Type",
    ]);
    const result = compareManagedMembers(
      { evidenceId: left.evidenceId, result: left.result },
      { evidenceId: right.evidenceId, result: right.result },
    );

    expect(result.summary).toMatchObject({ added: 0, removed: 0, unknown: 2 });
    expect(result.methods[0]).toMatchObject({
      status: "unknown",
      left: { token: "0x06000001" },
      right: null,
    });
    expect(result.coverage.status).toBe("partial");
    expect(result.limitations).toContain(
      "The observations select different declaring types; a member outside the other side's selection is unknown, not added or removed.",
    );
  });

  it("does not remap members across types neither side observed", () => {
    const left = inspect(buildManagedPeFixture(), "/tmp/left-a.dll", [
      "Fixture.Program",
    ]);
    const right = inspect(
      buildManagedPeFixture({
        mvid: Buffer.from("00112233445566778899aabbccddeefe", "hex"),
        typeName: "A",
        typeNamespace: "X",
      }),
      "/tmp/right-b.dll",
      ["X.A"],
    );
    const result = compareManagedMembers(
      { evidenceId: left.evidenceId, result: left.result },
      { evidenceId: right.evidenceId, result: right.result },
    );

    expect(result.matching.exact_il_signature).toBe(0);
    expect(result.summary).toMatchObject({
      unchanged: 0,
      added: 0,
      removed: 0,
      unknown: 4,
    });
  });

  it("compares two identical selections within those types", () => {
    const left = inspect(buildManagedPeFixture(), "/tmp/left-sel.dll", [
      "Fixture.Program",
    ]);
    const right = inspect(buildManagedPeFixture(), "/tmp/right-sel.dll", [
      "Fixture.Program",
    ]);
    const result = compareManagedMembers(
      { evidenceId: left.evidenceId, result: left.result },
      { evidenceId: right.evidenceId, result: right.result },
    );

    expect(result.methods[0]).toMatchObject({ status: "unchanged" });
    expect(result.coverage.status).toBe("complete-within-inputs");
    expect(result.limitations).toContain(
      "Both observations cover only the selected declaring types (Fixture.Program); member totals and statuses describe those types, not the whole assembly.",
    );
  });
});

describe("managed member comparison of one signature in several types", () => {
  it("pairs a file with itself when two types hold identical members", () => {
    const inspected = withTwin(
      inspect(buildManagedPeFixture(), "/tmp/twin.dll"),
    );
    const result = compareManagedMembers(inspected, inspected);

    expect(result.matching.ambiguous).toBe(0);
    expect(result.summary).toMatchObject({
      unchanged: 4,
      changed: 0,
      added: 0,
      removed: 0,
      unknown: 0,
    });
    for (const item of [...result.methods, ...result.fields])
      expect(item.right?.token).toBe(item.left?.token);
  });

  it.each([1, 2])(
    "keeps a member with its own changed counterpart beside %i identical members of other types",
    (twins) => {
      const left = inspect(buildManagedPeFixture(), "/tmp/own-before.dll");
      const changed = withTwin(
        inspect(
          buildManagedPeFixture({
            ilBody: Buffer.from([
              0x32, 0x02, 0x7b, 0x02, 0x00, 0x00, 0x04, 0x28, 0x02, 0x00, 0x00,
              0x0a, 0x2a,
            ]),
          }),
          "/tmp/own-after.dll",
        ),
        left,
        twins,
      );
      const result = compareManagedMembers(left, changed);

      expect(result.methods).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: "changed",
            left: expect.objectContaining({
              declaring_type: "Fixture.Program",
            }),
            right: expect.objectContaining({
              declaring_type: "Fixture.Program",
            }),
            match: expect.objectContaining({ basis: "exact-signature" }),
            dimensions: expect.arrayContaining(["cil"]),
          }),
          expect.objectContaining({
            status: "added",
            right: expect.objectContaining({ declaring_type: "Other.Twin" }),
          }),
        ]),
      );
      expect(result.fields).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: "unchanged",
            left: expect.objectContaining({
              declaring_type: "Fixture.Program",
            }),
            right: expect.objectContaining({
              declaring_type: "Fixture.Program",
            }),
          }),
          expect.objectContaining({
            status: "added",
            right: expect.objectContaining({ declaring_type: "Other.Twin" }),
          }),
        ]),
      );
      expect(result.summary).toMatchObject({ unknown: 0, removed: 0 });
    },
  );

  it("does not remap a member whose own identity remains on the other side", () => {
    const left = inspect(buildManagedPeFixture(), "/tmp/sig-before.dll");
    const changed = withTwin(
      inspect(
        buildManagedPeFixture({
          methodSignature: Buffer.from([0x00, 0x00, 0x08]),
          fieldSignature: Buffer.from([0x06, 0x0a]),
        }),
        "/tmp/sig-after.dll",
      ),
      left,
    );
    // Either side may hold the member whose own identity is left behind.
    const forward = compareManagedMembers(left, changed);
    const backward = compareManagedMembers(changed, left);

    for (const item of [
      ...forward.methods,
      ...forward.fields,
      ...backward.methods,
      ...backward.fields,
    ])
      expect(item.match.status).not.toBe("matched");
    expect(forward.summary).toMatchObject({ removed: 2, added: 4 });
    expect(backward.summary).toMatchObject({ removed: 4, added: 2 });
  });

  it("does not remap by structural shape a method whose own identity remains on the other side", () => {
    const left = inspect(buildManagedPeFixture(), "/tmp/shape-before.dll");
    const changed = withTwin(
      inspect(
        buildManagedPeFixture({
          methodSignature: Buffer.from([0x00, 0x00, 0x08]),
        }),
        "/tmp/shape-after.dll",
      ),
      left,
    );
    const [own, twin] = changed.result.methods;
    if (own === undefined || twin === undefined)
      throw new Error("Expected two methods");
    // Same body shape, different CIL digest: only the structural round links
    // the left method to the twin.
    const result = compareManagedMembers(left, {
      ...changed,
      result: {
        ...changed.result,
        methods: [
          own,
          {
            ...twin,
            body: { ...twin.body, normalized_il_sha256: "0".repeat(64) },
          },
        ],
      },
    });

    for (const item of result.methods)
      expect(item.match.status).not.toBe("matched");
  });
});

describe("managed member comparison remaps around kept identities", () => {
  it("does not hide a member whose own identity remains in an ambiguous remap group", () => {
    const left = inspect(buildManagedPeFixture(), "/tmp/group-before.dll");
    const changed = withTwin(
      inspect(
        buildManagedPeFixture({
          methodSignature: Buffer.from([0x00, 0x00, 0x08]),
          fieldSignature: Buffer.from([0x06, 0x0a]),
        }),
        "/tmp/group-after.dll",
      ),
      left,
      2,
    );
    const result = compareManagedMembers(left, changed);

    expect(result.matching.ambiguous).toBe(0);
    expect(result.summary).toMatchObject({ removed: 2, added: 6 });
  });

  it("remaps to the one candidate whose own identity is not kept elsewhere", () => {
    const base = inspect(buildManagedPeFixture(), "/tmp/kept-base.dll");
    const changedSignature = inspect(
      buildManagedPeFixture({
        methodSignature: Buffer.from([0x00, 0x00, 0x08]),
      }),
      "/tmp/kept-signature.dll",
    );
    // Left: Fixture.Program.Main, plus Other.Twin.Main with another signature.
    const left = withTwin(base, changedSignature);
    // Right: Other.Twin.Main and Other.Twin3.Main, both identical to the
    // left Fixture.Program.Main, which the right no longer has.
    const twins = withTwin(base, base, 2);
    const right = {
      ...twins,
      result: { ...twins.result, methods: twins.result.methods.slice(1) },
    };
    const result = compareManagedMembers(left, right);

    expect(result.methods).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          left: expect.objectContaining({ declaring_type: "Fixture.Program" }),
          right: expect.objectContaining({ declaring_type: "Other.Twin3" }),
          match: expect.objectContaining({
            status: "matched",
            basis: "exact-il-signature",
          }),
        }),
      ]),
    );
    expect(
      result.methods.filter(({ match }) => match.status === "ambiguous"),
    ).toEqual([]);
  });

  it("names the shared structural shape of an ambiguous remap group", () => {
    const base = inspect(buildManagedPeFixture(), "/tmp/shape-group.dll");
    const twins = withTwin(base, base, 2);
    // Two right methods share the left method's shape but not its CIL digest,
    // and the right no longer declares the left method's identity.
    const right = {
      ...twins,
      result: {
        ...twins.result,
        methods: twins.result.methods.slice(1).map((method) => ({
          ...method,
          body: { ...method.body, normalized_il_sha256: "0".repeat(64) },
        })),
        fields: [],
      },
    };
    const left = { ...base, result: { ...base.result, fields: [] } };
    const result = compareManagedMembers(left, right);

    expect(result.methods).toEqual([
      expect.objectContaining({
        match: expect.objectContaining({
          status: "ambiguous",
          basis: "structural-method-shape",
        }),
        limitations: [
          "Multiple managed methods share the same structural shape; Oopsware did not guess a token remap.",
        ],
      }),
    ]);
  });
});

describe("managed member comparison of unresolved and held identities", () => {
  it("does not remap past an unresolved member that may be the counterpart", () => {
    const base = inspect(buildManagedPeFixture(), "/tmp/orphan-copy.dll");
    const [method] = base.result.methods;
    if (method === undefined) throw new Error("Expected a fixture method");
    const left = { ...base, result: { ...base.result, fields: [] } };
    // The right keeps Main with an unresolved owner, and an identical copy
    // in another type; either could be the left Main.
    const right = {
      ...base,
      result: {
        ...base.result,
        types: [
          ...base.result.types,
          namedTypeFact("Twin", "Other", "0x02000003"),
        ],
        methods: [
          { ...method, declaring_type: null, declaring_type_token: null },
          {
            ...method,
            declaring_type: "Other.Twin",
            declaring_type_token: "0x02000003",
            name: "Copy",
            token: "0x06000002",
          },
        ],
        fields: [],
      },
    };

    for (const result of [
      compareManagedMembers(left, right),
      compareManagedMembers(right, left),
    ]) {
      expect(
        result.methods.filter(({ match }) => match.status === "matched"),
      ).toEqual([]);
      expect(result.summary).toMatchObject({ added: 0, removed: 0 });
    }
  });
});

describe("managed member comparison of raw-signature contention", () => {
  it("contests same-signature methods even when their bodies differ", () => {
    const base = inspect(
      buildManagedPeFixture(),
      "/tmp/ownerless-signatures.dll",
    );
    const [method] = base.result.methods;
    if (method === undefined) throw new Error("Expected a fixture method");
    const changedBody = (hash: string, stack: number) => ({
      ...method.body,
      normalized_il_sha256: hash.repeat(64),
      max_stack: stack,
    });
    const withOwnerless = {
      ...base,
      result: {
        ...base.result,
        fields: [],
        methods: [
          { ...method, body: changedBody("a", 1) },
          {
            ...method,
            token: "0x06000002",
            declaring_type: null,
            declaring_type_token: null,
            body: changedBody("b", 2),
          },
        ],
      },
    };
    const resolvedOnly = {
      ...base,
      result: {
        ...base.result,
        fields: [],
        methods: [{ ...method, body: changedBody("c", 3) }],
      },
    };
    for (const result of [
      compareManagedMembers(withOwnerless, resolvedOnly),
      compareManagedMembers(resolvedOnly, withOwnerless),
    ]) {
      expect(result.methods).toHaveLength(1);
      const [item] = result.methods;
      if (item === undefined)
        throw new Error("Expected uncertain signature group");
      expect(item).toMatchObject({
        status: "unknown",
        match: { status: "ambiguous", basis: "exact-signature" },
      });
      expect(result.summary).toMatchObject({
        added: 0,
        removed: 0,
        unknown: 1,
      });
      expect(
        item.match.candidate_left_tokens.length +
          item.match.candidate_right_tokens.length,
      ).toBe(3);
    }
  });

  it("contests ownerless undecoded fields by raw signature", () => {
    const base = inspect(
      buildManagedPeFixture({ fieldSignature: Buffer.from([0x06, 0x7f]) }),
      "/tmp/ownerless-field-signatures.dll",
    );
    const [field] = base.result.fields;
    if (field === undefined) throw new Error("Expected a fixture field");
    expect(field.signature.parse_status).toBe("unsupported");
    const withOwnerless = {
      ...base,
      result: {
        ...base.result,
        methods: [],
        fields: [
          field,
          {
            ...field,
            token: "0x04000002",
            declaring_type: null,
            declaring_type_token: null,
          },
        ],
      },
    };
    const resolvedOnly = {
      ...base,
      result: { ...base.result, methods: [], fields: [field] },
    };
    for (const result of [
      compareManagedMembers(withOwnerless, resolvedOnly),
      compareManagedMembers(resolvedOnly, withOwnerless),
    ])
      expect(
        result.fields.filter(({ match }) => match.status === "matched"),
      ).toEqual([]);
  });
});

describe("managed member comparison of consumed ownerless ambiguity", () => {
  it("keeps a consumed ownerless ambiguity from authorizing a later remap", () => {
    const base = inspect(
      buildManagedPeFixture(),
      "/tmp/consumed-ownerless.dll",
    );
    const [method] = base.result.methods;
    if (method === undefined) throw new Error("Expected a fixture method");
    const ownerTypes = new Map(
      ["T", "D", "U"].map((name, index) => [
        name,
        namedTypeFact(name, "", `0x0200000${String(index + 3)}`),
      ]),
    );
    const candidate = (
      raw: string,
      token: string,
      owner: string | null,
      name: string,
      stack: number,
    ) => ({
      ...method,
      token,
      declaring_type: owner,
      declaring_type_token:
        owner === null ? null : ownerTypes.get(owner)!.token,
      name,
      // An operand-free signature: its resolved digest is the raw one.
      signature: {
        ...method.signature,
        raw_sha256: raw.repeat(64),
        resolved_sha256: raw.repeat(64),
      },
      body: {
        ...method.body,
        normalized_il_sha256: raw.repeat(64),
        max_stack: stack,
      },
    });
    const left = {
      ...base,
      result: {
        ...base.result,
        types: [...base.result.types, ...ownerTypes.values()],
        fields: [],
        methods: [
          candidate("a", "0x06000001", "T", "M", 1),
          candidate("b", "0x06000002", null, "M", 1),
          candidate("b", "0x06000003", "D", "D", 2),
        ],
      },
    };
    const right = {
      ...base,
      result: {
        ...base.result,
        types: [...base.result.types, ...ownerTypes.values()],
        fields: [],
        methods: [
          candidate("c", "0x06000001", "U", "N", 1),
          candidate("b", "0x06000002", null, "M", 1),
          candidate("d", "0x06000003", "T", "M", 3),
        ],
      },
    };
    for (const result of [
      compareManagedMembers(left, right),
      compareManagedMembers(right, left),
    ]) {
      expect(result.matching.ambiguous).toBeGreaterThan(0);
      expect(
        result.methods.filter(({ match }) => match.status === "matched"),
      ).toEqual([]);
    }
  });
});

describe("managed member comparison of retained ownership contention", () => {
  it("keeps changed counterparts unknown after an ownerless candidate is held", () => {
    const base = inspect(buildManagedPeFixture(), "/tmp/held-ownerless.dll");
    const [method] = base.result.methods;
    if (method === undefined) throw new Error("Expected a fixture method");
    const body = (hash: string, stack: number) => ({
      ...method.body,
      il_sha256: hash.repeat(64),
      normalized_il_sha256: hash.repeat(64),
      max_stack: stack,
    });
    const ownerless = {
      ...method,
      token: "0x06000002",
      declaring_type: null,
      declaring_type_token: null,
      body: body("b", 2),
    };
    const left = {
      ...base,
      result: {
        ...base.result,
        fields: [],
        methods: [{ ...method, body: body("a", 1) }, ownerless],
      },
    };
    const right = {
      ...base,
      result: {
        ...base.result,
        types: [
          ...base.result.types,
          namedTypeFact("Twin", "Other", "0x02000003"),
        ],
        fields: [],
        methods: [
          { ...method, body: body("c", 3) },
          {
            ...method,
            token: "0x06000002",
            declaring_type: "Other.Twin",
            declaring_type_token: "0x02000003",
            name: "Copy",
            body: ownerless.body,
          },
        ],
      },
    };
    for (const result of [
      compareManagedMembers(left, right),
      compareManagedMembers(right, left),
    ]) {
      expect(result.summary).toEqual({
        unchanged: 0,
        changed: 0,
        added: 0,
        removed: 0,
        unknown: 2,
      });
      expect(result.methods).toEqual([
        expect.objectContaining({
          status: "unknown",
          match: {
            status: "ambiguous",
            basis: "exact-il-signature",
            confidence: "unknown",
            candidate_left_tokens: ["0x06000002"],
            candidate_right_tokens: ["0x06000002"],
          },
        }),
        expect.objectContaining({
          status: "unknown",
          match: {
            status: "ambiguous",
            basis: "exact-signature",
            confidence: "unknown",
            candidate_left_tokens: ["0x06000001"],
            candidate_right_tokens: ["0x06000001"],
          },
        }),
      ]);
    }
  });
});

describe("managed member comparison of ownerless structural competitors", () => {
  it("keeps structural competitors of an ownerless method ambiguous in both directions", () => {
    const base = inspect(
      buildManagedPeFixture(),
      "/tmp/ownerless-shape-competitors.dll",
    );
    const [method] = base.result.methods;
    if (method === undefined) throw new Error("Expected a fixture method");
    const withSignature = (raw: string, token: string) => ({
      ...method,
      token,
      signature: { ...method.signature, raw_sha256: raw.repeat(64) },
    });
    const withOwnerless = {
      ...base,
      result: {
        ...base.result,
        methods: [
          withSignature("a", "0x06000001"),
          {
            ...withSignature("b", "0x06000002"),
            declaring_type: null,
            declaring_type_token: null,
          },
        ],
        fields: [],
      },
    };
    const resolvedOnly = {
      ...base,
      result: {
        ...base.result,
        methods: [withSignature("c", "0x06000001")],
        fields: [],
      },
    };
    for (const result of [
      compareManagedMembers(withOwnerless, resolvedOnly),
      compareManagedMembers(resolvedOnly, withOwnerless),
    ]) {
      expect(result.matching.ambiguous).toBe(1);
      expect(
        result.methods.filter(({ match }) => match.status === "matched"),
      ).toEqual([]);
      expect(result.summary).toMatchObject({ added: 0, removed: 0 });
    }
  });
});

it("keeps a lone ownerless member unknown despite an identical payload", () => {
  const base = inspect(buildManagedPeFixture(), "/tmp/ownerless-lone.dll");
  const [method] = base.result.methods;
  if (method === undefined) throw new Error("Expected a fixture method");
  const ownerless = {
    ...method,
    declaring_type: null,
    declaring_type_token: null,
  };
  const side = {
    ...base,
    result: { ...base.result, methods: [ownerless], fields: [] },
  };

  const result = compareManagedMembers(side, side);

  expect(result.matching.ambiguous).toBe(1);
  expect(
    result.methods.filter(({ match }) => match.status === "matched"),
  ).toHaveLength(0);
  expect(result.methods[0]).toMatchObject({
    status: "unknown",
    match: {
      status: "ambiguous",
      candidate_left_tokens: [ownerless.token],
      candidate_right_tokens: [ownerless.token],
    },
    limitations: [
      expect.stringContaining("Declared type identity remains unresolved"),
    ],
  });
  expect(result.summary).toMatchObject({
    unchanged: 0,
    added: 0,
    removed: 0,
    unknown: 1,
  });
});

describe("managed member comparison of ownerless members", () => {
  it("keeps an ownerless member ambiguous beside a resolved copy, as main does", () => {
    const base = inspect(buildManagedPeFixture(), "/tmp/ownerless-copy.dll");
    const [method] = base.result.methods;
    if (method === undefined) throw new Error("Expected a fixture method");
    const ownerless = {
      ...method,
      declaring_type: null,
      declaring_type_token: null,
    };
    const left = {
      ...base,
      result: { ...base.result, methods: [ownerless], fields: [] },
    };
    // The right keeps the ownerless Foo and a resolved copy with the same
    // CIL and signature; the left Foo's owner may be either one.
    const right = {
      ...base,
      result: {
        ...base.result,
        methods: [ownerless, { ...method, token: "0x06000002" }],
        fields: [],
      },
    };

    for (const result of [
      compareManagedMembers(left, right),
      compareManagedMembers(right, left),
    ]) {
      expect(result.matching.ambiguous).toBe(1);
      expect(
        result.methods.filter(({ match }) => match.status === "matched"),
      ).toEqual([]);
      expect(result.summary).toMatchObject({ added: 0, removed: 0 });
    }
  });

  it("keeps a resolved copy out of the declared round when an ownerless competitor is on the left, as main does", () => {
    const base = inspect(buildManagedPeFixture(), "/tmp/ownerless-left.dll");
    const [method] = base.result.methods;
    if (method === undefined) throw new Error("Expected a fixture method");
    const ownerless = {
      ...method,
      declaring_type: null,
      declaring_type_token: null,
    };
    // The left holds the resolved Foo and an ownerless Foo with the same CIL
    // and signature; the right holds only the resolved Foo. The ownerless
    // Foo's owner may be the resolved one, so the three stay ambiguous.
    const withOwnerless = {
      ...base,
      result: { ...base.result, methods: [method, ownerless], fields: [] },
    };
    const resolvedOnly = {
      ...base,
      result: { ...base.result, methods: [method], fields: [] },
    };

    const result = compareManagedMembers(withOwnerless, resolvedOnly);

    expect(result.matching.ambiguous).toBe(1);
    expect(
      result.methods.filter(({ match }) => match.status === "matched"),
    ).toEqual([]);
    expect(result.summary).toMatchObject({ added: 0, removed: 0 });
  });

  it("keeps a resolved copy out of the declared round when an ownerless competitor is on the right, as main does", () => {
    const base = inspect(buildManagedPeFixture(), "/tmp/ownerless-right.dll");
    const [method] = base.result.methods;
    if (method === undefined) throw new Error("Expected a fixture method");
    const ownerless = {
      ...method,
      declaring_type: null,
      declaring_type_token: null,
    };
    const withOwnerless = {
      ...base,
      result: { ...base.result, methods: [method, ownerless], fields: [] },
    };
    const resolvedOnly = {
      ...base,
      result: { ...base.result, methods: [method], fields: [] },
    };

    const result = compareManagedMembers(resolvedOnly, withOwnerless);

    expect(result.matching.ambiguous).toBe(1);
    expect(
      result.methods.filter(({ match }) => match.status === "matched"),
    ).toEqual([]);
    expect(result.summary).toMatchObject({ added: 0, removed: 0 });
  });

  it("keeps an ownerless method ambiguous beside a resolved method of the same shape", () => {
    const base = inspect(buildManagedPeFixture(), "/tmp/ownerless-shape.dll");
    const [method] = base.result.methods;
    if (method === undefined) throw new Error("Expected a fixture method");
    const ownerless = {
      ...method,
      declaring_type: null,
      declaring_type_token: null,
    };
    // Raw signature digests differ, so only the decoded shape links them.
    const reshaped = (raw: string, token: string) => ({
      signature: { ...method.signature, raw_sha256: raw.repeat(64) },
      token,
    });
    const left = {
      ...base,
      result: { ...base.result, methods: [ownerless], fields: [] },
    };
    const right = {
      ...base,
      result: {
        ...base.result,
        methods: [
          { ...ownerless, ...reshaped("e", "0x06000001") },
          { ...method, name: "Bar", ...reshaped("d", "0x06000002") },
        ],
        fields: [],
      },
    };
    const result = compareManagedMembers(left, right);

    expect(result.matching.ambiguous).toBe(1);
    expect(
      result.methods.filter(({ match }) => match.status === "matched"),
    ).toEqual([]);
  });
});

describe("managed member comparison of unresolved owners", () => {
  it("does not pair members of unresolved types under different names", () => {
    const base = inspect(buildManagedPeFixture(), "/tmp/orphan-names.dll");
    const [method] = base.result.methods;
    if (method === undefined) throw new Error("Expected a fixture method");
    const orphan = { declaring_type: null, declaring_type_token: null };
    const side = (name: string) => ({
      ...base,
      result: {
        ...base.result,
        methods: [{ ...method, ...orphan, name }],
        fields: [],
      },
    });
    const result = compareManagedMembers(side("Main"), side("Renamed"));

    for (const item of result.methods)
      expect(item.match.status).not.toBe("matched");
  });

  it("keeps ownerless members that share a body ambiguous, as main does", () => {
    const base = inspect(buildManagedPeFixture(), "/tmp/orphan-self.dll");
    const [method] = base.result.methods;
    const [field] = base.result.fields;
    if (method === undefined || field === undefined)
      throw new Error("Expected a fixture method and field");
    const orphan = { declaring_type: null, declaring_type_token: null };
    const inspected = {
      ...base,
      result: {
        ...base.result,
        methods: [
          { ...method, ...orphan, name: "p" },
          { ...method, ...orphan, name: "q", token: "0x06000002" },
        ],
        fields: [
          { ...field, ...orphan, name: "a" },
          { ...field, ...orphan, name: "b", token: "0x04000002" },
        ],
      },
    };
    const result = compareManagedMembers(inspected, inspected);

    // Their owners are unknown, so `p` may be `q`; names alone cannot tell.
    expect(result.matching.ambiguous).toBe(2);
    expect(
      [...result.methods, ...result.fields].filter(
        ({ match }) => match.status === "matched",
      ),
    ).toEqual([]);
  });

  it("does not remap a member whose own identity is in an ambiguous group", () => {
    const undecoded = { methodSignature: Buffer.from([0x00, 0x00, 0x7f]) };
    const decoded = inspect(buildManagedPeFixture(), "/tmp/held-decoded.dll");
    const held = inspect(buildManagedPeFixture(undecoded), "/tmp/held.dll");
    const [undecodedMethod] = held.result.methods;
    const [decodedMethod] = decoded.result.methods;
    if (undecodedMethod === undefined || decodedMethod === undefined)
      throw new Error("Expected fixture methods");
    // The right keeps two identical undecoded Fixture.Program.Main, which
    // stay ambiguous, and a copy of the decoded Main in another type.
    const left = {
      ...held,
      result: {
        ...held.result,
        methods: [{ ...undecodedMethod, token: "0x06000002" }, decodedMethod],
      },
    };
    const right = {
      ...held,
      result: {
        ...held.result,
        types: [
          ...held.result.types,
          namedTypeFact("Twin", "Other", "0x02000003"),
        ],
        methods: [
          undecodedMethod,
          { ...undecodedMethod, token: "0x06000002" },
          {
            ...decodedMethod,
            declaring_type: "Other.Twin",
            declaring_type_token: "0x02000003",
            token: "0x06000003",
          },
        ],
      },
    };

    for (const result of [
      compareManagedMembers(left, right),
      compareManagedMembers(right, left),
    ])
      expect(
        result.methods.filter(({ match }) => match.status === "matched"),
      ).toEqual([]);
  });

  it("does not remap a member whose declaring type is unresolved", () => {
    const base = inspect(buildManagedPeFixture(), "/tmp/orphan.dll");
    const [method] = base.result.methods;
    if (method === undefined) throw new Error("Expected a fixture method");
    const left = {
      ...base,
      result: {
        ...base.result,
        methods: [
          { ...method, declaring_type: null, declaring_type_token: null },
        ],
        fields: [],
      },
    };
    const right = {
      ...base,
      result: {
        ...base.result,
        types: [
          ...base.result.types,
          namedTypeFact("Twin", "Other", "0x02000003"),
        ],
        methods: [
          {
            ...method,
            declaring_type: "Other.Twin",
            declaring_type_token: "0x02000003",
            token: "0x06000002",
          },
        ],
        fields: [],
      },
    };

    for (const result of [
      compareManagedMembers(left, right),
      compareManagedMembers(right, left),
    ])
      for (const item of result.methods)
        expect(item.match.status).not.toBe("matched");
  });
});

// Signatures name types by TypeDef/TypeRef row. The right build inserts a
// TypeDef and a TypeRef ahead of the ones its members use, so the same
// types sit at different rows and the raw signature bytes differ.
const LIST_REFERENCE = {
  namespace: "System.Collections.Generic",
  name: "List`1",
};
const leftBuild = {
  typeReferences: [LIST_REFERENCE],
};
const rightBuild = {
  additionalEmptyTypes: 1,
  typeReferences: [{ namespace: "System", name: "Uri" }, LIST_REFERENCE],
};
// List`1 is TypeRef row 2 on the left and row 3 on the right; Program is
// TypeDef row 1 on the left and row 2 on the right.
const leftTypes = { list: (2 << 2) | 1, program: 1 << 2 };
const rightTypes = { list: (3 << 2) | 1, program: 2 << 2 };
// List`1<Program> counter
const fieldSignature = (types: typeof leftTypes) =>
  Buffer.from([0x06, 0x15, 0x12, types.list, 0x01, 0x12, types.program]);
// List`1<Program> Main(Program)
const methodSignature = (types: typeof leftTypes) =>
  Buffer.from([
    0x00,
    0x01,
    0x15,
    0x12,
    types.list,
    0x01,
    0x12,
    types.program,
    0x12,
    types.program,
  ]);
const changedIl = Buffer.from([
  0x32, 0x02, 0x7b, 0x02, 0x00, 0x00, 0x04, 0x28, 0x02, 0x00, 0x00, 0x0a, 0x2a,
]);

const compareBuilds = (
  left: Parameters<typeof buildManagedPeFixture>[0],
  right: Parameters<typeof buildManagedPeFixture>[0],
) => {
  const leftInspection = inspect(
    buildManagedPeFixture(left),
    "/tmp/left-build.dll",
  );
  const rightInspection = inspect(
    buildManagedPeFixture(right),
    "/tmp/right-build.dll",
  );
  return compareManagedMembers(
    { evidenceId: leftInspection.evidenceId, result: leftInspection.result },
    {
      evidenceId: rightInspection.evidenceId,
      result: rightInspection.result,
    },
  );
};

describe("managed member comparison across builds", () => {
  it("pairs members whose signatures name the same types at different metadata rows", () => {
    const result = compareBuilds(
      {
        ...leftBuild,
        fieldSignature: fieldSignature(leftTypes),
        methodSignature: methodSignature(leftTypes),
      },
      {
        ...rightBuild,
        fieldSignature: fieldSignature(rightTypes),
        methodSignature: methodSignature(rightTypes),
      },
    );

    expect(result.methods).toEqual([
      expect.objectContaining({
        status: "unchanged",
        dimensions: [],
        match: expect.objectContaining({ basis: "exact-il-signature" }),
      }),
    ]);
    expect(result.fields).toEqual([
      expect.objectContaining({
        status: "unchanged",
        match: expect.objectContaining({ basis: "field-signature" }),
      }),
    ]);
  });

  it("pairs a method by declared type, name, and resolved signature when its CIL changed", () => {
    const result = compareBuilds(
      { ...leftBuild, methodSignature: methodSignature(leftTypes) },
      {
        ...rightBuild,
        methodSignature: methodSignature(rightTypes),
        ilBody: changedIl,
      },
    );

    expect(result.methods).toEqual([
      expect.objectContaining({
        status: "changed",
        dimensions: ["cil"],
        match: expect.objectContaining({ basis: "exact-signature" }),
      }),
    ]);
  });

  it("pairs a renamed method by structural shape when its signature names the same types", () => {
    const result = compareBuilds(
      { ...leftBuild, methodSignature: methodSignature(leftTypes) },
      {
        ...rightBuild,
        methodName: "Renamed",
        methodSignature: methodSignature(rightTypes),
        ilBody: changedIl,
      },
    );

    expect(result.methods).toEqual([
      expect.objectContaining({
        status: "changed",
        match: expect.objectContaining({
          basis: "structural-method-shape",
          confidence: "high",
        }),
      }),
    ]);
  });

  it("does not pair members whose identical signature bytes name different types", () => {
    // TypeDef row 1 is Program on the left and Empty0 on the right.
    const result = compareBuilds(
      {
        fieldSignature: Buffer.from([0x06, 0x12, leftTypes.program]),
        methodSignature: Buffer.from([0x00, 0x00, 0x12, leftTypes.program]),
      },
      {
        additionalEmptyTypes: 1,
        fieldSignature: Buffer.from([0x06, 0x12, leftTypes.program]),
        methodSignature: Buffer.from([0x00, 0x00, 0x12, leftTypes.program]),
      },
    );

    expect(result.methods.map(({ status }) => status).sort()).toEqual([
      "added",
      "removed",
    ]);
    expect(result.fields.map(({ status }) => status).sort()).toEqual([
      "added",
      "removed",
    ]);
  });
});

describe("managed member comparison of resolved signatures", () => {
  it("pairs a partially decoded field by declared type, name, and resolved signature", () => {
    // Trailing data after the field type leaves the signature partial.
    const result = compareBuilds(
      { fieldSignature: Buffer.from([0x06, 0x12, leftTypes.program, 0x00]) },
      {
        additionalEmptyTypes: 1,
        fieldSignature: Buffer.from([0x06, 0x12, rightTypes.program, 0x00]),
      },
    );

    expect(result.fields).toEqual([
      expect.objectContaining({
        status: "unchanged",
        match: expect.objectContaining({ basis: "exact-signature" }),
      }),
    ]);
  });

  it("does not pair a raw digest with an equal resolved digest", () => {
    // class Fixture.Program on the left; on the right, the bytes of its
    // resolved preimage, which do not decode and so compare by raw digest.
    const programDigest = createHash("sha256")
      .update(Buffer.from([0]))
      .update("Fixture")
      .update(Buffer.from([0]))
      .update("Program")
      .digest();
    const left = inspect(
      buildManagedPeFixture({
        methodSignature: Buffer.from([0x00, 0x00, 0x12, leftTypes.program]),
      }),
      "/tmp/left-collision.dll",
    );
    const right = inspect(
      buildManagedPeFixture({
        methodSignature: Buffer.concat([
          Buffer.from([0x00, 0x00, 0x12, 0xff]),
          programDigest,
        ]),
      }),
      "/tmp/right-collision.dll",
    );
    // The collision this guards against must exist: the right blob does not
    // decode, and its raw digest is the left signature's resolved digest.
    const [leftMethod] = left.result.methods;
    const [rightMethod] = right.result.methods;
    expect(rightMethod?.signature.resolved_sha256).toBeNull();
    expect(rightMethod?.signature.raw_sha256).toBe(
      leftMethod?.signature.resolved_sha256,
    );

    const result = compareManagedMembers(
      { evidenceId: left.evidenceId, result: left.result },
      { evidenceId: right.evidenceId, result: right.result },
    );

    expect(
      result.methods.filter(({ match }) => match.status === "matched"),
    ).toEqual([]);
  });

  it("compares raw signatures against Evidence recorded before resolution", () => {
    // Both signatures name Program, TypeDef row 1, in the same build.
    const build = () =>
      buildManagedPeFixture({
        fieldSignature: Buffer.from([0x06, 0x12, leftTypes.program]),
        methodSignature: Buffer.from([
          0x00,
          0x01,
          0x01,
          0x12,
          leftTypes.program,
        ]),
      });
    const left = inspect(build(), "/tmp/left-recorded.dll");
    const right = inspect(build(), "/tmp/right-current.dll");
    const withoutResolution = <Member extends { signature: object }>(
      members: readonly Member[],
    ) =>
      members.map((member) => {
        const { resolved_sha256: _omitted, ...recorded } = member.signature as {
          resolved_sha256: unknown;
        };
        return { ...member, signature: recorded };
      });
    const recorded = managedMemberInspectionSchema.parse({
      ...left.result,
      signature_resolution: undefined,
      methods: withoutResolution(left.result.methods),
      fields: withoutResolution(left.result.fields),
      member_refs: withoutResolution(left.result.member_refs),
    });
    expect(recorded.methods[0]?.signature.resolved_sha256).toBeNull();

    const result = compareManagedMembers(
      { evidenceId: left.evidenceId, result: recorded },
      { evidenceId: right.evidenceId, result: right.result },
    );

    expect(result.methods).toEqual([
      expect.objectContaining({ status: "unchanged" }),
    ]);
    expect(result.fields).toEqual([
      expect.objectContaining({ status: "unchanged" }),
    ]);
    expect(result.limitations).toContain(
      "At least one managed member observation does not attest signature type-name resolution, so signatures compare by raw bytes, which name types by build-local metadata row.",
    );
  });
});

describe("managed member comparison of nested signature types", () => {
  const fieldOfType = (codedIndex: number) =>
    Buffer.from([0x06, 0x12, codedIndex]);
  const statuses = (result: ReturnType<typeof compareBuilds>) =>
    result.fields.map(({ status }) => status).sort();

  it("pairs a nested TypeDef by its enclosing type at different rows", () => {
    // Fixture.Empty0/Fixture.Program is TypeDef row 2, then row 3.
    const result = compareBuilds(
      {
        additionalEmptyTypes: 1,
        nestedTypes: [[2, 1]],
        fieldSignature: fieldOfType(2 << 2),
      },
      {
        additionalEmptyTypes: 2,
        nestedTypes: [[3, 1]],
        fieldSignature: fieldOfType(3 << 2),
      },
    );

    expect(statuses(result)).toEqual(["unchanged"]);
  });

  it("tells same-named TypeDefs apart by their enclosing types", () => {
    // TypeDef row 2 is nested in Empty0 on the left only.
    const result = compareBuilds(
      {
        additionalEmptyTypes: 2,
        nestedTypes: [[2, 1]],
        fieldSignature: fieldOfType(2 << 2),
      },
      { additionalEmptyTypes: 2, fieldSignature: fieldOfType(2 << 2) },
    );

    expect(statuses(result)).toEqual(["added", "removed"]);
  });

  it("does not name a TypeDef whose nesting is cyclic", () => {
    const bytes = buildManagedPeFixture({
      additionalEmptyTypes: 2,
      nestedTypes: [
        [1, 2],
        [2, 1],
      ],
      fieldSignature: fieldOfType(1 << 2),
    });
    const field = inspect(bytes, "/tmp/cyclic.dll").result.fields[0];

    expect(field?.signature.parse_status).toBe("decoded");
    expect(field?.signature.resolved_sha256).toBeNull();
  });

  const enumerator = (enclosingRow: number) => ({
    namespace: "",
    name: "Enumerator",
    enclosingRow,
  });
  const list = { namespace: "System.Collections.Generic", name: "List`1" };
  const dictionary = {
    namespace: "System.Collections.Generic",
    name: "Dictionary`2",
  };

  it("pairs a nested TypeRef by its enclosing TypeRef at different rows", () => {
    // List`1/Enumerator is TypeRef row 3, then row 4.
    const result = compareBuilds(
      {
        typeReferences: [list, enumerator(2)],
        fieldSignature: fieldOfType((3 << 2) | 1),
      },
      {
        typeReferences: [dictionary, list, enumerator(3)],
        fieldSignature: fieldOfType((4 << 2) | 1),
      },
    );

    expect(statuses(result)).toEqual(["unchanged"]);
  });

  it("tells same-named TypeRefs apart by their enclosing TypeRefs", () => {
    // List`1/Enumerator on the left, Dictionary`2/Enumerator on the right.
    const result = compareBuilds(
      {
        typeReferences: [list, enumerator(2)],
        fieldSignature: fieldOfType((3 << 2) | 1),
      },
      {
        typeReferences: [dictionary, enumerator(2)],
        fieldSignature: fieldOfType((3 << 2) | 1),
      },
    );

    expect(statuses(result)).toEqual(["added", "removed"]);
  });
});

describe("managed member comparison of unresolved signatures", () => {
  // A TypeSpec operand has no name, so the method compares by raw bytes,
  // while the default field resolves.
  const typeSpecs = [Buffer.from([0x1d, 0x08]), Buffer.from([0x1d, 0x0e])];
  const unresolvedAt = (row: number) => ({
    typeSpecSignatures: typeSpecs,
    methodSignature: Buffer.from([0x00, 0x00, 0x12, (row << 2) | 2]),
  });
  const resolved = {
    methodSignature: Buffer.from([0x00, 0x00, 0x12, leftTypes.program]),
  };
  const methodLimitations = (result: ReturnType<typeof compareBuilds>) =>
    result.methods.map(({ status, limitations }) => [status, limitations]);

  it("does not establish unchanged signatures from identical unresolved row bytes", () => {
    const result = compareBuilds(unresolvedAt(1), {
      ...unresolvedAt(1),
      typeSpecSignatures: [...typeSpecs].reverse(),
    });
    expect(methodLimitations(result)).toEqual([
      ["unknown", [expect.stringMatching(/^signature-not-resolved:/u)]],
    ]);
  });

  it("retains a known CIL change beside an unresolved signature", () => {
    const result = compareBuilds(unresolvedAt(1), {
      ...unresolvedAt(1),
      ilBody: Buffer.from([0x0a, 0x17, 0x2a]),
    });
    expect(methodLimitations(result)).toEqual([
      ["changed", [expect.stringMatching(/^signature-not-resolved:/u)]],
    ]);
    expect(result.methods[0]?.dimensions).toContain("cil");
  });

  it("keeps a partially decoded field's unresolved type unknown after pairing", () => {
    const fieldSignature = Buffer.from([0x06, 0x12, (1 << 2) | 2, 0xff]);
    const result = compareBuilds(
      { typeSpecSignatures: typeSpecs, fieldSignature },
      { typeSpecSignatures: [...typeSpecs].reverse(), fieldSignature },
    );
    expect(result.fields).toEqual([
      expect.objectContaining({
        status: "unknown",
        limitations: [expect.stringMatching(/^signature-not-resolved:/u)],
      }),
    ]);
  });

  it("retains unknown signatures when every member has an unresolved operand", () => {
    const at = (row: number) => ({
      ...unresolvedAt(row),
      fieldSignature: Buffer.from([0x06, 0x12, (row << 2) | 2]),
    });
    const result = compareBuilds(at(1), at(2));
    expect(
      [...result.methods, ...result.fields].map(({ status }) => status),
    ).toEqual(["unknown", "unknown", "unknown", "unknown"]);
    expect(result.limitations).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "does not attest signature type-name resolution",
        ),
      ]),
    );
  });

  it("keeps an unmatched unresolved method unknown in a resolved comparison", () => {
    for (const result of [
      compareBuilds(unresolvedAt(1), unresolvedAt(2)),
      compareBuilds(unresolvedAt(2), unresolvedAt(1)),
    ])
      expect(methodLimitations(result)).toEqual([
        ["unknown", [expect.stringMatching(/^signature-not-resolved:/u)]],
        ["unknown", [expect.stringMatching(/^signature-not-resolved:/u)]],
      ]);
  });

  it("keeps a resolved method unknown beside an unresolved same-named counterpart", () => {
    for (const [left, right] of [
      [unresolvedAt(1), resolved],
      [resolved, unresolvedAt(1)],
    ] as const) {
      const result = compareBuilds(left, right);
      const unresolvedSide = left === resolved ? "right" : "left";
      expect(
        result.methods.map(({ status, left: leftItem, limitations }) => [
          status,
          (leftItem === null) === (unresolvedSide === "left")
            ? "resolved"
            : "unresolved",
          limitations,
        ]),
      ).toEqual(
        expect.arrayContaining([
          [
            "unknown",
            "unresolved",
            [expect.stringMatching(/^signature-not-resolved:/u)],
          ],
          [
            "unknown",
            "resolved",
            [
              expect.stringMatching(
                new RegExp(
                  `^counterpart-signature-not-resolved: The ${unresolvedSide} method inventory`,
                  "u",
                ),
              ),
            ],
          ],
        ]),
      );
    }
  });
});

describe("managed member comparison limitations for resolved signatures", () => {
  it("does not report missing resolved digests for observations without signatures", () => {
    const base = inspect(buildManagedPeFixture(), "/tmp/no-members.dll");
    const empty = {
      ...base,
      result: { ...base.result, methods: [], fields: [] },
    };
    const result = compareManagedMembers(empty, empty);

    expect(result.limitations).not.toContain(
      "At least one managed member observation does not attest signature type-name resolution, so signatures compare by raw bytes, which name types by build-local metadata row.",
    );
  });
});

describe("managed member comparison of resolved-signature contention", () => {
  it("contests an ownerless method across builds whose raw signature bytes differ", () => {
    const base = inspect(buildManagedPeFixture(), "/tmp/ownerless-builds.dll");
    const [method] = base.result.methods;
    if (method === undefined) throw new Error("Expected a fixture method");
    // The same signature names a type at another row in the right build.
    const member = (raw: string, body: string, stack: number) => ({
      ...method,
      signature: {
        ...method.signature,
        raw_sha256: raw.repeat(64),
        resolved_sha256: "e".repeat(64),
      },
      body: {
        ...method.body,
        normalized_il_sha256: body.repeat(64),
        max_stack: stack,
      },
    });
    const withOwnerless = {
      ...base,
      result: {
        ...base.result,
        fields: [],
        methods: [
          member("a", "a", 1),
          {
            ...member("a", "b", 2),
            token: "0x06000002",
            declaring_type: null,
            declaring_type_token: null,
          },
        ],
      },
    };
    const resolvedOnly = {
      ...base,
      result: { ...base.result, fields: [], methods: [member("f", "c", 3)] },
    };
    for (const result of [
      compareManagedMembers(withOwnerless, resolvedOnly),
      compareManagedMembers(resolvedOnly, withOwnerless),
    ]) {
      expect(result.methods).toEqual([
        expect.objectContaining({
          status: "unknown",
          match: expect.objectContaining({
            status: "ambiguous",
            basis: "exact-signature",
          }),
        }),
      ]);
      expect(result.summary).toMatchObject({ added: 0, removed: 0 });
    }
  });
});

/**
 * Add copies of the fixture's method and field, each pair declared by another
 * type, to an inspection. The copies come from `source`, so they can carry
 * the bytes of a different build than the inspection they join.
 */
const namedTypeFact = (
  typeName: string,
  typeNamespace: string,
  token: string,
) => {
  const type = inspect(
    buildManagedPeFixture({ typeName, typeNamespace }),
    `/fixture/${typeNamespace}/${typeName}.dll`,
  ).result.types.find(
    (type) => type.name === typeName && type.namespace === typeNamespace,
  );
  if (type === undefined || type.name_sha256 === null)
    throw new Error("Expected a named fixture TypeDef");
  return { ...type, token };
};

const withTwin = (
  inspected: ReturnType<typeof inspect>,
  source: ReturnType<typeof inspect> = inspected,
  count = 1,
): ReturnType<typeof inspect> => {
  const [method] = source.result.methods;
  const [field] = source.result.fields;
  if (method === undefined || field === undefined)
    throw new Error("Expected a fixture method and field");
  const rows = Array.from({ length: count }, (_, index) => index + 2);
  // This consumer fixture needs matching TypeDef facts as well as member
  // facts. Obtain nominal digests from the production metadata owner; copying
  // only display names leaves declaring_type_token pointing at a missing row.
  const types = rows.map((row) =>
    namedTypeFact(
      row === 2 ? "Twin" : `Twin${String(row)}`,
      "Other",
      `0x0200000${String(row + 1)}`,
    ),
  );
  const twin = (row: number) => ({
    declaring_type: types[row - 2]!.full_name,
    declaring_type_token: types[row - 2]!.token,
  });
  return {
    ...inspected,
    result: {
      ...inspected.result,
      types: [...inspected.result.types, ...types],
      methods: [
        ...inspected.result.methods,
        ...rows.map((row) => ({
          ...method,
          ...twin(row),
          token: `0x0600000${String(row)}`,
        })),
      ],
      fields: [
        ...inspected.result.fields,
        ...rows.map((row) => ({
          ...field,
          ...twin(row),
          token: `0x0400000${String(row)}`,
        })),
      ],
    },
  };
};

const inspect = (bytes: Buffer, path: string, typeNames?: string[]) => {
  const target = managedPeFixtureTarget(bytes, path);
  const result = inspectManagedMembersBytes(
    bytes,
    target,
    typeNames === undefined ? {} : { typeNames },
  );
  return {
    result,
    evidenceId: `ev_${hash(Buffer.from(path))}`,
  };
};

const hash = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");
