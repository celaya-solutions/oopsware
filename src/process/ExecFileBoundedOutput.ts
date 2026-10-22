import { spawn } from "node:child_process";

export interface BoundedCommandOutput {
  readonly exitCode: string | number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly outputTruncated: boolean;
}

/** Drain both streams while retaining bounded head and tail evidence. */
export const execFileBoundedOutput = (
  executable: string,
  args: readonly string[],
  options: {
    readonly env: Readonly<NodeJS.ProcessEnv>;
    readonly limit: number;
  },
): Promise<BoundedCommandOutput> =>
  new Promise((resolve) => {
    const child = spawn(executable, [...args], {
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const headLimit = Math.ceil(options.limit / 2);
    const tailLimit = options.limit - headLimit;
    const stdout = { head: Buffer.alloc(0), tail: Buffer.alloc(0), total: 0 };
    const stderr = { head: Buffer.alloc(0), tail: Buffer.alloc(0), total: 0 };
    let outputTruncated = false;
    const capture =
      (stream: typeof stdout) =>
      (chunk: Buffer): void => {
        stream.total += chunk.length;
        const headCount = Math.min(
          chunk.length,
          Math.max(0, headLimit - stream.head.length),
        );
        if (headCount > 0)
          stream.head = Buffer.concat([
            stream.head,
            chunk.subarray(0, headCount),
          ]);
        const rest = chunk.subarray(headCount);
        if (rest.length > 0 && tailLimit > 0)
          stream.tail = Buffer.concat([stream.tail, rest]).subarray(-tailLimit);
        if (stream.total > options.limit) outputTruncated = true;
      };
    child.stdout.on("data", capture(stdout));
    child.stderr.on("data", capture(stderr));
    let spawnError: NodeJS.ErrnoException | undefined;
    child.on("error", (error: NodeJS.ErrnoException) => {
      spawnError = error;
    });
    child.on("close", (code, signal) => {
      resolve({
        exitCode: spawnError?.code ?? code ?? signal,
        stdout: retainedOutput(stdout, options.limit),
        stderr: retainedOutput(stderr, options.limit),
        outputTruncated,
      });
    });
  });

const retainedOutput = (
  stream: {
    readonly head: Buffer;
    readonly tail: Buffer;
    readonly total: number;
  },
  limit: number,
): string =>
  stream.total > limit
    ? `${stream.head.toString("utf8")} … [output omitted] … ${stream.tail.toString("utf8")}`
    : Buffer.concat([stream.head, stream.tail]).toString("utf8");
