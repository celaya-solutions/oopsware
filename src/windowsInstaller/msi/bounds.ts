/** Bounds on what one database may make the reader hold, and its capped problem list. */
export const MSI_LIMITS = {
  stringPoolBytes: 64 * 1024 ** 2,
  stringDataBytes: 512 * 1024 ** 2,
  tableBytes: 256 * 1024 ** 2,
  cells: 1 << 24,
  problems: 200,
} as const;

export class Problems {
  readonly #list: string[] = [];
  #dropped = 0;

  add(message: string): void {
    if (this.#list.length < MSI_LIMITS.problems) this.#list.push(message);
    else this.#dropped += 1;
  }

  done(): readonly string[] {
    const list = [...this.#list];
    if (this.#dropped > 0)
      list.push(`${String(this.#dropped)} further problems were not listed.`);
    return Object.freeze(list);
  }
}
