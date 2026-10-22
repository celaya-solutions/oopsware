import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { FridaScriptLoadCancelledError } from "./FridaInstrumentationPort.js";
import type { FridaInstrumentationPort } from "./FridaInstrumentationPort.js";
import { FridaInstrumentationService } from "./FridaInstrumentationService.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
} from "../../domain/analysisErrorCore.js";

const createSession = () => ({
  sessionId: "00000000-0000-4000-8000-000000000001",
  deviceId: "local",
  target: "fixture",
  pid: 10,
  mode: "spawn" as const,
  state: "paused" as const,
});

const createScriptObservation = () => ({
  scriptId: "00000000-0000-4000-8000-000000000002",
  sourceKind: "inline" as const,
  sourcePath: null,
  sourceSha256: "a".repeat(64),
  messages: [],
  messagesTruncated: false,
});

const createProvider = (
  overrides: Partial<FridaInstrumentationPort> = {},
): FridaInstrumentationPort => ({
  async listDevices() {
    return { ok: true, value: { devices: [], cleanupError: null } };
  },
  async listProcesses() {
    return {
      ok: true,
      value: { deviceId: "local", processes: [], cleanupError: null },
    };
  },
  async startSession() {
    return { ok: true, value: createSession() };
  },
  async loadScript() {
    return { ok: true, value: createScriptObservation() };
  },
  async resumeSession() {
    return { ok: true, value: null };
  },
  async unloadScript() {
    return { ok: true, value: null };
  },
  status() {
    return undefined;
  },
  async closeSession() {
    return { ok: true, value: { targetResumeObserved: false } };
  },
  async closeAll() {},
  ...overrides,
});

it.each(["startSession", "instrument"] as const)(
  "does not start Frida when %s receives an already-cancelled signal",
  async (method) => {
    let starts = 0;
    let loads = 0;
    const provider = createProvider({
      async startSession() {
        starts += 1;
        return { ok: true, value: createSession() };
      },
      async loadScript() {
        loads += 1;
        return { ok: true, value: createScriptObservation() };
      },
    });
    const service = new FridaInstrumentationService(provider);
    const controller = new AbortController();
    controller.abort(new Error("cancelled before call"));

    const result =
      method === "startSession"
        ? await service.startSession(
            { mode: "spawn", deviceId: "local", program: "/tmp/fixture" },
            controller.signal,
          )
        : await service.instrument(
            {
              mode: "spawn",
              deviceId: "local",
              program: "/tmp/fixture",
              source: { sourceKind: "inline", source: "send('ready');" },
              durationMs: 1,
            },
            controller.signal,
          );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error._tag).toBe("AnalysisCancelledError");
    expect(starts).toBe(0);
    expect(loads).toBe(0);
  },
);

