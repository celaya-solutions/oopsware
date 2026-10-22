import { spawn, type ChildProcess } from "node:child_process";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Writable } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  runUpdateCommand,
  UPDATE_COMMAND_OUTPUT_BYTES,
} from "../../src/application/UpdateRuntime.js";

const execution = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("cross-spawn", () => ({ default: execution.spawn }));
let child: ChildProcess | undefined;
beforeEach(() => {
  execution.spawn.mockReset();
  execution.spawn.mockImplementation(
    (
      executable: string,
      args: readonly string[],
      options: Parameters<typeof spawn>[2],
    ) => {
      if (executable !== process.execPath)
        throw new Error("Only owned Node fixtures may execute");
      child = spawn(executable, [...args], options);
      return child;
    },
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (
    child !== undefined &&
    child.exitCode === null &&
    child.signalCode === null
  ) {
    const closed = new Promise<void>((resolve) => {
      child!.once("close", resolve);
    });
    child.kill("SIGKILL");
    await closed;
  }
  child = undefined;
});
const command = (script: string) => [process.execPath, "-e", script];

it.each(["stdout", "stderr"])(
  "rejects incomplete %s metadata after draining the command",
  async (stream) => {
    const result = await runUpdateCommand(
      command(
        `process.stdout.write('"6.5.0"');process.${stream}.write(' '.repeat(${UPDATE_COMMAND_OUTPUT_BYTES}))`,
      ),
      process.env,
    );
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("complete-output retention budget"),
    });
    expect(child?.exitCode).toBe(0);
  },
);

it("accepts exactly the combined byte budget and preserves split UTF-8", async () => {
  const result = await runUpdateCommand(
    command(
      `process.stdout.write('x'.repeat(${UPDATE_COMMAND_OUTPUT_BYTES - 3}));const b=Buffer.from('界');process.stdout.write(b.subarray(0,1));setTimeout(()=>process.stdout.write(b.subarray(1)),10)`,
    ),
    process.env,
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(Buffer.byteLength(result.value)).toBe(UPDATE_COMMAND_OUTPUT_BYTES);
    expect(result.value.endsWith("界")).toBe(true);
  }
});

it("refuses malformed UTF-8 instead of interpreting replacement text", async () => {
  expect(
    await runUpdateCommand(
      command("process.stdout.write(Buffer.from([255]))"),
      process.env,
    ),
  ).toMatchObject({
    ok: false,
    error: expect.stringContaining("invalid UTF-8"),
  });
});

it("waits for physical close after an early process error", async () => {
  let settled = false;
  const pending = runUpdateCommand(
    command("setTimeout(()=>process.stdout.write('late output'),50)"),
    process.env,
  ).then((result) => {
    settled = true;
    return result;
  });
  child!.emit("error", new Error("controlled process error"));
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(await pending).toEqual({
    ok: false,
    error: "controlled process error",
  });
  expect(child?.exitCode).toBe(0);
});

it("joins the final human progress write before reporting success", async () => {
  let acknowledge!: (cause?: Error | null) => void;
  let started!: () => void;
  const writing = new Promise<void>((resolve) => {
    started = resolve;
  });
  const destination = new Writable({
    write(_chunk, _encoding, callback) {
      acknowledge = callback;
      started();
    },
  });
  vi.spyOn(process, "stderr", "get").mockReturnValue(
    destination as typeof process.stderr,
  );
  let settled = false;
  const pending = runUpdateCommand(
    command("process.stdout.write('final progress')"),
    process.env,
    "human",
  ).then((result) => {
    settled = true;
    return result;
  });
  const closed = new Promise<void>((resolve) => {
    child!.once("close", resolve);
  });
  await writing;
  await closed;
  expect(settled).toBe(false);
  acknowledge(new Error("final progress refused"));
  expect(await pending).toMatchObject({
    ok: false,
    error: expect.stringContaining("final progress refused"),
  });
  expect(destination.writableEnded).toBe(false);
  await nextTurn();
  expect(destination.listenerCount("error")).toBe(0);
});
