import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Result } from "../../domain/result.js";
import type {
  DebugSymbolsReport,
  InspectDebugSymbolsInput,
} from "../../domain/debugSymbols/debugSymbols.js";

/** Stable read and in-process parsing of one caller-selected debug file and its optional binary. */
export interface DebugSymbolsPort {
  readonly identity: ProviderIdentity;
  inspectSymbols(
    input: InspectDebugSymbolsInput,
    options?: ExecutionOptions,
  ): Promise<Result<DebugSymbolsReport, AnalysisError>>;
}
