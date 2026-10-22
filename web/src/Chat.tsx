import { modelsSchema } from "./api";
import { useEffect, useRef, useState } from "react";
import { Sparkles, X, Square, ArrowRight, RefreshCw } from "lucide-react";
import { api, object, pretty, token, type Run, type Target } from "./api";

function savedChoice(key: string): string | null {
  try {
    return localStorage.getItem(`rea-chat-${key}`);
  } catch {
    return null;
  }
}

function saveChoice(key: string, value: string) {
  try {
    localStorage.setItem(`rea-chat-${key}`, value);
  } catch {
    // The selector still works when browser storage is unavailable.
  }
}

export function Chat({
  target,
  run,
  close,
}: {
  target: Target | undefined;
  run: Run | undefined;
  close: () => void;
}) {
  const [provider, setProvider] = useState(() => {
      const saved = savedChoice("provider");
      return saved &&
        [
          "ollama",
          "lmstudio",
          "huggingface",
          "openai",
          "claude",
          "openrouter",
        ].includes(saved)
        ? saved
        : "ollama";
    }),
    [models, setModels] = useState<{ id: string; name: string }[]>([]),
    [model, setModel] = useState(""),
    [refresh, setRefresh] = useState(0),
    [loadingModels, setLoadingModels] = useState(true),
    [messages, setMessages] = useState<
      { role: "user" | "assistant"; content: string }[]
    >([]),
    [prompt, setPrompt] = useState(""),
    [context, setContext] = useState(false),
    [error, setError] = useState(""),
    [streaming, setStreaming] = useState(false);
  const controller = useRef<AbortController | undefined>(undefined);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    setLoadingModels(true);
    setModels([]);
    setModel("");
    setError("");
    void api(`/api/models?provider=${provider}`, undefined, modelsSchema)
      .then((m) => {
        if (live) {
          setModels(m);
          const saved = savedChoice(`model-${provider}`);
          setModel(m.find((x) => x.id === saved)?.id ?? m[0]?.id ?? "");
        }
      })
      .catch((e) => {
        if (live) setError(String(e));
      })
      .finally(() => {
        if (live) setLoadingModels(false);
      });
    return () => {
      live = false;
    };
  }, [provider, refresh]);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [messages]);
  async function send() {
    if (!prompt.trim() || !model || streaming) return;
    const history = [
      ...messages,
      { role: "user" as const, content: prompt.trim() },
    ];
    if (history.length > 38) {
      setError("Start a new conversation to keep the context manageable.");
      return;
    }
    setMessages([...history, { role: "assistant", content: "" }]);
    setPrompt("");
    setStreaming(true);
    setError("");
    const abort = new AbortController();
    controller.current = abort;
    let answer = "";
    try {
      const selected = context
        ? `Selected path: ${target?.path ?? "none"}\nPreview (bounded to 32,000 characters): ${(target?.preview?.text ?? target?.preview?.hex ?? "").slice(0, 32000)}\nSelected delivered run (bounded to 32,000 characters): ${JSON.stringify(run ?? null).slice(0, 32000)}`
        : "";
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "x-rea-token": token, "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          model,
          messages: history,
          context: selected,
        }),
        signal: abort.signal,
      });
      if (!response.ok) {
        const v: unknown = await response.json();
        throw new Error(
          object(v) && typeof v.message === "string"
            ? v.message
            : "Model request failed.",
        );
      }
      if (!response.body) throw new Error("No response stream.");
      const reader = response.body.getReader(),
        decoder = new TextDecoder();
      let buffer = "",
        done = false;
      try {
        while (true) {
          const c = await reader.read();
          buffer += decoder.decode(c.value, { stream: !c.done });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          if (c.done && buffer) {
            lines.push(buffer);
            buffer = "";
          }
          for (const line of lines) {
            if (!line.trim()) continue;
            const v: unknown = JSON.parse(line);
            if (!object(v)) continue;
            if (v.type === "error") throw new Error(String(v.message));
            if (v.type === "done") done = true;
            if (v.type === "delta") {
              answer += String(v.text);
              setMessages([...history, { role: "assistant", content: answer }]);
            }
          }
          if (c.done) break;
        }
        if (!done)
          throw new Error(
            "Connection ended before completion. Partial answer preserved.",
          );
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    } catch (e) {
      setError(
        abort.signal.aborted ? "Stopped. Partial answer preserved." : String(e),
      );
      if (!answer) setMessages(history);
    } finally {
      setStreaming(false);
      controller.current = undefined;
    }
  }
  return (
    <aside className="assistant-panel">
      <div className="assistant-heading">
        <span>
          <Sparkles size={18} />
          <strong>Analysis assistant</strong>
        </span>
        <button
          className="icon-button"
          aria-label="Close assistant"
          onClick={close}
        >
          <X size={18} />
        </button>
      </div>
      <div className="model-pickers">
        <select
          aria-label="Model provider"
          disabled={streaming}
          value={provider}
          onChange={(e) => {
            saveChoice("provider", e.target.value);
            setProvider(e.target.value);
          }}
        >
          <option value="ollama">Ollama · all installed</option>
          <option value="lmstudio">LM Studio</option>
          <option value="huggingface">Hugging Face</option>
          <option value="openai">OpenAI</option>
          <option value="claude">Claude</option>
          <option value="openrouter">OpenRouter</option>
        </select>
        <select
          aria-label="Model"
          disabled={streaming || loadingModels || !models.length}
          value={model}
          onChange={(e) => {
            saveChoice(`model-${provider}`, e.target.value);
            setModel(e.target.value);
          }}
        >
          {!models.length && (
            <option value="">
              {loadingModels ? "Loading models…" : "No models available"}
            </option>
          )}
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
        <button
          className="icon-button"
          type="button"
          aria-label="Refresh models"
          title="Refresh models from the selected provider"
          disabled={streaming || loadingModels}
          onClick={() => setRefresh((value) => value + 1)}
        >
          <RefreshCw size={16} />
        </button>
      </div>
      <div className="chat-log">
        {!messages.length && (
          <div className="chat-welcome">
            <span className="empty-icon">
              <Sparkles size={26} />
            </span>
            <h2>Pull on a thread.</h2>
            <p>
              Start with something you noticed. We can follow the clues
              together.
            </p>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`chat-message ${m.role}`}>
            <small>{m.role === "user" ? "YOU" : "ASSISTANT"}</small>
            <div>{m.content || (streaming ? "Thinking…" : "")}</div>
          </div>
        ))}
        <div ref={end} />
      </div>
      {error && (
        <p className="chat-error" role="alert">
          {error}
        </p>
      )}
      <form
        className="chat-compose"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <label className="context-toggle">
          <input
            type="checkbox"
            checked={context}
            onChange={(e) => setContext(e.target.checked)}
          />
          Include selected target & run
        </label>
        <textarea
          aria-label="Message assistant"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="What are you curious about?"
        />
        <div>
          <button
            type="button"
            disabled={streaming}
            onClick={() => {
              setMessages([]);
              setError("");
            }}
          >
            New chat
          </button>
          {streaming ? (
            <button type="button" onClick={() => controller.current?.abort()}>
              <Square size={14} />
              Stop
            </button>
          ) : (
            <button className="primary" disabled={!model || !prompt.trim()}>
              <ArrowRight size={16} />
              Send
            </button>
          )}
        </div>
        <small>
          {provider === "ollama"
            ? "Via Ollama · cloud models run remotely"
            : provider === "lmstudio"
              ? "Runs in LM Studio on this Mac"
              : provider === "huggingface"
                ? model.startsWith("hf.co/")
                  ? "Runs in Ollama on this Mac"
                  : "Sent to Hugging Face Inference when you ask"
                : `Sent to ${provider === "openrouter" ? "OpenRouter" : pretty(provider)} when you ask`}
        </small>
      </form>
    </aside>
  );
}
