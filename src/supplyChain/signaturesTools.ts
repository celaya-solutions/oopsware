import { randomUUID, X509Certificate } from "node:crypto";
import { access, realpath, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { readStableArtifact } from "../artifacts/readStableArtifact.js";
import { sha256Hex } from "../artifacts/zipMemberView.js";
import type {
  SignatureReport,
  VerifyArtifactSignatureInput,
} from "../domain/supplyChain/signatures.js";
import type { runOwnedCommand } from "../process/OwnedCommand.js";

const JAVA_ROOTS = [
  "/opt/homebrew/opt/openjdk",
  "/opt/homebrew/opt/openjdk@21",
  "/opt/homebrew/opt/openjdk@17",
  "/usr/local/opt/openjdk",
  "/usr/lib/jvm/default-java",
  "/usr/lib/jvm/java-21-openjdk-amd64",
  "/usr/lib/jvm/java-17-openjdk-amd64",
];
const PATHS: Readonly<Record<string, readonly string[]>> = {
  jarsigner: [
    ...JAVA_ROOTS.map((root) => `${root}/bin/jarsigner`),
    "/usr/bin/jarsigner",
  ],
  keytool: [
    ...JAVA_ROOTS.map((root) => `${root}/bin/keytool`),
    "/usr/bin/keytool",
  ],
  codesign: ["/usr/bin/codesign"],
  osslsigncode: [
    "/opt/homebrew/bin/osslsigncode",
    "/usr/local/bin/osslsigncode",
    "/usr/bin/osslsigncode",
  ],
  openssl: [
    "/opt/homebrew/opt/openssl@3/bin/openssl",
    "/usr/local/opt/openssl@3/bin/openssl",
    "/usr/bin/openssl",
  ],
};

export interface SignatureContext {
  input: VerifyArtifactSignatureInput;
  report: SignatureReport;
  scratch: string;
  target: string;
  bytes: Uint8Array;
  run: typeof runOwnedCommand;
  signal: AbortSignal | undefined;
  certificate: string | null;
  publicKey: string | null;
}

export const check = (
  context: SignatureContext,
  id: string,
  status: SignatureReport["integrity"]["status"],
  reason: string,
) => {
  context.report.checks.push({ id, status, reason });
};

export const tool = async (
  context: SignatureContext,
  name: string,
  required = true,
): Promise<string | null> => {
  for (const candidate of PATHS[name] ?? []) {
    context.signal?.throwIfAborted();
    let path: string;
    try {
      path = await realpath(candidate);
      await access(path, constants.X_OK);
    } catch {
      continue;
    }
    const snapshot = await readStableArtifact(
      path,
      256 * 1024 ** 2,
      context.signal,
    );
    if (!context.report.providers.some((provider) => provider.path === path))
      context.report.providers.push({
        name,
        path,
        sha256: snapshot.sha256,
        version: null,
      });
    return path;
  }
  if (required)
    check(
      context,
      name,
      "unavailable",
      `No owner-installed ${name} was found at the supported fixed paths.`,
    );
  return null;
};

export const command = async (
  context: SignatureContext,
  executable: string,
  args: string[],
) => {
  const result = await context.run(
    {
      command: executable,
      arguments: args,
      runId: randomUUID(),
      cwd: context.scratch,
      hostEnvironment: {},
    },
    {
      timeoutMs: context.input.timeout_ms,
      diagnosticBytes: 1024 ** 2,
      acceptNonZeroExit: true,
    },
    { signal: context.signal },
  );
  return {
    code: result.exitCode,
    text: `${result.stdout.text}\n${result.stderr.text}`.replaceAll(
      context.scratch,
      "<scratch>",
    ),
  };
};

export const certificateSigner = (
  certificate: X509Certificate,
): SignatureReport["signers"][number] => ({
  identity: certificate.subject,
  certificate_sha256: sha256Hex(certificate.raw),
  public_key_sha256: sha256Hex(
    certificate.publicKey.export({ type: "spki", format: "der" }),
  ),
});

export const certificatesFromPem = (text: string): X509Certificate[] =>
  [
    ...text.matchAll(
      /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu,
    ),
  ].map(([pem]) => new X509Certificate(pem));

export const verifyApple = async (context: SignatureContext) => {
  const codesign = await tool(context, "codesign");
  if (codesign === null) return;
  const details = await command(context, codesign, [
    "-d",
    "--verbose=4",
    "--extract-certificates",
    join(context.scratch, "signer-"),
    context.target,
  ]);
  const verified = await command(context, codesign, [
    "--verify",
    "--strict",
    "--all-architectures",
    "--verbose=2",
    context.target,
  ]);
  const unsigned = /code object is not signed at all/u.test(verified.text);
  check(
    context,
    "apple_code_signature",
    verified.code === 0 ? "passed" : unsigned ? "unsigned" : "failed",
    verified.code === 0
      ? "codesign verified the embedded code signature for every architecture."
      : verified.text.trim(),
  );
  if (details.code === 0) {
    try {
      const leaf = await readStableArtifact(
        join(context.scratch, "signer-0"),
        1024 ** 2,
        context.signal,
      );
      context.report.signers.push(
        certificateSigner(new X509Certificate(leaf.bytes)),
      );
    } catch (cause) {
      if (context.signal?.aborted) throw cause;
      context.report.limitations.push(
        "No certificate signer was extracted (ad-hoc signatures have no certificate identity).",
      );
    }
  }
  context.report.trust = {
    status: "not_checked",
    reason:
      "Code integrity does not establish Gatekeeper acceptance or a trusted developer identity.",
  };
  context.report.timestamp = {
    status: "unknown",
    present: /(?:^|\n)Timestamp=/u.test(details.text),
    reason:
      "Timestamp presence is observed only; timestamp authority trust was not verified.",
  };
  context.report.limitations.push(
    "Only the selected regular file is checked; application bundles and enclosing package resources are outside this check.",
  );
  context.report.limitations.push(
    "Apple code signatures cover the code-signing format's selected ranges, not every byte of the container.",
  );
};

export const verifyCms = async (
  context: SignatureContext,
  signature: string,
  content: string | null,
  label: string,
): Promise<boolean> => {
  const openssl = await tool(context, "openssl");
  if (openssl === null) return false;
  const args = [
    "cms",
    "-verify",
    "-binary",
    "-inform",
    "DER",
    "-in",
    signature,
    "-out",
    join(context.scratch, `${label}-content`),
    "-signer",
    join(context.scratch, `${label}-signers.pem`),
  ];
  if (content !== null) args.push("-content", content);
  const verified = await command(context, openssl, [...args, "-noverify"]);
  check(
    context,
    label,
    verified.code === 0 ? "passed" : "failed",
    verified.code === 0
      ? "OpenSSL verified the CMS cryptographic signature independently of certificate trust."
      : verified.text.trim(),
  );
  if (verified.code !== 0) return false;
  const signers = await readStableArtifact(
    join(context.scratch, `${label}-signers.pem`),
    1024 ** 2,
    context.signal,
  );
  context.report.signers.push(
    ...certificatesFromPem(signers.bytes.toString("utf8")).map(
      certificateSigner,
    ),
  );
  if (content !== null) {
    const [expected, actual] = await Promise.all([
      readStableArtifact(
        content,
        context.input.max_artifact_bytes,
        context.signal,
      ),
      readStableArtifact(
        join(context.scratch, `${label}-content`),
        context.input.max_artifact_bytes,
        context.signal,
      ),
    ]);
    check(
      context,
      `${label}_content`,
      expected.sha256 === actual.sha256 ? "passed" : "failed",
      "The verified CMS content must equal the selected RECORD bytes.",
    );
  }
  if (context.certificate !== null) {
    const trust = await command(context, openssl, [
      ...args,
      "-CAfile",
      context.certificate,
      "-no-CApath",
      "-no-CAstore",
      "-purpose",
      "any",
    ]);
    context.report.trust = {
      status: trust.code === 0 ? "passed" : "failed",
      reason:
        trust.code === 0
          ? "OpenSSL verified the certificate chain against caller-supplied trust material at the current time; no code-signing policy was asserted."
          : trust.text.trim(),
    };
  }
  return true;
};

export const stageMaterial = async (
  path: string | undefined,
  kind: "certificate" | "public_key",
  context: Pick<SignatureContext, "scratch" | "signal" | "report">,
): Promise<string | null> => {
  if (path === undefined) return null;
  const snapshot = await readStableArtifact(path, 1024 ** 2, context.signal);
  context.report.trust_material.push({
    kind,
    path,
    sha256: snapshot.sha256,
    bytes: snapshot.bytes.length,
  });
  const target = join(context.scratch, `${kind}.pem`);
  await writeFile(target, snapshot.bytes, { flag: "wx" });
  return target;
};
