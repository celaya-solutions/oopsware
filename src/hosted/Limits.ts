import type { IncomingMessage } from "node:http";

/** Per-visitor abuse budgets for the public service. Counts live in memory only. */
export interface HostedLimits {
  /** Upload sessions one network address may start per hour. */
  readonly uploadsPerHour: number;
  /** Uploads one address may have incomplete or waiting for inspection at once. */
  readonly activeUploads: number;
  /** API requests one address may make per minute; upload chunks are bounded by their token. */
  readonly requestsPerMinute: number;
  /** Bytes one address may download per hour, which bounds hosting egress. */
  readonly downloadBytesPerHour: number;
}

/** Production budgets: generous for people, small enough to stop one address exhausting storage, the parser, or egress. */
export const DEFAULT_LIMITS: HostedLimits = {
  uploadsPerHour: 30,
  activeUploads: 3,
  requestsPerMinute: 600,
  downloadBytesPerHour: 10 * 1024 ** 3,
};

// Bounds memory when many addresses appear at once; losing counts is safer than unbounded growth.
const MAX_TRACKED = 100_000;

/** A fixed-window allowance per key; nothing is persisted, logged, or shared. */
export class Budget {
  readonly #windows = new Map<string, { used: number; resetAt: number }>();
  constructor(
    readonly capacity: number,
    readonly windowMs: number,
  ) {}
  /** Spend `cost` for `key`; returns whole seconds until the window resets when the allowance is used up, else null. */
  spend(key: string, cost = 1, now = Date.now()): number | null {
    let window = this.#windows.get(key);
    if (!window || window.resetAt <= now) {
      if (this.#windows.size >= MAX_TRACKED) this.prune(now);
      window = { used: 0, resetAt: now + this.windowMs };
      this.#windows.set(key, window);
    }
    if (window.used + cost > this.capacity)
      return Math.max(1, Math.ceil((window.resetAt - now) / 1000));
    window.used += cost;
    return null;
  }
  /** Forget windows that have already reset. */
  prune(now = Date.now()) {
    for (const [key, window] of this.#windows)
      if (window.resetAt <= now) this.#windows.delete(key);
    if (this.#windows.size >= MAX_TRACKED) this.#windows.clear();
  }
}

/** Railway's edge sets X-Real-IP to the visitor's address; direct connections fall back to the socket peer. */
export const clientKey = (req: IncomingMessage): string => {
  const forwarded = req.headers["x-real-ip"];
  const value = typeof forwarded === "string" ? forwarded.trim() : "";
  return value || req.socket.remoteAddress || "unknown";
};
