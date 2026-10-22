import { isPaddedBase64 } from "./stringPatterns.js";

/** Validate padded syntax without imposing canonical zero pad bits. */
export const paddedBase64ByteLength = (value: string): number | undefined => {
  if (!isPaddedBase64(value)) return undefined;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
};

export const decodePaddedBase64 = (value: string): Buffer | undefined =>
  paddedBase64ByteLength(value) === undefined
    ? undefined
    : Buffer.from(value, "base64");
