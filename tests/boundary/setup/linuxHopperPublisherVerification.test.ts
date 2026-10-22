import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { promises as filesystem } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import {
  access,
  copyFile,
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { createMessage, generateKey, readPrivateKey, sign } from "openpgp";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LinuxHopperPublisher,
  linuxHopperReleaseCacheDirectory,
  retryLinuxHopperPublisherCleanup,
} from "../../../src/application/LinuxHopperPublisher.js";
import {
  HOPPER_LINUX_PRIMARY_FINGERPRINT,
  type LinuxHopperRelease,
} from "../../../src/application/HopperReleaseFeed.js";
import * as signatures from "../../../src/process/DetachedPgpSignature.js";
import { downloadHopperPackage } from "../../../src/application/HopperDownload.js";
import { PrivateRuntimeRoot } from "../../../src/process/PrivateRuntimeRoot.js";
import { OwnedFileHandle } from "../../../src/filesystem/OwnedFileHandle.js";
import * as leases from "../../../src/process/HopperLease.js";
import * as nativeCommands from "../../../src/process/ExecFileOutput.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { createTestProcessRegistry } from "../../support/process/processFixture.js";

const run = promisify(execFile);
const verifySignature = signatures.verifyDetachedPgpSignature;
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const linux = it.skipIf(process.platform !== "linux");
const portableTar = it.skipIf(process.platform === "win32");

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Real native archives and cryptography; substitute only the test publisher identity. */
const fixture = async (family: "deb" | "arch" = "deb") => {
  const directory = await createTestTempDirectory("rea-linux-publisher-");
  const packageRoot = join(directory, "package-root");
  const launcher = join(packageRoot, "opt/hopper/bin/Hopper");
  await mkdir(join(packageRoot, "opt/hopper/bin"), { recursive: true });
  await copyFile("/usr/bin/true", launcher);
  const archive = join(directory, "archive");
  if (family === "deb") {
    await mkdir(join(packageRoot, "DEBIAN"));
    await writeFile(
      join(packageRoot, "DEBIAN/control"),
      "Package: hopper-fixture\nVersion: 1.0\nArchitecture: amd64\nMaintainer: Fixture\nDescription: Signature boundary fixture\n",
    );
    await run("dpkg-deb", ["--build", packageRoot, archive]);
  } else await run("tar", ["-cJf", archive, "-C", packageRoot, "opt"]);
  const bytes = await readFile(archive);
  const generated = await generateKey({
    type: "ecc",
    curve: "curve25519Legacy",
    userIDs: [{ name: "Fixture publisher" }],
    format: "armored",
  });
  const key = await readPrivateKey({ armoredKey: generated.privateKey });
  const signature = await sign({
    message: await createMessage({ binary: bytes }),
    signingKeys: key,
    detached: true,
    format: "binary",
  });
  const release: LinuxHopperRelease = {
    version: "1.0",
    filename: `https://www.hopperapp.com:443/downloader/public/Hopper-1.0-Linux-demo.${family === "deb" ? "deb" : "pkg.tar.xz"}`,
    file_length: String(bytes.length),
    file_hash: createHash("sha1").update(bytes).digest("hex"),
    main_exe_hash: sha256(await readFile(launcher)),
    signature: Buffer.from(signature).toString("base64"),
    public: "1",
    beta: "0",
  };
  const publisher = new LinuxHopperPublisher(
    { ...process.env, XDG_CACHE_HOME: join(directory, "cache") },
    async () => family,
  );
  const cache = join(publisher.cacheRoot, release.main_exe_hash);
  return {
    publisher,
    archive,
    launcher,
    release,
    cache,
    publicKey: generated.publicKey,
    fingerprint: key.getFingerprint().toUpperCase(),
  };
};

const admitFixturePublisher = (
  fingerprint: string,
  module: typeof signatures = signatures,
) =>
  vi
    .spyOn(module, "verifyDetachedPgpSignature")
    .mockImplementation((bytes, signature, key, primary, signal) => {
      expect(primary).toBe(HOPPER_LINUX_PRIMARY_FINGERPRINT);
      return verifySignature(bytes, signature, key, fingerprint, signal);
    });

