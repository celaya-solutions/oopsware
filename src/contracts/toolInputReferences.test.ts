import { Ajv } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { presentInputJsonSchema } from "./inputSchemaPresentation.js";
import { toolContract } from "./toolContracts.js";
import {
  toolInputSchemaWithMetadata,
  transformAdvertisedInputJsonSchema,
} from "./toolSchemaMetadata.js";
import { JAVASCRIPT_APPLICATION_EVIDENCE_EXAMPLE } from "./javascript/javascriptRuntimeReconciliationExample.js";

it.each(["draft-2020-12", "draft-07"] as const)(
  "honors projection options independently of cached wire transformations in %s",
  (target) => {
    const range = z.strictObject({ offset: z.number(), length: z.number() });
    const canonical = z.strictObject({ before: range, after: range });
    const transform = (schema: Record<string, unknown>) => ({
      ...schema,
      title: "Transformed range inputs",
    });
    const options = { target, libraryOptions: { reused: "ref" as const } };
    for (const sharedFirst of [false, true]) {
      const wrapped = transformAdvertisedInputJsonSchema(canonical, transform);
      const project = wrapped["~standard"].jsonSchema.input;
      if (sharedFirst) project(options);
      const advertised = project({ target });
      expect(JSON.stringify(advertised)).not.toContain('"$ref":');
      expect(advertised).toEqual(
        transform(canonical["~standard"].jsonSchema.input({ target })),
      );
      const shared = project(options);
      expect(JSON.stringify(shared)).toContain('"$ref":');
      expect(shared).toEqual(
        transform(canonical["~standard"].jsonSchema.input(options)),
      );
      expect(project({ target })).toBe(advertised);
    }
  },
);

it.each(["draft-2020-12", "draft-07"] as const)(
  "preserves the complete inline Evidence contract before deferred authentication in %s",
  (target) => {
    const schema = toolInputSchemaWithMetadata(
      toolContract("inspect_analysis_view"),
    )["~standard"].jsonSchema.input({ target });
    const ajv =
      target === "draft-2020-12"
        ? new Ajv2020({ strict: false, validateFormats: false })
        : new Ajv({ strict: false, validateFormats: false });
    expect(ajv.validateSchema(schema)).toBe(true);
    const validate = ajv.compile(schema);
    const input = {
      source: {
        kind: "inline",
        evidence: JAVASCRIPT_APPLICATION_EVIDENCE_EXAMPLE,
      },
      view: { kind: "summary" },
    };
    expect(validate(input), JSON.stringify(validate.errors)).toBe(true);
    expect(
      validate({ ...input, source: { kind: "inline", evidence: {} } }),
    ).toBe(false);
    expect(validate({ ...input, source: { kind: "inline" } })).toBe(false);
  },
);

it.each(["draft-2020-12", "draft-07"] as const)(
  "keeps objdump Unicode validation and portable SDK patterns in %s",
  (target) => {
    const canonical = toolInputSchemaWithMetadata(
      toolContract("inspect_with_objdump"),
    );
    const schema = canonical["~standard"].jsonSchema.input({ target });
    const input = { path: "sample.elf", operation: "disassemble" };
    for (const unicodeRegExp of [false, true]) {
      const options = { strict: false, validateFormats: false, unicodeRegExp };
      const ajv =
        target === "draft-2020-12" ? new Ajv2020(options) : new Ajv(options);
      expect(ajv.validateSchema(schema)).toBe(true);
      const validate = ajv.compile(schema);
      for (const symbol of [
        "known_function",
        "selector_\u{1F680}",
        "selector_\uFFFD",
      ]) {
        expect(
          validate({ ...input, symbol }),
          JSON.stringify(validate.errors),
        ).toBe(true);
        expect(canonical.safeParse({ ...input, symbol }).success).toBe(true);
      }
      expect(validate({ ...input, symbol: "a\u0000b" })).toBe(false);
    }
    // Scalar Unicode engines cannot express unpaired UTF-16 surrogates. The
    // registered canonical validator owns that runtime constraint.
    for (const symbol of [
      "\ud800",
      "\udc00",
      "prefix\ud800suffix",
      "\udc00\ud800",
    ])
      expect(canonical.safeParse({ ...input, symbol }).success).toBe(false);
  },
);

