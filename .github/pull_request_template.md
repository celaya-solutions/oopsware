```text
Document:    Oopsware Pull Request
Version:     v1.0.1
Author:      Celaya Solutions
Contact:     hello@celayasolutions.com
Date:        2026-10-13
SHA256:      4848f981c82a941cf62b1b1237ad2aa6ee740ffbc55fe3abce5eb3d595bafc05
Chain:       solana-mainnet
Tx:          4V4NXgK7dmjKPpy6MpLXMSeoEbqPHnHkgcAyWpUHsczETycDkFfTwYPGnEj8U2B2RcqMFdiaB5SiHvuVzRvn4LLb
License:     All Rights Reserved / Celaya Solutions
```

<!-- Use a Conventional Commit title, for example: fix: keep evidence after a failed capture. -->

## What changes

Describe the problem and what happens after this change. Keep it plain. Include a
small before-and-after example when it helps.

## How it was checked

List the local commands and the behavior they verified. Name any real providers
used; say explicitly when Hopper, Ghidra, or IDA was not exercised. Do not use
GitHub Actions.

For tool changes, update the source contracts and check the generated catalog at
`docs/public/product-catalog.json` with `npm run docs:check`; do not commit the
generated output.

## Anything a reviewer needs to know

Link the related issue. Explain contract changes, compatibility effects, and
remaining unknowns when they matter. Keep original author credit and third-party
notices intact. New tools or schema changes should include a small CLI or MCP
example with transport credentials removed.
