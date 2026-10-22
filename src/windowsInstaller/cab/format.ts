/** A structural problem at an exact byte offset of one cabinet. */
export class CabFormatError extends Error {
  constructor(
    readonly offset: number,
    message: string,
  ) {
    super(message);
    this.name = "CabFormatError";
  }
}

/** A well-formed cabinet using something this reader does not decode: Quantum, LZX, a span across cabinets. */
export class CabUnsupportedError extends Error {
  constructor(
    readonly feature: string,
    message: string,
  ) {
    super(message);
    this.name = "CabUnsupportedError";
  }
}

/** A read that would decode more bytes than the caller allowed. */
export class CabLimitError extends Error {
  constructor(
    readonly needed: number,
    readonly limit: number,
    message: string,
  ) {
    super(message);
    this.name = "CabLimitError";
  }
}

/** Positional read of the cabinet: bytes [offset, offset+length) from its first byte. */
export type CabRead = (offset: number, length: number) => Promise<Uint8Array>;

/** Cabinets are little-endian throughout ([MS-CAB] 2). */
export const u16 = (bytes: Uint8Array, at: number): number =>
  (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);

export const u32 = (bytes: Uint8Array, at: number): number =>
  ((bytes[at] ?? 0) |
    ((bytes[at + 1] ?? 0) << 8) |
    ((bytes[at + 2] ?? 0) << 16) |
    ((bytes[at + 3] ?? 0) << 24)) >>>
  0;

/** Bounds-checked positional reads over the cabinet's usable bytes. */
export class CabSource {
  constructor(
    readonly read: CabRead,
    /** The smaller of the declared cabinet size and the bytes present; nothing past it is read. */
    readonly end: number,
  ) {}

  async bytes(
    offset: number,
    length: number,
    what: string,
  ): Promise<Uint8Array> {
    if (offset < 0 || length < 0 || offset + length > this.end)
      throw new CabFormatError(
        offset,
        `${what} needs bytes ${String(offset)}..${String(offset + length)} but the cabinet ends at ${String(this.end)}.`,
      );
    if (length === 0) return new Uint8Array(0);
    const bytes = await this.read(offset, length);
    if (bytes.length !== length)
      throw new CabFormatError(
        offset,
        `${what} is truncated: ${String(bytes.length)} of ${String(length)} bytes could be read.`,
      );
    return bytes;
  }
}

/**
 * The cabinet checksum ([MS-CAB] 3.2 CSUMCompute): XOR of little-endian
 * 32-bit words, then the 1-3 tail bytes packed with the FIRST tail byte
 * highest, not as a little-endian word.
 */
export const cabChecksum = (bytes: Uint8Array, seed: number): number => {
  let sum = seed >>> 0;
  const whole = bytes.length - (bytes.length % 4);
  for (let at = 0; at < whole; at += 4) sum = (sum ^ u32(bytes, at)) >>> 0;
  let tail = 0;
  for (let at = whole; at < bytes.length; at += 1)
    tail = (tail << 8) | (bytes[at] ?? 0);
  return (sum ^ tail) >>> 0;
};

/** A DOS date and time as stored, ISO-8601 without a zone, or null when a field is out of range. */
export const dosDateTime = (date: number, time: number): string | null => {
  const year = (date >>> 9) + 1980;
  const month = (date >>> 5) & 0x0f;
  const day = date & 0x1f;
  const hour = time >>> 11;
  const minute = (time >>> 5) & 0x3f;
  const second = (time & 0x1f) * 2;
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    check.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    return null;
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}`;
};
