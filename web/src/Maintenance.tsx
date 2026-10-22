import { HelpHint } from "./components/Hint";
import { useEffect, useState, type ReactNode } from "react";
import {
  Activity,
  Cable,
  Download,
  RefreshCw,
  Terminal,
  Wrench,
} from "lucide-react";
import "./maintenance.css";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./components/ui/tabs";

type Info = {
  version: string;
  clients: { name: string; displayName: string }[];
  commands: string[];
};
type Output = { action?: string; result?: unknown };
type IntegrationSettings = {
  clients: string[];
  allDetected: boolean;
  installSkill: boolean;
  installHopper: boolean;
};
const INTEGRATION_SETTINGS_KEY = "rea-agent-integrations";
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};

function savedIntegrationSettings(): IntegrationSettings {
  let saved: Record<string, unknown> = {};
  try {
    saved = record(
      JSON.parse(localStorage.getItem(INTEGRATION_SETTINGS_KEY) ?? "{}"),
    );
  } catch {
    // Defaults keep setup usable if browser storage is unavailable or invalid.
  }
  return {
    clients: Array.isArray(saved.clients)
      ? saved.clients.filter(
          (client): client is string => typeof client === "string",
        )
      : [],
    allDetected: saved.allDetected === true,
    installSkill: saved.installSkill !== false,
    installHopper: saved.installHopper === true,
  };
}

