import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  requireMcpOperationResult as result,
  requireMcpToolError,
} from "../../scripts/lib/mcp-verifier-results.mjs";

/** Expected current heads from the original exported revisions, not displayed pages. */
export const retainedUnknownHeads = (unknowns, domain) => {
  const heads = new Map();
  for (const unknown of unknowns) {
    const previous = heads.get(unknown.unknown_id);
    if (previous === undefined || previous.revision < unknown.revision)
      heads.set(unknown.unknown_id, unknown);
  }
  return [...heads.values()]
    .filter((unknown) => unknown.domain === domain)
    .sort((a, b) =>
      a.unknown_id < b.unknown_id ? -1 : a.unknown_id > b.unknown_id ? 1 : 0,
    );
};

const verifyFollowupPages = async (call, original) => {
  const expected = retainedUnknownHeads(
    original.unknowns,
    "javascript-semantic-followup",
  );
  assert.ok(
    expected.length > 0,
    "Supply an authentic mixed history with semantic follow-ups",
  );
  const revised = expected.find((unknown) => unknown.revision > 1);
  assert.ok(revised, "Mixed verification requires a retained updated Unknown");
  let offset = 0;
  let pages = 0;
  const observed = [];
  do {
    const page = result(
      await call(
        "list_unknowns",
        {
          domain: "javascript-semantic-followup",
          offset,
          limit: 2,
        },
        `mixed-heads-${offset}`,
      ),
      "list_unknowns",
    );
    assert.equal(page.total, expected.length);
    assert.equal(page.offset, offset);
    assert.deepEqual(page.items, expected.slice(offset, offset + 2));
    assert.equal(
      page.next_offset,
      offset + 2 < expected.length ? offset + 2 : null,
    );
    observed.push(...page.items);
    offset = page.next_offset;
    pages += 1;
  } while (offset !== null);
  assert.deepEqual(observed, expected);
  return { revised, headsChecked: expected.length, pages };
};

const verifyMutationRefusals = async ({
  call,
  original,
  sourceId,
  output,
  revised,
}) => {
  const before = result(
    await call(
      "get_evidence_bundle",
      { detail: "summary" },
      "mixed-before-refusals",
    ),
    "get_evidence_bundle",
  );
  const stale = await call(
    "update_unknown",
    {
      unknown_id: revised.unknown_id,
      expected_revision: revised.revision - 1,
      status: revised.status,
      severity: revised.severity,
      supporting_evidence_ids: revised.supporting_evidence_ids,
      contradicting_evidence_ids: revised.contradicting_evidence_ids,
      required_authority: revised.required_authority,
      required_confidence: revised.required_confidence,
      required_environment: revised.required_environment,
      recommended_probes: revised.recommended_probes,
      relationships: revised.relationships,
      resolution: revised.resolution,
    },
    "mixed-stale-update",
  );
  assert.equal(requireMcpToolError(stale).code, "revision_conflict");
  const tampered = structuredClone(original);
  const target = tampered.records.find(
    (record) => record.evidence_id === sourceId,
  );
  assert.ok(target);
  target.normalized_result = { checkpoint_tampered: true };
  const path = join(output, "tampered-import.json");
  await writeFile(path, JSON.stringify(tampered), { flag: "wx" });
  const rejected = await call(
    "import_evidence_bundle",
    { path },
    "mixed-tampered-import",
  );
  assert.equal(
    requireMcpToolError(rejected).code,
    "evidence_integrity_mismatch",
  );
  const after = result(
    await call(
      "get_evidence_bundle",
      { detail: "summary" },
      "mixed-after-refusals",
    ),
    "get_evidence_bundle",
  );
  assert.deepEqual(after, before);
};

/** Verify original mixed-history heads, CAS rejection and atomic import failure. */
export const verifyMixedRetainedHistory = async (options) => {
  const { revised, headsChecked, pages } = await verifyFollowupPages(
    options.call,
    options.original,
  );
  await verifyMutationRefusals({ ...options, revised });
  return {
    heads_checked: headsChecked,
    pages,
    revised_unknown_id: revised.unknown_id,
    revision_checked: revised.revision,
    stale_update_rejected: true,
    tampered_import_rejected_atomically: true,
  };
};

/** Closing must neither retain old Unknowns nor rehydrate a closed source. */
export const verifyMixedRetainedClosure = async (call, sourceId) => {
  const unknowns = result(
    await call("list_unknowns", {}, "mixed-after-close-heads"),
    "list_unknowns",
  );
  assert.equal(unknowns.total, 0);
  const missing = await call(
    "inspect_analysis_view",
    {
      source: { kind: "retained-evidence", evidence_id: sourceId },
      view: { kind: "summary" },
    },
    "mixed-after-close-reference",
  );
  const failure = requireMcpToolError(missing);
  assert.equal(failure.details?.reason, "missing");
  return { unknowns_after_close: 0, old_reference_refused: true };
};
