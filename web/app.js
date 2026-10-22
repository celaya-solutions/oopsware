const $ = (selector) => document.querySelector(selector);
const token = $('meta[name="rea-token"]').content;
const state = {
  files: [],
  selected: null,
  tab: "overview",
  status: null,
  models: [],
  selectedModels: {},
  messages: [],
  controller: null,
  browse: null,
  noticeTimer: null,
  inspectBusy: false,
};
const labels = {
  openai: "OpenAI",
  claude: "Claude",
  ollama: "Ollama",
  huggingface: "Hugging Face",
};
const bytes = (n) =>
  n >= 1048576
    ? `${(n / 1048576).toFixed(1)} MiB`
    : n >= 1024
      ? `${(n / 1024).toFixed(1)} KiB`
      : `${n} bytes`;

async function api(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "x-rea-token": token,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json();
  if (!response.ok)
    throw new Error(value.message || `Request failed (${response.status})`);
  return value;
}
function notice(message, error = false) {
  clearTimeout(state.noticeTimer);
  $("#notice").textContent = message;
  $("#notice").classList.toggle("error", error);
  $("#notice").hidden = false;
  state.noticeTimer = setTimeout(
    () => {
      $("#notice").hidden = true;
    },
    error ? 12000 : 5500,
  );
}
function action(selector, handler) {
  $(selector).addEventListener("click", () => {
    Promise.resolve()
      .then(handler)
      .catch((error) => notice(error.message, true));
  });
}
function element(tag, text, className) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
}
function busy(button, active, label) {
  button.disabled = active;
  if (active) {
    button.dataset.label = button.textContent;
    button.textContent = label;
  } else button.textContent = button.dataset.label || button.textContent;
}

