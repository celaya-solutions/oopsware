import { describe, expect, it, vi } from "vitest";

const nativeCall = vi.hoisted(() => vi.fn());

vi.mock("./WindowsNativeLoader.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./WindowsNativeLoader.js")>();
  return {
    ...actual,
    requireWindowsNativeAuthority: () => ({ call: nativeCall }),
  };
});

import {
  WindowsPrivateRuntime,
  WindowsSnapshotCancelledError,
  windowsPrivateRuntime,
} from "./WindowsPrivateRuntime.js";

const observation = {
  requestedPath: "C:\\rea-private",
  finalPath: "C:\\rea-private",
  filesystem: "NTFS",
  volumeSerial: "0123456789abcdef",
  fileId: "0123456789abcdef0123456789abcdef",
  size: 0,
  directory: true,
  path: "C:\\rea-private",
  handle: {},
  privateDacl: true,
};

const nativeFailure = (win32Code: number): Error =>
  Object.assign(new Error(`native close failed (${win32Code})`), {
    code: "ERR_REA_WINDOWS_NATIVE",
    win32Code,
  });

describe("Windows private runtime cleanup retry", () => {
  it("retries a transient sharing conflict through the same owned close", async () => {
    const conflict = nativeFailure(32);
    let closes = 0;
    nativeCall.mockImplementation((operation: string) => {
      if (operation === "runtime_create") return observation;
      if (operation === "runtime_close" && closes++ === 0) throw conflict;
      return null;
    });
    const runtime = WindowsPrivateRuntime.create("C:\\", "rea-");

    await runtime.close();

    expect(closes).toBe(2);
    expect(() => windowsPrivateRuntime(observation.path)).toThrow(
      /No native private runtime/u,
    );
  });

  it.each([
    ["a native access denial", nativeFailure(5)],
    [
      "a POSIX-style access denial",
      Object.assign(new Error("access denied"), {
        code: "EACCES",
        win32Code: 32,
      }),
    ],
    [
      "a native error with string code 32",
      Object.assign(new Error("sharing conflict"), {
        code: "ERR_REA_WINDOWS_NATIVE",
        win32Code: "32",
      }),
    ],
    [
      "a native error without a Win32 code",
      Object.assign(new Error("native failure"), {
        code: "ERR_REA_WINDOWS_NATIVE",
      }),
    ],
    [
      "a missing-path error carrying a Win32 sharing code",
      Object.assign(new Error("path disappeared"), {
        code: "ENOENT",
        win32Code: 32,
      }),
    ],
    [
      "a nested cleanup detail carrying a Win32 sharing code",
      Object.assign(new Error("native failure"), {
        code: "ERR_REA_WINDOWS_NATIVE",
        cleanup: { win32Code: 32 },
      }),
    ],
  ] as const)(
    "does not retry %s and retains the owner for a later close",
    async (_label, denied) => {
      let closes = 0;
      nativeCall.mockImplementation((operation: string) => {
        if (operation === "runtime_create") return observation;
        if (operation === "runtime_close" && closes++ === 0) throw denied;
        return null;
      });
      const runtime = WindowsPrivateRuntime.create("C:\\", "rea-");

      await expect(runtime.close()).rejects.toBe(denied);
      expect(closes).toBe(1);
      expect(windowsPrivateRuntime(observation.path)).toBe(runtime);
      await runtime.close();
      expect(closes).toBe(2);
    },
  );

  it("shares one in-flight close across concurrent callers", async () => {
    let closes = 0;
    nativeCall.mockImplementation((operation: string) => {
      if (operation === "runtime_create") return observation;
      if (operation === "runtime_close" && closes++ === 0)
        throw nativeFailure(33);
      return null;
    });
    const runtime = WindowsPrivateRuntime.create("C:\\", "rea-");
    const first = runtime.close();
    const second = runtime.close();

    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(closes).toBe(2);
  });

  it("retains the exact final native error and owner when conflicts persist", async () => {
    const conflict = nativeFailure(32);
    let closes = 0;
    nativeCall.mockImplementation((operation: string) => {
      if (operation === "runtime_create") return observation;
      if (operation === "runtime_close") {
        closes++;
        throw conflict;
      }
      return null;
    });
    const runtime = WindowsPrivateRuntime.create("C:\\", "rea-");

    await expect(runtime.close()).rejects.toBe(conflict);

    expect(closes).toBe(10);
    expect(windowsPrivateRuntime(observation.path)).toBe(runtime);
    nativeCall.mockImplementation((operation: string) =>
      operation === "runtime_create" ? observation : null,
    );
    await runtime.close();
  });
});

it.each([995, 5])(
  "classifies native snapshot code %i independently of a late abort",
  async (code) => {
    const controller = new AbortController();
    const failure = nativeFailure(code);
    nativeCall.mockImplementation((operation: string) => {
      if (operation === "runtime_create") return observation;
      if (operation === "runtime_snapshot") return Promise.reject(failure);
      return null;
    });
    const runtime = WindowsPrivateRuntime.create("C:\\", "rea-");
    const pending = runtime.snapshot(
      "C:\\target.bin",
      "target.bin",
      controller.signal,
    );
    controller.abort(null);
    const result: unknown = await pending.catch((cause: unknown) => cause);
    if (code === 995) {
      expect(result).toBeInstanceOf(WindowsSnapshotCancelledError);
      expect(result).toMatchObject({ reason: null, cause: failure });
    } else expect(result).toBe(failure);
    await runtime.close();
  },
);