it.each([undefined, "", "/selected/cache", "relative/cache"])(
  "resolves the selected XDG cache setting %j once for every consumer",
  (setting) => {
    const selected = linuxHopperReleaseCacheDirectory({
      HOME: "/caller/home",
      ...(setting === undefined ? {} : { XDG_CACHE_HOME: setting }),
    });
    if (setting === "relative/cache")
      expect(selected).toMatchObject({ ok: false });
    else
      expect(selected).toEqual({
        ok: true,
        value: join(setting || "/caller/home/.cache", "rea/hopper-releases"),
      });
  },
);

describe("Linux signed package retention boundary", () => {
  linux(
    "rejects a cryptographically valid package signed by another publisher",
    async () => {
      const f = await fixture();
      try {
        expect(
          await f.publisher.verifyArchive(
            "deb",
            f.release,
            f.archive,
            undefined,
            f.publicKey,
          ),
        ).toMatchObject({
          ok: false,
          error: { reason: "publisher_verification_failed" },
        });
        await expect(access(f.publisher.cacheRoot)).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        await f.publisher.close();
      }
    },
  );

  linux.each(["deb", "arch"] as const)(
    "authenticates a real %s payload and verifies a retained install without network",
    async (family) => {
      const f = await fixture(family);
      admitFixturePublisher(f.fingerprint);
      const network = vi.fn(() => {
        throw new Error("Offline");
      });
      vi.stubGlobal("fetch", network);
      try {
        const verified = await f.publisher.verifyArchive(
          family,
          f.release,
          f.archive,
          undefined,
          f.publicKey,
        );
        if (!verified.ok) throw verified.error;
        expect(
          await f.publisher.retainVerifiedArchive(verified.value, f.archive),
        ).toEqual({ ok: true, value: undefined });
        await f.publisher.close();
        // A new instance alone still shares process-local cryptographic proofs.
        // Reload the owner and assert actual PGP and native payload inspection.
        vi.resetModules();
        const coldSignatures =
          await import("../../../src/process/DetachedPgpSignature.js");
        const signature = admitFixturePublisher(f.fingerprint, coldSignatures);
        const coldCommands =
          await import("../../../src/process/ExecFileOutput.js");
        const extraction = vi.spyOn(coldCommands, "execFileOutput");
        const { LinuxHopperPublisher: ColdPublisher } =
          await import("../../../src/application/LinuxHopperPublisher.js");
        const fresh = new ColdPublisher(
          f.publisher.environment,
          async () => family,
        );
        try {
          expect(await fresh.inspectLauncher(f.launcher)).toMatchObject({
            ok: true,
            value: {
              sha256: f.release.main_exe_hash,
              primaryFingerprint: f.fingerprint,
              source: "signed_package_cache",
            },
          });
          expect(network).not.toHaveBeenCalled();
          expect(signature).toHaveBeenCalledOnce();
          expect(extraction).toHaveBeenCalledWith(
            family === "deb" ? "dpkg-deb" : "tar",
            expect.any(Array),
            expect.any(Object),
          );
        } finally {
          await fresh.close();
        }
      } finally {
        await f.publisher.close();
      }
    },
  );
});

