import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  jsonObjectSchema,
  jsonValueSchema,
  MAX_JSON_DEPTH,
} from "./jsonValue.js";

const values = [
  "text",
  0,
  false,
  null,
  [],
  {},
  { nested: [{ deeper: [1, "two", null, { three: true }] }] },
];

it("projects JSON values without recursive definitions", () => {
  for (const io of ["input", "output"] as const) {
    const schema = z.toJSONSchema(
      z.object({ value: jsonValueSchema, map: jsonObjectSchema }),
      { io },
    );
    expect(JSON.stringify(schema)).not.toContain("$ref");
    expect(schema).not.toHaveProperty("$defs");
    const validate = new Ajv2020({ strict: false }).compile(schema);
    for (const value of values)
      expect(validate({ value, map: { value } })).toBe(true);
    expect(validate({ value: 1, map: [] })).toBe(false);
  }
});

it("still parses only JSON values at runtime", () => {
  for (const value of values)
    expect(jsonValueSchema.safeParse(value).success).toBe(true);
  for (const value of [undefined, Number.NaN, Infinity, () => 0, [undefined]])
    expect(jsonValueSchema.safeParse(value).success).toBe(false);
});

it("rejects sparse arrays and enumerable symbol-keyed object members", () => {
  const sparse = new Array(1);
  const symbolKeyed = { [Symbol("caller data")]: "retain or reject" };
  expect(jsonValueSchema.safeParse(sparse).success).toBe(false);
  expect(jsonValueSchema.safeParse(symbolKeyed).success).toBe(false);
});

const deepObject = (depth: number): unknown => {
  let value: unknown = 1;
  for (let index = 0; index < depth; index += 1) value = { nested: value };
  return value;
};

describe("jsonValueSchema depth bound", () => {
  it("accepts values nested to the maximum depth", () => {
    expect(jsonValueSchema.safeParse(deepObject(MAX_JSON_DEPTH)).success).toBe(
      true,
    );
  });

  it("rejects values nested past the maximum depth without throwing", () => {
    const result = jsonValueSchema.safeParse(deepObject(MAX_JSON_DEPTH + 1));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.message).toContain("maximum nesting depth");
  });

  it.each(["object", "array"])(
    "rejects the original 10000-level %s crash without throwing",
    (kind) => {
      let value: unknown = 1;
      for (let index = 0; index < 10_000; index += 1)
        value = kind === "object" ? { nested: value } : [value];
      const result = jsonValueSchema.safeParse(value);
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.issues[0]?.message).toContain(
        "maximum nesting depth",
      );
    },
  );

  it("stops enclosing refinements before rejected JSON reaches consumers", () => {
    let consumed = 0;
    const envelope = z.object({ value: jsonValueSchema }).superRefine(() => {
      consumed += 1;
    });
    const result = envelope.safeParse({ value: deepObject(10_000) });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.message).toContain("maximum nesting depth");
    expect(consumed).toBe(0);
  });

  it("rejects cyclic values instead of recursing forever", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const result = jsonValueSchema.safeParse(cyclic);
    expect(result.success).toBe(false);
  });

  it("keeps json semantics for non-JSON values", () => {
    expect(jsonValueSchema.safeParse(undefined).success).toBe(false);
    expect(jsonValueSchema.safeParse({ a: Number.NaN }).success).toBe(false);
    expect(
      jsonValueSchema.safeParse({ a: Number.POSITIVE_INFINITY }).success,
    ).toBe(false);
    expect(jsonValueSchema.safeParse({ a: 1n }).success).toBe(false);
  });
});

it("preserves prototype-named members without prototype mutation", () => {
  const input: unknown = JSON.parse(
    '{"__proto__":{"preserved":7},"constructor":"ordinary","prototype":[1],"nested":{"\\u005f\\u005fproto\\u005f\\u005f":"escaped"},"list":[{"__proto__":null}]}',
  );
  const parsed = jsonObjectSchema.parse(input);
  expect(parsed).toEqual(input);
  expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
  expect(Object.hasOwn(parsed, "__proto__")).toBe(true);
  expect(parsed["__proto__"]).toEqual({ preserved: 7 });
  expect(parsed["constructor"]).toBe("ordinary");
  expect(parsed["prototype"]).toEqual([1]);
  expect(parsed["nested"]).toEqual({ ["__proto__"]: "escaped" });
  expect(parsed["list"]).toEqual([{ ["__proto__"]: null }]);
  expect(Object.getPrototypeOf(parsed["nested"])).toBe(Object.prototype);
  expect(Reflect.get(Object.prototype, "preserved")).toBeUndefined();
  expect(JSON.parse(JSON.stringify(parsed))).toEqual(input);
});

it.each([undefined, Number.NaN, Infinity, 1n, () => 0, new Date(0)])(
  "rejects non-JSON values in prototype-named members (%s)",
  (value) => {
    for (const input of [
      { ["__proto__"]: value },
      { nested: [{ ["__proto__"]: value }] },
    ]) {
      expect(jsonValueSchema.safeParse(input).success).toBe(false);
      expect(jsonObjectSchema.safeParse(input).success).toBe(false);
    }
  },
);

describe("inert JSON data boundaries", () => {
  it.each(["member", "constructor", "array"])(
    "rejects an accessor at %s without invoking it",
    (kind) => {
      let accessed = false;
      const value = kind === "array" ? [] : {};
      Object.defineProperty(value, kind === "array" ? "0" : kind, {
        enumerable: true,
        get() {
          accessed = true;
          throw new Error("caller accessor must remain inert");
        },
      });
      expect(jsonValueSchema.safeParse(value).success).toBe(false);
      expect(accessed).toBe(false);
    },
  );

  it("rejects proxies before reflection can invoke traps", () => {
    let observed = false;
    const value = new Proxy(
      {},
      {
        getPrototypeOf() {
          observed = true;
          throw new Error("caller trap must remain inert");
        },
      },
    );
    expect(jsonValueSchema.safeParse(value).success).toBe(false);
    expect(observed).toBe(false);
    const revoked = Proxy.revocable([], {});
    revoked.revoke();
    expect(jsonValueSchema.safeParse(revoked.proxy).success).toBe(false);
  });

  it("projects array data without invoking caller iteration or map methods", () => {
    const value = [1, { nested: "preserved" }];
    Object.defineProperty(value, Symbol.iterator, {
      value() {
        throw new Error("caller iterator must remain inert");
      },
    });
    Object.defineProperty(value, "map", {
      value() {
        throw new Error("caller map must remain inert");
      },
    });
    expect(jsonValueSchema.parse(value)).toEqual([1, { nested: "preserved" }]);
  });
});
