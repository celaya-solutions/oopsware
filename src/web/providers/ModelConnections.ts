import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";
import type { OpenAiConnection } from "./OpenAiConnection.js";
import { WebFailure, providerJson } from "../WebFailure.js";
import {
  huggingFaceHome,
  scanHuggingFaceCache,
  scanLmStudioFolder,
} from "./LocalModels.js";

export const modelProviderSchema = z.enum([
  "openai",
  "claude",
  "ollama",
  "huggingface",
  "lmstudio",
  "openrouter",
]);
export type ModelProvider = z.infer<typeof modelProviderSchema>;
export type ModelChoice = { id: string; name: string; cloud?: boolean };
type Environment = Readonly<Record<string, string | undefined>>;

/** Every remote and local endpoint this module calls; tests replace them with fixtures. */
export type ModelEndpoints = {
  ollama: string;
  ollamaCloud: string;
  lmStudio: string;
  huggingFace: string;
  huggingFaceRouter: string;
  openRouter: string;
  openai: string;
  anthropic: string;
};
export const defaultModelEndpoints: ModelEndpoints = {
  ollama: "http://127.0.0.1:11434",
  ollamaCloud: "https://ollama.com",
  lmStudio: "http://127.0.0.1:1234",
  huggingFace: "https://huggingface.co",
  huggingFaceRouter: "https://router.huggingface.co",
  openRouter: "https://openrouter.ai",
  openai: "https://api.openai.com",
  anthropic: "https://api.anthropic.com",
};

const ollamaModels = z.object({
  models: z.array(
    z.object({ name: z.string(), remote_model: z.string().optional() }),
  ),
});
const claudeModels = z.object({
  data: z.array(z.object({ id: z.string(), display_name: z.string() })),
});
/** OpenAI-compatible list shape: public OpenAI API, OpenRouter, Hugging Face router, LM Studio /v1. */
const openAiCompatibleModels = z.object({
  data: z.array(z.object({ id: z.string(), name: z.string().optional() })),
});
/** ChatGPT-account model catalog shape, which some OpenAI account tokens receive. */
const openAiAccountModels = z.object({
  models: z.array(
    z.object({
      slug: z.string(),
      display_name: z.string(),
      visibility: z.string(),
    }),
  ),
});
/** LM Studio native REST list (GET /api/v1/models). */
const lmStudioModels = z.object({
  models: z.array(
    z.object({
      key: z.string(),
      display_name: z.string().optional(),
      type: z.string().optional(),
    }),
  ),
});
const savedKey = z.object({ apiKey: z.string().min(1) });
type SecretProvider = "claude" | "huggingface" | "openrouter";
type SecretSource = "saved" | "environment" | "huggingface-cli";

const isMissing = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ENOENT";

