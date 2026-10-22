import { execFile } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import type { PyValue } from "../../src/python/bytecode/marshal.js";
import { admittedProfiles } from "../../src/python/bytecode/profiles.js";
import { reprValue, type Printable } from "../../src/python/bytecode/repr.js";
import {
  discoverInterpreters,
  type Interpreter,
} from "../../src/python/interpreters.js";

const run = promisify(execFile);

/**
 * Real CPython producers for F03 fixtures. Each installed interpreter whose
 * release has an admitted bytecode profile compiles the committed sample
 * sources with py_compile at test time; no .pyc is committed. The same
 * interpreter's dis module (scripts/python/dis-oracle.py) is the oracle.
 */

const repository = resolve(import.meta.dirname, "../..");
const samples = join(repository, "tests/fixtures/python");
const oracle = join(repository, "scripts/python/dis-oracle.py");

/** Sample sources and the first release whose grammar accepts them. */
export const PYTHON_SAMPLES: readonly { file: string; since: number }[] = [
  { file: "sample.py", since: 9 },
  { file: "sample_310.py", since: 10 },
  { file: "sample_311.py", since: 11 },
  { file: "sample_312.py", since: 12 },
  { file: "sample_314.py", since: 14 },
  { file: "sample_315.py", since: 15 },
];

export type Invalidation = "TIMESTAMP" | "CHECKED_HASH" | "UNCHECKED_HASH";

/** Installed interpreters whose exact magic number has an admitted profile. */
export const admittedProducers = async (): Promise<Interpreter[]> => {
  const versions = new Set(
    admittedProfiles().map((profile) => profile.version),
  );
  const seen = new Set<string>();
  return (await discoverInterpreters()).filter((interpreter) => {
    if (!versions.has(interpreter.version) || seen.has(interpreter.version))
      return false;
    seen.add(interpreter.version);
    return true;
  });
};

export const minorOf = (interpreter: Interpreter): number =>
  Number(interpreter.version.split(".")[1]);

/** Compile one sample with py_compile; `name` is recorded as co_filename. */
export const compileSample = async (
  interpreter: Interpreter,
  directory: string,
  file: string,
  invalidation: Invalidation = "TIMESTAMP",
): Promise<string> => {
  await mkdir(directory, { recursive: true });
  const source = join(directory, file);
  await copyFile(join(samples, file), source);
  const target = join(
    directory,
    `${file.replace(/\.py$/u, "")}.${interpreter.version}.${invalidation.toLowerCase()}.pyc`,
  );
  await run(
    interpreter.path,
    [
      "-I",
      "-c",
      "import py_compile, sys; py_compile.compile(sys.argv[1], cfile=sys.argv[2], dfile=sys.argv[3], doraise=True, invalidation_mode=py_compile.PycInvalidationMode[sys.argv[4]])",
      source,
      target,
      file,
      invalidation,
    ],
    { env: {} },
  );
  return target;
};

export interface OracleInstruction {
  readonly offset: number;
  readonly opname: string;
  readonly opcode: number;
  readonly arg: number | null;
  readonly argrepr: string;
  readonly start_offset?: number;
  readonly starts_line: number | boolean | null;
  readonly line?: number | null;
  readonly positions?: (number | null)[];
  readonly jump_target?: number;
}

export interface OracleCode {
  readonly name: string;
  readonly qualname: string | null;
  readonly firstlineno: number;
  readonly argcount: number;
  readonly posonlyargcount: number;
  readonly kwonlyargcount: number;
  readonly nlocals: number;
  readonly stacksize: number;
  readonly flags: number;
  readonly names: string[];
  readonly varnames: string[];
  readonly cellvars: string[];
  readonly freevars: string[];
  readonly filename: string;
  readonly code_bytes: number;
  readonly consts: string[];
  readonly instructions: OracleInstruction[];
  readonly exception_table?: [number, number, number, number, boolean][];
}

export interface OracleReport {
  readonly version: string;
  readonly magic: number;
  readonly files: { path: string; codes: OracleCode[] }[];
}

/** What the producing interpreter's own dis reports for its .pyc files. */
export const disOracle = async (
  interpreter: Interpreter,
  files: readonly string[],
): Promise<OracleReport> => {
  const { stdout } = await run(interpreter.path, ["-I", oracle, ...files], {
    env: {},
    maxBuffer: 256 * 1024 ** 2,
  });
  return JSON.parse(stdout) as OracleReport;
};

