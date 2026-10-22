import {
  decompileManagedTypeInputSchema,
  managedDecompilationSchema,
} from "../domain/managed/managedDecompilation.js";
import type { ToolContract } from "./toolContractTypes.js";
import { toolContractMetadata } from "./toolEffects.js";
import { evidenceResultOf } from "./toolOutputSchemaPrimitives.js";

/** .NET reconstruction with the owner-installed ILSpy (roadmap item 5, part B), independent of binary targets. */
export const MANAGED_DECOMPILE_TOOL_CONTRACTS = [
  {
    name: "decompile_managed_type",
    ...toolContractMetadata("decompile_managed_type"),
    kind: "artifact-provider",
    description:
      "Reconstruct C# for one type of an explicit local .NET assembly (.dll or .exe), or for the whole assembly when no type is given, with the installed, digest-pinned ILSpy (ilspycmd), and return it inline labelled as inferred. A nested type is named Outer+Inner; its outermost type is decompiled with every nested type. ilspycmd runs in its own .NET process over a copy in a scratch directory that is removed afterwards, with only HOME (in the scratch) and PATH (the .NET host) set and its update check off; no target code is loaded for execution. Framework types come from the installed .NET runtime and other references only from reference_paths. Two checks follow: ILSpy's own markers (untyped IL offsets, failed methods, listed by line) and whether every method and field this reader decodes from the metadata is named in the text (missing ones listed). Any check that fails or cannot run makes the result partial. When ilspycmd is not installed or is not an admitted build, the tool says so instead of guessing; inspect_managed_members still gives the metadata.",
    inputSchema: decompileManagedTypeInputSchema,
    outputSchema: evidenceResultOf(managedDecompilationSchema),
    examples: [
      {
        title: "Decompile one type",
        input: { path: "/artifacts/App.dll", type: "Demo.Circle" },
      },
      {
        title: "Decompile a nested type with its dependencies as context",
        input: {
          path: "/artifacts/App.dll",
          type: "Demo.Circle+Unit",
          reference_paths: ["/artifacts/deps"],
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
