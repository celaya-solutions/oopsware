```text
Document:    Oopsware roadmap
Version:     v1.0.3
Author:      Celaya Solutions
Contact:     hello@celayasolutions.com
Date:        2026-10-22
SHA256:      61ee64a0ea6e33e6665e27e8b018d73944dce7b342f30b7534339e80322e0596
Chain:       solana-mainnet
Tx:          aS8WBZz9qTfWntb4RpmSUXbtoAyT92kRN9tzDhAmKVoJu3b1hk98jfFZb3J6WgWJDaikvAMXyQXukXvCJcEqeJG
License:     All Rights Reserved / Celaya Solutions
```

# Oopsware roadmap

Available tools and their verification limits are documented in the
[investigation guides](./index.md), [installation guide](installation.md), and
[generated catalog](mcp-contracts.md#generated-catalog).

## Priorities

- Expand native architecture, type, and indirect-call verification.
- Connect static findings and runtime observations across application layers.
- Improve obfuscated managed-code comparisons and verified native links.
- Extend process, protocol, filesystem, reconnect, and build-comparison coverage.
- Evaluate additional providers and targets when an analyst workflow demonstrates
  a capability gap.

## Admission criteria

New capabilities must return useful evidence through shared CLI/MCP workflows,
preserve observations and unknowns, and declare actual authority and lifecycle
constraints. Agents compose experiments using ordinary commands, scripts, and
fixture servers; custom orchestration needs a demonstrated requirement.

Provider and platform claims require their corresponding
[real verification lanes](testing.md#real-toolchain-verification-lanes).
See [tool design](tool-design.md) for choosing a tool boundary and
[Ghidra semantics](ghidra-provider.md) for the existing deep-provider contract.

Setup remains additive, reuses existing tools, and requires approval for disclosed
configuration and Hopper installation changes. Additional installer choices need
an implemented toolchain and explicit scope; setup does not install or upgrade
unrelated runtimes or dependencies.
