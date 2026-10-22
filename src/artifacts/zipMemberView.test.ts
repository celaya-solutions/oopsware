import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { expect, it } from "vitest";
import { DecodeBudget, MemberReadFailure, ZipView } from "./zipMemberView.js";

it("bounds ZIP member admission while preserving normal indexed reads", async () => {
  const writer = new ZipWriter(new Uint8ArrayWriter(), {
    useWebWorkers: false,
  });
  await writer.add("one", new TextReader("first"));
  await writer.add("two", new TextReader("second"));
  const bytes = await writer.close();
  await expect(ZipView.open(bytes, 1)).rejects.toMatchObject({
    reason: "budget",
  });
  await expect(ZipView.open(bytes, 0)).rejects.toBeInstanceOf(
    MemberReadFailure,
  );
  for (const maximum of [2, undefined]) {
    const zip = await ZipView.open(bytes, maximum);
    try {
      expect(zip.members.map((member) => member.path)).toEqual(["one", "two"]);
      expect(
        Buffer.from(
          await zip.read("two", new DecodeBudget(100, 100)),
        ).toString(),
      ).toBe("second");
    } finally {
      await zip.close();
    }
  }
});
