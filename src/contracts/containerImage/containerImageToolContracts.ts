import {
  containerImageReportSchema,
  inspectContainerImageInputSchema,
} from "../../domain/containerImage/containerImage.js";
import type { ToolContract } from "../toolContractTypes.js";
import { toolContractMetadata } from "../toolEffects.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";

/** OCI image layouts, OCI archives and Docker save archives (format expansion F09), read in process. */
export const CONTAINER_IMAGE_TOOL_CONTRACTS = [
  {
    name: "inspect_container_image",
    ...toolContractMetadata("inspect_container_image"),
    kind: "artifact-provider",
    description:
      "Read one explicit local OCI image layout directory, OCI image archive or Docker save archive from its bytes, without pulling from a registry, starting Docker, running a container, applying hooks, mounting layers or executing an entrypoint. A plain tar such as a docker export root filesystem has no image configuration or history and is refused. Returns the format; every image the index or manifest.json lists (manifest digest or image id, platform, ref names, annotations, attestation manifests marked) with its manifest or configuration blob recomputed against its digest and size; the selection (a single image is chosen automatically, several need platform such as linux/arm64 or manifest); the selected image's configuration as declarations, not observed behavior (user, working directory, environment, entrypoint, command, exposed ports, volumes, labels, history mapped to layers); each layer with its blob digest and size recomputed, its uncompressed digest checked against the configuration's diff id, compression, entry counts, whiteouts, opaque directories, how many lower-layer entries it hid or replaced, and the history command that made it (foreign layers are listed with their URLs and never fetched; a layer whose digests do not match is read but not applied). Then a page of files: the composed filesystem with whiteouts, opaque directories and replacements applied in layer order, each entry naming the layer it comes from, or with layer set one layer's own entries including its whiteouts. Modes, setuid bits and owners are stated, never applied. extract_artifact materializes the composed filesystem; inspect_artifact lists it in the artifact graph.",
    inputSchema: inspectContainerImageInputSchema,
    outputSchema: evidenceResultOf(containerImageReportSchema),
    examples: [
      {
        title: "Read a Docker save archive",
        input: { path: "/artifacts/app.tar" },
      },
      {
        title: "Select one platform of a multi-platform OCI layout",
        input: { path: "/artifacts/app-layout", platform: "linux/arm64" },
      },
      {
        title: "List what one layer adds and deletes",
        input: { path: "/artifacts/app.tar", layer: 2 },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
