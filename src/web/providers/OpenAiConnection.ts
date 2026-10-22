import { randomBytes, randomUUID, createHash } from "node:crypto";
import { readFile, mkdir, chmod } from "node:fs/promises";
import { join } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { WebFailure, providerJson } from "../WebFailure.js";

const credentialSchema = z.object({
  clientId: z.string(),
  subject: z.string(),
  email: z.string(),
  accessToken: z.string(),
  refreshToken: z.string(),
  idToken: z.string(),
  expiresAt: z.number(),
  scopes: z.array(z.string()),
});
const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  id_token: z.string().optional(),
  expires_in: z.number().positive(),
  scope: z.string().optional(),
});
const optionsSchema = z.object({
  issuer: z.string().url(),
  authorize: z.string().url(),
  token: z.string().url(),
  jwks: z.string().url(),
});
type Credentials = z.infer<typeof credentialSchema>;
type Pending = {
  state: string;
  nonce: string;
  verifier: string;
  createdAt: number;
  clientId: string;
  subject?: string;
};
const endpoints = optionsSchema.parse({
  issuer: "https://auth.openai.com",
  authorize: "https://auth.openai.com/api/accounts/authorize",
  token: "https://auth.openai.com/api/accounts/oauth/token",
  jwks: "https://auth.openai.com/.well-known/jwks.json",
});