describe("advertised object dependencies", () => {
  it.each([
    ["draft-07", "dependencies"],
    ["draft-2020-12", "dependentRequired"],
  ] as const)(
    "presents object-group dependencies as guidance without unsupported dialect keywords (%s)",
    (dialect, dependencyKeyword) => {
      const advertised = presentInputJsonSchema(
        {
          $schema:
            dialect === "draft-07"
              ? "http://json-schema.org/draft-07/schema#"
              : "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: { url: { type: "string" }, body: { type: "string" } },
          required: ["body"],
          [dependencyKeyword]: { body: ["url"] },
        },
        () => undefined,
      );
      expect(advertised.$schema).toBe(
        dialect === "draft-07"
          ? "http://json-schema.org/draft-07/schema#"
          : "https://json-schema.org/draft/2020-12/schema",
      );
      expect(advertised).not.toHaveProperty("dependencies");
      expect(advertised).not.toHaveProperty("dependentRequired");
      expect(advertised.description).toContain(
        "When body is provided, also provide url.",
      );
    },
  );
});

describe("advertised production selector contracts", () => {
  it.each(["draft-2020-12", "draft-07"] as const)(
    "preserves production native-selector constraints in %s",
    (target) => {
      const contract = toolContract("observe_native_calls");
      const advertised = toolInputSchemaWithMetadata(contract)[
        "~standard"
      ].jsonSchema.input({ target });
      const ajv =
        target === "draft-2020-12"
          ? new Ajv2020({ strict: false })
          : new Ajv({ strict: false });
      const validate = ajv.compile(advertised);
      for (const selector of [
        "setFoo:",
        "dataTaskWithRequest:completionHandler:",
        "",
        "bad selector:",
        "bad[selector]:",
        "set\0Foo:",
        "setFoo:\n",
      ]) {
        const sample = {
          breakpoints: [
            {
              kind: "objc-method",
              class_name: "NSURLSession",
              selector,
            },
          ],
        };
        expect(validate(sample)).toBe(
          contract.inputSchema.safeParse(sample).success,
        );
      }
      const unexpected = {
        breakpoints: [
          {
            kind: "objc-method",
            class_name: "NSURLSession",
            selector: "setFoo:",
            unexpected: true,
          },
        ],
      };
      expect(contract.inputSchema.safeParse(unexpected).success).toBe(false);
      expect(validate(unexpected)).toBe(false);
    },
  );
});

describe("advertised schema metadata and validation", () => {
  it.each(["draft-2020-12", "draft-07"] as const)(
    "retains specialized descriptions, literal metadata and strict validation in %s",
    (target) => {
      const literal = {
        properties: { target: { $ref: "literal caller data" } },
        examples: [{ properties: { path: {} } }],
      };
      const range = z
        .object({
          offset: z.number().int().nonnegative().max(65535),
          length: z.number().int().min(1),
        })
        .strict()
        .describe("Exact byte range in the selected artifact.");
      const canonical = z
        .object({
          before: range,
          after: range,
          metadata: z
            .record(z.string(), z.unknown())
            .meta({ default: literal, examples: [literal] }),
          constructor: z.string(),
        })
        .strict();
      const advertised = toolInputSchemaWithMetadata({
        ...toolContract("open_binary"),
        inputSchema: canonical,
      })["~standard"].jsonSchema.input({ target });
      const inline = toolInputSchemaWithMetadata({
        ...toolContract("open_binary"),
        inputSchema: canonical,
      })["~standard"].jsonSchema.input({
        target,
        libraryOptions: { reused: "inline" },
      });
      expect(inline).toMatchObject({
        properties: {
          before: { description: "Exact byte range in the selected artifact." },
          after: { description: "Exact byte range in the selected artifact." },
          metadata: { default: literal, examples: [literal] },
        },
      });
      // Inherited object keys never supply a description.
      expect(inline).not.toHaveProperty([
        "properties",
        "constructor",
        "description",
      ]);
      const ajv =
        target === "draft-2020-12"
          ? new Ajv2020({ strict: false })
          : new Ajv({ strict: false });
      const validate = ajv.compile(advertised);
      const valid = {
        before: { offset: 0, length: 1 },
        after: { offset: 65535, length: 2 },
        metadata: literal,
        constructor: "constructor data",
      };
      const samples = [
        valid,
        ...[
          { offset: -1 },
          { offset: 65536 },
          { offset: 0.5 },
          { length: 0 },
          { unexpected: true },
        ].map((change) => ({
          ...valid,
          before: { ...valid.before, ...change },
        })),
        { ...valid, after: null },
        { ...valid, unexpected: true },
      ];
      expect(canonical.safeParse(valid).success).toBe(true);
      for (const sample of samples)
        expect(validate(sample)).toBe(canonical.safeParse(sample).success);
    },
  );
});

