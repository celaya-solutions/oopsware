import { fork } from "node:child_process";

/**
 * Run one view builder in a separate process of the hosted worker script with
 * a fixed heap and wall-clock budget. Resolves with the message it sent, or
 * undefined when it failed, was killed, or exceeded the budget; the caller
 * validates the message before trusting it.
 */
export const runViewWorker = (
  worker: string,
  args: readonly string[],
  budget: { readonly heapMiB: number; readonly timeMs: number },
): Promise<unknown> =>
  new Promise<unknown>((resolve) => {
    let message: unknown;
    const child = fork(worker, [...args], {
      execArgv: [`--max-old-space-size=${String(budget.heapMiB)}`],
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        NODE_ENV: "production",
      },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), budget.timeMs);
    child.on("message", (value) => {
      message = value;
    });
    child.once("error", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? message : undefined);
    });
  });
