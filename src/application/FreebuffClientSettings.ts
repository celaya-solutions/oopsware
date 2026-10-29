import { z } from "zod";
import { ok, type Result } from "../domain/result.js";
import { PRODUCT_IDENTITY } from "../identity.js";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import type { ClientConfigurationDocument } from "./ClientConfigurationDocument.js";
import {
  readConfigurationFile,
  type ClientConfigurationFileError,
} from "./ClientConfigurationFiles.js";
import type { SetupClient } from "./SupportedClients.js";

const stringRecord = z.record(z.string(), z.string());

/**
 * Codebuff's `mcpConfigSchema`, which Freebuff shares: a union of strict
 * remote and stdio entries whose omitted members take defaults.
 */
const freebuffServerSchema = z.union([
  z.strictObject({
    type: z.enum(["http", "sse"]).optional(),
    url: z.string(),
    params: stringRecord.optional(),
    headers: stringRecord.optional(),
  }),
  z.strictObject({
    type: z.literal("stdio").optional(),
    command: z.string(),
    args: z.array(z.string()).optional(),
    env: stringRecord.optional(),
  }),
]);

/**
 * Freebuff skips the whole `mcp.json` when any entry fails its schema, so a
 * neighbouring entry it rejects leaves Oopsware unloaded as well. It also
 * resolves every `env` value that starts with `$` from its own environment.
 */
export const freebuffServersBlock = (
  servers: Readonly<Record<string, unknown>>,
  configPath: string,
): string | undefined => {
  const key = PRODUCT_IDENTITY.mcpServerKey;
  for (const [name, entry] of Object.entries(servers)) {
    if (freebuffServerSchema.safeParse(entry).success) continue;
    return name === key
      ? `Freebuff skips ${configPath} because mcpServers.${key} has members its schema rejects. Run oopsware setup to rewrite the entry with only type, command, args and env.`
      : `Freebuff skips ${configPath}, including mcpServers.${key}, because mcpServers.${name} does not match its schema: a stdio entry may hold only type, command, args and env; a remote entry only type, url, params and headers. Repair or remove that entry, then rerun oopsware setup.`;
  }
  const registration = freebuffServerSchema.safeParse(servers[key]);
  const environment =
    registration.success && "env" in registration.data
      ? (registration.data.env ?? {})
      : {};
  const reference = Object.keys(environment).find((name) =>
    environment[name]?.startsWith("$"),
  );
  return reference === undefined
    ? undefined
    : `Freebuff reads mcpServers.${key}.env.${reference} as a reference to its own environment because the value starts with "$", so Oopsware would not receive it literally. Change that value before rerunning oopsware setup.`;
};

/** Check the servers Freebuff would load after an optional Oopsware registration. */
export const readFreebuffPolicyBlock = async (
  client: SetupClient,
  userDocument?: ClientConfigurationDocument,
  desiredRegistration?: unknown,
  resources?: ArtifactResourceScope,
): Promise<Result<string | undefined, ClientConfigurationFileError>> => {
  if (client.format !== "freebuff") return ok(undefined);
  let document = userDocument;
  if (document === undefined) {
    const read = await readConfigurationFile(
      client.configPath,
      client.format,
      resources,
    );
    if (!read.ok) return read;
    document = read.value;
  }
  return ok(
    freebuffServersBlock(
      {
        ...document?.servers,
        ...(desiredRegistration === undefined
          ? {}
          : { [PRODUCT_IDENTITY.mcpServerKey]: desiredRegistration }),
      },
      client.configPath,
    ),
  );
};
