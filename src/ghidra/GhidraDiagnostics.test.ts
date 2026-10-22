import { ProcessOutputTokenScanner } from "../process/ProcessOutputTokenScanner.js";
import { ghidraFailureOutput } from "./GhidraDiagnostics.js";
import { expect, it } from "vitest";
import { createGhidraDiagnostics } from "./GhidraDiagnostics.js";

it("does not reuse historical operation-scoped failure output without a current owner", () => {
  const diagnostics = createGhidraDiagnostics({
    targetPath: "/tmp/target",
    targetSha256: "a".repeat(64),
    transport: "unix-socket",
    providerVersion: "11.4",
    profileDigest: "b".repeat(64),
    previous: {
      stdout: { text: "historical OOME" },
      failure_output: {
        stdout: { text: "historical OOME" },
        stderr: { text: "" },
        complete: true,
      },
    },
  });

  expect(diagnostics.stdout).toEqual({ text: "historical OOME" });
  expect(diagnostics).not.toHaveProperty("failure_output");
});

it.each([false, true])(
  "redacts credential tails only when the captured line's right edge is incomplete (open=%s)",
  (open) => {
    const scanner = new ProcessOutputTokenScanner("java.lang.OutOfMemoryError");
    const prefix = Buffer.from("prior operation prefix ");
    scanner.scan(prefix, 0);
    const suffix = Buffer.from(
      open
        ? "java.lang.OutOfMemoryError: e-trans"
        : "java.lang.OutOfMemoryError: Java heap space\n",
    );
    scanner.scan(suffix, prefix.length);
    const marker = scanner.latestWithin(
      prefix.length,
      prefix.length + suffix.length,
    );
    if (marker === undefined) throw new Error("Expected confirmed class token");
    const stream = { text: "", bytes: 0, observedBytes: suffix.length };
    const output = ghidraFailureOutput(
      {
        snapshot: {
          stdout: stream,
          stderr: stream,
          exitCode: null,
          signal: null,
        },
        complete: false,
        markers: [{ stream: "stderr", ...marker }],
      },
      "e-transport-secret",
      false,
    );
    expect(output).toMatchObject({
      observed_oome: [
        {
          line: open
            ? "java.lang.OutOfMemoryError: [REDACTED]"
            : "java.lang.OutOfMemoryError: Java heap space",
          line_complete: !open,
          truncated: true,
        },
      ],
    });
  },
);
