import { functionStructuralCandidate } from "./functionStructuralCandidate.js";
import type { z } from "zod";
import type { Evidence } from "../evidence.js";
import { EvidenceIntegrityError } from "../evidenceErrors.js";
import { digestCanonicalValue } from "../canonicalDigest.js";
import {
  functionBodySchema,
  functionBodyEntryAgrees,
  functionDossierSchema,
} from "../hopperValues.js";
import { isAutoName } from "../functionComparisonNormalization.js";
import {
  addressedValueSchema,
  nativeInventoryRowsSchemas,
} from "./nativeInventory.js";
import { parseNativeAddress } from "./nativeAddress.js";
import { nativeByteReadSchema } from "./nativeByteRead.js";
import { procedureInfoSchema } from "./procedureInfo.js";
import type { NativeFunctionMatchMember } from "./functionMatching.js";
import {
  FunctionByteCoverage,
  type NativeMatchingCheckpoint,
} from "./functionByteCoverage.js";

type Body = z.infer<typeof functionBodySchema>;
type AddressedValue = z.infer<typeof addressedValueSchema>;
export interface MatchingFunction {
  readonly member: NativeFunctionMatchMember;
  readonly symbol: string | null;
  readonly fingerprint: string | null;
}
interface Detail {
  body?: Body;
  dossier?: string | null;
  candidate?: string | null;
  conflict: boolean;
  readonly links: string[];
}
interface Symbols {
  readonly values: AddressedValue[];
  readonly links: Set<string>;
}
interface Facts {
  readonly details: Map<string, Detail>;
  readonly symbols: Map<string, Symbols>;
  readonly bytes: FunctionByteCoverage;
}

/** Supplementary observations must belong to this exact provider/target/profile/document. */
const requireContext = (inventory: Evidence, observation: Evidence): void => {
  if (
    observation.predicate_type !== "rea.analysis" ||
    digestCanonicalValue(observation.subject) !==
      digestCanonicalValue(inventory.subject) ||
    digestCanonicalValue(observation.provider) !==
      digestCanonicalValue(inventory.provider) ||
    digestCanonicalValue(observation.analysis_profile) !==
      digestCanonicalValue(inventory.analysis_profile) ||
    (observation.parameters.document ?? null) !==
      (inventory.parameters.document ?? null)
  )
    throw new EvidenceIntegrityError(
      "Function observation does not belong to its selected inventory context",
    );
};
const addBody = (observation: Evidence, details: Facts["details"]): void => {
  const dossier =
    observation.operation === "analyze_function"
      ? functionDossierSchema.parse(observation.normalized_result)
      : undefined;
  const procedure =
    dossier?.procedure ??
    (() => {
      const info = procedureInfoSchema.parse(observation.normalized_result);
      return { address: info.entrypoint, body: info.body };
    })();
  const address = parseNativeAddress(procedure.address);
  if (!functionBodyEntryAgrees(procedure.body, address))
    throw new EvidenceIntegrityError(
      "Procedure body entry membership contradicts its address",
    );
  let detail = details.get(address);
  if (detail === undefined)
    details.set(address, (detail = { conflict: false, links: [] }));
  if (
    detail.body !== undefined &&
    digestCanonicalValue(detail.body) !== digestCanonicalValue(procedure.body)
  )
    detail.conflict = true;
  detail.body = procedure.body;
  if (observation.operation === "analyze_function") {
    const candidate = functionStructuralCandidate(observation, dossier!);
    if (detail.dossier === undefined) {
      detail.dossier = observation.evidence_id;
      detail.candidate = candidate;
    } else {
      // Request identity and dossier selection are independent of body agreement.
      if (detail.dossier !== observation.evidence_id) detail.dossier = null;
      if (detail.candidate !== candidate) detail.candidate = null;
    }
  }
  detail.links.push(observation.evidence_id);
};
const addNames = async (
  observation: Evidence,
  symbols: Facts["symbols"],
  checkpoint: NativeMatchingCheckpoint,
): Promise<void> => {
  for (const symbol of nativeInventoryRowsSchemas.names.parse(
    observation.normalized_result,
  )) {
    await checkpoint(128 + symbol.value.length * 2);
    const address = parseNativeAddress(symbol.address);
    let group = symbols.get(address);
    if (group === undefined)
      symbols.set(address, (group = { values: [], links: new Set() }));
    group.values.push(symbol);
    group.links.add(observation.evidence_id);
  }
};
const addBytes = async (
  observation: Evidence,
  bytes: FunctionByteCoverage,
): Promise<void> => {
  const read = nativeByteReadSchema.parse(observation.normalized_result);
  if (
    (typeof observation.parameters.address === "string" &&
      parseNativeAddress(observation.parameters.address) !==
        parseNativeAddress(read.address)) ||
    (typeof observation.parameters.length === "number" &&
      observation.parameters.length !== read.requested_bytes)
  )
    throw new EvidenceIntegrityError(
      "Read-byte coordinates contradict the selected request",
    );
  await bytes.add(read, observation.evidence_id);
};
const reportedSymbol = (
  row: AddressedValue,
  known: Symbols | undefined,
): {
  readonly value: string | null;
  readonly origin: "known" | "unknown" | "conflicting";
} => {
  const names = [
    ...(row.symbol === undefined ? [] : [row]),
    ...(known?.values.filter((symbol) => symbol.value === row.value) ?? []),
  ];
  const generated = names.some(
    (symbol) =>
      symbol.symbol?.dynamic === true || symbol.symbol?.source === "default",
  );
  const named = names.some(
    (symbol) =>
      symbol.symbol?.dynamic === false && symbol.symbol.source !== "default",
  );
  return {
    value:
      row.value.length === 0 || generated || (!named && isAutoName(row.value))
        ? null
        : row.value,
    origin:
      generated && named
        ? "conflicting"
        : names.some((symbol) => symbol.symbol !== undefined)
          ? "known"
          : "unknown",
  };
};
const functionFact = async (
  {
    inventory,
    row,
    sourceIndex,
  }: { inventory: Evidence; row: AddressedValue; sourceIndex: number },
  facts: Facts,
  checkpoint: NativeMatchingCheckpoint,
): Promise<MatchingFunction> => {
  const address = parseNativeAddress(row.address),
    detail = facts.details.get(address),
    symbols = facts.symbols.get(address);
  // Bound expansion before creating per-occurrence sets, arrays and subsequent
  // schema/Evidence serialization copies. Same-address aliases repeat these links.
  for (const link of detail?.links ?? [])
    await checkpoint(256 + 8 * link.length);
  for (const link of symbols?.links ?? [])
    await checkpoint(256 + 8 * link.length);
  await checkpoint(256 + 8 * inventory.evidence_id.length);
  const links = new Set([inventory.evidence_id]);
  for (const link of detail?.links ?? []) links.add(link);
  for (const link of symbols?.links ?? []) links.add(link);
  const body = detail?.conflict ? undefined : detail?.body;
  const fingerprint = await facts.bytes.fingerprint(body);
  for (const link of fingerprint?.links ?? []) {
    await checkpoint(256 + 8 * link.length);
    links.add(link);
  }
  const limitations: string[] = [];
  const symbol = reportedSymbol(row, symbols);
  if (fingerprint === null)
    limitations.push(
      detail?.conflict
        ? "Conflicting procedure observations; body and dossier remain unknown."
        : "No complete unambiguous bytes for the observed function body.",
    );
  if (symbol.origin === "unknown")
    limitations.push(
      "Symbol origin unavailable; exact-name matching uses the reported name and the existing automatic-name exclusion rule.",
    );
  if (symbol.origin === "conflicting")
    limitations.push(
      "Conflicting generated and named symbol-origin observations; exact-name matching is unavailable. Independent complete body bytes remain eligible.",
    );
  if (detail?.dossier === null)
    limitations.push(
      "Multiple supplied dossiers describe this address; no dossier is selected automatically. Agreed body bytes and structural facts remain usable.",
    );
  return {
    member: {
      function_id: `${inventory.evidence_id}/${sourceIndex}`,
      inventory_evidence_id: inventory.evidence_id,
      source_index: sourceIndex,
      address,
      name: row.value,
      body_sha256: fingerprint?.sha256 ?? null,
      structural_candidate_sha256: detail?.conflict
        ? null
        : (detail?.candidate ?? null),
      body_bytes: body?.available ? body.total_bytes : null,
      dossier_evidence_id: detail?.conflict ? null : (detail?.dossier ?? null),
      evidence_links: [...links].sort(),
      limitations,
    },
    symbol: symbol.value,
    fingerprint: fingerprint?.key ?? null,
  };
};

