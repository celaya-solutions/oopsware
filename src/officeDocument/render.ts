import type {
  OfficeCell,
  OfficeItem,
} from "../domain/officeDocument/officeDocument.js";

const cellText = (value: string): string =>
  value.replace(/\r?\n/gu, " ").replace(/\|/gu, "\\|");

const table = (rows: readonly (readonly string[])[]): string[] => {
  const width = rows.reduce((most, row) => Math.max(most, row.length), 0);
  if (width === 0) return [];
  const pad = (row: readonly string[]): string =>
    `| ${Array.from({ length: width }, (_, at) => cellText(row[at] ?? "")).join(" | ")} |`;
  const [head = [], ...rest] = rows;
  return [
    pad(head),
    `| ${Array.from({ length: width }, () => "---").join(" | ")} |`,
    ...rest.map(pad),
  ];
};

const cellDisplay = (cell: OfficeCell): string => {
  const value = cell.value ?? "";
  if (cell.formula === null) return value;
  return value === "" ? `{=${cell.formula}}` : `${value} {=${cell.formula}}`;
};

const columnIndex = (ref: string): number => {
  let index = 0;
  for (const ch of ref) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) break;
    index = index * 26 + (code - 64);
  }
  return index;
};

/** Readable Markdown lines for one content item. Every item starts its own block. */
export const renderMarkdown = (item: OfficeItem): string[] => {
  switch (item.kind) {
    case "paragraph": {
      if (item.revision === "deleted" && item.text.trim() === "") return [];
      const body =
        item.heading_level !== null
          ? `${"#".repeat(Math.min(item.heading_level, 6))} ${item.text}`
          : item.list_level !== null
            ? `${"  ".repeat(Math.min(item.list_level, 8))}- ${item.text}`
            : item.text;
      const lines = body.split("\n");
      for (const link of item.links)
        lines.push(
          `> link: ${link.text} -> ${link.target}${link.external ? " (external)" : ""}`,
        );
      if (item.list_level === null) lines.push("");
      return item.text.trim() === "" && item.links.length === 0 ? [] : lines;
    }
    case "table":
      return [
        ...table(item.cells),
        ...(item.truncated
          ? ["> (table cut at the reader's row and column limit)"]
          : []),
        "",
      ];
    case "comment":
      return [
        `> **Comment** ${item.author ?? "unknown"}${item.date === null ? "" : ` ${item.date}`}: ${item.text.replace(/\n/gu, " ")}`,
        "",
      ];
    case "note":
      return [
        `[^${item.id ?? String(item.index)}]: ${item.text.replace(/\n/gu, " ")}`,
        "",
      ];
    case "row": {
      const cells: string[] = [];
      for (const cell of item.cells) {
        const at = columnIndex(cell.ref) - 1;
        // Columns end at XFD (16,384); a longer reference cannot grow the row.
        if (at < 0 || at >= 16_384) continue;
        while (cells.length < at) cells.push("");
        cells[at] = cellDisplay(cell);
      }
      return [`| ${String(item.row)} | ${cells.map(cellText).join(" | ")} |`];
    }
    case "slide": {
      const lines = [
        `## Slide ${String(item.number)}${item.title === null ? "" : `: ${item.title.replace(/\n/gu, " ")}`}${item.hidden ? " (hidden)" : ""}`,
        "",
      ];
      for (const text of item.texts) {
        for (const line of text.text.split("\n"))
          lines.push(line.trim() === "" ? "" : `- ${line}`);
      }
      for (const grid of item.tables) lines.push("", ...table(grid));
      if (item.notes !== null)
        lines.push(
          "",
          ...item.notes.split("\n").map((line) => `> Notes: ${line}`),
        );
      for (const link of item.links)
        lines.push(
          `> link: ${link.text} -> ${link.target}${link.external ? " (external)" : ""}`,
        );
      lines.push("");
      return lines;
    }
  }
};