it.each([
  [join(tmpdir(), "rea-missing-frida-script.js"), "no file exists there"],
  [tmpdir(), "it is not a regular file"],
])(
  "rejects the unreadable script file %s before starting Frida",
  async (path, reason) => {
    let starts = 0;
    const provider = createProvider({
      async startSession() {
        starts += 1;
        return { ok: true, value: createSession() };
      },
    });
    const service = new FridaInstrumentationService(provider);

    const result = await service.instrument({
      mode: "spawn",
      deviceId: "local",
      program: "/tmp/fixture",
      source: { sourceKind: "file", path },
      durationMs: 1,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(AnalysisInputError);
    expect((result.error as AnalysisInputError).issues).toEqual([
      {
        path: ["path"],
        reason: "invalid_value",
        message: `Cannot read Frida script file ${path}: ${reason}.`,
      },
    ]);
    expect(starts).toBe(0);
  },
);

it("reports cancellation before checking a file script source", async () => {
  const service = new FridaInstrumentationService(createProvider());
  const controller = new AbortController();
  controller.abort(new Error("cancelled before call"));

  const result = await service.instrument(
    {
      mode: "spawn",
      deviceId: "local",
      program: "/tmp/fixture",
      source: {
        sourceKind: "file",
        path: join(tmpdir(), "rea-missing-frida-script.js"),
      },
      durationMs: 1,
    },
    controller.signal,
  );

  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error._tag).toBe("AnalysisCancelledError");
});

it("does not resume a spawned target when cancellation arrives during script loading", async () => {
  const controller = new AbortController();
  let resumes = 0;
  let closes = 0;
  const service = new FridaInstrumentationService(
    createProvider({
      async loadScript() {
        controller.abort(new Error("cancelled while loading"));
        return { ok: true, value: createScriptObservation() };
      },
      async resumeSession() {
        resumes += 1;
        return { ok: true, value: null };
      },
      async closeSession() {
        closes += 1;
        return { ok: true, value: { targetResumeObserved: true } };
      },
    }),
  );

  const result = await service.instrument(
    {
      mode: "spawn",
      deviceId: "local",
      program: "/tmp/fixture",
      source: { sourceKind: "inline", source: "send('ready');" },
      durationMs: 1,
    },
    controller.signal,
  );

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error._tag).toBe("AnalysisCancelledError");
    expect(result.error.partialObservation).toMatchObject({
      normalized_result: {
        cleanup_error: null,
        target_state_before_cleanup: "paused",
        target_resume_observed: true,
        instrumentation_cleanup: "released",
        target_liveness_after_cleanup: "unknown",
      },
      parameters: {
        mode: "spawn",
        program: "/tmp/fixture",
      },
    });
  }
  expect(resumes).toBe(0);
  expect(closes).toBe(1);
});

it("reports the spawned session when cancellation arrives during resume", async () => {
  const controller = new AbortController();
  let closes = 0;
  const service = new FridaInstrumentationService(
    createProvider({
      async resumeSession() {
        controller.abort(new Error("cancelled while resuming"));
        return { ok: true, value: null };
      },
      status() {
        return {
          ...createSession(),
          state: "running",
          targetResumeObserved: true,
          scripts: [],
          messages: [],
          messagesTruncated: false,
        };
      },
      async closeSession() {
        closes += 1;
        return { ok: true, value: { targetResumeObserved: false } };
      },
    }),
  );

  const result = await service.instrument(
    {
      mode: "spawn",
      deviceId: "local",
      program: "/tmp/fixture",
      argv: ["--owned-fixture"],
      source: { sourceKind: "inline", source: "send('ready');" },
      durationMs: 60_000,
    },
    controller.signal,
  );

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error._tag).toBe("AnalysisCancelledError");
    expect(result.error.partialObservation).toMatchObject({
      normalized_result: {
        target_state_before_cleanup: "running",
        target_resume_observed: true,
        instrumentation_cleanup: "released",
        target_liveness_after_cleanup: "unknown",
      },
      parameters: {
        argv: ["--owned-fixture"],
      },
    });
  }
  expect(closes).toBe(1);
});

it.each([false, true])(
  "preserves a native resume failure when cancellation arrives before it settles (cleanupFails=%s)",
  async (cleanupFails) => {
    const controller = new AbortController();
    const abortReason = new Error("late cancellation during native resume");
    const primary = new AnalysisCapabilityUnavailableError(
      "frida",
      "resume_frida_session",
      "native resume failed",
      { diagnostics: { native_status: "resume_rejected" } },
    );
    let markResumeEntered: (() => void) | undefined;
    let finishResume:
      | ((result: {
          readonly ok: false;
          readonly error: AnalysisCapabilityUnavailableError;
        }) => void)
      | undefined;
    const resumeEntered = new Promise<void>((resolve) => {
      markResumeEntered = resolve;
    });
    let closes = 0;
    const service = new FridaInstrumentationService(
      createProvider({
        resumeSession() {
          markResumeEntered?.();
          return new Promise((resolve) => {
            finishResume = resolve;
          });
        },
        async closeSession() {
          closes += 1;
          return cleanupFails
            ? {
                ok: false,
                error: new AnalysisCapabilityUnavailableError(
                  "frida",
                  "close_frida_session",
                  "session cleanup failed",
                ),
              }
            : { ok: true, value: { targetResumeObserved: false } };
        },
      }),
    );

    const pending = service.instrument(
      {
        mode: "spawn",
        deviceId: "local",
        program: "/fixture",
        source: { sourceKind: "inline", source: "send('resume-failure')" },
        durationMs: 0,
      },
      controller.signal,
    );
    await resumeEntered;
    controller.abort(abortReason);
    finishResume?.({ ok: false, error: primary });
    const result = await pending;

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).not.toBeInstanceOf(AnalysisCancelledError);
    if (cleanupFails) {
      expect(result.error).toBeInstanceOf(AnalysisCapabilityUnavailableError);
      expect(result.error.cause).toBe(primary);
      expect(result.error.diagnostics).toEqual({
        native_status: "resume_rejected",
      });
      expect(result.error.cleanup).toMatchObject({
        reason: expect.stringContaining("session cleanup failed"),
        resources: [createSession().sessionId],
      });
    } else {
      expect(result.error).toBe(primary);
    }
    expect(closes).toBe(1);
  },
);

