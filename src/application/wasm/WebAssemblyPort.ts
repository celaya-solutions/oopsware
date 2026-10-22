import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Result } from "../../domain/result.js";
import type {
  ConvertWasmToCInput,
  ConvertWasmToTextInput,
  InspectWasmFunctionInput,
  InspectWasmModuleInput,
  WasmFunctionReport,
  WasmModuleReport,
  WasmCConversion,
  WasmTextConversion,
} from "../../domain/wasm/webAssembly.js";

/** Stable read and in-process decoding of one caller-selected WebAssembly file. */
export interface WebAssemblyPort {
  readonly identity: ProviderIdentity;
  inspectModule(
    input: InspectWasmModuleInput,
    options?: ExecutionOptions,
  ): Promise<Result<WasmModuleReport, AnalysisError>>;
  inspectFunction(
    input: InspectWasmFunctionInput,
    options?: ExecutionOptions,
  ): Promise<Result<WasmFunctionReport, AnalysisError>>;
  convertToText(
    input: ConvertWasmToTextInput,
    options?: ExecutionOptions,
  ): Promise<Result<WasmTextConversion, AnalysisError>>;
  /** Run the admitted wasm2c; the C it returns is derived from the module. */
  convertToC(
    input: ConvertWasmToCInput,
    options?: ExecutionOptions,
  ): Promise<Result<WasmCConversion, AnalysisError>>;
}
