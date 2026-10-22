import { useState } from "react";
import { z } from "zod";
import { api } from "./api";

const accountSchema = z.discriminatedUnion("connected", [
  z.object({ connected: z.literal(true), name: z.string() }),
  z.object({ connected: z.literal(false), url: z.url() }),
]);

/** Browser sign-in delegated to the user's installed Ollama server. */
export function OllamaAccount({ refresh }: { refresh: () => void }) {
  const [account, setAccount] = useState<z.infer<typeof accountSchema>>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function check() {
    setBusy(true);
    setError("");
    setAccount(undefined);
    try {
      setAccount(await api("/api/auth/ollama", {}, accountSchema));
      refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      {account?.connected === false && (
        <p>
          <a href={account.url} target="_blank" rel="noopener noreferrer">
            Continue to Ollama sign-in
          </a>
          . Finish in the new tab, then check sign-in here.
        </p>
      )}
      {account?.connected && (
        <p role="status">Signed in to Ollama as {account.name}.</p>
      )}
      {error && <p role="alert">{error}</p>}
      <button disabled={busy} onClick={() => void check()}>
        {busy
          ? "Checking Ollama…"
          : account
            ? "Check sign-in"
            : "Sign in for cloud models"}
      </button>
      <p>
        Ollama manages this account. Cloud models send messages to Ollama's
        cloud.
      </p>
    </div>
  );
}