it("keeps a typed resume cancellation as cancellation when its signal is aborted", async () => {
  const controller = new AbortController();
  const abortReason = new Error("native resume was cancelled");
  let closes = 0;
  const service = new FridaInstrumentationService(
    createProvider({
      async resumeSession() {
        controller.abort(abortReason);
        return {
          ok: false,
          error: new AnalysisCancelledError("resume_frida_session", {
            cause: abortReason,
          }),
        };
      },
      async closeSession() {
        closes += 1;
        return { ok: true, value: { targetResumeObserved: false } };
      },
    }),
  );

  const result = await service.instrument(
    {
      mode: "spawn",
      deviceId: "local",
      program: "/fixture",
      source: { sourceKind: "inline", source: "send('resume-cancel')" },
      durationMs: 0,
    },
    controller.signal,
  );

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toBeInstanceOf(AnalysisCancelledError);
  expect(result.error.cause).toBe(abortReason);
  expect(closes).toBe(1);
});

it("does not infer a Frida resume for a running attached target on cancellation", async () => {
  const controller = new AbortController();
  const service = new FridaInstrumentationService(
    createProvider({
      async loadScript() {
        controller.abort(new Error("cancelled while loading"));
        return { ok: true, value: createScriptObservation() };
      },
      status() {
        return {
          ...createSession(),
          mode: "attach",
          state: "running",
          targetResumeObserved: false,
          scripts: [],
          messages: [],
          messagesTruncated: false,
        };
      },
      async closeSession() {
        return { ok: true, value: { targetResumeObserved: false } };
      },
    }),
  );

  const result = await service.instrument(
    {
      mode: "attach",
      deviceId: "local",
      pid: 512,
      source: { sourceKind: "inline", source: "send('ready');" },
      durationMs: 0,
    },
    controller.signal,
  );

  expect(result.ok).toBe(false);
  if (!result.ok)
    expect(result.error.partialObservation).toMatchObject({
      normalized_result: {
        target_state_before_cleanup: "running",
        target_resume_observed: false,
      },
    });
});

it("retains an observed spawn resume after the target detaches before cancellation", async () => {
  const controller = new AbortController();
  const service = new FridaInstrumentationService(
    createProvider({
      async loadScript() {
        controller.abort(new Error("cancelled after target exit"));
        return { ok: true, value: createScriptObservation() };
      },
      status() {
        return {
          ...createSession(),
          state: "detached",
          targetResumeObserved: true,
          scripts: [],
          messages: [],
          messagesTruncated: false,
        };
      },
      async closeSession() {
        return { ok: true, value: { targetResumeObserved: false } };
      },
    }),
  );

  const result = await service.instrument(
    {
      mode: "spawn",
      deviceId: "local",
      program: "/tmp/fixture",
      source: { sourceKind: "inline", source: "send('ready');" },
      durationMs: 0,
    },
    controller.signal,
  );

  expect(result.ok).toBe(false);
  if (!result.ok)
    expect(result.error.partialObservation).toMatchObject({
      normalized_result: {
        target_state_before_cleanup: "detached",
        target_resume_observed: true,
      },
    });
});