describe("root input presentation", () => {
  it("preserves prototype-named properties in object-root presentation", () => {
    const fields = Object.fromEntries([
      ["__proto__", { type: "string" }],
      ["constructor", { type: "number" }],
    ]);
    const branch = {
      type: "object",
      properties: fields,
      required: ["__proto__"],
      additionalProperties: false,
    };
    const presented = presentInputJsonSchema(
      { anyOf: [branch, branch] },
      (property) => `Parameter ${property}`,
    );
    expect(presented).not.toHaveProperty("anyOf");
    expect(presented).toMatchObject({
      type: "object",
      required: ["__proto__"],
      additionalProperties: false,
    });
    const properties = presented.properties;
    if (typeof properties !== "object" || properties === null)
      throw new Error("Missing root properties");
    expect(Object.getPrototypeOf(properties)).toBe(Object.prototype);
    expect(Object.hasOwn(properties, "__proto__")).toBe(true);
  });

  it.each(["draft-2020-12", "draft-07"] as const)(
    "advertises complete root groups while runtime keeps the exact union in %s",
    (target) => {
      const schema = z.union([
        z.strictObject({ before: z.string(), after: z.string() }),
        z.strictObject({
          before_scenario: z.number(),
          after_scenario: z.number(),
          normalization: z.boolean().optional(),
        }),
      ]);
      const canonical = z.toJSONSchema(schema, { io: "input", target });
      const advertised = presentInputJsonSchema(
        canonical,
        (property) => property,
      );
      // Anthropic tool input schemas reject anyOf, oneOf, and allOf at the root.
      for (const combinator of ["anyOf", "oneOf", "allOf"])
        expect(advertised).not.toHaveProperty(combinator);
      expect(advertised.description).toBe(
        "Provide a complete input group: before + after; before_scenario + after_scenario + [normalization].",
      );
      const ajv =
        target === "draft-2020-12"
          ? new Ajv2020({ strict: false })
          : new Ajv({ strict: false });
      const validate = ajv.compile(advertised);
      for (const input of [
        { before: "first", after: "second" },
        { before_scenario: 1, after_scenario: 2 },
        { before_scenario: 1, after_scenario: 2, normalization: true },
      ]) {
        expect(schema.safeParse(input).success).toBe(true);
        expect(validate(input)).toBe(true);
      }
      for (const input of [
        {},
        { before: "first" },
        { unexpected: true },
        { before_scenario: 1, after_scenario: "wrong" },
      ]) {
        expect(schema.safeParse(input).success).toBe(false);
        expect(validate(input)).toBe(false);
      }
      // The vendor-safe advertisement uses group guidance instead of
      // dependentRequired; the canonical runtime parser keeps exact unions.
      expect(
        schema.safeParse({ before_scenario: 1, normalization: true }).success,
      ).toBe(false);
      expect(validate({ before_scenario: 1, normalization: true })).toBe(true);
      expect(
        schema.safeParse({ after_scenario: 2, normalization: true }).success,
      ).toBe(false);
      expect(validate({ after_scenario: 2, normalization: true })).toBe(true);
      // Cross-group exclusion is enforced only by the canonical runtime parser.
      const mixed = {
        before: "first",
        after: "second",
        before_scenario: 1,
        after_scenario: 2,
      };
      expect(validate(mixed)).toBe(true);
      expect(schema.safeParse(mixed).success).toBe(false);
    },
  );

  it("keeps a root branch whose reference siblings cannot be merged", () => {
    const branch = { $ref: "#/$defs/object", additionalProperties: false };
    const root = {
      $defs: {
        object: { type: "object", properties: { value: { type: "string" } } },
      },
      anyOf: [branch],
    };
    const presented = presentInputJsonSchema(root, (property) => property);
    expect(presented.anyOf).toEqual([branch]);
    const ajv = new Ajv2020({ strict: false });
    for (const sample of [{}, { value: "value" }, { other: 1 }, null])
      expect(ajv.compile(presented)(sample)).toBe(ajv.compile(root)(sample));
  });

  it("preserves specialized guidance across reference chains without following literal references", () => {
    const literal = { properties: { literal: {} }, $ref: "#/$defs/missing" };
    const presented = presentInputJsonSchema(
      {
        $defs: {
          "a~b": {
            type: "string",
            description: "Literal URL selected by the caller.",
          },
          alias: { $ref: "#/$defs/a~0b" },
        },
        type: "object",
        properties: {
          url: { $ref: "#/$defs/alias" },
          other: { $ref: "#/$defs/alias", description: "Explicit override." },
        },
        default: literal,
        const: literal,
        examples: [literal],
        enum: [literal],
      },
      (property) => `Parameter ${property}`,
    );
    expect(presented).toMatchObject({
      properties: {
        url: { description: "Literal URL selected by the caller." },
        other: { description: "Explicit override." },
      },
      default: literal,
      const: literal,
      examples: [literal],
      enum: [literal],
    });
  });
});

