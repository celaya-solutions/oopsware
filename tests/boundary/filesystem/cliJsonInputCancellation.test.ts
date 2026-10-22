import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { parseCliJsonInput } from "../../../src/cliJsonInput.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("reports an already-cancelled inline JSON read as cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  expect(
    await parseCliJsonInput('{"value":1}', "test-input", controller.signal),
  ).toMatchObject({
    ok: false,
    error: { code: "cancelled", details: { operation: "test-input" } },
  });
});

it("cancels a pending regular-file JSON read through the owning reader", async () => {
  const root = await createTestTempDirectory("rea-json-input-cancel-");
  const path = join(root, "input.json");
  await writeFile(path, '{"value":1}');
  const controller = new AbortController();
  const result = parseCliJsonInput(path, "test-input", controller.signal);
  controller.abort();
  expect(await result).toMatchObject({
    ok: false,
    error: { code: "cancelled", details: { operation: "test-input" } },
  });
});

it("cancels cooperative sealing of an owned inline Evidence input", async () => {
  const controller = new AbortController();
  const input = JSON.stringify(
    Array.from({ length: 20000 }, () => ({ value: 1 })),
  );
  const pending = parseCliJsonInput(input, "test-input", controller.signal, {
    snapshot: true,
  });
  controller.abort();
  expect(await pending).toMatchObject({
    ok: false,
    error: { code: "cancelled" },
  });
});
