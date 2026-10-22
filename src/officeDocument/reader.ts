import type {
  OfficeContentPart,
  OfficeDiagnostic,
  OfficeItem,
  OfficeOmission,
} from "../domain/officeDocument/officeDocument.js";

/** Longest text one item carries; longer text is cut and counted as an omission. */
export const MAX_ITEM_TEXT = 32_768;
const MAX_DIAGNOSTICS = 200;

/** What a read observed and left out, collected while the content is walked. */
export class ReaderCounters {
  readonly #counts = new Map<string, number>();
  readonly #omissions = new Map<string, { count: number; note: string }>();
  readonly diagnostics: OfficeDiagnostic[] = [];
  #diagnosticsDropped = 0;

  add(name: string, by = 1): void {
    this.#counts.set(name, (this.#counts.get(name) ?? 0) + by);
  }

  set(name: string, value: number): void {
    this.#counts.set(name, value);
  }

  omit(kind: string, note: string, by = 1): void {
    const current = this.#omissions.get(kind);
    this.#omissions.set(kind, { count: (current?.count ?? 0) + by, note });
  }

  diagnose(location: string | null, message: string): void {
    if (this.diagnostics.length >= MAX_DIAGNOSTICS)
      this.#diagnosticsDropped += 1;
    else this.diagnostics.push({ location, message });
  }

  get counts(): Record<string, number> {
    return Object.fromEntries(
      [...this.#counts].filter(([, value]) => value > 0).sort(),
    );
  }

  get omissions(): OfficeOmission[] {
    return [...this.#omissions].map(([kind, entry]) => ({
      kind,
      count: entry.count,
      note: entry.note,
    }));
  }

  get diagnosticsDropped(): number {
    return this.#diagnosticsDropped;
  }
}

/** Cut text at the per-item limit, never inside a surrogate pair, and count the cut. */
export const capText = (text: string, counters: ReaderCounters): string => {
  if (text.length <= MAX_ITEM_TEXT) return text;
  let end = MAX_ITEM_TEXT;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  counters.omit(
    "truncated-text",
    `Text longer than ${String(MAX_ITEM_TEXT)} characters is cut in the item.`,
  );
  return `${text.slice(0, end)}…`;
};

/** One document's content, read part by part in document order. */
export interface DocumentReader {
  readonly family: "word" | "excel" | "powerpoint";
  /** The parts a caller can select, the first being the default. */
  contentParts(): readonly OfficeContentPart[];
  defaultPart(): OfficeContentPart | undefined;
  /** Walk one part, calling visit for each item in order. A part that cannot be read becomes a diagnostic. */
  forEach(
    part: OfficeContentPart,
    visit: (item: OfficeItem) => void,
  ): Promise<void>;
}
