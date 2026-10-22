/**
 * Sequential pull reader over a byte stream. It never seeks: archive readers
 * built on it work for plain files and decoded compression streams alike.
 */
export class ByteSource {
  readonly #iterator: AsyncIterator<Buffer | Uint8Array | string>;
  #chunks: Buffer[] = [];
  #buffered = 0;
  #position = 0;
  #ended = false;

  constructor(stream: AsyncIterable<Buffer | Uint8Array | string>) {
    this.#iterator = stream[Symbol.asyncIterator]();
  }

  /** Bytes consumed so far. */
  get position(): number {
    return this.#position;
  }

  async #fill(wanted: number): Promise<void> {
    while (this.#buffered < wanted && !this.#ended) {
      const next = await this.#iterator.next();
      if (next.done === true) {
        this.#ended = true;
        break;
      }
      const chunk =
        typeof next.value === "string"
          ? Buffer.from(next.value)
          : Buffer.from(
              next.value.buffer,
              next.value.byteOffset,
              next.value.byteLength,
            );
      if (chunk.length === 0) continue;
      this.#chunks.push(chunk);
      this.#buffered += chunk.length;
    }
  }

  #consume(length: number): Buffer {
    const parts: Buffer[] = [];
    let remaining = length;
    while (remaining > 0) {
      const head = this.#chunks[0];
      if (head === undefined) break;
      if (head.length <= remaining) {
        parts.push(head);
        this.#chunks.shift();
        remaining -= head.length;
      } else {
        parts.push(head.subarray(0, remaining));
        this.#chunks[0] = head.subarray(remaining);
        remaining = 0;
      }
    }
    const taken = length - remaining;
    this.#buffered -= taken;
    this.#position += taken;
    return parts.length === 1 && parts[0] !== undefined
      ? parts[0]
      : Buffer.concat(parts, taken);
  }

  /** Look at up to `length` bytes without consuming them. */
  async peek(length: number): Promise<Buffer> {
    await this.#fill(length);
    const view = Buffer.concat(this.#chunks, Math.min(this.#buffered, length));
    return view.subarray(0, Math.min(view.length, length));
  }

  /** Read up to `length` bytes; fewer means the stream ended. */
  async read(length: number): Promise<Buffer> {
    await this.#fill(length);
    return this.#consume(Math.min(length, this.#buffered));
  }

  /** Yield exactly `length` bytes in arrival-sized pieces, or fewer at end of stream. */
  async *take(length: number): AsyncGenerator<Buffer> {
    let remaining = length;
    while (remaining > 0) {
      if (this.#buffered === 0) await this.#fill(1);
      if (this.#buffered === 0) return;
      const head = this.#chunks[0];
      const piece = this.#consume(Math.min(remaining, head?.length ?? 0));
      remaining -= piece.length;
      yield piece;
    }
  }

  /** Consume up to `length` bytes, returning how many were present. */
  async skip(length: number): Promise<number> {
    let skipped = 0;
    for await (const piece of this.take(length)) skipped += piece.length;
    return skipped;
  }

  /** Release the underlying iterator. */
  async return(): Promise<void> {
    this.#chunks = [];
    this.#buffered = 0;
    await this.#iterator.return?.();
  }
}
