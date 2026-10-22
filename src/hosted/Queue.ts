import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { HostedStore } from "./Store.js";

/** Inspections interrupted this many times (for example by a crash or restart) are not started again. */
export const MAX_ANALYSIS_ATTEMPTS = 2;

/** One disposable parser at a time keeps uploads responsive and bounds resource use. */
export class AnalysisQueue {
  #pending: string[] = [];
  #active = false;
  #closed = false;
  #child: ReturnType<typeof fork> | undefined;
  #running: { id: string; done: Promise<void> } | undefined;
  /** Jobs an operator has stopped; they save no failure and leave the folder to the operator. */
  readonly #cancelled = new Set<string>();
  constructor(
    readonly store: HostedStore,
    readonly worker = fileURLToPath(new URL("./worker.mjs", import.meta.url)),
  ) {}
  async recover() {
    for (const value of await this.store.list()) {
      if (value.status !== "queued" && value.status !== "analyzing") continue;
      // A job that keeps dying mid-inspection may be what stopped the service; never loop on it.
      if (
        value.status === "analyzing" &&
        value.analysisAttempts >= MAX_ANALYSIS_ATTEMPTS
      ) {
        await this.store.save({
          ...value,
          status: "failed",
          error:
            "Static inspection was interrupted more than once, so it will not run again. The original upload is retained.",
        });
        continue;
      }
      value.status = "queued";
      await this.store.save(value);
      this.#pending.push(value.id);
    }
    this.#pump();
  }
  enqueue(id: string) {
    if (!this.#pending.includes(id)) this.#pending.push(id);
    this.#pump();
  }
  /**
   * Stop inspecting one submission and wait until its worker is gone, so the
   * caller can remove the folder without the worker writing into it afterwards.
   */
  async cancel(id: string) {
    this.#pending = this.#pending.filter((queued) => queued !== id);
    const running = this.#running;
    if (running?.id !== id) return;
    this.#cancelled.add(id);
    this.#child?.kill("SIGKILL");
    await running.done;
  }
  close() {
    this.#closed = true;
    this.#child?.kill("SIGKILL");
  }
  #pump() {
    if (this.#active || this.#closed) return;
    const id = this.#pending.shift();
    if (!id) return;
    this.#active = true;
    // The sweeper must not remove a folder the worker is still writing into.
    this.store.inspecting.add(id);
    const done = this.#run(id)
      .catch(() => {
        /* The persisted job state is recovered on restart. */
      })
      .finally(() => {
        this.store.inspecting.delete(id);
        this.#cancelled.delete(id);
        this.#running = undefined;
        this.#active = false;
        this.#pump();
      });
    this.#running = { id, done };
  }
  async #run(id: string) {
    const value = await this.store.get(id);
    if (value.status !== "queued") return;
    await this.store.save({
      ...value,
      status: "analyzing",
      analysisAttempts: value.analysisAttempts + 1,
    });
    if (this.#cancelled.has(id)) return;
    const succeeded = await new Promise<boolean>((resolve) => {
      const child = fork(this.worker, [this.store.directory, id], {
        execArgv: ["--max-old-space-size=512"],
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          NODE_ENV: "production",
        },
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      this.#child = child;
      const timer = setTimeout(() => child.kill("SIGKILL"), 10 * 60_000);
      child.once("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code === 0);
      });
    });
    this.#child = undefined;
    if (!succeeded && !this.#closed && !this.#cancelled.has(id)) {
      const current = await this.store.get(id);
      await this.store.save({
        ...current,
        status: "failed",
        error:
          "Static inspection could not finish within the worker's memory or time budget. The original upload is retained.",
      });
    }
  }
}
