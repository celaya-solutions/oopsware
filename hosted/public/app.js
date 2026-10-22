import MarkdownIt from "markdown-it";

import { wasmBody, wasmProblemCount, wasmStatus } from "./wasmView.js";

// Raw HTML stays text. Markdown links use the parser's protocol validation;
// images stay descriptions, so uploaded documents cannot make remote requests.
const markdown = new MarkdownIt({
  html: false,
  linkify: false,
  typographer: false,
});
markdown.renderer.rules.image = (tokens, index) =>
  markdown.utils.escapeHtml(tokens[index].content || "[image]");
const renderMarkdown = (text) => {
  const element = node("div", undefined, "markdown-body");
  element.innerHTML = markdown.render(text);
  for (const link of element.querySelectorAll("a")) {
    link.setAttribute("rel", "noreferrer noopener");
    link.setAttribute("target", "_blank");
  }
  return element;
};
const labels = {
  all: "Everything",
  archives: "Archives",
  apps: "Apps & binaries",
  source: "Source",
  data: "Data",
  documents: "Documents",
  media: "Media",
  models: "Models",
  other: "Other files",
};
const track = (event, properties) => window.oopsware?.track(event, properties);
// Plain "deletes in 3 hours" / "deletes in 20 minutes" from an ISO expiry.
const countdown = (iso) => {
  const ms = Date.parse(iso) - Date.now();
  if (ms <= 0) return "deleting soon";
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 1)
    return `deletes in ${hours} ${hours === 1 ? "hour" : "hours"}`;
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return `deletes in ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
};
let category = "all";
let lastTrigger;
let reportDownload;
let archiveItems = [];
const $ = (id) => document.getElementById(id);
let selected;
let selectedFile;
let nextOffset = null;
let fileLimit = 50;
let uploadController;
let selectionVersion = 0;
let listVersion = 0;
const bytes = (n) =>
  n >= 1024 ** 3
    ? `${(n / 1024 ** 3).toFixed(2)} GiB`
    : n >= 1024 ** 2
      ? `${(n / 1024 ** 2).toFixed(1)} MiB`
      : n >= 1024
        ? `${(n / 1024).toFixed(1)} KiB`
        : `${n} B`;
const node = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
};
const notice = (text) => {
  (document.querySelector("dialog[open]") ?? document.body).append($("notice"));
  $("notice-text").textContent = text;
  $("notice").hidden = false;
};
const safe =
  (action) =>
  (...args) => {
    Promise.resolve()
      .then(() => action(...args))
      .catch((error) => notice(error.message || "Something went wrong."));
  };
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, cache: "no-store" });
  const body = await response.json();
  if (!response.ok)
    throw new Error(body.error || `Request failed (${response.status}).`);
  return body;
}
const post = (path, body, options = {}) =>
  api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    ...options,
  });
const submissionPath = (id = selected?.id) =>
  `/api/submissions/${encodeURIComponent(id)}`;
$("dismiss-notice").onclick = () => {
  $("notice").hidden = true;
};
for (const button of document.querySelectorAll("[data-upload]"))
  button.onclick = () => $("upload-dialog").showModal();
$("close-upload").onclick = () => $("upload-dialog").close();
document.addEventListener("keydown", (event) => {
  if (
    event.key === "/" &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !document.querySelector("dialog[open]") &&
    !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)
  ) {
    event.preventDefault();
    $("search").focus();
  }
});

function showFile() {
  const file = $("file-input").files[0];
  $("file-name").textContent = file?.name ?? "Choose a file or drop it here";
  $("file-detail").textContent = file
    ? `${bytes(file.size)} · shared publicly after upload`
    : "Apps, archives, source, and documents · up to 1 GiB";
}
$("file-input").onchange = showFile;
$("drop-zone").ondragover = (event) => {
  event.preventDefault();
  $("drop-zone").classList.add("drag");
};
$("drop-zone").ondragleave = () => $("drop-zone").classList.remove("drag");
$("drop-zone").ondrop = (event) => {
  event.preventDefault();
  $("drop-zone").classList.remove("drag");
  if (event.dataTransfer.files.length) {
    $("file-input").files = event.dataTransfer.files;
    showFile();
  }
};
$("cancel-upload").onclick = () => uploadController?.abort();
$("upload-form").onsubmit = (event) => {
  event.preventDefault();
  void upload().catch((error) => notice(error.message));
};
async function upload() {
  const file = $("file-input").files[0];
  if (!file || !$("agreement").checked)
    throw new Error(
      "Choose a file and agree to public sharing without personal data.",
    );
  if (!file.size || file.size > 1024 ** 3)
    throw new Error("Choose a file from 1 byte to 1 GiB.");
  uploadController = new AbortController();
  const signal = uploadController.signal;
  $("upload-button").disabled = true;
  $("file-input").disabled = true;
  $("upload-progress").hidden = false;
  $("cancel-upload").hidden = false;
  $("progress-bar").value = 0;
  $("upload-status").textContent = "Preparing your upload…";
  let admission;
  let completed = false;
  try {
    track("upload_started", { autoDelete: $("retain").checked });
    admission = await post(
      "/api/submissions",
      {
        name: file.name,
        size: file.size,
        agreement: true,
        autoDelete: $("retain").checked,
      },
      { signal },
    );
    const headers = {
      Authorization: `Bearer ${admission.token}`,
      "Content-Type": "application/octet-stream",
    };
    let offset = 0;
    let failures = 0;
    while (offset < file.size) {
      signal.throwIfAborted();
      try {
        const result = await api(
          `${submissionPath(admission.id)}/chunk?offset=${offset}`,
          {
            method: "PUT",
            headers,
            body: file.slice(offset, offset + admission.chunkBytes),
            signal,
          },
        );
        offset = result.received;
        failures = 0;
      } catch (error) {
        if (signal.aborted || ++failures > 3) throw error;
        $("upload-status").textContent =
          "Connection interrupted. Resuming from the last saved chunk…";
        const saved = await api(submissionPath(admission.id), {
          headers,
          signal,
        });
        offset = saved.received;
        continue;
      }
      $("progress-bar").value = (offset / file.size) * 100;
      $("upload-status").textContent =
        `${bytes(offset)} / ${bytes(file.size)} · ${Math.round((offset / file.size) * 100)}%`;
    }
    await api(`${submissionPath(admission.id)}/complete`, {
      method: "POST",
      headers,
      signal,
    });
    completed = true;
    track("upload_completed");
    $("upload-status").textContent = "Published. Static inspection is queued.";
    $("upload-form").reset();
    $("retain").checked = true;
    showFile();
    await loadArchive();
    $("upload-dialog").close();
    await selectSubmission(admission.id);
  } catch (error) {
    if (signal.aborted) $("upload-status").textContent = "Upload canceled.";
    else {
      track("upload_failed");
      throw error;
    }
  } finally {
    if (!completed && admission)
      await api(submissionPath(admission.id), {
        method: "DELETE",
        headers: { Authorization: `Bearer ${admission.token}` },
      }).catch(() => {});
    $("upload-button").disabled = false;
    $("file-input").disabled = false;
    uploadController = undefined;
    $("cancel-upload").hidden = true;
  }
}

function renderCard(item) {
  const card = node("article", undefined, "item-card");
  const top = node("div", undefined, "card-top");
  const extension = item.name.includes(".")
    ? item.name.split(".").pop().slice(0, 5).toUpperCase()
    : "FILE";
  top.append(
    node("span", extension, `file-icon ${item.category}`),
    node(
      "span",
      item.status === "ready"
        ? "Ready to explore"
        : item.status === "failed"
          ? "Needs attention"
          : "Inspecting…",
      `pill ${item.status === "ready" ? "" : item.status === "failed" ? "failed" : "pending"}`,
    ),
  );
  const title = node("h3");
  const link = node("a", item.name, "card-title");
  link.href = `#submission=${item.id}`;
  link.onclick = (event) => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    lastTrigger = link;
    safe(() => selectSubmission(item.id))();
  };
  title.append(link);
  const meta = node("div", undefined, "card-meta");
  meta.append(node("span", labels[item.category], "card-category"));
  // The category is a filename hint; the observed format comes from the bytes.
  if (item.observedFormat)
    meta.append(
      node("span", "·"),
      node("span", item.observedFormat.label, "card-format"),
    );
  meta.append(
    node("span", "·"),
    node("span", bytes(item.size)),
    node("span", "·"),
    node(
      "time",
      new Date(item.createdAt).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      }),
    ),
  );
  meta.querySelector("time").dateTime = item.createdAt;
  if (item.expiresAt)
    meta.append(
      node("span", "·"),
      node("span", countdown(item.expiresAt), "card-countdown"),
    );
  const actions = node("div", undefined, "card-actions");
  const details = node("a", "View details ↗");
  details.href = link.href;
  details.setAttribute("aria-label", `View details for ${item.name}`);
  details.onclick = (event) => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    lastTrigger = details;
    safe(() => selectSubmission(item.id))();
  };
  actions.append(details);
  if (item.files.some((file) => file.id === item.id)) {
    const download = node("a", "Download ↓", "download-link");
    download.href = `${submissionPath(item.id)}/files/${item.id}`;
    download.download = item.name;
    download.setAttribute("aria-label", `Download ${item.name}`);
    download.onclick = () => track("download_clicked", { where: "card" });
    actions.append(download);
  }
  card.append(
    top,
    title,
    node("p", item.summary, "card-summary"),
    meta,
    actions,
  );
  return card;
}
async function loadArchive(append = false) {
  const version = ++listVersion;
  const query = $("search").value;
  const params = new URLSearchParams({
    q: query,
    category,
    status: $("status").value,
    sort: $("sort").value,
    offset: String(append ? (nextOffset ?? 0) : 0),
  });
  $("submissions").setAttribute("aria-busy", "true");
  $("load-more").disabled = true;
  try {
    const result = await api(`/api/submissions?${params}`);
    if (version !== listVersion) return;
    archiveItems = append
      ? [
          ...archiveItems,
          ...result.items.filter(
            (item) => !archiveItems.some((previous) => previous.id === item.id),
          ),
        ]
      : result.items;
    $("submissions").replaceChildren(...archiveItems.map(renderCard));
    $("archive-count").textContent =
      `${result.total.toLocaleString()} ${result.total === 1 ? "discovery" : "discoveries"}${query ? ` matching “${query}”` : " to explore"}`;
    $("total-count").textContent = result.archiveTotal.toLocaleString();
    for (const button of document.querySelectorAll("[data-category]")) {
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.category === category),
      );
      button.querySelector("span").textContent = (
        button.dataset.category === "all"
          ? result.matchingTotal
          : result.categories[button.dataset.category]
      ).toLocaleString();
    }
    const filtered = Boolean(
      query || category !== "all" || $("status").value !== "all",
    );
    $("clear-filters").hidden = !filtered;
    if (!archiveItems.length) {
      const empty = node("div", undefined, "empty");
      empty.append(
        node(
          "strong",
          filtered
            ? "Nothing here. Yet."
            : "A library starts with one discovery.",
        ),
        node(
          "p",
          filtered
            ? "Try another name or clear the filters to explore everything."
            : "Share a file to start the collection. Its findings and downloads will appear here.",
        ),
      );
      const action = node(
        "button",
        filtered ? "Clear filters" : "Upload the first file ↗",
        "button",
      );
      action.onclick = filtered
        ? clearFilters
        : () => $("upload-dialog").showModal();
      empty.append(action);
      $("submissions").append(empty);
    }
    nextOffset = result.nextOffset;
    $("load-more").hidden = nextOffset === null;
  } catch (error) {
    if (version !== listVersion) return;
    $("archive-count").textContent = "Could not refresh the library.";
    if (!archiveItems.length) {
      const empty = node("div", undefined, "empty");
      empty.append(
        node("strong", "The library couldn’t load."),
        node("p", "Please try again."),
      );
      const retry = node("button", "Try again", "button");
      retry.onclick = safe(() => loadArchive());
      empty.append(retry);
      $("submissions").replaceChildren(empty);
    }
    throw error;
  } finally {
    if (version === listVersion) {
      $("submissions").setAttribute("aria-busy", "false");
      $("load-more").disabled = false;
    }
  }
}
function clearFilters() {
  category = "all";
  $("search").value = "";
  $("status").value = "all";
  safe(() => loadArchive())();
}
$("clear-filters").onclick = clearFilters;
$("refresh").onclick = safe(() => loadArchive());
$("load-more").onclick = safe(() => loadArchive(true));
$("sort").onchange = safe(() => loadArchive());
$("status").onchange = safe(() => loadArchive());
for (const button of document.querySelectorAll("[data-category]"))
  button.onclick = safe(() => {
    category = button.dataset.category;
    track("filter_category", { category });
    return loadArchive();
  });
