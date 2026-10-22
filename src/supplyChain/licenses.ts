import type { LicenseFinding } from "../domain/supplyChain/sbom.js";

/** Names select documents to inspect; they never establish the license. */
export const isLicenseFile = (path: string): boolean =>
  /^(?:licen[cs]e|copying|copyright|notice|unlicense)(?:[._-].*)?$/iu.test(
    path.split("/").at(-1) ?? "",
  );

/** Distinctive text clauses are clues, not legal conclusions or exact-text verification. */
export const inspectLicenseText = (
  source: string,
  sha256: string,
  bytes: Uint8Array,
): LicenseFinding => {
  const text = new TextDecoder()
    .decode(bytes)
    .replace(/\s+/gu, " ")
    .toLowerCase();
  const matches: [string, readonly string[]][] = [
    [
      "MIT",
      [
        "permission is hereby granted, free of charge",
        "the above copyright notice and this permission notice",
        'the software is provided "as is"',
      ],
    ],
    [
      "Apache-2.0",
      [
        "apache license",
        "version 2.0, january 2004",
        "grant of patent license",
      ],
    ],
    [
      "BSD-3-Clause",
      [
        "redistribution and use in source and binary forms",
        "neither the name",
        "this software is provided",
      ],
    ],
    [
      "ISC",
      [
        "permission to use, copy, modify, and/or distribute this software",
        'the software is provided "as is"',
      ],
    ],
    ["MPL-2.0", ["mozilla public license version 2.0", "covered software"]],
    [
      "Unlicense",
      [
        "this is free and unencumbered software released into the public domain",
        "anyone is free to copy, modify, publish",
      ],
    ],
  ];
  const matched = matches
    .filter(([, clauses]) => clauses.every((clause) => text.includes(clause)))
    .map(([id]) => id);
  return {
    source,
    sha256,
    component_ref: null,
    evidence_kind: matched.length === 1 ? "inferred" : "unknown",
    value:
      matched.length === 1
        ? "Characteristic license text matched; modifications and exceptions were not evaluated."
        : "Unknown, custom, or ambiguous license text; source retained by path and SHA-256.",
    matched_license: matched.length === 1 ? (matched[0] ?? null) : null,
  };
};