it("returns typed partial Evidence when cancellation arrives during successful final cleanup", async () => {
  const controller = new AbortController();
  const abortReason = new Error("cancelled during final detach");
  const script = {
    ...createScriptObservation(),
    messages: [{ type: "send", payload: "completed-before-detach" }],
  };
  let closes = 0;
  const service = new FridaInstrumentationService(
    createProvider({
      async loadScript() {
        return { ok: true, value: script };
      },
      async closeSession() {
        closes += 1;
        controller.abort(abortReason);
        return { ok: true, value: { targetResumeObserved: true } };
      },
    }),
  );

  const result = await service.instrument(
    {
      mode: "spawn",
      deviceId: "local",
      program: "/fixture",
      source: {
        sourceKind: "inline",
        source: "send('completed-before-detach')",
      },
      durationMs: 0,
    },
    controller.signal,
  );

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toBeInstanceOf(AnalysisCancelledError);
  expect(result.error.cause).toBe(abortReason);
  expect(result.error.partialObservation).toMatchObject({
    normalized_result: {
      messages: script.messages,
      source_sha256: script.sourceSha256,
      cleanup_error: null,
      target_state_before_cleanup: "paused",
      target_resume_observed: true,
      instrumentation_cleanup: "released",
      target_liveness_after_cleanup: "unknown",
    },
  });
  expect(closes).toBe(1);
});

it("keeps cancellation primary and records failed final cleanup without retrying it", async () => {
  const controller = new AbortController();
  const abortReason = { source: "test", stage: "final-detach" };
  let closes = 0;
  const service = new FridaInstrumentationService(
    createProvider({
      async loadScript() {
        return { ok: true, value: createScriptObservation() };
      },
      async closeSession() {
        closes += 1;
        controller.abort(abortReason);
        return {
          ok: false,
          error: new AnalysisCapabilityUnavailableError(
            "frida",
            "close_frida_session",
            "detach acknowledgement failed",
            {
              cleanup: {
                reason: "session remains owned",
                resources: [createSession().sessionId],
              },
            },
          ),
        };
      },
    }),
  );

  const result = await service.instrument(
    {
      mode: "spawn",
      deviceId: "local",
      program: "/fixture",
      source: { sourceKind: "inline", source: "send('ready')" },
      durationMs: 0,
    },
    controller.signal,
  );

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toBeInstanceOf(AnalysisCancelledError);
  expect(result.error.cause).toBe(abortReason);
  expect(result.error.cleanup).toEqual({
    reason:
      "Provider frida cannot execute close_frida_session: detach acknowledgement failed",
    resources: [createSession().sessionId],
  });
  expect(result.error.partialObservation).toMatchObject({
    normalized_result: {
      cleanup_error:
        "Provider frida cannot execute close_frida_session: detach acknowledgement failed",
      instrumentation_cleanup: "incomplete_or_unknown",
    },
  });
  expect(closes).toBe(1);
});

it("retains a spawned resume reported after detach when remote cleanup fails", async () => {
  const controller = new AbortController();
  const abortReason = new Error("cancelled during remote cleanup");
  let statusReads = 0;
  let closes = 0;
  const service = new FridaInstrumentationService(
    createProvider({
      status() {
        statusReads += 1;
        return {
          ...createSession(),
          state: statusReads === 1 ? "paused" : "detached",
          targetResumeObserved: statusReads > 1,
          scripts: [],
          messages: [],
          messagesTruncated: false,
        };
      },
      async closeSession() {
        closes += 1;
        controller.abort(abortReason);
        return {
          ok: false,
          error: new AnalysisCapabilityUnavailableError(
            "frida",
            "close_frida_session",
            "remote removal failed after detach",
          ),
        };
      },
    }),
  );

  const result = await service.instrument(
    {
      mode: "spawn",
      deviceId: "local",
      program: "/fixture",
      source: { sourceKind: "inline", source: "send('ready')" },
      durationMs: 0,
    },
    controller.signal,
  );

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toBeInstanceOf(AnalysisCancelledError);
  expect(result.error.cause).toBe(abortReason);
  expect(result.error.partialObservation).toMatchObject({
    normalized_result: {
      target_state_before_cleanup: "paused",
      target_resume_observed: true,
      cleanup_error:
        "Provider frida cannot execute close_frida_session: remote removal failed after detach",
      instrumentation_cleanup: "incomplete_or_unknown",
    },
  });
  expect(statusReads).toBe(2);
  expect(closes).toBe(1);
});

