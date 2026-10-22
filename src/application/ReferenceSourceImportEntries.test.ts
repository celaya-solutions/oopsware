import { createHash } from "node:crypto";

import { expect, it } from "vitest";

import { parseReferenceSourceEntries } from "./ReferenceSourceImportEntries.js";
import { historicalSourceLanguages } from "../domain/referenceSourceGraph.js";
import type { ReferenceSourceRead } from "../reference/ReferenceSourceReaderTypes.js";

it("projects an unsupported non-regular entry as unknown kind instead of file", () => {
  const read: ReferenceSourceRead = {
    root: "/selected/source",
    entries: [
      {
        status: "failed",
        kind: "other",
        path: "src/pipe",
        code: "unsupported",
        message: "Entry is not a regular file",
        size: 0,
      },
    ],
    bytesRead: 0,
    limitations: [],
  };
  const parsed = parseReferenceSourceEntries(read, new Set());
  expect(parsed.entries).toContainEqual({
    path: "src/pipe",
    kind: "unknown",
    classifications: ["unknown"],
    limitations: [
      "Entry is not a regular file Exclude this entry or replace it with a regular file.",
    ],
  });
  expect(parsed.entries.some((entry) => entry.kind === "file")).toBe(false);
});

it("keeps a failed regular file as file kind", () => {
  const read: ReferenceSourceRead = {
    root: "/selected/source",
    entries: [
      {
        status: "failed",
        kind: "file",
        path: "src/broken.ts",
        code: "io",
        message: "Entry could not be read",
      },
    ],
    bytesRead: 0,
    limitations: [],
  };
  const parsed = parseReferenceSourceEntries(read, new Set());
  expect(parsed.entries).toContainEqual({
    path: "src/broken.ts",
    kind: "file",
    sha256: null,
    size: null,
    language: null,
    classifications: ["source"],
    content_state: "unreadable",
    limitations: [
      "Entry could not be read This file could not be read. Check its permissions, then try again.",
    ],
  });
});

it("retains Kotlin source identity and language across the inventory projection", () => {
  const files = [
    [
      "MainActivity.kt",
      "import android.app.Activity\nclass MainActivity : Activity()\n",
      ["source"],
      "Kotlin",
    ],
    ["task.kts", 'println("hello")\n', ["source"], "Kotlin"],
    [
      "build.gradle.kts",
      'plugins { kotlin("jvm") version "2.3.0" }\n',
      ["manifest", "source"],
      "Kotlin",
    ],
    ["MainActivity.kt.backup", "backup\n", ["unknown"], null],
    ["Legacy.java", "class Legacy {}\n", ["source"], "Java"],
  ] as const;
  const read: ReferenceSourceRead = {
    root: "/selected/source",
    entries: files.map(([path, content]) => ({
      status: "read",
      kind: "file",
      path,
      bytes: Buffer.from(content),
      size: Buffer.byteLength(content),
    })),
    bytesRead: files.reduce(
      (sum, [, content]) => sum + Buffer.byteLength(content),
      0,
    ),
    limitations: [],
  };
  const parsed = parseReferenceSourceEntries(
    read,
    new Set(files.map(([path]) => path)),
  );
  for (const [path, content, classifications, language] of files)
    expect(parsed.entries).toContainEqual({
      path,
      kind: "file",
      language,
      classifications,
      size: Buffer.byteLength(content),
      sha256: createHash("sha256").update(content).digest("hex"),
      content_state: "hashed",
      limitations: [],
    });
  expect(historicalSourceLanguages(parsed.entries)).toEqual(["Java", "Kotlin"]);
  expect(parsed.parseFailures).toEqual([]);
  expect(parsed.relationships).toEqual([]);
});

it("resolves runtime require package mains without an index and before typed indexes", () => {
  const files = [
    ["main.cjs", 'require("./pkg");\nrequire("./dep");\n'],
    [
      "main.ts",
      'import dep = require("./typed");\n' +
        'require("./typed");\n' +
        'import data = require("./json-package");\n' +
        'require("./emitted.js");\n',
    ],
    ["pkg/package.json", '{"main":"actual.js"}\n'],
    ["pkg/actual.js", 'module.exports = "package main";\n'],
    ["dep.js", 'module.exports = "file";\n'],
    ["dep/index.ts", 'export const value = "index";\n'],
    ["typed.js", 'module.exports = "runtime file";\n'],
    ["typed/index.ts", 'export const value = "source index";\n'],
    ["json-package/package.json", '{"main":"data"}\n'],
    ["json-package/data.json", '{"value":"package main"}\n'],
    ["json-package/index.js", 'module.exports = "fallback index";\n'],
    ["emitted.ts", 'export const value = "source counterpart";\n'],
  ] as const;
  const read: ReferenceSourceRead = {
    root: "/selected/source",
    entries: files.map(([path, content]) => ({
      status: "read",
      kind: "file",
      path,
      bytes: Buffer.from(content),
      size: Buffer.byteLength(content),
    })),
    bytesRead: files.reduce(
      (sum, [, content]) => sum + Buffer.byteLength(content),
      0,
    ),
    limitations: [],
  };

  const parsed = parseReferenceSourceEntries(
    read,
    new Set(files.map(([path]) => path)),
  );

  expect(parsed.relationships).toContainEqual({
    from_path: "main.cjs",
    to: "pkg/actual.js",
    kind: "requires",
    resolution: "internal",
    parse_state: "parsed",
  });
  expect(parsed.relationships).toContainEqual({
    from_path: "main.cjs",
    to: "dep.js",
    kind: "requires",
    resolution: "internal",
    parse_state: "parsed",
  });
  expect(parsed.relationships).toContainEqual({
    from_path: "main.ts",
    to: "typed/index.ts",
    kind: "requires",
    resolution: "internal",
    parse_state: "parsed",
  });
  expect(parsed.relationships).toContainEqual({
    from_path: "main.ts",
    to: "typed.js",
    kind: "requires",
    resolution: "internal",
    parse_state: "parsed",
  });
  expect(parsed.relationships).toContainEqual({
    from_path: "main.ts",
    to: "json-package/data.json",
    kind: "requires",
    resolution: "internal",
    parse_state: "parsed",
  });
  expect(parsed.relationships).toContainEqual({
    from_path: "main.ts",
    to: "emitted.ts",
    kind: "requires",
    resolution: "internal",
    parse_state: "parsed",
  });
});

