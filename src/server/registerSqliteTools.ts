import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { SqliteDatabaseService } from "../application/sqlite/SqliteDatabaseService.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { Logger } from "pino";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import { createEvidenceToolHandler } from "./contractToolHandler.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

/** Bind snapshot inspection and read-only queries to their named contracts and additive session Evidence. */
export const registerSqliteTools = (
  server: EvidenceMcpServer,
  service: SqliteDatabaseService,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  withAdmittedAnalysis?: WithAdmittedAnalysis,
): void => {
  const inspection = toolContract("inspect_sqlite_database");
  const query = toolContract("query_database_readonly");
  const handler = createEvidenceToolHandler(
    server,
    (input, options) => service.inspect(input, options),
    logger,
    recordEvidence,
    withAdmittedAnalysis,
  );
  server.registerTool(
    inspection.name,
    toolRegistrationOptions(inspection),
    handler(inspection),
  );
  const queryHandler = createEvidenceToolHandler(
    server,
    (input, options) => service.query(input, options),
    logger,
    recordEvidence,
    withAdmittedAnalysis,
  );
  server.registerTool(
    query.name,
    toolRegistrationOptions(query),
    queryHandler(query),
  );
};
