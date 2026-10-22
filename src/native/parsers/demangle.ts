import type { z } from "zod";

import { isSwiftMangledSymbolName } from "../../domain/swiftSymbolClassification.js";
import type { demangleSwiftSchema } from "../../domain/native/nativeInspection.js";

type DemangledSymbol = z.infer<typeof demangleSwiftSchema>["symbols"][number];

/**
 * swift-demangle removes one underscore from a name starting with `__` before
 * demangling, and prefixes `$` to an argument starting with S, s or e. A name
 * it cannot decode is printed in that adjusted spelling.
 */
const linkageName = (input: string): string =>
  input.startsWith("__") ? input.slice(1) : input;
const undecodedSpelling = (input: string): string =>
  /^[Sse]/u.test(input) ? `$${input}` : linkageName(input);

/**
 * Preserve input ordering while parsing `swift-demangle --compact` lines.
 * The demangler ends each record with LF, so a carriage return belongs to the
 * symbol text.
 */
export const parseDemangledSymbols = (
  inputs: readonly string[],
  output: string,
): DemangledSymbol[] => {
  if (inputs.length === 0) {
    if (output === "" || output === "\n") return [];
    throw new TypeError("swift-demangle emitted output for an empty input");
  }
  const lines = output.replace(/\n$/u, "").split("\n");
  if (lines.length !== inputs.length)
    throw new TypeError("swift-demangle output count does not match input");
  return inputs.map<DemangledSymbol>((input, index) => {
    const value = lines[index];
    if (value === undefined)
      throw new TypeError("swift-demangle omitted an output line");
    const decoded = value !== input && value !== undecodedSpelling(input);
    return {
      input,
      // Status describes decoding; retain the producer's exact spelling even
      // when it adjusted an identifier that it could not decode.
      output: value,
      status: decoded
        ? "demangled"
        : isSwiftMangledSymbolName(linkageName(input))
          ? "invalid"
          : "unchanged",
    };
  });
};
