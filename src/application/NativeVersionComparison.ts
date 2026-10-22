import { z } from "zod";
import type { BinarySessionPort } from "./binary/BinarySessionPort.js";
import { parseBinaryTarget } from "./BinaryTargetResolver.js";
import { executeFunctionAnalysisEvidence } from "./FunctionAnalysisEvidence.js";
import { createEvidence, type Evidence } from "../domain/evidence.js";
import { jsonValueSchema, jsonObjectSchema } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisOutputError,
  AnalysisUnsupportedTargetError,
} from "../domain/analysisErrorCore.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { EvidenceIntegrityError } from "../domain/evidenceErrors.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import {
  nativeVersionComparisonInputSchema,
  nativeVersionComparisonResultSchema,
  type NativeVersionComparisonInput,
  type NativeVersionSide,
} from "../domain/nativeVersionComparisonSchemas.js";
import { discoverNativeFunctionCandidates } from "../domain/nativeVersionComparison.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";

const operation = "compare_native_versions";
const provider = {
  id: "rea-native-version-comparison",
  name: "Oopsware native version comparison",
  version: "1",
};
const inventorySchema = z.array(
  z.object({ address: z.string().min(1), value: z.string() }),
);
type SupportedTarget = BinaryTarget & {
  format: "mach-o" | "elf";
  architecture: "arm64" | "x86_64";
};
const supports = (target: BinaryTarget): target is SupportedTarget =>
  target.kind === "executable" &&
  target.availableArchitectures.length === 1 &&
  ((target.format === "mach-o" && target.architecture === "arm64") ||
    (target.format === "elf" && target.architecture === "x86_64"));

/** Own temporary read-only analysis sessions; never switch the caller's active target. */
export class NativeVersionComparison {
  constructor(
    private readonly createSession: () => Result<
      BinarySessionPort,
      AnalysisError
    >,
  ) {}

