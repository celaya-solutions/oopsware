import { z } from "zod";
import type { ModelConnections } from "./ModelConnections.js";
import { WebFailure, providerJson } from "../WebFailure.js";

/** One progress line streamed to the browser while a model downloads. */
export type DownloadProgress = {
  status: string;
  completed?: number | undefined;
  total?: number | undefined;
};
export const downloadRequestSchema = z.object({
  /** Who stores the model. Hugging Face GGUF repos download through either one. */
  target: z.enum(["ollama", "lmstudio"]),
  model: z
    .string()
    .min(1)
    .max(300)
    .regex(
      /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/,
      "Use a model name such as qwen3:0.6b or hf.co/owner/repo:Q4_K_M.",
    ),
  quantization: z
    .string()
    .max(40)
    .regex(/^[A-Za-z0-9_.-]*$/)
    .optional(),
});
export type DownloadRequest = z.infer<typeof downloadRequestSchema>;

const ollamaPullEvent = z
  .object({
    status: z.string().optional(),
    error: z.string().optional(),
    completed: z.number().optional(),
    total: z.number().optional(),
  })
  .passthrough();
const lmStudioJob = z
  .object({
    job_id: z.string().optional(),
    status: z.enum([
      "downloading",
      "paused",
      "completed",
      "failed",
      "already_downloaded",
    ]),
    total_size_bytes: z.number().optional(),
    downloaded_bytes: z.number().optional(),
  })
  .passthrough();

/** Download a model into the user's Ollama or LM Studio; progress is reported until the owner says done. */
export const downloadModel = async (input: {
  connections: ModelConnections;
  request: DownloadRequest;
  signal: AbortSignal;
  emit: (progress: DownloadProgress) => void;
}): Promise<void> => {
  if (input.request.target === "ollama") return pullWithOllama(input);
  return downloadWithLmStudio(input);
};

const pullWithOllama = async ({
  connections,
  request,
  signal,
  emit,
}: Parameters<typeof downloadModel>[0]) => {
  const model =
    request.quantization && !request.model.includes(":")
      ? `${request.model}:${request.quantization}`
      : request.model;
  let response: Response;
  try {
    response = await fetch(`${connections.endpoints.ollama}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, stream: true }),
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new WebFailure(
      503,
      "ollama_unavailable",
      "Ollama is not running. Start Ollama, then try the download again.",
    );
  }
  if (!response.ok || !response.body) {
    const detail = z
      .object({ error: z.string() })
      .safeParse(await response.json().catch(() => null));
    throw new WebFailure(
      502,
      "ollama_pull_failed",
      detail.success
        ? `Ollama could not download ${model}: ${detail.data.error}`
        : `Ollama could not download ${model} (HTTP ${response.status}).`,
    );
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let success = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      if (buffer.length > 1_048_576)
        throw new WebFailure(
          502,
          "provider_event_too_large",
          "Ollama sent a progress line larger than 1 MiB.",
        );
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = ollamaPullEvent.parse(JSON.parse(line));
        if (event.error)
          throw new WebFailure(
            502,
            "ollama_pull_failed",
            `Ollama could not download ${model}: ${event.error}`,
          );
        if (event.status === "success") success = true;
        emit({
          status: event.status ?? "working",
          completed: event.completed,
          total: event.total,
        });
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (!success)
    throw new WebFailure(
      502,
      "ollama_pull_interrupted",
      "Ollama stopped before the download finished. Start it again to resume.",
    );
};

const downloadWithLmStudio = async ({
  connections,
  request,
  signal,
  emit,
}: Parameters<typeof downloadModel>[0]) => {
  const base = connections.endpoints.lmStudio;
  const headers = connections.bearerHeaders("lmstudio");
  const call = async (path: string, init: RequestInit = {}) => {
    try {
      return await fetch(`${base}${path}`, { ...init, headers, signal });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new WebFailure(
        503,
        "lmstudio_unavailable",
        "LM Studio's server is off. Start it in LM Studio (Developer > Start server) or run lms server start.",
      );
    }
  };
  const started = await call("/api/v1/models/download", {
    method: "POST",
    body: JSON.stringify(lmStudioDownloadBody(request)),
  });
  if (started.status === 404)
    throw new WebFailure(
      502,
      "lmstudio_download_unsupported",
      "This LM Studio version has no download API. Update LM Studio, or use lms get in Terminal.",
    );
  let job = lmStudioJob.parse(await providerJson(started));
  while (true) {
    emit({
      status: job.status,
      completed: job.downloaded_bytes,
      total: job.total_size_bytes,
    });
    if (job.status === "completed" || job.status === "already_downloaded")
      return;
    if (job.status === "failed")
      throw new WebFailure(
        502,
        "lmstudio_download_failed",
        `LM Studio could not download ${request.model}.`,
      );
    if (!job.job_id)
      throw new WebFailure(
        502,
        "lmstudio_download_untracked",
        "LM Studio started the download without a job id. Watch progress in LM Studio.",
      );
    await pause(1_000, signal);
    job = lmStudioJob.parse(
      await providerJson(
        await call(
          `/api/v1/models/download/status/${encodeURIComponent(job.job_id)}`,
        ),
      ),
    );
  }
};

/**
 * LM Studio takes catalog keys or full Hugging Face links; quantization only applies to links.
 * An Ollama-style hf.co/owner/repo:QUANT name carries its quantization in the tag.
 */
export const lmStudioDownloadBody = (request: DownloadRequest) => {
  if (!request.model.startsWith("hf.co/")) return { model: request.model };
  const [repo = "", tag] = request.model.slice("hf.co/".length).split(":");
  const quantization = request.quantization || tag;
  return {
    model: `https://huggingface.co/${repo}`,
    ...(quantization ? { quantization } : {}),
  };
};

/** Wait between status polls without leaving an abort listener behind for every poll. */
const pause = (milliseconds: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });

