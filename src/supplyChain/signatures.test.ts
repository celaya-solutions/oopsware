import { execFile } from "node:child_process";
import { generateKeyPairSync, sign, X509Certificate } from "node:crypto";
import {
  access,
  copyFile,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../artifacts/zipMemberView.js";
import {
  signatureReportSchema,
  verifyArtifactSignatureInputSchema,
  type SignatureReport,
} from "../domain/supplyChain/signatures.js";
import { recordDigest } from "../python/wheel.js";
import { verifyArtifactSignature } from "./signatures.js";

const exec = promisify(execFile);
const OPENSSL = "/opt/homebrew/opt/openssl@3/bin/openssl";
const JARSIGNER = "/opt/homebrew/opt/openjdk@17/bin/jarsigner";
const OSSL = "/opt/homebrew/bin/osslsigncode";
const PE =
  "/opt/homebrew/opt/python@3.14/lib/python3.14/site-packages/pip/_vendor/distlib/t64.exe";
const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );
const available = await Promise.all([
  exists(OPENSSL),
  exists(JARSIGNER),
  exists(OSSL),
  exists(PE),
]);
let root: string;
let cert: string;
let key: string;
let fingerprint: string;
const pair = generateKeyPairSync("ed25519");

const zip = async (
  path: string,
  entries: Record<string, Uint8Array | string>,
) => {
  const writer = new ZipWriter(new Uint8ArrayWriter(), {
    useWebWorkers: false,
  });
  for (const [name, bytes] of Object.entries(entries))
    await writer.add(
      name,
      new Uint8ArrayReader(
        typeof bytes === "string" ? Buffer.from(bytes) : bytes,
      ),
    );
  await writeFile(path, await writer.close());
};
const report = async (
  input: Record<string, unknown>,
): Promise<SignatureReport> => {
  const result = await verifyArtifactSignature(
    verifyArtifactSignatureInputSchema.parse(input),
  );
  if (!result.ok) throw result.error;
  return signatureReportSchema.parse(result.value);
};
beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "rea-signature-test-")));
  cert = join(root, "signer.pem");
  key = join(root, "signer-key.pem");
  await writeFile(
    join(root, "public.pem"),
    pair.publicKey.export({ format: "pem", type: "spki" }),
  );
  if (!available[0]) return;
  await exec(
    OPENSSL,
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=Oopsware Offline Test",
      "-addext",
      "extendedKeyUsage=codeSigning",
      "-addext",
      "keyUsage=critical,digitalSignature",
      "-addext",
      "basicConstraints=critical,CA:FALSE",
    ],
    { env: {}, cwd: root },
  );
  fingerprint = sha256Hex(new X509Certificate(await readFile(cert)).raw);
  await exec(
    OPENSSL,
    [
      "pkcs12",
      "-export",
      "-in",
      cert,
      "-inkey",
      key,
      "-out",
      join(root, "signer.p12"),
      "-name",
      "signer",
      "-passout",
      "pass:offline",
    ],
    { env: {}, cwd: root },
  );
}, 30_000);
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

const wheel = async (
  name: string,
  mode: "signed" | "tampered" | "unsigned" | "unlisted" | "cms",
) => {
  const recordPath = "example-1.dist-info/RECORD";
  const content = Buffer.from("x = 1\n");
  const record = Buffer.from(
    `example.py,sha256=${recordDigest("sha256", content)},${String(content.length)}\n${recordPath},,\n`,
  );
  const entries: Record<string, Uint8Array | string> = {
    "example.py": mode === "tampered" ? "x = 2\n" : content,
    [recordPath]: record,
  };
  if (mode !== "unsigned" && mode !== "cms") {
    const protectedHeader = Buffer.from(
      JSON.stringify({ alg: "EdDSA" }),
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ hash: `sha256=${recordDigest("sha256", record)}` }),
    ).toString("base64url");
    entries[`${recordPath}.jws`] = JSON.stringify({
      payload,
      signatures: [
        {
          protected: protectedHeader,
          signature: sign(
            null,
            Buffer.from(`${protectedHeader}.${payload}`),
            pair.privateKey,
          ).toString("base64url"),
        },
      ],
    });
  }
  if (mode === "unlisted") entries["extra.py"] = "not covered";
  if (mode === "cms") {
    await writeFile(join(root, "record"), record);
    await exec(
      OPENSSL,
      [
        "cms",
        "-sign",
        "-binary",
        "-in",
        join(root, "record"),
        "-signer",
        cert,
        "-inkey",
        key,
        "-outform",
        "DER",
        "-out",
        join(root, "record.p7s"),
      ],
      { env: {}, cwd: root },
    );
    entries[`${recordPath}.p7s`] = await readFile(join(root, "record.p7s"));
  }
  const path = join(root, `${name}.whl`);
  await zip(path, entries);
  return path;
};

