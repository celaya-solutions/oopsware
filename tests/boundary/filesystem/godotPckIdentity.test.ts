import { writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { buildGodotPck, pckU64 } from "../../fixtures/godotPck.js";
import {
  scanArtifactInventory,
  materializeArtifactInventory,
} from "../../fixtures/artifactInventory.js";
import { parseBinaryTarget } from "../../../src/application/BinaryTargetResolver.js";
import { elf } from "../../../src/domain/binaryTarget.fixture.js";

it("binds extraction to the original carrier even if a changed directory names identical payloads", async () => {
  const root = await createTestTempDirectory("rea-pck-extraction-identity-");
  const source = join(root, "game.pck");
  const bytes = buildGodotPck(4, [{ path: "res://a.txt", data: "unchanged" }]);
  await writeFile(source, bytes);
  const snapshot = await scanArtifactInventory(source);
  // A version field changes the carrier identity without changing any member's
  // path, length or bytes. Per-member SHA-256 checks alone cannot detect this.
  bytes.writeUInt32LE(7, 12);
  await writeFile(source, bytes);
  const output = join(root, "out");
  await expect(
    materializeArtifactInventory(
      {
        inputPath: source,
        inputFormat: "godot-pck",
        outputRoot: output,
        environment: {},
        integrityPolicy: "fail",
      },
      source,
      snapshot,
    ),
  ).rejects.toMatchObject({ reason: "integrity" });
  await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
});

it("preserves native defaults and explicit native selection for embedded carriers", async () => {
  const root = await createTestTempDirectory("rea-pck-native-selection-");
  const source = join(root, "game.x86_64");
  const pack = buildGodotPck(4, [{ path: "res://a.txt", data: "a" }]);
  await writeFile(
    source,
    Buffer.concat([
      elf(2, 1, 62),
      pack,
      pckU64(pack.length),
      Buffer.from("GDPC"),
    ]),
  );
  expect(await parseBinaryTarget(source)).toMatchObject({
    ok: true,
    value: { kind: "executable", format: "elf" },
  });
  expect(
    await parseBinaryTarget(source, { targetKind: "executable" }),
  ).toMatchObject({
    ok: true,
    value: { kind: "executable", format: "elf", architecture: "x86_64" },
  });
});
