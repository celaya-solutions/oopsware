import { createHash } from "node:crypto";

/** "PKCX": the four bytes before the PKCS#7 SignedData in AppxSignature.p7x. */
const MAGIC = [0x50, 0x4b, 0x43, 0x58];

export interface AppxSignaturePart {
  readonly size: number;
  /** The part starts with "PKCX". */
  readonly magic: boolean;
  /** Bytes after the magic: the PKCS#7 blob as stored. */
  readonly pkcs7_bytes: number;
  readonly pkcs7_sha256: string;
  /**
   * The blob's outer DER SEQUENCE length (header plus contents), or null
   * when it does not start with a definite-length SEQUENCE.
   */
  readonly der_length: number | null;
  readonly problems: readonly string[];
}

/** Length of a DER SEQUENCE at the start of `bytes`, header included; null when it is not one. */
const derSequenceLength = (bytes: Uint8Array): number | null => {
  if (bytes.length < 2 || bytes[0] !== 0x30) return null;
  const first = bytes[1] ?? 0;
  if (first < 0x80) return 2 + first;
  const count = first & 0x7f;
  if (count === 0 || count > 4 || bytes.length < 2 + count) return null;
  let length = 0;
  for (let index = 0; index < count; index += 1)
    length = length * 256 + (bytes[2 + index] ?? 0);
  return 2 + count + length;
};

/**
 * Record AppxSignature.p7x: its "PKCX" magic and the PKCS#7 blob's size,
 * digest and outer DER length. Nothing is verified: no signer, certificate
 * chain, timestamp or block-map digest is checked. Whether a package also
 * carries AppxMetadata/CodeIntegrity.cat is for the caller's member list.
 */
export const readAppxSignature = (bytes: Uint8Array): AppxSignaturePart => {
  const problems: string[] = [];
  const magic = MAGIC.every((byte, index) => bytes[index] === byte);
  if (!magic) problems.push('The signature part does not start with "PKCX".');
  const blob = bytes.subarray(magic ? MAGIC.length : 0);
  const der_length = derSequenceLength(blob);
  if (der_length === null)
    problems.push(
      "The PKCS#7 blob does not start with a definite-length DER SEQUENCE.",
    );
  else if (der_length !== blob.length)
    problems.push(
      `The PKCS#7 SEQUENCE spans ${String(der_length)} bytes; ${String(blob.length)} follow the magic.`,
    );
  return {
    size: bytes.length,
    magic,
    pkcs7_bytes: blob.length,
    pkcs7_sha256: createHash("sha256").update(blob).digest("hex"),
    der_length,
    problems,
  };
};