describe("offline wheel signatures", () => {
  it("verifies the PEP 427 hash payload and distinguishes a wrong signer pin", async () => {
    const path = await wheel("valid", "signed");
    const result = await report({
      path,
      kind: "wheel",
      public_key: join(root, "public.pem"),
      expected_signer_sha256: sha256Hex(
        pair.publicKey.export({ type: "spki", format: "der" }),
      ),
    });
    expect(result.integrity.status).toBe("passed");
    expect(result.signer_identity.status).toBe("passed");
    const wrong = await report({
      path,
      kind: "wheel",
      public_key: join(root, "public.pem"),
      expected_signer_sha256: "0".repeat(64),
    });
    expect(wrong.integrity.status).toBe("passed");
    expect(wrong.signer_identity.status).toBe("failed");
  });
  it("binds trust to supplied key bytes and detects replacing a key at the same path", async () => {
    const path = await wheel("key-replacement", "signed");
    const publicKey = join(root, "replaceable-public.pem");
    const original = pair.publicKey.export({ format: "pem", type: "spki" });
    await writeFile(publicKey, original);
    const before = await report({ path, kind: "wheel", public_key: publicKey });
    expect(before.trust_material).toEqual([
      {
        kind: "public_key",
        path: publicKey,
        sha256: sha256Hex(Buffer.from(original)),
        bytes: Buffer.byteLength(original),
      },
    ]);
    const replaced = generateKeyPairSync("ed25519").publicKey.export({
      format: "pem",
      type: "spki",
    });
    await writeFile(publicKey, replaced);
    const after = await report({ path, kind: "wheel", public_key: publicKey });
    expect(before.integrity.status).toBe("passed");
    expect(after.integrity.status).toBe("failed");
    expect(after.trust_material[0]?.sha256).toBe(
      sha256Hex(Buffer.from(replaced)),
    );
    expect(after.trust_material[0]?.sha256).not.toBe(
      before.trust_material[0]?.sha256,
    );
    expect(after.artifact.sha256).toBe(before.artifact.sha256);
  });
  it("rejects changed or unlisted content and does not turn RECORD hashes into signatures", async () => {
    for (const mode of ["tampered", "unlisted"] as const)
      expect(
        (
          await report({
            path: await wheel(mode, mode),
            kind: "wheel",
            public_key: join(root, "public.pem"),
          })
        ).integrity.status,
      ).toBe("failed");
    expect(
      (
        await report({
          path: await wheel("unsigned", "unsigned"),
          kind: "wheel",
        })
      ).integrity.status,
    ).toBe("unsigned");
    expect(
      (await report({ path: await wheel("no-key", "signed"), kind: "wheel" }))
        .integrity.status,
    ).toBe("unavailable");
  });
  it.skipIf(!available[0])(
    "verifies real CMS over RECORD with separate caller certificate trust",
    async () => {
      const result = await report({
        path: await wheel("cms", "cms"),
        kind: "wheel",
        trusted_certificate: cert,
        expected_signer_sha256: fingerprint,
      });
      expect(result.integrity.status).toBe("passed");
      expect(result.trust.status).toBe("passed");
      expect(result.signer_identity.status).toBe("passed");
    },
  );
});

describe.skipIf(!available[0] || !available[1])(
  "real jarsigner verification",
  () => {
    const signedJar = async (name: string) => {
      const path = join(root, `${name}.jar`);
      await zip(path, { "payload.txt": "signed payload" });
      await exec(
        JARSIGNER,
        [
          "-keystore",
          join(root, "signer.p12"),
          "-storepass",
          "offline",
          path,
          "signer",
        ],
        { env: {}, cwd: root },
      );
      return path;
    };
    it("separates verified content, certificate identity, and caller trust", async () => {
      const path = await signedJar("valid");
      const result = await report({
        path,
        kind: "jar",
        trusted_certificate: cert,
        expected_signer_sha256: fingerprint,
      });
      expect(result, JSON.stringify(result)).toMatchObject({
        integrity: { status: "passed" },
        signer_identity: { status: "passed" },
        trust: { status: "passed" },
      });
      const untrusted = await report({ path, kind: "jar" });
      expect(untrusted.integrity.status).toBe("passed");
      expect(untrusted.trust.status).toBe("not_checked");
    }, 30_000);
    it("detects unsigned and changed signed payloads", async () => {
      const path = join(root, "unsigned.jar");
      await zip(path, { "payload.txt": "unsigned" });
      expect((await report({ path, kind: "jar" })).integrity.status).toBe(
        "unsigned",
      );
      const signed = await signedJar("tamper");
      const { ZipReader } = await import("@zip.js/zip.js");
      const reader = new ZipReader(
        new Uint8ArrayReader(await readFile(signed)),
      );
      const entries: Record<string, Uint8Array> = {};
      for (const entry of await reader.getEntries())
        if (!entry.directory)
          entries[entry.filename] = await entry.getData!(
            new Uint8ArrayWriter(),
          );
      await reader.close();
      entries["payload.txt"] = Buffer.from("changed payload");
      await zip(signed, entries);
      expect(
        (await report({ path: signed, kind: "jar" })).integrity.status,
      ).toBe("failed");
    }, 30_000);
    it("refuses whole-archive coverage when an unsigned member is appended", async () => {
      const path = await signedJar("partial");
      const { ZipReader } = await import("@zip.js/zip.js");
      const reader = new ZipReader(new Uint8ArrayReader(await readFile(path)));
      const entries: Record<string, Uint8Array> = {};
      for (const entry of await reader.getEntries())
        if (!entry.directory)
          entries[entry.filename] = await entry.getData!(
            new Uint8ArrayWriter(),
          );
      await reader.close();
      entries["unsigned.txt"] = Buffer.from("unprotected");
      await zip(path, entries);
      const result = await report({
        path,
        kind: "jar",
        trusted_certificate: cert,
      });
      expect(result.integrity.status).toBe("failed");
      expect(
        result.checks.find((check) => check.id === "jar_signature")?.status,
      ).toBe("passed");
      expect(
        result.checks.find((check) => check.id === "all_members_signed")
          ?.status,
      ).toBe("failed");
      expect(result.unsigned_members).toBeNull();
      expect(result.trust.status).toBe("passed");
    }, 30_000);
  },
);