for (const button of document.querySelectorAll("[data-view]"))
  button.onclick = () => {
    const view = button.dataset.view;
    for (const other of document.querySelectorAll("[data-view]"))
      other.setAttribute("aria-pressed", String(other === button));
    $("files-panel").hidden = view !== "files";
    $("prompts-panel").hidden = view !== "prompts";
    track("view_switched", { view });
  };
let searchTimer;
$("search").oninput = () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(
    safe(() => loadArchive()),
    250,
  );
};
async function selectSubmission(id) {
  const version = ++selectionVersion;
  const value = await api(submissionPath(id));
  if (version !== selectionVersion) return;
  selected = value;
  selectedFile = undefined;
  fileLimit = 50;
  $("preview-area").replaceChildren(
    node("p", "Choose a file to read its bytes, text, and strings.", "empty"),
  );
  $("file-search").value = "";
  if (!$("detail-dialog").open) {
    $("detail-dialog").showModal();
    track("detail_opened", { status: value.status });
  }
  $("detail-summary").textContent = value.summary;
  $("download-original").href = `${submissionPath(id)}/files/${id}`;
  $("download-original").hidden = !value.files.some((file) => file.id === id);
  $("download-original").onclick = () =>
    track("download_clicked", { where: "detail" });
  $("investigation-name").textContent = value.name;
  $("investigation-meta").textContent =
    `${bytes(value.size)} / ${new Date(value.createdAt).toLocaleString()}` +
    (value.expiresAt ? ` / ${countdown(value.expiresAt)}` : "");
  history.replaceState(null, "", `#submission=${id}`);
  switchTab("report");
  await renderReport(version);
  if (version !== selectionVersion) return;
  renderFiles();
  await loadDocumentIndex(version);
  await loadWasmIndex(version);
  if (version !== selectionVersion) return;
  if (
    (documentView || wasmView || /\.(md|markdown)$/i.test(value.name)) &&
    value.files.length
  ) {
    switchTab("files");
    await loadPreview(value.files[0], 0);
  }
}
// Structured-text names the reader parses; others keep the byte preview only.
const TEXT_NAME = /\.(md|markdown|json|jsonl|ya?ml|toml|xml|csv|tsv|txt)$/i;
let documentView = null;
async function loadDocumentIndex(version) {
  documentView = null;
  if (
    !selected ||
    selected.status !== "ready" ||
    !TEXT_NAME.test(selected.name) ||
    !selected.files.some((file) => file.id === selected.id)
  )
    return;
  // Older uploads have no stored view; they keep the byte preview.
  const view = await api(`${submissionPath(selected.id)}/structure`).catch(
    () => null,
  );
  if (version === selectionVersion) documentView = view;
}
// WebAssembly originals get a decoded module view; others keep the byte preview.
let wasmView = null;
async function loadWasmIndex(version) {
  wasmView = null;
  if (
    !selected ||
    selected.status !== "ready" ||
    !/\.wasm$/i.test(selected.name) ||
    !selected.files.some((file) => file.id === selected.id)
  )
    return;
  // Older uploads and oversized modules have no stored view.
  const view = await api(`${submissionPath(selected.id)}/wasm`).catch(
    () => null,
  );
  if (version === selectionVersion) wasmView = view;
}
$("close-investigation").onclick = () => $("detail-dialog").close();
$("detail-dialog").addEventListener("close", () => {
  selectionVersion++;
  previewVersion++;
  selected = undefined;
  documentView = null;
  wasmView = null;
  if (reportDownload) {
    URL.revokeObjectURL(reportDownload);
    reportDownload = undefined;
  }
  history.replaceState(null, "", location.pathname + location.search);
  if (lastTrigger?.isConnected) lastTrigger.focus();
});
$("copy-link").onclick = safe(async () => {
  await navigator.clipboard.writeText(location.href);
  notice("Public investigation link copied.");
});
function switchTab(tab) {
  for (const name of ["report", "files"]) {
    $(`tab-${name}`).setAttribute("aria-selected", String(name === tab));
    $(`panel-${name}`).hidden = name !== tab;
    $(`tab-${name}`).tabIndex = name === tab ? 0 : -1;
  }
}
document.querySelectorAll("[data-tab]").forEach((button) => {
  button.onclick = () => switchTab(button.dataset.tab);
  button.onkeydown = (event) => {
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const tab =
        event.key === "Home"
          ? "report"
          : event.key === "End"
            ? "files"
            : button.dataset.tab === "report"
              ? "files"
              : "report";
      switchTab(tab);
      $(`tab-${tab}`).focus();
    }
  };
});
async function renderReport(version = selectionVersion) {
  if (!selected) return;
  const current = selected;
  $("report-content").replaceChildren();
  $("report-status").textContent =
    current.status === "failed"
      ? current.error
      : current.status !== "ready"
        ? "Static inspection is in progress. This page updates automatically."
        : "";
  if (current.status !== "ready") return;
  const report = await api(`${submissionPath(current.id)}/report`);
  if (version !== selectionVersion) return;
  const grid = node("div", undefined, "fact-grid");
  for (const [label, value] of [
    ["FORMAT", report.format],
    ["SIZE", bytes(report.size)],
    ["EXTRACTED FILES", String(report.files.length - 1)],
  ]) {
    const fact = node("div", undefined, "fact");
    fact.append(node("span", label), node("strong", value));
    grid.append(fact);
  }
  const digest = node("p", `SHA-256 / ${report.sha256}`, "digest");
  const columns = node("div", undefined, "report-columns");
  for (const [title, values] of [
    ["What we observed", report.observations],
    ["What remains unknown", report.limitations],
  ]) {
    const section = node("div");
    section.append(node("h3", title));
    const list = node("ul");
    for (const value of values) list.append(node("li", value));
    section.append(list);
    columns.append(section);
  }
  const download = node("a", "Download complete evidence JSON ↗", "button");
  download.href = `${submissionPath(current.id)}/report`;
  download.download = "analysis.json";
  const reportText = `# ${report.name.replace(/[\r\n]/g, " ")}\n\n${current.summary}\n\n## Observations\n\n${report.observations.map((value) => `- ${value}`).join("\n")}\n\n## Limits and unknowns\n\n${report.limitations.map((value) => `- ${value}`).join("\n")}\n\nSHA-256: ${report.sha256}\n`;
  if (reportDownload) URL.revokeObjectURL(reportDownload);
  reportDownload = URL.createObjectURL(
    new Blob([reportText], { type: "text/markdown;charset=utf-8" }),
  );
  const markdownDownload = node("a", "Download report .md ↓", "button");
  markdownDownload.href = reportDownload;
  markdownDownload.download = `${current.name}-report.md`;
  const downloads = node("div", undefined, "report-downloads");
  downloads.append(markdownDownload, download);
  $("report-content").append(grid, digest, columns, downloads);
}
function renderFiles() {
  if (!selected) return;
  const query = $("file-search").value.toLowerCase();
  const files = selected.files.filter((file) =>
    file.name.toLowerCase().includes(query),
  );
  $("file-list").replaceChildren();
  for (const file of files.slice(0, fileLimit)) {
    const button = node(
      "button",
      file.name,
      `file-item ${selectedFile?.id === file.id ? "selected" : ""}`,
    );
    button.append(
      node(
        "small",
        `${bytes(file.size)}${file.id === selected.id ? " · ORIGINAL" : ""}`,
      ),
    );
    button.onclick = safe(() => loadPreview(file, 0));
    $("file-list").append(button);
  }
  $("more-files").hidden = files.length <= fileLimit;
}
$("file-search").oninput = () => {
  fileLimit = 50;
  renderFiles();
};
$("more-files").onclick = () => {
  fileLimit += 50;
  renderFiles();
};
let previewVersion = 0;
async function loadPreview(file, offset, raw = false) {
  if (!selected) return;
  if (!raw && documentView && file.id === selected.id)
    return loadDocument(file, { view: "Read", segment: 0, page: 0 });
  if (!raw && wasmView && file.id === selected.id)
    return loadWasm(file, { view: "Module", page: 0 });
  const version = ++previewVersion,
    selection = selectionVersion;
  const id = selected.id;
  const preview = await api(
    `${submissionPath(id)}/files/${file.id}/preview?offset=${offset}`,
  );
  if (version !== previewVersion || selection !== selectionVersion) return;
  selectedFile = file;
  renderFiles();
  const toolbar = node("div", undefined, "preview-toolbar");
  const name = node("strong", file.name);
  const download = node("a", "Download ↓", "button");
  download.href = `${submissionPath(id)}/files/${file.id}`;
  download.download = file.name;
  toolbar.append(name, download);
  if (documentView && file.id === selected.id) {
    const back = node("button", "Structured view", "text-button");
    back.onclick = safe(() =>
      loadDocument(file, { view: "Read", segment: 0, page: 0 }),
    );
    toolbar.append(back);
  }
  if (wasmView && file.id === selected.id) {
    const back = node("button", "Module view", "text-button");
    back.onclick = safe(() => loadWasm(file, { view: "Module", page: 0 }));
    toolbar.append(back);
  }
  const tabs = node("div", undefined, "preview-tabs"),
    data = node("pre", undefined, "preview-data");
  const hex = () =>
    (preview.hex.match(/.{1,32}/g) || [])
      .map(
        (line, index) =>
          `${(offset + index * 16).toString(16).padStart(8, "0")}  ${line.match(/../g).join(" ")}`,
      )
      .join("\n");
  const values = {
    Text:
      preview.text ?? "This page contains binary bytes. Use Hex or Strings.",
    Hex: hex(),
    Strings:
      preview.strings
        .map((item) => `0x${item.offset.toString(16)}  ${item.text}`)
        .join("\n") || "No printable strings on this page.",
  };
  const rendered = node("div");
  const isMarkdown =
    /\.(md|markdown)$/i.test(file.name) && preview.text !== null;
  const show = (label) => {
    for (const button of tabs.querySelectorAll("button"))
      button.setAttribute("aria-pressed", String(button.textContent === label));
    data.hidden = label === "Markdown";
    rendered.hidden = label !== "Markdown";
    if (label === "Markdown")
      rendered.replaceChildren(renderMarkdown(preview.text));
    else data.textContent = values[label];
  };
  for (const label of [
    ...(isMarkdown ? ["Markdown"] : []),
    ...Object.keys(values),
  ]) {
    const button = node("button", label);
    button.onclick = () => show(label);
    tabs.append(button);
  }
  show(isMarkdown ? "Markdown" : preview.text === null ? "Hex" : "Text");
  const pagination = node("div", undefined, "preview-toolbar");
  const previous = node("button", "← Previous", "text-button"),
    next = node("button", "Next →", "text-button");
  previous.disabled = offset === 0;
  next.disabled = preview.nextOffset === null;
  previous.onclick = safe(() => loadPreview(file, Math.max(0, offset - 16384)));
  next.onclick = safe(() => loadPreview(file, preview.nextOffset));
  pagination.append(
    previous,
    node(
      "span",
      `${offset.toLocaleString()}–${(offset + preview.bytes).toLocaleString()} / ${bytes(preview.size)}`,
      "hint",
    ),
    next,
  );
  const pageNote = node(
    "p",
    "Preview shows a 16 KiB page. Markdown formatting may continue on the next page. Download the file for the complete document.",
    "hint",
  );
  pageNote.hidden =
    !isMarkdown || (offset === 0 && preview.nextOffset === null);
  $("preview-area").replaceChildren(
    toolbar,
    tabs,
    rendered,
    data,
    pageNote,
    pagination,
  );
}
const PROFILE_LABELS = {
  markdown: "Markdown",
  json: "JSON",
  jsonl: "JSON Lines",
  yaml: "YAML",
  toml: "TOML",
  xml: "XML",
  csv: "CSV",
  tsv: "TSV",
  "plain-text": "Plain text",
};
const PARSE_STATUS = {
  parsed: "read completely",
  partial: "read with problems",
  failed: "could not be read",
};
const where = (location) =>
  location
    ? `line ${location.line}, column ${location.column}, byte ${location.offset.toLocaleString()}`
    : "no source position";
