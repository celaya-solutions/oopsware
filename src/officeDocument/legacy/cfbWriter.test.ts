import { describe, expect, it } from "vitest";

import { CompoundFile } from "../../windowsInstaller/cfb.js";
import { writeCompoundFile } from "../../../tests/fixtures/cfbWriter.js";

const pattern = (length: number, seed: number): Uint8Array =>
  Uint8Array.from({ length }, (_, at) => (at * 7 + seed) & 0xff);

const open = async (bytes: Uint8Array): Promise<CompoundFile> =>
  await CompoundFile.open(
    async (offset, length) => bytes.subarray(offset, offset + length),
    bytes.length,
  );

describe("compound file fixture writer", () => {
  it("round-trips mini streams, regular streams and nested storages through the reader", async () => {
    const small = pattern(100, 1);
    const medium = pattern(3000, 2);
    const large = pattern(70_000, 3);
    const nested = pattern(5000, 4);
    const bytes = writeCompoundFile([
      { name: "WordDocument", data: large },
      { name: "\u0005SummaryInformation", data: small },
      { name: "Empty", data: new Uint8Array(0) },
      { name: "1Table", data: medium },
      {
        name: "ObjectPool",
        children: [
          {
            name: "_1",
            children: [{ name: "\u0001Ole10Native", data: nested }],
          },
        ],
      },
    ]);
    const file = await open(bytes);
    expect(file.problems).toEqual([]);
    const read = async (path: string[]): Promise<Uint8Array> => {
      const entry = file.entries.find(
        (candidate) => candidate.path.join("/") === path.join("/"),
      );
      if (entry === undefined) throw new Error(path.join("/"));
      return await file.read(entry, entry.size);
    };
    expect(await read(["WordDocument"])).toEqual(large);
    expect(await read(["\u0005SummaryInformation"])).toEqual(small);
    expect(await read(["1Table"])).toEqual(medium);
    expect(await read(["Empty"])).toEqual(new Uint8Array(0));
    expect(await read(["ObjectPool", "_1", "\u0001Ole10Native"])).toEqual(
      nested,
    );
    expect(
      file.entries.map((entry) => `${entry.type}:${entry.path.join("/")}`),
    ).toContain("storage:ObjectPool/_1");
  });
});