linux.each([
  "archive",
  "metadata",
  "missing metadata",
  "missing key",
  "malformed key",
  "missing archive",
  "malformed JSON",
  "empty directory",
  "symlink archive",
])("fails closed on retained %s tampering", async (kind) => {
  const f = await fixture();
  admitFixturePublisher(f.fingerprint);
  try {
    const verified = await f.publisher.verifyArchive(
      "deb",
      f.release,
      f.archive,
      undefined,
      f.publicKey,
    );
    if (!verified.ok) throw verified.error;
    const retained = await f.publisher.retainVerifiedArchive(
      verified.value,
      f.archive,
    );
    if (!retained.ok) throw retained.error;
    if (kind === "archive") {
      const tampered = Buffer.from("tampered");
      await writeFile(join(f.cache, "archive"), tampered);
      const metadata = JSON.parse(
        await readFile(join(f.cache, "release.json"), "utf8"),
      );
      metadata.release.file_length = String(tampered.length);
      metadata.release.file_hash = createHash("sha1")
        .update(tampered)
        .digest("hex");
      await writeFile(join(f.cache, "release.json"), JSON.stringify(metadata));
    }
    if (kind === "metadata") {
      const metadata = JSON.parse(
        await readFile(join(f.cache, "release.json"), "utf8"),
      );
      metadata.release.main_exe_hash = "a".repeat(64);
      await writeFile(join(f.cache, "release.json"), JSON.stringify(metadata));
    }
    if (kind === "missing metadata") await rm(join(f.cache, "release.json"));
    if (kind === "missing key") await rm(join(f.cache, "public-key.asc"));
    if (kind === "malformed key")
      await writeFile(join(f.cache, "public-key.asc"), Buffer.from([0xff]));
    if (kind === "missing archive") await rm(join(f.cache, "archive"));
    if (kind === "malformed JSON")
      await writeFile(join(f.cache, "release.json"), "{broken JSON");
    if (kind === "empty directory")
      await Promise.all(
        ["release.json", "public-key.asc", "archive"].map((name) =>
          rm(join(f.cache, name)),
        ),
      );
    if (kind === "symlink archive") {
      await rm(join(f.cache, "archive"));
      await symlink(f.archive, join(f.cache, "archive"));
    }
    const network = vi.fn(() => {
      throw new Error("Must preserve the cache failure");
    });
    vi.stubGlobal("fetch", network);
    expect(await f.publisher.inspectLauncher(f.launcher)).toMatchObject({
      ok: false,
    });
    expect(network).not.toHaveBeenCalled();
    // An explicitly approved fresh package can repair this entry while
    // preserving the original evidence and keeping ordinary reads strict.
    expect(
      await f.publisher.retainVerifiedArchive(verified.value, f.archive),
    ).toEqual({ ok: true, value: undefined });
    const backups = (await readdir(f.publisher.cacheRoot)).filter((name) =>
      name.startsWith(`${f.release.main_exe_hash}.backup-`),
    );
    expect(backups).toHaveLength(1);
    if (kind === "missing metadata" || kind === "empty directory")
      await expect(
        access(join(f.publisher.cacheRoot, backups[0]!, "release.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    else
      expect(
        await readFile(
          join(f.publisher.cacheRoot, backups[0]!, "release.json"),
          "utf8",
        ),
      ).toBeTruthy();
    expect(await f.publisher.inspectLauncher(f.launcher)).toMatchObject({
      ok: true,
    });
    expect(
      await f.publisher.retainVerifiedArchive(verified.value, f.archive),
    ).toEqual({ ok: true, value: undefined });
    expect(
      (await readdir(f.publisher.cacheRoot)).filter((name) =>
        name.includes(".backup-"),
      ),
    ).toEqual(backups);
    expect(network).not.toHaveBeenCalled();
  } finally {
    await f.publisher.close();
  }
});

linux.each([false, true])(
  "serializes real cross-process repair and cancellation: %s",
  async (cancel) => {
    const f = await fixture();
    admitFixturePublisher(f.fingerprint);
    const processes = createTestProcessRegistry();
    const controller = new AbortController();
    let retention:
      | ReturnType<LinuxHopperPublisher["retainVerifiedArchive"]>
      | undefined;
    try {
      const verified = await f.publisher.verifyArchive(
        "deb",
        f.release,
        f.archive,
        undefined,
        f.publicKey,
      );
      if (!verified.ok) throw verified.error;
      expect(
        await f.publisher.retainVerifiedArchive(verified.value, f.archive),
      ).toEqual({ ok: true, value: undefined });
      const staged = join(f.publisher.cacheRoot, "authenticated-fixture-stage");
      await cp(f.cache, staged, { recursive: true });
      const broken = "{interrupted cache record";
      await writeFile(join(f.cache, "release.json"), broken);
      const child = processes.spawn(process.execPath, [
        fileURLToPath(
          new URL("../../fixtures/hopperCachePublisher.mjs", import.meta.url),
        ),
        f.publisher.cacheRoot,
        f.release.main_exe_hash,
        staged,
      ]);
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const exited = once(child, "close");
      const ready = await Promise.race([
        once(child.stdout, "data").then(([bytes]) => {
          if (!Buffer.isBuffer(bytes))
            throw new Error("Expected fixture readiness bytes");
          return JSON.parse(bytes.toString());
        }),
        exited.then(([code]) => {
          throw new Error(
            `Fixture exited before acquiring its lease: ${String(code)} ${stderr}`,
          );
        }),
      ]);
      expect(ready).toEqual({ held: true });
      let notifyBusy: (() => void) | undefined;
      const busy = new Promise<void>((resolve) => {
        notifyBusy = resolve;
      });
      const acquire = leases.acquireHopperReleaseCacheLease;
      vi.spyOn(leases, "acquireHopperReleaseCacheLease").mockImplementation(
        async (input) => {
          const observed = await acquire(input);
          if (!observed.acquired) notifyBusy?.();
          return observed;
        },
      );
      retention = f.publisher.retainVerifiedArchive(
        verified.value,
        f.archive,
        controller.signal,
      );
      await Promise.race([
        busy,
        retention.then(() => {
          throw new Error("Retention bypassed the other process's cache lease");
        }),
      ]);
      expect(await readFile(join(f.cache, "release.json"), "utf8")).toBe(
        broken,
      );
      expect(
        (await readdir(f.publisher.cacheRoot)).some((name) =>
          name.includes(".backup-"),
        ),
      ).toBe(false);
      if (cancel) {
        controller.abort();
        expect(await retention).toMatchObject({
          ok: false,
          error: { reason: "cancelled" },
        });
        child.stdin.end("release\n");
      } else {
        child.stdin.end("publish\n");
        expect(await retention).toEqual({ ok: true, value: undefined });
        expect(await f.publisher.inspectLauncher(f.launcher)).toMatchObject({
          ok: true,
        });
        expect(
          (await readdir(f.publisher.cacheRoot)).filter((name) =>
            name.includes(".backup-"),
          ),
        ).toHaveLength(1);
      }
      expect(await exited).toEqual([0, null]);
    } finally {
      controller.abort();
      await processes.shutdown();
      await retention;
      await f.publisher.close();
    }
  },
);

linux("restores old evidence when replacement publication fails", async () => {
  const f = await fixture();
  admitFixturePublisher(f.fingerprint);
  try {
    const verified = await f.publisher.verifyArchive(
      "deb",
      f.release,
      f.archive,
      undefined,
      f.publicKey,
    );
    if (!verified.ok) throw verified.error;
    expect(
      await f.publisher.retainVerifiedArchive(verified.value, f.archive),
    ).toEqual({ ok: true, value: undefined });
    const broken = "{interrupted cache metadata";
    await writeFile(join(f.cache, "release.json"), broken);
    const rename = filesystem.rename;
    const denied = Object.assign(new Error("Fixture publication failure"), {
      code: "EIO",
    });
    let backup: string | undefined;
    const publication = vi
      .spyOn(filesystem, "rename")
      .mockImplementation(async (from, to) => {
        if (backup !== undefined && to === f.cache && from !== backup)
          throw denied;
        await rename(from, to);
        if (from === f.cache && typeof to === "string") backup = to;
      });
    syncBuiltinESMExports();
    try {
      const result = await f.publisher.retainVerifiedArchive(
        verified.value,
        f.archive,
      );
      expect(result).toMatchObject({
        ok: false,
        error: {
          reason: "verification_unavailable",
          message: expect.stringContaining(f.cache),
        },
      });
      if (result.ok) throw new Error("Expected publication failure");
      expect(result.error.cause).toBeInstanceOf(AggregateError);
      if (result.error.cause instanceof AggregateError)
        expect(result.error.cause.errors).toContain(denied);
      expect(await readFile(join(f.cache, "release.json"), "utf8")).toBe(
        broken,
      );
      expect(
        (await readdir(f.publisher.cacheRoot)).some((name) =>
          name.includes(".backup-"),
        ),
      ).toBe(false);
    } finally {
      publication.mockRestore();
      syncBuiltinESMExports();
    }
    expect(
      await f.publisher.retainVerifiedArchive(verified.value, f.archive),
    ).toEqual({ ok: true, value: undefined });
    expect(await f.publisher.inspectLauncher(f.launcher)).toMatchObject({
      ok: true,
    });
  } finally {
    await f.publisher.close();
  }
});

linux(
  "preserves existing evidence when native cache inspection is unavailable",
  async () => {
    const f = await fixture();
    admitFixturePublisher(f.fingerprint);
    try {
      const verified = await f.publisher.verifyArchive(
        "deb",
        f.release,
        f.archive,
        undefined,
        f.publicKey,
      );
      if (!verified.ok) throw verified.error;
      expect(
        await f.publisher.retainVerifiedArchive(verified.value, f.archive),
      ).toEqual({ ok: true, value: undefined });
      await writeFile(join(f.cache, "public-key.asc"), f.publicKey + "\n");
      const metadata = await readFile(join(f.cache, "release.json"));
      const unavailable = vi
        .spyOn(nativeCommands, "execFileOutput")
        .mockRejectedValue(new Error("Fixture native inspection unavailable"));
      expect(
        await f.publisher.retainVerifiedArchive(verified.value, f.archive),
      ).toMatchObject({
        ok: false,
        error: { reason: "verification_unavailable" },
      });
      expect(await readFile(join(f.cache, "release.json"))).toEqual(metadata);
      expect(
        (await readdir(f.publisher.cacheRoot)).some((name) =>
          name.includes(".backup-"),
        ),
      ).toBe(false);
      unavailable.mockRestore();
      expect(await f.publisher.inspectLauncher(f.launcher)).toMatchObject({
        ok: true,
      });
    } finally {
      await f.publisher.close();
    }
  },
);

linux(
  "rejects a feed digest not represented in the signed payload",
  async () => {
    const f = await fixture();
    admitFixturePublisher(f.fingerprint);
    try {
      expect(
        await f.publisher.verifyArchive(
          "deb",
          { ...f.release, main_exe_hash: "a".repeat(64) },
          f.archive,
          undefined,
          f.publicKey,
        ),
      ).toMatchObject({
        ok: false,
        error: {
          reason: "integrity",
          message: expect.stringContaining(f.release.main_exe_hash),
        },
      });
      expect(
        await f.publisher.verifyArchive(
          "deb",
          f.release,
          f.archive,
          AbortSignal.abort(),
          f.publicKey,
        ),
      ).toMatchObject({ ok: false, error: { reason: "cancelled" } });
    } finally {
      await f.publisher.close();
    }
  },
);

linux(
  "retains a failed publication lease until its real socket owner closes",
  async () => {
    const f = await fixture();
    admitFixturePublisher(f.fingerprint);
    const acquire = leases.acquireHopperReleaseCacheLease;
    let allowCleanup = false;
    vi.spyOn(leases, "acquireHopperReleaseCacheLease").mockImplementation(
      async (input) => {
        const acquired = await acquire(input);
        if (!acquired.acquired) return acquired;
        return {
          acquired: true as const,
          lease: {
            ...acquired.lease,
            release: async () => {
              if (!allowCleanup)
                throw new Error("Fixture lease close unavailable");
              await acquired.lease.release();
            },
          },
        };
      },
    );
    try {
      const verified = await f.publisher.verifyArchive(
        "deb",
        f.release,
        f.archive,
        undefined,
        f.publicKey,
      );
      if (!verified.ok) throw verified.error;
      expect(
        await f.publisher.retainVerifiedArchive(verified.value, f.archive),
      ).toMatchObject({ ok: false, error: { reason: "cleanup_failed" } });
      const input = {
        cacheDirectory: f.publisher.cacheRoot,
        launcherSha256: f.release.main_exe_hash,
        runId: "fixture-competing-writer",
      };
      expect(await acquire(input)).toMatchObject({ acquired: false });
      await expect(f.publisher.close()).rejects.toMatchObject({
        cleanup: { resources: [expect.stringContaining(".sock")] },
      });
      allowCleanup = true;
      await f.publisher.close();
      const recovered = await acquire(input);
      if (!recovered.acquired)
        throw new Error("Expected the released real cache lease");
      await recovered.lease.release();
    } finally {
      allowCleanup = true;
      await f.publisher.close();
    }
  },
);

it("bounds a stalled metadata fetch and preserves caller cancellation", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url, options: RequestInit) =>
        new Promise((_resolve, reject) => {
          const signal = options.signal;
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
          signal?.throwIfAborted();
        }),
    ),
  );
  await expect(
    downloadHopperPackage("https://www.hopperapp.com/fixture", {
      timeoutMs: 10,
    }),
  ).rejects.toMatchObject({ name: "TimeoutError" });
  const controller = new AbortController();
  const reason = new Error("Caller cancelled metadata inspection");
  const pending = downloadHopperPackage("https://www.hopperapp.com/fixture", {
    signal: controller.signal,
  });
  controller.abort(reason);
  await expect(pending).rejects.toBe(reason);
});
it("cancels an oversized chunked metadata response before retaining it", async () => {
  const cancelled = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(4));
            },
            cancel: cancelled,
          }),
        ),
    ),
  );
  expect(
    await downloadHopperPackage("https://www.hopperapp.com/fixture", {
      maxBytes: 3,
    }),
  ).toEqual({ ok: false, bytes: new Uint8Array() });
  expect(cancelled).toHaveBeenCalledOnce();
});