const hasModules = async (
  interpreter: Interpreter,
  modules: readonly string[],
): Promise<boolean> => {
  try {
    const { stdout } = await run(
      interpreter.path,
      [
        "-I",
        "-c",
        "import importlib.util, sys; print(all(importlib.util.find_spec(m) for m in sys.argv[1:]))",
        ...modules,
      ],
      { env: {} },
    );
    return stdout.trim() === "True";
  } catch {
    return false;
  }
};

/** An installed interpreter with pip and setuptools, which builds wheels offline. */
export const wheelProducer = async (): Promise<Interpreter | null> => {
  for (const interpreter of await discoverInterpreters())
    if (await hasModules(interpreter, ["pip", "setuptools"]))
      return interpreter;
  return null;
};

/**
 * Build one fixture project (`project`: pure, `native`: with a C extension)
 * into a wheel with pip and setuptools, offline and without build isolation.
 */
export const buildWheel = async (
  interpreter: Interpreter,
  directory: string,
  project: "project" | "native",
): Promise<string> => {
  const work = join(directory, `${project}-build`);
  await mkdir(work, { recursive: true });
  await run("/bin/cp", ["-R", join(samples, project), join(work, "src")]);
  const out = join(directory, `${project}-wheel`);
  await run(
    interpreter.path,
    [
      "-I",
      "-m",
      "pip",
      "wheel",
      "--no-deps",
      "--no-build-isolation",
      "--no-index",
      "--disable-pip-version-check",
      "-w",
      out,
      join(work, "src"),
    ],
    // The C compiler is found on PATH; nothing else is inherited.
    { env: { HOME: work, PATH: "/usr/bin:/bin" }, maxBuffer: 16 * 1024 ** 2 },
  );
  const { stdout } = await run("/bin/ls", [out]);
  const name = stdout.split("\n").find((entry) => entry.endsWith(".whl"));
  if (name === undefined) throw new Error(`pip wrote no wheel for ${project}`);
  return join(out, name);
};

/**
 * Build a zip application with python -m zipapp: a shebang line, a
 * __main__.py, a package, and that package compiled into __pycache__.
 */
export const buildZipapp = async (
  interpreter: Interpreter,
  directory: string,
): Promise<string> => {
  const app = join(directory, "zipapp-src");
  await mkdir(join(app, "pkg"), { recursive: true });
  await copyFile(join(samples, "sample.py"), join(app, "pkg", "sample.py"));
  await run(
    interpreter.path,
    [
      "-I",
      "-c",
      [
        "import pathlib, py_compile, sys",
        "app = pathlib.Path(sys.argv[1])",
        "(app / '__main__.py').write_text('import pkg.sample\\npkg.sample.outer(1, d=2)\\n')",
        "(app / 'pkg' / '__init__.py').write_text('')",
        "py_compile.compile(str(app / 'pkg' / 'sample.py'), cfile=str(app / 'pkg' / '__pycache__' / ('sample.' + sys.implementation.cache_tag + '.pyc')), dfile='pkg/sample.py', doraise=True)",
      ].join("\n"),
      app,
    ],
    { env: {} },
  );
  const target = join(directory, "app.pyz");
  await run(
    interpreter.path,
    ["-I", "-m", "zipapp", app, "-o", target, "-p", "/usr/bin/env python3"],
    { env: {} },
  );
  return target;
};

/** Copy a ZIP, replacing one member's bytes, with the interpreter's zipfile module. */
export const replaceMember = async (
  interpreter: Interpreter,
  source: string,
  target: string,
  member: string,
  text: string,
): Promise<void> => {
  await run(
    interpreter.path,
    [
      "-I",
      "-c",
      [
        "import sys, zipfile",
        "source, target, member, text = sys.argv[1:5]",
        "with zipfile.ZipFile(source) as old, zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as new:",
        "    for info in old.infolist():",
        "        new.writestr(info, text.encode() if info.filename == member else old.read(info))",
      ].join("\n"),
      source,
      target,
      member,
      text,
    ],
    { env: {} },
  );
};

/** A constant with every set's items sorted by repr, matching dis-oracle.py's stable(). */
export const sortSets = (printable: Printable, value: PyValue): PyValue => {
  switch (value.t) {
    case "tuple":
    case "list":
      return {
        t: value.t,
        items: value.items.map((item) => sortSets(printable, item)),
      };
    case "set":
    case "frozenset":
      return {
        t: value.t,
        items: value.items
          .map((item) => sortSets(printable, item))
          .sort((left, right) => {
            const a = reprValue(printable, left);
            const b = reprValue(printable, right);
            return a < b ? -1 : a > b ? 1 : 0;
          }),
      };
    default:
      return value;
  }
};
