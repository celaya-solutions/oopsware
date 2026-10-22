import { inspectModelArtifactInputSchema } from "../../domain/model/modelArtifactQuery.js";
import { z } from "zod";
import { modelArtifactSchema } from "../../domain/model/modelArtifact.js";
import {
  modelArtifactPageViewResultSchema,
  modelArtifactSummaryViewResultSchema,
} from "../../domain/analysisView/analysisView.js";
import type { ToolContract } from "../toolContractTypes.js";
import { toolContractMetadata } from "../toolEffects.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";

export const MODEL_TOOL_CONTRACTS = [
  {
    name: "inspect_model_artifact",
    ...toolContractMetadata("inspect_model_artifact"),
    kind: "artifact-provider",
    description:
      "Inspect local GGUF v2/v3 or safetensors declarations by content, without loading models or executing code. Default hash header reads only the header: full-file SHA-256 and Evidence subject are unknown; artifact.header_sha256 is a scoped prefix commitment, not weight identity. hash full additionally streams all file bytes for SHA-256. Optional view returns a selected metadata/tensor/type page plus model context in this call. Summary retains complete Evidence for inspect_analysis_view kind model-artifact, collection metadata (keys/indices/fields) or tensors (names/types/indices/fields), with stable header-scoped indices and paging. Metadata arrays retain eight-element typed previews; scalar metadata is complete. Tensor counts, shapes, types and offsets are observed; parameter/storage totals are derived from declarations. Unknown GGUF types retain IDs with unknown byte lengths. Tensor payload, model behavior and inference quality are not inspected. One active inspection, 100 MB header ceiling and 32 MiB retained-facts budget; resource refusals are explicit. No network, external files, Python, model runtime, extraction or deserialization of pickle.",
    inputSchema: inspectModelArtifactInputSchema,
    outputSchema: evidenceResultOf(
      z.union([
        modelArtifactSchema,
        modelArtifactSummaryViewResultSchema,
        modelArtifactPageViewResultSchema,
      ]),
    ),
    examples: [
      {
        title: "Read model declarations without reading weights",
        input: {
          path: "/artifacts/model.gguf",
          hash: "header",
          detail: "summary",
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