portableTar(
  "retains the temporary root until its failed hash descriptor closes",
  async () => {
    const f = await fixture("arch");
    admitFixturePublisher(f.fingerprint);
    const events: string[] = [];
    let targetCloseAttempts = 0;
    let failTargetClose = true;
    const targetSize = (await stat(f.launcher)).size;
    let temporaryRoot: string | undefined;
    const originalFileClose = OwnedFileHandle.prototype.close;
    const fileClose = vi
      .spyOn(OwnedFileHandle.prototype, "close")
      .mockImplementation(async function (this: OwnedFileHandle) {
        if ((await this.handle.stat()).size === targetSize) {
          targetCloseAttempts += 1;
          if (failTargetClose) {
            events.push(`hash-close-failed-${targetCloseAttempts}`);
            throw new Error("Fixture extracted launcher close unavailable");
          }
          events.push("hash-close-retried");
        }
        return originalFileClose.call(this);
      });
    const originalRootClose = PrivateRuntimeRoot.prototype.close;
    const originalRootCreate = PrivateRuntimeRoot.create;
    const rootCreate = vi
      .spyOn(PrivateRuntimeRoot, "create")
      .mockImplementation(async (options) => {
        const root = await originalRootCreate.call(PrivateRuntimeRoot, options);
        temporaryRoot = root.path;
        return root;
      });
    const rootClose = vi
      .spyOn(PrivateRuntimeRoot.prototype, "close")
      .mockImplementation(async function (this: PrivateRuntimeRoot) {
        temporaryRoot = this.path;
        events.push("temporary-root-close");
        return originalRootClose.call(this);
      });
    try {
      expect(
        await f.publisher.verifyArchive(
          "arch",
          f.release,
          f.archive,
          undefined,
          f.publicKey,
        ),
      ).toMatchObject({ ok: false, error: { reason: "cleanup_failed" } });
      expect(targetCloseAttempts).toBeGreaterThanOrEqual(2);
      expect(events).not.toContain("temporary-root-close");
      const attemptsBeforeClose = targetCloseAttempts;
      await expect(f.publisher.close()).rejects.toThrow();
      expect(targetCloseAttempts).toBeGreaterThan(attemptsBeforeClose);
      expect(events).not.toContain("temporary-root-close");
      expect(temporaryRoot).toBeDefined();
      await expect(access(temporaryRoot!)).resolves.toBeUndefined();
      failTargetClose = false;
      await f.publisher.close();
      expect(events.slice(-2)).toEqual([
        "hash-close-retried",
        "temporary-root-close",
      ]);
    } finally {
      fileClose.mockRestore();
      rootClose.mockRestore();
      rootCreate.mockRestore();
      await f.publisher.close();
    }
  },
);

