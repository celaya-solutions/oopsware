```text
Document:    Oopsware Field Notes
Version:     v1.1.1
Author:      Celaya Solutions
Contact:     hello@celayasolutions.com
Date:        2026-10-22
SHA256:      97f692b92369bccbd6c92059740c206a250d1f07f46563da9904e18aa01db995
Chain:       solana-mainnet
Tx:          2J67wNLhqe69KqYNdfpAAJhCd1c14ivtdpBsfZtjDAN9dAJoukZThwuTGw2dM36YaVvyNMm7xa4NE68J8EkyspR8
License:     All Rights Reserved / Celaya Solutions
```

# Follow the interesting bit

Oopsware is CSR's local bench for taking software apart and seeing how it
works. Start with a question small enough to check. Keep the clues nearby.

## First visit

Build from the [source instructions](https://github.com/celaya-solutions/oopsware#readme),
then open the workbench or use its terminal command:

```sh
node scripts/oopsware.mjs web --port 4097
node scripts/oopsware.mjs --help
```

[Installation and setup](./installation.md) connects your tools and agents.
[CLI and Evidence](./cli.md) explains what comes back.

[Offline supply-chain checks](./supply-chain.md) builds a parts list, matches
local vulnerability data, and separates signature integrity from trust.
[Agent prompts](./mcp-prompts.md) gives you a few threads to pull.

## Pick a thread

- [Native applications](./native-investigation.md)
- [JavaScript and Electron](./javascript-artifact-reconstruction.md)
- [Browser behavior](./browser-observation.md)
- [Android packages](./android-analysis.md)
- [Apple applications](./apple-application-analysis.md)
- [.NET assemblies](./managed-code-analysis.md)
- [Firmware](./firmware-analysis.md)
- [Tool contracts](./mcp-contracts.md)

The technical guides keep exact command names, configuration keys, source
evidence, and provider limits. Old `REA_*` settings remain supported.
When a guide shows `npx -y @celaya-solutions/oopsware@latest`, use
`node scripts/oopsware.mjs` until a CSR package is published.

For runtime instrumentation, see the [Frida guide](./frida-instrumentation.md).

## Find a guide

| Task                                                | Guides                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Identify a desktop installation                     | [Runtime candidates, evidence and follow-up files](desktop-applications.md)                                                                                                                                                                                                                                                                            |
| Inspect native functions, references, or types      | [Native binaries](native-investigation.md), [Go metadata](go-binaries.md), [Rust dependencies](rust-binaries.md), [offline ELF layout](binary-diagnostics.md), [recorded crashes](recorded-crashes.md)                                                                                                                                                 |
| Select a native provider or import format           | [Ghidra semantics](ghidra-provider.md), [Windows](windows-ghidra-p0.md), [DOS](ghidra-dos.md), [raw bytes](raw-binary.md), [MIPS](ghidra-mips.md), [PSP](ghidra-psp.md), [NativeAOT](ghidra-nativeaot.md), [IDA](ida-provider.md), [Kuna](kuna-provider.md), [JEB](jeb-analysis.md)                                                                    |
| Analyze JavaScript or Electron artifacts            | [Static analysis](javascript-artifact-reconstruction.md), [tracing and comparisons](javascript-application-workflows.md), [application graph](javascript-application-graph.md), [source recovery](javascript-recovery.md)                                                                                                                              |
| Compare static JavaScript with runtime observations | [Runtime attribution](javascript-runtime-observation.md), [reconciliation](javascript-runtime-reconciliation.md), [Electron observation](electron-observation.md), [Electron fuses](electron-fuses.md)                                                                                                                                                 |
| Inspect assemblies, packages, or firmware           | [Godot PCK](godot-pck.md), [.NET](managed-code-analysis.md), [Android](android-analysis.md), [Apktool resources](apktool-resource-analysis.md), [ADB acquisition](adb-device-analysis.md), [Apple](apple-application-analysis.md), [Harmony](harmony-analysis.md), [firmware](firmware-analysis.md), [WASM](wasm-artifacts.md), [EVM](evm-bytecode.md) |
| Observe or compare a browser scenario               | [CDP observation](browser-observation.md), [scenarios](browser-scenario-contract.md), [runtime evidence](web-runtime.md), [historical captures](web-network-captures.md)                                                                                                                                                                               |
| Serve recorded behavior as an agent environment     | [Agent environments](agent-environments.md)                                                                                                                                                                                                                                                                                                            |
| Trace captured website source                       | [Source locations](web-source-location.md), [module traces](website-module-trace.md), [script export](website-script-export.md)                                                                                                                                                                                                                        |
| Capture and compare a command                       | [Process capture](process-capture.md)                                                                                                                                                                                                                                                                                                                  |
| Read WebAssembly, JVM, Python, or text              | [WebAssembly](webassembly.md), [JVM](jvm.md), [Python](python.md), [structured text](structured-text.md)                                                                                                                                                                                                                                               |
| Use CLI/MCP and retain evidence                     | [CLI](cli.md), [MCP contracts](mcp-contracts.md), [agent prompts](mcp-prompts.md), [obligation ledgers](reconstruction-obligation-ledgers.md)                                                                                                                                                                                                          |

For development, use [testing](testing.md), [client verification](client-verification.md),
[tool design](tool-design.md), and [releasing](releasing.md).
[Reconstruction readiness](reconstruction-readiness.md) describes a development
conformance verifier. [The 6.2 migration](migration-6.2.md) records that release's
compatibility changes; [the roadmap](roadmap.md) tracks future work.

## Who built the bench

Oopsware builds on REA by **morluto and the REA contributors**.
[Credits](https://github.com/celaya-solutions/oopsware/blob/main/CREDITS.md) explain
the history. New CSR work is free for noncommercial use; original MIT work
keeps its rights. Read the
[license scope](https://github.com/celaya-solutions/oopsware/blob/main/LICENSE).
