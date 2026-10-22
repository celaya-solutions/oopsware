import { Writable } from "node:stream";

import { Cli, Formatter } from "incur";
import { estimateTokenCount } from "tokenx";
import { expect, it } from "vitest";

import {
  createCliResultOutput,
  streamCliCommandResults,
} from "../../../src/cli/cliResultOutput.js";

const source = [{ selected: 1 }, { other: 2 }, { selected: null }];

it.each(
  (["json", "jsonl"] as const).flatMap((format) =>
    [false, true].map((full) => ({ format, full })),
  ),
)(
  "preserves filtered array positions in $format (full: $full)",
  async ({ format, full }) => {
    const value = Object.freeze(
      source.map((item) => Object.freeze({ ...item })),
    );
    const cli = Cli.create("filtered-array-test", { sync: false });
    cli.command("rows", { run: () => value });
    const args = [
      "rows",
      "--format",
      format,
      "--filter-output",
      "selected",
      ...(full ? ["--full-output"] : []),
    ];
    const chunks: Buffer[] = [];
    const output = createCliResultOutput(
      args,
      new Writable({
        write(chunk: Buffer, _encoding, callback) {
          chunks.push(chunk);
          callback();
        },
      }),
    );
    if (output === undefined) throw new Error("Missing CLI output owner");
    streamCliCommandResults(cli, output);
    let fallback = "";
    let status = 0;
    await cli.serve(args, {
      stdout: (text) => {
        if (!output.handled) fallback += text;
      },
      exit: (code) => {
        status = code;
      },
    });
    const text = Buffer.concat(chunks).toString("utf8");
    if (full)
      expect(JSON.parse(text)).toMatchObject({
        ok: true,
        data: [1, null, null],
        meta: { command: "rows" },
      });
    else if (format === "json")
      expect(JSON.parse(text)).toEqual([1, null, null]);
    else expect(text).toBe("1\nnull\nnull\n");
    expect(fallback).toBe("");
    expect(status).toBe(0);
    expect(output.handled).toBe(true);
    expect(output.failed).toBe(false);
    expect(value).toEqual(source);
  },
);

it.each(["json", "jsonl"] as const)(
  "counts the normalized filtered %s records",
  async (format) => {
    const cli = Cli.create("filtered-count-test", { sync: false });
    cli.command("rows", { run: () => source });
    const args = [
      "rows",
      "--format",
      format,
      "--filter-output",
      "selected",
      "--token-count",
    ];
    const chunks: Buffer[] = [];
    const output = createCliResultOutput(
      args,
      new Writable({
        write(chunk: Buffer, _encoding, callback) {
          chunks.push(chunk);
          callback();
        },
      }),
    );
    if (output === undefined) throw new Error("Missing CLI output owner");
    streamCliCommandResults(cli, output);
    let fallback = "";
    await cli.serve(args, {
      exit: (code) => {
        expect(code).toBe(0);
      },
      stdout: (text) => {
        if (!output.handled) fallback += text;
      },
    });
    expect(Buffer.concat(chunks).toString()).toBe(
      `${estimateTokenCount(Formatter.format([1, null, null], format))}\n`,
    );
    expect(fallback).toBe("");
  },
);

it.each(["selected", "toString", "constructor"])(
  "normalizes only owned nested selection arrays for %s",
  async (filter) => {
    const value = [[{ selected: false }, {}], [{ selected: 0 }], []];
    const before = structuredClone(value);
    const chunks: Buffer[] = [];
    const output = createCliResultOutput(
      ["--json", "--filter-output", filter],
      new Writable({
        write(chunk: Buffer, _encoding, callback) {
          chunks.push(chunk);
          callback();
        },
      }),
    );
    await output?.write(value, {
      command: "rows",
      duration: "0ms",
      format: "json",
    });
    expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual(
      filter === "selected"
        ? [[false, null], [0], []]
        : [[null, null], [null], []],
    );
    expect(value).toEqual(before);
  },
);

it("finishes JSONL after a bounded large record before a missing selection", async () => {
  const value = [{ selected: "x".repeat(80 * 1024) }, {}];
  const chunks: Buffer[] = [];
  const output = createCliResultOutput(
    ["--format", "jsonl", "--filter-output", "selected"],
    new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk);
        setImmediate(callback);
      },
    }),
  );
  if (output === undefined) throw new Error("Missing CLI output owner");
  await output.write(value, {
    command: "rows",
    duration: "0ms",
    format: "jsonl",
  });
  const lines = Buffer.concat(chunks).toString().trimEnd().split("\n");
  expect(lines.map((line) => JSON.parse(line))).toEqual([
    value[0]?.selected,
    null,
  ]);
  expect(output.failed).toBe(false);
});
