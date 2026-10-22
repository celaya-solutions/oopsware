import { expect, it } from "vitest";
import { closeVerifierResources } from "../../../scripts/lib/verifier-cleanup.mjs";

it("attempts every cleanup and reports failures when there is no primary error", async () => {
  const attempted: string[] = [];
  const tasks = [
    async () => {
      attempted.push("provider");
      throw new Error("provider close failed");
    },
    async () => {
      attempted.push("fixture");
    },
  ];

  let failure: unknown;
  try {
    await closeVerifierResources(tasks);
  } catch (cause) {
    failure = cause;
  }
  expect(failure).toBeInstanceOf(AggregateError);
  expect(
    (failure as AggregateError).errors.map((error) => error.message),
  ).toEqual(["provider close failed"]);
  expect(attempted).toEqual(["provider", "fixture"]);
});

it("retains primary verification and independent cleanup failures", async () => {
  const primary = new Error("analysis assertion failed");
  const attempted: string[] = [];
  const tasks = [
    async () => {
      attempted.push("provider");
      throw new Error("provider close failed");
    },
    async () => {
      attempted.push("fixture");
      throw new Error("fixture removal failed");
    },
  ];

  let failure: unknown;
  try {
    await closeVerifierResources(tasks, primary);
  } catch (cause) {
    failure = cause;
  }
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors).toEqual([
    primary,
    expect.objectContaining({ message: "provider close failed" }),
    expect.objectContaining({ message: "fixture removal failed" }),
  ]);
  expect(attempted).toEqual(["provider", "fixture"]);
});

it("keeps a parent fixture when any owned child cleanup remains incomplete", async () => {
  const primary = new Error("verification failed");
  const attempted: string[] = [];
  let parentRemoved = false;
  let failure: unknown;
  try {
    await closeVerifierResources(
      [
        async () => {
          await closeVerifierResources([
            async () => {
              attempted.push("client");
            },
            async () => {
              attempted.push("transport");
              throw new Error("transport close failed");
            },
            async () => {
              attempted.push("file-scope");
            },
          ]);
          parentRemoved = true;
        },
      ],
      primary,
    );
  } catch (cause) {
    failure = cause;
  }

  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors[0]).toBe(primary);
  expect((failure as AggregateError).errors[1]).toBeInstanceOf(AggregateError);
  expect(attempted).toEqual(["client", "transport", "file-scope"]);
  expect(parentRemoved).toBe(false);
});
