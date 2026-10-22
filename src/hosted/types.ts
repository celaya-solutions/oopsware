import { z } from "zod";
import { categoryFor, observedFormatFor, summaryFor } from "./catalog.js";

/** Hosted limits are byte budgets, independent of the local CLI. */
export const MAX_UPLOAD = 1024 ** 3;
export const CHUNK_BYTES = 8 * 1024 ** 2;
export const fileSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  relative: z.string(),
  size: z.number().int().nonnegative(),
  sha256: z.string(),
});
export const submissionSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  size: z.number().int().nonnegative(),
  received: z.number().int().nonnegative(),
  createdAt: z.string(),
  // Last time an incomplete upload received bytes; abandoned uploads are swept from it.
  updatedAt: z.string().datetime().optional(),
  // ISO timestamp after which a sweeper removes the whole submission; null means keep.
  expiresAt: z.string().datetime().nullable().default(null),
  status: z.enum(["uploading", "queued", "analyzing", "ready", "failed"]),
  // Started inspections; bounds retries of a job that keeps being interrupted.
  analysisAttempts: z.number().int().nonnegative().default(0),
  tokenHash: z.string(),
  agreementVersion: z.literal("public-v1"),
  files: z.array(fileSchema),
  error: z.string().optional(),
  // Root format observed from bytes by the last completed inspection; absent on older submissions.
  format: z.string().optional(),
});
export type Submission = z.infer<typeof submissionSchema>;
export type PublishedFile = z.infer<typeof fileSchema>;

/** A failure safe to show without leaking provider responses or filesystem paths. */
export class HostedError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Seconds a refused visitor should wait, sent as Retry-After. */
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}

/** Exclude upload credentials and internal bookkeeping from every public representation. */
export const publicSubmission = (submission: Submission) => {
  const {
    tokenHash: _secret,
    updatedAt: _updated,
    analysisAttempts: _attempts,
    ...visible
  } = submission;
  return {
    ...visible,
    category: categoryFor(submission.name),
    observedFormat: observedFormatFor(submission.format),
    summary: summaryFor(submission),
    files: visible.files.map(({ relative: _path, ...file }) => file),
  };
};
