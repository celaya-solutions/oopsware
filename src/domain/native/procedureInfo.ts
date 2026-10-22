import { z } from "zod";
import {
  functionBodySchema,
  localVariableSchema,
  procedureClassificationSchema,
} from "../hopperValues.js";

/** Provider-neutral procedure metadata, including exact body ranges. */
export const procedureInfoSchema = z.object({
  name: z.string(),
  entrypoint: z.string(),
  basicblock_count: z.number().int().min(0),
  length: z.number().min(0),
  signature: z.string().nullable(),
  locals: z.array(localVariableSchema),
  classification: procedureClassificationSchema.nullable(),
  body: functionBodySchema,
});
