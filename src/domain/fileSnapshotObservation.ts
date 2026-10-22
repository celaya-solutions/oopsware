import { z } from "zod";

const byteCount = z.number().int().nonnegative().safe();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);

/** Completed immutable-file facts retained when read finalization fails. */
export const fileSnapshotPartialObservationSchema = z.discriminatedUnion(
  "kind",
  [
    z.strictObject({
      kind: z.literal("file-snapshot-hash"),
      path: z.string().min(1),
      sha256,
      bytes: byteCount,
    }),
    z.strictObject({
      kind: z.literal("file-snapshot-read"),
      path: z.string().min(1),
      admitted_sha256: sha256,
      capture: z.discriminatedUnion("status", [
        z.strictObject({ status: z.literal("captured"), bytes: byteCount }),
        z.strictObject({
          status: z.literal("over-capacity"),
          source_bytes_at_least: byteCount,
          maximum_bytes: byteCount,
        }),
      ]),
    }),
  ],
);
export type FileSnapshotPartialObservation = z.infer<
  typeof fileSnapshotPartialObservationSchema
>;
