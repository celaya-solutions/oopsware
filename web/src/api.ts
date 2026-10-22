import type { Json, Obj, Run, Tool } from "./types.js";
export type { Json, Obj, Run, RunSummary, Tool, Target } from "./types.js";
import { z } from "zod";
import { object } from "./json.js";
export { object } from "./json.js";
export const token =
  document.querySelector<HTMLMetaElement>('meta[name="rea-token"]')?.content ??
  "";
export async function api<T = Json>(
  path: string,
  body: unknown,
  schema: z.ZodType<T>,
): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-rea-token": token, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value: unknown = await response.json();
  if (!response.ok)
    throw new Error(
      object(value) && typeof value.message === "string"
        ? value.message
        : `Request failed (${response.status})`,
    );
  return schema.parse(value);
}
export const jsonSchema = z.json();
export const objectSchema = z.record(z.string(), z.json());
export const runSchema = z.object({
  id: z.string(),
  tool: z.string(),
  arguments: objectSchema,
  targetPath: z.string().optional(),
  status: z.string(),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  progress: z
    .object({
      progress: z.number(),
      total: z.number().optional(),
      message: z.string().optional(),
    })
    .optional(),
  result: objectSchema.optional(),
  error: z.string().optional(),
});
export const runResponseSchema = z.object({ run: runSchema });
export const runSummarySchema = runSchema
  .omit({ arguments: true, result: true, error: true, targetPath: true })
  .extend({ hasResult: z.boolean() });
export const summaryResponseSchema = z.object({ run: runSummarySchema });
export const workspaceSchema = z.object({
  id: z.string(),
  runs: z.array(runSummarySchema),
  total: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
});
export const toolSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  category: z.string().optional(),
  kind: z.string().optional(),
  inputSchema: objectSchema,
  effects: jsonSchema.optional(),
  examples: z
    .array(z.object({ title: z.string(), input: objectSchema }))
    .optional(),
});
export const toolsSchema = z.object({ tools: z.array(toolSchema) });
export const targetSchema = z.object({
  name: z.string(),
  path: z.string(),
  directory: z.boolean(),
  application: z.boolean(),
  size: z.number(),
  modified: z.string(),
  executablePath: z.string().optional(),
  applicationError: jsonSchema.optional(),
  preview: z
    .object({
      offset: z.number(),
      bytes: z.number(),
      hasMore: z.boolean(),
      text: z.string().nullable(),
      hex: z.string(),
      strings: z.array(z.object({ offset: z.number(), text: z.string() })),
    })
    .nullable(),
});
export const browseSchema = z.object({
  path: z.string(),
  parent: z.string(),
  entries: z.array(
    z.object({
      name: z.string(),
      path: z.string(),
      directory: z.boolean(),
      application: z.boolean(),
    }),
  ),
  offset: z.number(),
  total: z.number(),
  nextOffset: z.number().nullable(),
});
export const modelsSchema = z.array(
  z.object({ id: z.string(), name: z.string() }),
);
export function resultValue(run: Pick<Run, "result" | "error">): Json {
  const r = run.result;
  if (!r) return run.error ?? null;
  if (object(r.structuredContent)) return r.structuredContent;
  const c = r.content;
  if (Array.isArray(c)) {
    const text = c
      .filter(object)
      .filter((x) => x.type === "text")
      .map((x) => String(x.text))
      .join("\n");
    try {
      return jsonSchema.parse(JSON.parse(text));
    } catch {
      return text || r;
    }
  }
  return r;
}
export function download(name: string, value: unknown) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
export const pretty = (s: string) =>
  s.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());
const KIND_CATEGORIES: Readonly<Record<string, string>> = {
  "official-proxy": "Binary analysis",
  enhanced: "Binary analysis",
  session: "Binary analysis",
  "native-provider": "Binary analysis",
  "artifact-provider": "Artifacts",
  "firmware-provider": "Artifacts",
  "managed-provider": "Managed code",
  "android-provider": "Applications",
  "apktool-provider": "Applications",
  "jeb-provider": "Applications",
  "adb-provider": "Runtime",
  "browser-provider": "Browser",
  "electron-provider": "JavaScript",
  "runtime-provider": "Runtime",
  application: "Applications",
};
const EVIDENCE_OPERATIONS = new Set([
  "inspect_analysis_view",
  "export_evidence_bundle",
  "import_evidence_bundle",
  "get_evidence_bundle",
  "list_unknowns",
  "record_unknown",
  "update_unknown",
  "verify_unknown_resolution",
  "build_reconstruction_obligation_ledger",
  "evaluate_reconstruction_coverage",
  "verify_reconstruction",
]);
const RUNTIME_OPERATIONS = new Set([
  "observe_native_ui",
  "capture_native_ui_scenario",
  "observe_native_calls",
  "capture_process_scenario",
  "correlate_static_and_runtime",
  "list_javascript_runtime_targets",
  "observe_javascript_runtime",
  "capture_electron_scenario",
]);
const MANAGED_OPERATIONS = new Set([
  "verify_managed_native_boundaries",
  "import_managed_reconstruction",
  "project_managed_application_graph",
]);
/** Group canonical provider kinds and explicit cross-provider operations for analysts. */
export function category(t: Tool): string {
  if (t.name.startsWith("compare_") || t.name === "find_changed_behavior")
    return "Comparisons";
  if (EVIDENCE_OPERATIONS.has(t.name)) return "Evidence";
  if (RUNTIME_OPERATIONS.has(t.name)) return "Runtime";
  if (MANAGED_OPERATIONS.has(t.name)) return "Managed code";
  if (t.name.startsWith("trace_web_") || t.name === "export_web_scripts")
    return "Browser";
  if (
    t.name === "trace_javascript_semantics" ||
    t.name === "recover_javascript_sources"
  )
    return "JavaScript";
  return KIND_CATEGORIES[t.kind ?? t.category ?? ""] ?? "Binary analysis";
}
