import { expect, it } from "vitest";

import { analyzeJavaScriptArtifactFiles } from "./JavaScriptArtifactAnalysis.js";

const packageObservation = (text: string) =>
  analyzeJavaScriptArtifactFiles({
    files: [
      {
        path: "app/package.json",
        container_sha256: "a".repeat(64),
        sha256: "b".repeat(64),
        bytes: Buffer.byteLength(text),
        inventory_artifact_id: "package-main-fixture",
        kind: "package-json",
        unpacked: false,
        text: { included: true, value: text },
      },
    ],
    unavailable_relevant_files: [],
    containers: [],
    text_bytes_read: Buffer.byteLength(text),
    invalid_utf8_files: 0,
  }).packages[0];

it.each([null, false, 123, {}, []].map((main) => ({ main })))(
  "retains non-string main $main evidence separately from Node index fallback",
  ({ main }) => {
    expect(packageObservation(JSON.stringify({ main }))).toMatchObject({
      status: "included",
      main: null,
      main_status: "invalid",
      main_entrypoint: "",
    });
  },
);

it.each([
  ["{}", "default", ""],
  ['{"main":""}', "default", ""],
  ['{"main":"main.cjs"}', "declared", "main.cjs"],
  ['{"main":"sub\\\\main.cjs"}', "declared", "sub\\main.cjs"],
  ['{"main":"C:main.cjs"}', "declared", "C:main.cjs"],
] as const)(
  "preserves package launch declarations from %s",
  (text, status, entry) => {
    expect(packageObservation(text)).toMatchObject({
      status: "included",
      main_status: status,
      main_entrypoint: entry,
    });
  },
);

it.each(["{", "null", "[]", "[{}]", "123", '"root"', "false"])(
  "keeps malformed package metadata %s out of known launch fallback",
  (text) => {
    expect(packageObservation(text)).toMatchObject({
      status: "invalid",
      main: null,
      main_status: "unavailable",
      main_entrypoint: null,
    });
  },
);
