import type { ReaderCounters } from "../reader.js";
import { OffsetList, RT, type PptStream, type Span } from "./pptRecords.js";
import { TextReader, type ActionSink, type TextBody } from "./pptText.js";

/**
 * One slide's outline text in the slide list ([MS-PPT] 2.4.14.3): the records
 * between its SlidePersistAtom and the next. The slide list is kept as offset
 * ranges and read here, slide by slide, when the slide is walked. An
 * OutlineTextRefAtom's index counts TextHeaderAtom records only; characters
 * before the first header are read as unplaced text and flagged.
 */
export class Outline {
  readonly #stream: PptStream;
  readonly #counters: ReaderCounters;
  readonly #span: Span;
  readonly #location: string;
  readonly #taken = new Set<number>();
  #headers: OffsetList | null = null;

  constructor(
    stream: PptStream,
    counters: ReaderCounters,
    span: Span,
    location: string,
  ) {
    this.#stream = stream;
    this.#counters = counters;
    this.#span = span;
    this.#location = location;
  }

  /** Offsets of the slide's TextHeaderAtom records, found once. */
  async #index(): Promise<OffsetList> {
    if (this.#headers !== null) return this.#headers;
    const headers = new OffsetList();
    const cursor = this.#stream.cursor(this.#span, this.#location);
    for (let record = cursor.next(); record !== null; record = cursor.next()) {
      if (this.#stream.due) await this.#stream.pause();
      if (record.type === RT.textHeaderAtom) headers.push(record.offset);
    }
    cursor.report(this.#counters);
    this.#headers = headers;
    return headers;
  }

  async #read(
    start: number,
    end: number,
    sink: ActionSink,
  ): Promise<TextBody[]> {
    const reader = new TextReader(this.#stream, this.#counters, sink);
    const cursor = this.#stream.cursor(
      { start, length: end - start },
      this.#location,
    );
    for (let record = cursor.next(); record !== null; record = cursor.next()) {
      if (this.#stream.due) await this.#stream.pause();
      await reader.feed(record);
    }
    return reader.bodies;
  }

  #end(headers: OffsetList, index: number): number {
    return index + 1 < headers.length
      ? headers.get(index + 1)
      : this.#span.start + this.#span.length;
  }

  /** Outline body `index` (undefined when the slide has none there, null when a shape already took it). */
  async body(
    index: number,
    sink: ActionSink,
  ): Promise<TextBody | null | undefined> {
    const headers = await this.#index();
    if (index < 0 || index >= headers.length) return undefined;
    if (this.#taken.has(index)) return null;
    this.#taken.add(index);
    const [body] = await this.#read(
      headers.get(index),
      this.#end(headers, index),
      sink,
    );
    return body;
  }

  /** Text no shape took: characters before the first header, then each untaken body. */
  async rest(sink: ActionSink): Promise<TextBody[]> {
    const headers = await this.#index();
    const first =
      headers.length > 0
        ? headers.get(0)
        : this.#span.start + this.#span.length;
    const rest = await this.#read(this.#span.start, first, sink);
    for (let index = 0; index < headers.length; index += 1)
      if (!this.#taken.has(index)) {
        this.#taken.add(index);
        rest.push(
          ...(await this.#read(
            headers.get(index),
            this.#end(headers, index),
            sink,
          )),
        );
      }
    return rest;
  }
}
