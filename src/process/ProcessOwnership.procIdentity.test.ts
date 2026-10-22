import { expect, it, vi } from "vitest";

const filesystem = vi.hoisted(() => ({
  readFile: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, readFile: filesystem.readFile };
});

import {
  createSystemProcessOwnershipHost,
  readProcessOwnershipFacts,
} from "./ProcessOwnershipObservation.js";
import type {
  ProcessOwnershipHost,
  ProcessTableEntry,
} from "./ProcessOwnership.js";

const entry: ProcessTableEntry = {
  pid: 42,
  parentPid: 1,
  processGroupId: 42,
  state: "S",
  command: "fixture",
};

const filesystemError = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(code), { code });

const procStat = (
  startTime: number,
  parentPid = 1,
  processGroupId = 42,
  pid = 42,
) => {
  const fields = ["S", String(parentPid), String(processGroupId), "42"];
  while (fields.length < 19) fields.push("0");
  fields.push(String(startTime));
  return `${String(pid)} (fixture) ${fields.join(" ")}`;
};

it("binds Linux effective UID to the same native process generation", async () => {
  const host = createSystemProcessOwnershipHost("linux", {});
  filesystem.readFile
    .mockResolvedValueOnce(procStat(100, 10, 42))
    .mockResolvedValueOnce("Name:\tfixture\nUid:\t1000\t1001\t1002\t1003\n")
    .mockResolvedValueOnce(procStat(100, 11, 43));

  await expect(
    host.processIdentities?.([entry], undefined, new Set([entry.pid])),
  ).resolves.toEqual(
    new Map([
      [
        42,
        {
          state: "readable",
          identity: "linux-starttime:100",
          effectiveUid: 1001,
          lifecycle: { state: "observed", lifecycle: "non-zombie" },
          relation: {
            state: "observed",
            parentPid: 11,
            processGroupId: 43,
          },
        },
      ],
    ]),
  );
  expect(filesystem.readFile.mock.calls.map(([path]) => path)).toEqual([
    "/proc/42/stat",
    "/proc/42/status",
    "/proc/42/stat",
  ]);
});

it("keeps native identity when status UID is unavailable", async () => {
  const host = createSystemProcessOwnershipHost("linux", {});
  filesystem.readFile
    .mockResolvedValueOnce(procStat(100))
    .mockRejectedValueOnce(filesystemError("EACCES"));

  await expect(
    host.processIdentities?.([entry], undefined, new Set([entry.pid])),
  ).resolves.toEqual(
    new Map([
      [
        42,
        {
          state: "readable",
          identity: "linux-starttime:100",
          lifecycle: { state: "observed", lifecycle: "non-zombie" },
          relation: {
            state: "observed",
            parentPid: 1,
            processGroupId: 42,
          },
        },
      ],
    ]),
  );
  expect(filesystem.readFile).toHaveBeenCalledTimes(2);
});

it("does not attach a UID when the process generation changes around status", async () => {
  const host = createSystemProcessOwnershipHost("linux", {});
  filesystem.readFile
    .mockResolvedValueOnce(procStat(100))
    .mockResolvedValueOnce("Uid:\t1000\t1001\t1002\t1003\n")
    .mockResolvedValueOnce(procStat(101));

  await expect(
    host.processIdentities?.([entry], undefined, new Set([entry.pid])),
  ).resolves.toEqual(
    new Map([
      [
        42,
        {
          state: "unavailable",
          reason: "process_identity_changed_during_uid_observation",
        },
      ],
    ]),
  );
});

it("reads Linux effective UID only for token-unavailable rows", async () => {
  const rows = [entry, { ...entry, pid: 43, processGroupId: 43 }];
  const statReads = new Map<number, number>();
  const uidStatusPids: number[] = [];
  filesystem.readFile.mockImplementation(async (path) => {
    const match = /^\/proc\/(\d+)\/(stat|status)$/u.exec(String(path));
    if (match === null) throw new Error(`unexpected path: ${String(path)}`);
    const pid = Number(match[1]);
    if (match[2] === "status") {
      uidStatusPids.push(pid);
      return "Uid:\t1000\t1001\t1002\t1003\n";
    }
    const reads = (statReads.get(pid) ?? 0) + 1;
    statReads.set(pid, reads);
    return procStat(100, 1, pid, pid);
  });
  const systemHost = createSystemProcessOwnershipHost("linux", {});
  const host: ProcessOwnershipHost = {
    ...systemHost,
    runTokens: async () =>
      new Map([
        [entry.pid, { state: "unavailable", reason: "EACCES" }],
        [43, { state: "readable", runId: undefined }],
      ]),
  };

  const facts = await readProcessOwnershipFacts(rows, host);

  expect(uidStatusPids).toEqual([entry.pid]);
  expect(facts.map(({ identityAfter }) => identityAfter)).toMatchObject([
    { state: "readable", effectiveUid: 1001 },
    { state: "readable" },
  ]);
  expect(facts[1]?.identityAfter).not.toHaveProperty("effectiveUid");
  expect(statReads).toEqual(
    new Map([
      [entry.pid, 3],
      [43, 2],
    ]),
  );
});

