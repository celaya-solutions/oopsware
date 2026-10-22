import { z } from "zod";

/** Independent expected outcomes supplied by the verification scenario. */
export const structuredScopeExpectationsSchema = z.record(
  z.string().min(1),
  z.strictObject({
    operation: z.enum([
      "parse-package-json",
      "parse-json-module",
      "parse-html-script-references",
      "parse-local-source-map",
    ]),
    analysis_status: z.enum(["interrupted", "not-started"]),
  }),
);

/** Every retained gap must match the named phase and its unavailable status. */
export const matchesStructuredScopeExpectation = (scopes, expected) =>
  expected !== undefined &&
  scopes.length > 0 &&
  scopes.every(
    ({ evidence, properties }) =>
      evidence.authority === "artifact-bytes" &&
      evidence.state === "unavailable" &&
      evidence.confidence === "unknown" &&
      properties.operation === expected.operation &&
      properties.analysis_status === expected.analysis_status,
  );
