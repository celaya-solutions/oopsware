import type { Obj } from "./types.js";

/** Narrow JSON objects without accepting arrays or null. */
export const object = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);
