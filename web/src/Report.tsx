import { useState } from "react";
import { object, pretty, type Json } from "./api";
export function JsonView({ value }: { value: Json }) {
  const [expanded, setExpanded] = useState(false);
  const text = JSON.stringify(value, null, 2);
  return (
    <div className="json-view">
      <pre>{expanded ? text : text.slice(0, 18000)}</pre>
      {text.length > 18000 && (
        <button onClick={() => setExpanded(!expanded)}>
          {expanded ? "Collapse" : "Show all delivered JSON"} ·{" "}
          {text.length.toLocaleString()} characters
        </button>
      )}
    </div>
  );
}
export function Report({ value, depth = 0 }: { value: Json; depth?: number }) {
  if (depth > 3) return <JsonView value={value} />;
  if (!object(value) && !Array.isArray(value))
    return (
      <p className="report-text">{String(value ?? "No value returned")}</p>
    );
  if (Array.isArray(value)) {
    if (!value.length) return <p className="subtle report-text">No entries.</p>;
    const rows = value.filter(object);
    const keys = [...new Set(rows.flatMap(Object.keys))];
    if (
      rows.length === value.length &&
      keys.length <= 8 &&
      rows.every((r) =>
        Object.values(r).every((v) => !object(v) && !Array.isArray(v)),
      )
    )
      return (
        <div className="result-table">
          <table>
            <thead>
              <tr>
                {keys.map((k) => (
                  <th key={k}>{pretty(k)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 150).map((r, i) => (
                <tr key={i}>
                  {keys.map((k) => (
                    <td key={k}>{String(r[k] ?? "—")}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > 150 && (
            <p>
              Showing 150 of {rows.length} entries. All entries remain in the
              delivered JSON and export.
            </p>
          )}
        </div>
      );
    return (
      <div className="report-array">
        {value.slice(0, 60).map((v, i) => (
          <details key={i}>
            <summary>
              {object(v)
                ? String(
                    v.name ?? v.title ?? v.path ?? v.id ?? `Entry ${i + 1}`,
                  )
                : String(v)}
            </summary>
            <Report value={v} depth={depth + 1} />
          </details>
        ))}
        {value.length > 60 && (
          <p className="subtle">
            Showing 60 of {value.length} entries. Use full delivered JSON for
            all entries.
          </p>
        )}
      </div>
    );
  }
  return (
    <div className="report">
      {Object.entries(value).map(([k, v]) =>
        object(v) || Array.isArray(v) ? (
          <section
            className={`report-section ${/unknown|limitation|error|warning|partial/.test(k) ? "caution" : ""}`}
            key={k}
          >
            <h3>
              {pretty(k)}
              {Array.isArray(v) && <span className="badge">{v.length}</span>}
            </h3>
            <Report value={v} depth={depth + 1} />
          </section>
        ) : (
          <div className="report-fact" key={k}>
            <span>{pretty(k)}</span>
            <strong>
              {typeof v === "boolean"
                ? v
                  ? "Yes"
                  : "No"
                : String(v ?? "null")}
            </strong>
          </div>
        ),
      )}
    </div>
  );
}