/** Consume normalized producer facts once; never infer body extents from neighbor entries. */
export const readFunctionInventory = async (
  inventory: Evidence,
  observations: readonly Evidence[],
  checkpoint: NativeMatchingCheckpoint,
): Promise<MatchingFunction[]> => {
  if (
    inventory.operation !== "list_procedures" ||
    inventory.predicate_type !== "rea.analysis" ||
    inventory.subject === null
  )
    throw new EvidenceIntegrityError(
      "Expected artifact-bound list_procedures Evidence",
    );
  const rows = nativeInventoryRowsSchemas.names.parse(
    inventory.normalized_result,
  );
  const facts: Facts = {
    details: new Map(),
    symbols: new Map(),
    bytes: new FunctionByteCoverage(checkpoint),
  };
  for (const observation of observations) {
    await checkpoint();
    requireContext(inventory, observation);
    switch (observation.operation) {
      case "list_names":
        await addNames(observation, facts.symbols, checkpoint);
        break;
      case "read_bytes":
        await addBytes(observation, facts.bytes);
        break;
      case "procedure_info":
      case "analyze_function":
        addBody(observation, facts.details);
        break;
      default:
        throw new EvidenceIntegrityError(
          "Function matching observations must be list_names, procedure_info, read_bytes or analyze_function Evidence",
        );
    }
  }
  const functions: MatchingFunction[] = [];
  for (let sourceIndex = 0; sourceIndex < rows.length; sourceIndex++) {
    const row = rows[sourceIndex]!;
    await checkpoint(1024 + 4 * (row.address.length + row.value.length));
    functions.push(
      await functionFact({ inventory, row, sourceIndex }, facts, checkpoint),
    );
  }
  return functions;
};
