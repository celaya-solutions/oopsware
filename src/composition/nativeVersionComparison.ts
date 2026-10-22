import { parseConfig } from "../config/parseConfig.js";
import { NativeVersionComparison } from "../application/NativeVersionComparison.js";
import { createBinarySession } from "./binary.js";
import { ok } from "../domain/result.js";
import type { Logger } from "pino";
import { snapshotEnvironment } from "../process/snapshotEnvironment.js";

/** Bind owned comparison sessions to the caller-selected configuration. */
export const createNativeVersionComparison = (
  selectedEnvironment: Readonly<NodeJS.ProcessEnv>,
  logger: Logger,
): NativeVersionComparison => {
  const environment = snapshotEnvironment(selectedEnvironment);
  return new NativeVersionComparison(() => {
    const config = parseConfig(environment);
    return config.ok
      ? ok(createBinarySession(config.value, logger, environment))
      : config;
  });
};
