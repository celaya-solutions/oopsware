```text
Document:    Graft Code Context for REA Agents
Version:     v1.0.1
Author:      Celaya Solutions
Contact:     hello@celayasolutions.com
Date:        2026-10-22
SHA256:      ec6e0849c978c583c2a3935a220de4d6307c3feac51d36acaea4e262eb5bd033
Chain:       solana-mainnet
Tx:          5C5e112URdciG4xjoutUQyWRm2UbvD2H7NJ368V4iM6XnrfmFwYry7djvn7mwCBVmJDBhrGTGHrivKkE4wMQVtM7
License:     All Rights Reserved / Celaya Solutions
```

# Graft code context

Graft is optional local development tooling. Oopsware's packaged analysis tools
and built-in chat do not depend on it. Install Graft separately if you want a
source graph, then run it from your checkout:

```sh
graft build
graft ask "where are tool contracts registered?" --source
graft callers createServer
```

The generated `graft/` directory is ignored. Queries refresh changed source
files; each worktree keeps its own graph. No API key is needed for the default
build. Model-backed summaries are optional.

Configure your agent locally if you want the MCP server (`graft mcp`). Machine
settings, hooks and status-line scripts are not distributed by this repository.
For Codex, `codex mcp add graft -- graft mcp` registers it for your account; restart
the client afterward. Review configuration changes before applying them.

Graft does not index every document or binary. An empty search result alone is
not proof that a file is unused. Use Oopsware's analysis tools for binary and
runtime evidence. If Graft is unavailable, ordinary source tools still work.
