import { expect, it } from "vitest";

import { createReferenceSourcePathLookup } from "./referenceSourcePathIdentity.js";

it("reports ambiguous canonical identities while preserving exact paths", () => {
  const first = "package/a\u0301\u0323/package.json";
  const second = "package/a\u0323\u0301/package.json";
  const third = "package/\u1ea1\u0301/package.json";
  const lookup = createReferenceSourcePathLookup([first, second]);

  expect(lookup.has(third)).toBe(true);
  expect(lookup.resolve(third)).toBeUndefined();
  expect(lookup.resolve(first)).toBe(first);
  expect(lookup.resolve(second)).toBe(second);
});