linux("retains and retries failed verification cleanup", async () => {
  const f = await fixture();
  admitFixturePublisher(f.fingerprint);
  const cleanup = vi
    .spyOn(PrivateRuntimeRoot.prototype, "close")
    .mockRejectedValueOnce(new Error("Fixture cleanup unavailable"));
  try {
    expect(
      await f.publisher.verifyArchive(
        "deb",
        f.release,
        f.archive,
        undefined,
        f.publicKey,
      ),
    ).toMatchObject({ ok: false, error: { reason: "cleanup_failed" } });
    expect(cleanup).toHaveBeenCalledOnce();
    await f.publisher.close();
    expect(cleanup).toHaveBeenCalledTimes(2);
  } finally {
    await f.publisher.close();
  }
});

portableTar(
  "reports pending publisher cleanup as a typed failure before retrying the operation",
  async () => {
    const f = await fixture("arch");
    admitFixturePublisher(f.fingerprint);
    const closeRoot = PrivateRuntimeRoot.prototype.close;
    let rootCloseAttempts = 0;
    vi.spyOn(PrivateRuntimeRoot.prototype, "close").mockImplementation(
      async function (this: PrivateRuntimeRoot) {
        rootCloseAttempts += 1;
        if (rootCloseAttempts < 3)
          throw new Error("Fixture cleanup remains unavailable");
        return await closeRoot.apply(this);
      },
    );
    try {
      expect(
        await f.publisher.verifyArchive(
          "arch",
          f.release,
          f.archive,
          undefined,
          f.publicKey,
        ),
      ).toMatchObject({ ok: false, error: { reason: "cleanup_failed" } });

      const closeHandle = vi.spyOn(OwnedFileHandle.prototype, "close");
      expect(await f.publisher.inspectLauncher(f.launcher)).toMatchObject({
        ok: false,
        error: { reason: "cleanup_failed" },
      });
      expect(closeHandle).not.toHaveBeenCalled();

      expect(
        await f.publisher.verifyArchive(
          "arch",
          f.release,
          f.archive,
          undefined,
          f.publicKey,
        ),
      ).toMatchObject({ ok: true });
      expect(closeHandle).toHaveBeenCalled();
      expect(rootCloseAttempts).toBe(4);
    } finally {
      await f.publisher.close();
    }
  },
);

