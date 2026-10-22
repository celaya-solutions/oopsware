const UNSUPPORTED_OUTPUT_COMBINATION_MESSAGE =
  "Token windows cannot preserve structured output. Remove --token-limit/--token-offset and use --filter-output or command pagination.";

type StructuredOutputFormat = "json" | "jsonl" | "yaml";
const INCUR_OUTPUT_FORMATS = new Set(["toon", "json", "yaml", "md", "jsonl"]);
/** Global output flags that take a value. */
const VALUED_OUTPUT_FLAGS = new Set([
  "--format",
  "--filter-output",
  "--token-limit",
  "--token-offset",
]);

const ROOT_UPDATE_OUTPUT_FLAGS = new Set([
  "--json",
  "--full-output",
  "--token-count",
]);

/**
 * Route the root update alias and split `--flag=value` output forms. Incur reads these
 * flags only in spaced form, so `--format=json` otherwise reaches the command
 * parser and fails as an unknown flag. Command options accept both forms.
 */
export const normalizeCliArguments = (
  arguments_: readonly string[],
): string[] => {
  const normalized: string[] = [];
  const updates = new Set<number>();
  let rootUpdate = true;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (VALUED_OUTPUT_FLAGS.has(argument) && arguments_[index + 1]) {
      // Incur consumes a nonempty spaced value before looking for more flags.
      // Its contents belong to that option, even when they look like a flag.
      normalized.push(argument, arguments_[index + 1]!);
      index += 1;
      continue;
    }
    const separator = argument.indexOf("=");
    const flag = argument.slice(0, separator);
    if (separator >= 0 && VALUED_OUTPUT_FLAGS.has(flag))
      normalized.push(flag, argument.slice(separator + 1));
    else {
      if (argument === "--update") updates.add(normalized.length);
      else if (!ROOT_UPDATE_OUTPUT_FLAGS.has(argument)) rootUpdate = false;
      normalized.push(argument);
    }
  }
  // Output option values were consumed above; flag-shaped data is never an alias.
  // Help/check/command/unknown tokens retain Incur's parsing and precedence.
  return rootUpdate && updates.size > 0
    ? ["update", ...normalized.filter((_, index) => !updates.has(index))]
    : normalized;
};

export type CliOutputArgumentValidation =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly format: StructuredOutputFormat;
      readonly code:
        | "UNSUPPORTED_OUTPUT_COMBINATION"
        | "INVALID_OUTPUT_FILTER"
        | "MISSING_OUTPUT_VALUE";
      readonly message: string;
    };

interface ParsedCliOutputArguments {
  readonly filterOutput: string | undefined;
  readonly format: string;
  readonly fullOutput: boolean;
  /** First valued output flag that Incur skips because it has no value. */
  readonly missingValue: string | undefined;
  readonly parseError: boolean;
  readonly tokenCount: boolean;
  readonly tokenWindow: boolean;
  readonly tokenLimit: number | undefined;
  readonly tokenOffset: number | undefined;
}

