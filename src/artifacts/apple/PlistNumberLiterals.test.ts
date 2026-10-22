import { describe, expect, it } from "vitest";

import {
  decodeBinaryPlistNumbers,
  scanBinaryPlistNumberLiterals,
} from "./PlistNumberLiterals.js";

const dataObjectWithUnusedOverlappingInteger = (): Buffer => {
  const bytes = Buffer.alloc(66);
  Buffer.from("bplist00", "ascii").copy(bytes);
  bytes[8] = 0xa1; // One-element array referencing data object 1.
  bytes[9] = 1;
  bytes[10] = 0x4f; // Data object with an extended length of 18 bytes.
  bytes[11] = 0x10;
  bytes[12] = 18;
  bytes[13] = 0x14; // An unused object-table entry points into this data.
  bytes.fill(0xff, 14, 30);
  bytes[30] = 0;
  bytes.set([8, 10, 13], 31); // object offsets, including the overlapping entry
  bytes[40] = 1; // offset width
  bytes[41] = 1; // reference width
  bytes.writeBigUInt64BE(3n, 42);
  bytes.writeBigUInt64BE(0n, 50);
  bytes.writeBigUInt64BE(31n, 58);
  return bytes;
};

describe("binary plist number rewriting", () => {
  it("does not rewrite an integer marker inside another object's data", () => {
    const bytes = dataObjectWithUnusedOverlappingInteger();
    const metadata = scanBinaryPlistNumberLiterals(bytes);

    expect(metadata.literals.incomplete).toBe(true);
    expect(metadata.wideIntegers).toEqual([]);
    expect(decodeBinaryPlistNumbers(bytes, metadata)).toBe(bytes);
    expect(bytes.subarray(13, 30)).toEqual(
      Buffer.from([0x14, ...Array<number>(16).fill(0xff)]),
    );
  });
});
