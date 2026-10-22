import { build, buildBinary } from "plist";
import { expect, it } from "vitest";

import { decodeKeyedArchiveBytes } from "../../../src/artifacts/apple/KeyedArchiveReader.js";

it.each([
  { name: "data", value: new Uint8Array([0]) },
  { name: "date", value: new Date(0) },
  { name: "real", value: Number.POSITIVE_INFINITY },
])(
  "rejects a $name scalar used as the top-level root dictionary in either encoding",
  ({ value }) => {
    const archive = {
      $archiver: "NSKeyedArchiver",
      $version: 100000,
      $objects: ["$null"],
      $top: value,
    };
    for (const encode of [build, buildBinary]) {
      const bytes = Buffer.from(encode(archive));
      expect(() =>
        decodeKeyedArchiveBytes(bytes, { offset: 0, limit: 10 }),
      ).toThrow("Keyed archive has no $top roots");
    }
  },
);

it("keeps literal wrapper-shaped dictionaries as real root maps", () => {
  const top = { $plist_type: "data", base64: "AA==" };
  const archive = {
    $archiver: "NSKeyedArchiver",
    $version: 100000,
    $objects: ["$null"],
    $top: top,
  };
  for (const encode of [build, buildBinary]) {
    const graph = decodeKeyedArchiveBytes(Buffer.from(encode(archive)), {
      offset: 0,
      limit: 10,
    });
    expect(graph.roots).toEqual(top);
    expect(graph.references).toEqual([]);
  }
});

it("retains own binary dictionary facts when a prototype key changes the decoder prototype", () => {
  const object = Object.fromEntries([
    ["__proto__", { inherited: "not an own fact" }],
    ["payload", "retained"],
  ]);
  const graph = decodeKeyedArchiveBytes(
    Buffer.from(
      buildBinary({
        $archiver: "NSKeyedArchiver",
        $version: 100000,
        $objects: ["$null", object],
        $top: { root: { UID: 1 } },
      }),
    ),
    { offset: 0, limit: 10 },
  );
  expect(graph.objects[1]).toMatchObject({
    kind: "dictionary",
    value: { payload: "retained" },
  });
  expect(graph.objects[1]?.value).toEqual({ payload: "retained" });
  expect(graph.limitations).toContainEqual(
    expect.stringContaining("__proto__"),
  );
});
