import type { ExecutionOptions } from "../application/AnalysisProvider.js";
import type { DebugSymbolsPort } from "../application/debugSymbols/DebugSymbolsPort.js";
import { DEBUG_SYMBOLS_PROVIDER } from "../application/InvestigationProviders.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
  AnalysisUnsupportedTargetError,
} from "../domain/analysisErrorCore.js";
import { ArtifactOperationError } from "../domain/artifactOperationError.js";
import type {
  DebugSymbolsImage,
  DebugSymbolsReport,
  InspectDebugSymbolsInput,
  SymbolDiagnostic,
} from "../domain/debugSymbols/debugSymbols.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  UnitReader,
  DwarfSections,
  readUnitHeaders,
  type UnitHeader,
} from "./dwarfUnits.js";
import {
  DecodeBudget,
  DecodeBudgetExceeded,
  type DebugImage,
  type ImageIdentity,
} from "./image.js";
import { pairImages } from "./pairing.js";
import { OPERATION, openFile, openSymbols, type SymbolFile } from "./source.js";
import { coverageOf } from "./symbolCoverage.js";
import { readView } from "./symbolViews.js";

const MAX_DIAGNOSTICS = 200;

const LIMITATIONS: readonly string[] = [
  "Identifiers decide pairing: a Mach-O UUID, an ELF build id, or a debug link CRC-32 (weaker). A file with the same name is not a match, and a mismatched file is listed but must not be used to name anything in the binary.",
  "DWARF 2 to 5 is read from linked images (ELF executables, shared objects and .debug files; Mach-O dSYM files). Object files need relocations this reader does not apply, split DWARF (.dwo and .dwp) lives in files that are not read, and supplementary files named by .gnu_debugaltlink are not read.",
  "Units, functions and line tables are decoded. Types, variables, scopes, inlined call sites and location expressions are counted but not described. PDB files are not read.",
  "Symbols name and locate things; they do not restore the original program. Nothing is run, and no symbol server, debuginfod server or source file is contacted or read; comp_dir, file names and debug link names are declarations only.",
  "A dSYM's Info.plist and a Mach-O debug map (object files named by N_OSO entries) are not read.",
];

const identityReport = (
  identity: ImageIdentity,
): DebugSymbolsImage["identity"] => ({
  build_id: identity.buildId,
  uuid: identity.uuid,
  debug_link: identity.debugLink,
  debug_alt_link:
    identity.debugAltLink === null
      ? null
      : {
          name: identity.debugAltLink.name,
          build_id: identity.debugAltLink.buildId,
        },
});

const cancelled = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted === true) throw new AnalysisCancelledError(OPERATION);
};

