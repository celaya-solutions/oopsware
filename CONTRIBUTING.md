```text
Document:    Contributing to Oopsware
Version:     v1.0.1
Author:      Celaya Solutions
Contact:     hello@celayasolutions.com
Date:        2026-10-20
SHA256:      aced3e2934bc7e548dcdd85d871f546759dde2e862c0f1ce72e45e580e7086de
Chain:       solana-mainnet
Tx:          3c5d7hyTQiNd7R9NSwga6VdUNBa4gKbVKnJQu2HNaSd5MLq4YH7UoZZjugsxxWzaWmLQ6jNegam4ssmwNUnUTcP8
License:     All Rights Reserved / Celaya Solutions
```

# Leave the bench a little better

A tiny reproduction, a clear explanation, or a missing bit of evidence can
be a great contribution. Tell us what surprised you and what you expected.
Keep the change focused enough that someone else can follow the thread.

## Get set up

Use the development versions in `.nvmrc` and `package.json#packageManager`.
The installed runtime also accepts the Node versions in `package.json#engines`.

```sh
npm ci
npm run build:cached
npm run dashboard:build
node scripts/oopsware.mjs web --port 4097
```

Work on a branch in an isolated worktree. Keep unrelated edits and running
services intact. Do not merge into main without a direct request.

### Windows source checkouts

A source checkout does not include the Windows x64 native addon or its
manifest: `native/windows/build/` is ignored by Git, and neither `npm ci` nor
`npm run build:cached` (or `npm run build`) produces `rea-windows-x64.node` or
`manifest.json` in that directory. Windows workflows and tests that require
native controls need these artifacts; this includes `run-exclusive` commands,
which use the native Job Object to keep the artifact lock until every command
descendant has exited. Without the artifacts, those controls are unavailable
even after a successful runtime build.

