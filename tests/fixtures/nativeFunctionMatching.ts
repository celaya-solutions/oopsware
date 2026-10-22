import { createEvidence, type Evidence } from "../../src/domain/evidence.js";
import { jsonValueSchema } from "../../src/domain/jsonValue.js";
import { FUNCTION_COMPARISON_EXAMPLE } from "../../src/contracts/functionComparisonExample.js";
import { functionDossierSchema } from "../../src/domain/hopperValues.js";

/** Explicit synthetic producer facts; they do not qualify any real provider. */
export const nativeMatchingProvider = {
  id: "matching-fixture",
  name: "Synthetic native matching facts",
  version: "1",
};
export const nativeMatchingTarget = (side: "1" | "2") => ({
  path: `/tmp/matching-${side}.elf`,
  sha256: side.repeat(64),
  format: "elf" as const,
  architecture: "x86_64" as const,
});
export const nativeMatchingInventory = (
  side: "1" | "2",
  entries: readonly { address: string; value: string }[],
  evidenceLinks: readonly string[] = [],
) =>
  createEvidence(nativeMatchingTarget(side), nativeMatchingProvider, {
    operation: "list_procedures",
    parameters: {},
    result: jsonValueSchema.parse(entries),
    evidenceLinks: [...evidenceLinks],
  });
export const nativeMatchingBody = (address: string, bytes: number) => ({
  available: true as const,
  provenance: "explicit synthetic body",
  ranges: [
    {
      start: address,
      end: `0x${(BigInt(address) + BigInt(bytes) - 1n).toString(16)}`,
    },
  ],
  total_bytes: bytes,
  span_bytes: bytes,
  non_contiguous: false,
  contains_entry: true,
});
export const nativeMatchingDetails = (
  side: "1" | "2",
  address: string,
  hex: string,
  dossier = false,
): Evidence[] => {
  const target = nativeMatchingTarget(side),
    body = nativeMatchingBody(address, hex.length / 2);
  const procedure = {
    name: "fixture",
    entrypoint: address,
    basicblock_count: 1,
    length: hex.length / 2,
    signature: null,
    locals: [],
    classification: null,
    body,
  };
  let observation: Evidence;
  if (dossier) {
    const value = functionDossierSchema.parse(
      FUNCTION_COMPARISON_EXAMPLE.left.normalized_result,
    );
    value.procedure = {
      address,
      name: "fixture",
      classification: null,
      body,
      signature: null,
      locals: [],
    };
    value.basic_blocks = [];
    observation = createEvidence(target, nativeMatchingProvider, {
      operation: "analyze_function",
      parameters: { procedure: address },
      result: jsonValueSchema.parse(value),
      relationshipCoverage: { status: "complete" },
    });
  } else
    observation = createEvidence(target, nativeMatchingProvider, {
      operation: "procedure_info",
      parameters: { procedure: address },
      result: procedure,
    });
  return [
    observation,
    createEvidence(target, nativeMatchingProvider, {
      operation: "read_bytes",
      parameters: { address, length: hex.length / 2 },
      result: {
        address,
        requested_bytes: hex.length / 2,
        returned_bytes: hex.length / 2,
        bytes_hex: hex,
        complete: true,
      },
    }),
  ];
};
