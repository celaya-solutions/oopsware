import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Result } from "../../domain/result.js";
import type {
  InspectLinuxPackageInput,
  LinuxPackageReport,
} from "../../domain/linuxPackage/linuxPackage.js";

/** Stable read and in-process parsing of one caller-selected .deb, .rpm, AppImage or SquashFS image. */
export interface LinuxPackagePort {
  readonly identity: ProviderIdentity;
  inspectPackage(
    input: InspectLinuxPackageInput,
    options?: ExecutionOptions,
  ): Promise<Result<LinuxPackageReport, AnalysisError>>;
}
