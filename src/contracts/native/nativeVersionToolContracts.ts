import {
  nativeVersionComparisonInputSchema,
  nativeVersionComparisonResultSchema,
} from "../../domain/nativeVersionComparisonSchemas.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";
import { toolContractMetadata } from "../toolEffects.js";
import type { ToolContract } from "../toolContractTypes.js";

/** Static two-path discovery followed by exact selected-pair comparison. */
export const NATIVE_VERSION_TOOL_CONTRACTS = [
  {
    name: "compare_native_versions",
    ...toolContractMetadata("compare_native_versions"),
    kind: "native-provider",
    description:
      "Compare two explicit local native binary versions without executing them. Collect provider procedure inventories and analyze_function dossiers in owned temporary sessions, preserving the caller's active target. Initial profile: same-format, same-architecture thin Mach-O arm64 or ELF x86_64. Discover address-normalized CFG, classified imports, strings and supported IR/constants candidates; names alone never match. Scores rank observations, not semantic equivalence. Same-artifact/address identity and unique exact provider assembly plus CFG representations pair automatically; assembly normalization removes source addresses only and retains operands. selected_pairs explicitly resolves disputed pairs and reuses compare_functions exact semantics. Returns all source Evidence, ambiguous alternatives, collisions, added/removed candidates and unavailable facets inline. Provider-detected inventory completeness does not establish all real functions. Expansion beyond 100000 candidate pairs fails explicitly to bound retained memory. Providers may create ephemeral analysis files/processes; no sample execution or executable edits.",
    inputSchema: nativeVersionComparisonInputSchema,
    outputSchema: evidenceResultOf(nativeVersionComparisonResultSchema),
    examples: [
      {
        title: "Discover native changes between two builds",
        input: {
          left: { path: "/artifacts/before" },
          right: { path: "/artifacts/after" },
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
