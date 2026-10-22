import { constants } from "node:buffer";
import type { Writable } from "node:stream";

import { Cli, Filter, Formatter } from "incur";
import { estimateTokenCount, sliceByTokens } from "tokenx";

import {
  parseCliOutputArguments,
  validateCliOutputArguments,
} from "../cliOutput.js";
import {
  cliOperationFailureIdentity,
  cliOperationFailurePayload,
} from "../cliLogging.js";
import { AnalysisResourceConstraintError } from "../domain/analysisErrorCore.js";
import {
  projectAnalysisError,
  type AnalysisErrorProjection,
} from "../domain/analysisErrorProjection.js";
import {
  jsonOutputParts,
  writeJsonOutput,
  writeOutputText,
} from "./jsonOutput.js";
import type { CliInstance } from "./types.js";

/** Result metadata supplied by the command that actually ran. */
export interface CliResultOutputMetadata {
  readonly command: string;
  readonly duration: string;
  readonly format: string;
}

/** Optional executable-owned result surface for one CLI invocation. */
export interface CliResultOutput {
  readonly handled: boolean;
  readonly failed: boolean;
  readonly error: AnalysisErrorProjection | undefined;
  write(value: unknown, metadata: CliResultOutputMetadata): Promise<boolean>;
  /** Recover only before any delegated stdout has been written. */
  recoverFormattingFailure(cause: unknown): Promise<boolean>;
}

type CommandMap = NonNullable<ReturnType<typeof Cli.toCommands.get>>;
type CommandDefinition = Extract<
  CommandMap extends Map<string, infer Entry> ? Entry : never,
  { run: unknown }
>;
const registeredCommands: WeakMap<object, CommandMap> = Cli.toCommands;

/** Install formatting once, after registration, for every ordinary CLI result. */
export const streamCliCommandResults = (
  cli: CliInstance,
  output: CliResultOutput,
): void => {
  const commands = registeredCommands.get(cli);
  if (commands !== undefined) wrapCommands(commands, [], output);
};

const wrapCommands = (
  commands: CommandMap,
  parents: readonly string[],
  output: CliResultOutput,
): void => {
  for (const [name, entry] of commands) {
    const path = [...parents, name];
    if ("_group" in entry) {
      wrapCommands(entry.commands, path, output);
      if (entry.root !== undefined)
        wrapCommand(entry.root, path.join(" "), output);
    } else if (!("_alias" in entry) && !("_fetch" in entry))
      wrapCommand(entry, path.join(" "), output);
  }
};

const wrapCommand = (
  command: Pick<CommandDefinition, "run">,
  name: string,
  output: CliResultOutput,
): void => {
  const run = command.run;
  command.run = (context) => {
    const started = performance.now();
    const result: unknown = run(context);
    // Generator results and Incur's sentinel responses retain their own protocol.
    if (
      typeof result === "object" &&
      result !== null &&
      Symbol.asyncIterator in result
    )
      return result;
    return Promise.resolve(result).then(async (value: unknown) => {
      if (
        typeof value === "object" &&
        value !== null &&
        Symbol.for("incur.sentinel") in value
      )
        return value;
      if (
        !(await output.write(value, {
          command: name,
          format: context.format,
          duration: `${Math.round(performance.now() - started)}ms`,
        }))
      )
        return value;
      if (output.error !== undefined)
        return context.error({
          code: output.error.code,
          message: output.error.message,
        });
      return undefined;
    });
  };
};