function renderFiles() {
  const list = $("#file-list");
  list.replaceChildren();
  for (const file of state.files) {
    const button = element(
      "button",
      undefined,
      `file-item${file === state.selected ? " active" : ""}`,
    );
    button.title = file.path;
    button.append(element("span", file.directory ? "▤" : "◧", "file-icon"));
    const copy = element("span", undefined, "file-item-copy");
    copy.append(
      element("strong", file.name),
      element(
        "small",
        file.application
          ? "MAC APP"
          : file.directory
            ? "FOLDER"
            : bytes(file.size),
      ),
    );
    button.append(copy);
    button.addEventListener("click", () => selectFile(file));
    list.append(button);
  }
  $("#file-count").textContent = String(state.files.length).padStart(2, "0");
}
function addFile(file) {
  const existing = state.files.find((f) => f.path === file.path);
  if (existing) {
    Object.assign(existing, file);
    selectFile(existing);
  } else {
    state.files.push(file);
    selectFile(file);
  }
}
function selectFile(file) {
  state.selected = file;
  $("#welcome").hidden = true;
  $("#artifact").hidden = false;
  $("#artifact-name").textContent = file.name;
  $("#artifact-path").textContent = file.path;
  $("#artifact-kind").textContent = file.application
    ? "MAC APPLICATION"
    : file.directory
      ? "LOCAL FOLDER"
      : file.preview?.text !== null
        ? "TEXT / SOURCE FILE"
        : "BINARY FILE";
  $("#artifact-size").textContent =
    file.directory && !file.application ? "Folder" : bytes(file.size);
  $("#artifact-modified").textContent = new Date(
    file.modified,
  ).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  $("#analysis-mode").value = /\.(?:[cm]?jsx?|tsx?|json|asar)$/i.test(file.name)
    ? "javascript"
    : "binary";
  $("#download-report").disabled = !file.report;
  renderFiles();
  renderPreview();
  renderReport();
  setTab(state.tab);
}
function renderPreview() {
  const file = state.selected;
  const preview = file.preview;
  if (!preview) {
    $("#file-content").textContent =
      "This is a folder. Browse it to open files, or inspect it as an artifact.";
    $("#preview-range").textContent = "Folder";
    $("#strings-content").replaceChildren();
    $("#previous-page").disabled = true;
    $("#next-page").disabled = true;
    return;
  }
  $("#preview-range").textContent =
    `Bytes ${preview.offset.toLocaleString()}–${(preview.offset + preview.bytes).toLocaleString()} of ${file.size.toLocaleString()}`;
  $("#previous-page").disabled = preview.offset === 0;
  $("#next-page").disabled = !preview.hasMore;
  $("#file-content").textContent =
    preview.text ?? hexDump(preview.hex, preview.offset);
  const strings = $("#strings-content");
  strings.replaceChildren();
  for (const match of preview.strings) {
    const row = element("div", undefined, "string-row");
    row.append(
      element("span", match.offset.toString(16).padStart(8, "0")),
      element("span", match.text),
    );
    strings.append(row);
  }
  if (!preview.strings.length)
    strings.append(
      element("p", "No printable strings in this page.", "view-note"),
    );
}
function hexDump(hex, offset) {
  const lines = [];
  for (let i = 0; i < hex.length; i += 32) {
    const cells = hex.slice(i, i + 32).match(/.{2}/g) || [];
    const ascii = cells
      .map((cell) => {
        const n = parseInt(cell, 16);
        return n >= 32 && n < 127 ? String.fromCharCode(n) : ".";
      })
      .join("");
    lines.push(
      `${(offset + i / 2).toString(16).padStart(8, "0")}  ${cells.join(" ").padEnd(47)}  ${ascii}`,
    );
  }
  return lines.join("\n");
}
function setTab(name) {
  state.tab = name;
  for (const button of document.querySelectorAll("[data-tab]"))
    button.setAttribute("aria-selected", String(button.dataset.tab === name));
  for (const section of document.querySelectorAll(".view"))
    section.hidden = section.id !== `view-${name}`;
}
function renderReport() {
  const file = state.selected;
  const failure = file.report?.error ? file.report : file.applicationError;
  const overview = $("#overview-content");
  overview.replaceChildren();
  const card = element("div", undefined, "overview-card");
  card.append(
    element(
      "h3",
      failure
        ? "Inspection could not finish"
        : file.report
          ? "Inspection collected"
          : "Ready to inspect",
    ),
  );
  card.append(
    element(
      "p",
      failure
        ? failure.message || failure.error
        : file.report
          ? "Explore Oopsware’s observed facts below. Evidence retains the engine’s original result, including unknowns and suggested next steps."
          : "Read the file in File view, explore printable strings, or run Inspect artifact to identify its structure and available analysis paths.",
    ),
  );
  if (file.directory) {
    const browse = element(
      "button",
      file.application ? "Browse app contents →" : "Browse folder →",
      "quiet",
    );
    browse.addEventListener("click", () =>
      openBrowser(file.path).catch((e) => notice(e.message, true)),
    );
    card.append(browse);
  }
  if (file.executablePath)
    card.append(element("p", `Executable: ${file.executablePath}`));
  if (file.report?.subject && file.report?.provider) {
    const facts = element("dl");
    for (const [label, value] of [
      ["Format", file.report.subject.format],
      ["Engine", file.report.provider.name],
      ["SHA-256", file.report.subject.digest?.sha256],
    ]) {
      if (value) facts.append(element("dt", label), element("dd", value));
    }
    card.append(facts);
    if (file.report.limitations?.length)
      card.append(
        element(
          "p",
          `${file.report.limitations.length} limitations reported. Review them in Evidence before drawing conclusions.`,
        ),
      );
  }
  overview.append(card);
  if (!file.report) {
    $("#evidence-content").textContent =
      "Run an inspection to collect evidence.";
    return;
  }
  const tree = element("div", undefined, "result-tree");
  const report = file.report;
  for (const [key, value] of Object.entries(report)) {
    const details = element("details");
    const count = Array.isArray(value) ? ` · ${value.length}` : "";
    details.append(element("summary", `${key.replaceAll("_", " ")}${count}`));
    const pre = element("pre", renderJson(value));
    details.append(pre);
    tree.append(details);
  }
  overview.append(tree);
  $("#evidence-content").textContent = renderJson(report);
}
function renderJson(value) {
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return text.length > 200000
    ? `${text.slice(0, 200000)}\n\n[Display limited to 200,000 characters. Save report for the complete evidence.]`
    : text;
}
async function openPath(path) {
  const file = await api("/api/open", { path });
  addFile(file);
  return file;
}
async function changePage(direction) {
  if (!state.selected?.preview) return;
  const file = state.selected;
  const result = await api("/api/open", {
    path: file.path,
    offset: Math.max(0, file.preview.offset + direction * 65536),
  });
  Object.assign(file, result);
  if (state.selected === file) renderPreview();
}
async function inspect(mode) {
  if (!state.selected || state.inspectBusy) return;
  const file = state.selected;
  const button = $(mode === "inspect" ? "#inspect" : "#analyze");
  state.inspectBusy = true;
  busy(button, true, "Inspecting…");
  try {
    const report = await api(
      mode === "inspect" ? "/api/inspect" : "/api/analyze",
      {
        path: file.path,
        ...(mode === "inspect" ? {} : { mode: $("#analysis-mode").value }),
      },
    );
    file.report = report;
    if (state.selected === file) {
      renderReport();
      $("#download-report").disabled = false;
      setTab("overview");
    }
    notice(
      report.error
        ? report.message || report.error
        : "Oopsware inspection finished. Review the evidence and any reported limitations.",
      Boolean(report.error),
    );
  } finally {
    busy(button, false);
    state.inspectBusy = false;
  }
}
async function uploadFiles(files) {
  for (const file of files) {
    if (file.size > 128 * 1024 * 1024) {
      notice(`${file.name} is over 128 MiB. Use Open path instead.`, true);
      continue;
    }
    notice(`Adding ${file.name}…`);
    const response = await fetch(
      `/api/upload?name=${encodeURIComponent(file.name)}`,
      {
        method: "POST",
        headers: {
          "x-rea-token": token,
          "Content-Type": "application/octet-stream",
        },
        body: file,
      },
    );
    const value = await response.json();
    if (!response.ok) throw new Error(value.message || "Upload failed.");
    addFile(value);
  }
  notice("Files added to your local workspace.");
}
async function openBrowser(path, offset = 0) {
  const result = await api("/api/browse", { path, offset });
  state.browse = result;
  $("#browse-location").value = result.path;
  const list = $("#browse-list");
  if (!offset) list.replaceChildren();
  for (const entry of result.entries) {
    const button = element("button", undefined, "browse-entry");
    button.append(
      element("span", `${entry.directory ? "▤" : "◧"}  ${entry.name}`),
      element(
        "small",
        entry.application
          ? "Select app →"
          : entry.directory
            ? "Open →"
            : "File",
      ),
    );
    button.addEventListener("click", async () => {
      try {
        if (entry.directory && !entry.application)
          await openBrowser(entry.path);
        else {
          await openPath(entry.path);
          $("#browse-dialog").close();
        }
      } catch (error) {
        notice(error.message, true);
      }
    });
    list.append(button);
  }
  if (!result.entries.length && !offset)
    list.append(element("p", "This folder is empty.", "view-note"));
  $("#browse-more").hidden = result.nextOffset === null;
  if (!$("#browse-dialog").open) $("#browse-dialog").showModal();
}

