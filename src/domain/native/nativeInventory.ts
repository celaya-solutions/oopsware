import { z } from "zod";
import { analysisStringSchema } from "../hopperValues.js";

/** Canonical named native observations; same-address alternatives stay separate. */
export const addressedValueSchema = z.object({
  address: z.string(),
  value: z.string(),
  symbol: z
    .object({
      primary: z.boolean(),
      dynamic: z.boolean(),
      external: z.boolean(),
      type: z.string(),
      source: z.enum(["default", "analysis", "ai", "imported", "user_defined"]),
    })
    .exactOptional(),
  objc_class_label: z.literal("hopper_legacy_class_object").exactOptional(),
  procedure: z
    .object({
      external: z.boolean(),
      thunk: z.boolean(),
      thunk_target: z.string().nullable(),
    })
    .exactOptional(),
  string: z
    .object({
      encoding: z.string(),
      termination: z.enum(["missing", "present_or_not_required"]),
      byte_length: z.number().int().min(0),
    })
    .exactOptional(),
});

/** Canonical row arrays shared by complete delivery and retained source validation. */
export const nativeInventoryRowsSchemas = {
  names: z.array(addressedValueSchema),
  strings: z.array(analysisStringSchema),
};

export const NATIVE_INVENTORY_OPERATIONS = [
  "list_procedures",
  "search_procedures",
  "list_strings",
  "search_strings",
  "list_names",
] as const;

export const nativeInventoryOperationSchema = z.enum(
  NATIVE_INVENTORY_OPERATIONS,
);
export type NativeInventoryOperation = z.infer<
  typeof nativeInventoryOperationSchema
>;

export const isNativeInventoryOperation = (
  operation: string,
): operation is NativeInventoryOperation =>
  NATIVE_INVENTORY_OPERATIONS.some((supported) => supported === operation);
