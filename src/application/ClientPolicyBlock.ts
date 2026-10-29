import type { Result } from "../domain/result.js";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import type { ClientConfigurationDocument } from "./ClientConfigurationDocument.js";
import type { ClientConfigurationFileError } from "./ClientConfigurationFiles.js";
import { readFreebuffPolicyBlock } from "./FreebuffClientSettings.js";
import { readGeminiPolicyBlock } from "./GeminiClientSettings.js";
import type { SetupClient } from "./SupportedClients.js";

/**
 * Explain why a client would not load the Oopsware registration despite a
 * matching entry, or return nothing. Each client's loading rules have one owner.
 */
export const readClientPolicyBlock = (
  client: SetupClient,
  userDocument?: ClientConfigurationDocument,
  desiredRegistration?: unknown,
  resources?: ArtifactResourceScope,
): Promise<Result<string | undefined, ClientConfigurationFileError>> =>
  client.format === "freebuff"
    ? readFreebuffPolicyBlock(
        client,
        userDocument,
        desiredRegistration,
        resources,
      )
    : readGeminiPolicyBlock(
        client,
        userDocument,
        desiredRegistration,
        resources,
      );