/** Preserve Incur output controls and stream JSON while framing failures. */
export const createCliResultOutput = (
  arguments_: readonly string[],
  destination: Writable,
): CliResultOutput | undefined => {
  const options = parseCliOutputArguments(arguments_);
  if (options.parseError || !validateCliOutputArguments(arguments_).ok)
    return undefined;
  const format = options.format as "json" | "jsonl" | "yaml" | "toon" | "md";
  let handled = false;
  let failed = false;
  let error: AnalysisErrorProjection | undefined;
  let completed:
    | {
        readonly metadata: CliResultOutputMetadata;
        readonly originalFailure: ReturnType<
          typeof cliOperationFailureIdentity
        >;
      }
    | undefined;
  const recoverFormattingFailure = async (cause: unknown): Promise<boolean> => {
    // A rejected command never reaches write(). Destination failures retain
    // handled ownership. Only a completed, unwritten result can be replaced.
    if (
      completed === undefined ||
      handled ||
      !(cause instanceof RangeError) ||
      cause.message !== "Invalid string length"
    )
      return false;
    const { originalFailure } = completed;
    error = projectAnalysisError(
      new AnalysisResourceConstraintError(
        completed.metadata.command,
        "memory",
        `The ${format} result could not fit in a runtime string. The original result was not written.`,
        {
          format,
          formatted_characters: null,
          max_string_characters: constants.MAX_STRING_LENGTH,
          ...(originalFailure === undefined
            ? {}
            : { original_failure: originalFailure }),
        },
        {
          cause,
          retryable: false,
          remediationAction:
            "Use --format json to stream the complete result, or narrow it with --filter-output. Token limits are applied after formatting and cannot avoid this constraint.",
        },
      ),
    );
    const document = options.fullOutput
      ? {
          ok: false,
          error,
          meta: {
            command: completed.metadata.command,
            duration: completed.metadata.duration,
          },
        }
      : error;
    // Recovery must remain actionable even when a token window/count was
    // requested. Do not apply those controls to this small typed failure.
    const text = Formatter.format(document, format);
    handled = true;
    try {
      await writeOutputText(destination, `${text}\n`);
    } catch (writeFailure: unknown) {
      failed = true;
      throw writeFailure;
    }
    return true;
  };
  const write = async (
    value: unknown,
    metadata: CliResultOutputMetadata,
  ): Promise<boolean> => {
    completed = undefined;
    if (metadata.format !== format) return false;
    try {
      return await writeResult(value, metadata);
    } catch (cause: unknown) {
      if (await recoverFormattingFailure(cause)) return true;
      throw cause;
    }
  };
  return {
    get handled() {
      return handled;
    },
    get failed() {
      return failed;
    },
    get error() {
      return error;
    },
    write,
    recoverFormattingFailure,
  };

  async function writeResult(
    value: unknown,
    metadata: CliResultOutputMetadata,
  ): Promise<boolean> {
    completed = {
      metadata,
      originalFailure: cliOperationFailureIdentity(value),
    };
    const filterPaths = options.filterOutput
      ? Filter.parse(options.filterOutput)
      : undefined;
    const operationFailure =
      options.fullOutput || filterPaths !== undefined
        ? cliOperationFailurePayload(value)
        : undefined;
    const failure = options.fullOutput ? operationFailure : undefined;
    const filtered: unknown =
      operationFailure ??
      (filterPaths === undefined ? value : Filter.apply(value, filterPaths));
    if (
      operationFailure === undefined &&
      filterPaths !== undefined &&
      filterPaths.length > 0 &&
      (format === "json" || format === "jsonl") &&
      Array.isArray(filtered)
    )
      normalizeFilteredJsonArrays(filtered);
    // Leave successful non-JSON rendering to Incur. This owner handles typed
    // failures when full output is requested or a data filter would erase the
    // failure projection.
    if (
      format !== "json" &&
      format !== "jsonl" &&
      operationFailure === undefined
    )
      return false;
    if (options.tokenCount) {
      // Incur/tokenx materialize JSON. Measure its UTF-16 expansion before
      // allowing that allocation, independently of UTF-8 bytes. Other formats
      // retain Incur's materializing behavior.
      const tokenValue = failure ?? filtered;
      let characters = 0;
      if (
        tokenValue !== undefined &&
        tokenValue !== null &&
        typeof tokenValue !== "function" &&
        typeof tokenValue !== "symbol"
      ) {
        if (format === "json" || format === "jsonl") {
          for (const part of jsonOutputParts(
            tokenValue,
            format,
            format === "json",
          ))
            characters += part.length;
          characters = Math.max(0, characters - 1);
        }
      }
      if (characters <= constants.MAX_STRING_LENGTH) {
        const count = estimateTokenCount(Formatter.format(tokenValue, format));
        handled = true;
        try {
          await writeOutputText(destination, `${count}\n`);
          return true;
        } catch (cause: unknown) {
          failed = true;
          throw cause;
        }
      }
      error = projectAnalysisError(
        new AnalysisResourceConstraintError(
          metadata.command,
          "memory",
          "Token counting requires a formatted string larger than the runtime permits.",
          {
            formatted_characters: characters,
            max_string_characters: constants.MAX_STRING_LENGTH,
          },
          {
            remediationAction:
              "Remove --token-count to stream the complete JSON result, or narrow it with --filter-output.",
          },
        ),
      );
    }
    const meta = {
      command: metadata.command,
      duration: metadata.duration,
    };
    const errorDocument =
      options.fullOutput && failure !== undefined
        ? fullFailureEnvelope(
            failure,
            meta,
            format,
            options.tokenLimit,
            options.tokenOffset,
          )
        : undefined;
    const document = options.fullOutput
      ? failure !== undefined
        ? errorDocument
        : filtered === undefined
          ? { ok: true, meta }
          : { ok: true, data: filtered, meta }
      : // A selected null is a value; only a selection with no JSON value
        // falls back to the empty document.
        filtered === undefined ||
          typeof filtered === "function" ||
          typeof filtered === "symbol"
        ? {}
        : filtered;
    // Once writing starts, a failed destination must not receive a second
    // document from Incur's error formatter.
    const failureText =
      operationFailure !== undefined && format !== "json" && format !== "jsonl"
        ? Formatter.format(document, format)
        : undefined;
    handled = true;
    try {
      if (failureText !== undefined) {
        // Incur's error sentinel only carries code/message/retryable. Render
        // the full caller-visible failure at this output boundary.
        await writeOutputText(destination, `${failureText}\n`);
      } else {
        await writeJsonOutput(
          error === undefined
            ? document
            : options.fullOutput
              ? { ok: false, error, meta }
              : error,
          destination,
          format as "json" | "jsonl",
        );
      }
    } catch (cause: unknown) {
      failed = true;
      throw cause;
    }
    return true;
  }
};