  /** Collect both native versions, discover candidates, and compare selected exact pairs. */
  async compare(
    input: unknown,
    signal?: AbortSignal,
  ): Promise<Result<Evidence, AnalysisError>> {
    const parsed = nativeVersionComparisonInputSchema.safeParse(input);
    if (!parsed.success)
      return err(
        analysisInputErrorFromIssues(operation, parsed.error.issues, {}),
      );
    const request = parsed.data;
    const left = await parseBinaryTarget(
      request.left.path,
      signal === undefined ? {} : { signal },
    );
    if (!left.ok) return left;
    const right = await parseBinaryTarget(
      request.right.path,
      signal === undefined ? {} : { signal },
    );
    if (!right.ok) return right;
    for (const [target, expected] of [
      [left.value, request.left.expected_sha256],
      [right.value, request.right.expected_sha256],
    ] as const) {
      if (!supports(target))
        return err(
          new AnalysisUnsupportedTargetError(
            operation,
            target.path,
            "Requires a thin Mach-O arm64 or ELF x86_64 native executable; cross-format, cross-architecture, universal and database inputs are unsupported",
          ),
        );
      if (expected !== undefined && expected !== target.sha256)
        return err(
          new EvidenceIntegrityError(
            `Expected SHA-256 ${expected} but observed ${target.sha256} at ${target.path}`,
          ),
        );
    }
    if (!supports(left.value) || !supports(right.value))
      return err(
        new AnalysisOutputError(operation, "Target classification changed"),
      );
    if (
      left.value.format !== right.value.format ||
      left.value.architecture !== right.value.architecture
    )
      return err(
        new AnalysisUnsupportedTargetError(
          operation,
          right.value.path,
          "Both versions must have the same format and architecture",
        ),
      );
    const leftSide = await this.collect(left.value, request, signal);
    if (!leftSide.ok) return leftSide;
    const rightSide = await this.collect(right.value, request, signal);
    if (!rightSide.ok) {
      rightSide.error.partialObservation = this.collectedEvidence(
        leftSide.value,
        rightSide.error.partialObservation ?? null,
      );
      return rightSide;
    }
    try {
      if (signal?.aborted) throw new AnalysisCancelledError(operation);
      const discovery = discoverNativeFunctionCandidates(
        leftSide.value.functions,
        rightSide.value.functions,
        request.selected_pairs,
        signal,
        leftSide.value.failures.length === 0 &&
          rightSide.value.failures.length === 0,
      );
      const result = nativeVersionComparisonResultSchema.parse({
        ...discovery,
        left: leftSide.value,
        right: rightSide.value,
        completeness:
          leftSide.value.failures.length + rightSide.value.failures.length === 0
            ? "provider-inventory"
            : "partial",
        limitations: [
          "Static observations only; neither binary was executed. Candidate scores rank shared facts and never establish semantic equivalence.",
          "Automatic pairs require identical artifact SHA-256/address or a unique exact provider assembly representation plus normalized CFG. Assembly normalization strips only instruction source addresses; operands remain verbatim. This is observed representation equality, not semantic equivalence. Other candidates require analyst selection.",
          "Added and removed candidates mean no shared observed feature was found; missed procedures, optimization and inlining can explain unmatched functions.",
          "Inventory completeness is limited to the selected provider's detected procedures. Per-function failures and unavailable facets remain explicit.",
          "Constants and IR signatures come only from complete provider IR. Constant operands may include address-like values; they are not normalized or interpreted as semantic facts.",
          "Exact comparison retains compare_functions semantics, including opaque assembly text and ambiguous or mismatched symbol identity.",
        ],
      });
      return ok(
        createEvidence(undefined, provider, {
          operation,
          parameters: jsonObjectSchema.parse(request),
          result: jsonValueSchema.parse(result),
          confidence: "derived",
          authority: "analyst-inference",
          limitations: result.limitations,
          evidenceLinks: [
            leftSide.value.inventory,
            ...leftSide.value.functions,
            rightSide.value.inventory,
            ...rightSide.value.functions,
          ].map((evidence) => evidence.evidence_id),
        }),
      );
    } catch (cause: unknown) {
      if (cause instanceof AnalysisError)
        return err(
          cause.retainPartialObservation(
            this.collectedEvidence(leftSide.value, rightSide.value),
          ),
        );
      return err(
        new EvidenceIntegrityError(
          cause instanceof Error
            ? cause.message
            : "Invalid native function comparison",
          {
            cause,
            partialObservation: this.collectedEvidence(
              leftSide.value,
              rightSide.value,
            ),
          },
        ),
      );
    }
  }

  private partial(
    side: NativeVersionSide,
    interruptedObservation?: unknown,
  ): Evidence {
    return createEvidence(undefined, provider, {
      operation,
      parameters: {},
      result: jsonValueSchema.parse({
        collected_side: side,
        ...(interruptedObservation === undefined
          ? {}
          : { interrupted_observation: interruptedObservation }),
      }),
      limitations: [
        "Version collection failed before candidate discovery completed.",
      ],
    });
  }

  private collectedEvidence(left: NativeVersionSide, right: unknown): Evidence {
    return createEvidence(undefined, provider, {
      operation,
      parameters: {},
      result: jsonValueSchema.parse({ left, right }),
      limitations: [
        "Collection or discovery failed; retained observations do not establish a completed comparison.",
      ],
    });
  }

  private async collect(
    target: SupportedTarget,
    request: NativeVersionComparisonInput,
    signal?: AbortSignal,
  ): Promise<Result<NativeVersionSide, AnalysisError>> {
    const created = this.createSession();
    if (!created.ok) return created;
    const session = created.value;
    let result: Result<NativeVersionSide, AnalysisError>;
    try {
      result = await this.collectOpenSession(session, target, request, signal);
    } catch (cause: unknown) {
      const closed = await session.close();
      if (!closed.ok)
        throw new AggregateError(
          [cause, closed.error],
          "Native collection and cleanup failed",
        );
      throw cause;
    }
    const closed = await session.close();
    if (closed.ok) return result;
    return result.ok
      ? err(closed.error.retainPartialObservation(this.partial(result.value)))
      : err(analysisErrorWithCleanupFailure(result.error, closed.error));
  }

