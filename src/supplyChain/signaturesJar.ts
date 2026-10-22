import { join } from "node:path";
import {
  check,
  command,
  tool,
  certificatesFromPem,
  certificateSigner,
  type SignatureContext,
} from "./signaturesTools.js";

export const verifyJar = async (context: SignatureContext) => {
  const jarsigner = await tool(context, "jarsigner");
  if (jarsigner === null) return;
  const java = [
    "-J-Duser.language=en",
    "-J-Duser.country=US",
    `-J-Duser.home=${context.scratch}`,
    `-J-Djava.io.tmpdir=${context.scratch}`,
    "-J-Dcom.sun.security.enableAIAcaIssuers=false",
    "-J-Dcom.sun.security.enableCRLDP=false",
    "-J-Dcom.sun.net.ssl.checkRevocation=false",
  ];
  const args = [...java, "-verify", "-verbose", "-certs", "-strict"];
  const keytool = await tool(context, "keytool", false);
  if (keytool === null)
    context.report.limitations.push(
      "keytool is unavailable: signer certificates and caller-selected certificate trust could not be checked.",
    );
  if (context.certificate !== null && keytool !== null) {
    const store = join(context.scratch, "trust.p12");
    const imported = await command(context, keytool, [
      ...java,
      "-importcert",
      "-noprompt",
      "-alias",
      "caller",
      "-file",
      context.certificate,
      "-keystore",
      store,
      "-storepass",
      "offline-public-certificates",
    ]);
    if (imported.code !== 0)
      throw new Error(
        `Cannot read the supplied trust certificate: ${imported.text}`,
      );
    args.push("-keystore", store, "-storepass", "offline-public-certificates");
  }
  const verified = await command(context, jarsigner, [...args, context.target]);
  const unsigned = /jar is unsigned/u.test(verified.text);
  if (unsigned) context.report.unsigned_members = null;
  const valid =
    verified.code !== null &&
    verified.code !== undefined &&
    (verified.code & 3) === 0 &&
    /(?:^|\n)jar verified(?:[.,]|$)/mu.test(verified.text);
  check(
    context,
    "jar_signature",
    valid ? "passed" : unsigned ? "unsigned" : "failed",
    valid
      ? "jarsigner verified the signed entries and their signature blocks."
      : verified.text.trim(),
  );
  if (valid) {
    const partial =
      /unsigned entries/u.test(verified.text) ||
      ((verified.code ?? 0) & 16) !== 0;
    if (partial) context.report.unsigned_members = null;
    check(
      context,
      "all_members_signed",
      partial ? "failed" : "passed",
      partial
        ? "The JAR contains unsigned entries; the whole archive is not authenticated."
        : "jarsigner reported no unsigned content entries.",
    );
    context.report.trust = jarTrust(context, verified.code, keytool);
  }
  context.report.timestamp = {
    status: "unknown",
    present: /Timestamped by|timestamp on/u.test(verified.text),
    reason:
      "No timestamp authority trust or signing-time validation is claimed.",
  };
  context.report.limitations.push(
    "JAR signing covers signed entries and manifest data, not ZIP layout, directories, or signature metadata as whole-file bytes.",
  );
  if (valid) await jarSigners(context, keytool, java);
};

const jarTrust = (
  context: SignatureContext,
  code: number | null | undefined,
  keytool: string | null,
): SignatureContext["report"]["trust"] => {
  return context.certificate === null
    ? {
        status: "not_checked",
        reason:
          "No caller trust certificate was supplied; runtime default trust is not adopted.",
      }
    : keytool === null
      ? {
          status: "unavailable",
          reason:
            "keytool is required to create the caller-selected trust store.",
        }
      : {
          status: ((code ?? 1) & 12) === 0 ? "passed" : "failed",
          reason:
            ((code ?? 1) & 12) === 0
              ? "jarsigner accepted the caller-supplied trust certificate and current certificate policy."
              : "jarsigner did not accept all certificate or usage checks under the supplied trust store.",
        };
};

const jarSigners = async (
  context: SignatureContext,
  keytool: string | null,
  java: string[],
) => {
  if (keytool === null) return;
  const printed = await command(context, keytool, [
    ...java,
    "-printcert",
    "-jarfile",
    context.target,
    "-rfc",
  ]);
  if (printed.code === 0) {
    // keytool groups one chain per Signer; only its first certificate is the leaf.
    for (const group of printed.text.split(/(?:^|\n)Signer #[0-9]+:/u)) {
      const leaf = certificatesFromPem(group)[0];
      if (leaf !== undefined)
        context.report.signers.push(certificateSigner(leaf));
    }
  }
};
