// Real-producer lane for format expansion F03. Every installed CPython whose
// exact magic number has an admitted profile compiles its own standard
// library with py_compile; every code object of every .pyc is decoded by the
// built reader and compared with that interpreter's own dis
// (scripts/python/dis-oracle.py). Then pip-built wheels (pure and with a C
// extension) and a zipapp-built application go through the public CLI. A
// missing interpreter makes its profile unverified, never a pass.
//
// REA_PYTHON_LANE_LIMIT caps the standard-library files per release (default all).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const cli = join(repository, "scripts/oopsware.mjs");
const oracle = join(repository, "scripts/python/dis-oracle.py");
const load = (path) => import(join(repository, "dist", path));
const { admittedProfiles } = await load("python/bytecode/profiles.js");
const { discoverInterpreters } = await load("python/interpreters.js");
const { readPycHeader, loadPyc, codeEntries } = await load(
  "python/bytecode/pyc.js",
);
const { lineInfo, exceptionTable } = await load("python/bytecode/lineTable.js");
const { disassemble } = await load("python/bytecode/disassemble.js");
const { reprValue } = await load("python/bytecode/repr.js");

const limit = Number(process.env.REA_PYTHON_LANE_LIMIT ?? Infinity);
const BATCH = 80;

/** A constant with every set's items sorted by repr, matching dis-oracle.py's stable(). */
const sortSets = (printable, value) => {
  if (value.t === "tuple" || value.t === "list")
    return {
      t: value.t,
      items: value.items.map((item) => sortSets(printable, item)),
    };
  if (value.t === "set" || value.t === "frozenset")
    return {
      t: value.t,
      items: value.items
        .map((item) => sortSets(printable, item))
        .map((item) => [reprValue(printable, item), item])
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([, item]) => item),
    };
  return value;
};

const constantText = (code, profile, item) => {
  const value = item.arg === null ? undefined : code.consts[item.arg];
  return item.argrepr !== "" &&
    item.opname !== "LOAD_SMALL_INT" &&
    profile.has("hasconst", item.opcode) &&
    value !== undefined &&
    ["tuple", "set", "frozenset"].includes(value.t)
    ? reprValue(profile.data.printable, sortSets(profile.data.printable, value))
    : item.argrepr;
};

/** One difference is enough to fail; report where it is. */
const compareCode = (file, index, profile, entry, expected) => {
  const code = entry.code;
  const where = `${file} code ${String(index)} (${expected.qualname ?? expected.name})`;
  for (const field of [
    "name",
    "qualname",
    "firstlineno",
    "argcount",
    "posonlyargcount",
    "kwonlyargcount",
    "nlocals",
    "stacksize",
    "flags",
    "filename",
  ])
    assert.equal(code[field], expected[field], `${where}: ${field}`);
  for (const field of ["names", "varnames", "cellvars", "freevars"])
    assert.deepEqual(code[field], expected[field], `${where}: ${field}`);
  assert.deepEqual(
    code.consts.map((value) =>
      reprValue(
        profile.data.printable,
        sortSets(profile.data.printable, value),
      ),
    ),
    expected.consts,
    `${where}: consts`,
  );
  const lines = lineInfo(code, profile);
  assert.equal(lines.problem, null, `${where}: line table`);
  const table =
    profile.layout === "3.11+"
      ? exceptionTable(code)
      : { entries: [], problem: null };
  assert.equal(table.problem, null, `${where}: exception table`);
  if (expected.exception_table !== undefined)
    assert.deepEqual(
      table.entries.map((item) => [
        item.start,
        item.end,
        item.target,
        item.depth,
        item.lasti,
      ]),
      expected.exception_table,
      `${where}: exception table`,
    );
  const { instructions, problems } = disassemble(code, profile, lines);
  assert.deepEqual(problems, [], `${where}: problems`);
  assert.equal(
    instructions.length,
    expected.instructions.length,
    `${where}: instruction count`,
  );
  const modern =
    profile.rules !== "3.9" &&
    profile.rules !== "3.11" &&
    profile.rules !== "3.12";
  instructions.forEach((ours, position) => {
    const theirs = expected.instructions[position];
    const at = `${where} @${String(theirs.offset)}`;
    assert.equal(ours.offset, theirs.offset, `${at}: offset`);
    assert.equal(ours.opname, theirs.opname, `${at}: opname`);
    assert.equal(ours.arg, theirs.arg, `${at}: arg`);
    assert.equal(
      constantText(code, profile, ours),
      theirs.argrepr,
      `${at}: argrepr`,
    );
    if (modern) {
      assert.equal(
        ours.startOffset,
        theirs.start_offset,
        `${at}: start_offset`,
      );
      assert.equal(ours.startsLine, theirs.starts_line, `${at}: starts_line`);
      assert.equal(ours.line, theirs.line, `${at}: line`);
    } else
      assert.equal(
        ours.startsLine ? ours.line : null,
        theirs.starts_line,
        `${at}: starts_line`,
      );
    if (theirs.positions !== undefined)
      assert.deepEqual(
        [ours.line, ours.endLine, ours.column, ours.endColumn],
        theirs.positions,
        `${at}: positions`,
      );
    if (theirs.jump_target !== undefined)
      assert.equal(ours.jumpTarget, theirs.jump_target, `${at}: jump target`);
  });
  return instructions.length;
};

