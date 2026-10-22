import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type {
  DecompileManagedTypeInput,
  ManagedDecompilation,
} from "../../domain/managed/managedDecompilation.js";
import type { Result } from "../../domain/result.js";

/** Reconstruct C# for one caller-selected assembly with the admitted ILSpy; the text is inferred. */
export interface ManagedDecompilePort {
  readonly identity: ProviderIdentity;
  decompileType(
    input: DecompileManagedTypeInput,
    options?: ExecutionOptions,
  ): Promise<Result<ManagedDecompilation, AnalysisError>>;
}
