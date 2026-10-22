import {
  schemaArrays,
  schemaChildren,
  schemaMaps,
} from "../../src/contracts/jsonSchemaKeywords.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** VS Code Copilot rejects falsy `items` for any type that admits arrays. */
export const arrayItemSchemaError = (
  schema: unknown,
  path: string,
): string | undefined => {
  if (!isRecord(schema)) return undefined;
  const admitsArrays =
    schema.type === "array" ||
    (Array.isArray(schema.type) && schema.type.includes("array"));
  if (admitsArrays && !schema.items)
    return `${path}: tool parameters array type must have items`;
  for (const [key, value] of Object.entries(schema)) {
    const children =
      schemaMaps.has(key) && isRecord(value)
        ? Object.entries(value).map(
            ([name, child]) => [`${key}.${name}`, child] as const,
          )
        : (schemaArrays.has(key) || schemaChildren.has(key)) &&
            Array.isArray(value)
          ? value.map(
              (child: unknown, index) => [`${key}.${index}`, child] as const,
            )
          : schemaChildren.has(key)
            ? [[key, value] as const]
            : [];
    for (const [suffix, child] of children) {
      const error = arrayItemSchemaError(child, `${path}.${suffix}`);
      if (error !== undefined) return error;
    }
  }
  return undefined;
};

/** Reject Gemini-incompatible boolean literals in advertised input positions. */
export const booleanLiteralSchemaError = (
  schema: unknown,
  path: string,
): string | undefined => {
  if (!isRecord(schema)) return undefined;
  if (typeof schema.const === "boolean") return `${path}.const is boolean`;
  if (
    Array.isArray(schema.enum) &&
    schema.enum.some((value) => typeof value === "boolean")
  )
    return `${path}.enum contains a boolean`;
  for (const [key, value] of Object.entries(schema)) {
    const children =
      schemaMaps.has(key) && isRecord(value)
        ? Object.entries(value).map(
            ([name, child]) => [`${key}.${name}`, child] as const,
          )
        : schemaArrays.has(key) && Array.isArray(value)
          ? value.map(
              (child: unknown, index) => [`${key}[${index}]`, child] as const,
            )
          : schemaChildren.has(key)
            ? [[key, value] as const]
            : [];
    for (const [suffix, child] of children) {
      const error = booleanLiteralSchemaError(child, `${path}.${suffix}`);
      if (error !== undefined) return error;
    }
  }
  return undefined;
};
