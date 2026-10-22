import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Result } from "../../domain/result.js";
import type {
  InspectMsixPackageInput,
  MsixPackageReport,
} from "../../domain/windowsInstaller/msixPackage.js";
import type {
  InspectWindowsInstallerInput,
  WindowsInstallerReport,
} from "../../domain/windowsInstaller/windowsInstaller.js";

/** Stable read and in-process parsing of one caller-selected MSI, MSIX/AppX package or bundle. */
export interface WindowsInstallerPort {
  readonly identity: ProviderIdentity;
  inspectInstaller(
    input: InspectWindowsInstallerInput,
    options?: ExecutionOptions,
  ): Promise<Result<WindowsInstallerReport, AnalysisError>>;
  inspectMsix(
    input: InspectMsixPackageInput,
    options?: ExecutionOptions,
  ): Promise<Result<MsixPackageReport, AnalysisError>>;
}