/** Read effective Incur output controls at the executable boundary. */
export const parseCliOutputArguments = (
  arguments_: readonly string[],
): ParsedCliOutputArguments => {
  let format: string = "toon";
  let filterOutput: string | undefined;
  let fullOutput = false;
  let missingValue: string | undefined;
  let tokenCount = false;
  let tokenLimit: number | undefined;
  let tokenOffset: number | undefined;
  const parsed = (parseError: boolean): ParsedCliOutputArguments => ({
    filterOutput,
    format,
    fullOutput,
    missingValue,
    parseError,
    tokenCount,
    tokenWindow:
      !parseError && (tokenLimit !== undefined || tokenOffset !== undefined),
    tokenLimit: parseError ? undefined : tokenLimit,
    tokenOffset: parseError ? undefined : tokenOffset,
  });
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    // Incur scans builtins across `--` and reads spaced value forms, which
    // normalizeCliArguments has produced. Mirror those effective values.
    if (argument === "--json") {
      format = "json";
      continue;
    }
    if (argument === "--format") {
      const value = arguments_[index + 1];
      if (value) {
        // Incur stops parsing at an invalid format before applying any later
        // output controls. Let it report that malformed flag itself.
        if (!INCUR_OUTPUT_FORMATS.has(value)) return parsed(true);
        format = value;
        index += 1;
      } else missingValue ??= argument;
      continue;
    }
    if (argument === "--filter-output") {
      if (arguments_[index + 1]) {
        filterOutput = arguments_[index + 1];
        index += 1;
      } else missingValue ??= argument;
      continue;
    }
    if (argument === "--token-limit" || argument === "--token-offset") {
      const value = arguments_[index + 1];
      if (value) {
        const numericValue = Number(value);
        if (!Number.isFinite(numericValue) || value.trim() === "")
          return parsed(true);
        if (argument === "--token-limit") tokenLimit = numericValue;
        else tokenOffset = numericValue;
        index += 1;
      } else missingValue ??= argument;
      continue;
    }
    if (argument === "--full-output") fullOutput = true;
    if (argument === "--token-count") tokenCount = true;
  }
  return parsed(false);
};

/** Reject slices that cannot advance within Incur's comma-delimited paths. */
const hasUnclosedFilterSlice = (expression: string): boolean => {
  let depth = 0;
  let unclosed = false;
  for (const character of expression) {
    if (character === "[") {
      depth += 1;
      unclosed = true;
    } else if (character === "]") {
      depth -= 1;
      // Incur consumes everything through the next closing bracket, including
      // nested opening brackets. Do not impose a different filter grammar.
      unclosed = false;
    } else if (character === "," && depth === 0 && unclosed) return true;
  }
  return unclosed;
};

/** Reject output controls that cannot safely produce a complete result. */
export const validateCliOutputArguments = (
  arguments_: readonly string[],
): CliOutputArgumentValidation => {
  const { filterOutput, format, missingValue, parseError, tokenWindow } =
    parseCliOutputArguments(arguments_);
  if (parseError) return { ok: true };
  if (filterOutput !== undefined && hasUnclosedFilterSlice(filterOutput))
    return {
      ok: false,
      format: format === "yaml" || format === "jsonl" ? format : "json",
      code: "INVALID_OUTPUT_FILTER",
      message:
        "The --filter-output expression has a slice without a closing ]. Close the slice or remove --filter-output.",
    };
  if (
    tokenWindow &&
    (format === "json" || format === "jsonl" || format === "yaml")
  )
    return {
      ok: false,
      format,
      code: "UNSUPPORTED_OUTPUT_COMBINATION",
      message: UNSUPPORTED_OUTPUT_COMBINATION_MESSAGE,
    };
  // Incur skips a valued flag without a value and then reports the flag
  // itself as unknown. Name the missing value instead.
  if (missingValue !== undefined)
    return {
      ok: false,
      format: format === "yaml" || format === "jsonl" ? format : "json",
      code: "MISSING_OUTPUT_VALUE",
      message: `${missingValue} requires a value, as in ${missingValue} <value> or ${missingValue}=<value>.`,
    };
  return { ok: true };
};

/** Preserve a complete document when Incur filters the entire result away. */
export const renderEmptyFilteredCliOutput = (
  arguments_: readonly string[],
): string | undefined => {
  const { filterOutput, format, parseError } =
    parseCliOutputArguments(arguments_);
  if (parseError) return undefined;
  if (
    filterOutput &&
    (format === "json" || format === "jsonl" || format === "yaml")
  )
    return "{}\n";
  return undefined;
};

/** Render one complete structured error before command execution. */
export const renderCliOutputArgumentError = (
  error: Exclude<CliOutputArgumentValidation, { readonly ok: true }>,
): string => {
  const value = {
    ok: false,
    error: { code: error.code, message: error.message },
  };
  if (error.format === "yaml")
    return `ok: false\nerror:\n  code: ${error.code}\n  message: ${JSON.stringify(error.message)}\n`;
  return `${JSON.stringify(value)}\n`;
};
