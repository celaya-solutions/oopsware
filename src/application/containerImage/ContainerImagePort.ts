import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Result } from "../../domain/result.js";
import type {
  ContainerImageReport,
  InspectContainerImageInput,
} from "../../domain/containerImage/containerImage.js";

/** Stable read and in-process parsing of one caller-selected OCI or Docker image. */
export interface ContainerImagePort {
  readonly identity: ProviderIdentity;
  inspectImage(
    input: InspectContainerImageInput,
    options?: ExecutionOptions,
  ): Promise<Result<ContainerImageReport, AnalysisError>>;
}