export type CatalogEntry = {
  id: string;
  name: string;
  /** Exact name to hand to the download target. */
  pull: string;
  detail?: string | undefined;
  quantizations?: string[];
};

const ollamaCloudCatalog = z.object({
  models: z.array(
    z.object({
      name: z.string(),
      details: z
        .object({ parameter_size: z.string().optional() })
        .partial()
        .optional(),
    }),
  ),
});
const huggingFaceSearch = z.array(
  z.object({
    id: z.string(),
    downloads: z.number().optional(),
    siblings: z.array(z.object({ rfilename: z.string() })).optional(),
  }),
);

/** Ollama names its cloud tags name:cloud, or tag-cloud when the name already has a tag. */
export const ollamaCloudPullName = (name: string) =>
  name.includes(":") ? `${name}-cloud` : `${name}:cloud`;

/** Quantization labels from GGUF file names such as Model.Q4_K_M.gguf or model-q8_0.gguf. */
export const ggufQuantizations = (files: string[]): string[] => {
  const found = new Set<string>();
  for (const file of files) {
    if (!file.toLowerCase().endsWith(".gguf") || file.includes("mmproj"))
      continue;
    const match =
      /[.-]((?:I?Q\d[A-Z0-9_]*)|F16|BF16|F32|FP16)(?:-\d{5}-of-\d{5})?\.gguf$/i.exec(
        file,
      );
    if (match?.[1]) found.add(match[1].toUpperCase());
  }
  return [...found].sort();
};

/** Public catalogs for picking a download; neither needs a sign-in to read. */
export const searchCatalog = async (
  connections: ModelConnections,
  source: "ollama-cloud" | "huggingface",
  query: string,
): Promise<CatalogEntry[]> => {
  const needle = query.trim().toLowerCase();
  if (source === "ollama-cloud") {
    const body = ollamaCloudCatalog.parse(
      await providerJson(
        await fetch(`${connections.endpoints.ollamaCloud}/api/tags`, {
          signal: AbortSignal.timeout(15_000),
        }),
      ),
    );
    return body.models
      .filter((m) => !needle || m.name.toLowerCase().includes(needle))
      .slice(0, 50)
      .map((m) => ({
        id: m.name,
        name: m.name,
        pull: ollamaCloudPullName(m.name),
        detail: m.details?.parameter_size || undefined,
      }));
  }
  const url = new URL("/api/models", connections.endpoints.huggingFace);
  url.searchParams.set("filter", "gguf");
  url.searchParams.set("sort", "downloads");
  url.searchParams.set("limit", "20");
  url.searchParams.set("full", "true");
  if (needle) url.searchParams.set("search", needle);
  const headers: Record<string, string> = {};
  try {
    Object.assign(headers, {
      Authorization: connections.bearerHeaders("huggingface").Authorization,
    });
  } catch {
    // Public search works without a token; a token also shows the user's gated repos.
  }
  const body = huggingFaceSearch.parse(
    await providerJson(
      await fetch(url, { headers, signal: AbortSignal.timeout(15_000) }),
    ),
  );
  return body.map((m) => ({
    id: m.id,
    name: m.id,
    pull: `hf.co/${m.id}`,
    detail:
      m.downloads === undefined
        ? undefined
        : `${m.downloads.toLocaleString("en-US")} downloads`,
    quantizations: ggufQuantizations(
      (m.siblings ?? []).map((s) => s.rfilename),
    ),
  }));
};
