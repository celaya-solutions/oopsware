/**
 * Word field instructions ([MS-DOC] 2.8.25 Plcfld; the field codes are those of
 * ECMA-376 Part 1, 17.16): instructions are kept as written and never
 * evaluated. Only the targets of fields that point outside the document
 * (HYPERLINK, INCLUDEPICTURE, INCLUDETEXT, LINK, DDE, DDEAUTO) are taken
 * apart, so they can be listed; none is followed.
 */

/** Split a field instruction into arguments; quoted arguments keep their spaces, switches start with a backslash. */
const tokens = (instruction: string): { value: string; flag: boolean }[] => {
  const out: { value: string; flag: boolean }[] = [];
  let at = 0;
  while (at < instruction.length && out.length < 64) {
    const ch = instruction[at] ?? "";
    if (/\s/u.test(ch)) {
      at += 1;
      continue;
    }
    if (ch === '"') {
      const close = instruction.indexOf('"', at + 1);
      const end = close < 0 ? instruction.length : close;
      out.push({ value: instruction.slice(at + 1, end), flag: false });
      at = end + 1;
      continue;
    }
    let end = at;
    while (end < instruction.length && !/\s/u.test(instruction[end] ?? ""))
      end += 1;
    const value = instruction.slice(at, end);
    out.push({ value, flag: value.startsWith("\\") });
    at = end;
  }
  return out;
};

/** The target a HYPERLINK field names (ECMA-376 Part 1, 17.16.5.25): a URL or file and an optional bookmark (switch l); never followed. */
export const hyperlinkTarget = (
  instruction: string,
): { target: string; external: boolean } | null => {
  const args = tokens(instruction).slice(1);
  let url: string | undefined;
  let anchor: string | undefined;
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at];
    if (arg === undefined) break;
    if (arg.flag) {
      const name = arg.value.toLowerCase();
      if (name === "\\l") anchor = args[(at += 1)]?.value;
      else if (name === "\\o" || name === "\\t") at += 1;
    } else url ??= arg.value;
  }
  if (url !== undefined && url !== "")
    return {
      target: anchor === undefined ? url : `${url}#${anchor}`,
      external: true,
    };
  return anchor === undefined || anchor === ""
    ? null
    : { target: `#${anchor}`, external: false };
};

/** Fields that load content from outside the document, and which positional argument names it. */
const OUTSIDE: ReadonlyMap<string, number> = new Map([
  ["INCLUDEPICTURE", 0],
  ["INCLUDETEXT", 0],
  // LINK ProgId FileName [Place] and DDE/DDEAUTO App FileName [Place]: the file is the second argument.
  ["LINK", 1],
  ["DDE", 1],
  ["DDEAUTO", 1],
]);

/** The outside file an INCLUDEPICTURE, INCLUDETEXT, LINK, DDE or DDEAUTO field names, as written. */
export const fieldReference = (
  instruction: string,
): { kind: string; target: string } | null => {
  const all = tokens(instruction);
  const name = all[0]?.value.toUpperCase() ?? "";
  const position = OUTSIDE.get(name);
  if (position === undefined) return null;
  const args: string[] = [];
  for (let at = 1; at < all.length; at += 1) {
    const arg = all[at];
    if (arg === undefined) break;
    // A converter switch (\c) takes the next argument.
    if (arg.flag) at += arg.value.toLowerCase() === "\\c" ? 1 : 0;
    else args.push(arg.value);
  }
  const target = args[position];
  return target === undefined || target === ""
    ? null
    : { kind: name.toLowerCase(), target };
};
