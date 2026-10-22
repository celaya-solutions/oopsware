import { types } from "node:util";
import { z } from "zod";
import { isImmutableJsonSnapshot } from "./immutableJson.js";

/** Maximum JSON nesting accepted before recursive result cloning. */
export const MAX_JSON_DEPTH = 1000;

/** JSON-safe value shared by domain, application, and adapter boundaries. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const immutableValidation = new WeakMap<object, string | undefined>();

/** Validate JSON meaning and nesting without cloning a trusted immutable value. */
export const jsonValueValidationIssue = (root: unknown): string | undefined => {
  const steps = jsonValueValidationSteps(root);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
};

/** Validate JSON in bounded steps; cache only authenticated immutable roots. */
export function* jsonValueValidationSteps(
  root: unknown,
): Generator<void, string | undefined> {
  const immutable =
    typeof root === "object" && root !== null && isImmutableJsonSnapshot(root)
      ? root
      : undefined;
  if (immutable !== undefined && immutableValidation.has(immutable))
    return immutableValidation.get(immutable);
  const finish = (issue: string | undefined): string | undefined => {
    if (immutable !== undefined) immutableValidation.set(immutable, issue);
    return issue;
  };
  const pending: { value: unknown; depth: number }[] = [
    { value: root, depth: 0 },
  ];
  let examined = 0;
  while (pending.length > 0) {
    if (examined++ === 4096) {
      examined = 0;
      yield;
    }
    const item = pending.pop();
    if (item === undefined) break;
    if (item.depth > MAX_JSON_DEPTH)
      return finish(
        `JSON value exceeds maximum nesting depth of ${MAX_JSON_DEPTH}`,
      );
    const value = item.value;
    if (typeof value === "object" && value !== null && types.isProxy(value))
      return finish("JSON values cannot contain proxies");
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    )
      continue;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return finish("JSON numbers must be finite");
    } else if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        if (descriptor === undefined || !Object.hasOwn(descriptor, "value"))
          return finish(
            "JSON arrays require dense data properties without accessors",
          );
        pending.push({ value: descriptor.value, depth: item.depth + 1 });
      }
    } else if (isRecord(value)) {
      const prototype: unknown = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null)
        return finish("JSON objects require ordinary data properties");
      for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor?.enumerable !== true) continue;
        if (typeof key !== "string")
          return finish("JSON object keys must be strings");
        if (!Object.hasOwn(descriptor, "value"))
          return finish("JSON objects cannot contain accessors");
        pending.push({ value: descriptor.value, depth: item.depth + 1 });
      }
    } else return finish("Invalid JSON value");
  }
  return finish(undefined);
}

const preserveJsonValue = (value: JsonValue): JsonValue => {
  const immutableCandidate: unknown = value;
  if (isImmutableJsonSnapshot(immutableCandidate)) return value;
  if (Array.isArray(value)) {
    const copy: JsonValue[] = [];
    for (let index = 0; index < value.length; index += 1)
      copy.push(preserveJsonValue(value[index]!));
    return copy;
  }
  if (value !== null && typeof value === "object")
    return Object.fromEntries<JsonValue>(
      Object.entries(value).map(([key, child]) => [
        key,
        preserveJsonValue(child),
      ]),
    );
  return value;
};

const validatedJsonValue = z
  .unknown()
  .superRefine((value, context) => {
    const issue = jsonValueValidationIssue(value);
    if (issue !== undefined)
      context.addIssue({ code: "custom", message: issue, continue: false });
  })
  .transform((value) => value as JsonValue);
// Keep both stages nonrecursive in public and Standard Schema projections.
validatedJsonValue._zod.toJSONSchema = () => ({});

/** Parse bounded JSON and retain all own data members without prototype setters. */
export const jsonValueSchema = z
  .unknown()
  .nonoptional()
  .pipe(validatedJsonValue)
  .transform(preserveJsonValue);
jsonValueSchema._zod.toJSONSchema = () => ({});

const objectValidation = z.custom<Record<string, JsonValue>>(
  isRecord,
  "Expected JSON object",
);
const objectProjection = () => ({ type: "object", additionalProperties: {} });
objectValidation._zod.toJSONSchema = objectProjection;

/** JSON object boundary for caller-visible parameter maps. */
export const jsonObjectSchema = jsonValueSchema.pipe(objectValidation);
jsonObjectSchema._zod.toJSONSchema = objectProjection;