describe.skipIf(process.platform !== "darwin")(
  "real Apple code signatures",
  () => {
    it("checks an ad-hoc signed Mach-O without claiming developer trust", async () => {
      const path = join(root, "apple");
      await copyFile("/usr/bin/true", path);
      await exec("/usr/bin/codesign", ["--force", "--sign", "-", path], {
        env: {},
      });
      expect((await report({ path, kind: "apple" })).integrity.status).toBe(
        "passed",
      );
      const bytes = await readFile(path);
      bytes[2048] = (bytes[2048] ?? 0) ^ 1;
      await writeFile(path, bytes);
      expect((await report({ path, kind: "apple" })).integrity.status).toBe(
        "failed",
      );
    }, 30_000);
  },
);

describe.skipIf(!available.every(Boolean))(
  "real Authenticode verification",
  () => {
    it("checks a locally signed PE and rejects changed code", async () => {
      const path = join(root, "signed.exe");
      await exec(
        OSSL,
        ["sign", "-certs", cert, "-key", key, "-in", PE, "-out", path],
        { env: {}, cwd: root },
      );
      const result = await report({
        path,
        kind: "authenticode",
        trusted_certificate: cert,
        expected_signer_sha256: fingerprint,
      });
      expect(result, JSON.stringify(result)).toMatchObject({
        integrity: { status: "passed" },
        signer_identity: { status: "passed" },
        trust: { status: "passed" },
      });
      const bytes = await readFile(path);
      bytes[1024] = (bytes[1024] ?? 0) ^ 1;
      await writeFile(path, bytes);
      expect(
        (
          await report({
            path,
            kind: "authenticode",
            trusted_certificate: cert,
          })
        ).integrity.status,
      ).toBe("failed");
    }, 30_000);
  },
);

it("refuses excessive accumulated unsigned member names instead of truncating a signature report", async () => {
  const path = join(root, "many-unlisted.whl");
  const entries: Record<string, string> = {
    "example-1.dist-info/RECORD": "example-1.dist-info/RECORD,,\n",
  };
  for (let index = 0; index < 1100; index += 1)
    entries[`${"x".repeat(1000)}-${String(index)}.py`] = "";
  await zip(path, entries);
  const result = await verifyArtifactSignature(
    verifyArtifactSignatureInputSchema.parse({ path, kind: "wheel" }),
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error._tag).toBe("AnalysisResourceConstraintError");
  expect(result.error.message).toContain("member diagnostics exceed 1 MiB");
  expect(result.error.partialObservation).toBeUndefined();
});

it("preserves pre-cancellation and rejects unused per-kind options", async () => {
  const signal = AbortSignal.abort("caller cancelled");
  const cancelled = await verifyArtifactSignature(
    verifyArtifactSignatureInputSchema.parse({
      path: join(root, "absent"),
      kind: "jar",
    }),
    { signal },
  );
  expect(cancelled.ok ? "success" : cancelled.error._tag).toBe(
    "AnalysisCancelledError",
  );
  const unused = await verifyArtifactSignature(
    verifyArtifactSignatureInputSchema.parse({
      path: join(root, "absent"),
      kind: "apple",
      public_key: "key.pem",
    }),
  );
  expect(unused.ok ? "success" : unused.error._tag).toBe("AnalysisInputError");
});
