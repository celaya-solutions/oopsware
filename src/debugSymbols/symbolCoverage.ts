import type { FacetCoverage } from "../domain/formatRegistry.js";

export interface CoverageInput {
  readonly selected: boolean;
  readonly dwarfState: string | null;
  readonly reason: string | null;
  readonly budgetExceeded: boolean;
  readonly problems: boolean;
  /** The view this call returned and where its page stands, when one was read. */
  readonly page: {
    readonly view: string;
    readonly start: number;
    readonly returned: number;
    readonly total: number | null;
    readonly next: number | null;
  } | null;
}

const facet = (
  name: FacetCoverage["facet"],
  state: FacetCoverage["state"],
  rest: Partial<Omit<FacetCoverage, "facet" | "state">>,
): FacetCoverage => ({
  facet: name,
  state,
  examined: null,
  omitted: null,
  reason: null,
  continuation: null,
  ...rest,
});

export const coverageOf = (input: CoverageInput): FacetCoverage[] => [
  facet("identify", "complete", {
    examined:
      "container headers, identifiers and the debug section table of every image",
  }),
  !input.selected
    ? facet("inspect", "partial", {
        examined: "the images and their identifiers",
        omitted: "DWARF units, functions and line tables",
        reason: "More than one image matches.",
        continuation: "Pass architecture or member to select one image.",
      })
    : input.dwarfState !== "dwarf"
      ? facet("inspect", "partial", {
          examined:
            "the selected image's headers, identifiers and section table",
          omitted: "DWARF units, functions and line tables",
          reason: input.reason ?? "The selected image has no readable DWARF.",
          continuation: input.budgetExceeded
            ? "Raise max_decoded_bytes (up to 2 GiB)."
            : null,
        })
      : input.problems
        ? facet("inspect", "partial", {
            examined: "the DWARF units that could be decoded",
            omitted: "units or sections listed in diagnostics",
            reason: "Some DWARF could not be decoded; see diagnostics.",
            continuation: input.budgetExceeded
              ? "Raise max_decoded_bytes (up to 2 GiB)."
              : null,
          })
        : facet("inspect", "complete", {
            examined: input.page
              ? `the selected image's DWARF ${input.page.view} view, rows ${input.page.start} to ${input.page.start + input.page.returned} of ${input.page.total ?? "an unknown number"}`
              : "the selected image's DWARF headers and units",
            continuation:
              input.page?.next === null || input.page === null
                ? null
                : `Pass start=${input.page.next} for the next rows; the other views were not read in this call.`,
          }),
];
