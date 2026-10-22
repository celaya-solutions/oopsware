// Client-side filtering for the file-types page. Works on top of static HTML,
// so the page is fully readable with JavaScript disabled.
const search = document.getElementById("formats-search");
const empty = document.getElementById("formats-empty");
const entries = [...document.querySelectorAll(".fmt")];
const tiers = [...document.querySelectorAll(".tier")];
let tier = "all";

const apply = () => {
  const query = (search?.value ?? "").trim().toLowerCase();
  let shown = 0;
  for (const entry of entries) {
    const okTier = tier === "all" || entry.dataset.tier === tier;
    const okText = !query || entry.dataset.text.includes(query);
    const visible = okTier && okText;
    entry.hidden = !visible;
    if (visible) shown += 1;
  }
  for (const section of tiers)
    section.classList.toggle(
      "is-empty",
      !section.querySelector(".fmt:not([hidden])"),
    );
  if (empty) empty.hidden = shown !== 0;
  window.oopsware?.track("formats_filter", { tier, hasQuery: Boolean(query) });
};

search?.addEventListener("input", apply);
for (const button of document.querySelectorAll(".tier-filter button"))
  button.addEventListener("click", () => {
    tier = button.dataset.tierFilter;
    for (const other of document.querySelectorAll(".tier-filter button"))
      other.setAttribute("aria-pressed", String(other === button));
    apply();
  });
