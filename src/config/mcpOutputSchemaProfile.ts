import { z } from "zod";

import { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";

/** Select whether tools/list carries the large output contracts. */
export const mcpOutputSchemaProfileSchema = z.enum(["full", "off"]);

export type McpOutputSchemaProfile = z.infer<
  typeof mcpOutputSchemaProfileSchema
>;

const profileConstraint =
  'REA_MCP_OUTPUT_SCHEMA_PROFILE must be "full" (default) or "off". The off profile omits output schemas from tools/list while REA validates every successful result against its canonical tool contract and returns complete structured content.';

/** Parse the output schema advertisement selection at server composition. */
export const parseMcpOutputSchemaProfile = (
  value: string | undefined,
): Result<McpOutputSchemaProfile | undefined, ConfigurationError> => {
  if (value === undefined) return ok(undefined);
  const parsed = mcpOutputSchemaProfileSchema.safeParse(value);
  return parsed.success
    ? ok(parsed.data)
    : err(
        new ConfigurationError(profileConstraint, {
          settings: [
            {
              setting: "REA_MCP_OUTPUT_SCHEMA_PROFILE",
              constraint: profileConstraint,
            },
          ],
        }),
      );
};
