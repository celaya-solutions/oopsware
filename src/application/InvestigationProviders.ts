import type { AnalysisOperation } from "./AnalysisProvider.js";
import {
  createAnalysisProfile,
  type AnalysisProfileCommitment,
} from "../domain/analysisProfile.js";

/** Provider identity for deterministic composed analysis workflows. */
export const REA_WORKFLOW_PROVIDER = {
  id: "rea-workflow",
  name: "Oopsware composed investigation workflow",
  version: "1",
} as const;

/** Commit a workflow result to its upstream profile and applicable semantic revision. */
export const workflowAnalysisProfile = (
  upstream: AnalysisProfileCommitment,
  operation?: AnalysisOperation,
): AnalysisProfileCommitment =>
  createAnalysisProfile(REA_WORKFLOW_PROVIDER, {
    upstream_analysis_profile: upstream,
    source_limitations: "provider-operation-caveats-v1",
    ...(operation === "binary_overview"
      ? { workflow_revision: 4 }
      : operation === "batch_decompile" ||
          operation === "get_call_graph" ||
          operation === "trace_feature"
        ? { workflow_revision: 3 }
        : { workflow_revision: 1 }),
  });

/** Provider identity for deterministic artifact inventories. */
export const ARTIFACT_GRAPH_PROVIDER = Object.freeze({
  id: "rea-artifact-graph",
  name: "Oopsware safe artifact graph provider",
  version: "1",
} as const);

/** Provider identity for execution-free managed PE/CLI analysis. */
export const MANAGED_STATIC_PROVIDER = Object.freeze({
  id: "rea-dotnet-static",
  name: "Oopsware managed static analysis provider",
  version: "1",
} as const);

/** Provider identity for .NET reconstruction by an owner-installed, digest-pinned ilspycmd. */
export const MANAGED_DECOMPILE_PROVIDER = Object.freeze({
  id: "rea-dotnet-ilspy",
  name: "Oopsware .NET decompiler (ILSpy)",
  version: "1",
} as const);

/** Provider identity for local package inventories and offline security checks. */
export const SUPPLY_CHAIN_PROVIDER = Object.freeze({
  id: "rea-supply-chain",
  name: "Oopsware offline supply-chain checks",
  version: "1",
} as const);

/** Provider identity for in-process structured-text reading (F11). */
export const STRUCTURED_TEXT_PROVIDER = Object.freeze({
  id: "rea-structured-text",
  name: "Oopsware structured-text reader",
  version: "1",
} as const);

/** Provider identity for in-process WebAssembly decoding; wabt.js only validates and renders text. */
export const WEBASSEMBLY_PROVIDER = Object.freeze({
  id: "rea-webassembly",
  name: "Oopsware WebAssembly reader",
  version: "1",
} as const);

/** Provider identity for in-process class file, JAR and AAR parsing; no JVM is started. */
export const JVM_PROVIDER = Object.freeze({
  id: "rea-jvm",
  name: "Oopsware JVM class reader",
  version: "1",
} as const);

/** Provider identity for in-process CPython bytecode, wheel and zip application reading; source goes to an installed interpreter's ast module. */
export const PYTHON_PROVIDER = Object.freeze({
  id: "rea-python",
  name: "Oopsware Python reader",
  version: "1",
} as const);

/** Provider identity for in-process DEX, APK, App Bundle, APK set and XAPK reading. */
export const ANDROID_PACKAGE_PROVIDER = Object.freeze({
  id: "rea-android",
  name: "Oopsware Android package reader",
  version: "1",
} as const);

/** Provider identity for in-process Debian, RPM, AppImage and SquashFS reading. */
export const LINUX_PACKAGE_PROVIDER = Object.freeze({
  id: "rea-linux-package",
  name: "Oopsware Linux package reader",
  version: "1",
} as const);

/** Provider identity for in-process OCI image layout, OCI archive and Docker save reading. */
export const CONTAINER_IMAGE_PROVIDER = Object.freeze({
  id: "rea-container-image",
  name: "Oopsware container image reader",
  version: "1",
} as const);

/** Provider identity for in-process DWARF reading of ELF and Mach-O debug files. */
export const DEBUG_SYMBOLS_PROVIDER = Object.freeze({
  id: "rea-debug-symbols",
  name: "Oopsware debug symbols reader",
  version: "1",
} as const);

/** Provider identity for in-process Windows Installer, MSIX and AppX reading. */
export const WINDOWS_INSTALLER_PROVIDER = Object.freeze({
  id: "rea-windows-installer",
  name: "Oopsware Windows installer reader",
  version: "1",
} as const);

