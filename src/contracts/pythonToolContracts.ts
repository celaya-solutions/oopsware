import {
  decompilePythonCodeInputSchema,
  inspectPythonArtifactInputSchema,
  inspectPythonCodeInputSchema,
  inspectPythonModuleInputSchema,
  pythonArtifactReportSchema,
  pythonCodeReportSchema,
  pythonDecompilationSchema,
  pythonModuleReportSchema,
} from "../domain/python/python.js";
import type { ToolContract } from "./toolContractTypes.js";
import { toolContractMetadata } from "./toolEffects.js";
import { evidenceResultOf } from "./toolOutputSchemaPrimitives.js";

/** Python source, CPython bytecode, wheels and zip applications (format expansion F03), independent of binary targets. */
export const PYTHON_TOOL_CONTRACTS = [
  {
    name: "inspect_python_artifact",
    ...toolContractMetadata("inspect_python_artifact"),
    kind: "artifact-provider",
    description:
      "Read one explicit local Python artifact from its bytes: a .py source file, a .pyc, a wheel (.whl), a zip application (.pyz) or a ZIP of modules. Nothing is imported, installed, compiled or run. Returns what the container is (and any name/byte disagreement); for a .pyc its magic number, release, invalidation mode (timestamp or checked/unchecked source hash) and whether this reader decodes it; for a wheel the file-name tags, METADATA (name, version, Requires-Python, Requires-Dist, licenses, classifiers), WHEEL tags, entry points as declarations, RECORD digests recomputed with each row's own algorithm (mismatches, unlisted and absent members), license files, native extensions with their binary format and ABI tag, and .data schemes; for a zip application its shebang and the __main__.py it would run. Then a page of modules, each with member path, dotted module name, digest and, for bytecode, magic number and release.",
    inputSchema: inspectPythonArtifactInputSchema,
    outputSchema: evidenceResultOf(pythonArtifactReportSchema),
    examples: [
      {
        title: "Inventory a wheel",
        input: { path: "/artifacts/example-1.0-py3-none-any.whl" },
      },
      { title: "Identify a .pyc", input: { path: "/artifacts/module.pyc" } },
    ],
  },
  {
    name: "inspect_python_module",
    ...toolContractMetadata("inspect_python_module"),
    kind: "artifact-provider",
    description:
      'Read one Python module from an explicit local file or archive member. For source, an installed CPython parses it with its own ast module in a separate isolated process (no site packages, empty environment, nothing compiled or run): the encoding from its BOM or PEP 263 line, any syntax error with its location, the module docstring, imports (with level, alias, enclosing scope, lazy imports and the if/try/TYPE_CHECKING/__main__ blocks around them), function and class definitions (qualified name, decorators and bases as source text, arguments, type parameters, docstring), calls by the dotted name written at the call, dynamic imports and exec/eval/compile/reflection calls as unknowns, module-level assignments, a literal __all__, global/nonlocal declarations and if __name__ == "__main__" blocks. Choose the grammar with `python` (e.g. 3.12); the newest installed interpreter is used otherwise. For a .pyc whose exact magic number is admitted (3.9, 3.11, 3.12, 3.13, 3.14, 3.15), the bytecode is decoded in process: the header, every code object in pre-order (index, qualified name, flags, argument counts, instruction count) and IMPORT_NAME sites with their from-list and level. Other magic numbers keep the header only.',
    inputSchema: inspectPythonModuleInputSchema,
    outputSchema: evidenceResultOf(pythonModuleReportSchema),
    examples: [
      { title: "Parse a source file", input: { path: "/artifacts/tool.py" } },
      {
        title: "List the code objects of a module in a wheel",
        input: {
          path: "/artifacts/example-1.0-py3-none-any.whl",
          entry: "example/__init__.py",
          python: "3.12",
        },
      },
    ],
  },
  {
    name: "inspect_python_code",
    ...toolContractMetadata("inspect_python_code"),
    kind: "artifact-provider",
    description:
      "Decode one code object of an explicit local .pyc (or .pyc archive member) in process, without unmarshalling it in an interpreter or running it: a page of instructions with offset, opcode, name, argument, the argument as the producing release's dis renders it (constants, names, locals, comparison and binary operators, jump labels), jump target, inline cache units, source line and column span; plus the exception table, constants with their repr, names, local, cell and free variables, flags and argument counts. Choose the code object by its qualified name (when unique) or by the pre-order index inspect_python_module lists; the module itself is index 0. Only admitted release profiles (3.9, 3.11, 3.12, 3.13, 3.14, 3.15) are decoded.",
    inputSchema: inspectPythonCodeInputSchema,
    outputSchema: evidenceResultOf(pythonCodeReportSchema),
    examples: [
      {
        title: "Decode a method",
        input: { path: "/artifacts/module.pyc", code: "Child.fetch" },
      },
      {
        title: "Decode the third code object of a zipped module",
        input: {
          path: "/artifacts/app.pyz",
          entry: "pkg/__pycache__/mod.cpython-312.pyc",
          code_index: 2,
        },
      },
    ],
  },
  {
    name: "decompile_python_code",
    ...toolContractMetadata("decompile_python_code"),
    kind: "artifact-provider",
    description:
      "Reconstruct Python source for one .pyc (a loose file or a wheel, zip application or ZIP member chosen with entry) with the installed, digest-pinned pycdc (Decompyle++), and return it inline labelled as inferred. Python 2.7 and 3.5-3.13 bytecode is read; 3.14 and later are refused. pycdc runs in its own process over a copy in a scratch directory that is removed afterwards, with an empty environment; nothing is imported, unmarshalled by an interpreter or run. Then three checks: pycdc's own warnings (unsupported opcodes, `# WARNING: Decompyle incomplete` markers, listed by line); whether an installed CPython of the same release compiles the text (compiled only, never run); and whether the recompiled code objects match the original's by name (missing and extra names listed). Any check that fails or cannot run makes the result partial; pycdc is weak on 3.9 and later, so expect partial text. When pycdc is not installed or is not an admitted build, the tool says so instead of guessing; inspect_python_code still gives the bytecode.",
    inputSchema: decompilePythonCodeInputSchema,
    outputSchema: evidenceResultOf(pythonDecompilationSchema),
    examples: [
      {
        title: "Decompile a .pyc",
        input: { path: "/artifacts/module.pyc" },
      },
      {
        title: "Decompile a module inside a zip application without the checks",
        input: {
          path: "/artifacts/app.pyz",
          entry: "pkg/__pycache__/mod.cpython-38.pyc",
          check: false,
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