it("reports absence only when /proc lookup and signal-zero both report ESRCH", async () => {
  const host = createSystemProcessOwnershipHost("linux", {});
  const signalProbe = vi.spyOn(process, "kill").mockImplementation(() => {
    throw filesystemError("ESRCH");
  });
  try {
    for (const code of ["ENOENT", "ESRCH"]) {
      filesystem.readFile.mockRejectedValueOnce(filesystemError(code));
      await expect(host.processIdentities?.([entry])).resolves.toEqual(
        new Map([
          [
            42,
            {
              state: "absent",
              reason: "not-found-in-caller-pid-namespace",
            },
          ],
        ]),
      );
    }
    expect(signalProbe).toHaveBeenCalledTimes(2);
    expect(signalProbe).toHaveBeenNthCalledWith(1, 42, 0);
  } finally {
    signalProbe.mockRestore();
  }
});

it("keeps hidden or permission-denied live PIDs unavailable", async () => {
  const host = createSystemProcessOwnershipHost("linux", {});
  const signalProbe = vi.spyOn(process, "kill");
  try {
    filesystem.readFile.mockRejectedValueOnce(filesystemError("ENOENT"));
    signalProbe.mockReturnValueOnce(true);
    await expect(host.processIdentities?.([entry])).resolves.toEqual(
      new Map([
        [
          42,
          {
            state: "unavailable",
            reason: "proc_stat_missing_but_process_signal_probe_succeeded",
          },
        ],
      ]),
    );

    filesystem.readFile.mockRejectedValueOnce(filesystemError("ENOENT"));
    signalProbe.mockImplementationOnce(() => {
      throw filesystemError("EPERM");
    });
    const denied = await host.processIdentities?.([entry]);
    const deniedIdentity = denied?.get(42);
    expect(deniedIdentity).toMatchObject({ state: "unavailable" });
    expect(
      deniedIdentity?.state === "unavailable" ? deniedIdentity.reason : "",
    ).toContain("EPERM");
  } finally {
    signalProbe.mockRestore();
  }
});

it("keeps permission, parser, and unexpected failures unavailable", async () => {
  const host = createSystemProcessOwnershipHost("linux", {});
  const signalProbe = vi.spyOn(process, "kill");
  try {
    for (const code of ["EACCES", "EPERM", "EIO"]) {
      filesystem.readFile.mockRejectedValueOnce(filesystemError(code));
      const result = await host.processIdentities?.([entry]);
      expect(result?.get(42)?.state).toBe("unavailable");
    }

    filesystem.readFile.mockResolvedValueOnce("42 (fixture) S malformed");
    await expect(host.processIdentities?.([entry])).resolves.toEqual(
      new Map([[42, { state: "unavailable", reason: "malformed_proc_stat" }]]),
    );
    expect(signalProbe).not.toHaveBeenCalled();
  } finally {
    signalProbe.mockRestore();
  }
});

it("rejects invalid PIDs before procfs lookup or signal probing", async () => {
  const host = createSystemProcessOwnershipHost("linux", {});
  const signalProbe = vi.spyOn(process, "kill");
  filesystem.readFile.mockClear();
  try {
    await expect(
      host.processIdentities?.([{ ...entry, pid: 0 }]),
    ).resolves.toEqual(
      new Map([[0, { state: "unavailable", reason: "invalid_process_id" }]]),
    );
    expect(filesystem.readFile).not.toHaveBeenCalled();
    expect(signalProbe).not.toHaveBeenCalled();
  } finally {
    signalProbe.mockRestore();
  }
});

it("preserves cancellation before and after the signal-zero probe", async () => {
  const host = createSystemProcessOwnershipHost("linux", {});
  const controller = new AbortController();
  const reason = new Error("cancelled");
  controller.abort(reason);
  filesystem.readFile.mockRejectedValueOnce(
    Object.assign(new Error("aborted"), { name: "AbortError" }),
  );
  await expect(
    host.processIdentities?.([entry], controller.signal),
  ).rejects.toMatchObject({ name: "AbortError" });

  const afterProbe = new AbortController();
  const probeAbort = vi.spyOn(process, "kill").mockImplementation(() => {
    afterProbe.abort(reason);
    throw filesystemError("ESRCH");
  });
  try {
    filesystem.readFile.mockRejectedValueOnce(filesystemError("ENOENT"));
    await expect(
      host.processIdentities?.([entry], afterProbe.signal),
    ).rejects.toBe(reason);
  } finally {
    probeAbort.mockRestore();
  }
});