const fullFailureEnvelope = (
  failure: unknown,
  meta: Readonly<Record<string, unknown>>,
  format: "json" | "jsonl" | "yaml" | "toon" | "md",
  tokenLimit: number | undefined,
  tokenOffset: number | undefined,
): Readonly<Record<string, unknown>> => {
  if (tokenLimit === undefined && tokenOffset === undefined)
    return { ok: false, error: failure, meta };
  const formatted = Formatter.format(failure, format);
  const total = estimateTokenCount(formatted);
  const offset = tokenOffset ?? 0;
  const end = tokenLimit === undefined ? total : offset + tokenLimit;
  if (offset === 0 && end >= total) return { ok: false, error: failure, meta };
  const actualEnd = Math.min(end, total);
  const nextOffset = actualEnd < total ? actualEnd : undefined;
  return {
    ok: false,
    error: `${sliceByTokens(formatted, offset, end)}\n[truncated: showing tokens ${offset}–${actualEnd} of ${total}]`,
    meta: { ...meta, ...(nextOffset === undefined ? {} : { nextOffset }) },
  };
};

/** Filter.apply owns these mapped arrays; an empty path list returns the source. */
const normalizeFilteredJsonArrays = (selection: unknown[]): void => {
  const pending = [selection];
  while (pending.length > 0) {
    const array = pending.pop()!;
    for (let index = 0; index < array.length; index += 1) {
      const value: unknown = array[index];
      if (
        value === undefined ||
        typeof value === "function" ||
        typeof value === "symbol"
      )
        array[index] = null;
      else if (Array.isArray(value)) pending.push(value);
    }
  }
};
