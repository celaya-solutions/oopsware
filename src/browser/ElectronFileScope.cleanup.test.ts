import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, expect, it, vi } from "vitest";

const handleState = vi.hoisted(() => ({
  archive: undefined as string | undefined,
  failCloseCount: 0,
  closeController: undefined as AbortController | undefined,
  closeReason: undefined as unknown,
  readController: undefined as AbortController | undefined,
  readReason: undefined as unknown,
  statController: undefined as AbortController | undefined,
  statReason: undefined as unknown,
  readFailure: undefined as Error | undefined,
  events: [] as string[],
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (String(args[0]) !== handleState.archive) return handle;
      handleState.events.push("open");
      return new Proxy(handle, {
        get(target, property, receiver) {
          if (property === "stat" && handleState.statController !== undefined)
            return async () => {
              const result = await target.stat();
              handleState.statController?.abort(handleState.statReason);
              handleState.statController = undefined;
              return result;
            };
          if (property === "read" && handleState.readFailure !== undefined)
            return async () => {
              const failure = handleState.readFailure;
              handleState.readFailure = undefined;
              throw failure;
            };
          if (property === "read" && handleState.readController !== undefined)
            return async (...args: Parameters<typeof target.read>) => {
              const response = await target.read(...args);
              handleState.readController?.abort(handleState.readReason);
              handleState.readController = undefined;
              return response;
            };
          if (property === "close")
            return async () => {
              handleState.events.push("close");
              if (handleState.closeController !== undefined) {
                handleState.closeController.abort(handleState.closeReason);
                handleState.closeController = undefined;
              }
              if (handleState.failCloseCount > 0) {
                handleState.failCloseCount -= 1;
                throw new Error("controlled ASAR descriptor close failure");
              }
              return await target.close();
            };
          return Reflect.get(target, property, receiver) as unknown;
        },
      });
    },
  };
});

import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { CdpElectronProvider } from "./CdpElectronProvider.js";
import {
  authorizedElectronFile,
  mapElectronFileAuthorizationFailure,
  retryElectronFileCleanup,
} from "./ElectronFileScope.js";

const roots: string[] = [];

afterEach(async () => {
  await retryElectronFileCleanup();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
  handleState.archive = undefined;
  handleState.failCloseCount = 0;
  handleState.closeController = undefined;
  handleState.closeReason = undefined;
  handleState.readController = undefined;
  handleState.readReason = undefined;
  handleState.statController = undefined;
  handleState.statReason = undefined;
  handleState.readFailure = undefined;
  handleState.events = [];
});

const asarPage = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "rea-electron-file-scope-"));
  roots.push(root);
  const archive = join(root, "app.asar");
  const json = Buffer.from(
    JSON.stringify({ files: { "index.html": { size: 1, offset: "0" } } }),
  );
  const archiveBytes = Buffer.alloc(16 + json.length + 1);
  const headerBytes = 8 + json.length;
  archiveBytes.writeUInt32LE(4, 0);
  archiveBytes.writeUInt32LE(headerBytes, 4);
  archiveBytes.writeUInt32LE(headerBytes - 4, 8);
  archiveBytes.writeUInt32LE(json.length, 12);
  json.copy(archiveBytes, 16);
  archiveBytes[16 + json.length] = 0;
  await writeFile(archive, archiveBytes);
  handleState.archive = archive;
  return pathToFileURL(join(archive, "index.html")).href;
};

it("retains a failed ASAR close through denial and retries before reopening", async () => {
  const location = await asarPage();
  const missing = pathToFileURL(
    join(dirname(fileURLToPath(location)), "missing.js"),
  ).href;
  handleState.failCloseCount = 1;

  let failure: unknown;
  try {
    await authorizedElectronFile(missing, undefined, "list_electron_targets");
  } catch (cause: unknown) {
    failure = cause;
  }

  if (!(failure instanceof ArtifactReaderFailure))
    throw new Error("Expected an ASAR descriptor cleanup failure");
  expect(failure.cleanup?.resources).toEqual([handleState.archive]);
  const mapped = mapElectronFileAuthorizationFailure(
    failure,
    "rea-cdp-electron",
    "list_electron_targets",
  );
  expect(mapped?.cleanupIncomplete).toBe(true);
  expect(mapped?.cleanupPrimary).toBeUndefined();

  await expect(
    authorizedElectronFile(missing, undefined, "list_electron_targets"),
  ).resolves.toBeUndefined();
  expect(handleState.events).toEqual([
    "open",
    "close",
    "close",
    "open",
    "close",
  ]);
  expect(mapped?.cleanupIncomplete).toBe(false);
});

