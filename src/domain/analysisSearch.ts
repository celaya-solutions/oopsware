import { z } from "zod";

import { analysisSearchInput } from "../contracts/analysisSearchContract.js";
import { AnalysisInputError } from "./analysisErrorCore.js";

/** Parsed `search_procedures`/`search_strings` query shared by providers that match in REA. */
export const analysisSearchQuerySchema = z.object(analysisSearchInput);

export type AnalysisSearchQuery = z.infer<typeof analysisSearchQuerySchema>;

/**
 * Match names the way the search contract describes: a literal substring by
 * default, or a Unicode regular expression, case-insensitive unless requested.
 * An invalid pattern is the caller's input error.
 */
export const analysisSearchPredicate = (
  query: AnalysisSearchQuery,
): ((value: string) => boolean) => {
  if (query.mode === "regex") {
    let regex: RegExp;
    try {
      regex = new RegExp(query.pattern, query.case_sensitive ? "u" : "iu");
    } catch (cause: unknown) {
      throw new AnalysisInputError("search", { cause });
    }
    return (value) => regex.test(value);
  }
  const needle = query.case_sensitive
    ? query.pattern
    : query.pattern.toLowerCase();
  return (value) =>
    (query.case_sensitive ? value : value.toLowerCase()).includes(needle);
};