/** Model discovery and credentials owned by Oopsware, independent of external AI clients. */
export class ModelConnections {
  readonly endpoints: ModelEndpoints;
  readonly environment: Environment;
  #secrets = new Map<SecretProvider, { key: string; source: SecretSource }>();
  /** undefined = not checked yet; null = the check failed (checked once per key). */
  #huggingFaceUser: string | null | undefined;
  constructor(
    readonly openai: OpenAiConnection,
    options: {
      endpoints?: Partial<ModelEndpoints>;
      environment?: Environment;
    } = {},
  ) {
    this.endpoints = { ...defaultModelEndpoints, ...options.endpoints };
    this.environment = options.environment ?? process.env;
  }
  get localUrl(): string {
    return this.endpoints.ollama;
  }
  async initialize(): Promise<void> {
    await this.openai.initialize();
    for (const provider of ["claude", "huggingface", "openrouter"] as const) {
      try {
        this.#secrets.set(provider, {
          key: savedKey.parse(
            JSON.parse(
              await readFile(
                join(this.openai.directory, `${provider}.json`),
                "utf8",
              ),
            ),
          ).apiKey,
          source: "saved",
        });
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    await this.#loadSharedKeys();
  }
  /** Keys owned by the environment or the hf CLI; used whenever Oopsware has no saved key. */
  async #loadSharedKeys(): Promise<void> {
    if (!this.#secrets.has("huggingface")) {
      // Reuse an existing `hf auth login` or HF_TOKEN without copying it into Oopsware's folder.
      const fromEnvironment = this.environment.HF_TOKEN?.trim();
      if (fromEnvironment)
        this.#secrets.set("huggingface", {
          key: fromEnvironment,
          source: "environment",
        });
      else
        try {
          const token = (
            await readFile(
              this.environment.HF_TOKEN_PATH ??
                join(huggingFaceHome(this.environment), "token"),
              "utf8",
            )
          ).trim();
          if (token)
            this.#secrets.set("huggingface", {
              key: token,
              source: "huggingface-cli",
            });
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
    }
    if (!this.#secrets.has("openrouter")) {
      const fromEnvironment = this.environment.OPENROUTER_API_KEY?.trim();
      if (fromEnvironment)
        this.#secrets.set("openrouter", {
          key: fromEnvironment,
          source: "environment",
        });
    }
  }
  async #save(provider: SecretProvider, apiKey: string) {
    await writeFileAtomic(
      join(this.openai.directory, `${provider}.json`),
      JSON.stringify({ apiKey }),
      { mode: 0o600 },
    );
    this.#secrets.set(provider, { key: apiKey, source: "saved" });
  }
  /**
   * Forget a key Oopsware saved. Keys from the environment or the hf CLI stay with their owner,
   * so the provider may still be connected afterwards; the result says which key is in use.
   */
  async disconnect(
    provider: SecretProvider,
  ): Promise<{ connected: boolean; source?: SecretSource }> {
    await rm(join(this.openai.directory, `${provider}.json`), { force: true });
    if (this.#secrets.get(provider)?.source === "saved") {
      this.#secrets.delete(provider);
      if (provider === "huggingface") this.#huggingFaceUser = undefined;
      await this.#loadSharedKeys();
    }
    const remaining = this.#secrets.get(provider);
    return remaining
      ? { connected: true, source: remaining.source }
      : { connected: false };
  }
  async connectClaude(apiKey: string): Promise<void> {
    await providerJson(
      await fetch(`${this.endpoints.anthropic}/v1/models`, {
        headers: this.claudeHeaders(apiKey),
        signal: AbortSignal.timeout(20_000),
      }),
    );
    await this.#save("claude", apiKey);
  }
  /** Check a Hugging Face access token with whoami, then keep it in Oopsware's private folder. */
  async connectHuggingFace(apiKey: string): Promise<{ name: string }> {
    const name = await this.#whoami(apiKey);
    await this.#save("huggingface", apiKey);
    this.#huggingFaceUser = name;
    return { name };
  }
  async #whoami(apiKey: string, timeout = 20_000): Promise<string> {
    const response = await fetch(
      `${this.endpoints.huggingFace}/api/whoami-v2`,
      {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(timeout),
      },
    );
    if (response.status === 401)
      throw new WebFailure(
        401,
        "huggingface_token_rejected",
        "Hugging Face rejected this token. Create a token at huggingface.co/settings/tokens and paste it again.",
      );
    return z
      .object({ name: z.string().min(1) })
      .parse(await providerJson(response)).name;
  }
  /** Check an OpenRouter key against its key endpoint, then save it. */
  async connectOpenRouter(apiKey: string): Promise<void> {
    const response = await fetch(`${this.endpoints.openRouter}/api/v1/key`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 401)
      throw new WebFailure(
        401,
        "openrouter_key_rejected",
        "OpenRouter rejected this key. Create one at openrouter.ai/settings/keys and paste it again.",
      );
    await providerJson(response);
    await this.#save("openrouter", apiKey);
  }
  /** Use the local Ollama daemon's account flow; Ollama owns its credentials. */
  async connectOllama() {
    let response: Response;
    try {
      response = await fetch(`${this.endpoints.ollama}/api/me`, {
        method: "POST",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new WebFailure(
        503,
        "ollama_unavailable",
        "Start Ollama, then check sign-in again.",
      );
    }
    if (response.status === 401) {
      const body = z
        .object({ signin_url: z.url() })
        .safeParse(await response.json());
      if (!body.success)
        throw new WebFailure(
          502,
          "ollama_signin_unavailable",
          "Ollama did not return a sign-in link. Use ollama signin in Terminal.",
        );
      const url = new URL(body.data.signin_url);
      if (
        url.origin !== "https://ollama.com" ||
        url.pathname !== "/connect" ||
        url.username ||
        url.password
      )
        throw new WebFailure(
          502,
          "ollama_signin_url_invalid",
          "Ollama returned an unexpected sign-in address. Use ollama signin in Terminal.",
        );
      return { connected: false as const, url: url.href };
    }
    if (response.status === 404)
      throw new WebFailure(
        502,
        "ollama_signin_unavailable",
        "This Ollama server does not support cloud sign-in. Update Ollama and try again.",
      );
    const account = z
      .object({ name: z.string().min(1) })
      .parse(await providerJson(response));
    return { connected: true as const, name: account.name };
  }
  claudeHeaders(
    key = this.#secrets.get("claude")?.key,
  ): Record<string, string> {
    if (!key)
      throw new WebFailure(
        401,
        "claude_not_connected",
        "Connect Claude with an Anthropic API key in Models.",
      );
    return {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    };
  }
  /** Bearer headers for the OpenAI-compatible providers Oopsware holds a key for. */
  bearerHeaders(
    provider: "huggingface" | "openrouter" | "lmstudio",
  ): Record<string, string> {
    if (provider === "lmstudio") {
      const token = this.environment.LM_API_TOKEN;
      return {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      };
    }
    const key = this.#secrets.get(provider)?.key;
    if (!key)
      throw new WebFailure(
        401,
        `${provider}_not_connected`,
        provider === "huggingface"
          ? "Add a Hugging Face token in Connections to use Hugging Face hosted models."
          : "Add an OpenRouter API key in Connections to chat with OpenRouter models.",
      );
    return {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(provider === "openrouter"
        ? { "X-Title": "Oopsware", "HTTP-Referer": "http://127.0.0.1" }
        : {}),
    };
  }
  async status() {
    const settle = async (provider: ModelProvider) => {
      try {
        return { models: await this.models(provider) };
      } catch (error) {
        return {
          models: [] as ModelChoice[],
          error:
            error instanceof WebFailure
              ? error.message
              : "The provider did not answer.",
        };
      }
    };
    const [local, lmStudio] = await Promise.all([
      settle("ollama"),
      settle("lmstudio"),
    ]);
    const huggingFace = this.#secrets.get("huggingface");
    if (huggingFace && this.#huggingFaceUser === undefined)
      this.#huggingFaceUser = await this.#whoami(huggingFace.key, 8_000).catch(
        () => null,
      );
    const openRouter = this.#secrets.get("openrouter");
    return {
      defaultProvider: "openai",
      openai: this.openai.status(),
      claude: { connected: this.#secrets.has("claude") },
      ollama: {
        connected: local.error === undefined,
        models: local.models,
        error:
          local.error === undefined
            ? undefined
            : "Ollama is unavailable. Start Ollama, then refresh Models.",
      },
      huggingface: {
        connected: huggingFace !== undefined,
        tokenSource: huggingFace?.source,
        name: this.#huggingFaceUser ?? undefined,
        error:
          this.#huggingFaceUser === null
            ? "Hugging Face did not accept the token. Paste a new one."
            : undefined,
        models: local.models.filter((m) => m.id.startsWith("hf.co/")),
      },
      lmstudio: {
        connected: lmStudio.error === undefined,
        models: lmStudio.models,
        error: lmStudio.error,
      },
      openrouter: {
        connected: openRouter !== undefined,
        keySource: openRouter?.source,
      },
    };
  }
  async models(provider: ModelProvider): Promise<ModelChoice[]> {
    if (provider === "openai") {
      const token = await this.openai.accessToken();
      const body = await providerJson(
        await fetch(`${this.endpoints.openai}/v1/models`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(20_000),
        }),
      );
      return parseOpenAiModels(body);
    }
    if (provider === "claude") {
      const body = claudeModels.parse(
        await providerJson(
          await fetch(`${this.endpoints.anthropic}/v1/models`, {
            headers: this.claudeHeaders(),
            signal: AbortSignal.timeout(20_000),
          }),
        ),
      );
      return body.data.map((m) => ({ id: m.id, name: m.display_name }));
    }
    if (provider === "openrouter") {
      // OpenRouter's catalog is public; chatting still needs the user's key.
      const body = openAiCompatibleModels.parse(
        await providerJson(
          await fetch(`${this.endpoints.openRouter}/api/v1/models`, {
            signal: AbortSignal.timeout(20_000),
          }),
        ),
      );
      return body.data
        .map((m) => ({ id: m.id, name: m.name ?? m.id, cloud: true }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }
    if (provider === "lmstudio") return this.#lmStudioModels();
    const installed = await this.#ollamaModels();
    if (provider === "ollama") return installed;
    const local = installed.filter((m) => m.id.startsWith("hf.co/"));
    if (!this.#secrets.has("huggingface")) return local;
    let hosted: z.infer<typeof openAiCompatibleModels>;
    try {
      hosted = openAiCompatibleModels.parse(
        await providerJson(
          await fetch(`${this.endpoints.huggingFaceRouter}/v1/models`, {
            headers: this.bearerHeaders("huggingface"),
            signal: AbortSignal.timeout(20_000),
          }),
        ),
      );
    } catch (error) {
      // A rejected or unreachable HF Inference list must not hide models already installed in Ollama.
      // Connections reports the token problem separately through whoami.
      if (local.length === 0) throw error;
      return local;
    }
    return [
      ...local.map((m) => ({ ...m, name: `${m.name} · local Ollama` })),
      ...hosted.data.map((m) => ({
        id: m.id,
        name: `${m.id} · HF Inference`,
        cloud: true,
      })),
    ];
  }
  async #ollamaModels(): Promise<ModelChoice[]> {
    let response: Response;
    try {
      response = await fetch(`${this.endpoints.ollama}/api/tags`, {
        signal: AbortSignal.timeout(4_000),
      });
    } catch {
      throw new WebFailure(
        503,
        "ollama_unavailable",
        "Ollama is not running. Start Ollama, then refresh.",
      );
    }
    return ollamaModels
      .parse(await providerJson(response))
      .models.map((m) =>
        m.remote_model
          ? { id: m.name, name: `${m.name} · cloud`, cloud: true }
          : { id: m.name, name: m.name },
      );
  }
  /** LM Studio's native list names every downloaded model; /v1/models is the older fallback. */
  async #lmStudioModels(): Promise<ModelChoice[]> {
    const get = async (path: string) => {
      try {
        return await fetch(`${this.endpoints.lmStudio}${path}`, {
          headers: this.bearerHeaders("lmstudio"),
          signal: AbortSignal.timeout(4_000),
        });
      } catch {
        throw new WebFailure(
          503,
          "lmstudio_unavailable",
          "LM Studio's server is off. Start it in LM Studio (Developer > Start server) or run lms server start, then refresh.",
        );
      }
    };
    const native = await get("/api/v1/models");
    if (native.ok) {
      const body = lmStudioModels.safeParse(await native.json());
      if (body.success)
        return body.data.models
          .filter((m) => m.type === undefined || m.type === "llm")
          .map((m) => ({ id: m.key, name: m.display_name ?? m.key }));
    }
    if (native.status === 401)
      throw new WebFailure(
        401,
        "lmstudio_token_required",
        "LM Studio requires an API token. Set LM_API_TOKEN before starting Oopsware.",
      );
    return openAiCompatibleModels
      .parse(await providerJson(await get("/v1/models")))
      .data.map((m) => ({ id: m.id, name: m.name ?? m.id }));
  }
  /** Everything Oopsware can find on this computer without a network call. */
  async discover() {
    const [ollama, lmstudio, lmStudioFolder, huggingFaceCache] =
      await Promise.all([
        this.#ollamaModels().then(
          (models) => ({ running: true, models }),
          () => ({ running: false, models: [] as ModelChoice[] }),
        ),
        this.#lmStudioModels().then(
          (models) => ({ running: true, models }),
          (error: unknown) => ({
            running: false,
            models: [] as ModelChoice[],
            error: error instanceof WebFailure ? error.message : undefined,
          }),
        ),
        scanLmStudioFolder(this.environment),
        scanHuggingFaceCache(this.environment),
      ]);
    return { ollama, lmstudio, lmStudioFolder, huggingFaceCache };
  }
}

/** Accept the public OpenAI API shape and the ChatGPT-account catalog shape. */
export const parseOpenAiModels = (body: unknown): ModelChoice[] => {
  const account = openAiAccountModels.safeParse(body);
  if (account.success)
    return account.data.models
      .filter((m) => m.visibility === "list")
      .map((m) => ({ id: m.slug, name: m.display_name }));
  return openAiCompatibleModels
    .parse(body)
    .data.filter(
      (m) =>
        /^(gpt|o\d|chatgpt|codex)/.test(m.id) &&
        !/(image|audio|realtime|tts|transcribe|embedding|moderation)/.test(
          m.id,
        ),
    )
    .map((m) => ({ id: m.id, name: m.name ?? m.id }))
    .sort((a, b) => a.id.localeCompare(b.id));
};
