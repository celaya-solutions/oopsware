/** Repeated long text one method view may show in full. */
export const REPEATED_TEXT_BUDGET = 4 * 1024 ** 2;
/** Text this long or shorter is always shown in full and is never charged. */
const ALWAYS_FULL = 256;

/**
 * A constant-pool string can be 64 KB and one method can load it from
 * thousands of instructions, so the text of a method view grows with
 * instructions times string length, not with the file. Text stays exact while
 * the budget lasts; after that a long value is cut to its start plus its length.
 */
export class TextBudget {
  #remaining = REPEATED_TEXT_BUDGET;
  #shortened = false;

  get shortened(): boolean {
    return this.#shortened;
  }

  take(text: string): string {
    if (text.length <= ALWAYS_FULL) return text;
    if (text.length <= this.#remaining) {
      this.#remaining -= text.length;
      return text;
    }
    this.#shortened = true;
    return `${text.slice(0, ALWAYS_FULL)}… (${String(text.length)} characters)`;
  }

  /** `take` for a value that may be absent. */
  takeOrNull(text: string | null): string | null {
    return text === null ? null : this.take(text);
  }
}