it.each([
  { cleanupState: "running" as const, resumeObserved: false },
  { cleanupState: "paused" as const, resumeObserved: false },
  { cleanupState: "detached" as const, resumeObserved: true },
])(
  "uses explicit resume evidence after failed cleanup ($cleanupState)",
  async ({ cleanupState, resumeObserved }) => {
    const controller = new AbortController();
    let statusCalls = 0;
    const service = new FridaInstrumentationService(
      createProvider({
        async loadScript() {
          controller.abort(new Error("cancelled while loading"));
          return { ok: true, value: createScriptObservation() };
        },
        status() {
          statusCalls += 1;
          return {
            ...createSession(),
            state: statusCalls === 1 ? "paused" : cleanupState,
            targetResumeObserved: statusCalls > 1 && resumeObserved,
            scripts: [],
            messages: [],
            messagesTruncated: false,
          };
        },
        async closeSession() {
          return {
            ok: false,
            error: new AnalysisCapabilityUnavailableError(
              "frida",
              "close_frida_session",
              "session cleanup failed",
            ),
          };
        },
      }),
    );

    const result = await service.instrument(
      {
        mode: "spawn",
        deviceId: "local",
        program: "/tmp/fixture",
        source: { sourceKind: "inline", source: "send('ready');" },
        durationMs: 0,
      },
      controller.signal,
    );

    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.partialObservation).toMatchObject({
        normalized_result: {
          instrumentation_cleanup: "incomplete_or_unknown",
          target_state_before_cleanup: "paused",
          target_resume_observed: resumeObserved,
        },
      });
  },
);

it("records target selection in Evidence without remote authentication values", async () => {
  const token = "synthetic-frida-token";
  const certificate = "synthetic-frida-certificate";
  const service = new FridaInstrumentationService(createProvider());

  const result = await service.instrument({
    mode: "spawn",
    remote: {
      address: "127.0.0.1:27042",
      token,
      certificate,
      origin: "rea-test",
      keepaliveInterval: 1_000,
    },
    program: "/tmp/fixture",
    argv: ["--marker", "selected-argument"],
    source: { sourceKind: "inline", source: "send('ready');" },
    durationMs: 1,
  });

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.evidence.parameters).toMatchObject({
    session_id: createSession().sessionId,
    remote: {
      address: "127.0.0.1:27042",
      origin: "rea-test",
      keepalive_interval: 1_000,
    },
    mode: "spawn",
    program: "/tmp/fixture",
    argv: ["--marker", "selected-argument"],
  });
  const parameters = JSON.stringify(result.value.evidence.parameters);
  expect(parameters).not.toContain(token);
  expect(parameters).not.toContain(certificate);
});

it("reports completed cleanup when closing the parent session releases a failed script", async () => {
  const service = new FridaInstrumentationService(
    createProvider({
      async loadScript() {
        return {
          ok: false,
          error: new AnalysisCapabilityUnavailableError(
            "frida",
            "load_frida_script",
            "script load failed",
            {
              cleanup: {
                reason: "script unload failed",
                resources: ["script-1"],
              },
            },
          ),
        };
      },
    }),
  );

  const result = await service.instrument({
    mode: "spawn",
    deviceId: "local",
    program: "/tmp/fixture",
    source: { sourceKind: "inline", source: "send('ready');" },
    durationMs: 1,
  });

  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.cleanupIncomplete).toBe(false);
});

