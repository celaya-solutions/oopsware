import { describe, expect, it } from "vitest";
import { planApplyToSession, type SessionIdentity } from "./applyPlan.js";
import { createProject } from "./projectEdits.js";
import type { Project, Provenance } from "./projectSchema.js";

const T0 = "2026-10-21T10:00:00.000Z";
const SHA = "c".repeat(64);
const DIGEST = "d".repeat(64);
const provenance: Provenance = {
  run: null,
  provider: { id: "ghidra", name: "Ghidra", version: "12.1.4" },
  profile_digest: DIGEST,
};

const project = (): Project => {
  const base = createProject(
    { id: "8f6c0f1e-6a4e-4d8b-9a55-0d6b1f0e2c11", title: "P" },
    T0,
  );
  const stamp = { createdAt: T0, updatedAt: T0, provenance };
  const anchor = (address: string) => ({
    target_sha256: SHA,
    target_id: null,
    location: { kind: "address" as const, address },
  });
  return {
    ...base,
    renames: ["0x1", "0x2", "0x3"].map((address, index) => ({
      id: crypto.randomUUID(),
      target_sha256: SHA,
      address,
      name: `fn_${index}`,
      ...stamp,
    })),
    notes: ["0x1", "0x2"].map((address) => ({
      id: crypto.randomUUID(),
      text: "why",
      anchor: anchor(address),
      kind: "comment" as const,
      ...stamp,
    })),
  };
};

const session = (
  overrides: Partial<SessionIdentity> = {},
): SessionIdentity => ({
  sha256: SHA,
  provider_id: "ghidra",
  profile_digest: DIGEST,
  capabilities: { names: true, comments: true, bookmarks: true },
  ...overrides,
});

describe("planApplyToSession", () => {
  it("refuses a different file", () => {
    expect(
      planApplyToSession(project(), SHA, session({ sha256: "e".repeat(64) })),
    ).toEqual({ ok: false, reason: "The open session is a different file." });
  });

  it("refuses when the session identity is unknown", () => {
    for (const unknown of [{ sha256: null }, { provider_id: null }])
      expect(planApplyToSession(project(), SHA, session(unknown))).toEqual({
        ok: false,
        reason: "The open session's identity is unknown.",
      });
  });

  it("refuses another provider and a different analysis profile", () => {
    expect(
      planApplyToSession(project(), SHA, session({ provider_id: "hopper" })).ok,
    ).toBe(false);
    expect(
      planApplyToSession(
        project(),
        SHA,
        session({ profile_digest: "f".repeat(64) }),
      ).ok,
    ).toBe(false);
  });

  it("allows a session that reports no profile", () => {
    expect(
      planApplyToSession(project(), SHA, session({ profile_digest: null })).ok,
    ).toBe(true);
  });

  it("batches names and skips comments a provider cannot store", () => {
    expect(
      planApplyToSession(
        project(),
        SHA,
        session({
          capabilities: { names: true, comments: false, bookmarks: false },
        }),
      ),
    ).toEqual({
      ok: true,
      calls: [
        {
          tool: "set_addresses_names",
          arguments: { names: { "0x1": "fn_0", "0x2": "fn_1", "0x3": "fn_2" } },
        },
      ],
      skipped: [
        {
          kind: "comment",
          count: 2,
          reason: "This provider cannot store comments.",
        },
      ],
    });
  });

  it("emits one set_comment per comment when supported", () => {
    const plan = planApplyToSession(project(), SHA, session());
    expect(plan.ok && plan.calls.map((c) => c.tool)).toEqual([
      "set_addresses_names",
      "set_comment",
      "set_comment",
    ]);
  });
});