async function refreshConnections() {
  state.status = await api("/api/status");
  for (const control of document.querySelectorAll("[data-mac-apps]"))
    control.hidden = state.status.platform !== "darwin";
  $("#openai-status").textContent = state.status.openai.connected
    ? `Connected: ${state.status.openai.email}`
    : state.status.openai.error ||
      "Sign in with your ChatGPT account. Oopsware keeps its own connection.";
  $("#openai-connect").textContent = state.status.openai.connected
    ? "Reconnect ChatGPT"
    : "Continue with ChatGPT";
  $("#claude-status").textContent = state.status.claude.connected
    ? "Connected with an Anthropic API key."
    : "Connect with an Anthropic API key.";
  $("#local-status").textContent = state.status.ollama.connected
    ? `${state.status.ollama.models.length} Ollama models installed, including ${state.status.huggingface.models.length} from Hugging Face.`
    : state.status.ollama.error;
  await loadModels();
}
async function loadModels() {
  const provider = $("#provider").value;
  const preferred = state.selectedModels[provider];
  $("#model").replaceChildren(new Option("Loading models…", ""));
  $("#model-status").textContent = "Checking connection…";
  $("#send-destination").textContent =
    provider === "ollama" || provider === "huggingface"
      ? "Runs locally · no cloud fallback"
      : `Sent to ${labels[provider]} when you ask`;
  try {
    const choices = await api(`/api/models?provider=${provider}`);
    if ($("#provider").value !== provider) return;
    state.models = choices;
    $("#model").replaceChildren();
    for (const model of choices)
      $("#model").add(new Option(model.name, model.id));
    if (preferred && choices.some((model) => model.id === preferred))
      $("#model").value = preferred;
    if (!choices.length) $("#model").add(new Option("No installed models", ""));
    $("#model-status").textContent = choices.length
      ? `${choices.length} models available${provider === "huggingface" ? " · served locally by Ollama" : ""}`
      : "Install a model in Ollama, then refresh Models.";
    const connectButton = $("#chat-connect");
    if (connectButton)
      connectButton.hidden =
        provider !== "openai" || state.status?.openai.connected;
  } catch (error) {
    if ($("#provider").value !== provider) return;
    state.models = [];
    $("#model").replaceChildren(new Option("Connect to choose a model", ""));
    $("#model-status").textContent = error.message;
    const connectButton = $("#chat-connect");
    if (connectButton) connectButton.hidden = provider !== "openai";
  }
}
async function signIn() {
  const popup = window.open("about:blank", "rea-openai");
  if (popup) popup.opener = null;
  try {
    const { url } = await api("/api/auth/openai", {});
    if (popup) popup.location.href = url;
    else window.location.href = url;
    notice(
      "Complete the OpenAI sign-in in the browser. Oopsware will update when you return.",
    );
  } catch (error) {
    if (popup) popup.close();
    throw error;
  }
}
function newChat() {
  if (state.controller) state.controller.abort();
  state.messages = [];
  $("#chat-log").replaceChildren(
    element(
      "p",
      "New conversation. Ask about the selected artifact or its inspection results.",
      "view-note",
    ),
  );
}
function chatBubble(role, text) {
  if (!state.messages.length) $("#chat-log .chat-intro")?.remove();
  const row = element("div", undefined, `chat-message ${role}`);
  row.append(element("div", role === "user" ? "YOU" : "Oopsware", "role"));
  const content = element("div", text, "message-text");
  row.append(content);
  $("#chat-log").append(row);
  return { row, content };
}
function selectedContext() {
  if (!$("#include-context").checked || !state.selected) return "";
  const file = state.selected;
  const report = file.report
    ? JSON.stringify(file.report)
    : "No inspection collected.";
  const preview =
    file.preview?.text ??
    (file.preview
      ? hexDump(file.preview.hex.slice(0, 8192), file.preview.offset)
      : "Directory; no file preview.");
  return `Path: ${file.path}\nSize: ${file.size}\nPreview (up to 32,000 characters; starts at byte ${file.preview?.offset ?? 0}):\n${preview.slice(0, 32000)}\n\nREA inspection (up to 32,000 characters):\n${report.slice(0, 32000)}${report.length > 32000 ? "\n[Inspection context truncated; full report remains in Oopsware.]" : ""}`;
}
async function sendChat(event) {
  event.preventDefault();
  if (state.controller) return;
  const prompt = $("#prompt").value.trim();
  if (!prompt) return;
  const provider = $("#provider").value,
    model = $("#model").value;
  if (!model) {
    $("#models-dialog").showModal();
    notice("Connect a provider or choose an installed local model first.");
    return;
  }
  if (state.messages.length >= 38) {
    notice("Start a new conversation to keep the context manageable.", true);
    return;
  }
  chatBubble("user", prompt);
  const history = state.messages;
  history.push({ role: "user", content: prompt });
  $("#prompt").value = "";
  const answer = chatBubble("assistant", "");
  answer.row.classList.add("loading");
  const controller = new AbortController();
  state.controller = controller;
  $("#send-chat").disabled = true;
  $("#stop-chat").hidden = false;
  let text = "",
    done = false;
  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-rea-token": token },
      body: JSON.stringify({
        provider,
        model,
        messages: history,
        context: selectedContext(),
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const failure = await response.json();
      throw new Error(failure.message || "The model request failed.");
    }
    const reader = response.body.getReader(),
      decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line) continue;
          const value = JSON.parse(line);
          if (value.type === "error") throw new Error(value.message);
          if (value.type === "delta") {
            text += value.text;
            answer.content.textContent = text;
          }
          if (value.type === "done") done = true;
        }
        $("#chat-log").scrollTop = $("#chat-log").scrollHeight;
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    if (!done)
      throw new Error("The connection ended before the answer completed.");
  } catch (error) {
    answer.row.classList.add("error");
    answer.content.textContent = `${text}${text ? "\n\n" : ""}${error.name === "AbortError" ? "Stopped. Partial answer preserved." : error.message}`;
  } finally {
    if (text)
      history.push({ role: "assistant", content: text.slice(0, 80000) });
    else history.pop();
    answer.row.classList.remove("loading");
    state.controller = null;
    $("#send-chat").disabled = false;
    $("#stop-chat").hidden = true;
  }
}

