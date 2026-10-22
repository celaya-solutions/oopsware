import { z } from "zod";

export const OBJDUMP_ARTIFACT_OPERATIONS = [
  "file_headers",
  "section_headers",
  "symbols",
  "relocations",
  "dwarf",
  "disassemble",
  "disassemble_all",
] as const;

const objdumpArtifactInputSchema = z
  .object({
    path: z.string().min(1),
    operation: z.enum(OBJDUMP_ARTIFACT_OPERATIONS).exclude(["disassemble"]),
    follow_debug_links: z.boolean().default(false),
  })
  .strict();

const objdumpDisassemblyInputSchema = objdumpArtifactInputSchema.extend({
  operation: z.literal("disassemble"),
  symbol: z
    .string()
    .min(1)
    .regex(/^[^\x00]*$/u)
    // Keep UTF-16 checks out of patterns consumed by scalar Unicode engines.
    .refine(
      (symbol) => !/[\uD800-\uDFFF]/u.test(symbol),
      "Symbol must be well-formed Unicode.",
    )
    .describe(
      "Native symbol to disassemble, expressed as well-formed Unicode. Matching and symbol boundaries follow GNU objdump; omitted means all code sections.",
    )
    .optional(),
});

/** Caller-selected artifact facet or pathless provider capability query. */
export const objdumpInputSchema = z.discriminatedUnion("operation", [
  objdumpArtifactInputSchema,
  objdumpDisassemblyInputSchema,
  z.strictObject({ operation: z.literal("architectures") }),
]);

/** Caller-selected Rizin command against one local artifact. */
export const rizinInputSchema = z
  .object({
    path: z.string().min(1),
    command: z
      .string()
      .min(1)
      .refine(
        (value) => !/[\r\n\u0000]/u.test(value),
        "A single command line is required",
      ),
  })
  .strict();

export type ObjdumpInput = z.input<typeof objdumpInputSchema>;
export type RizinInput = z.input<typeof rizinInputSchema>;
