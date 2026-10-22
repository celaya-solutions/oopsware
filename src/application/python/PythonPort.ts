import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Result } from "../../domain/result.js";
import type {
  DecompilePythonCodeInput,
  InspectPythonArtifactInput,
  InspectPythonCodeInput,
  InspectPythonModuleInput,
  PythonArtifactReport,
  PythonCodeReport,
  PythonDecompilation,
  PythonModuleReport,
} from "../../domain/python/python.js";

/** Stable read of one caller-selected .py, .pyc, wheel or zip application; nothing is imported or run. */
export interface PythonPort {
  readonly identity: ProviderIdentity;
  inspectArtifact(
    input: InspectPythonArtifactInput,
    options?: ExecutionOptions,
  ): Promise<Result<PythonArtifactReport, AnalysisError>>;
  inspectModule(
    input: InspectPythonModuleInput,
    options?: ExecutionOptions,
  ): Promise<Result<PythonModuleReport, AnalysisError>>;
  inspectCode(
    input: InspectPythonCodeInput,
    options?: ExecutionOptions,
  ): Promise<Result<PythonCodeReport, AnalysisError>>;
  /** Run the admitted decompiler; the source it returns is inferred. */
  decompileCode(
    input: DecompilePythonCodeInput,
    options?: ExecutionOptions,
  ): Promise<Result<PythonDecompilation, AnalysisError>>;
}
