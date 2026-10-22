import { join } from "node:path";
import { readStableArtifact } from "../artifacts/readStableArtifact.js";
import {
  check,
  command,
  tool,
  certificatesFromPem,
  certificateSigner,
  type SignatureContext,
} from "./signaturesTools.js";

export const verifyAuthenticode = async (context: SignatureContext) => {
  const ossl = await tool(context, "osslsigncode");
  if (ossl === null) return;
  const signature = join(context.scratch, "authenticode.der");
  const extracted = await command(context, ossl, [
    "extract-signature",
    "-in",
    context.target,
    "-out",
    signature,
  ]);
  if (extracted.code !== 0) {
    check(
      context,
      "authenticode_signature",
      /No signature found|No signature present/u.test(extracted.text)
        ? "unsigned"
        : "failed",
      extracted.text.trim(),
    );
    return;
  }
  const args = [
    "verify",
    "-ignore-cdp",
    "-ignore-crl",
    "-ignore-timestamp",
    "-in",
    context.target,
  ];
  if (context.certificate !== null) args.push("-CAfile", context.certificate);
  const verified = await command(context, ossl, args);
  const current = [
    ...verified.text.matchAll(
      /^Current message digest\s*:\s*([0-9A-Fa-f]+)/gmu,
    ),
  ].map((match) => match[1]?.toLowerCase());
  const calculated = [
    ...verified.text.matchAll(
      /^Calculated message digest\s*:\s*([0-9A-Fa-f]+)/gmu,
    ),
  ].map((match) => match[1]?.toLowerCase());
  const matches =
    current.length > 0 &&
    current.length === calculated.length &&
    current.every((digest, index) => digest === calculated[index]);
  check(
    context,
    "authenticode_file_digest",
    matches ? "passed" : "failed",
    matches
      ? "osslsigncode recomputed matching Authenticode digests for the selected artifact."
      : "The signed and recomputed Authenticode digests did not match or were unavailable.",
  );
  await authenticateSigner(context, ossl, signature);
  context.report.trust =
    context.certificate === null
      ? {
          status: "not_checked",
          reason: "No caller trust certificate was supplied.",
        }
      : {
          status: verified.code === 0 ? "passed" : "failed",
          reason:
            verified.code === 0
              ? "osslsigncode accepted the signature and caller-supplied certificate trust under its Authenticode policy."
              : verified.text.trim(),
        };
  context.report.timestamp = {
    status: "not_checked",
    present: null,
    reason:
      "Timestamp verification was explicitly disabled to keep verification offline.",
  };
  if (
    current.length > 1 ||
    [...verified.text.matchAll(/^Signature Index:/gmu)].length > 1
  )
    check(
      context,
      "authenticode_multiple_signatures",
      "unknown",
      "Multiple signatures were observed; individual nested-signature coverage is not established.",
    );
  context.report.limitations.push(
    "Authenticode excludes parts of the file by design; this is not a whole-file signature. Nested signatures and catalog signatures are not separately enumerated.",
  );
};

const authenticateSigner = async (
  context: SignatureContext,
  ossl: string,
  signature: string,
) => {
  const openssl = await tool(context, "openssl");
  if (openssl === null) return;
  const certificates = join(context.scratch, "authenticode-certificates.pem");
  const printed = await command(context, openssl, [
    "pkcs7",
    "-inform",
    "DER",
    "-in",
    signature,
    "-print_certs",
    "-out",
    certificates,
  ]);
  if (printed.code !== 0) {
    check(context, "authenticode_signature", "failed", printed.text.trim());
    return;
  }
  const raw = await readStableArtifact(certificates, 1024 ** 2, context.signal);
  const candidates = certificatesFromPem(raw.bytes.toString("utf8"));
  let authenticated = false;
  // Embedded certificates supply integrity-only anchors; only a verified leaf hash identifies a signer.
  if (candidates.length <= 32)
    for (const certificate of candidates) {
      const signer = certificateSigner(certificate);
      const crypto = await command(context, ossl, [
        "verify",
        "-ignore-cdp",
        "-ignore-crl",
        "-ignore-timestamp",
        "-CAfile",
        certificates,
        "-require-leaf-hash",
        `sha256:${signer.certificate_sha256!}`,
        "-in",
        context.target,
      ]);
      if (crypto.code === 0) {
        context.report.signers.push(signer);
        authenticated = true;
        break;
      }
    }
  check(
    context,
    "authenticode_signature",
    authenticated ? "passed" : "unknown",
    authenticated
      ? "osslsigncode verified the cryptographic signature using embedded certificates as integrity-only anchors and confirmed the signer leaf SHA-256."
      : "osslsigncode did not accept signature and certificate policy under embedded anchors (at most 32 candidates). Certificate validity or usage can prevent a separate cryptographic conclusion.",
  );
};
