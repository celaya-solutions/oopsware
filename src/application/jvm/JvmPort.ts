import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Result } from "../../domain/result.js";
import type {
  DecompileJvmClassInput,
  InspectJvmArtifactInput,
  InspectJvmClassInput,
  InspectJvmMethodInput,
  JvmArtifactReport,
  JvmClassReport,
  JvmDecompilation,
  JvmMethodReport,
} from "../../domain/jvm/jvm.js";

/** Stable read and in-process parsing of one caller-selected class file, JAR or AAR. */
export interface JvmPort {
  readonly identity: ProviderIdentity;
  inspectArtifact(
    input: InspectJvmArtifactInput,
    options?: ExecutionOptions,
  ): Promise<Result<JvmArtifactReport, AnalysisError>>;
  inspectClass(
    input: InspectJvmClassInput,
    options?: ExecutionOptions,
  ): Promise<Result<JvmClassReport, AnalysisError>>;
  inspectMethod(
    input: InspectJvmMethodInput,
    options?: ExecutionOptions,
  ): Promise<Result<JvmMethodReport, AnalysisError>>;
  /** Run the admitted decompiler; the source it returns is inferred. */
  decompileClass(
    input: DecompileJvmClassInput,
    options?: ExecutionOptions,
  ): Promise<Result<JvmDecompilation, AnalysisError>>;
}
