import { expect, it } from "vitest";

import {
  parseRecordedTransportUrl,
  parseUrlQueryParameterNames,
  iterateUrlQueryParameters,
  recordedPathSegments,
} from "./recordedTransportUrl.js";

it("recognizes an empty userinfo marker at the authority start", () => {
  expect(parseRecordedTransportUrl("https://@host")).toMatchObject({
    origin: "https://host",
    path: "/",
    credentials: { start: 8, end: 9 },
  });
});

it.each([
  ["https://host/api?", "?"],
  ["https://host?", "?"],
  ["https://host/api?#fragment", "?"],
  ["https://host/api#?", ""],
  ["https://host/api", ""],
  ["https://host/api?x=1", "?x=1"],
])("preserves the selected query delimiter in %s", (url, query) => {
  expect(parseRecordedTransportUrl(url, { includeQuery: true }).query).toBe(
    query,
  );
  expect(parseRecordedTransportUrl(url)).not.toHaveProperty("query");
});

it.each([
  "",
  "?",
  "?a=1&a=2&?a=3&&=x&x=1=2",
  "??=x&%3F=y&+=space&%00=nul",
  "?x=%FF&x=%E2%82&%ED%A0%80=%ZZ",
  "?x=\ud800&y=\udfff",
  "?🌟=😃&x=é",
  "flag&flag&last=2",
  "&=a&=&empty",
  "?x=1+2&%2B=%26%3D",
])("streams form fields with native meanings: %s", (query) => {
  const expected = new URLSearchParams(query);
  expect([...iterateUrlQueryParameters(query)]).toEqual([...expected]);
  expect([...parseUrlQueryParameterNames(query)]).toEqual([...expected.keys()]);
  const selected = new Map([
    ["x", ""],
    ["", ""],
  ]);
  expect([...iterateUrlQueryParameters(query, selected)]).toEqual(
    [...expected].filter(([name]) => selected.has(name)),
  );
});

it("reads only requested path coordinates, retaining empty and raw segments", () => {
  for (const path of ["", "/", "//a/", "/a/%2F/b", "relative/first/last"])
    for (const index of [-1, 0, 1, 2, 3, 8])
      expect(recordedPathSegments(path, [index]).get(index)).toBe(
        path.split("/").slice(1)[index],
      );
  expect(
    recordedPathSegments(`/${"literal/".repeat(20000)}wanted`, [20000]).get(
      20000,
    ),
  ).toBe("wanted");
});
