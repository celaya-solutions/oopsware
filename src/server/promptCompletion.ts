import type { EvidenceReader } from "../application/investigation/InvestigationRecordPort.js";
import { z } from "zod";

import { uniqueSorted } from "../domain/canonicalOrdering.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { AnalysisOperationPort } from "../application/AnalysisProvider.js";
import type { BinarySessionPort } from "../application/binary/BinarySessionPort.js";
import type { PromptCompletionKind } from "../contracts/promptContracts.js";
import { addressedValueSchema } from "../domain/native/nativeInventory.js";
import { currentMcpRequestSignal } from "./EvidenceMcpServer.js";
import { parseArtifactInventoryEvidence } from "../domain/artifactInventoryEvidence.js";
import { EvidenceIntegrityError } from "../domain/evidenceErrors.js";
import { parseProcessCapture } from "../domain/process/processCaptureParsing.js";

const documentListSchema = z.array(z.string().min(1));
const procedureInventorySchema = z.array(
  addressedValueSchema.pick({ address: true, value: true }),
);
const providerStatusSchema = z.object({
  analysis_provider_candidates: z.array(
    z.object({ provider: z.object({ id: z.string().min(1) }) }),
  ),
});

interface CompletionContext {
  readonly arguments?: Readonly<Record<string, string>>;
}

/** Read-only session projection used by MCP prompt argument completers. */
export interface PromptCompletionSource {
  complete(
    kind: PromptCompletionKind,
    value: string,
    context?: CompletionContext,
  ): Promise<readonly string[]>;
}

/** Build live completion over the active provider and session ledger. */
export const createPromptCompletionSource = (
  analysis: AnalysisOperationPort,
  session?: BinarySessionPort,
): PromptCompletionSource => ({
  async complete(kind, value, context) {
    const candidates = await completionCandidates(
      kind,
      analysis,
      session,
      context,
    );
    const prefix = normalize(value);
    const nonEmpty = candidates.filter((candidate) => candidate.length > 0);
    return uniqueSorted(nonEmpty).filter((candidate) =>
      normalize(candidate).startsWith(prefix),
    );
  },
});

const completionCandidates = async (
  kind: PromptCompletionKind,
  analysis: AnalysisOperationPort,
  session: BinarySessionPort | undefined,
  context: CompletionContext | undefined,
): Promise<readonly string[]> => {
  switch (kind) {
    case "document":
      return documentCandidates(analysis, session);
    case "procedure":
      return procedureCandidates(
        analysis,
        session,
        context?.arguments?.document,
      );
    case "provider":
      return providerCandidates(session);
    case "evidence":
    case "capture":
    case "manifest":
    case "occurrence":
      return evidenceCandidates(kind, session);
    case "unknown":
      return unknownCandidates(session);
  }
};

const documentCandidates = async (
  analysis: AnalysisOperationPort,
  session: BinarySessionPort | undefined,
): Promise<readonly string[]> => {
  const result = await completionInventoryLookup(
    analysis,
    session,
    "list_documents",
    {},
  );
  if (result === undefined) return [];
  if (!result.ok) return [];
  const parsed = documentListSchema.safeParse(result.value.result);
  return parsed.success ? parsed.data : [];
};

const procedureCandidates = async (
  analysis: AnalysisOperationPort,
  session: BinarySessionPort | undefined,
  document: string | undefined,
): Promise<readonly string[]> => {
  const addresses = new Set<string>();
  // null records proven ambiguity; later rows cannot restore uniqueness.
  const addressByName = new Map<string, string | null>();
  const input =
    document === undefined || document.length === 0 ? {} : { document };
  const result = await completionInventoryLookup(
    analysis,
    session,
    "list_procedures",
    input,
  );
  if (result === undefined) return [];
  if (result.ok) {
    const parsed = procedureInventorySchema.safeParse(result.value.result);
    if (parsed.success)
      for (const { address, value: name } of parsed.data) {
        addresses.add(address);
        if (name.length === 0) continue;
        const previous = addressByName.get(name);
        addressByName.set(
          name,
          previous === undefined || previous === address ? address : null,
        );
      }
  }

  const candidates = [...addresses];
  for (const [name, address] of addressByName)
    if (address !== null) candidates.push(name);
  return candidates;
};

const completionInventoryLookup = async (
  analysis: AnalysisOperationPort,
  session: BinarySessionPort | undefined,
  operation: "list_documents" | "list_procedures",
  parameters: Readonly<Record<string, JsonValue>>,
) => {
  const signal = currentMcpRequestSignal();
  const options = signal === undefined ? {} : { signal };
  const result =
    session === undefined
      ? await analysis.execute(operation, parameters, options)
      : await session.executeIfProviderReady(operation, parameters, options);
  return signal?.aborted === true ? undefined : result;
};

const providerCandidates = async (
  session: BinarySessionPort | undefined,
): Promise<readonly string[]> => {
  if (session === undefined) return [];
  const signal = currentMcpRequestSignal();
  const parsed = providerStatusSchema.safeParse(
    await session.status(signal === undefined ? {} : { signal }),
  );
  if (!parsed.success) return [];
  const candidates = parsed.data.analysis_provider_candidates.map(
    ({ provider }) => provider.id,
  );
  return ["auto", ...candidates];
};

const evidenceCandidates = (
  kind: "evidence" | "capture" | "manifest" | "occurrence",
  session: BinarySessionPort | undefined,
): readonly string[] => {
  if (session === undefined) return [];
  const candidates: string[] = [];
  for (const evidence of session.exportEvidenceBundle().records)
    candidates.push(...evidenceValues(kind, evidence));
  return candidates;
};

type LedgerEvidence = ReturnType<
  EvidenceReader["exportEvidenceBundle"]
>["records"][number];

const evidenceValues = (
  kind: "evidence" | "capture" | "manifest" | "occurrence",
  evidence: LedgerEvidence,
): readonly string[] => {
  if (kind === "evidence") return [evidence.evidence_id];
  if (kind === "capture")
    return isProcessCaptureEvidence(evidence) ? [evidence.evidence_id] : [];
  if (
    evidence.operation === "inventory_artifact" ||
    evidence.operation === "inspect_artifact"
  )
    return artifactInventoryValues(kind, evidence);
  return [];
};

const artifactInventoryValues = (
  kind: "manifest" | "occurrence",
  evidence: unknown,
): readonly string[] => {
  try {
    const { inventory } = parseArtifactInventoryEvidence(evidence);
    return kind === "manifest"
      ? [inventory.manifest.manifest_id]
      : inventory.occurrences.map(({ occurrence_id: id }) => id);
  } catch (cause: unknown) {
    if (
      cause instanceof TypeError ||
      cause instanceof z.ZodError ||
      cause instanceof EvidenceIntegrityError
    )
      return [];
    throw cause;
  }
};

const isProcessCaptureEvidence = (evidence: LedgerEvidence): boolean => {
  if (evidence.operation !== "capture_process_scenario") return false;
  try {
    parseProcessCapture(evidence.normalized_result);
    return true;
  } catch (cause: unknown) {
    if (cause instanceof TypeError || cause instanceof z.ZodError) return false;
    throw cause;
  }
};

const unknownCandidates = (
  session: BinarySessionPort | undefined,
): readonly string[] =>
  session === undefined
    ? []
    : session
        .listUnknowns()
        .filter(({ status }) => status !== "resolved")
        .map(({ unknown_id: id }) => id);

const normalize = (value: string): string =>
  value.normalize("NFKC").toLowerCase();