Follow the [Windows native build guide](native/windows/README.md#build) before
running those workflows from source. The artifact build requires Linux,
MinGW-w64, and `tar`; the build script does not run on Windows. Keep the
generated addon and manifest uncommitted.

## Report what you saw

Keep a report short. For a bug, include the actual result, the shortest
reproduction you ran, the version and environment, and the smallest useful
output, artifact, screenshot, or source reference. Ground expected behavior in
documentation, source, or a known-good version when you can. Say how often it
happens and keep untested scope and suspected causes labelled as such.

Incomplete reports and intermittent failures are welcome. If you lack an
answer or evidence, write `NOT_ENOUGH_INFO` and explain the gap. Label
source-only findings and proposed checks; never claim a reproduction or result
you did not observe. You do not need a root cause or a fix to report a problem.
For documentation, name the passage or missing guidance and what confused you.

Feature ideas can start with a problem and a desired outcome. Examples, prior
art, and measurements help but are optional. See
[AGENTS.md](AGENTS.md#issue-reports) for the same rules in agent form.

## Follow the evidence

The [architecture map](docs/architecture.mermaid) explains the layers.
Provider details stay in adapters; CLI and MCP share application workflows.
Production factories in `src/composition/` construct fresh providers without
starting engines or acquiring targets, and an optional adapter failure must
leave its successful peers working. Read [AGENTS.md](AGENTS.md),
[tool design](docs/tool-design.md), and [testing](docs/testing.md) before
changing a boundary or adding a tool.

Preserve observed facts, source locations, and unknowns. A mock passing is
not a real provider run. A package starting is not proof that every target
works. Say what you checked, and leave the next person enough detail to
repeat it.

For analysis workflows and agent interfaces, follow the
[performance priorities](AGENTS.md#performance). Explain the selected output
scope, reuse or cache decisions, and before/after measurements when these
costs change. The
[analysis optimization skill](.agents/skills/rea-analysis-optimization/SKILL.md)
helps locate provider and shared-workflow bottlenecks while preserving
Evidence; compare equivalent real tasks before claiming an improvement.

## Own the change

AI-assisted contributions are welcome. Every change needs a human owner who
takes responsibility for all of it: code, tests, documentation, and claims
produced with AI help. Before asking for review, the owner should:

- Review the final diff and the code around it, and be able to explain the
  problem, the approach, how it fits Oopsware, and the edge cases that matter.
- Show that it works: what was checked, what was observed, and what was not
  covered. For a fix, show the original failure and why the new test catches
  it when practical. Never report an unrun check as passing.

Agents must leave human sign-off to the human owner and must not attest to a
human review on their behalf. A passing check or a clean automated review does
not replace that ownership. See [AGENTS.md](AGENTS.md#pull-request-readiness).

## What belongs here

Oopsware focuses on software structure, runtime behavior, and evidence through
general-purpose reverse-engineering workflows. Judge a proposal by its actual
capabilities, side effects, defaults, and complete workflow. A tool name, or a
mention of vulnerability research, malware analysis, or CTFs, does not decide
whether it belongs.

In scope: format inspection, ordinary archive and standard compression
extraction, disassembly, decompilation, cross-references, general static
deobfuscation, vulnerability analysis, and evidence reporting. Static
protection detection is different from defeating that protection. Security
fixes and isolated regression tests stay in scope.

Runtime investigation needs explicit boundaries. Launching or attaching to a
process, injecting instrumentation, running scripts, and changing memory or
registers need review of target selection, execution and mutation authority,
provenance, resource limits, cancellation, and cleanup. General Frida or
debugger support is not inherently read-only, and existing support does not
authorize every workflow built on it. General-purpose interfaces are not
classed as bypass workflows only because caller code could be misused; their
execution and mutation authority must still be reviewed.

Oopsware does not integrate or distribute:

- Purpose-built workflows to defeat commercial packing or code-virtualization
  protections and automatically recover protected code.
- Anti-debugging or anti-instrumentation evasion, or DRM, license, anti-cheat,
  or access-control bypass workflows.
- Exploit or attack-payload automation, credential theft, covert persistence,
  unauthorized access, or bulk attack workflows.

These limits cover first-party providers, adapters, plugins, bundled scripts,
defaults, examples, and documentation. Moving a capability into an optional
dependency or plugin does not exempt it. Review what an integration exposes,
including upstream defaults and raw-command or script execution paths.
Ordinary extraction and general static deobfuscation are not excluded just
because the input is packed or obfuscated; assess added bypass or execution
behavior separately.

This is a product and maintenance boundary, not a judgment about anyone's
intentions or a claim that all excluded research is unlawful. Contributors must
have the rights and authorization their work needs. A local-only design or an
"authorized use only" disclaimer does not establish containment or settle legal
and scope questions.

### Fail closed

If scope fit, target or authorization boundaries, side effects, or the
verification needed to establish them stay materially unresolved, **do not
merge, enable, or ship the capability**. Keep it pending, narrow it, or decline
it. Record unknowns explicitly; never turn them into "none" or assumed safety.
Passing checks, finished code, upstream popularity, or silence is not scope
approval.

A new provider, or a capability involving target execution, injection,
mutation, or protection recovery, needs an explicit scope decision before
substantial work meant for integration. Small exploratory prototypes can inform
that decision; they do not authorize integration. The decision covers the final
behavior, and a scope expansion needs a new one. Routine fixes and documentation
inside existing boundaries need no separate decision, but must not quietly
widen them.

### Start a proposal

Describe the problem and the outcome or decision you want. Short answers and
"not sure yet" are fine. You do not need code, a full design or test plan, legal
analysis, or private proof of authorization to start. Before integration, work
out together:

- The concrete analyst question, the inputs and outputs, and why existing
  Oopsware operations are not enough.
- Why the workflow fits this scope, its non-goals, and any protection recovery,
  bypass, or attack automation it would expose.
- The selected targets and every execution, injection, mutation, network, or
  persistence effect, including behavior inherited from upstream tools.
- How the boundaries and outcome will be verified with self-owned or properly
  licensed samples: real CLI/MCP and provider coverage, cleanup and resource
  checks, and remaining unknowns. Do not publish private binaries, credentials,
  or sensitive target data; follow [SECURITY.md](SECURITY.md) for private
  vulnerability reports.

Split mixed proposals so acceptable analysis can be decided apart from excluded
workflows. Opening an issue or PR does not authorize integration. This is an
integration gate, not a per-call confirmation or a sandbox guarantee.

## Check the changed path

```sh
npm run test:focused -- path/to/affected.test.ts
npm run check:fast
npm run dashboard:check
```

Run the dashboard check when web code changes. Packaging changes also need
`npm run verify:package` and `npm pack --dry-run`. For a provider change,
run the matching real-provider lane in the testing guide. Use local checks;
do not create, run, watch, or wait for GitHub Actions.

`npm run check:pr` is the broader local gate when the change needs it. It
reuses build and static-check outputs while running the test suite fresh,
including the fast Python producer checks. Run `npm run verify:test-discovery`
after adding or moving tests; `npm run verify:module-boundaries` (part of lint)
checks resolved import boundaries. For test correctness, drift, or performance
investigations, the
[`rea-ci-tests-audit` contributor skill](.agents/skills/rea-ci-tests-audit/SKILL.md)
guides reproduction and comparable measurements before changing checks.

Pre-commit formats and lints staged source; pre-push runs `check:fast`.
Use Conventional Commit subjects, such as `fix(web): keep the selected target`.

## Generated files

After package or skill metadata changes, run `npm run metadata:generate`.
`npm run docs:generate` refreshes the catalog and documentation projections.
Do not commit `dist/`, `node_modules/`, generated `skills/`, cached tool
catalogs, or the ignored managed-conformance projections.

Author agent instructions in `.agents/skills/reverse-engineer-anything/`.
Keep the canonical tool contracts in sync across the CLI and MCP. Do not
rename old storage keys or evidence fields just to match the product name.
For grouped changelog notes with verified contributor thanks, use the
`rea-changelog-update` skill in `.agents/skills/rea-changelog-update/`.

## Words and pictures

Write like someone sharing a neat discovery at a workbench. A little play
belongs in introductions and empty states. Errors and instructions should
say exactly what happened and what to do next. Skip growth claims, badges,
star counters, sales copy, and borrowed community links.

The [technical docs](docs/index.md) and [small local website](website/README.md)
are separate from the app. No public host or package publication is implied.

## Rights and credit

Keep original notices and third-party licenses intact. New contributions
must identify their author and be compatible with the project's
[license scope](LICENSE). Do not assume ownership of someone else's patch
or retroactively restrict existing MIT grants. See [credits](CREDITS.md).