describe("advertised Boolean literals", () => {
  it("keeps canonical boolean-literal inputs accepted after advertisement", () => {
    const canonical = {
      type: "object",
      properties: {
        enabled: { type: "boolean", const: false },
      },
      required: ["enabled"],
      additionalProperties: false,
    };
    const advertised = presentInputJsonSchema(canonical, () => undefined);
    const canonicalValidate = new Ajv2020({ strict: false }).compile(canonical);
    const advertisedValidate = new Ajv2020({ strict: false }).compile(
      advertised,
    );

    expect(canonicalValidate({ enabled: false })).toBe(true);
    expect(canonicalValidate({ enabled: true })).toBe(false);
    expect(advertisedValidate({ enabled: false })).toBe(true);
    expect(advertisedValidate({ enabled: true })).toBe(true);
    expect(advertised.properties).toEqual({ enabled: { type: "boolean" } });
  });

  it("drops affected negation and conditional groups without rejecting canonical inputs", () => {
    const negated = {
      type: "object",
      properties: {
        flag: { type: "boolean", not: { const: false } },
      },
    };
    const negatedAdvertisement = presentInputJsonSchema(
      negated,
      () => undefined,
    );
    const canonicalNegated = new Ajv2020({ strict: false }).compile(negated);
    const advertisedNegated = new Ajv2020({ strict: false }).compile(
      negatedAdvertisement,
    );
    expect(canonicalNegated({ flag: true })).toBe(true);
    expect(canonicalNegated({ flag: false })).toBe(false);
    expect(advertisedNegated({ flag: true })).toBe(true);

    const conditional = {
      type: "object",
      properties: {
        choice: {
          if: { const: false },
          then: { type: "string" },
          else: { type: "boolean" },
        },
      },
    };
    const conditionalAdvertisement = presentInputJsonSchema(
      conditional,
      () => undefined,
    );
    const canonicalConditional = new Ajv2020({ strict: false }).compile(
      conditional,
    );
    const advertisedConditional = new Ajv2020({ strict: false }).compile(
      conditionalAdvertisement,
    );
    expect(canonicalConditional({ choice: true })).toBe(true);
    expect(advertisedConditional({ choice: true })).toBe(true);
    expect(conditionalAdvertisement.properties).toEqual({
      choice: {},
    });
  });
});