it("cleans up a session and returns typed cancellation after a pending start", async () => {
  let finishStart: (() => void) | undefined;
  let markStartCalled: (() => void) | undefined;
  const startGate = new Promise<void>((resolve) => {
    finishStart = resolve;
  });
  const startCalled = new Promise<void>((resolve) => {
    markStartCalled = resolve;
  });
  const closed: string[] = [];
  const provider: FridaInstrumentationPort = {
    async listDevices() {
      return { ok: true, value: { devices: [], cleanupError: null } };
    },
    async listProcesses() {
      return {
        ok: true,
        value: { deviceId: "local", processes: [], cleanupError: null },
      };
    },
    async startSession() {
      markStartCalled?.();
      await startGate;
      return {
        ok: true,
        value: {
          sessionId: "00000000-0000-4000-8000-000000000001",
          deviceId: "local",
          target: "fixture",
          pid: 10,
          mode: "attach",
          state: "running",
        },
      };
    },
    async loadScript() {
      return {
        ok: false,
        error: new AnalysisInputError("load_frida_script"),
      };
    },
    async resumeSession() {
      return { ok: true, value: null };
    },
    async unloadScript() {
      return { ok: true, value: null };
    },
    status() {
      return undefined;
    },
    async closeSession(sessionId) {
      closed.push(sessionId);
      return { ok: true, value: { targetResumeObserved: false } };
    },
    async closeAll() {},
  };
  const service = new FridaInstrumentationService(provider);
  const controller = new AbortController();
  const pending = service.startSession(
    { mode: "attach", deviceId: "local", pid: 10 },
    controller.signal,
  );
  await startCalled;
  controller.abort(new Error("caller cancelled"));
  finishStart?.();

  const result = await pending;
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error._tag).toBe("AnalysisCancelledError");
  expect(closed).toEqual(["00000000-0000-4000-8000-000000000001"]);
});

it("retains a cancelled provider load's source and messages in one-shot Evidence", async () => {
  const controller = new AbortController();
  const script = {
    ...createScriptObservation(),
    messages: [{ type: "send", payload: "cancelled-load" }],
  };
  const service = new FridaInstrumentationService(
    createProvider({
      async loadScript() {
        controller.abort(new Error("cancel during native load"));
        return {
          ok: false,
          error: new FridaScriptLoadCancelledError(script, {
            cause: controller.signal.reason,
          }),
        };
      },
    }),
  );
  const result = await service.instrument(
    {
      mode: "spawn",
      program: "/fixture",
      source: { sourceKind: "inline", source: "send('cancelled-load')" },
      durationMs: 0,
    },
    controller.signal,
  );
  if (result.ok) throw new Error("Cancelled instrumentation succeeded");
  expect(result.error.partialObservation).toMatchObject({
    normalized_result: {
      source_kind: "inline",
      source_sha256: script.sourceSha256,
      messages: script.messages,
      instrumentation_cleanup: "released",
    },
  });
});

it.each([
  ["before cleanup", false],
  ["before cleanup", true],
  ["during cleanup", false],
  ["during cleanup", true],
] as const)(
  "keeps an ordinary provider load failure primary when cancellation arrives %s (cleanupFails=%s)",
  async (abortTiming, cleanupFails) => {
    const controller = new AbortController();
    const abortReason = new Error("late caller cancellation");
    const primary = new AnalysisCapabilityUnavailableError(
      "frida",
      "load_frida_script",
      "native script compilation failed",
      { diagnostics: { native_status: "compile_rejected" } },
    );
    let closes = 0;
    const service = new FridaInstrumentationService(
      createProvider({
        async loadScript() {
          if (abortTiming === "before cleanup") controller.abort(abortReason);
          return { ok: false, error: primary };
        },
        async closeSession() {
          closes += 1;
          if (abortTiming === "during cleanup") controller.abort(abortReason);
          return cleanupFails
            ? {
                ok: false,
                error: new AnalysisCapabilityUnavailableError(
                  "frida",
                  "close_frida_session",
                  "session cleanup failed",
                ),
              }
            : { ok: true, value: { targetResumeObserved: false } };
        },
      }),
    );

    const result = await service.instrument(
      {
        mode: "spawn",
        program: "/fixture",
        source: { sourceKind: "inline", source: "send('ready');" },
        durationMs: 0,
      },
      controller.signal,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).not.toBeInstanceOf(AnalysisCancelledError);
    expect(controller.signal.reason).toBe(abortReason);
    if (cleanupFails) {
      expect(result.error).toBeInstanceOf(AnalysisCapabilityUnavailableError);
      expect(result.error.cause).toBe(primary);
      expect(result.error.diagnostics).toEqual({
        native_status: "compile_rejected",
      });
      expect(result.error.cleanup).toMatchObject({
        reason: expect.stringContaining("session cleanup failed"),
        resources: [createSession().sessionId],
      });
    } else {
      expect(result.error).toBe(primary);
    }
    expect(closes).toBe(1);
  },
);

