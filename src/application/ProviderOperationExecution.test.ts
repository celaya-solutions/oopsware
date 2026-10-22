import { expect, it, vi } from "vitest";
import { z } from "zod";

import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import { executeProviderOperation } from "./ProviderOperationExecution.js";

it("projects request-schema issues without exposing the request envelope", async () => {
  const execute = vi.fn();
  const result = await executeProviderOperation(
    "list_jeb_units",
    { parent_unit_path: "" },
    undefined,
    z.strictObject({
      operation: z.literal("list_jeb_units"),
      input: z.strictObject({ parent_unit_path: z.string().min(1) }),
    }),
    { execute },
    "observed",
  );

  expect(result.ok).toBe(false);
  if (result.ok || !(result.error instanceof AnalysisInputError))
    throw new Error("Expected input error");
  expect(result.error.issues).toEqual([
    {
      path: ["parent_unit_path"],
      reason: "out_of_range",
      minimum: 1,
    },
  ]);
  expect(result.error.cause).toBeInstanceOf(z.ZodError);
  expect(execute).not.toHaveBeenCalled();
});

it("removes only the owned envelope prefix while preserving nested caller paths", async () => {
  const execute = vi.fn();
  const result = await executeProviderOperation(
    "inspect",
    { input: "", rows: [{}], mode: "foreign", extra: "caller-only-marker" },
    undefined,
    z.strictObject({
      operation: z.literal("inspect"),
      input: z.strictObject({
        input: z.string().min(1),
        rows: z.array(z.strictObject({ name: z.string() })),
        mode: z.enum(["first", "second"]),
      }),
    }),
    { execute },
    "observed",
  );
  if (result.ok || !(result.error instanceof AnalysisInputError))
    throw new Error("Expected input error");
  expect(result.error.issues).toEqual([
    { path: ["input"], reason: "out_of_range", minimum: 1 },
    {
      path: ["rows", 0, "name"],
      reason: "missing_argument",
      expected: "string",
    },
    { path: ["mode"], reason: "invalid_value", expected: ["first", "second"] },
    { path: ["extra"], reason: "unknown_argument" },
  ]);
  expect(JSON.stringify(result.error.issues)).not.toContain(
    "caller-only-marker",
  );
  expect(execute).not.toHaveBeenCalled();
});

it("preserves operation correction outside the input envelope", async () => {
  const execute = vi.fn();
  const result = await executeProviderOperation(
    "unknown",
    {},
    undefined,
    z.strictObject({
      operation: z.literal("known"),
      input: z.strictObject({}),
    }),
    { execute },
    "observed",
  );
  if (result.ok || !(result.error instanceof AnalysisInputError))
    throw new Error("Expected input error");
  expect(result.error.issues).toEqual([
    { path: ["operation"], reason: "invalid_value", expected: ["known"] },
  ]);
  expect(execute).not.toHaveBeenCalled();
});
