import { expect, it } from "vitest";
import { parseOtoolLoadCommands } from "../../../../src/native/parsers/otool.js";
import {
  nativeFixture,
  withOtoolMachHeader,
} from "../../../fixtures/nativeCommands.js";
it.each([
  ["decimal-space", "123 library.dylib"],
  ["hex-space", "0x123 library.dylib"],
  ["decimal", "123"],
  ["hex", "0x123"],
  ["ordinary", "ordinary.dylib"],
])("preserves native install-name text from %s capture", async (slug, name) => {
  const load = parseOtoolLoadCommands(
    withOtoolMachHeader(
      await nativeFixture(`load-command-text-values/${slug}.txt`),
    ),
  );
  // The image's own install name is identity, not a dependency.
  expect(load.dependencies.map(({ kind }) => kind)).not.toContain(
    "LC_ID_DYLIB",
  );
  expect(
    load.commands.find((command) => command.kind === "LC_ID_DYLIB")?.fields
      .name,
  ).toBe(`${name} (offset 24)`);
  const text = load.segments.find((segment) => segment.name === "__TEXT");
  expect(text).toMatchObject({
    file_offset: 0,
    file_size: 16384,
    initial_permissions: { read: true, write: false, execute: true },
  });
  expect(
    load.commands.find((command) => command.kind === "LC_SEGMENT_64")?.fields
      .cmdsize,
  ).toBe(232);
});
