import { z } from "zod";
import { evidenceInputSchema } from "../evidenceInputContracts.js";

// Borrow inline payloads until application admission; advertise the exact public
// Evidence/reference union without a pre-admission recursive SDK clone.
const input = z.unknown().nonoptional();
input._zod.processJSONSchema = evidenceInputSchema._zod.processJSONSchema;

/** Inventories stay portable; optional observations avoid all-function decompilation. */
export const matchNativeFunctionsInputSchema = z.strictObject({
  left: input.describe(
    "Left list_procedures Evidence or exact retained reference",
  ),
  right: input.describe(
    "Right list_procedures Evidence or exact retained reference",
  ),
  left_observations: z
    .array(input)
    .default([])
    .describe(
      "Optional same-context list_names, procedure_info, read_bytes or analyze_function Evidence",
    ),
  right_observations: z
    .array(input)
    .default([])
    .describe(
      "Optional same-context list_names, procedure_info, read_bytes or analyze_function Evidence",
    ),
  detail: z.enum(["summary", "complete"]).default("summary"),
});