async function request(body?: unknown): Promise<unknown> {
  const token =
    document.querySelector<HTMLMetaElement>('meta[name="rea-token"]')
      ?.content ?? "";
  const response = await fetch("/api/maintenance", {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", "x-rea-token": token },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data: unknown = await response.json();
  if (!response.ok)
    throw new Error(
      String(
        record(data).message ??
          "Maintenance request failed. Reload Oopsware and try again.",
      ),
    );
  return data;
}

/** Existing setup, diagnostics and installation workflows in the local workspace. */
export function Maintenance({ sessionTools }: { sessionTools?: ReactNode }) {
  const [info, setInfo] = useState<Info>({
    version: "",
    clients: [],
    commands: [],
  });
  const [integrationSettings, setIntegrationSettings] = useState(
    savedIntegrationSettings,
  );
  const {
    clients,
    allDetected: detected,
    installSkill: skill,
    installHopper: hopper,
  } = integrationSettings;
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [output, setOutput] = useState<Output | null>(null);
  const [planId, setPlanId] = useState("");
  const [command, setCommand] = useState("");
  const [shell, setShell] = useState("zsh");
  useEffect(() => {
    try {
      localStorage.setItem(
        INTEGRATION_SETTINGS_KEY,
        JSON.stringify(integrationSettings),
      );
    } catch {
      // Choices still work for this page when browser storage is unavailable.
    }
  }, [integrationSettings]);
  useEffect(() => {
    void request()
      .then((data) => {
        const value = record(data);
        const nextInfo: Info = {
          version: String(value.version ?? ""),
          clients: Array.isArray(value.clients)
            ? value.clients.map((client: unknown) => ({
                name: String(record(client).name),
                displayName: String(record(client).displayName),
              }))
            : [],
          commands: Array.isArray(value.commands)
            ? value.commands.filter(
                (entry): entry is string => typeof entry === "string",
              )
            : [],
        };
        setInfo(nextInfo);
        setIntegrationSettings((current) => ({
          ...current,
          clients: current.clients.filter((name) =>
            nextInfo.clients.some((client) => client.name === name),
          ),
        }));
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      );
  }, []);

  function updateIntegrationSettings(changes: Partial<IntegrationSettings>) {
    setPlanId("");
    setIntegrationSettings((current) => ({ ...current, ...changes }));
  }

  async function run(action: string, options: Record<string, unknown> = {}) {
    setBusy(action);
    setError("");
    setPlanId("");
    try {
      const data = record(await request({ action, ...options }));
      setOutput({ action, result: data.result });
      if (
        action === "setup-preview" &&
        typeof record(data.result).planId === "string"
      )
        setPlanId(String(record(data.result).planId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy("");
    }
  }
  function download() {
    if (!output) return;
    const result = record(output.result);
    const plain = typeof result.text === "string";
    const content = plain
      ? String(result.text)
      : JSON.stringify(output, null, 2);
    const url = URL.createObjectURL(
      new Blob([content], { type: plain ? "text/plain" : "application/json" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `rea-${output.action ?? "report"}.${plain ? "txt" : "json"}`;
    anchor.click();
    URL.revokeObjectURL(url);
  }
  const outputText = output
    ? typeof record(output.result).text === "string"
      ? String(record(output.result).text)
      : JSON.stringify(output.result, null, 2)
    : "";
  return (
    <div className="maintenance">
      <Tabs defaultValue="diagnostics" className="maintenance-tabs">
        <TabsList
          aria-label="Connection management"
          className="maintenance-nav"
        >
          <TabsTrigger value="diagnostics">Diagnostics</TabsTrigger>
          <TabsTrigger value="integrations">Agent integrations</TabsTrigger>
          <TabsTrigger value="reference">Command reference</TabsTrigger>
          <TabsTrigger value="installation">Installation</TabsTrigger>
        </TabsList>
        <TabsContent value="diagnostics" className="maintenance-card">
          <h3>
            <Activity size={18} /> Diagnostics{" "}
            <span className="maintenance-version">v{info.version}</span>
            <HelpHint label="Diagnostics help">
              Check local engines, capabilities, and the agent connection.
            </HelpHint>
          </h3>
          <div className="maintenance-actions">
            <button disabled={!!busy} onClick={() => void run("doctor")}>
              Run health check
            </button>
            <button disabled={!!busy} onClick={() => void run("providers")}>
              Providers
            </button>
            <button disabled={!!busy} onClick={() => void run("capabilities")}>
              Capabilities
            </button>
            <button disabled={!!busy} onClick={() => void run("mcp-doctor")}>
              Test MCP connection
            </button>
          </div>
          {sessionTools}
        </TabsContent>
        <TabsContent value="integrations" className="maintenance-card">
          <h3>
            <Cable size={18} /> Agent integrations
            <HelpHint label="Agent setup help">
              Select agents, preview the file changes, then apply the plan.
            </HelpHint>
          </h3>
          <div className="maintenance-clients">
            {info.clients.map((client) => (
              <label key={client.name}>
                <input
                  type="checkbox"
                  checked={clients.includes(client.name)}
                  onChange={(event) => {
                    updateIntegrationSettings({
                      clients: event.target.checked
                        ? [...clients, client.name]
                        : clients.filter((id) => id !== client.name),
                    });
                  }}
                />
                {client.displayName}
              </label>
            ))}
          </div>
          <label>
            <input
              type="checkbox"
              checked={detected}
              onChange={(e) => {
                updateIntegrationSettings({ allDetected: e.target.checked });
              }}
            />{" "}
            Include all detected agents
          </label>
          <label>
            <input
              type="checkbox"
              checked={skill}
              onChange={(e) => {
                updateIntegrationSettings({ installSkill: e.target.checked });
              }}
            />{" "}
            Install or refresh Oopsware skills
          </label>
          <label>
            <input
              type="checkbox"
              checked={hopper}
              onChange={(e) => {
                updateIntegrationSettings({ installHopper: e.target.checked });
              }}
            />{" "}
            Include Hopper installation in the plan
          </label>
          <div className="maintenance-actions">
            <button
              disabled={!!busy}
              onClick={() =>
                void run("setup-preview", {
                  clients,
                  allDetected: detected,
                  installSkill: skill,
                  installHopper: hopper,
                })
              }
            >
              Preview setup changes
            </button>
            {planId && (
              <button
                className="maintenance-primary"
                disabled={!!busy}
                onClick={() => void run("setup-apply", { planId })}
              >
                Apply reviewed plan
              </button>
            )}
          </div>
        </TabsContent>
        <TabsContent value="reference" className="maintenance-card">
          <h3>
            <Terminal size={18} /> Command reference
            <HelpHint label="Command reference help">
              Read command help or download shell completions.
            </HelpHint>
          </h3>
          <label>
            Command
            <select
              value={command}
              onChange={(e) => setCommand(e.target.value)}
            >
              <option value="">All commands</option>
              {info.commands.map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>
          </label>
          <div className="maintenance-actions">
            <button
              disabled={!!busy}
              onClick={() => void run("help", command ? { command } : {})}
            >
              Show help
            </button>
          </div>
          <label>
            Shell
            <select value={shell} onChange={(e) => setShell(e.target.value)}>
              {["zsh", "bash", "fish", "nushell"].map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>
          </label>
          <button
            disabled={!!busy}
            onClick={() => void run("completions", { shell })}
          >
            Generate completions
          </button>
        </TabsContent>
        <TabsContent value="installation" className="maintenance-card">
          <h3>
            <Wrench size={18} /> Installation
            <HelpHint label="Installation help">
              Update Oopsware or remove its agent files. Existing ownership and
              backup checks apply.
            </HelpHint>
          </h3>
          <button
            disabled={!!busy}
            onClick={() => {
              if (
                window.confirm(
                  "Update this Oopsware installation and verify the installed release? A restart may be needed afterward.",
                )
              )
                void run("update");
            }}
          >
            <RefreshCw size={14} /> Update installation
          </button>
          <details>
            <summary>Remove integrations or local data</summary>
            <p>
              These actions remove Oopsware-owned configuration. Purging also
              removes Oopsware caches and state.
            </p>
            <button
              disabled={!!busy}
              onClick={() => {
                if (
                  window.confirm(
                    "Remove Oopsware-owned agent configuration and skill files?",
                  )
                )
                  void run("uninstall", { purgeData: false });
              }}
            >
              Remove integrations
            </button>
            <button
              className="maintenance-danger"
              disabled={!!busy}
              onClick={() => {
                if (
                  window.confirm(
                    "Remove Oopsware-owned integrations AND permanently purge Oopsware caches and state?",
                  )
                )
                  void run("uninstall", { purgeData: true });
              }}
            >
              Remove and purge data
            </button>
          </details>
        </TabsContent>
      </Tabs>
      {busy && (
        <div role="status" className="maintenance-status">
          Running {busy.replaceAll("-", " ")}… Keep this page open until the
          action finishes.
        </div>
      )}
      {error && (
        <div role="alert" className="maintenance-error">
          {error}
        </div>
      )}
      {output && (
        <section className="maintenance-card maintenance-output">
          <div className="maintenance-output-heading">
            <h3>{output.action?.replaceAll("-", " ")}</h3>
            <button onClick={download}>
              <Download size={15} /> Download complete result
            </button>
          </div>
          {outputText.length > 80000 && (
            <p>
              Showing the first 80,000 characters. Download the complete result
              above.
            </p>
          )}
          <pre>{outputText.slice(0, 80000)}</pre>
        </section>
      )}
    </div>
  );
}
