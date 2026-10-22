import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { z } from "zod";
import {
  CHUNK_BYTES,
  HostedError,
  MAX_UPLOAD,
  submissionSchema,
  type Submission,
} from "./types.js";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
// Path separators, control and line-break characters, and bidirectional overrides
// (which can disguise a name's real extension) are refused.
const UNSAFE_NAME =
  /[\x00-\x1f\x7f-\x9f/\\\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const newSubmission = z.strictObject({
  name: z.string().refine(
    (name) =>
      name.trim() !== "" &&
      // Linux limits a name to 255 bytes; keep headroom.
      Buffer.byteLength(name) <= 240 &&
      !UNSAFE_NAME.test(name) &&
      name !== "." &&
      name !== "..",
    "Use a plain filename.",
  ),
  size: z.number().int().min(1).max(MAX_UPLOAD),
  agreement: z.literal(true),
  // When true, the whole submission is removed about 24 hours after upload.
  autoDelete: z.boolean().default(true),
});

/** Auto-deleting uploads are removed this long after they are created. */
export const RETENTION_MS = 24 * 60 * 60 * 1000;
/** Incomplete uploads that receive no bytes for this long are discarded, whatever their retention choice. */
export const ABANDONED_MS = 60 * 60 * 1000;

/** Durable single-instance public archive; only incomplete uploads have write tokens. */
export class HostedStore {
  readonly busy = new Set<string>();
  /** Submissions the queue is inspecting now; their folders are not removed until it is done. */
  readonly inspecting = new Set<string>();
  constructor(readonly directory: string) {}
  path(id: string) {
    return join(this.directory, z.string().uuid().parse(id));
  }
  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
  }
  async get(id: string): Promise<Submission> {
    try {
      return submissionSchema.parse(
        JSON.parse(
          await readFile(join(this.path(id), "submission.json"), "utf8"),
        ),
      );
    } catch {
      throw new HostedError(404, "Submission not found.");
    }
  }
  async save(value: Submission) {
    const folder = this.path(value.id);
    const temporary = join(folder, `metadata-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await rename(temporary, join(folder, "submission.json"));
  }
  async list() {
    const results: Submission[] = [];
    for (const entry of await readdir(this.directory)) {
      if (!z.string().uuid().safeParse(entry).success) continue;
      try {
        results.push(await this.get(entry));
      } catch {
        /* Ignore incomplete atomic creation. */
      }
    }
    return results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async create(input: unknown) {
    const parsed = newSubmission.safeParse(input);
    if (!parsed.success)
      throw new HostedError(
        400,
        parsed.error.issues.some((issue) => issue.path[0] === "name")
          ? "Rename the file first: use a plain name under 240 bytes, without slashes, control characters, or text-direction marks."
          : "Choose a file from 1 byte to 1 GiB and agree that it contains no personal data and will be public.",
      );
    const disk = await statfs(this.directory);
    const reserved = (await this.list())
      .filter((s) => s.status === "uploading")
      .reduce((n, s) => n + s.size - s.received, 0);
    if (
      disk.bavail * disk.bsize - reserved <
      parsed.data.size + 512 * 1024 ** 2
    )
      throw new HostedError(
        507,
        "The archive is out of storage. Please try again after the operator adds space.",
      );
    const token = randomBytes(32).toString("base64url");
    const createdAt = new Date();
    const value: Submission = {
      id: randomUUID(),
      name: parsed.data.name,
      size: parsed.data.size,
      received: 0,
      createdAt: createdAt.toISOString(),
      updatedAt: createdAt.toISOString(),
      expiresAt: parsed.data.autoDelete
        ? new Date(createdAt.getTime() + RETENTION_MS).toISOString()
        : null,
      status: "uploading",
      analysisAttempts: 0,
      tokenHash: hash(token),
      agreementVersion: "public-v1",
      files: [],
    };
    const folder = this.path(value.id);
    await mkdir(folder, { mode: 0o700 });
    try {
      await mkdir(join(folder, "source"));
      await writeFile(join(folder, "source", value.name), "", {
        mode: 0o600,
        flag: "wx",
      });
      await this.save(value);
    } catch (cause) {
      // Without submission.json no sweep would ever find this folder again.
      await rm(folder, { recursive: true, force: true });
      throw cause;
    }
    return { id: value.id, token, chunkBytes: CHUNK_BYTES };
  }
  authorize(value: Submission, token: string | undefined) {
    if (
      !token ||
      !timingSafeEqual(
        Buffer.from(value.tokenHash, "hex"),
        Buffer.from(hash(token), "hex"),
      )
    )
      throw new HostedError(
        403,
        "This upload belongs to a different browser session.",
      );
  }
  async append(value: Submission, offset: number, req: IncomingMessage) {
    if (value.status !== "uploading")
      throw new HostedError(409, "This upload is already complete.");
    if (offset !== value.received)
      throw new HostedError(409, `Resume at byte ${value.received}.`);
    const file = await open(
      join(this.path(value.id), "source", value.name),
      "r+",
    );
    let length = 0;
    try {
      // Truncate bytes from any interrupted request before resuming the committed offset.
      await file.truncate(value.received);
      for await (const raw of req) {
        const bytes = Buffer.isBuffer(raw)
          ? raw
          : Buffer.from(z.string().parse(raw));
        length += bytes.length;
        if (length > CHUNK_BYTES || value.received + length > value.size)
          throw new HostedError(
            413,
            "The upload chunk exceeds the declared file size or 8 MiB chunk limit.",
          );
        let written = 0;
        while (written < bytes.length) {
          const result = await file.write(
            bytes,
            written,
            bytes.length - written,
            value.received + length - bytes.length + written,
          );
          if (!result.bytesWritten) throw new Error("Unable to write upload.");
          written += result.bytesWritten;
        }
      }
      if (!length) throw new HostedError(400, "Empty upload chunk.");
      await file.sync();
      value.received += length;
      value.updatedAt = new Date().toISOString();
      await this.save(value);
    } finally {
      await file.close();
    }
  }
  async finish(value: Submission) {
    if (value.status !== "uploading") return;
    const info = await stat(join(this.path(value.id), "source", value.name));
    if (value.received !== value.size || info.size !== value.size)
      throw new HostedError(409, "Finish uploading every byte first.");
    value.files = [
      {
        id: value.id,
        name: value.name,
        relative: `source/${value.name}`,
        size: value.size,
        sha256: "",
      },
    ];
    value.status = "queued";
    await this.save(value);
  }
  async discard(value: Submission) {
    if (value.status !== "uploading")
      throw new HostedError(
        409,
        "Published submissions cannot be removed by a visitor.",
      );
    await rm(this.path(value.id), { recursive: true });
  }
  /** Operator removal: delete any submission, published or not, with its files and findings. */
  async remove(value: Submission) {
    await rm(this.path(value.id), { recursive: true, force: true });
  }
  /** Remove expired submissions with their files and findings, and abandoned incomplete uploads. */
  async sweepExpired(now = Date.now()): Promise<number> {
    let removed = 0;
    for (const value of await this.list()) {
      const expired =
        value.expiresAt !== null && Date.parse(value.expiresAt) <= now;
      // An idle incomplete upload still reserves disk space, so it never outlives this window.
      const abandoned =
        value.status === "uploading" &&
        Date.parse(value.updatedAt ?? value.createdAt) + ABANDONED_MS <= now;
      if (!expired && !abandoned) continue;
      if (
        this.busy.has(value.id) ||
        this.inspecting.has(value.id) ||
        this.busy.has("create")
      )
        continue;
      try {
        await rm(this.path(value.id), { recursive: true, force: true });
        removed += 1;
      } catch {
        /* A concurrent reader or the next sweep retries it. */
      }
    }
    return removed;
  }
}
