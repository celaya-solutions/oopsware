import { expect, it, vi } from "vitest";
import {
  cleanupOwnedProcessGroup,
  type ProcessIdentityObservation,
  type ProcessOwnershipHost,
  type ProcessTableEntry,
} from "./ProcessOwnership.js";

it.each(["zombie", "absent", "live", "unavailable"] as const)(
  "rechecks native lifetime when a token disappears during cleanup: %s",
  async (lifetimeAfterToken) => {
    const row: ProcessTableEntry = {
      pid: 100,
      parentPid: 1,
      processGroupId: 100,
      state: "S",
      command: "fixture",
    };
    let tokenRead = false;
    const identity = (): ProcessIdentityObservation => {
      if (tokenRead && lifetimeAfterToken === "absent")
        return { state: "absent", reason: "not-found-in-caller-pid-namespace" };
      if (tokenRead && lifetimeAfterToken === "unavailable")
        return { state: "unavailable", reason: "identity read denied" };
      return {
        state: "readable",
        identity: "same-generation",
        lifecycle: {
          state: "observed",
          lifecycle:
            tokenRead && lifetimeAfterToken === "zombie"
              ? "zombie"
              : "non-zombie",
        },
        relation: { state: "observed", parentPid: 1, processGroupId: 100 },
      };
    };
    const signalGroup = vi.fn();
    const host: ProcessOwnershipHost = {
      platform: "linux",
      listProcesses: async () => [row],
      environment: async () => ({}),
      runTokens: async (members) => {
        tokenRead = true;
        return new Map(
          members.map(({ pid }) => [
            pid,
            { state: "readable" as const, runId: undefined },
          ]),
        );
      },
      processIdentities: async (members) =>
        new Map(members.map(({ pid }) => [pid, identity()])),
      signalGroup,
    };
    const result = await cleanupOwnedProcessGroup(
      { runId: "run", leaderPid: 100, processGroupId: 100 },
      host,
    );
    expect(tokenRead).toBe(true);
    if (lifetimeAfterToken === "zombie" || lifetimeAfterToken === "absent") {
      expect(result).toEqual({ cleaned: true, signaled: false });
    } else {
      expect(result).toMatchObject({
        cleaned: false,
        failures: [
          {
            pid: 100,
            reason:
              lifetimeAfterToken === "live"
                ? "run-token-mismatch"
                : "process-identity-unavailable",
          },
        ],
      });
    }
    expect(signalGroup).not.toHaveBeenCalled();
  },
);
