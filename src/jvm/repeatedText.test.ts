import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { inspectJvmMethodInputSchema } from "../domain/jvm/jvm.js";
import { removeTestWorkspace } from "../../tests/support/workspace/workspaceFixture.js";
import { JvmProvider } from "./JvmProvider.js";

const u2 = (value: number) => [value >> 8, value & 0xff];
const u4 = (value: number) => [...u2(value >>> 16), ...u2(value & 0xffff)];
const utf8 = (text: string) => [1, ...u2(text.length), ...Buffer.from(text)];

/**
 * A class whose `run` method loads one 65,535-character string 16,000 times:
 * 64 KB of text behind each of 16,000 four-byte instruction pairs.
 */
const hostileClass = (loads: number): Buffer => {
  const pool = [
    [7, ...u2(2)],
    utf8("Hostile"),
    [7, ...u2(4)],
    utf8("java/lang/Object"),
    utf8("run"),
    utf8("()V"),
    utf8("Code"),
    utf8("x".repeat(65_535)),
    [8, ...u2(8)],
  ];
  // ldc_w #9, pop, repeated; then return.
  const code = [
    ...Array.from({ length: loads }, () => [0x13, ...u2(9), 0x57]).flat(),
    0xb1,
  ];
  const codeAttribute = [
    ...u2(7),
    ...u4(12 + code.length),
    ...u2(1),
    ...u2(0),
    ...u4(code.length),
    ...code,
    ...u2(0),
    ...u2(0),
  ];
  return Buffer.from([
    ...[0xca, 0xfe, 0xba, 0xbe],
    ...u2(0),
    ...u2(65),
    ...u2(pool.length + 1),
    ...pool.flat(),
    ...u2(0x21),
    ...u2(1),
    ...u2(3),
    ...u2(0),
    ...u2(0),
    ...u2(1),
    ...u2(0x09),
    ...u2(5),
    ...u2(6),
    ...u2(1),
    ...codeAttribute,
    ...u2(0),
  ]);
};

let root: string | undefined;
afterAll(() => (root === undefined ? undefined : removeTestWorkspace(root)));

describe("repeated long constants in a method view", () => {
  it("shortens text once the method has repeated 4 MiB of it", async () => {
    root = await mkdtemp(join(tmpdir(), "oopsware-jvm-repeat-"));
    const path = join(root, "Hostile.class");
    await writeFile(path, hostileClass(16_000));
    const result = await new JvmProvider().inspectMethod(
      inspectJvmMethodInputSchema.parse({ path, method: "run", limit: 65_535 }),
    );
    if (!result.ok) throw result.error;
    const report = result.value;

    const operands = report.instructions.map((entry) => entry.operands);
    const total = (texts: readonly string[]) =>
      texts.reduce((sum, text) => sum + text.length, 0);
    expect(operands[0]?.length).toBeGreaterThan(65_000);
    expect(operands.at(-3)).toMatch(/characters\)$/u);
    expect(total(operands)).toBeLessThan(16 * 1024 ** 2);
    expect(
      total(report.references.constants.map((entry) => entry.value)),
    ).toBeLessThan(16 * 1024 ** 2);
    expect(report.limitations.join(" ")).toMatch(/shortened/u);
  });
});
