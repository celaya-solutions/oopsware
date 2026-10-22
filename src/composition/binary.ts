import { isAppleDispatchMetadataTarget } from "../domain/native/objcSwiftMetadata.js";
import { snapshotEnvironment } from "../process/snapshotEnvironment.js";
import type { AppConfig } from "../config/types.js";
import type { BinarySession } from "../application/binary/BinarySession.js";
import { HopperProvider } from "../hopper/HopperProvider.js";
import { GhidraProvider } from "../ghidra/GhidraProvider.js";
import { IdaProvider } from "../ida/IdaProvider.js";
import { KunaProvider } from "../kuna/KunaProvider.js";
import type { Logger } from "pino";
import { auxiliaryAnalysisProviderDeclarations } from "./auxiliaryAnalysisProviders.js";
import { AnalysisProviderRegistry } from "../application/binary/AnalysisProviderRegistry.js";
import { composeBinarySession } from "../application/binary/BinarySessionComposition.js";
import { LazyAnalysisProvider } from "../application/binary/LazyAnalysisProvider.js";
import { ManagedStaticProvider } from "../dotnet/ManagedStaticProvider.js";

/**
 * Compose the target-switching runtime shared directly by CLI and MCP adapters.
 * This is the sole production wiring point, so both adapters share identical
 * provider selection, profile, lifecycle, and Evidence semantics.
 */
export const createBinarySession = (
  config: AppConfig,
  logger: Logger,
  selectedEnvironment: Readonly<NodeJS.ProcessEnv>,
): BinarySession =>
  composeDeepBinarySession(config, logger, selectedEnvironment);

/** Prefer byte-backed dispatch inspection while retaining deep symbol fallback. */
export const createNativeDispatchBinarySession = (
  config: AppConfig,
  logger: Logger,
  selectedEnvironment: Readonly<NodeJS.ProcessEnv>,
): BinarySession =>
  composeDeepBinarySession(
    config,
    logger,
    selectedEnvironment,
    "inspect_native_dispatch_metadata",
  );

const composeDeepBinarySession = (
  config: AppConfig,
  logger: Logger,
  selectedEnvironment: Readonly<NodeJS.ProcessEnv>,
  inspection?: "inspect_native_dispatch_metadata",
): BinarySession => {
  const environment = snapshotEnvironment(selectedEnvironment);
  const hopper = new HopperProvider(config, logger, environment);
  const ghidra = new GhidraProvider(config, logger, environment);
  const ida = new IdaProvider(config, environment);
  const kuna = new KunaProvider(environment);
  const auxiliaryDeclarations =
    auxiliaryAnalysisProviderDeclarations(environment);
  const nativeInspectionAvailable =
    inspection !== undefined &&
    auxiliaryDeclarations.some(({ capabilities }) =>
      capabilities.some(
        ({ operation, available }) => operation === inspection && available,
      ),
    );
  return composeBinarySession(
    new AnalysisProviderRegistry(
      [hopper, ghidra, ida, kuna],
      config.analysisProvider,
      nativeInspectionAvailable ? isAppleDispatchMetadataTarget : undefined,
    ),
    auxiliaryDeclarations.map(
      (declaration) => new LazyAnalysisProvider(declaration),
    ),
  );
};

/** Compose an execution-free managed session without native provider selection. */
export const createManagedBinarySession = (): BinarySession =>
  composeBinarySession(new AnalysisProviderRegistry([]), [
    new ManagedStaticProvider(),
  ]);

/** Compose the artifact operations without candidates for deep analysis engines. */
export const createArtifactBinarySession = (
  selectedEnvironment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform = process.platform,
): Promise<BinarySession> =>
  import("../artifacts/ArtifactProvider.js").then(({ ArtifactProvider }) =>
    composeBinarySession(new AnalysisProviderRegistry([]), [
      new ArtifactProvider(
        snapshotEnvironment(selectedEnvironment, platform),
        platform,
      ),
    ]),
  );

/** Compose native inspection utilities without candidates for deep analysis. */
export const createNativeBinarySession = (
  selectedEnvironment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform = process.platform,
): Promise<BinarySession> =>
  import("../native/NativeMacOSProvider.js").then(({ NativeMacOSProvider }) =>
    composeBinarySession(new AnalysisProviderRegistry([]), [
      new NativeMacOSProvider(
        snapshotEnvironment(selectedEnvironment, platform),
        undefined,
        platform,
      ),
    ]),
  );
