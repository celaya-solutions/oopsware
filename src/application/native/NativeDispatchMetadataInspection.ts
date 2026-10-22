import { z } from "zod";
import { addressedValueSchema } from "../../domain/native/nativeInventory.js";
import {
  nativeDispatchMetadataResultSchema,
  inspectNativeDispatchMetadata,
} from "../../domain/native/objcSwiftMetadata.js";
import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";
import { jsonValueSchema } from "../../domain/jsonValue.js";
import { err, ok } from "../../domain/result.js";
import type { AnalysisOperationPort } from "../AnalysisProvider.js";
import type { EnhancedResult } from "../EnhancedToolTypes.js";

/** Source operations for this workflow, shared with capability discovery. */
export const NATIVE_DISPATCH_METADATA_SOURCES = {
  binary: "inspect_native_dispatch_metadata",
  symbols: "list_names",
} as const;

/** Prefer validated binary metadata, otherwise preserve the bound provider's symbol-only coverage. */
export const inspectNativeDispatch = async (
  analysis: AnalysisOperationPort,
  maxRecords: number,
  signal?: AbortSignal,
): EnhancedResult => {
  const binaryMetadata = await analysis.execute(
    NATIVE_DISPATCH_METADATA_SOURCES.binary,
    { max_records: maxRecords },
    signal === undefined ? {} : { signal },
  );
  if (binaryMetadata.ok)
    return ok(
      jsonValueSchema.parse(
        nativeDispatchMetadataResultSchema.parse(binaryMetadata.value.result),
      ),
    );
  if (binaryMetadata.error._tag !== "AnalysisCapabilityUnavailableError")
    return err(binaryMetadata.error);
  const execution = await analysis.execute(
    NATIVE_DISPATCH_METADATA_SOURCES.symbols,
    {},
    signal === undefined ? {} : { signal },
  );
  if (!execution.ok) return err(execution.error);
  const names = z
    .array(
      z.union([
        addressedValueSchema.strict(),
        addressedValueSchema
          .omit({ value: true })
          .extend({ name: z.string() })
          .strict(),
      ]),
    )
    .safeParse(execution.value.result);
  if (!names.success)
    return err(
      new AnalysisOutputError(
        NATIVE_DISPATCH_METADATA_SOURCES.symbols,
        "provider returned an invalid inventory",
      ),
    );
  return ok(
    jsonValueSchema.parse(
      nativeDispatchMetadataResultSchema.parse({
        target_sha256: execution.value.subject?.sha256 ?? null,
        provider: execution.value.provider,
        analysis_profile_digest:
          execution.value.analysisProfile?.digest ?? null,
        result: inspectNativeDispatchMetadata(
          names.data.map((entry) => ({
            address: entry.address,
            name: "value" in entry ? entry.value : entry.name,
          })),
          maxRecords,
        ),
      }),
    ),
  );
};
