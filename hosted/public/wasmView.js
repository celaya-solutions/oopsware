// WebAssembly module view (format expansion F01). Every value is rendered as
// a text node through the page's own table helper; nothing from the module
// is interpreted as markup and the module is never instantiated.

const VALIDATION = {
  valid: "valid WebAssembly 2.0",
  invalid: "not valid",
  "requires-proposal": "valid only with a newer proposal",
  not_checked: "not validated",
};
const NAME_SOURCE = {
  "name-section": "",
  export: " (export name)",
  import: " (import name)",
};

const offset = (value) => `0x${value.toString(16)}`;
const plural = (count, word) =>
  `${count.toLocaleString()} ${word}${count === 1 ? "" : "s"}`;

/** One-line status for the top of the view. */
export const wasmStatus = (view) => {
  const { report } = view;
  if (report.encoding.kind !== "module")
    return `WebAssembly ${report.encoding.kind} · identified, not decoded`;
  const coverage = report.coverage.find((item) => item.facet === "inspect");
  return [
    "WebAssembly core module",
    VALIDATION[report.validation.state] ?? report.validation.state,
    plural(report.function_count, "function"),
    coverage?.state === "complete" ? "read completely" : "read in part",
  ].join(" · ");
};

/** Number of problems shown on the Problems tab label. */
export const wasmProblemCount = (view) =>
  view.report.diagnostics.length +
  (view.report.validation.state === "valid" ? 0 : 1);

const facts = (node, entries) => {
  const list = node("dl", undefined, "wasm-facts");
  for (const [term, value] of entries) {
    list.append(node("dt", term), node("dd", value));
  }
  return list;
};

const moduleBody = (view, { node, table }) => {
  const { report } = view;
  const body = [
    facts(node, [
      [
        "Kind",
        `${report.encoding.kind}, version ${report.encoding.version ?? "unknown"}`,
      ],
      [
        "Validation",
        `${VALIDATION[report.validation.state] ?? report.validation.state} (${report.validation.validator})`,
      ],
      ["Module name", report.module_name ?? "none recorded"],
      [
        "Built by",
        report.producers
          .flatMap((field) =>
            field.values.map((value) =>
              `${value.name} ${value.version}`.trim(),
            ),
          )
          .join(", ") || "not recorded",
      ],
      [
        "Contents",
        [
          plural(report.summary.functions, "function"),
          plural(report.summary.imports, "import"),
          plural(report.summary.exports, "export"),
          plural(report.summary.data, "data segment"),
          plural(report.summary.indirect_call_sites, "indirect call"),
        ].join(" · "),
      ],
    ]),
  ];
  if (report.imports.length)
    body.push(
      table(
        "Imports: what the module asks its host to provide.",
        ["Module", "Name", "Kind", "Type"],
        report.imports.map((item) => ({
          cells: [item.module, item.name, item.kind, item.description],
        })),
      ),
    );
  if (report.exports.length)
    body.push(
      table(
        "Exports: what the module offers its host.",
        ["Name", "Kind", "Index"],
        report.exports.map((item) => ({
          cells: [item.name, item.kind, String(item.index)],
        })),
      ),
    );
  if (report.memories.length)
    body.push(
      table(
        "Memories, in 64 KiB pages.",
        ["Index", "Minimum", "Maximum", "Shared"],
        report.memories.map((item) => ({
          cells: [
            String(item.index),
            String(item.limits.min),
            item.limits.max === null ? "none" : String(item.limits.max),
            item.limits.shared ? "yes" : "no",
          ],
        })),
      ),
    );
  if (report.data.length)
    body.push(
      table(
        "Data segments with the first bytes as text; dots stand for other bytes.",
        ["Index", "Placed at", "Size", "Starts with"],
        report.data.map((item) => ({
          cells: [
            String(item.index),
            item.offset_expression ?? "passive",
            plural(item.size, "byte"),
            item.preview_text,
          ],
        })),
      ),
    );
  body.push(
    table(
      "Sections in file order with their byte ranges.",
      ["Section", "Starts", "Size", "Read"],
      report.sections.map((item) => ({
        cells: [
          item.custom_name === null ? item.name : `custom: ${item.custom_name}`,
          offset(item.offset),
          plural(item.size, "byte"),
          item.decoded ? "yes" : "stopped",
        ],
      })),
    ),
  );
  return body;
};

const functionsBody = (view, page, { node, table }) => {
  const rows = (page?.functions ?? []).map((item) => ({
    cells: [
      String(item.index),
      `${item.name ?? "unnamed"}${NAME_SOURCE[item.name_source] ?? ""}`,
      item.signature ?? "unknown",
      item.imported
        ? `imported from ${item.imported.module}`
        : item.decode === "stopped"
          ? `${plural(item.instructions ?? 0, "instruction")}, then stopped`
          : plural(item.instructions ?? 0, "instruction"),
      item.direct_callees.length ? item.direct_callees.join(", ") : "none",
      String(item.indirect_call_sites),
      String(item.direct_callers),
    ],
  }));
  const body = [
    table(
      "Functions by index. Imports come first; names are never invented.",
      [
        "Index",
        "Name",
        "Signature",
        "Body",
        "Calls",
        "Indirect calls",
        "Called by",
      ],
      rows,
    ),
  ];
  if (view.stored_functions < view.report.function_count)
    body.push(
      node(
        "p",
        `Showing the first ${view.stored_functions.toLocaleString()} of ${view.report.function_count.toLocaleString()} functions. Download the original for the rest.`,
        "hint",
      ),
    );
  return body;
};

const problemsBody = (view, { node }) => {
  const { report } = view;
  const list = node("ul", undefined, "diagnostic-list");
  if (report.validation.state !== "valid" && report.validation.message)
    list.append(node("li", `Validation: ${report.validation.message}`));
  for (const item of report.diagnostics)
    list.append(
      node(
        "li",
        `${item.message} (byte ${offset(item.offset)}${item.section ? `, ${item.section} section` : ""})`,
      ),
    );
  const limits = node("ul", undefined, "diagnostic-list");
  for (const item of [
    ...(report.unsupported_proposals.length
      ? [`Not decoded here: ${report.unsupported_proposals.join(", ")}.`]
      : []),
    ...view.limitations,
    ...(view.wat_omitted ? [view.wat_omitted] : []),
  ])
    limits.append(node("li", item));
  return [
    node("h3", "Problems found", "doc-heading"),
    list.childElementCount ? list : node("p", "None.", "hint"),
    node("h3", "What this view does not do", "doc-heading"),
    limits,
  ];
};

/** Body elements for one tab of the WebAssembly view. */
export const wasmBody = (view, state, page, helpers) =>
  state.view === "Functions"
    ? functionsBody(view, page, helpers)
    : state.view === "Problems"
      ? problemsBody(view, helpers)
      : moduleBody(view, helpers);