it("retries a launcher hash descriptor after a transient close failure", async () => {
  const launcher = join(
    await createTestTempDirectory("rea-linux-publisher-hash-"),
    "Hopper",
  );
  const bytes = Buffer.from("fixture launcher bytes");
  await writeFile(launcher, bytes);
  const publisher = new LinuxHopperPublisher({}, async () => undefined);
  const closeCause = new Error("Fixture hash descriptor close unavailable");
  const owners: OwnedFileHandle[] = [];
  const originalClose = OwnedFileHandle.prototype.close;
  const close = vi
    .spyOn(OwnedFileHandle.prototype, "close")
    .mockImplementation(async function (this: OwnedFileHandle) {
      owners.push(this);
      if (owners.length === 1) throw closeCause;
      return originalClose.call(this);
    });
  try {
    await expect(publisher.hashLauncher(launcher)).resolves.toBe(sha256(bytes));
    expect(close).toHaveBeenCalledTimes(2);
    expect(owners).toHaveLength(2);
    expect(owners[1]).toBe(owners[0]);
    expect(owners[0]?.handle.fd).toBe(-1);
    await publisher.close();
    expect(close).toHaveBeenCalledTimes(2);
  } finally {
    close.mockRestore();
    await publisher.close();
  }
});

portableTar(
  "lets overlapping verification and descriptor cleanup settle without re-entering publisher admission",
  async () => {
    const f = await fixture("arch");
    admitFixturePublisher(f.fingerprint);
    const verified = await f.publisher.verifyArchive(
      "arch",
      f.release,
      f.archive,
      undefined,
      f.publicKey,
    );
    if (!verified.ok) throw verified.error;
    expect(
      await f.publisher.retainVerifiedArchive(verified.value, f.archive),
    ).toMatchObject({ ok: true });

    let reachedMetadataClose!: () => void;
    const metadataCloseStarted = new Promise<void>((resolve) => {
      reachedMetadataClose = resolve;
    });
    let releaseMetadataClose!: () => void;
    const metadataCloseGate = new Promise<void>((resolve) => {
      releaseMetadataClose = resolve;
    });
    const originalClose = OwnedFileHandle.prototype.close;
    const close = vi
      .spyOn(OwnedFileHandle.prototype, "close")
      .mockImplementation(async function (this: OwnedFileHandle) {
        const attempt = close.mock.calls.length;
        if (attempt === 2) {
          reachedMetadataClose();
          await metadataCloseGate;
        }
        if (attempt === 3 || attempt === 4 || attempt === 5)
          throw new Error("Fixture descriptor close temporarily unavailable");
        return await originalClose.apply(this);
      });
    try {
      const inspection = f.publisher.inspectLauncher(f.launcher);
      await metadataCloseStarted;
      const hashFailure = await f.publisher.hashLauncher(f.launcher).then(
        () => undefined,
        (cause: unknown) => cause,
      );
      expect(hashFailure).toMatchObject({
        reason: "cleanup_failed",
        cause: expect.any(AggregateError),
      });
      const cleanupOutcomes = (hashFailure as Error & { cause: AggregateError })
        .cause.errors;
      expect(cleanupOutcomes).toHaveLength(2);
      expect(cleanupOutcomes[0]).toMatchObject({ reason: "cleanup_failed" });
      releaseMetadataClose();
      await expect(inspection).resolves.toMatchObject({
        ok: true,
        value: { source: "signed_package_cache" },
      });
      await expect(f.publisher.close()).resolves.toBeUndefined();
      expect(close).toHaveBeenCalledTimes(9);
    } finally {
      releaseMetadataClose();
      close.mockRestore();
      await f.publisher.close();
    }
  },
);

linux(
  "preserves cleanup ownership when verification is cancelled",
  async () => {
    const f = await fixture();
    admitFixturePublisher(f.fingerprint);
    const controller = new AbortController();
    const cleanup = vi
      .spyOn(PrivateRuntimeRoot.prototype, "close")
      .mockImplementation(async () => {
        controller.abort();
        throw new Error("Fixture cleanup unavailable after cancellation");
      });
    try {
      expect(
        await f.publisher.verifyArchive(
          "deb",
          f.release,
          f.archive,
          controller.signal,
          f.publicKey,
        ),
      ).toMatchObject({
        ok: false,
        error: { reason: "cleanup_failed" },
      });
      await expect(retryLinuxHopperPublisherCleanup()).rejects.toMatchObject({
        cleanup: {
          resources: [expect.stringContaining("rea-hopper-publisher-")],
        },
      });
    } finally {
      cleanup.mockRestore();
      await f.publisher.close();
      await retryLinuxHopperPublisherCleanup();
    }
  },
);
