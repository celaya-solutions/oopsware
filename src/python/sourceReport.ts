import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import type { PythonModuleReport } from "../domain/python/python.js";
import { runOwnedCommand } from "../process/OwnedCommand.js";
import type { Interpreter } from "./interpreters.js";
import { AST_FACTS_SCRIPT } from "./source/astScript.js";

type SourceFacts = NonNullable<PythonModuleReport["source"]>;

/** Largest JSON the parser process may print. */
const OUTPUT_BYTES = 256 * 1024 ** 2;

export class SourceParseFailure extends Error {
  readonly _tag = "SourceParseFailure";
}

const span = {
  line: z.number().int().nullable(),
  column: z.number().int().nullable(),
  end_line: z.number().int().nullable(),
  end_column: z.number().int().nullable(),
};
const text = z.string().nullable();

/** The parser script's output, checked (unknown keys dropped) before any of it is reported. */
const scriptOutputSchema = z.object({
  python: z.string(),
  encoding: z.string().nullable(),
  encoding_error: z.string().optional(),
  decode_error: z.string().optional(),
  syntax_error: z
    .object({ message: z.string(), ...span, text: z.string() })
    .optional(),
  parser_limit: z.string().optional(),
  walk_limit: z.string().optional(),
  docstring: text.optional(),
  nodes: z.number().int().optional(),
  all: z.array(z.string()).nullable().optional(),
  main_guards: z.array(z.object(span)).optional(),
  lists: z.object({
    imports: z
      .array(
        z.object({
          ...span,
          kind: z.enum(["import", "from"]),
          module: text,
          name: text,
          asname: text,
          level: z.number().int().min(0),
          scope: z.string(),
          lazy: z.boolean(),
          guarded: z.array(z.string()),
        }),
      )
      .optional(),
    definitions: z
      .array(
        z.object({
          ...span,
          kind: z.enum(["function", "async-function", "class"]),
          name: z.string(),
          qualname: z.string(),
          scope: z.string(),
          decorators: z.array(text),
          docstring: text,
          type_params: z.array(text),
          bases: z.array(text).optional(),
          keywords: z.array(text).optional(),
          arguments: text.optional(),
          returns: text.optional(),
        }),
      )
      .optional(),
    calls: z
      .array(z.object({ ...span, callee: z.string(), scope: z.string() }))
      .optional(),
    dynamic: z
      .array(
        z.object({
          ...span,
          kind: z.enum(["import", "exec", "eval", "compile", "reflection"]),
          callee: z.string(),
          scope: z.string(),
          literal: text,
          source: text,
        }),
      )
      .optional(),
    assignments: z.array(z.object({ ...span, name: z.string() })).optional(),
    globals: z
      .array(
        z.object({
          ...span,
          name: z.string(),
          scope: z.string(),
          kind: z.enum(["global", "nonlocal"]),
        }),
      )
      .optional(),
  }),
  totals: z.record(z.string(), z.number().int().min(0)),
});

/**
 * Parse one source file with the chosen interpreter's `ast` module in its own
 * process: isolated mode, no site packages, no bytecode written, an empty
 * environment and a scratch working directory holding only a copy of the bytes.
 */
export const sourceFacts = async (
  bytes: Uint8Array,
  interpreter: Interpreter,
  limits: { maxListed: number; timeoutMs: number },
  signal?: AbortSignal,
): Promise<SourceFacts> => {
  const scratch = await mkdtemp(join(tmpdir(), "oopsware-python-source-"));
  try {
    const file = join(scratch, "target.py");
    await writeFile(file, bytes, { flag: "wx" });
    const snapshot = await runOwnedCommand(
      {
        command: interpreter.path,
        arguments: [
          "-I",
          "-S",
          "-B",
          "-X",
          "utf8",
          "-c",
          AST_FACTS_SCRIPT,
          file,
          String(limits.maxListed),
        ],
        runId: randomUUID(),
        cwd: scratch,
        hostEnvironment: {},
        ...(signal === undefined ? {} : { signal }),
      },
      { timeoutMs: limits.timeoutMs, diagnosticBytes: OUTPUT_BYTES },
      signal === undefined ? {} : { signal },
    );
    let raw: unknown;
    try {
      raw = JSON.parse(snapshot.stdout.text);
    } catch {
      throw new SourceParseFailure(
        `The parser process printed no readable result${snapshot.stderr.text.trim() === "" ? "" : `: ${snapshot.stderr.text.trim().split("\n").slice(-2).join(" ")}`}`,
      );
    }
    const parsed = scriptOutputSchema.safeParse(raw);
    if (!parsed.success)
      throw new SourceParseFailure(
        "The parser process printed a result in an unexpected shape.",
      );
    const out = parsed.data;
    const lists = out.lists;
    const total = (key: string, items: readonly unknown[] | undefined) =>
      out.totals[key] ?? items?.length ?? 0;
    const status: SourceFacts["status"] =
      out.encoding_error !== undefined || out.decode_error !== undefined
        ? "undecodable"
        : out.syntax_error !== undefined
          ? "syntax-error"
          : out.parser_limit !== undefined
            ? "parser-limit"
            : "parsed";
    const problem =
      out.encoding_error ??
      out.decode_error ??
      (out.parser_limit === undefined
        ? out.walk_limit === undefined
          ? null
          : `The tree is nested too deeply to walk completely (${out.walk_limit}); the facts before that point are listed.`
        : `The parser stopped at its own limit (${out.parser_limit}).`);
    return {
      parser: { path: interpreter.path, release: out.python },
      encoding: out.encoding,
      bom: bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf,
      status,
      syntax_error: out.syntax_error ?? null,
      problem,
      docstring: out.docstring ?? null,
      node_count: out.nodes ?? null,
      imports: {
        total: total("imports", lists.imports),
        items: lists.imports ?? [],
      },
      definitions: {
        total: total("definitions", lists.definitions),
        items: (lists.definitions ?? []).map((item) => ({
          ...item,
          bases: item.bases ?? [],
          keywords: item.keywords ?? [],
          arguments: item.arguments ?? null,
          returns: item.returns ?? null,
        })),
      },
      calls: {
        total: total("calls", lists.calls),
        items: lists.calls ?? [],
      },
      unresolved_calls: out.totals.unresolved_calls ?? 0,
      dynamic: {
        total: total("dynamic", lists.dynamic),
        items: lists.dynamic ?? [],
      },
      assignments: {
        total: total("assignments", lists.assignments),
        items: lists.assignments ?? [],
      },
      scope_declarations: {
        total: total("globals", lists.globals),
        items: lists.globals ?? [],
      },
      lambdas: out.totals.lambdas ?? 0,
      all: out.all ?? null,
      main_guards: out.main_guards ?? [],
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
};
