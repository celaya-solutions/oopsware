```text
Document:    Oopsware Local Web Workspace
Version:     v1.4.1
Author:      Celaya Solutions
Contact:     hello@celayasolutions.com
Date:        2026-10-17
SHA256:      d43593403b80cdd1231275df0c0225f2401aba6ae8d9c42c996dd6626de52aa1
Chain:       solana-mainnet
Tx:          4qTrSWjPfDwGNdAYfxejEYPUN2Z6ryN7PykaH2Vq3X79VLrC7wWEA8Jmhpx4EzNXEHS5K8DCArZXZtkwPTKk7G7p
License:     All Rights Reserved / Celaya Solutions
```

# Oopsware local web workspace

Run `oopsware web` and open `http://127.0.0.1:4097`. For a source checkout, run
`npm ci`, then `npm run web`. Use `oopsware web --port 4100` to choose another port.
This is Oopsware's own interface. It does not depend on OpenCode or another AI client.

The sidebar groups **Workspace**, **Tools**, **Runs**, **Evidence**, **Compare**, **Connections**, and **Settings**. The assistant opens alongside the workspace. Use the theme button for light or dark mode and Command/Ctrl-K to search tools.

Use **Upload files** to copy files into Oopsware's private local data folder. Uploads are limited to 128 MiB per file. Use **Open path** for larger files, or **Browse computer** to choose existing files and folders without copying them. **Try a sample** opens the bundled, non-executing JavaScript example. **Applications** opens local application browsing. Selecting a bundle preserves its package path while showing its executable preview where available.

Text, hex, and strings views page through source bytes. Files are read, not executed. Folder listings are paged. **Package inventory** uses provider-independent inspection; **Apple graph** and **Android graph** first inspect the selected package, then project the observed inventory into an application graph. JavaScript application analysis accepts a folder or ASAR. Standalone JavaScript files use source inspection. **Native binary** opens the target in a configured binary provider before requesting an overview.

**Tools** exposes the full canonical catalog and its complete input schemas. Forms support nested objects, arrays, choices, optional values, and examples; **JSON** mode supports lossless advanced input. Results distinguish observations, unknowns, errors, and declared limits. Unavailable providers remain visible and return their actual availability reason when invoked.

Each browser workspace has its own live MCP session and durable **Runs** history. Reload preserves the workspace; restarting Oopsware retains results but requires reopening native sessions. **Stop** cancels a running operation and waits for its owned cleanup. History marks interrupted work honestly. Downloads contain the full delivered result; retained originals referenced by a limited tool response remain available through the evidence tools. Inputs explicitly marked sensitive and transport credentials are removed from stored runs; retry requires reentering redacted values.

**Evidence** and **Compare** expose the existing evidence and paired-input tools. **Settings** provides diagnostics, provider status, agent integration setup, help/completion exports, update, and uninstall. Setup shows its concrete plan before applying it and checks that the plan has not changed. These controls reuse Oopsware's existing maintenance workflows and backup rules.

History loads a page of summaries. Use **Load older runs** to see earlier runs and select a run to load its complete result. Full results are saved separately, so starting a new run does not rewrite earlier evidence. Existing histories migrate on first use with the original archive kept.

For two native versions, choose **Compare native versions** in **Tools** and enter the two absolute paths. Oopsware collects function evidence in separate analysis sessions, proposes function pairs with supporting signals, and compares exact unique or explicitly selected pairs. Ambiguous matches and missing provider facts remain visible. A similarity score does not prove equal behavior. The first format boundary is matching thin Mach-O arm64 pairs or ELF x86-64 pairs with an available provider; neither binary is executed.

## Model connections

OpenAI is the default connection. Choose **Connections → Continue with ChatGPT** to
register and sign in to Oopsware. This follows OpenAI's documented native public-client
flow: dynamic registration, authorization code with PKCE, callback state and nonce
validation, signed ID-token checks, and the ChatGPT plan permission scope. Oopsware
uses the account-specific model list and public Responses endpoint. It never
copies credentials from another app. An existing OpenCode login does not sign in
Oopsware. The browser must complete Oopsware's own registration and consent flow.

