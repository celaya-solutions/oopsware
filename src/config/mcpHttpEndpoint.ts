import { z } from "zod";

import {
  ConfigurationError,
  type ConfigurationSettingIssue,
} from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";

/** The loopback default keeps the listener local-only until an operator opts out. */
export const DEFAULT_MCP_HTTP_HOST = "127.0.0.1";
/** Port 0 asks the host for an ephemeral port, reported by the listening log line. */
export const DEFAULT_MCP_HTTP_PORT = 0;

/** Decimal TCP port text, shared by the `--port` flag and `MCP_PORT`. */
export const mcpHttpPortSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d*)$/u)
  .transform(Number)
  .pipe(z.number().int().min(0).max(65535));

const mcpHttpHostSchema = z.string().trim().min(1);

export const MCP_HTTP_PORT_CONSTRAINT =
  "MCP_PORT must be a decimal integer between 0 and 65535.";
export const MCP_HTTP_HOST_CONSTRAINT =
  "MCP_HOST must be a non-empty host name or IP address.";

/** Where the streamable HTTP listener binds. */
export interface McpHttpEndpoint {
  readonly host: string;
  readonly port: number;
}

/** Resolve the endpoint: explicit values, then MCP_HOST/MCP_PORT, then loopback defaults. */
export const parseMcpHttpEndpoint = (
  environment: Readonly<NodeJS.ProcessEnv>,
  overrides: Partial<McpHttpEndpoint> = {},
): Result<McpHttpEndpoint, ConfigurationError> => {
  const issues: ConfigurationSettingIssue[] = [];
  let host = overrides.host ?? DEFAULT_MCP_HTTP_HOST;
  let port = overrides.port ?? DEFAULT_MCP_HTTP_PORT;
  if (overrides.host === undefined && environment.MCP_HOST !== undefined) {
    const parsed = mcpHttpHostSchema.safeParse(environment.MCP_HOST);
    if (parsed.success) host = parsed.data;
    else
      issues.push({
        setting: "MCP_HOST",
        constraint: MCP_HTTP_HOST_CONSTRAINT,
      });
  }
  if (overrides.port === undefined && environment.MCP_PORT !== undefined) {
    const parsed = mcpHttpPortSchema.safeParse(environment.MCP_PORT);
    if (parsed.success) port = parsed.data;
    else
      issues.push({
        setting: "MCP_PORT",
        constraint: MCP_HTTP_PORT_CONSTRAINT,
      });
  }
  if (issues.length > 0)
    return err(
      new ConfigurationError(
        issues.map(({ constraint }) => constraint).join(" "),
        { settings: issues },
      ),
    );
  return ok({ host, port });
};
