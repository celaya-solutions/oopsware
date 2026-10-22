import type {
  AnalysisExecution,
  ExecutionOptions,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type {
  InspectSqliteDatabaseInput,
  QuerySqliteDatabaseInput,
} from "../../domain/sqlite/sqliteDatabase.js";
import type { Result } from "../../domain/result.js";

/** Offline database inspection boundary shared by CLI and MCP. */
export interface SqliteDatabasePort {
  /** Await and retry provider-owned snapshot cleanup. */
  close?(): Promise<void>;
  inspect(
    input: InspectSqliteDatabaseInput,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>>;
  /** Run one read-only statement on a frozen copy of the selected database. */
  query(
    input: QuerySqliteDatabaseInput,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>>;
}
