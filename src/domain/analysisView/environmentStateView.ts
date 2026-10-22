import { z } from "zod";
import type { AnalysisError } from "../analysisErrorBase.js";
import { jsonValueSchema } from "../jsonValue.js";
import { ok, type Result } from "../result.js";
import type {
  AnalysisViewParent,
  AnalysisViewRequest,
  UnsignedAnalysisView,
} from "./analysisView.js";
import { EnvironmentStateAccumulator } from "./EnvironmentStateAccumulator.js";
import {
  groupCaptureRecords,
  templateRulesSchema,
} from "./environmentManifestView.js";

export const environmentStateViewRequestSchema = z.strictObject({
  kind: z.literal("environment-state"),
  template_rules: templateRulesSchema.describe(
    "Opt-in template rules as for environment-manifest, each listed at most once. Use the rules of the manifest the state accompanies so tool names match.",
  ),
});

const jsonObjectFieldsSchema = z.record(z.string(), jsonValueSchema);
const checkedSchema = z
  .array(z.number().int().nonnegative())
  .describe(
    "Latest init record per request line that the view reproduced from the state.",
  );
const entityViewFields = {
  tool: z.string(),
  type: z.string(),
  pointer: z
    .string()
    .describe(
      "JSON pointer, of depth at most one, to the entity object or array within the response.",
    ),
  fields: z
    .array(z.string())
    .describe("Ordered fields the view shows of each entity."),
  required_fields: z.array(z.string()),
  checked_record_ordinals: checkedSchema,
};
const viewSchema = z.discriminatedUnion("shape", [
  z.strictObject({
    ...entityViewFields,
    shape: z.literal("item"),
    envelope_ordinal: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "Record whose response, with the entity object replaced, every item response shares.",
      ),
  }),
  z.strictObject({
    ...entityViewFields,
    shape: z.literal("list"),
    membership: z
      .enum(["all", "recorded"])
      .describe(
        "all: every entity of the collection in state order; recorded: the entities each recorded response listed.",
      ),
    counters: z
      .array(z.string())
      .describe("Envelope members that count the listed entities."),
  }),
  z.strictObject({
    tool: z.string(),
    shape: z.literal("document"),
    checked_record_ordinals: checkedSchema,
  }),
  z.strictObject({
    tool: z.string(),
    shape: z.literal("recorded"),
    reason: z.enum([
      "query-body",
      "no-init-recording",
      "body-unusable",
      "not-entity",
      "no-identity",
      "query-varies",
      "fields-differ",
      "envelope-varies",
      "list-differs",
    ]),
  }),
]);

export const environmentStateFields = {
  origin: z
    .string()
    .describe("Primary origin, as the environment manifest selects it."),
  name: z.string(),
  timeline: z
    .enum(["recorded-start-time", "record-order"])
    .describe(
      "Records are ordered by recorded start time, or by record order when any start time is missing.",
    ),
  types: z.array(
    z.strictObject({
      collection_template: z.string(),
      id_field: z.string(),
      id_basis: z
        .enum(["path-parameter", "field-name"])
        .describe(
          "path-parameter: item responses repeat the requested path value in this field; field-name: an inferred identity name every listed item carries distinctly.",
        ),
      init_before_ordinal: z
        .number()
        .int()
        .nonnegative()
        .nullable()
        .describe(
          "First recorded write whose path root relates to the type; state comes from records that finished before it.",
        ),
      volatile_fields: z
        .array(z.string())
        .describe(
          "Fields whose recorded values changed with no recorded write between; the state keeps the latest.",
        ),
    }),
  ),
  entities: z
    .array(
      z.strictObject({
        type: z.string(),
        collection: z.string(),
        id: z.string(),
        fields: jsonObjectFieldsSchema,
        view_fields: z.array(
          z.strictObject({ tool: z.string(), fields: jsonObjectFieldsSchema }),
        ),
        record_ordinals: z.array(z.number().int().nonnegative()),
      }),
    )
    .describe(
      "Entities in collection order: type, collection, then first sighting.",
    ),
  documents: z.array(
    z.strictObject({
      tool: z.string(),
      path: z.string(),
      value: jsonValueSchema,
      record_ordinal: z.number().int().nonnegative(),
    }),
  ),
  views: z.array(viewSchema),
  unknowns: z.array(
    z.strictObject({
      kind: z.enum([
        "authorization-model",
        "response-semantics",
        "state-transition",
      ]),
      statement: z.string(),
    }),
  ),
};

/** Extract the init state a capture's reads observed and each read tool's render plan; types and identity are inferences. */
export const projectEnvironmentStateView = (
  parent: AnalysisViewParent,
  view: Extract<AnalysisViewRequest, { kind: "environment-state" }>,
  accumulator = new EnvironmentStateAccumulator(undefined, view.template_rules),
): Result<UnsignedAnalysisView, AnalysisError> => {
  const grouped = groupCaptureRecords(parent, view.kind, view.template_rules, {
    accumulator,
    noun: "state",
    limitations: [
      "Entity types, identity fields, list membership and counters are inferences from recorded response bodies; the state does not establish server-side schemas, derived values or values copied outside entity objects.",
    ],
  });
  if (!grouped.ok) return grouped;
  const state = accumulator.finishState();
  if (!state.ok) return state;
  return ok({
    kind: "environment-state",
    view,
    parent_evidence_id: parent.evidenceId,
    parent_operation: grouped.value.operation,
    parent_digest: parent.evidenceId.slice(3),
    artifact: {
      path: grouped.value.artifact.path,
      sha256: grouped.value.artifact.sha256,
    },
    ...state.value,
  });
};
