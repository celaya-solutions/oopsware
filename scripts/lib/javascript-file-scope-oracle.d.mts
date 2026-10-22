import type { z } from "zod";

export interface StructuredScopeExpectation {
  readonly operation:
    | "parse-package-json"
    | "parse-json-module"
    | "parse-html-script-references"
    | "parse-local-source-map";
  readonly analysis_status: "interrupted" | "not-started";
}

export interface StructuredProcessingScope {
  readonly properties: Readonly<Record<string, unknown>>;
  readonly evidence: {
    readonly authority: string;
    readonly state: string;
    readonly confidence: string;
  };
}

export const structuredScopeExpectationsSchema: z.ZodType<
  Record<string, StructuredScopeExpectation>
>;

export function matchesStructuredScopeExpectation(
  scopes: readonly StructuredProcessingScope[],
  expected: StructuredScopeExpectation | undefined,
): boolean;