describe("advertised Boolean schema composition", () => {
  it("widens an affected oneOf to anyOf when branches could overlap", () => {
    const canonical = {
      type: "object",
      properties: {
        flag: {
          oneOf: [{ type: "boolean", const: false }, {}],
        },
      },
    };
    const advertised = presentInputJsonSchema(canonical, () => undefined);
    const canonicalValidate = new Ajv2020({ strict: false }).compile(canonical);
    const advertisedValidate = new Ajv2020({ strict: false }).compile(
      advertised,
    );
    expect(canonicalValidate({ flag: true })).toBe(true);
    expect(canonicalValidate({ flag: false })).toBe(false);
    expect(advertisedValidate({ flag: true })).toBe(true);
    expect(advertised).toHaveProperty(["properties", "flag", "anyOf"]);
  });

  it("retains nested branch guidance when widening oneOf to anyOf", () => {
    const canonical = {
      type: "object",
      properties: {
        selection: {
          oneOf: [
            {
              type: "object",
              properties: {
                source: { type: "string" },
                mode: { type: "boolean", const: false },
              },
              required: ["source", "mode"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                target: { type: "string" },
                mode: { type: "boolean", const: true },
              },
              required: ["target", "mode"],
              additionalProperties: false,
            },
          ],
        },
      },
    };
    const advertised = presentInputJsonSchema(canonical, () => undefined);
    const canonicalValidate = new Ajv2020({ strict: false }).compile(canonical);
    const advertisedValidate = new Ajv2020({ strict: false }).compile(
      advertised,
    );
    const example = { selection: { source: "capture.json", mode: false } };
    expect(canonicalValidate(example)).toBe(true);
    expect(advertisedValidate(example)).toBe(true);
    expect(advertised).toMatchObject({
      properties: {
        selection: {
          anyOf: [
            { properties: { source: { type: "string" } } },
            { properties: { target: { type: "string" } } },
          ],
        },
      },
    });
  });

  it("removes a nested not when widening a boolean item predicate", () => {
    const canonical = {
      type: "object",
      properties: {
        values: {
          type: "array",
          not: { items: { type: "boolean", const: false } },
        },
      },
    };
    const advertised = presentInputJsonSchema(canonical, () => undefined);
    const canonicalValidate = new Ajv2020({ strict: false }).compile(canonical);
    const advertisedValidate = new Ajv2020({ strict: false }).compile(
      advertised,
    );
    expect(canonicalValidate({ values: [true] })).toBe(true);
    expect(advertisedValidate({ values: [true] })).toBe(true);
    expect(advertised).toHaveProperty(["properties", "values"], {
      type: "array",
    });
  });

  it("normalizes schema keywords only and preserves literal payloads", () => {
    const literal = {
      const: false,
      enum: [false],
      properties: { nested: { const: true } },
    };
    const presented = presentInputJsonSchema(
      {
        type: "object",
        properties: {
          default: { type: "boolean", const: false },
          allowed: { enum: [false, true] },
          kind: { type: "string", const: "exact" },
        },
        default: literal,
        examples: [literal],
      },
      () => undefined,
    );
    expect(presented.properties).toEqual({
      default: { type: "boolean" },
      allowed: { type: "boolean" },
      kind: { type: "string", const: "exact" },
    });
    expect(presented.default).toEqual(literal);
    expect(presented.examples).toEqual([literal]);
  });
});
