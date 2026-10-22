import { deflateSync } from "node:zlib";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../src/contracts/toolContracts.js";
import { machoImageWithUnknownCommand } from "../../src/artifacts/apple/MachoImage.fixture.js";
import {
  createRustImage,
  rustDependencyPayload,
} from "../fixtures/rust/image.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";
import { connectLocalToolsMcp } from "../fixtures/localToolsMcp.js";
import { parseMcpToolError } from "../fixtures/mcpToolError.js";

cliTest(
  "rejects misaligned 64-bit Mach-O through Rust CLI and stdio MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-rust-macho-alignment-");
    const { client, call } = await connectLocalToolsMcp();
    const expectedFailure = {
      code: "invalid_request",
      details: {
        operation: "inspect_rust_binary",
        issues: [{ path: ["path"], reason: "invalid_format" }],
      },
    };

    for (const fixture of [
      { wide: true, size: 12, bits: 64, malformed: true },
      { wide: true, size: 16, bits: 64, malformed: false },
      { wide: false, size: 12, bits: 32, malformed: false },
    ]) {
      const path = join(root, `image-${fixture.bits}-${fixture.size}.macho`);
      await writeFile(
        path,
        machoImageWithUnknownCommand(fixture.wide, fixture.size),
      );
      const result = await cli.run({
        arguments: ["inspect-rust-binary", path, "--json"],
      });
      const response = await call("inspect_rust_binary", { path });

      if (fixture.malformed) {
        expect(result.exitCode).toBe(1);
        expect(result.json).toMatchObject(expectedFailure);
        expect(result.json).not.toHaveProperty("normalized_result");
        expect(parseMcpToolError(response).error).toMatchObject(
          expectedFailure,
        );
        expect(response.structuredContent).toBeUndefined();
        continue;
      }

      expect(result.exitCode, result.stderr).toBe(0);
      const evidence = toolContract("inspect_rust_binary").outputSchema.parse(
        result.json,
      );
      expect(evidence.normalized_result).toMatchObject({
        format: "macho",
        bits: fixture.bits,
        auditable_metadata: null,
      });
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      expect(response.structuredContent).toEqual(evidence);
    }
    await client.ping();
  },
  30000,
);

cliTest(
  "reports cargo-auditable packages through the public CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-rust-cli-");
    const path = join(root, "sample");
    await writeFile(path, createRustImage({ format: "macho" }));
    const result = await cli.run({
      arguments: ["inspect-rust-binary", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = toolContract("inspect_rust_binary").outputSchema.parse(
      result.json,
    );
    expect(evidence.normalized_result.auditable_metadata).toMatchObject({
      section_name: "__DATA,.dep-v0",
      format_version: 1,
      root_package_index: 1,
      packages: [
        { name: "itoa", version: "1.0.18" },
        { name: "sample", version: "0.1.0", root: true },
      ],
    });
  },
);

cliTest("returns null metadata when .dep-v0 is absent", async ({ cli }) => {
  const root = await createTestTempDirectory("rea-rust-cli-missing-");
  const path = join(root, "plain");
  await writeFile(path, createRustImage({ format: "elf", omitSection: true }));
  const result = await cli.run({
    arguments: ["inspect-rust-binary", path, "--json"],
  });
  expect(result.exitCode, result.stderr).toBe(0);
  const evidence = toolContract("inspect_rust_binary").outputSchema.parse(
    result.json,
  );
  expect(evidence.normalized_result.auditable_metadata).toBeNull();
  expect(evidence.normalized_result.limitations.join("\n")).toContain(
    "does not mean the binary has no dependencies",
  );
});

cliTest(
  "preserves an unknown cargo-auditable revision and reports its fallback",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-rust-cli-unknown-format-");
    const path = join(root, "sample");
    const payload = rustDependencyPayload({
      format: 4,
      packages: [
        { name: "sample", version: "0.1.0", source: "local", root: true },
      ],
    });
    await writeFile(path, createRustImage({ format: "elf", payload }));
    const result = await cli.run({
      arguments: ["inspect-rust-binary", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = toolContract("inspect_rust_binary").outputSchema.parse(
      result.json,
    );
    expect(evidence.normalized_result.auditable_metadata?.format_version).toBe(
      4,
    );
    expect(evidence.normalized_result.limitations.join("\n")).toContain(
      "highest known preceding revision (1)",
    );
    expect(evidence.normalized_result.limitations.join("\n")).toContain(
      "this specific revision has not been independently verified",
    );
  },
);

cliTest("reports malformed zlib as invalid input", async ({ cli }) => {
  const root = await createTestTempDirectory("rea-rust-cli-zlib-");
  const path = join(root, "broken.elf");
  await writeFile(
    path,
    createRustImage({
      format: "elf",
      payload: deflateSync(Buffer.from("{")),
      includeRustc: false,
    }),
  );
  const result = await cli.run({
    arguments: ["inspect-rust-binary", path, "--json"],
  });
  expect(result.exitCode).toBe(1);
  expect(result.json).toMatchObject({
    code: "invalid_request",
    details: { operation: "inspect_rust_binary" },
  });
});

cliTest(
  "releases a failed Rust descriptor close before projecting the CLI failure",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-rust-cli-close-");
    const path = join(root, "sample.elf");
    const marker = join(root, "close-events.json");
    const preload = join(root, "deny-first-close.mjs");
    const bytes = createRustImage({ format: "elf" });
    await writeFile(path, bytes);
    await writeFile(
      preload,
      `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const open = fs.promises.open;
    const events = [];
    let denied = false;
    let opened = 0;
    fs.promises.open = async (...args) => {
      const file = await open(...args);
      if (String(args[0]) !== process.env.REA_TEST_SELECTED_FILE) return file;
      const handleId = opened++;
      events.push({ stage: 'opened', handleId });
      const close = file.close.bind(file);
      let releaseObserved = false;
      file.close = async () => {
        if (!denied) {
          denied = true;
          events.push({ stage: 'denied', handleId, open: file.fd >= 0 });
          fs.writeFileSync(process.env.REA_TEST_CLOSE_EVENTS, JSON.stringify(events));
          throw new Error('controlled Rust descriptor close failure');
        }
        await close();
        // Node can re-enter close while notifying its attached read stream.
        // Record the descriptor's completed transition once per exact handle.
        if (!releaseObserved) {
          releaseObserved = true;
          events.push({ stage: 'released', handleId, fd: file.fd });
          fs.writeFileSync(process.env.REA_TEST_CLOSE_EVENTS, JSON.stringify(events));
        }
      };
      return file;
    };
    syncBuiltinESMExports();
  `,
    );
    const result = await cli.run({
      arguments: ["inspect-rust-binary", path, "--json"],
      environment: {
        NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
        REA_TEST_SELECTED_FILE: path,
        REA_TEST_CLOSE_EVENTS: marker,
      },
    });
    expect(result.exitCode, result.stdout + result.stderr).toBe(1);
    expect(result.json).toHaveProperty("code");
    expect(result.json).not.toMatchObject({ code: "cleanup_incomplete" });
    expect(JSON.parse(await readFile(marker, "utf8"))).toEqual([
      { stage: "opened", handleId: 0 },
      { stage: "denied", handleId: 0, open: true },
      { stage: "released", handleId: 0, fd: -1 },
    ]);
    expect(await readFile(path)).toEqual(bytes);
  },
);
