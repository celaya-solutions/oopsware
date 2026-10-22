import type { ExecutionOptions } from "../application/AnalysisProvider.js";
import type { ReaderRunner } from "../application/identification/IdentificationPort.js";
import { IdentificationService } from "../application/identification/IdentificationService.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { AnalysisCapabilityUnavailableError } from "../domain/analysisErrorCore.js";
import type { Evidence } from "../domain/evidence.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import { IdentificationProvider } from "../identification/IdentificationProvider.js";
import { createAndroidPackageService } from "./androidPackage.js";
import { createPeResourcesService } from "./binaryDiagnostics.js";
import { createDesktopApplicationService } from "./desktop.js";
import { runManagedProviderExecution } from "./directAnalysis.js";
import { createDocumentService } from "./documents.js";
import { createGoBinaryService } from "./go.js";
import { createJvmService } from "./jvm.js";
import { createContainerImageService } from "./containerImage.js";
import { createLinuxPackageService } from "./linuxPackage.js";
import { createOfficeDocumentService } from "./officeDocument.js";
import { createPdfDocumentService } from "./pdfDocument.js";
import { createPythonService } from "./python.js";
import { createRustBinaryService } from "./rust.js";
import { createWebAssemblyService } from "./wasm.js";
import { createWindowsInstallerService } from "./windowsInstaller.js";

type Input = { readonly [key: string]: JsonValue };
type Run = (
  input: Input,
  options: ExecutionOptions,
) => Promise<Result<unknown, AnalysisError>>;

/** A reader's report is its Evidence's normalized result. */
const report =
  (
    operation: (
      input: Input,
      options: ExecutionOptions,
    ) => Promise<Result<Evidence, AnalysisError>>,
  ): Run =>
  async (input, options) => {
    const evidence = await operation(input, options);
    return evidence.ok ? ok(evidence.value.normalized_result) : evidence;
  };

/**
 * The in-process readers identification may run, each through its own
 * service so its validation, limits and output checks apply unchanged.
 * Services are created once per runner and reused.
 */
const createReaderRunner = (): ReaderRunner => {
  const linux = createLinuxPackageService();
  const image = createContainerImageService();
  const windows = createWindowsInstallerService();
  const android = createAndroidPackageService();
  const jvm = createJvmService();
  const python = createPythonService();
  const wasm = createWebAssemblyService();
  const document = createDocumentService();
  const pdf = createPdfDocumentService();
  const office = createOfficeDocumentService();
  const go = createGoBinaryService();
  const rust = createRustBinaryService();
  const peResources = createPeResourcesService();
  const runs: Readonly<Record<string, Run>> = {
    inspect_linux_package: report((input, options) =>
      linux.inspectPackage(input, options),
    ),
    inspect_container_image: report((input, options) =>
      image.inspectImage(input, options),
    ),
    inspect_windows_installer: report((input, options) =>
      windows.inspectInstaller(input, options),
    ),
    inspect_msix_package: report((input, options) =>
      windows.inspectMsix(input, options),
    ),
    inspect_android_artifact: report((input, options) =>
      android.inspectArtifact(input, options),
    ),
    inspect_jvm_artifact: report((input, options) =>
      jvm.inspectArtifact(input, options),
    ),
    inspect_python_artifact: report((input, options) =>
      python.inspectArtifact(input, options),
    ),
    inspect_wasm_module: report((input, options) =>
      wasm.inspectModule(input, options),
    ),
    inspect_document: report((input, options) =>
      document.inspect(input, options),
    ),
    inspect_pdf_document: report((input, options) =>
      pdf.inspectDocument(input, options),
    ),
    inspect_office_document: report((input, options) =>
      office.inspectDocument(input, options),
    ),
    inspect_go_binary: report((input, options) => go.inspect(input, options)),
    inspect_rust_binary: report((input, options) =>
      rust.inspect(input, options),
    ),
    inspect_pe_resources: report((input, options) =>
      peResources.inspect(input, options),
    ),
    // One inspection at a time per service: each call owns a fresh one.
    inspect_desktop_application: report(async (input, options) => {
      const desktop = createDesktopApplicationService();
      try {
        return await desktop.inspect(input, options);
      } finally {
        await desktop.close();
      }
    }),
    inspect_managed_artifact: async (input, options) => {
      const path = input.path;
      if (typeof path !== "string")
        return err(
          new AnalysisCapabilityUnavailableError(
            "managed",
            "inspect_managed_artifact",
            "No path was given to the .NET metadata reader.",
          ),
        );
      const execution = await runManagedProviderExecution(
        path,
        "inspect_managed_artifact",
        options.signal,
        {},
      );
      return execution.ok ? ok(execution.value.result) : execution;
    },
  };
  return {
    run: (tool, input, options) => {
      const run = runs[tool];
      return run === undefined
        ? Promise.resolve(
            err(
              new AnalysisCapabilityUnavailableError(
                tool,
                "identify_artifact",
                `Identification does not run ${tool} itself.`,
              ),
            ),
          )
        : run(input, options);
    },
  };
};

/** "What is this?" over the existing detection, artifact readers and reader tools. */
export const createIdentificationService = (
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): IdentificationService =>
  new IdentificationService(
    new IdentificationProvider(environment),
    createReaderRunner(),
  );
