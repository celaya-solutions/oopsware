import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { Download, RefreshCw, Search, Square } from "lucide-react";
import { api, object, token } from "./api";

const choice = z.object({
  id: z.string(),
  name: z.string(),
  cloud: z.boolean().optional(),
});
const diskScan = z.object({
  directory: z.string(),
  found: z.boolean(),
  truncated: z.boolean(),
  error: z.string().optional(),
  models: z.array(
    z.object({
      id: z.string(),
      path: z.string(),
      formats: z.array(z.string()),
      sizeBytes: z.number(),
      weights: z.boolean(),
      error: z.string().optional(),
    }),
  ),
});
const discoverSchema = z.object({
  ollama: z.object({ running: z.boolean(), models: z.array(choice) }),
  lmstudio: z.object({
    running: z.boolean(),
    models: z.array(choice),
    error: z.string().optional(),
  }),
  lmStudioFolder: diskScan,
  huggingFaceCache: diskScan,
});
const catalogSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    pull: z.string(),
    detail: z.string().optional(),
    quantizations: z.array(z.string()).optional(),
  }),
);
type Discovered = z.infer<typeof discoverSchema>;
type Source = "name" | "ollama-cloud" | "huggingface";
type Target = "ollama" | "lmstudio";

const size = (bytes: number) =>
  bytes >= 1e9
    ? `${(bytes / 1e9).toFixed(1)} GB`
    : bytes >= 1e6
      ? `${Math.round(bytes / 1e6)} MB`
      : `${Math.round(bytes / 1e3)} KB`;

