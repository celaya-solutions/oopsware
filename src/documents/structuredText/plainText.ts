import type { DocumentBuilder } from "./DocumentBuilder.js";

/** Plain text as lines, each with its exact newline and source offset. */
export const walkPlainText = (builder: DocumentBuilder): number => {
  builder.unit = "line";
  const { text, lineStarts } = builder.source;
  if (text.length === 0) return 0;
  let lines = 0;
  for (const [line, start] of lineStarts.entries()) {
    if (start === text.length && line > 0) break;
    const next = lineStarts[line + 1] ?? text.length;
    let end = next;
    while (end > start && /[\r\n]/u.test(text[end - 1] ?? "")) end -= 1;
    const newline = text.slice(end, next);
    lines += 1;
    builder.node({
      depth: 0,
      kind: "line",
      path: `line ${String(line + 1)}`,
      value: text.slice(start, end),
      record: line + 1,
      at: start,
      end: next,
      details: {
        newline:
          newline === "\r\n"
            ? "crlf"
            : newline === "\r"
              ? "cr"
              : newline === "\n"
                ? "lf"
                : null,
      },
    });
  }
  return lines;
};