it("matches package manifests by exact or unique canonical directory identity", () => {
  const composed = "caf\u00e9";
  const decomposed = "cafe\u0301";
  const composedTwin = "r\u00e9sum\u00e9";
  const decomposedTwin = "re\u0301sume\u0301";
  const files = [
    [
      "main.cjs",
      [composed, composedTwin, decomposedTwin]
        .map((name) => `require(${JSON.stringify(`./${name}`)});`)
        .join("\n"),
    ],
    [`${decomposed}/package.json`, '{"main":"unique.js"}\n'],
    [`${decomposed}/unique.js`, 'module.exports = "unique";\n'],
    [`${composed}/unique.js`, 'module.exports = "unrelated exact spelling";\n'],
    [`${composedTwin}/package.json`, '{"main":"exact-composed.js"}\n'],
    [`${composedTwin}/exact-composed.js`, 'module.exports = "composed";\n'],
    [`${decomposedTwin}/package.json`, '{"main":"exact-decomposed.js"}\n'],
    [
      `${decomposedTwin}/exact-decomposed.js`,
      'module.exports = "decomposed";\n',
    ],
  ] as const;
  const read: ReferenceSourceRead = {
    root: "/selected/source",
    entries: files.map(([path, content]) => ({
      status: "read",
      kind: "file",
      path,
      bytes: Buffer.from(content),
      size: Buffer.byteLength(content),
    })),
    bytesRead: files.reduce(
      (sum, [, content]) => sum + Buffer.byteLength(content),
      0,
    ),
    limitations: [],
  };

  const parsed = parseReferenceSourceEntries(
    read,
    new Set(files.map(([path]) => path)),
  );

  expect(parsed.relationships.map(({ to }) => to)).toEqual([
    `${decomposed}/unique.js`,
    `${composedTwin}/exact-composed.js`,
    `${decomposedTwin}/exact-decomposed.js`,
  ]);
});

it("resolves extensionless imports and requires to .mts and .cts files and directory indexes", () => {
  const files = [
    [
      "src/index.ts",
      'import "./esm";\nimport "./pkg-esm";\nimport cjs = require("./cjs");\nimport pkgCjs = require("./pkg-cjs");\n',
    ],
    ["src/esm.mts", "export const esm = 1;\n"],
    ["src/pkg-esm/index.mts", "export const pkgEsm = 2;\n"],
    ["src/cjs.cts", "module.exports = { cjs: 3 };\n"],
    ["src/pkg-cjs/index.cts", "module.exports = { pkgCjs: 4 };\n"],
  ] as const;
  const read: ReferenceSourceRead = {
    root: "/selected/source",
    entries: files.map(([path, content]) => ({
      status: "read",
      kind: "file",
      path,
      bytes: Buffer.from(content),
      size: Buffer.byteLength(content),
    })),
    bytesRead: files.reduce(
      (sum, [, content]) => sum + Buffer.byteLength(content),
      0,
    ),
    limitations: [],
  };
  const parsed = parseReferenceSourceEntries(
    read,
    new Set(files.map(([path]) => path)),
  );
  expect(parsed.relationships).toEqual(
    expect.arrayContaining([
      {
        from_path: "src/index.ts",
        to: "src/esm.mts",
        kind: "imports",
        resolution: "internal",
        parse_state: "parsed",
      },
      {
        from_path: "src/index.ts",
        to: "src/pkg-esm/index.mts",
        kind: "imports",
        resolution: "internal",
        parse_state: "parsed",
      },
      {
        from_path: "src/index.ts",
        to: "src/cjs.cts",
        kind: "requires",
        resolution: "internal",
        parse_state: "parsed",
      },
      {
        from_path: "src/index.ts",
        to: "src/pkg-cjs/index.cts",
        kind: "requires",
        resolution: "internal",
        parse_state: "parsed",
      },
    ]),
  );
});
