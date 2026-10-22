import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { runDoctor } from "../application/Doctor.js";
import { runSetup } from "../application/Setup.js";
import { systemSetupHost } from "../application/SetupHost.js";
import type { SetupAction, SetupOptions } from "../application/SetupTypes.js";
import { SUPPORTED_CLIENT_DEFINITIONS } from "../application/SupportedClients.js";
import { runUninstall, systemUninstallHost } from "../application/Uninstall.js";
import { runUpdate } from "../application/Update.js";
import { systemUpdateHost } from "../application/UpdateRuntime.js";
import { createDirectAnalysis } from "../composition/directAnalysis.js";
import { homeDirectoryFromEnvironment } from "../config/homeDirectory.js";
import { createSystemDoctorHost } from "../doctorRuntime.js";
import { PRODUCT_IDENTITY } from "../identity.js";
import { silentLogger } from "../logger.js";
import { runProductionMcpDoctor } from "../mcpDoctor.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { snapshotEnvironment } from "../process/snapshotEnvironment.js";
import { WebFailure } from "./WebFailure.js";

const clientId = z
  .string()
  .refine(
    (id) => SUPPORTED_CLIENT_DEFINITIONS.some((client) => client.name === id),
    "Choose a supported agent integration.",
  );
const requestSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("doctor"),
    target: z.string().optional(),
  }),
  z.strictObject({
    action: z.enum(["providers", "capabilities", "mcp-doctor", "update"]),
  }),
  z.strictObject({
    action: z.literal("help"),
    command: z.enum(CLI_COMMANDS).optional(),
  }),
  z.strictObject({
    action: z.literal("completions"),
    shell: z.enum(["bash", "fish", "nushell", "zsh"]),
  }),
  z.strictObject({
    action: z.literal("uninstall"),
    purgeData: z.boolean().default(false),
  }),
  z.strictObject({
    action: z.literal("setup-preview"),
    clients: z.array(clientId).default([]),
    skillClients: z.array(z.union([clientId, z.literal("shared")])).default([]),
    allDetected: z.boolean().default(false),
    installSkill: z.boolean().default(true),
    installHopper: z.boolean().default(false),
  }),
  z.strictObject({ action: z.literal("setup-apply"), planId: z.uuid() }),
]);
type Request = z.infer<typeof requestSchema>;
type Plan = { options: SetupOptions; digest: string };
const fingerprint = (actions: readonly SetupAction[]) =>
  createHash("sha256").update(JSON.stringify(actions)).digest("hex");

/** Named local maintenance workflows; never accepts a shell command or executable. */
export class MaintenanceService {
  readonly #environment: Readonly<NodeJS.ProcessEnv>;
  readonly #plans = new Map<string, Plan>();
  #pending: Promise<unknown> | undefined;
  #closing = false;

  constructor(environment: Readonly<NodeJS.ProcessEnv>) {
    this.#environment = snapshotEnvironment(environment);
  }

  /** Expose supported choices without probing or changing integrations. */
  describe() {
    return {
      version: PRODUCT_IDENTITY.packageVersion,
      clients: SUPPORTED_CLIENT_DEFINITIONS.map(({ name, displayName }) => ({
        name,
        displayName,
      })),
      commands: Object.values(CLI_COMMANDS),
    };
  }

  /** Validate, serialize, and execute one explicitly selected maintenance action. */
  async execute(input: unknown): Promise<unknown> {
    if (this.#closing)
      throw new WebFailure(503, "server_closing", "Oopsware is shutting down.");
    const request = requestSchema.parse(input);
    if (this.#pending !== undefined)
      throw new WebFailure(
        409,
        "maintenance_busy",
        "Another maintenance action is still running. Wait for its result.",
      );
    const pending = this.#execute(request);
    this.#pending = pending;
    try {
      return { action: request.action, result: await pending };
    } finally {
      this.#pending = undefined;
    }
  }

  /** Keep in-flight filesystem transactions owned through server shutdown. */
  async close(): Promise<void> {
    this.#closing = true;
    await this.#pending?.catch(() => undefined);
    this.#plans.clear();
  }

  async #execute(request: Request): Promise<unknown> {
    const environment = this.#environment;
    switch (request.action) {
      case "doctor":
        return runDoctor(request.target, createSystemDoctorHost(environment));
      case "providers":
      case "capabilities":
        return createDirectAnalysis(environment).runSessionStatus(silentLogger);
      case "mcp-doctor":
        return runProductionMcpDoctor({
          command: process.execPath,
          args: [
            fileURLToPath(new URL("../../scripts/rea.mjs", import.meta.url)),
            "--mcp",
          ],
          cwd: fileURLToPath(new URL("../../", import.meta.url)),
          environment,
        });
      case "update":
        return runUpdate(
          PRODUCT_IDENTITY.packageVersion,
          systemUpdateHost(undefined, undefined, environment),
          "structured",
        );
      case "uninstall":
        return runUninstall(
          request.purgeData,
          systemUninstallHost(
            homeDirectoryFromEnvironment(environment, process.platform),
            undefined,
            environment,
          ),
        );
      case "setup-preview": {
        const options: SetupOptions = {
          approved: false,
          structured: true,
          dryRun: true,
          installHopper: request.installHopper,
          proposeHopper: request.installHopper,
          clientIds: request.clients,
          ...(request.skillClients.length
            ? { skillClientIds: request.skillClients }
            : {}),
          allDetectedClients: request.allDetected,
          installSkill: request.installSkill,
        };
        const result = await runSetup(
          options,
          systemSetupHost(createSystemDoctorHost(environment), environment),
        );
        const planId = randomUUID();
        // Only the most recently reviewed plan can be applied by this server.
        this.#plans.clear();
        this.#plans.set(planId, {
          options,
          digest: fingerprint(result.plannedActions),
        });
        return { ...result, planId };
      }
      case "setup-apply": {
        const plan = this.#plans.get(request.planId);
        if (plan === undefined)
          throw new WebFailure(
            409,
            "setup_plan_required",
            "Preview the setup changes again before applying them.",
          );
        this.#plans.delete(request.planId);
        const result = await runSetup(
          {
            ...plan.options,
            dryRun: false,
            structured: false,
            approved: false,
          },
          systemSetupHost(createSystemDoctorHost(environment), environment),
          async (actions) => fingerprint(actions) === plan.digest,
        );
        return result.status === "cancelled"
          ? {
              ...result,
              remediation:
                "The setup plan changed. Preview the new changes before applying them.",
            }
          : result;
      }
      case "help":
      case "completions": {
        const { createCli } = await import("../cli.js");
        let text = "";
        const args =
          request.action === "completions"
            ? ["completions", request.shell]
            : [...(request.command ? [request.command] : []), "--help"];
        await createCli(environment).serve(args, {
          stdout: (value) => {
            text += value;
          },
        });
        return { text };
      }
    }
  }
}
