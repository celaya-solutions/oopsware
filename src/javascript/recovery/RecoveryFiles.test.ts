import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";
import { OwnedFileHandle } from "../../filesystem/OwnedFileHandle.js";
import {
  openRegularFile,
  RegularFileAdmissionFailure,
} from "../../filesystem/RegularFile.js";
import { readWithoutFifoWriter } from "../../../tests/fixtures/fifoInput.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { readRecoveryFile } from "./RecoveryFiles.js";

vi.mock("../../filesystem/RegularFile.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../filesystem/RegularFile.js")>();
  return { ...actual, openRegularFile: vi.fn(actual.openRegularFile) };
});

it.skipIf(process.platform === "win32")(
  "rejects a named pipe without waiting for a writer",
  async () => {
    const root = await createTestTempDirectory("rea-recovery-fifo-");
    const regular = join(root, "regular.js");
    await writeFile(regular, "module.exports = 1;\n");
    await expect(readRecoveryFile(regular, 1024)).resolves.toHaveLength(20);

    const fifoPath = join(root, "sample.js");
    await promisify(execFile)("mkfifo", [fifoPath]);
    const outcome = await readWithoutFifoWriter(fifoPath, () =>
      readRecoveryFile(fifoPath, 1024).catch((cause: unknown) => cause),
    );
    if (outcome.state !== "completed")
      throw new Error("Recovery input read waited for a FIFO writer");
    expect(outcome.result).toBeInstanceOf(AnalysisOutputError);
  },
);

it("keeps a failed admission close owned when cancellation is also requested", async () => {
  const owner = new OwnedFileHandle({ fd: -1 } as never);
  const failure = new RegularFileAdmissionFailure(
    "/selected.js",
    new Error("cancelled during admission"),
    new Error("close failed"),
    owner,
  );
  vi.mocked(openRegularFile).mockRejectedValueOnce(failure);
  const controller = new AbortController();
  controller.abort();
  await expect(
    readRecoveryFile("/selected.js", 1024, controller.signal),
  ).rejects.toBe(failure);
});
