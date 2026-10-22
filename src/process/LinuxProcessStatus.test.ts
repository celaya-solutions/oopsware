import { expect, it } from "vitest";

import { parseLinuxProcessEffectiveUid } from "./LinuxProcessStatus.js";

it("parses the effective UID from the single native status Uid row", () => {
  expect(
    parseLinuxProcessEffectiveUid(
      "Name:\tworker\nUid:\t1000\t1001\t1002\t1003\nGid:\t20\t20\t20\t20\n",
    ),
  ).toBe(1001);
});

it.each([
  "Name:\tworker\n",
  "Uid:\t1000\t1001\t1002\n",
  "Uid:\t1000\t1001\t1002\t1003\nUid:\t1000\t1001\t1002\t1003\n",
  "Uid:\t1000\t-1\t1002\t1003\n",
  "Uid:\t1000\t9007199254740992\t1002\t1003\n",
])("does not infer an effective UID from malformed status: %s", (status) => {
  expect(parseLinuxProcessEffectiveUid(status)).toBeUndefined();
});