const sources = async (interpreter) => {
  const { stdout } = await exec(
    interpreter.path,
    ["-I", "-c", "import sysconfig; print(sysconfig.get_paths()['stdlib'])"],
    { env: {} },
  );
  const root = stdout.trim();
  const files = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === "site-packages" || entry.name === "__pycache__")
        continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith(".py")) files.push(path);
    }
  };
  await walk(root);
  return { root, files: files.sort().slice(0, limit) };
};

/** Stdlib modules decompiled per release; each run starts its own pycdc and checker. */
const DECOMPILE_SAMPLE = Number(process.env.REA_PYTHON_DECOMPILE_SAMPLE ?? 40);
/** The admitted pycdc reads up to 3.13 bytecode. */
const DECOMPILE_MAX_MINOR = 13;

const scratch = await mkdtemp(join(tmpdir(), "oopsware-python-lane-"));
const summary = [];
const compiledTargets = new Map();
try {
  const versions = new Set(
    admittedProfiles().map((profile) => profile.version),
  );
  const seen = new Set();
  const producers = (await discoverInterpreters()).filter((interpreter) => {
    if (!versions.has(interpreter.version) || seen.has(interpreter.version))
      return false;
    seen.add(interpreter.version);
    return true;
  });
  const missing = [...versions].filter((version) => !seen.has(version));
  if (missing.length > 0)
    console.log(
      `UNVERIFIED (no interpreter installed): Python ${missing.join(", ")}`,
    );
  assert.ok(
    producers.length > 0,
    "No admitted CPython is installed; the lane cannot run.",
  );

  for (const interpreter of producers) {
    const { root, files } = await sources(interpreter);
    const out = join(scratch, interpreter.version);
    await mkdir(out, { recursive: true });
    let compiled = 0;
    let skipped = 0;
    let codes = 0;
    let instructions = 0;
    for (let start = 0; start < files.length; start += BATCH) {
      const batch = files.slice(start, start + BATCH);
      // py_compile each file; sources the grammar rejects (deliberate bad-syntax tests) are skipped and counted.
      const { stdout } = await exec(
        interpreter.path,
        [
          "-I",
          "-c",
          [
            "import py_compile, sys, os",
            "root, out = sys.argv[1], sys.argv[2]",
            "for path in sys.argv[3:]:",
            "    target = os.path.join(out, os.path.relpath(path, root) + 'c')",
            "    try:",
            "        py_compile.compile(path, cfile=target, dfile=os.path.relpath(path, root), doraise=True)",
            "        print('ok', target)",
            "    except Exception:",
            "        print('skip', path)",
          ].join("\n"),
          root,
          out,
          ...batch,
        ],
        { env: {}, maxBuffer: 64 * 1024 ** 2 },
      );
      const targets = [];
      for (const lineText of stdout.split("\n")) {
        if (lineText.startsWith("ok ")) targets.push(lineText.slice(3));
        else if (lineText.startsWith("skip ")) skipped += 1;
      }
      if (targets.length === 0) continue;
      compiledTargets.set(interpreter, [
        ...(compiledTargets.get(interpreter) ?? []),
        ...targets,
      ]);
      const { stdout: described } = await exec(
        interpreter.path,
        ["-I", oracle, ...targets],
        {
          env: {},
          maxBuffer: 1024 ** 3,
        },
      );
      const report = JSON.parse(described);
      for (const file of report.files) {
        const bytes = await readFile(file.path);
        const header = readPycHeader(bytes);
        assert.ok(header?.admitted, `${file.path}: header not admitted`);
        const loaded = loadPyc(bytes, header, 5_000_000);
        assert.equal(
          loaded.kind,
          "decoded",
          `${file.path}: ${loaded.problem ?? loaded.kind}`,
        );
        assert.equal(loaded.trailing, 0, `${file.path}: trailing bytes`);
        const entries = codeEntries(loaded.module, 1_000_000);
        assert.equal(
          entries.length,
          file.codes.length,
          `${file.path}: code object count`,
        );
        entries.forEach((entry, index) => {
          instructions += compareCode(
            relative(out, file.path),
            index,
            loaded.profile,
            entry,
            file.codes[index],
          );
        });
        codes += entries.length;
        compiled += 1;
      }
    }
    summary.push(
      `Python ${interpreter.release}: ${String(compiled)} stdlib modules, ${String(codes)} code objects, ${String(instructions)} instructions = dis (${String(skipped)} sources the grammar rejects skipped)`,
    );
    console.log(summary.at(-1));
  }

  // Wheels and a zip application through the public CLI.
  const run = async (...args) => {
    const { stdout } = await exec(process.execPath, [cli, ...args, "--json"], {
      maxBuffer: 256 * 1024 ** 2,
    });
    return JSON.parse(stdout).normalized_result;
  };

  // pycdc reconstruction of a spread of stdlib modules per release. pycdc's
  // quality is reported, not asserted; the checks must agree with themselves.
  decompile: for (const [interpreter, targets] of compiledTargets) {
    if (Number(interpreter.version.split(".")[1]) > DECOMPILE_MAX_MINOR)
      continue;
    const step = Math.max(1, Math.floor(targets.length / DECOMPILE_SAMPLE));
    const sample = targets
      .filter((_, index) => index % step === 0)
      .slice(0, DECOMPILE_SAMPLE);
    const counts = {
      modules: 0,
      crashed: 0,
      complete: 0,
      warnings: 0,
      recompiles: 0,
      match: 0,
    };
    for (const path of sample) {
      let report;
      try {
        report = await run("decompile-python-code", path);
      } catch (cause) {
        const output = `${cause.stdout ?? ""}`;
        if (
          /pycdc/iu.test(output) &&
          /unavailable|not installed|not admitted/iu.test(output)
        ) {
          console.log(
            `UNVERIFIED (no admitted pycdc installed): decompile-python-code`,
          );
          break decompile;
        }
        // pycdc itself can crash or stop on modern bytecode; that is counted, not a lane failure.
        if (
          /"unsupported_target"/u.test(output) &&
          /pycdc (crashed|exited)/u.test(output)
        ) {
          counts.modules += 1;
          counts.crashed += 1;
          continue;
        }
        throw new Error(`${path}: decompile failed: ${output.slice(0, 500)}`, {
          cause,
        });
      }
      const state = (id) =>
        report.checks.find((check) => check.id === id)?.state;
      assert.equal(report.source.confidence, "inferred", `${path}: confidence`);
      assert.ok(
        report.source.derived_from.includes(report.selection.sha256),
        `${path}: derived_from`,
      );
      // The provider picks its own interpreter of the same feature release.
      if (report.checker !== null)
        assert.equal(
          report.checker.release.split(".").slice(0, 2).join("."),
          interpreter.version,
          `${path}: checker`,
        );
      assert.equal(
        state("recompiles") === "failed",
        report.syntax_error !== null,
        `${path}: syntax error agrees`,
      );
      if (state("code_objects_match") === "passed")
        assert.deepEqual(
          [report.code_objects.missing, report.code_objects.extra],
          [[], []],
          `${path}: names`,
        );
      assert.equal(
        report.coverage[0].state === "complete",
        report.checks.every((check) => check.state === "passed"),
        `${path}: coverage agrees with checks`,
      );
      counts.modules += 1;
      if (report.coverage[0].state === "complete") counts.complete += 1;
      if (state("decompiler_warnings") === "passed") counts.warnings += 1;
      if (state("recompiles") === "passed") counts.recompiles += 1;
      if (state("code_objects_match") === "passed") counts.match += 1;
    }
    summary.push(
      `pycdc on Python ${interpreter.release}: ${String(counts.modules)} stdlib modules; pycdc crashed or stopped ${String(counts.crashed)}, no warnings ${String(counts.warnings)}, recompile ${String(counts.recompiles)}, code objects match ${String(counts.match)}, all checks passed ${String(counts.complete)}`,
    );
    console.log(summary.at(-1));
  }
  const builder = await (async () => {
    for (const interpreter of await discoverInterpreters()) {
      const { stdout } = await exec(
        interpreter.path,
        [
          "-I",
          "-c",
          "import importlib.util as u; print(bool(u.find_spec('pip') and u.find_spec('setuptools')))",
        ],
        { env: {} },
      );
      if (stdout.trim() === "True") return interpreter;
    }
    return null;
  })();
  if (builder === null)
    console.log(
      "UNVERIFIED: no interpreter with pip and setuptools builds wheels.",
    );
  else
    for (const project of ["project", "native"]) {
      const work = join(scratch, `${project}-wheel`);
      await exec("/bin/cp", [
        "-R",
        join(repository, "tests/fixtures/python", project),
        work,
      ]);
      await exec(
        builder.path,
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
          join(work, "out"),
          work,
        ],
        {
          env: { HOME: work, PATH: "/usr/bin:/bin" },
          maxBuffer: 16 * 1024 ** 2,
        },
      );
      const wheel = join(
        work,
        "out",
        (await readdir(join(work, "out"))).find((name) =>
          name.endsWith(".whl"),
        ),
      );
      const report = await run("inspect-python-artifact", wheel);
      assert.equal(report.container.kind, "wheel");
      assert.deepEqual(
        report.wheel.record.mismatched,
        [],
        `${project}: RECORD mismatch`,
      );
      assert.deepEqual(
        report.wheel.record.not_listed,
        [],
        `${project}: members RECORD omits`,
      );
      if (project === "native")
        assert.equal(report.native_count, 1, "native extension");
      summary.push(
        `pip ${builder.release} wheel ${project}: RECORD ${String(report.wheel.record.verified)}/${String(report.wheel.record.rows)} verified, ${String(report.native_count)} native`,
      );
      console.log(summary.at(-1));
    }
  const newest = producers[0];
  const app = join(scratch, "app");
  await mkdir(join(app, "pkg"), { recursive: true });
  await exec("/bin/cp", [
    join(repository, "tests/fixtures/python/sample.py"),
    join(app, "pkg", "sample.py"),
  ]);
  await exec(
    newest.path,
    [
      "-I",
      "-c",
      "import pathlib, sys; p = pathlib.Path(sys.argv[1]); (p / '__main__.py').write_text('import pkg.sample\\n'); (p / 'pkg' / '__init__.py').write_text('')",
      app,
    ],
    { env: {} },
  );
  await exec(newest.path, ["-I", "-m", "compileall", "-q", join(app, "pkg")], {
    env: {},
  });
  await exec(
    newest.path,
    [
      "-I",
      "-m",
      "zipapp",
      app,
      "-o",
      `${app}.pyz`,
      "-p",
      "/usr/bin/env python3",
    ],
    { env: {} },
  );
  const zipapp = await run("inspect-python-artifact", `${app}.pyz`);
  assert.equal(zipapp.container.kind, "zipapp");
  assert.equal(zipapp.zipapp.shebang, "#!/usr/bin/env python3");
  const pyc = zipapp.modules.find((entry) => entry.kind === "bytecode");
  assert.ok(pyc?.admitted, "zipapp .pyc admitted");
  const listed = await run(
    "inspect-python-module",
    `${app}.pyz`,
    "--entry",
    pyc.entry,
  );
  assert.equal(listed.bytecode.decode, "complete");
  const source = await run(
    "inspect-python-module",
    `${app}.pyz`,
    "--entry",
    "pkg/sample.py",
  );
  assert.equal(source.source.status, "parsed");
  summary.push(
    `zipapp ${newest.release}: ${String(zipapp.module_count)} modules, ${String(listed.bytecode.code_count)} code objects decoded, source parsed`,
  );
  console.log(summary.at(-1));
  console.log("PASS verify:formats:python");
} finally {
  await rm(scratch, { recursive: true, force: true });
}
