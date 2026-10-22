import { expect, it } from "vitest";
import { readGoBinaryImage } from "./GoBinaryImage.js";
import { readGoPeImage } from "./GoPeImage.js";
import {
  createGoBinaryFixture,
  setGoPeVirtualSize,
} from "../../tests/fixtures/go/image.js";

it.each([32, 64] as const)(
  "uses raw-size fallback for PE%d Go build-info and keeps RVA mappings intact",
  (bits) => {
    for (const encoding of ["inline", "pointer"] as const) {
      const fixture = createGoBinaryFixture({ format: "pe", bits, encoding });
      const expected = readGoBinaryImage(fixture.bytes).build_info;
      expect(expected).not.toBeNull();
      setGoPeVirtualSize(fixture.bytes, 0);

      const container = readGoPeImage(fixture.bytes);
      expect(container.sections[0]).toMatchObject({
        name: ".data",
        offset: 1024,
        size: 2048,
        file_backed: true,
      });
      expect(container.mappings[0]).toMatchObject({
        address: 0x10400n,
        offset: 1024,
        size: 2048,
      });
      expect(container.search[0]).toMatchObject({
        address: 0x10400n,
        offset: 1024,
        size: 2048,
      });
      expect(readGoBinaryImage(fixture.bytes).build_info).toEqual(expected);
    }
  },
);

it.each(["inline", "pointer"] as const)(
  "does not search PE raw alignment padding beyond a nonzero VirtualSize (%s)",
  (encoding) => {
    const fixture = createGoBinaryFixture({ format: "pe", bits: 64, encoding });
    // Put an otherwise valid, aligned record in the raw-only tail.
    fixture.bytes.copy(
      fixture.bytes,
      fixture.headerOffset + 512,
      fixture.headerOffset,
      fixture.headerOffset + 512,
    );
    fixture.bytes.fill(0, fixture.headerOffset, fixture.headerOffset + 512);
    setGoPeVirtualSize(fixture.bytes, 512);

    const container = readGoPeImage(fixture.bytes);
    expect(container.sections[0]).toMatchObject({
      size: 512,
      file_backed: true,
    });
    expect(container.mappings[0]).toMatchObject({ size: 2048, offset: 1024 });
    expect(container.search[0]).toMatchObject({ size: 512, offset: 1024 });
    expect(readGoBinaryImage(fixture.bytes).build_info).toBeNull();
  },
);
