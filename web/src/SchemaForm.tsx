import { useEffect, useState } from "react";
import { object, pretty, jsonSchema, type Json, type Obj } from "./api";
import { resolve } from "./schema.js";
import { HelpHint } from "./components/Hint";
function initial(s: Obj): Json {
  if ("const" in s) return s.const ?? null;
  if ("default" in s) return s.default ?? null;
  if (s.type === "object" || s.properties) return {};
  if (s.type === "array") return [];
  if (s.type === "boolean") return false;
  if (s.type === "number" || s.type === "integer") return 0;
  if (s.type === "null") return null;
  return "";
}
export function SchemaField({
  schema,
  root,
  value,
  change,
  name,
  depth = 0,
}: {
  schema: Obj;
  root: Obj;
  value: Json | undefined;
  change: (v: Json | undefined) => void;
  name: string;
  depth?: number;
}) {
  const s = resolve(schema, root);
  const variants: Json[] = Array.isArray(s.oneOf)
    ? s.oneOf
    : Array.isArray(s.anyOf)
      ? s.anyOf
      : Array.isArray(s.type)
        ? s.type.map((type) => ({ ...s, type }))
        : [];
  const [chosenBranch, setBranch] = useState<number | undefined>();
  const inferred = variants.findIndex(
    (v) => object(v) && matches(resolve(v, root), value),
  );
  const branch = chosenBranch ?? Math.max(0, inferred);
  if (depth > 10)
    return <JsonInput value={value} change={change} label={name} />;
  if (variants.length) {
    const selected = variants[branch];
    return (
      <div className="schema-variant">
        <select
          aria-label={`${name} type`}
          value={branch}
          onChange={(e) => {
            setBranch(Number(e.target.value));
            const next = variants[Number(e.target.value)];
            if (object(next)) change(initial(resolve(next, root)));
          }}
        >
          {variants.map((v, i) => (
            <option key={i} value={i}>
              {object(v)
                ? String(v.title ?? v.type ?? `Option ${i + 1}`)
                : `Option ${i + 1}`}
            </option>
          ))}
        </select>
        {object(selected) && (
          <SchemaField
            key={branch}
            schema={withoutVariants(s, selected)}
            root={root}
            value={value}
            change={change}
            name={name}
            depth={depth + 1}
          />
        )}
      </div>
    );
  }
  if (Array.isArray(s.enum))
    return (
      <select
        aria-label={name}
        value={JSON.stringify(value)}
        onChange={(e) => {
          if (e.target.value !== "")
            change(jsonSchema.parse(JSON.parse(e.target.value)));
          else change(undefined);
        }}
      >
        <option value="">Choose…</option>
        {s.enum.map((v) => (
          <option key={JSON.stringify(v)} value={JSON.stringify(v)}>
            {String(v)}
          </option>
        ))}
      </select>
    );
  if ("const" in s)
    return (
      <button
        type="button"
        className="constant"
        onClick={() => change(s.const)}
      >
        {JSON.stringify(s.const)} · use value
      </button>
    );
  if (s.type === "object" || object(s.properties)) {
    const props = object(s.properties) ? s.properties : {};
    const v = object(value) ? value : {};
    return (
      <div className="schema-object">
        {Object.entries(props).map(([key, spec]) => {
          if (!object(spec)) return null;
          const required =
            Array.isArray(s.required) && s.required.includes(key);
          const enabled = key in v;
          return (
            <div className="field" key={key}>
              <div className="field-heading">
                <label>
                  {pretty(key)}
                  {required && <span className="required"> *</span>}
                </label>
                {typeof spec.description === "string" && (
                  <HelpHint label={`About ${pretty(key)}`}>
                    {spec.description}
                  </HelpHint>
                )}
                <label className="include">
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={(e) => {
                      const n = { ...v };
                      if (e.target.checked)
                        n[key] = initial(resolve(spec, root));
                      else delete n[key];
                      change(n);
                    }}
                  />
                  {enabled ? "Included" : required ? "Required" : "Optional"}
                </label>
              </div>
              {enabled && (
                <SchemaField
                  schema={spec}
                  root={root}
                  value={v[key]}
                  change={(x) => {
                    const n = { ...v };
                    if (x === undefined) delete n[key];
                    else n[key] = x;
                    change(n);
                  }}
                  name={key}
                  depth={depth + 1}
                />
              )}
            </div>
          );
        })}
        {s.additionalProperties !== false && (
          <details>
            <summary>Additional fields / full object</summary>
            <JsonInput value={v} change={change} label={name} />
          </details>
        )}
      </div>
    );
  }
  if (s.type === "array") {
    const v = Array.isArray(value) ? value : [];
    const item = object(s.items) ? s.items : {};
    return (
      <div className="array-fields">
        {v.map((x, i) => (
          <div className="array-item" key={i}>
            <SchemaField
              schema={item}
              root={root}
              value={x}
              name={`${name} ${i + 1}`}
              depth={depth + 1}
              change={(n) =>
                change(v.map((old, j) => (j === i ? (n ?? null) : old)))
              }
            />
            <button
              type="button"
              onClick={() => change(v.filter((_, j) => j !== i))}
            >
              Remove
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => change([...v, initial(resolve(item, root))])}
        >
          + Add item
        </button>
      </div>
    );
  }
  if (s.type === "null")
    return (
      <button type="button" onClick={() => change(null)}>
        Set null
      </button>
    );
  if (s.type === "boolean")
    return (
      <select
        aria-label={name}
        value={String(value)}
        onChange={(e) => change(e.target.value === "true")}
      >
        <option value="false">False</option>
        <option value="true">True</option>
      </select>
    );
  if (s.type === "number" || s.type === "integer")
    return (
      <input
        aria-label={name}
        type="number"
        step={s.type === "integer" ? 1 : "any"}
        value={typeof value === "number" ? value : ""}
        onChange={(e) =>
          change(e.target.value === "" ? undefined : Number(e.target.value))
        }
      />
    );
  if (s.type === "string" || !s.type)
    return (
      <input
        aria-label={name}
        value={typeof value === "string" ? value : ""}
        onChange={(e) => change(e.target.value)}
        placeholder={typeof s.default === "string" ? s.default : name}
      />
    );
  return <JsonInput value={value} change={change} label={name} />;
}
function JsonInput({
  value,
  change,
  label,
}: {
  value: Json | undefined;
  change: (v: Json) => void;
  label: string;
}) {
  const [text, setText] = useState(JSON.stringify(value, null, 2) ?? "");
  const [error, setError] = useState("");
  const serialized = JSON.stringify(value, null, 2) ?? "";
  useEffect(() => {
    setText(serialized);
    setError("");
  }, [serialized]);
  return (
    <>
      <textarea
        aria-label={label}
        className="json-input"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          try {
            change(jsonSchema.parse(JSON.parse(e.target.value)));
            setError("");
            e.currentTarget.setCustomValidity("");
          } catch {
            setError("Enter valid JSON.");
            e.currentTarget.setCustomValidity(
              "Enter valid JSON before running.",
            );
          }
        }}
      />
      {error && <small className="error-text">{error}</small>}
    </>
  );
}

function withoutVariants(s: Obj, selected: Obj): Obj {
  const { anyOf: _anyOf, oneOf: _oneOf, ...base } = s;
  return { ...base, ...selected };
}

function matches(s: Obj, value: Json | undefined): boolean {
  if ("const" in s) return s.const === value;
  if (Array.isArray(s.enum)) return s.enum.includes(value ?? null);
  if (s.type === "null") return value === null;
  if (s.type === "array") return Array.isArray(value);
  if (s.type === "object" || object(s.properties)) {
    if (!object(value)) return false;
    return (
      !object(s.properties) ||
      Object.entries(s.properties).every(
        ([key, child]) =>
          !object(child) || !("const" in child) || value[key] === child.const,
      )
    );
  }
  return (
    s.type === typeof value ||
    (s.type === "integer" &&
      typeof value === "number" &&
      Number.isInteger(value))
  );
}
