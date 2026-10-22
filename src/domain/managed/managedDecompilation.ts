import { z } from "zod";

import { facetCoverageSchema } from "../formatRegistry.js";

/**
 * Inferred C# for one type of a .NET assembly, reconstructed by an
 * owner-installed, digest-pinned ILSpy (`ilspycmd`) run by an installed .NET
 * runtime (roadmap item 5, part B). Nothing in the target is loaded or run.
 */

export const DEFAULT_MANAGED_DECOMPILE_FILE_BYTES = 256 * 1024 ** 2;
export const MAX_MANAGED_DECOMPILE_FILE_BYTES = 1024 ** 3;
export const DEFAULT_MANAGED_DECOMPILE_MS = 120_000;
export const MAX_MANAGED_DECOMPILE_MS = 600_000;
export const DEFAULT_MANAGED_SOURCE_BYTES = 4 * 1024 ** 2;
export const MAX_MANAGED_SOURCE_BYTES = 32 * 1024 ** 2;
export const MAX_MANAGED_REFERENCE_PATHS = 16;

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const count = z.number().int().min(0);

export const decompileManagedTypeInputSchema = z.strictObject({
  path: z
    .string()
    .min(1)
    .describe(
      "Absolute path to a caller-selected local .NET assembly (.dll or .exe)",
    ),
  type: z
    .string()
    .min(1)
    .max(1024)
    .optional()
    .describe(
      "Namespace-qualified type name, e.g. Demo.Circle; a nested type as Outer+Inner (its outermost type is decompiled with it). Omit to decompile the whole assembly",
    ),
  reference_paths: z
    .array(z.string().min(1))
    .max(MAX_MANAGED_REFERENCE_PATHS)
    .default([])
    .describe(
      "Absolute directories holding the assembly's dependencies, read as type context only",
    ),
  timeout_ms: z
    .number()
    .int()
    .min(1000)
    .max(MAX_MANAGED_DECOMPILE_MS)
    .default(DEFAULT_MANAGED_DECOMPILE_MS)
    .describe("Wall-clock limit for the decompiler (default 120 s)"),
  max_source_bytes: z
    .number()
    .int()
    .min(1)
    .max(MAX_MANAGED_SOURCE_BYTES)
    .default(DEFAULT_MANAGED_SOURCE_BYTES)
    .describe("Largest reconstructed source returned inline (default 4 MiB)"),
  max_file_bytes: z
    .number()
    .int()
    .min(1)
    .max(MAX_MANAGED_DECOMPILE_FILE_BYTES)
    .default(DEFAULT_MANAGED_DECOMPILE_FILE_BYTES)
    .describe("Maximum stable bytes to read from the file (default 256 MiB)"),
});
export type DecompileManagedTypeInput = z.infer<
  typeof decompileManagedTypeInputSchema
>;

const checkSchema = z.strictObject({
  id: z.enum(["decompiler_clean", "members_present"]),
  state: z.enum(["passed", "failed", "not_checked"]),
  detail: z.string(),
});

export const managedDecompilationSchema = z.strictObject({
  artifact: z.strictObject({
    path: z.string().min(1),
    sha256,
    bytes: count,
  }),
  /** The requested type and the outermost type handed to the decompiler; null for the whole assembly. */
  selection: z.strictObject({
    type: z.string().nullable(),
    decompiled: z.string().nullable(),
    /** Types decompiled with it (nested types), as this reader names them. */
    nested: z.array(z.string()),
  }),
  references: z.array(z.string()),
  decompiler: z.strictObject({
    id: z.literal("ilspycmd"),
    version: z.string(),
    build: z.string(),
    /** SHA-256 over the sorted `path:sha256` lines of every file in the tool folder. */
    tool: z.strictObject({ directory: z.string(), files: count, sha256 }),
    runtime: z.strictObject({ host: z.string(), version: z.string() }),
    arguments: z.array(z.string()),
  }),
  source: z.strictObject({
    /** Inferred C#; it is not the original and may not compile. */
    text: z.string(),
    bytes: count,
    sha256,
    lines: count,
    media_type: z.literal("text/x-csharp; charset=utf-8"),
    confidence: z.literal("inferred"),
    derived_from: z.array(sha256),
  }),
  /** Places the decompiler marked as failed or uncertain, by line. */
  decompiler_notes: z.array(
    z.strictObject({ line: z.number().int().min(1), text: z.string() }),
  ),
  messages: z.array(z.string()),
  checks: z.array(checkSchema),
  /** Members this reader decodes from metadata that the text does not name (capped). */
  missing_members: z.array(
    z.strictObject({
      type: z.string(),
      member: z.string(),
      kind: z.enum(["method", "field"]),
    }),
  ),
  coverage: z.array(facetCoverageSchema),
  limitations: z.array(z.string()),
});
export type ManagedDecompilation = z.infer<typeof managedDecompilationSchema>;