  private async collectOpenSession(
    session: BinarySessionPort,
    target: SupportedTarget,
    request: NativeVersionComparisonInput,
    signal?: AbortSignal,
  ): Promise<Result<NativeVersionSide, AnalysisError>> {
    const options = signal === undefined ? {} : { signal };
    const opened = await session.open(target.path, {
      ...options,
      ...(request.provider_id === undefined
        ? {}
        : { providerId: request.provider_id }),
    });
    if (!opened.ok) return opened;
    if (
      opened.value.sha256 !== target.sha256 ||
      opened.value.path !== target.path
    )
      return err(
        new EvidenceIntegrityError(
          `Binary identity changed while opening ${target.path}`,
        ),
      );
    const inventory = await session.execute(
      "list_procedures",
      { document: null },
      options,
    );
    if (!inventory.ok) return inventory;
    const parsed = inventorySchema.safeParse(inventory.value.result);
    if (!parsed.success)
      return err(
        new AnalysisOutputError(
          operation,
          `Malformed procedure inventory: ${parsed.error.message}`,
        ),
      );
    const addresses = parsed.data.map(({ address }) =>
      /^0x[0-9a-f]+$/iu.test(address)
        ? `0x${BigInt(address).toString(16)}`
        : address,
    );
    if (new Set(addresses).size !== addresses.length)
      return err(
        new AnalysisOutputError(
          operation,
          "Duplicate addresses in provider procedure inventory",
        ),
      );
    const inventoryEvidence = createEvidence(
      inventory.value.subject ?? target,
      inventory.value.provider,
      {
        operation: "list_procedures",
        parameters: { document: null },
        result: inventory.value.result,
        limitations: inventory.value.limitations,
        rawResult: inventory.value.rawResult,
      },
    );
    if (inventoryEvidence.subject?.digest.sha256 !== target.sha256)
      return err(
        new EvidenceIntegrityError(
          "Procedure inventory subject does not match requested binary",
        ),
      );
    const functions: Evidence[] = [],
      failures: NativeVersionSide["failures"] = [];
    const side: NativeVersionSide = {
      path: target.path,
      sha256: target.sha256,
      format: target.format,
      architecture: target.architecture,
      inventory: inventoryEvidence,
      functions,
      failures,
    };
    for (const address of addresses) {
      if (signal?.aborted)
        return err(
          new AnalysisCancelledError(operation).retainPartialObservation(
            this.partial(side),
          ),
        );
      if (!/^0x[0-9a-f]+$/iu.test(address)) {
        failures.push({
          address,
          reason:
            "Provider inventory contains a non-native or external address space; preserved in inventory but not paired as a native function",
          error: null,
        });
        continue;
      }
      const dossier = await executeFunctionAnalysisEvidence(
        session,
        { procedure: address },
        target,
        options,
      );
      if (!dossier.ok) {
        if (
          signal?.aborted ||
          dossier.error._tag === "AnalysisCancelledError" ||
          dossier.error._tag === "HopperCancelledError"
        ) {
          dossier.error.partialObservation = this.partial(
            side,
            dossier.error.partialObservation,
          );
          return dossier;
        }
        failures.push({
          address,
          reason: dossier.error.message,
          error: projectAnalysisError(dossier.error),
        });
        continue;
      }
      if (dossier.value.subject?.digest.sha256 !== target.sha256)
        return err(
          new EvidenceIntegrityError(
            `Function ${address} subject does not match requested binary`,
          ).retainPartialObservation(this.partial(side)),
        );
      const procedure = z
        .object({ procedure: z.object({ address: z.string() }) })
        .parse(dossier.value.normalized_result).procedure;
      if (
        !/^0x[0-9a-f]+$/iu.test(procedure.address) ||
        `0x${BigInt(procedure.address).toString(16)}` !== address
      )
        return err(
          new EvidenceIntegrityError(
            `Provider returned a different function for ${address}`,
          ).retainPartialObservation(this.partial(side)),
        );
      functions.push(dossier.value);
    }
    const after = await parseBinaryTarget(target.path, options);
    if (!after.ok)
      return err(after.error.retainPartialObservation(this.partial(side)));
    if (after.value.sha256 !== target.sha256)
      return err(
        new EvidenceIntegrityError(
          `Binary changed during analysis: ${target.path}`,
        ).retainPartialObservation(this.partial(side)),
      );
    return ok(side);
  }
}
