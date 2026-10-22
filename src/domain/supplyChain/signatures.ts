import { z } from "zod";
import { localPathStringSchema } from "../localPath.js";
import { digestSchema } from "../digests.js";

export const verifyArtifactSignatureInputSchema = z
  .object({
    path: localPathStringSchema,
    kind: z.enum(["jar", "authenticode", "apple", "wheel"]),
    trusted_certificate: localPathStringSchema.optional(),
    public_key: localPathStringSchema.optional(),
    expected_signer_sha256: z
      .string()
      .regex(/^[a-fA-F0-9]{64}$/u)
      .optional(),
    max_artifact_bytes: z
      .number()
      .int()
      .positive()
      .max(1024 ** 3)
      .default(256 * 1024 ** 2),
    timeout_ms: z.number().int().min(100).max(120_000).default(30_000),
  })
  .strict();

const status = z.enum([
  "passed",
  "failed",
  "unsigned",
  "unavailable",
  "unknown",
  "not_checked",
]);
const observation = z.object({ status, reason: z.string() }).strict();
export const signatureReportSchema = z
  .object({
    kind: z.enum(["jar", "authenticode", "apple", "wheel"]),
    artifact: z
      .object({
        path: localPathStringSchema,
        sha256: digestSchema.nullable(),
        bytes: z.number().int().nonnegative().nullable(),
      })
      .strict(),
    integrity: observation,
    checks: z.array(observation.extend({ id: z.string() })),
    signers: z.array(
      z
        .object({
          identity: z.string().nullable(),
          certificate_sha256: digestSchema.nullable(),
          public_key_sha256: digestSchema.nullable(),
        })
        .strict(),
    ),
    signer_identity: observation,
    trust: observation,
    trust_material: z.array(
      z
        .object({
          kind: z.enum(["certificate", "public_key"]),
          path: localPathStringSchema,
          sha256: digestSchema,
          bytes: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    timestamp: observation.extend({ present: z.boolean().nullable() }),
    revocation: observation,
    notarization: observation,
    unsigned_members: z.array(z.string()).nullable(),
    providers: z.array(
      z
        .object({
          name: z.string(),
          path: localPathStringSchema.nullable(),
          sha256: digestSchema.nullable(),
          version: z.string().nullable(),
        })
        .strict(),
    ),
    limitations: z.array(z.string()),
  })
  .strict();

export type VerifyArtifactSignatureInput = z.infer<
  typeof verifyArtifactSignatureInputSchema
>;
export type SignatureReport = z.infer<typeof signatureReportSchema>;