/** Oopsware-owned OAuth registration. Tokens never cross the browser API boundary. */
export class OpenAiConnection {
  #pending: Pending | undefined;
  #credentials: Credentials | undefined;
  #hostId = "";
  #refresh: Promise<string> | undefined;
  #lastError: string | undefined;
  constructor(
    readonly directory: string,
    readonly callback: string,
    readonly urls = endpoints,
  ) {}

  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    try {
      this.#hostId = z
        .string()
        .uuid()
        .parse(
          (await readFile(join(this.directory, "host-id"), "utf8")).trim(),
        );
    } catch (error) {
      if (!isMissing(error)) throw error;
      this.#hostId = randomUUID();
      await writeFileAtomic(join(this.directory, "host-id"), this.#hostId, {
        mode: 0o600,
      });
    }
    try {
      this.#credentials = credentialSchema.parse(
        JSON.parse(await readFile(join(this.directory, "openai.json"), "utf8")),
      );
    } catch (error) {
      if (!isMissing(error))
        this.#lastError =
          "Saved OpenAI connection could not be read. Sign in again.";
    }
  }

  status() {
    return {
      connected: this.#credentials !== undefined,
      email: this.#credentials?.email,
      pending:
        this.#pending !== undefined &&
        Date.now() - this.#pending.createdAt < 600_000,
      error: this.#lastError,
    };
  }

  start(): { url: string } {
    const saved = this.#credentials;
    const pending: Pending = {
      state: randomBytes(32).toString("base64url"),
      nonce: randomBytes(32).toString("base64url"),
      verifier: randomBytes(48).toString("base64url"),
      createdAt: Date.now(),
      clientId: saved?.clientId ?? "dynamic_agent_client",
      ...(saved ? { subject: saved.subject } : {}),
    };
    this.#pending = pending;
    this.#lastError = undefined;
    const url = new URL(this.urls.authorize);
    const params = {
      client_id: pending.clientId,
      ext_agent_host_id: `urn:uuid:${this.#hostId}`,
      response_type: "code",
      redirect_uri: this.callback,
      scope:
        "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
      resource: "https://api.openai.com/v1",
      state: pending.state,
      nonce: pending.nonce,
      code_challenge_method: "S256",
      code_challenge: createHash("sha256")
        .update(pending.verifier)
        .digest("base64url"),
    };
    for (const [key, value] of Object.entries(params))
      url.searchParams.set(key, value);
    if (saved) url.searchParams.set("id_token_hint", saved.idToken);
    else url.searchParams.set("agent_name_hint", "Oopsware");
    return { url: url.toString() };
  }

  async complete(params: URLSearchParams): Promise<void> {
    const pending = this.#pending;
    if (
      !pending ||
      Date.now() - pending.createdAt > 600_000 ||
      params.get("state") !== pending.state
    )
      throw new WebFailure(
        400,
        "oauth_state_invalid",
        "Sign-in expired or did not match Oopsware's request. Start sign-in again.",
      );
    this.#pending = undefined;
    try {
      if (params.has("error"))
        throw new WebFailure(
          400,
          "oauth_declined",
          "Sign-in was declined. You can continue with a local model or try again.",
        );
      const code = params.get("code");
      const clientId = params.get("client_id") ?? pending.clientId;
      if (
        !code ||
        clientId === "dynamic_agent_client" ||
        (pending.clientId !== "dynamic_agent_client" &&
          clientId !== pending.clientId)
      )
        throw new WebFailure(
          400,
          "oauth_registration_incomplete",
          "OpenAI did not return the expected Oopsware client registration. Start sign-in again.",
        );
      const tokens = tokenSchema.parse(
        await this.#exchange({
          grant_type: "authorization_code",
          client_id: clientId,
          code,
          code_verifier: pending.verifier,
          redirect_uri: this.callback,
          resource: "https://api.openai.com/v1",
        }),
      );
      if (!tokens.id_token || !tokens.refresh_token)
        throw new WebFailure(
          400,
          "oauth_tokens_missing",
          "OpenAI did not issue complete sign-in credentials. Sign in again.",
        );
      const { payload } = await jwtVerify(
        tokens.id_token,
        createRemoteJWKSet(new URL(this.urls.jwks)),
        {
          issuer: this.urls.issuer,
          audience: clientId,
          requiredClaims: ["sub", "exp", "nonce"],
        },
      );
      if (
        payload.nonce !== pending.nonce ||
        typeof payload.sub !== "string" ||
        (pending.subject && payload.sub !== pending.subject)
      )
        throw new WebFailure(
          400,
          "oauth_identity_mismatch",
          "The returned account did not match this sign-in attempt.",
        );
      const scopes = (tokens.scope ?? "").split(/\s+/);
      this.#assertScope(scopes);
      await this.#save({
        clientId,
        subject: payload.sub,
        email:
          typeof payload.email === "string" ? payload.email : "ChatGPT account",
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        idToken: tokens.id_token,
        expiresAt: Date.now() + tokens.expires_in * 1000,
        scopes,
      });
      this.#lastError = undefined;
    } catch (error) {
      this.#lastError =
        error instanceof WebFailure
          ? error.message
          : "OpenAI sign-in could not be verified. Start sign-in again.";
      throw new WebFailure(400, "oauth_failed", this.#lastError);
    }
  }

  async accessToken(): Promise<string> {
    const saved = this.#credentials;
    if (!saved)
      throw new WebFailure(
        401,
        "openai_not_connected",
        "Use Continue with ChatGPT to connect Oopsware first.",
      );
    if (saved.expiresAt > Date.now() + 60_000) return saved.accessToken;
    if (this.#refresh) return this.#refresh;
    this.#refresh = this.#renew(saved).finally(() => {
      this.#refresh = undefined;
    });
    return this.#refresh;
  }

  async #renew(saved: Credentials): Promise<string> {
    const tokens = tokenSchema.parse(
      await this.#exchange({
        grant_type: "refresh_token",
        client_id: saved.clientId,
        refresh_token: saved.refreshToken,
        resource: "https://api.openai.com/v1",
      }),
    );
    const scopes = tokens.scope ? tokens.scope.split(/\s+/) : saved.scopes;
    this.#assertScope(scopes);
    await this.#save({
      ...saved,
      scopes,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? saved.refreshToken,
      idToken: tokens.id_token ?? saved.idToken,
      expiresAt: Date.now() + tokens.expires_in * 1000,
    });
    return tokens.access_token;
  }

  #assertScope(scopes: string[]): void {
    if (!scopes.includes("chatgpt.tokens.use.direct"))
      throw new WebFailure(
        403,
        "chatgpt_plan_not_enabled",
        "This account has not enabled ChatGPT plan use for Oopsware. Sign in and grant that permission, or choose a local model.",
      );
  }
  async #exchange(body: Record<string, string>): Promise<unknown> {
    return providerJson(
      await fetch(this.urls.token, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(body),
        signal: AbortSignal.timeout(30_000),
      }),
    );
  }
  async #save(value: Credentials): Promise<void> {
    await writeFileAtomic(
      join(this.directory, "openai.json"),
      JSON.stringify(value),
      { mode: 0o600 },
    );
    this.#credentials = value;
  }
}
const isMissing = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ENOENT";
