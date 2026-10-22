```text
Document:    Connection and task recovery
Version:     v1.0.1
Author:      Celaya Solutions
Contact:     hello@celayasolutions.com
Date:        2026-10-20
SHA256:      c3ca2e7bcd7e39d8f807e2b21c3e47e0cabc7a4aedc241409ccb85b86075a37e
Chain:       solana-mainnet
Tx:          3zEF3M72Qmcf22LyAmTurCxStnxv7JPNFYPQbWAGAzBxDQWNv9ZvKBRXVtRnTnHokbyPPNJJ8jrJtajrie9hXVmv
License:     All Rights Reserved / Celaya Solutions
```

# Connection and task recovery

Read this guide only for an observed connection, command, approval or provider
blocker. Keep the user's target and question in view. Explain what prevented the
operation and the next useful step; after repair, continue the investigation.

Commands below use an installed `rea`. If none is available, use the package
invocation in `SKILL.md` when acquiring Oopsware is authorized. Follow the connected
server's schemas and the installed CLI's help rather than assuming repository
main and an older release expose the same arguments.

## Choose the remedy from the observed failure

| Observation                                                          | Meaning and next step                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No Oopsware tools in the active session                              | Inspect registration with `oopsware doctor --client codex --json`. A skill installation alone does not register MCP.                                                                                                                                                                                                  |
| Missing, malformed or stale registration                             | Prepare a scoped setup plan; apply only authorized changes with backups.                                                                                                                                                                                                                                              |
| Aligned registration, but no connected tools                         | Restart/reconnect the client. Doctor checks registration; it cannot establish the current agent's connection. Inspect the client's launch error if reconnection fails.                                                                                                                                                |
| `MCP tool call requires approval, but approval policy is never`      | Codex rejected the call before Oopsware executed it. Do not install an engine or repeat setup to solve this client-policy decision. See the approval section below.                                                                                                                                                   |
| Oopsware returns `provider_unavailable` or an unavailable tool entry | Read that operation's provider diagnostics or `binary_session.result.tool_availability`. Expand each group's tool names and inherit the shared client requirements unless overridden. Use the operation's availability, reason, and remediation; a complete tool catalog does not imply every operation is available. |
| `rea` is missing in a child shell, or Node is incompatible           | Inspect the actual shell PATH and launcher/runtime. A prefix installation may be absent from a login shell's PATH; this does not establish a broken MCP registration.                                                                                                                                                 |

If the client cannot launch its shell/sandbox helper or read the installed skill,
inspect its launch diagnostic. For example, Codex can refuse helper aliases when
CODEX_HOME is under `/tmp`; use an authorized profile outside the OS temporary
directory. Oopsware setup cannot repair the client's executor. Preserve the sandbox
instead of silently disabling it to make an analysis command work.

Static JavaScript and ordinary ZIP inventory need neither Hopper nor Ghidra.
HAR inspection is offline and does not require a live browser. Native
decompilation, Android analysis and firmware extraction have their own
bring-your-own prerequisites. Use supported inventory/static evidence when it
answers part of the question, and name the unavailable evidence separately.
Do not substitute another target. Label observations from ordinary shell tools
as such; only actual Oopsware output supplies Oopsware Evidence.

## Distinguish client and server deadlines

A host message such as `timed out awaiting tools/call` with no Oopsware result means
the client's deadline expired before a result arrived. It does not establish
that Oopsware finished, canceled successfully, or released all resources. Do not
repeat the unchanged analysis. Inspect available session/provider state and
retained Evidence only when useful; an idle `binary_session` is not proof that
every target-free operation stopped. Never invent a missing Evidence reference.

Allow the host tool deadline to cover execution, cancellation/cleanup, and
response delivery. In Codex, the setting is
`mcp_servers.<server-id>.tool_timeout_sec` in **seconds**, not
`startup_timeout_sec`. Select a value for the actual operation budget and
headroom, not a universal timeout. See the
[official MCP configuration reference](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).
Apply configuration changes only within the authorized scope, preserving
unrelated entries and backups; reconnect/restart as required by the host.
When configuration is not editable, report the setting needed or use an
authorized CLI fallback. Do not silently broaden permissions or switch targets.