const clip = (text, limit = 240) =>
  text.length > limit ? `${text.slice(0, limit)}…` : text;
// A table whose cells are text nodes only: formula-like cells cannot run.
const documentTable = (caption, headings, rows) => {
  const wrap = node("div", undefined, "doc-table-wrap");
  const table = node("table", undefined, "doc-table");
  table.append(node("caption", caption));
  const head = node("tr");
  for (const heading of headings) {
    const cell = node("th", heading);
    cell.scope = "col";
    head.append(cell);
  }
  const thead = node("thead");
  thead.append(head);
  const tbody = node("tbody");
  for (const { cells, className, label } of rows) {
    const row = node("tr", undefined, className);
    const [first, ...rest] = cells;
    const header = node("th", first);
    header.scope = "row";
    if (label) header.setAttribute("aria-label", label);
    row.append(header, ...rest.map((value) => node("td", value)));
    tbody.append(row);
  }
  table.append(thead, tbody);
  wrap.append(table);
  wrap.tabIndex = 0;
  return wrap;
};
/** Parser-aware reading for an original structured-text upload. */
async function loadDocument(file, state) {
  if (!selected || !documentView) return;
  const version = ++previewVersion,
    selection = selectionVersion;
  const id = selected.id;
  const view = documentView;
  const profile = view.format.profile;
  const tabular = profile === "csv" || profile === "tsv";
  const needsNodes =
    state.view === "Structure" || (state.view === "Read" && tabular);
  const segment =
    state.view === "Read" && !tabular && view.segments.length
      ? await api(`${submissionPath(id)}/previews/segment-${state.segment}`)
      : null;
  const page =
    needsNodes && view.node_pages
      ? await api(`${submissionPath(id)}/structure/nodes/${state.page}`)
      : null;
  if (version !== previewVersion || selection !== selectionVersion) return;
  selectedFile = file;
  renderFiles();
  const toolbar = node("div", undefined, "preview-toolbar");
  const download = node("a", "Download ↓", "button");
  download.href = `${submissionPath(id)}/files/${file.id}`;
  download.download = file.name;
  toolbar.append(node("strong", file.name), download);
  const status = node(
    "p",
    `${PROFILE_LABELS[profile] ?? profile} · ${view.encoding.name} · ${PARSE_STATUS[view.parse.status] ?? view.parse.status} · ${view.node_count.toLocaleString()} parts found`,
    "hint",
  );
  status.setAttribute("role", "status");
  const problems = view.diagnostics.length + view.diagnostics_omitted;
  const tabs = node("div", undefined, "preview-tabs");
  tabs.setAttribute("aria-label", "Ways to read this file");
  for (const label of [
    "Read",
    "Structure",
    ...(problems || view.limitations.length ? ["Problems"] : []),
    "Bytes",
  ]) {
    const button = node(
      "button",
      label === "Problems" && problems ? `Problems (${problems})` : label,
    );
    button.setAttribute("aria-pressed", String(label === state.view));
    button.onclick = safe(() =>
      label === "Bytes"
        ? loadPreview(file, 0, true)
        : loadDocument(file, { ...state, view: label }),
    );
    tabs.append(button);
  }
  const body = [];
  const pager = (index, count, label, go) => {
    const bar = node("div", undefined, "preview-toolbar");
    const previous = node("button", "← Previous", "text-button"),
      next = node("button", "Next →", "text-button");
    previous.disabled = index <= 0;
    next.disabled = index >= count - 1;
    previous.onclick = safe(() => go(index - 1));
    next.onclick = safe(() => go(index + 1));
    bar.append(previous, node("span", label, "hint"), next);
    return bar;
  };
  const nodePager = () =>
    pager(
      state.page,
      view.node_pages,
      `Page ${state.page + 1} of ${Math.max(1, view.node_pages)}`,
      (index) => loadDocument(file, { ...state, page: index }),
    );
  if (state.view === "Read" && tabular) {
    const rows = (page?.nodes ?? []).map((item) => ({
      cells: [String(item.record ?? item.index + 1), ...(item.fields ?? [])],
      className: item.details.formula_like_cells ? "formula" : undefined,
      label: item.details.formula_like_cells
        ? `Row ${item.record}, has cells a spreadsheet would run as formulas; shown as text`
        : undefined,
    }));
    const widest = Math.max(1, ...rows.map(({ cells }) => cells.length - 1));
    body.push(
      documentTable(
        `${PROFILE_LABELS[profile]} rows as text. No header meaning is assumed.`,
        ["Row", ...Array.from({ length: widest }, (_, i) => `Field ${i + 1}`)],
        rows,
      ),
      nodePager(),
    );
  } else if (state.view === "Read") {
    if (segment === null) body.push(node("p", "This file is empty.", "empty"));
    else {
      if (profile === "markdown") body.push(renderMarkdown(segment.text));
      else body.push(node("pre", segment.text, "preview-data"));
      if (!segment.segment.complete_units)
        body.push(
          node(
            "p",
            "This page splits a very long line or block; the next page continues it.",
            "hint",
          ),
        );
      body.push(
        pager(
          state.segment,
          view.segments.length,
          `Lines ${segment.segment.first_line.toLocaleString()}–${segment.segment.last_line.toLocaleString()} · page ${state.segment + 1} of ${view.segments.length}`,
          (index) => loadDocument(file, { ...state, segment: index }),
        ),
      );
    }
  } else if (state.view === "Structure") {
    body.push(
      documentTable(
        "Parsed parts in file order with where each one starts.",
        ["Where", "Path", "Kind", "Value"],
        (page?.nodes ?? []).map((item) => ({
          cells: [
            item.location
              ? `${item.location.line}:${item.location.column}`
              : "—",
            item.path || "/",
            item.kind,
            clip(
              item.value ??
                (item.fields
                  ? item.fields.join(" | ")
                  : typeof item.details.children === "number"
                    ? `${item.details.children} ${item.details.children === 1 ? "item" : "items"}`
                    : (item.name ?? "")),
            ),
          ],
        })),
      ),
    );
    if (view.stored_nodes < view.node_count)
      body.push(
        node(
          "p",
          `Showing the first ${view.stored_nodes.toLocaleString()} of ${view.node_count.toLocaleString()} parts. Download the original for the rest.`,
          "hint",
        ),
      );
    body.push(nodePager());
  } else {
    const list = node("ul", undefined, "diagnostic-list");
    for (const item of view.diagnostics)
      list.append(
        node(
          "li",
          `${item.severity.toUpperCase()} · ${item.message} (${where(item.location)}${item.record ? `, record ${item.record}` : ""})`,
        ),
      );
    if (view.diagnostics_omitted)
      list.append(
        node("li", `${view.diagnostics_omitted} more problems not listed.`),
      );
    const limits = node("ul", undefined, "diagnostic-list");
    for (const item of view.limitations) limits.append(node("li", item));
    body.push(
      node("h3", "Problems found", "doc-heading"),
      view.diagnostics.length ? list : node("p", "None.", "hint"),
      node("h3", "What this view does not do", "doc-heading"),
      limits,
    );
  }
  $("preview-area").replaceChildren(toolbar, status, tabs, ...body);
}
/** Decoded view of an original WebAssembly upload; the module never runs. */
async function loadWasm(file, state) {
  if (!selected || !wasmView) return;
  const version = ++previewVersion,
    selection = selectionVersion;
  const id = selected.id;
  const view = wasmView;
  const page =
    state.view === "Functions" && view.function_pages
      ? await api(`${submissionPath(id)}/wasm/functions/${state.page}`)
      : null;
  if (version !== previewVersion || selection !== selectionVersion) return;
  selectedFile = file;
  renderFiles();
  const toolbar = node("div", undefined, "preview-toolbar");
  const download = node("a", "Download original ↓", "button");
  download.href = `${submissionPath(id)}/files/${file.id}`;
  download.download = file.name;
  toolbar.append(node("strong", file.name), download);
  if (view.wat) {
    const derived = node("a", "Download derived text (.wat) ↓", "text-button");
    derived.href = `${submissionPath(id)}/outputs/${view.wat.id}`;
    derived.setAttribute(
      "aria-label",
      "Download the WebAssembly text rendered from this module by wabt.js; it is derived, not the original",
    );
    toolbar.append(derived);
  }
  const status = node("p", wasmStatus(view), "hint");
  status.setAttribute("role", "status");
  const problems = wasmProblemCount(view);
  const tabs = node("div", undefined, "preview-tabs");
  tabs.setAttribute("aria-label", "Ways to read this module");
  const labels =
    view.report.encoding.kind === "module"
      ? ["Module", "Functions", "Problems", "Bytes"]
      : ["Module", "Problems", "Bytes"];
  for (const label of labels) {
    const button = node(
      "button",
      label === "Problems" && problems ? `Problems (${problems})` : label,
    );
    button.setAttribute("aria-pressed", String(label === state.view));
    button.onclick = safe(() =>
      label === "Bytes"
        ? loadPreview(file, 0, true)
        : loadWasm(file, { view: label, page: 0 }),
    );
    tabs.append(button);
  }
  const body = wasmBody(view, state, page, { node, table: documentTable });
  if (state.view === "Functions" && view.function_pages > 1) {
    const bar = node("div", undefined, "preview-toolbar");
    const previous = node("button", "← Previous", "text-button"),
      next = node("button", "Next →", "text-button");
    previous.disabled = state.page <= 0;
    next.disabled = state.page >= view.function_pages - 1;
    previous.onclick = safe(() =>
      loadWasm(file, { ...state, page: state.page - 1 }),
    );
    next.onclick = safe(() =>
      loadWasm(file, { ...state, page: state.page + 1 }),
    );
    bar.append(
      previous,
      node("span", `Page ${state.page + 1} of ${view.function_pages}`, "hint"),
      next,
    );
    body.push(bar);
  }
  $("preview-area").replaceChildren(toolbar, status, tabs, ...body);
}
let polling = false;
setInterval(() => {
  if (polling) return;
  polling = true;
  void (async () => {
    if (selected && ["queued", "analyzing"].includes(selected.status)) {
      const id = selected.id,
        version = selectionVersion;
      const value = await api(submissionPath(id));
      if (version === selectionVersion && value.status !== selected.status) {
        selected = value;
        $("detail-summary").textContent = value.summary;
        $("download-original").hidden = !value.files.some(
          (file) => file.id === id,
        );
        await renderReport(version);
        await loadDocumentIndex(version);
        await loadWasmIndex(version);
        renderFiles();
        // A text or WebAssembly upload that just finished opens on its view.
        const original = value.files.find((file) => file.id === value.id);
        if ((documentView || wasmView) && original && !selectedFile) {
          switchTab("files");
          await loadPreview(original, 0);
        }
        await loadArchive();
      }
    }
  })()
    .catch((error) => notice(error.message))
    .finally(() => {
      polling = false;
    });
}, 2500);
void loadArchive().catch((error) => notice(error.message));
function openFromHash() {
  const match = /^#submission=([0-9a-f-]{36})$/.exec(location.hash);
  if (!match && $("detail-dialog").open) $("detail-dialog").close();
  if (match && selected?.id !== match[1])
    void selectSubmission(match[1]).catch((error) => notice(error.message));
}
window.addEventListener("hashchange", openFromHash);
openFromHash();
