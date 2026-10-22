import { object } from "./json.js";
import type { Json, Obj } from "./types.js";

/** Resolve local references and object intersections shared by forms and target defaults. */
export function resolve(schema: Obj, root: Obj, seen = new Set<string>()): Obj {
  let s = schema;
  if (
    typeof s.$ref === "string" &&
    s.$ref.startsWith("#/") &&
    !seen.has(s.$ref)
  ) {
    seen.add(s.$ref);
    let ref: Json = root;
    for (const key of s.$ref
      .slice(2)
      .split("/")
      .map((k) => k.replaceAll("~1", "/").replaceAll("~0", "~")))
      ref = object(ref) ? (ref[key] ?? null) : null;
    if (object(ref)) {
      const { $ref: _, ...rest } = s;
      s = { ...resolve(ref, root, seen), ...rest };
    }
  }
  if (Array.isArray(s.allOf))
    for (const part of s.allOf.filter(object)) {
      const r = resolve(part, root, new Set(seen));
      s = {
        ...r,
        ...s,
        properties: {
          ...(object(r.properties) ? r.properties : {}),
          ...(object(s.properties) ? s.properties : {}),
        },
        required: [
          ...new Set([
            ...(Array.isArray(s.required) ? s.required : []),
            ...(Array.isArray(r.required) ? r.required : []),
          ]),
        ],
      };
    }
  return s;
}