Claude uses an Anthropic API key entered under **Connections**. Ollama uses
`http://127.0.0.1:11434` and LM Studio uses its server on `http://127.0.0.1:1234`
(start it in LM Studio's Developer tab or with `lms server start`; set
`LM_API_TOKEN` if LM Studio requires a token). Local requests never fall back
to a cloud provider.

**Hugging Face** lists GGUF models installed in Ollama (`hf.co/...`). Add a
Hugging Face token, or sign in once with `hf auth login` (Oopsware reads that
token or `HF_TOKEN` in place and does not copy it), to also list and chat with
HF Inference models through `router.huggingface.co`. A pasted token is checked
with `whoami` and saved in `huggingface.json`. **OpenRouter** lists its public
catalog without a key; chatting needs a key (pasted, checked against
`/api/v1/key`, saved in `openrouter.json`, or read from `OPENROUTER_API_KEY`).
OpenAI model lists accept both the public `{data:[{id}]}` shape and the
ChatGPT-account `{models:[...]}` shape.

**Models on this Mac** (under Connections) shows what Oopsware finds without
reaching the internet: Ollama's installed models, LM Studio's server list, the LM
Studio models folder (from its `downloadsFolder` setting, or
`LMSTUDIO_MODELS_DIR`), and the Hugging Face cache (`HF_HUB_CACHE`, `HF_HOME/hub`,
or `~/.cache/huggingface/hub`). Folder scans do not follow links outside the
cache and stop at 500 models. Cache models are listed for reference; chat needs
Ollama, LM Studio or HF Inference to serve them.

**Get a model** downloads only when you press Download or Get. It can pull an
exact name into Ollama (`/api/pull`, progress streamed, Stop cancels and a
later pull resumes), search Hugging Face GGUF repositories and pull a chosen
quantization as `hf.co/owner/repo:QUANT`, or add an Ollama cloud model
(`name:cloud`). Cloud models are small links; using them needs Ollama sign-in
and Ollama's cloud setting turned on. LM Studio downloads use its
`/api/v1/models/download` job API with a catalog key or a Hugging Face link
(an `hf.co/owner/repo:QUANT` name passes its tag as the quantization). That
API has no cancel call, so Stop only stops watching an LM Studio download;
LM Studio keeps it running. A folder that cannot be read is reported on its
model instead of failing the whole scan. Removing a saved Hugging Face or
OpenRouter key falls back to `HF_TOKEN`, the `hf` CLI login, or
`OPENROUTER_API_KEY` when one exists.

The assistant explains the provided evidence; it does not execute commands,
modify files, or autonomously invoke inspection tools. Use the visible inspection
controls to collect more evidence. The selected provider receives chat messages
only when **Send** is pressed. The context checkbox includes the selected path,
up to 32,000 characters of the current file preview, and up to 32,000 characters
of inspection JSON. Clear it to omit file context. Model output is an inference,
not a replacement for Oopsware's observations. Switching provider starts a new chat.
**Stop** cancels an active model request and preserves its partial response.

Oopsware stores its own credentials and uploaded copies under `~/.config/rea/web/`.
The directory is owner-only and credential files use mode `0600` on Unix. Tokens
never enter frontend responses, browser storage, or the repository. The server
binds only to `127.0.0.1`, validates Host and Origin, requires a per-run browser
session token on API calls, and serves a restrictive content security policy.

## Verification and limits

The HTTP suite covers upload/open/inspection, directory and file paging, request
origin and host checks, invalid inputs, signed OAuth callbacks, rejected nonces,
callback replay, credential permissions, canceled requests, and interrupted inference streams. CLI
schema and inventory checks cover the new `web` command. Real browser checks
cover the native file picker, an upload, sample inspection, source viewing, and
a local Ollama answer. Real HTTP inference also passed with an installed Hugging Face GGUF model. The packed npm artifact was installed with production dependencies and its page, assets, sample, and real inspection were checked.

OpenAI's real consent and account-specific cloud inference require the user's
account. Claude inference requires the user's API key. Local artifact inspection
does not establish real Hopper or Ghidra support; those providers retain their
own verification lanes. Browser verification in this change is on macOS Safari.

References: [OpenAI registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in),
[models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference),
and [Ollama chat API](https://docs.ollama.com/api/chat).