for (const button of document.querySelectorAll(".dialog-close"))
  button.addEventListener("click", () => button.closest("dialog").close());
for (const button of document.querySelectorAll("[data-tab]"))
  button.addEventListener("click", () => setTab(button.dataset.tab));
action("#add-files", () => $("#file-input").click());
action("#welcome-add", () => $("#file-input").click());
$("#file-input").addEventListener("change", () => {
  uploadFiles([...$("#file-input").files]).catch((error) =>
    notice(error.message, true),
  );
  $("#file-input").value = "";
});
action("#browse-files", () => openBrowser(state.status?.home || "~"));
action("#welcome-browse", () => openBrowser(state.status?.home || "~"));
action("#browse-apps", () => openBrowser("/Applications"));
action("#welcome-apps", () => openBrowser("/Applications"));
action("#apps-installed", () => openBrowser("/Applications"));
action("#apps-user", () => openBrowser("~/Applications"));
action("#apps-system", () => openBrowser("/System/Applications"));
action("#open-path", () => {
  $("#path-dialog").showModal();
  $("#path-input").focus();
});
$("#path-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await openPath($("#path-input").value);
    $("#path-dialog").close();
  } catch (error) {
    notice(error.message, true);
  }
});
$("#browse-form").addEventListener("submit", (event) => {
  event.preventDefault();
  openBrowser($("#browse-location").value).catch((error) =>
    notice(error.message, true),
  );
});
action("#browse-up", () => openBrowser(state.browse.parent));
action("#browse-more", () =>
  openBrowser(state.browse.path, state.browse.nextOffset),
);
action("#select-folder", async () => {
  await openPath(state.browse.path);
  $("#browse-dialog").close();
});
action("#browse-parent", () =>
  openBrowser(
    state.selected.directory
      ? state.selected.path
      : state.selected.path.slice(0, state.selected.path.lastIndexOf("/")) ||
          "/",
  ),
);
action("#load-sample", async () => {
  addFile(await api("/api/sample", {}));
  await inspect("inspect");
});
action("#inspect", () => inspect("inspect"));
action("#analyze", () => inspect("analyze"));
action("#previous-page", () => changePage(-1));
action("#next-page", () => changePage(1));
action("#download-report", () => {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(state.selected.report, null, 2)], {
      type: "application/json",
    }),
  );
  const link = element("a");
  link.href = url;
  link.download = `${state.selected.name}.rea.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
action("#connections", async () => {
  $("#models-dialog").showModal();
  await refreshConnections();
});
action("#refresh-models", refreshConnections);
action("#openai-connect", signIn);
action("#chat-connect", signIn);
$("#claude-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("#claude-form button");
  busy(button, true, "Connecting…");
  try {
    await api("/api/auth/claude", { apiKey: $("#claude-key").value });
    $("#claude-key").value = "";
    await refreshConnections();
    notice("Claude connected.");
  } catch (error) {
    notice(error.message, true);
  } finally {
    busy(button, false);
  }
});
$("#model").addEventListener("change", () => {
  state.selectedModels[$("#provider").value] = $("#model").value;
});
$("#provider").addEventListener("change", () => {
  newChat();
  loadModels().catch((error) => notice(error.message, true));
});
action("#new-chat", newChat);
action("#stop-chat", () => state.controller?.abort());
$("#chat-form").addEventListener("submit", sendChat);
$("#prompt").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $("#chat-form").requestSubmit();
  }
});
let dragDepth = 0;
window.addEventListener("dragenter", (event) => {
  if ([...event.dataTransfer.types].includes("Files")) {
    event.preventDefault();
    dragDepth++;
    $("#drop-overlay").hidden = false;
  }
});
window.addEventListener("dragover", (event) => {
  if ([...event.dataTransfer.types].includes("Files")) event.preventDefault();
});
window.addEventListener("dragleave", (event) => {
  event.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $("#drop-overlay").hidden = true;
});
window.addEventListener("drop", (event) => {
  event.preventDefault();
  dragDepth = 0;
  $("#drop-overlay").hidden = true;
  uploadFiles([...event.dataTransfer.files]).catch((error) =>
    notice(error.message, true),
  );
});
window.addEventListener("focus", () => {
  if (state.status && !state.controller) refreshConnections().catch(() => {});
});
refreshConnections().catch((error) => notice(error.message, true));
