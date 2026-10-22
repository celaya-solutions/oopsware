import {
  artifactIdentificationSchema,
  identifyArtifactInputSchema,
} from "../domain/identification/identification.js";
import type { ToolContract } from "./toolContractTypes.js";
import { toolContractMetadata } from "./toolEffects.js";
import { evidenceResultOf } from "./toolOutputSchemaPrimitives.js";

/** "What is this?" for any local file or folder (roadmap item 3). */
export const IDENTIFICATION_TOOL_CONTRACTS = [
  {
    name: "identify_artifact",
    ...toolContractMetadata("identify_artifact"),
    kind: "artifact-provider",
    description:
      'Answer "what is this?" for one explicit local file or folder in one call. No file is run, installed or fetched; nested containers are read with the existing artifact readers, which may use installed decoders (xz, bsdtar) and, on macOS, mount a disk image read-only. Detects the format from its bytes (a name only decides text profiles bytes cannot settle, and is labelled so), runs the in-process reader that owns that format in its cheapest mode for a headline (package name, version, architecture, counts), opens nested archives and packages to depth (default 3 for a file, 0 for a folder), and for a folder or drive walks every entry within max_entries (symlinks listed, never followed; refused or vanished entries named) and tallies files by format. Returns one summary sentence that names every stop, the root detection, a format tally, unrecognized files by extension, the largest files, a page of pieces (format, container state, reader state and headline), and next steps: exact tool calls for deeper reading, including readers that need an installed engine or interpreter, with what they need and which file to open first. Readers run on one piece of each format within max_readers; a reader that refutes a name falls back to what the bytes prove.',
    inputSchema: identifyArtifactInputSchema,
    outputSchema: evidenceResultOf(artifactIdentificationSchema),
    examples: [
      {
        title: "What is this download?",
        input: { path: "/artifacts/release.tar.gz" },
      },
      {
        title: "Inventory a folder and open the archives in it",
        input: { path: "/artifacts/unpacked", depth: 1, limit: 200 },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