A returned Oopsware `provider_timeout` instead means the **server/provider** reached
its deadline. Follow its `remediation.action`, reuse accessible partial Evidence,
and resolve reported incomplete cleanup before retrying. Raising only the
client deadline does not change this server budget. For static JavaScript,
`analysis_timeout_ms` (CLI `oopsware analyze-javascript-application <path>
--analysis-timeout-ms <milliseconds>`) controls each source's
startup, analysis and transfer deadline in **milliseconds**. Increase that
budget or reduce semantic work / select exact inventoried `source_paths` when
the task permits. Omit `source_paths` for all sources; `[]` is invalid.
`detail: "summary"` reduces delivery, not analysis work. A per-source budget
does not bound the elapsed time for an entire multi-source application.
Partial-Evidence inspection can avoid recomputation; an unavailable reader is
not itself a reason to block a corrected static-analysis retry.
The shorthand `oopsware analyze <path>` does not expose this timeout flag; use the
explicit JavaScript command when changing that budget.

For invalid arguments, use the connected tool's current input schema, or the
installed CLI's command help. Refresh the catalog if stale; do not guess fields
from an older skill or return the entire catalog to repair one field. Correct
all reported fields before retrying.

## Repair registration when needed

For Codex:

```bash
oopsware doctor --client codex --json
oopsware setup --client codex --dry-run --json
```

Use the current supported client's ID: `claude_code`, `claude_desktop`, `codex`,
`cursor`, `gemini_cli`, `windsurf`, `devin`, `opencode`, `antigravity`,
`copilot_cli`, `commandcode`, `qwen_code`, `vscode`, `trae`, `grok_build`, `omp`, `pi`,
`hermes`, `qoder`, `droid`, `zcode`, `dsh`, or `grok_bot`. If unknown, inspect `doctor --json` before choosing a
scope. `grok_bot` uses a chat registration step rather than local `mcp.json`.
For unsupported clients, use version-pinned manual stdio registration or CLI.

Show the plan's exact paths, backups, changes and bundled-skill replacement.
Obtain approval for writes when that concrete scope is not already authorized,
then apply the same scope with `oopsware setup --client codex --yes`. Add
`--install-hopper` only when separately needed and explicitly approved. Do not
install or upgrade unrelated prerequisites. Restart/reconnect, verify tools
actually appear, and resume the original task. If they remain absent, inspect
the launch failure rather than looping through setup.

## Codex tool approval is separate from Oopsware readiness

Oopsware tools have no permission-grant handshake. Codex can still require approval
because an operation creates owned resources, launches a helper or has cleanup
effects. An advertised tool or successful doctor result does not override that
client policy. `workspace-write` alone does not resolve an MCP approval
rejection, and `approval_policy = "never"` does not mean every MCP tool is
preapproved.

When interactive approval is available, use the client's approval flow for the
requested operation. In an unattended run, continue through an authorized CLI
workflow if the execution environment permits it, or report the blocked
operation and the approval needed to proceed. Do not retry the same rejected
call, silently broaden approvals, or rewrite MCP effects as read-only.

For an operator who explicitly wants to preapprove named operations in a
disposable Codex profile, current Codex supports per-tool configuration. For
example, opening and closing an analysis session can be scoped independently:

```toml
[mcp_servers.rea.tools.open_binary]
approval_mode = "approve"

[mcp_servers.rea.tools.close_binary]
approval_mode = "approve"
```

Use the actual server ID and only the operations whose effects were approved;
this example does not approve inspection, extraction or runtime execution.
Show the proposed config edit and preserve unrelated entries and backups before
writing. Managed policy can constrain client settings. Consult the
[Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
for the installed client's supported settings. This is an optional recovery
choice, not a prerequisite for every Oopsware task.

## Continue through an installed CLI

Check the command environment only if the launcher fails:

```bash
command -v rea
command -v node
node --version
oopsware --version
```

Use the public launcher at its known installation path with a supported existing
Node on PATH when the child shell loses a prefix installation. Avoid internal
`dist/cli.js` entrypoints or global toolchain changes. MCP may have its own valid
launcher even when a shell cannot resolve `rea`.

For a user-supplied JavaScript tree or ASAR, select output files in the authorized
workspace and save complete Evidence before reading a view:

```bash
oopsware analyze-javascript-application /absolute/path/to/app --json > app-evidence.json
jq -c '{source: {kind: "inline", evidence: .}, view: {kind: "summary"}}' app-evidence.json > app-view.json
oopsware inspect-analysis-view app-view.json
```

These commands do not register MCP or install an analysis engine. CLI JavaScript
JSON is complete and can be very large; redirect it rather than loading it into
context. Use an existing JSON processor if `jq` is absent, without installing
one just for this recipe. Inspect a module page or item using the same inline
source and the [JavaScript recipes](javascript-applications.md). Preserve graph
coverage, limitations and unknowns. Native CLI analysis still requires its
selected engine, and all CLI operations retain the host's execution permissions.