/** Provider identity for "What is this?": detection, nested containers and folder inventory. */
export const IDENTIFICATION_PROVIDER = Object.freeze({
  id: "rea-identification",
  name: "Oopsware identification",
  version: "1",
} as const);

/** Provider identity for portable, execution-free PE resource decoding. */
export const PE_RESOURCES_PROVIDER = Object.freeze({
  id: "rea-pe-resources",
  name: "Oopsware PE resource parser",
  version: "1",
} as const);

/** Provider identity for deterministic managed-code comparison workflows. */
export const MANAGED_WORKFLOW_PROVIDER = {
  id: "rea-dotnet-workflows",
  name: "Oopsware managed-code workflows",
  version: "1",
} as const;

/** Provider identity for deterministic Apple application projections. */
export const APPLE_APPLICATION_PROVIDER = {
  id: "rea-apple-application",
  name: "Oopsware Apple application workflows",
  version: "1",
} as const;

/** Provider identity for deterministic Android application projections. */
export const ANDROID_APPLICATION_PROVIDER = {
  id: "rea-android-application",
  name: "Oopsware Android application workflows",
  version: "1",
} as const;

/** Provider identity for deterministic HarmonyOS application projections. */
export const HARMONY_APPLICATION_PROVIDER = {
  id: "rea-harmony-application",
  name: "REA HarmonyOS application workflows",
  version: "1",
} as const;

/** Provider identity for verified publication of retained website scripts. */
export const WEB_SCRIPT_EXPORT_PROVIDER = {
  id: "rea-web-script-export",
  name: "Oopsware captured script export",
  version: "1",
} as const;

/** Provider identity for deterministic static JavaScript application analysis. */
export const JAVASCRIPT_APPLICATION_PROVIDER = {
  id: "rea-javascript-application",
  name: "Oopsware JavaScript application analyzer",
  version: "1",
} as const;

/** Provider identity for static/passive-runtime JavaScript reconciliation. */
export const JAVASCRIPT_RUNTIME_RECONCILIATION_PROVIDER = {
  id: "rea-javascript-runtime-reconciliation",
  name: "Oopsware JavaScript runtime reconciliation",
  version: "1",
} as const;

/** Provider identity for selected views of retained analysis Evidence. */
export const ANALYSIS_VIEW_PROVIDER = {
  id: "rea-analysis-view",
  name: "Oopsware analysis view projection",
  version: "1",
} as const;

/** Provider identity for graph-native feature tracing and version comparison. */
export const JAVASCRIPT_APPLICATION_WORKFLOW_PROVIDER = {
  id: "rea-javascript-application-workflows",
  name: "Oopsware JavaScript application workflows",
  version: "1",
} as const;

/** Provider identity for deterministic cross-artifact comparisons. */
export const ARTIFACT_COMPARISON_PROVIDER = {
  id: "rea-artifact-comparison",
  name: "Oopsware artifact comparison",
  version: "1",
} as const;

/** Provider identity for deterministic cross-function comparisons. */
export const FUNCTION_COMPARISON_PROVIDER = {
  id: "rea-function-comparison",
  name: "Oopsware function comparison",
  version: "1",
} as const;

/** Provider identity for deterministic Evidence bundle comparisons. */
export const BUNDLE_COMPARISON_PROVIDER = {
  id: "rea-bundle-comparison",
  name: "Oopsware Evidence bundle comparison",
  version: "1",
} as const;

/** Provider identity for comparison-Evidence behavior aggregation. */
export const CHANGED_BEHAVIOR_PROVIDER = {
  id: "rea-changed-behavior",
  name: "Oopsware changed behavior investigation",
  version: "1",
} as const;

/** Provider identity for Evidence-backed call-path reconstruction. */
export const CALL_PATH_PROVIDER = {
  id: "rea-call-path",
  name: "Oopsware call path reconstruction",
  version: "1",
} as const;

/** Provider identity for explicit static/runtime hypothesis correlation. */
export const STATIC_RUNTIME_PROVIDER = {
  id: "rea-static-runtime-correlation",
  name: "Oopsware static/runtime correlation",
  version: "1",
} as const;

/** Provider identity for finite reconstruction specification verification. */
export const RECONSTRUCTION_PROVIDER = {
  id: "rea-reconstruction-verifier",
  name: "Oopsware reconstruction verifier",
  version: "1",
} as const;

/** Provider identity for in-process Office Open XML reading. */
export const OFFICE_DOCUMENT_PROVIDER = Object.freeze({
  id: "rea-office-document",
  name: "Oopsware Office document reader",
  version: "1",
} as const);

/** Provider identity for PDF structure reading and Poppler page text. */
export const PDF_DOCUMENT_PROVIDER = Object.freeze({
  id: "rea-pdf-document",
  name: "Oopsware PDF reader",
  version: "1",
} as const);