const failure = (
  cause: unknown,
  input: InspectDebugSymbolsInput,
  signal: AbortSignal | undefined,
): AnalysisError => {
  if (signal?.aborted === true)
    return new AnalysisCancelledError(OPERATION, { cause });
  if (
    cause instanceof AnalysisUnsupportedTargetError ||
    cause instanceof AnalysisInputError ||
    cause instanceof ArtifactOperationError ||
    cause instanceof AnalysisResourceConstraintError ||
    cause instanceof AnalysisCancelledError
  )
    return cause;
  if (
    cause instanceof Error &&
    "_tag" in cause &&
    cause._tag !== "DebugFormatError"
  )
    return cause as AnalysisError;
  if (cause instanceof DecodeBudgetExceeded)
    return new AnalysisResourceConstraintError(
      OPERATION,
      "memory",
      cause.message,
      { max_decoded_bytes: input.max_decoded_bytes },
      {
        cause,
        remediationAction: "Raise max_decoded_bytes (up to 2 GiB).",
      },
    );
  return new ArtifactOperationError(
    OPERATION,
    "format",
    undefined,
    `The debug file could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
    { cause },
  );
};

interface Prepared {
  readonly file: SymbolFile;
  readonly image: DebugImage;
  readonly sections: DwarfSections;
  readonly units: readonly UnitHeader[];
  readonly report: DebugSymbolsImage;
}

/** What a debug image holds, decided before any DIE is read. */
const dwarfState = (
  image: DebugImage,
  sections: DwarfSections,
): {
  readonly state: DebugSymbolsImage["dwarf"]["state"];
  readonly reason: string | null;
  readonly units: readonly UnitHeader[];
  readonly problems: readonly string[];
} => {
  const none = (
    state: DebugSymbolsImage["dwarf"]["state"],
    reason: string,
  ) => ({ state, reason, units: [] as UnitHeader[], problems: [] as string[] });
  if (image.relocatable)
    return none(
      "relocatable-object",
      "An object file's DWARF depends on relocations this reader does not apply, so its addresses and references would be wrong. Link the program, or read the linked image or its dSYM.",
    );
  const info = image.sections.find((section) => section.name === ".debug_info");
  if (info === undefined) {
    const dwo = image.sections.some((section) =>
      section.storedName.endsWith(".dwo"),
    );
    return dwo
      ? none(
          "split-dwarf",
          "The DWARF is split into .dwo sections or files, which are not read.",
        )
      : none(
          "none",
          image.identity.debugLink !== null
            ? "The image has no .debug_info; its .gnu_debuglink names a separate debug file."
            : "The image has no .debug_info section.",
        );
  }
  if (info.noBits)
    return none(
      "none",
      "The .debug_info section occupies no file bytes: the debug data was stripped from this file.",
    );
  const read = readUnitHeaders(sections);
  if (sections.get(".debug_info") === undefined)
    return {
      ...none(
        "unreadable",
        [...sections.problems].join(" ") ||
          "The .debug_info section could not be read.",
      ),
    };
  if (
    read.units.length > 0 &&
    read.units.every((unit) => unit.unitType === 4 || unit.unitType === 5)
  )
    return {
      state: "split-dwarf",
      reason:
        "Every unit is a skeleton: the DWARF itself is in .dwo or .dwp files, which are not read.",
      units: read.units,
      problems: read.problems,
    };
  return {
    state: "dwarf",
    reason: null,
    units: read.units,
    problems: read.problems,
  };
};

const prepare = (
  files: readonly SymbolFile[],
  budget: DecodeBudget,
  diagnostics: SymbolDiagnostic[],
): Prepared[] => {
  const prepared: Prepared[] = [];
  for (const file of files) {
    for (const image of file.images) {
      const index = prepared.length;
      const location = `image ${index}${file.member === null ? "" : ` (${file.member})`}`;
      const sections = new DwarfSections(image, budget);
      const state = dwarfState(image, sections);
      const versions = [
        ...new Set(state.units.map((unit) => unit.version)),
      ].sort((a, b) => a - b);
      for (const problem of [...image.problems, ...state.problems])
        diagnostics.push({ location, message: problem });
      prepared.push({
        file,
        image,
        sections,
        units: state.units,
        report: {
          index,
          member: file.member,
          format: image.format,
          architecture: image.architecture,
          bits: image.bits,
          endian: image.littleEndian ? "little" : "big",
          file_type: image.fileType,
          identity: identityReport(image.identity),
          has_symbol_table: image.hasSymbolTable,
          dwarf: {
            state: state.state,
            reason: state.reason,
            versions,
            unit_count: state.units.length,
            sections: image.sections.map((section) => ({
              name: section.name,
              stored_name: section.storedName,
              bytes: section.size,
              compression: section.compression,
              decompressed_bytes: section.declaredSize,
              no_bits: section.noBits,
            })),
          },
          pairing: null,
          selected: false,
          problems: [...image.problems],
        },
      });
    }
  }
  return prepared;
};

const select = (
  prepared: readonly Prepared[],
  input: InspectDebugSymbolsInput,
): {
  readonly selection: DebugSymbolsReport["selection"];
  readonly chosen: Prepared | null;
} => {
  const wanted = input.architecture?.toLowerCase();
  const pool = prepared.filter(
    (item) =>
      (wanted === undefined ||
        item.image.architecture.toLowerCase() === wanted) &&
      (input.member === undefined || item.file.member === input.member),
  );
  if (pool.length === 0)
    throw new AnalysisInputError(OPERATION, undefined, [
      {
        path: [input.member !== undefined ? "member" : "architecture"],
        reason: "invalid_value",
        message: `No image matches. Available: ${prepared
          .map(
            (item) =>
              `${item.image.architecture}${item.file.member === null ? "" : ` in ${item.file.member}`}`,
          )
          .join(", ")}.`,
      },
    ]);
  if (pool.length > 1)
    return {
      chosen: null,
      selection: {
        state: "ambiguous",
        by: null,
        index: null,
        reason: `${pool.length} images match; pass architecture or member to select one.`,
      },
    };
  const chosen = pool[0]!;
  return {
    chosen,
    selection: {
      state: "selected",
      by:
        input.member !== undefined
          ? "member"
          : input.architecture !== undefined
            ? "architecture"
            : "only",
      index: chosen.report.index,
      reason: null,
    },
  };
};

/** Pair one debug image with the binary image of its architecture, by identifier only. */
const pairingFor = (
  item: Prepared,
  binary: SymbolFile,
): NonNullable<DebugSymbolsImage["pairing"]> => {
  const target =
    binary.images.find(
      (candidate) => candidate.architecture === item.image.architecture,
    ) ?? (binary.images.length === 1 ? binary.images[0] : undefined);
  if (target === undefined)
    return {
      binary_image: null,
      checks: [
        {
          kind: "architecture",
          status: "mismatched",
          debug: item.image.architecture,
          binary: binary.images
            .map((candidate) => candidate.architecture)
            .join(", "),
          note: "The binary has no image for this architecture.",
        },
      ],
      verdict: "mismatched",
      strength: "none",
      enrichment_allowed: false,
      reason: "The binary has no image built for this architecture.",
    };
  const result = pairImages(
    item.image,
    { path: item.file.path, bytes: item.file.bytes },
    target,
  );
  return {
    binary_image: binary.images.indexOf(target),
    checks: [...result.checks],
    verdict: result.verdict,
    strength: result.strength,
    enrichment_allowed: result.enrichmentAllowed,
    reason: result.reason,
  };
};

const binaryReport = (
  binary: SymbolFile & { readonly size: number },
): NonNullable<DebugSymbolsReport["binary"]> => ({
  path: binary.path,
  sha256: binary.sha256,
  bytes: binary.size,
  format: binary.images[0]!.format,
  images: binary.images.map((image, index) => ({
    index,
    architecture: image.architecture,
    identity: identityReport(image.identity),
  })),
});

const boundedDiagnostics = (
  diagnostics: SymbolDiagnostic[],
): SymbolDiagnostic[] =>
  diagnostics.length <= MAX_DIAGNOSTICS
    ? diagnostics
    : [
        ...diagnostics.slice(0, MAX_DIAGNOSTICS),
        {
          location: null,
          message: `${diagnostics.length - MAX_DIAGNOSTICS} more diagnostics were not listed.`,
        },
      ];

export class DebugSymbolsProvider implements DebugSymbolsPort {
  readonly identity = DEBUG_SYMBOLS_PROVIDER;

  async inspectSymbols(
    input: InspectDebugSymbolsInput,
    options?: ExecutionOptions,
  ): Promise<Result<DebugSymbolsReport, AnalysisError>> {
    const signal = options?.signal;
    try {
      return ok(await this.#inspect(input, signal));
    } catch (cause) {
      return err(failure(cause, input, signal));
    }
  }

  async #inspect(
    input: InspectDebugSymbolsInput,
    signal: AbortSignal | undefined,
  ): Promise<DebugSymbolsReport> {
    const opened = await openSymbols(input.path, input.max_file_bytes, signal);
    cancelled(signal);
    const binary =
      input.binary === undefined
        ? null
        : await openFile(input.binary, input.max_file_bytes, signal);
    cancelled(signal);
    const diagnostics: SymbolDiagnostic[] = opened.skipped.map((item) => ({
      location: `bundle member ${item.member}`,
      message: `Left out: ${item.reason}`,
    }));
    const prepared = prepare(
      opened.files,
      new DecodeBudget(input.max_decoded_bytes),
      diagnostics,
    );
    if (binary !== null)
      for (const item of prepared)
        item.report.pairing = pairingFor(item, binary);

    const { selection, chosen } = select(prepared, input);
    if (chosen !== null) chosen.report.selected = true;
    cancelled(signal);

    const view =
      chosen !== null && chosen.report.dwarf.state === "dwarf"
        ? readView(
            new UnitReader(chosen.sections),
            chosen.units,
            input,
            diagnostics,
            signal,
          )
        : null;
    if (chosen !== null) {
      const location = `image ${chosen.report.index}`;
      for (const problem of chosen.sections.problems)
        diagnostics.push({ location, message: problem });
      if (view === null)
        diagnostics.push({
          location,
          message: chosen.report.dwarf.reason ?? "No DWARF units were read.",
        });
    }
    const listed = boundedDiagnostics(diagnostics);
    return {
      artifact: opened.artifact,
      binary: binary === null ? null : binaryReport(binary),
      images: prepared.map((item) => item.report),
      selection,
      view: view === null ? null : input.view,
      total: view?.total ?? null,
      page: {
        start: input.start,
        limit: input.limit,
        returned: view?.returned ?? 0,
        next: view?.next ?? null,
      },
      units: view?.units ?? [],
      functions: view?.functions ?? [],
      line_files: view?.lineFiles ?? [],
      lines: view?.lines ?? [],
      diagnostics: listed,
      coverage: coverageOf({
        selected: chosen !== null,
        dwarfState: chosen?.report.dwarf.state ?? null,
        reason: chosen?.report.dwarf.reason ?? null,
        budgetExceeded: chosen?.sections.budgetExceeded ?? false,
        problems: listed.length > 0,
        page:
          view === null
            ? null
            : {
                view: input.view,
                start: input.start,
                returned: view.returned,
                total: view.total,
                next: view.next,
              },
      }),
      limitations: [...LIMITATIONS],
    };
  }
}
