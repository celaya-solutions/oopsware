import type { Run, RunSummary } from "./types.js";
/** Keep only small rows even when an operation returns complete evidence. */
export function summarizeRun(run: Run | RunSummary): RunSummary {
  return {
    id: run.id,
    tool: run.tool,
    status: run.status,
    createdAt: run.createdAt,
    ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
    ...(run.completedAt === undefined ? {} : { completedAt: run.completedAt }),
    ...("progress" in run && run.progress !== undefined
      ? { progress: run.progress }
      : {}),
    hasResult: "hasResult" in run ? run.hasResult : run.result !== undefined,
  };
}
/** Merge older HTTP snapshots without losing newly submitted or terminal runs. */
export function mergeRuns(
  current: (Run | RunSummary)[],
  incoming: (Run | RunSummary)[],
): RunSummary[] {
  const byId = new Map(current.map((run) => [run.id, summarizeRun(run)]));
  for (const value of incoming) {
    const next = summarizeRun(value);
    const previous = byId.get(next.id);
    const terminal = (r: RunSummary) =>
      r.status !== "queued" && r.status !== "running";
    if (previous && terminal(previous) && !terminal(next)) continue;
    if (
      previous?.completedAt &&
      next.completedAt &&
      previous.completedAt > next.completedAt
    )
      continue;
    if (
      previous?.progress &&
      next.progress &&
      previous.progress.progress > next.progress.progress &&
      !terminal(next)
    )
      continue;
    byId.set(next.id, next);
  }
  return [...byId.values()].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
}
/** Keep reload history, but fork a duplicated tab while another live tab owns it. */
export async function claimWorkspace(
  saved: string | null,
): Promise<{ id: string | null; close: () => void }> {
  if (!saved || typeof BroadcastChannel === "undefined")
    return { id: saved, close: () => {} };
  const channel = new BroadcastChannel("rea-workspace-ownership");
  const nonce = crypto.randomUUID();
  let occupied = false,
    settled = false;
  channel.onmessage = (event) => {
    const value: unknown = event.data;
    if (
      typeof value !== "object" ||
      value === null ||
      !("workspace" in value) ||
      value.workspace !== saved ||
      !("nonce" in value) ||
      typeof value.nonce !== "string" ||
      value.nonce === nonce ||
      !("type" in value)
    )
      return;
    if (value.type === "probe") {
      if (!settled && value.nonce < nonce) occupied = true;
      if (settled || nonce < value.nonce)
        channel.postMessage({
          type: "owned",
          workspace: saved,
          nonce,
          to: value.nonce,
        });
    } else if (value.type === "owned" && "to" in value && value.to === nonce)
      occupied = true;
  };
  channel.postMessage({ type: "probe", workspace: saved, nonce });
  await new Promise<void>((resolve) => setTimeout(resolve, 180));
  if (occupied) {
    channel.close();
    return { id: null, close: () => {} };
  }
  settled = true;
  return { id: saved, close: () => channel.close() };
}
/** Announce ownership for a newly created workspace for future duplicate tabs. */
export function ownWorkspace(id: string): () => void {
  if (typeof BroadcastChannel === "undefined") return () => {};
  const channel = new BroadcastChannel("rea-workspace-ownership");
  const nonce = crypto.randomUUID();
  channel.onmessage = (event) => {
    const value: unknown = event.data;
    if (
      typeof value === "object" &&
      value !== null &&
      "workspace" in value &&
      value.workspace === id &&
      "type" in value &&
      value.type === "probe" &&
      "nonce" in value
    )
      channel.postMessage({
        type: "owned",
        workspace: id,
        nonce,
        to: value.nonce,
      });
  };
  return () => channel.close();
}
