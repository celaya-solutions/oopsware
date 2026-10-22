import {
  projectArtifactIntegrityDetails,
  type ArtifactIntegrityDetails,
} from "./artifactIntegrity.js";
import {
  AnalysisError,
  type AnalysisErrorOptions,
} from "./analysisErrorBase.js";

/** Artifact inventory or extraction failed a typed safety boundary. */
export class ArtifactOperationError extends AnalysisError {
  readonly _tag = "ArtifactOperationError";

  constructor(
    readonly operation:
      | "inventory_artifact"
      | "inspect_artifact"
      | "inspect_desktop_application"
      | "identify_artifact"
      | "generate_sbom"
      | "check_vulnerabilities"
      | "verify_artifact_signature"
      | "inspect_pe_resources"
      | "inspect_document"
      | "inspect_wasm_module"
      | "inspect_wasm_function"
      | "convert_wasm_to_text"
      | "convert_wasm_to_c"
      | "inspect_jvm_artifact"
      | "inspect_jvm_class"
      | "inspect_jvm_method"
      | "inspect_python_artifact"
      | "inspect_python_module"
      | "inspect_python_code"
      | "decompile_python_code"
      | "decompile_managed_type"
      | "inspect_android_artifact"
      | "inspect_dex_class"
      | "inspect_dex_method"
      | "decompile_dex_class"
      | "inspect_linux_package"
      | "inspect_container_image"
      | "inspect_debug_symbols"
      | "inspect_office_document"
      | "inspect_pdf_document"
      | "inspect_windows_installer"
      | "inspect_msix_package"
      | "decompile_jvm_class"
      | "extract_artifact"
      | "decode_interface_builder"
      | "inspect_asset_catalog"
      | "inspect_keyed_archive"
      | "trace_dylib_resolution"
      | "export_web_scripts"
      | "trace_web_module_imports"
      | "trace_web_source_location"
      | "analyze_javascript_application",
    readonly reason:
      | "cancelled"
      | "format"
      | "integrity"
      | "limit"
      | "path"
      | "unavailable"
      | "io",
    readonly artifactDetails?: ArtifactIntegrityDetails,
    /** The specific constraint that failed, such as the colliding path. */
    readonly detail?: string,
    options?: AnalysisErrorOptions,
  ) {
    super(
      artifactDetails === undefined
        ? `Artifact ${operation} failed: ${reason}`
        : artifactDetailsMessage(operation, reason, artifactDetails),
      options,
    );
  }
}

const artifactDetailsMessage = (
  operation: string,
  reason: string,
  details: ArtifactIntegrityDetails,
): string => {
  const { logical_path, ...facts } = projectArtifactIntegrityDetails(details);
  const description = Object.entries(facts)
    .map(([key, value]) => `${key}=${String(value ?? "unavailable")}`)
    .join(", ");
  return `Artifact ${operation} failed: ${reason} at ${logical_path} (${description})`;
};
