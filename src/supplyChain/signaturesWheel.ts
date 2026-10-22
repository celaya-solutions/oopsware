import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { AnalysisResourceConstraintError } from "../domain/analysisErrorCore.js";
import { readStableArtifact } from "../artifacts/readStableArtifact.js";
import {
  DecodeBudget,
  sha256Hex,
  ZipView,
} from "../artifacts/zipMemberView.js";
import {
  parseRecord,
  recordAlgorithmAccepted,
  recordDigest,
} from "../python/wheel.js";
import { check, verifyCms, type SignatureContext } from "./signaturesTools.js";

const base64url = z.string().regex(/^[A-Za-z0-9_-]*$/u);
const jwsSchema = z.object({
  payload: base64url,
  signatures: z
    .array(
      z.object({
        protected: base64url,
        signature: base64url,
        header: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .length(1),
});
const protectedSchema = z
  .object({
    alg: z.enum(["RS256", "ES256", "EdDSA"]),
    crit: z.array(z.string()).optional(),
    b64: z.boolean().optional(),
  })
  .passthrough();

const verifyJws = async (
  context: SignatureContext,
  bytes: Uint8Array,
  record: Uint8Array,
) => {
  if (context.publicKey === null) {
    check(
      context,
      "wheel_jws",
      "unavailable",
      "A RECORD.jws is present; supply public_key to verify it. Embedded keys are not automatically trusted.",
    );
    return;
  }
  context.signal?.throwIfAborted();
  const parsed = jwsSchema.safeParse(
    JSON.parse(Buffer.from(bytes).toString("utf8")),
  );
  if (!parsed.success) {
    check(
      context,
      "wheel_jws",
      "unknown",
      "Only one protected JWS signature is supported.",
    );
    return;
  }
  const signed = parsed.data.signatures[0]!;
  const header = protectedSchema.safeParse(
    JSON.parse(Buffer.from(signed.protected, "base64url").toString("utf8")),
  );
  if (
    !header.success ||
    (header.data.crit?.length ?? 0) > 0 ||
    header.data.b64 === false ||
    signed.header?.alg !== undefined
  ) {
    check(
      context,
      "wheel_jws",
      "unknown",
      "JWS needs a supported protected algorithm without critical extensions or an unprotected algorithm.",
    );
    return;
  }
  const keyBytes = await readStableArtifact(
    context.publicKey,
    1024 ** 2,
    context.signal,
  );
  const key = createPublicKey(keyBytes.bytes);
  const valid = verifyJwsSignature(header.data.alg, key, {
    ...signed,
    payload: parsed.data.payload,
  });
  check(
    context,
    "wheel_jws",
    valid ? "passed" : "failed",
    valid
      ? "Node crypto verified the JWS against the caller-supplied public key."
      : "The JWS did not verify against the supplied key and protected algorithm.",
  );
  const payload = z
    .object({ hash: z.string() })
    .safeParse(
      JSON.parse(
        Buffer.from(parsed.data.payload, "base64url").toString("utf8"),
      ),
    );
  const matches =
    payload.success &&
    payload.data.hash === `sha256=${recordDigest("sha256", record)}`;
  check(
    context,
    "wheel_jws_record",
    matches ? "passed" : "failed",
    "The signed JWS payload must name the SHA-256 of these exact RECORD bytes.",
  );
  if (valid) {
    context.report.signers.push({
      identity: null,
      certificate_sha256: null,
      public_key_sha256: sha256Hex(key.export({ type: "spki", format: "der" })),
    });
    context.report.trust = {
      status: "passed",
      reason:
        "The signature matches the caller-supplied public key; ownership of that key is the caller's trust decision.",
    };
  }
};

export const verifyWheel = async (context: SignatureContext) => {
  const zip = await ZipView.open(context.bytes, 100_000);
  try {
    if (zip.duplicates.length > 0) {
      check(
        context,
        "wheel_layout",
        "failed",
        "Duplicate ZIP member names make signature coverage ambiguous.",
      );
      return;
    }
    const records = zip.members.filter((member) =>
      /^[^/]+\.dist-info\/RECORD$/u.test(member.path),
    );
    if (records.length !== 1) {
      check(
        context,
        "wheel_layout",
        "failed",
        "Expected exactly one dist-info/RECORD.",
      );
      return;
    }
    const recordPath = records[0]!.path;
    const budget = new DecodeBudget(
      context.input.max_artifact_bytes,
      context.input.max_artifact_bytes,
    );
    const record = await checkWheelRecord(context, zip, budget, recordPath);
    let signed = false;
    if (zip.has(`${recordPath}.jws`)) {
      signed = true;
      try {
        await verifyJws(
          context,
          await zip.read(`${recordPath}.jws`, budget, context.signal),
          record,
        );
      } catch (cause) {
        if (context.signal?.aborted) throw cause;
        check(
          context,
          "wheel_jws",
          "failed",
          `Cannot verify JWS: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    }
    if (zip.has(`${recordPath}.p7s`)) {
      signed = true;
      const signature = join(context.scratch, "record.p7s");
      const content = join(context.scratch, "record");
      await writeFile(
        signature,
        await zip.read(`${recordPath}.p7s`, budget, context.signal),
        { flag: "wx" },
      );
      await writeFile(content, record, { flag: "wx" });
      await verifyCms(context, signature, content, "wheel_cms");
    }
    if (!signed)
      check(
        context,
        "wheel_signature",
        "unsigned",
        "No RECORD.jws or RECORD.p7s exists; matching RECORD hashes do not authenticate a publisher.",
      );
    if (context.input.public_key !== undefined && !zip.has(`${recordPath}.jws`))
      check(
        context,
        "requested_public_key",
        "failed",
        "public_key was supplied but the wheel has no JWS signature.",
      );
    if (
      context.input.trusted_certificate !== undefined &&
      !zip.has(`${recordPath}.p7s`)
    )
      check(
        context,
        "requested_trust_certificate",
        "failed",
        "trusted_certificate was supplied but the wheel has no CMS signature.",
      );
    context.report.limitations.push(
      "RECORD itself and its .jws/.p7s signature members are excluded from RECORD hashes as required by the wheel format. Other unlisted or unhashed members prevent a whole-wheel integrity result.",
    );
  } finally {
    await zip.close();
  }
};

const verifyJwsSignature = (
  algorithm: string,
  key: KeyObject,
  signed: { protected: string; payload: string; signature: string },
): boolean => {
  const keyType = key.asymmetricKeyType;
  const compatible =
    (algorithm === "RS256" && keyType === "rsa") ||
    (algorithm === "ES256" &&
      keyType === "ec" &&
      key.asymmetricKeyDetails?.namedCurve === "prime256v1") ||
    (algorithm === "EdDSA" && keyType === "ed25519");
  return (
    compatible &&
    verify(
      algorithm === "EdDSA" ? null : "sha256",
      Buffer.from(`${signed.protected}.${signed.payload}`),
      { key, dsaEncoding: "ieee-p1363" },
      Buffer.from(signed.signature, "base64url"),
    )
  );
};

const checkWheelRecord = async (
  context: SignatureContext,
  zip: ZipView,
  budget: DecodeBudget,
  recordPath: string,
) => {
  context.report.providers.push({
    name: "node:crypto",
    path: null,
    sha256: null,
    version: process.versions.openssl,
  });
  const unsignedMembers: string[] = [];
  context.report.unsigned_members = unsignedMembers;
  const retain = wheelDiagnosticCollector();
  const record = await zip.read(recordPath, budget, context.signal);
  const parsed = parseRecord(record);
  const rows = new Map(parsed.rows.map((row) => [row.path, row]));
  const exempt = new Set([
    recordPath,
    `${recordPath}.jws`,
    `${recordPath}.p7s`,
  ]);
  const problems: string[] = [];
  if (parsed.problem !== null) retain(problems, parsed.problem);
  if (rows.size !== parsed.rows.length)
    retain(problems, "RECORD has duplicate rows.");
  let checked = 0;
  for (const member of zip.members.filter((member) => !member.directory)) {
    context.signal?.throwIfAborted();
    if (exempt.has(member.path)) continue;
    const row = rows.get(member.path);
    if (
      row?.algorithm == null ||
      row.digest === null ||
      !recordAlgorithmAccepted(row.algorithm)
    ) {
      retain(unsignedMembers, member.path);
      continue;
    }
    const content = await zip.read(member.path, budget, context.signal);
    if (
      row.size !== content.length ||
      row.digest !== recordDigest(row.algorithm, content)
    )
      retain(problems, `${member.path}: RECORD size or digest mismatch.`);
    checked += 1;
  }
  for (const row of parsed.rows)
    if (!zip.has(row.path))
      retain(problems, `${row.path}: listed in RECORD but missing.`);
  if (unsignedMembers.length > 0)
    retain(
      problems,
      "Some content members are not protected by a supported RECORD hash.",
    );
  check(
    context,
    "wheel_record_hashes",
    problems.length === 0 ? "passed" : "failed",
    problems.length === 0
      ? `Recomputed ${String(checked)} content hashes; RECORD hashes alone are not signatures.`
      : problems.join(" "),
  );
  return record;
};

const wheelDiagnosticCollector = () => {
  let bytes = 0;
  return (destination: string[], detail: string) => {
    bytes += Buffer.byteLength(JSON.stringify(detail)) + 1;
    if (bytes > 1024 ** 2)
      throw new AnalysisResourceConstraintError(
        "verify_artifact_signature",
        "transport",
        "Wheel member diagnostics exceed 1 MiB.",
        { max_member_diagnostic_bytes: 1024 ** 2 },
      );
    destination.push(detail);
  };
};