/** Models already on this computer, plus downloads into Ollama or LM Studio. */
export function ModelLibrary({ refresh }: { refresh: () => void }) {
  const [found, setFound] = useState<Discovered>();
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState("");
  const [source, setSource] = useState<Source>("name");
  const [target, setTarget] = useState<Target>("ollama");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<z.infer<typeof catalogSchema>>([]);
  const [searching, setSearching] = useState(false);
  const [quant, setQuant] = useState<Record<string, string>>({});
  const [progress, setProgress] = useState<{
    model: string;
    status: string;
    completed?: number;
    total?: number;
    error?: string;
    done?: boolean;
  }>();
  const controller = useRef<AbortController | undefined>(undefined);
  async function scan() {
    setScanning(true);
    setScanError("");
    try {
      setFound(await api("/api/models/discover", undefined, discoverSchema));
    } catch (error) {
      setScanError(error instanceof Error ? error.message : String(error));
    } finally {
      setScanning(false);
    }
  }
  useEffect(() => {
    void scan();
    return () => controller.current?.abort();
  }, []);
  async function search() {
    if (source === "name") return;
    setSearching(true);
    setResults([]);
    setScanError("");
    try {
      setResults(
        await api(
          `/api/models/catalog?source=${source}&q=${encodeURIComponent(query)}`,
          undefined,
          catalogSchema,
        ),
      );
    } catch (error) {
      setScanError(error instanceof Error ? error.message : String(error));
    } finally {
      setSearching(false);
    }
  }
  async function download(model: string, quantization?: string) {
    if (!model || controller.current) return;
    const abort = new AbortController();
    controller.current = abort;
    const into = target;
    setProgress({ model, status: "Starting" });
    try {
      const response = await fetch("/api/models/download", {
        method: "POST",
        headers: { "x-rea-token": token, "Content-Type": "application/json" },
        body: JSON.stringify({
          target: into,
          model,
          ...(quantization ? { quantization } : {}),
        }),
        signal: abort.signal,
      });
      if (!response.ok || !response.body) {
        const v: unknown = await response.json().catch(() => null);
        throw new Error(
          object(v) && typeof v.message === "string"
            ? v.message
            : "The download did not start.",
        );
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let done = false;
      while (true) {
        const chunk = await reader.read();
        buffer += decoder.decode(chunk.value, { stream: !chunk.done });
        const lines = buffer.split("\n");
        buffer = chunk.done ? "" : (lines.pop() ?? "");
        for (const line of lines) {
          if (!line.trim()) continue;
          const v: unknown = JSON.parse(line);
          if (!object(v)) continue;
          if (v.type === "error") throw new Error(String(v.message));
          if (v.type === "done") done = true;
          if (v.type === "progress")
            setProgress({
              model,
              status: String(v.status),
              ...(typeof v.completed === "number"
                ? { completed: v.completed }
                : {}),
              ...(typeof v.total === "number" ? { total: v.total } : {}),
            });
        }
        if (chunk.done) break;
      }
      if (!done) throw new Error("The download stopped before it finished.");
      setProgress({ model, status: "Downloaded", done: true });
      refresh();
      void scan();
    } catch (error) {
      setProgress({
        model,
        status: "Stopped",
        error: abort.signal.aborted
          ? into === "ollama"
            ? "Stopped. Start it again to resume."
            : // LM Studio's REST API has no cancel call; the job keeps running there.
              "Stopped watching. LM Studio may keep downloading; check its Downloads panel."
          : error instanceof Error
            ? error.message
            : String(error),
      });
    } finally {
      controller.current = undefined;
    }
  }
  const busy = progress !== undefined && !progress.done && !progress.error;
  const percent =
    progress?.completed !== undefined && progress.total
      ? Math.min(100, Math.round((progress.completed / progress.total) * 100))
      : undefined;
  return (
    <section className="card model-library">
      <div className="card-heading">
        <h2>Models on this Mac</h2>
        <button disabled={scanning} onClick={() => void scan()}>
          <RefreshCw size={14} />
          {scanning ? "Looking…" : "Look again"}
        </button>
      </div>
      <div className="library-grid">
        <FoundList
          title="Ollama"
          note={found && !found.ollama.running ? "Ollama is not running." : ""}
          items={found?.ollama.models.map((m) => ({
            id: m.id,
            label: m.name,
          }))}
        />
        <FoundList
          title="LM Studio server"
          note={found?.lmstudio.error ?? ""}
          items={found?.lmstudio.models.map((m) => ({
            id: m.id,
            label: m.name,
          }))}
        />
        <FoundList
          title="LM Studio folder"
          note={
            found
              ? (found.lmStudioFolder.error ??
                (found.lmStudioFolder.found
                  ? found.lmStudioFolder.directory
                  : "No LM Studio models folder."))
              : ""
          }
          items={found?.lmStudioFolder.models.map((m) => ({
            id: m.id,
            label: m.id,
            detail: `${m.formats.join(", ") || "no weights"} · ${size(m.sizeBytes)}${m.error ? ` · ${m.error}` : ""}`,
          }))}
        />
        <FoundList
          title="Hugging Face cache"
          note={
            found
              ? (found.huggingFaceCache.error ??
                (found.huggingFaceCache.found
                  ? `${found.huggingFaceCache.directory} · chat needs Ollama, LM Studio or HF Inference`
                  : "No Hugging Face cache."))
              : ""
          }
          items={found?.huggingFaceCache.models.map((m) => ({
            id: m.id,
            label: m.id,
            detail: `${m.formats.join(", ") || "no weights"} · ${size(m.sizeBytes)}${m.error ? ` · ${m.error}` : ""}`,
          }))}
        />
      </div>
      <form
        className="model-get"
        onSubmit={(e) => {
          e.preventDefault();
          if (source === "name") void download(query.trim());
          else void search();
        }}
      >
        <h3>Get a model</h3>
        <div className="model-get-row">
          <select
            aria-label="Where to look"
            value={source}
            onChange={(e) => {
              setSource(e.target.value as Source);
              setResults([]);
            }}
          >
            <option value="name">By exact name</option>
            <option value="huggingface">Hugging Face GGUF</option>
            <option value="ollama-cloud">Ollama cloud</option>
          </select>
          <input
            aria-label={source === "name" ? "Model name" : "Search models"}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={
              source === "name"
                ? target === "ollama"
                  ? "qwen3:0.6b or hf.co/owner/repo:Q4_K_M"
                  : "openai/gpt-oss-20b"
                : "Search, e.g. qwen3"
            }
          />
          <select
            aria-label="Download into"
            value={target}
            onChange={(e) => setTarget(e.target.value as Target)}
          >
            <option value="ollama">into Ollama</option>
            <option value="lmstudio">into LM Studio</option>
          </select>
          <button
            className="primary"
            disabled={busy || searching || (source === "name" && !query.trim())}
          >
            {source === "name" ? <Download size={14} /> : <Search size={14} />}
            {source === "name"
              ? "Download"
              : searching
                ? "Searching…"
                : "Search"}
          </button>
        </div>
        {source === "ollama-cloud" && (
          <p className="model-hint">
            Cloud models are small links. Chatting with them needs Ollama
            sign-in, and Ollama's cloud must be turned on in its settings.
          </p>
        )}
      </form>
      {progress && (
        <div className="download-progress" role="status">
          <span>
            <strong>{progress.model}</strong> ·{" "}
            {progress.error ?? progress.status}
            {percent !== undefined && !progress.error ? ` · ${percent}%` : ""}
          </span>
          {percent !== undefined && !progress.error && (
            <progress max={100} value={percent} />
          )}
          {busy && (
            <button onClick={() => controller.current?.abort()}>
              <Square size={14} />
              Stop
            </button>
          )}
        </div>
      )}
      {results.length > 0 && (
        <ul className="catalog-results">
          {results.map((r) => {
            const quants = r.quantizations ?? [];
            const picked =
              quant[r.id] ??
              quants.find((q) => q === "Q4_K_M") ??
              quants[0] ??
              "";
            return (
              <li key={r.id}>
                <span>
                  <strong>{r.name}</strong>
                  {r.detail && <small>{r.detail}</small>}
                </span>
                {quants.length > 0 && (
                  <select
                    aria-label={`Quantization for ${r.name}`}
                    value={picked}
                    onChange={(e) =>
                      setQuant({ ...quant, [r.id]: e.target.value })
                    }
                  >
                    {quants.map((q) => (
                      <option key={q}>{q}</option>
                    ))}
                  </select>
                )}
                <button
                  disabled={
                    busy || (target === "lmstudio" && source === "ollama-cloud")
                  }
                  onClick={() => void download(r.pull, picked || undefined)}
                >
                  <Download size={14} />
                  Get
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {scanError && <p role="alert">{scanError}</p>}
    </section>
  );
}

function FoundList({
  title,
  note,
  items,
}: {
  title: string;
  note: string;
  items: { id: string; label: string; detail?: string }[] | undefined;
}) {
  return (
    <details className="found-list" open={(items?.length ?? 0) > 0}>
      <summary>
        {title}
        <span>{items === undefined ? "…" : items.length}</span>
      </summary>
      {note && <p>{note}</p>}
      <ul>
        {(items ?? []).map((item) => (
          <li key={item.id}>
            <span>{item.label}</span>
            {item.detail && <small>{item.detail}</small>}
          </li>
        ))}
      </ul>
    </details>
  );
}