it("keeps cancellation primary when ASAR close fails, then retries the same handle", async () => {
  const location = await asarPage();
  const controller = new AbortController();
  const reason = new Error("cancel during ASAR close");
  handleState.closeController = controller;
  handleState.closeReason = reason;
  handleState.failCloseCount = 1;

  let failure: unknown;
  try {
    await authorizedElectronFile(
      location,
      controller.signal,
      "inspect_electron_page",
    );
  } catch (cause: unknown) {
    failure = cause;
  }
  expect(failure).toBeInstanceOf(ArtifactReaderFailure);
  const mapped = mapElectronFileAuthorizationFailure(
    failure,
    "rea-cdp-electron",
    "inspect_electron_page",
  );
  expect(mapped?.cleanupIncomplete).toBe(true);
  expect(mapped?.cleanupPrimary).toBeInstanceOf(AnalysisCancelledError);
  expect(mapped?.cleanupPrimary?.cause).toBe(reason);

  await expect(authorizedElectronFile(location)).resolves.toBe(
    `${handleState.archive}/index.html`,
  );
  expect(handleState.events).toEqual([
    "open",
    "close",
    "close",
    "open",
    "close",
  ]);
  expect(mapped?.cleanupIncomplete).toBe(false);
});

it("keeps an earlier read failure primary over a later abort and close failure", async () => {
  const location = await asarPage();
  const controller = new AbortController();
  const reason = new Error("late cancellation after read failure");
  const readFailure = new Error("controlled ASAR header read failure");
  handleState.closeController = controller;
  handleState.closeReason = reason;
  handleState.failCloseCount = 1;
  handleState.readFailure = readFailure;

  let failure: unknown;
  try {
    await authorizedElectronFile(location, controller.signal);
  } catch (cause: unknown) {
    failure = cause;
  }
  const mapped = mapElectronFileAuthorizationFailure(
    failure,
    "rea-cdp-electron",
    "inspect_electron_page",
  );
  expect(mapped?.cleanupIncomplete).toBe(true);
  expect(mapped?.cleanupPrimary).not.toBeInstanceOf(AnalysisCancelledError);
  expect(mapped?.cleanupPrimary?.cause).toBe(readFailure);

  await expect(authorizedElectronFile(location)).resolves.toBe(
    `${handleState.archive}/index.html`,
  );
  expect(mapped?.cleanupIncomplete).toBe(false);
});

it("preserves an arbitrary cancellation reason observed during ASAR read", async () => {
  const location = await asarPage();
  const controller = new AbortController();
  const reason = { source: "caller", token: 17 };
  handleState.readController = controller;
  handleState.readReason = reason;
  handleState.failCloseCount = 1;

  let failure: unknown;
  try {
    await authorizedElectronFile(location, controller.signal);
  } catch (cause: unknown) {
    failure = cause;
  }
  const mapped = mapElectronFileAuthorizationFailure(
    failure,
    "rea-cdp-electron",
    "inspect_electron_page",
  );
  expect(mapped?.cleanupIncomplete).toBe(true);
  expect(mapped?.cleanupPrimary).toBeInstanceOf(AnalysisCancelledError);
  expect(mapped?.cleanupPrimary?.cause).toBe(reason);

  await expect(authorizedElectronFile(location)).resolves.toBe(
    `${handleState.archive}/index.html`,
  );
  expect(mapped?.cleanupIncomplete).toBe(false);
});

it("preserves cancellation observed after ASAR stat when final close fails", async () => {
  const location = await asarPage();
  const controller = new AbortController();
  const reason = { source: "caller", stage: "descriptor-stat" };
  handleState.statController = controller;
  handleState.statReason = reason;
  handleState.failCloseCount = 1;

  let failure: unknown;
  try {
    await authorizedElectronFile(location, controller.signal);
  } catch (cause: unknown) {
    failure = cause;
  }
  const mapped = mapElectronFileAuthorizationFailure(
    failure,
    "rea-cdp-electron",
    "inspect_electron_page",
  );
  expect(mapped?.cleanupIncomplete).toBe(true);
  expect(mapped?.cleanupPrimary).toBeInstanceOf(AnalysisCancelledError);
  expect(mapped?.cleanupPrimary?.cause).toBe(reason);

  await expect(authorizedElectronFile(location)).resolves.toBe(
    `${handleState.archive}/index.html`,
  );
  expect(mapped?.cleanupIncomplete).toBe(false);
});

it("retries a failed ASAR descriptor lease during provider shutdown", async () => {
  const location = await asarPage();
  handleState.failCloseCount = 1;
  await expect(authorizedElectronFile(location)).rejects.toBeInstanceOf(
    ArtifactReaderFailure,
  );

  await new CdpElectronProvider().close();

  expect(handleState.events).toEqual(["open", "close", "close"]);
});
