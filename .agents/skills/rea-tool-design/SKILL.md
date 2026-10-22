---
name: rea-tool-design
description: Design or change Oopsware investigation tools, CLI/MCP contracts, provider capabilities, and Evidence semantics.
---

```text
Document:    Oopsware tool design
Version:     v1.0.1
Author:      Celaya Solutions
Contact:     hello@celayasolutions.com
Date:        2026-10-13
SHA256:      75b51d381675c8ba46d3f111adc6075a5dfc0423717b56021f18f33525b762ee
Chain:       solana-mainnet
Tx:          4fX4W4UUpNmegDywH21Cdhr3CR8RApayzBsKS6HK5wuY5YHKYm4gMPMv6VNhPAmnFgEW5b2a3rCME4983KuDhoeh
License:     All Rights Reserved / Celaya Solutions
```

# Oopsware tool design

Use the [tool-design guide](../../../docs/tool-design.md) for tool boundaries,
contract semantics, provider ownership, and discoverability. Inspect the current
contract and nearest existing tool relevant to the analyst question; source,
documentation, and live catalogs may describe different versions.

For a design request, return the proposed boundary, input/result shape, Evidence
semantics, nearest alternative, and verification approach. Implement when
requested, preserving the user's scope and existing authorization.

For implementation or verification, consult [testing](../../../docs/testing.md)
for the affected consumer and provider lanes, and
[contributing](../../../CONTRIBUTING.md) for generated-file ownership. Read
provider/workflow guides only as the task requires.