it("preserves typed load cancellation cause, safe diagnostics, and decoded source representation in partial Evidence", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "rea-frida-cancelled-source-"),
  );
  const path = join(directory, "invalid-utf8.js");
  await writeFile(path, Buffer.from([0x2f, 0x2f, 0x20, 0xff, 0x0a]));
  try {
    const controller = new AbortController();
    const abortReason = new Error("native load cancelled after decoding");
    const diagnostics = {
      native_failure: "script load cancelled; transport_token=<redacted>",
      read_attempt: 1,
    };
    const script = {
      ...createScriptObservation(),
      sourceKind: "file" as const,
      sourcePath: path,
      sourceRepresentation: {
        encoding: "utf8" as const,
        decoding: "replacement" as const,
        loadedSourceSha256: "b".repeat(64),
      },
      messages: [{ type: "send", payload: "retained-before-cancel" }],
    };
    let closes = 0;
    const service = new FridaInstrumentationService(
      createProvider({
        async loadScript() {
          controller.abort(abortReason);
          return {
            ok: false,
            error: new FridaScriptLoadCancelledError(script, {
              cause: abortReason,
              diagnostics,
            }),
          };
        },
        async closeSession() {
          closes += 1;
          return { ok: true, value: { targetResumeObserved: false } };
        },
      }),
    );

    const result = await service.instrument(
      {
        mode: "spawn",
        program: "/fixture",
        source: { sourceKind: "file", path },
        durationMs: 0,
      },
      controller.signal,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(AnalysisCancelledError);
    expect(result.error.cause).toBe(abortReason);
    expect(result.error.diagnostics).toEqual(diagnostics);
    expect(result.error.partialObservation).toMatchObject({
      normalized_result: {
        source_kind: "file",
        source_path: path,
        source_sha256: script.sourceSha256,
        messages: script.messages,
        instrumentation_cleanup: "released",
      },
      raw_result: {
        source_representation: {
          encoding: "utf8",
          decoding: "replacement",
          loaded_source_sha256: "b".repeat(64),
        },
      },
      limitations: expect.arrayContaining([
        expect.stringContaining("Invalid UTF-8"),
      ]),
    });
    expect(closes).toBe(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("preserves a provider-committed load when cancellation arrives during result delivery", async () => {
  const controller = new AbortController();
  let unloads = 0;
  const script = createScriptObservation();
  const service = new FridaInstrumentationService(
    createProvider({
      loadScript() {
        const completed = Promise.resolve({ ok: true as const, value: script });
        void completed.then(() =>
          controller.abort(new Error("late cancellation")),
        );
        return completed;
      },
      async unloadScript() {
        unloads += 1;
        return { ok: true, value: null };
      },
    }),
  );
  const loaded = await service.loadScript(
    createSession().sessionId,
    { sourceKind: "inline", source: "send('ready')" },
    controller.signal,
  );
  expect(controller.signal.aborted).toBe(true);
  if (!loaded.ok) throw loaded.error;
  expect(loaded.value.normalized_result).toMatchObject({
    script_id: script.scriptId,
  });
  expect(unloads).toBe(0);
});
