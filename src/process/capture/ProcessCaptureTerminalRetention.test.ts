import { expect, it } from "vitest";
import type { IPty } from "@lydell/node-pty";

import { parseProcessScenario } from "../../domain/process/processScenario.js";
import type { TerminalFrame } from "../../domain/process/processCapture.js";
import { captureTerminalFrames } from "./ProcessCaptureLifecycle.js";
import { createBoundedProcessTextNormalizer } from "./ProcessNormalization.js";

it("omits an expanding chunk whole and retains a later smaller normalized chunk", () => {
  let onData: ((data: string) => void) | undefined;
  const terminal = {
    onData: (listener: (data: string) => void) => {
      onData = listener;
      return { dispose: () => undefined };
    },
  } as unknown as IPty;
  const scenario = parseProcessScenario({
    executable: "unused",
    limits: { output_bytes: 1_000 },
    normalization: {
      paths: false,
      pids: false,
      ports: false,
      patterns: [{ pattern: "a", replacement: "x".repeat(500) }],
    },
  });
  const frames: TerminalFrame[] = [];
  const renderedChunks: string[] = [];
  const journal: Array<[string, number]> = [];
  const captureRetention = captureTerminalFrames({
    terminal,
    scenario,
    frames,
    started: 0,
    onOutput: () => undefined,
    renderer: { write: (data: string) => renderedChunks.push(data) } as never,
    normalizeText: createBoundedProcessTextNormalizer(scenario, "/tmp", -1),
    recordEvent: (collection, index) => journal.push([collection, index]),
  });

  onData?.("aaa");
  onData?.("z");

  expect(frames).toEqual([
    { sequence: 0, at_ms: expect.any(Number), data: "z" },
  ]);
  expect(renderedChunks).toEqual(["z"]);
  expect(journal).toEqual([["frames", 0]]);
  expect(captureRetention()).toEqual({
    raw_terminal: {
      budget_bytes: 1_000,
      observed_bytes: 4,
      retained_bytes: 1,
      observed_frames: 2,
      retained_frames: 1,
    },
    normalized_terminal: {
      budget_bytes: 1_000,
      retained_bytes: 1,
      omitted_frames: 1,
    },
  });
});
