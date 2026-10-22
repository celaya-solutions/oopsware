import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Result } from "../../domain/result.js";
import type {
  AndroidArtifactReport,
  DecompileDexClassInput,
  DexClassReport,
  DexDecompilation,
  DexMethodReport,
  InspectAndroidArtifactInput,
  InspectDexClassInput,
  InspectDexMethodInput,
} from "../../domain/android/androidArtifact.js";

/** Stable read and in-process parsing of one caller-selected DEX, APK, App Bundle, APK set or XAPK. */
export interface AndroidPackagePort {
  readonly identity: ProviderIdentity;
  inspectArtifact(
    input: InspectAndroidArtifactInput,
    options?: ExecutionOptions,
  ): Promise<Result<AndroidArtifactReport, AnalysisError>>;
  inspectClass(
    input: InspectDexClassInput,
    options?: ExecutionOptions,
  ): Promise<Result<DexClassReport, AnalysisError>>;
  inspectMethod(
    input: InspectDexMethodInput,
    options?: ExecutionOptions,
  ): Promise<Result<DexMethodReport, AnalysisError>>;
  /** Run the admitted converter and decompiler; the source they return is inferred. */
  decompileClass(
    input: DecompileDexClassInput,
    options?: ExecutionOptions,
  ): Promise<Result<DexDecompilation, AnalysisError>>;
}
