import { isAbsolute } from "node:path";

import { expect, it } from "vitest";

import { absoluteLocalPathStringSchema } from "./localPath.js";

it("matches the host path module for absolute local paths", () => {
  for (const path of [
    "/absolute/path",
    "/",
    "relative/path",
    "C:\\absolute\\path",
    "c:/absolute/path",
    "C:relative/path",
    "\\\\server\\share\\path",
    "\\rooted\\path",
    "//server/share/path",
    "file:///absolute/path",
  ]) {
    expect(absoluteLocalPathStringSchema.safeParse(path).success).toBe(
      isAbsolute(path),
    );
  }
  expect(absoluteLocalPathStringSchema.safeParse("").success).toBe(false);
  expect(
    absoluteLocalPathStringSchema.safeParse("/absolute/with\0nul").success,
  ).toBe(false);
});
