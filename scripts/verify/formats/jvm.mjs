// Real-producer lane for format expansion F02: classes compiled by the
// installed JDK, JARs it ships, and any JARs named in REA_JVM_LANE_JARS
// (colon-separated) are read through the public CLI, and every method of
// every class is decoded and compared with the JDK's own javap. A missing JDK
// makes the lane unavailable, never a pass.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  constants,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { arch, platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const cli = join(repository, "scripts/oopsware.mjs");
const { parseClass } = await import(
  join(repository, "dist/jvm/classfile/parseClass.js")
);
const { decodeBytecode } = await import(
  join(repository, "dist/jvm/classfile/bytecode.js")
);

const LANE = "verify:formats:jvm";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const unavailable = (reason) => {
  console.log(JSON.stringify({ lane: LANE, status: "unavailable", reason }));
  console.error(`UNAVAILABLE: ${reason}`);
  process.exit(2);
};

const executable = async (path) => {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** The JDK whose javac, jar and javap this lane uses; release 21 or newer (the source uses switch patterns). */
const findJdk = async () => {
  const candidates = [process.env.REA_TEST_JDK_HOME, process.env.JAVA_HOME];
  if (platform() === "darwin")
    try {
      candidates.push(
        (await exec("/usr/libexec/java_home", ["-v", "21+"])).stdout.trim(),
      );
    } catch {
      // No registered JDK.
    }
  candidates.push(
    "/opt/homebrew/opt/openjdk@21",
    "/opt/homebrew/opt/openjdk",
    "/usr/lib/jvm/default-java",
  );
  for (const home of candidates) {
    if (!home) continue;
    const tools = ["javac", "jar", "javap"].map((tool) =>
      join(home, "bin", tool),
    );
    if (!(await Promise.all(tools.map(executable))).every(Boolean)) continue;
    const { stderr, stdout } = await exec(join(home, "bin", "javac"), [
      "-version",
    ]);
    const release = Number(/javac (\d+)/u.exec(`${stdout}${stderr}`)?.[1]);
    if (release >= 21) return { home, version: `${stdout}${stderr}`.trim() };
  }
  return null;
};

const run = async (...args) => {
  const { stdout } = await exec(process.execPath, [cli, ...args, "--json"], {
    cwd: repository,
    maxBuffer: 512 * 1024 ** 2,
    env: { ...process.env, REA_LOG_LEVEL: "silent" },
  });
  return JSON.parse(stdout).normalized_result;
};

const SOURCE = `package lane;

import java.util.*;
import java.util.function.*;

public sealed interface Shape permits Shape.Box, Shape.Dot {
  record Box(int w, int h) implements Shape {}
  record Dot() implements Shape {}

  static int area(Shape shape) {
    return switch (shape) {
      case Box b when b.w() > 100 -> -1;
      case Box b -> b.w() * b.h();
      case Dot d -> 0;
    };
  }
  static String join(List<String> parts) {
    StringBuilder out = new StringBuilder();
    for (String part : parts) {
      try { out.append(part.charAt(0)); }
      catch (StringIndexOutOfBoundsException e) { out.append('?'); }
      finally { out.append(','); }
    }
    Function<String, Integer> length = String::length;
    return out + ":" + length.apply("abc") + ":" + 3.5d + ":" + 7L;
  }
}
`;

/** Ordinary Java 17 constructs Vineflower 1.12 is expected to reconstruct as compilable source. */
const PLAIN = `package lane;

import java.util.*;
import java.util.function.*;

public final class Plain {
  private final Map<String, Integer> counts = new TreeMap<>();

  public int add(Collection<String> words) {
    int total = 0;
    for (String word : words) {
      try {
        counts.merge(word.toLowerCase(Locale.ROOT), 1, Integer::sum);
        total += word.length();
      } catch (RuntimeException e) {
        total = -1;
      } finally {
        total ^= 1;
      }
    }
    return total;
  }

  public String describe(int kind) {
    String label = switch (kind) { case 0 -> "none"; case 1 -> "one"; default -> "many"; };
    Supplier<String> text = () -> label + counts.size();
    return text.get();
  }
}
`;

/**
 * javap's `pc: mnemonic` lines per method, one entry per file in input order:
 * javap prints one class header per file, and a multi-release JAR repeats a
 * class name across versions, so files, not names, key the result.
 */
const javapListings = async (javap, files) => {
  const listings = [];
  for (let start = 0; start < files.length; start += 200) {
    const { stdout } = await exec(
      javap,
      ["-c", "-p", "-s", ...files.slice(start, start + 200)],
      {
        maxBuffer: 1024 ** 3,
      },
    );
    let owner = null;
    let header = "";
    let current = null;
    for (const line of stdout.split("\n")) {
      // Modifiers are optional: package-private classes start with the keyword itself.
      const type =
        /^(?:[\w-]+ )*(?:class|interface|enum|record) ([\w.$-]+)/u.exec(line);
      if (type !== null && !line.startsWith(" ")) {
        owner = new Map();
        listings.push({ name: type[1], methods: owner });
        header = "";
        continue;
      }
      if (/^ {2}(\S.*\(.*\)|static \{\}).*;$/u.test(line)) {
        header = line;
        current = null;
        continue;
      }
      const descriptor = /^ {4}descriptor: (\S+)$/u.exec(line);
      if (descriptor !== null && header !== "" && owner !== null) {
        const name = header.includes("static {}")
          ? "<clinit>"
          : (/([\w$<>.]+)\(/u.exec(header)?.[1] ?? "?");
        current = [];
        owner.set(`${name.split(".").at(-1)}${descriptor[1]}`, current);
        continue;
      }
      const instruction = /^\s+(\d+): ([a-z]\w*)/u.exec(line);
      if (instruction !== null && current !== null)
        current.push(`${instruction[1]}: ${instruction[2]}`);
    }
  }
  return listings;
};

const classFiles = async (directory) =>
  (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".class") &&
        entry.name !== "module-info.class",
    )
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();

/** Decode every method of every class file and compare it with javap; returns counts. */
const compareWithJavap = async (javap, directory) => {
  const files = await classFiles(directory);
  const listings = await javapListings(javap, files);
  assert.equal(
    listings.length,
    files.length,
    `javap printed ${listings.length} classes for ${files.length} files`,
  );
  let methods = 0;
  let instructions = 0;
  for (const [index, file] of files.entries()) {
    const bytes = await readFile(file);
    const parsed = parseClass(bytes);
    assert.ok(parsed !== null, `${file} is not a class file`);
    assert.equal(
      parsed.stopped,
      null,
      `${file}: ${JSON.stringify(parsed.stopped)}`,
    );
    const owner = parsed.thisClass;
    assert.equal(listings[index].name, owner.replaceAll("/", "."), file);
    const expected = listings[index].methods;
    for (const method of parsed.methods) {
      if (method.code === null) continue;
      const decoded = decodeBytecode(
        bytes,
        method.code.codeOffset,
        method.code.codeLength,
        parsed.pool,
      );
      assert.equal(
        decoded.stopped,
        null,
        `${owner}.${method.name}: ${JSON.stringify(decoded.stopped)}`,
      );
      const simple = owner.split("/").at(-1);
      const key = `${method.name === "<init>" ? simple : method.name}${method.descriptor}`;
      const ours = decoded.instructions.map(
        (entry) => `${entry.pc}: ${entry.opcode.name}${entry.wide ? "_w" : ""}`,
      );
      assert.deepEqual(ours, expected.get(key), `${owner} ${key}`);
      methods += 1;
      instructions += ours.length;
    }
  }
  return { classes: files.length, methods, instructions };
};

/** Every page of a JAR's class list through the CLI; every class must decode completely. */
const inventory = async (path) => {
  const first = await run("inspect-jvm-artifact", path, "--limit", "5000");
  const classes = [...first.classes];
  for (let next = first.page.next; next !== null;) {
    const page = await run(
      "inspect-jvm-artifact",
      path,
      "--start",
      String(next),
      "--limit",
      "5000",
    );
    classes.push(...page.classes);
    next = page.page.next;
  }
  assert.equal(classes.length, first.class_count, `${path} pages`);
  const incomplete = classes.filter((entry) => entry.decode !== "complete");
  assert.deepEqual(
    incomplete.map(
      (entry) => `${entry.container ?? ""}!${entry.entry}: ${entry.error}`,
    ),
    [],
    path,
  );
  if (first.entry_digests !== null)
    assert.equal(
      first.entry_digests.matched,
      first.entry_digests.declared,
      `${path} digests ${JSON.stringify(first.entry_digests)}`,
    );
  return first;
};

/** Top-level classes decompiled per JAR; each run starts its own Vineflower JVM. */
const DECOMPILE_SAMPLE = 25;

/**
 * Reconstruct a sample of top-level classes through the CLI. Returns null when
 * the admitted Vineflower is not installed, so that part is reported as
 * unavailable rather than passed.
 */
const reconstruct = async (jar, report) => {
  const names = [
    ...new Set(
      report.classes
        .filter(
          (entry) =>
            entry.release === null &&
            entry.container === null &&
            entry.kind !== "module" &&
            entry.name !== null &&
            !entry.name.includes("$"),
        )
        .map((entry) => entry.name),
    ),
  ].slice(0, DECOMPILE_SAMPLE);
  const counts = {
    classes: 0,
    complete: 0,
    partial: 0,
    untrusted_methods: 0,
    notes: 0,
  };
  for (const name of names) {
    let result;
    try {
      result = await run("decompile-jvm-class", jar, "--class", name);
    } catch (cause) {
      const output = `${cause.stdout ?? ""}`;
      if (
        /AnalysisCapabilityUnavailableError|vineflower/iu.test(output) &&
        counts.classes === 0
      )
        return null;
      throw new Error(
        `${jar} ${name}: decompile failed: ${output.slice(0, 500)}`,
        { cause },
      );
    }
    assert.equal(result.source.confidence, "inferred");
    assert.ok(result.source.text.length > 0, `${jar} ${name}: empty source`);
    counts.classes += 1;
    counts[result.coverage[0].state] += 1;
    counts.untrusted_methods += result.untrusted_methods.length;
    counts.notes += result.decompiler_notes.length;
  }
  return counts;
};

const root = await mkdtemp(join(tmpdir(), "oopsware-jvm-lane-"));
try {
  const jdk = await findJdk();
  if (jdk === null)
    unavailable("no JDK 21+ with javac, jar and javap was found");
  const tool = (name) => join(jdk.home, "bin", name);
  const javap = tool("javap");

  await mkdir(join(root, "src", "lane"), { recursive: true });
  await writeFile(join(root, "src", "lane", "Shape.java"), SOURCE);
  await writeFile(join(root, "src", "lane", "Plain.java"), PLAIN);
  await exec(tool("javac"), [
    "-g",
    "--release",
    "21",
    "-d",
    join(root, "classes"),
    join(root, "src", "lane", "Shape.java"),
    join(root, "src", "lane", "Plain.java"),
  ]);
  const built = join(root, "lane.jar");
  await exec(tool("jar"), [
    "--create",
    "--file",
    built,
    "-C",
    join(root, "classes"),
    ".",
  ]);

  const jars = [
    built,
    ...(
      await readdir(join(jdk.home, "demo"), { recursive: true }).catch(() => [])
    )
      .filter((name) => name.endsWith(".jar"))
      .map((name) => join(jdk.home, "demo", name)),
    ...(process.env.REA_JVM_LANE_JARS ?? "")
      .split(":")
      .filter((path) => path !== ""),
  ];
  const results = [];
  for (const [index, jar] of jars.entries()) {
    const report = await inventory(jar);
    const extracted = join(root, `extracted-${index}`);
    await mkdir(extracted);
    await exec(tool("jar"), ["--extract", "--file", jar], {
      cwd: extracted,
      maxBuffer: 64 * 1024 ** 2,
    });
    const compared = await compareWithJavap(javap, extracted);
    assert.equal(
      compared.classes,
      report.class_count - report.summary.kinds.module,
      `${jar}: CLI and extracted class counts`,
    );
    const reconstructed = await reconstruct(jar, report);
    results.push({
      reconstructed,
      jar: jar === built ? "lane.jar (javac-built)" : jar,
      sha256: sha256(await readFile(jar)),
      kind: report.container.kind,
      multi_release: report.multi_release.releases,
      signatures: report.signatures.map((entry) => entry.signer),
      ...compared,
    });
  }

  // Plain's reconstruction must compile again; Shape's pattern switch must be flagged, not called complete.
  let recompiled = null;
  if (results[0]?.reconstructed != null) {
    const plain = await run(
      "decompile-jvm-class",
      built,
      "--class",
      "lane.Plain",
    );
    assert.equal(
      plain.coverage[0].state,
      "complete",
      JSON.stringify(plain.decompiler_notes),
    );
    const again = join(root, "recompiled", "lane");
    await mkdir(again, { recursive: true });
    await writeFile(join(again, "Plain.java"), plain.source.text);
    await exec(tool("javac"), [
      "--release",
      "21",
      "-d",
      join(root, "recompiled-classes"),
      join(again, "Plain.java"),
    ]);
    const shape = await run(
      "decompile-jvm-class",
      built,
      "--class",
      "lane.Shape",
    );
    assert.equal(shape.coverage[0].state, "partial");
    assert.ok(
      shape.decompiler_notes.some((note) =>
        note.text.startsWith("Unresolved invokedynamic"),
      ),
      "pattern switch flagged",
    );
    recompiled = {
      plain: { recompiles: true, source_sha256: plain.source.sha256 },
      pattern_switch: { flagged: true, notes: shape.decompiler_notes.length },
      decompiler: plain.decompiler.build,
    };
  }

  const { stdout: commit } = await exec("git", ["rev-parse", "HEAD"], {
    cwd: repository,
  });
  const totals = results.reduce(
    (sum, entry) => ({
      classes: sum.classes + entry.classes,
      methods: sum.methods + entry.methods,
      instructions: sum.instructions + entry.instructions,
    }),
    { classes: 0, methods: 0, instructions: 0 },
  );
  console.log(
    JSON.stringify({
      lane: LANE,
      status: "passed",
      commit: commit.trim(),
      host: `${platform()}-${arch()}`,
      tools: { jdk: jdk.version },
      reconstruction:
        recompiled === null
          ? {
              status: "unavailable",
              reason: "no admitted Vineflower build is installed",
            }
          : {
              status: "passed",
              lane_source_recompiled: recompiled,
              sample_per_jar: DECOMPILE_SAMPLE,
            },
      inputs: results,
      totals,
      passed: [
        "identify and inventory every class through the CLI (all pages)",
        "manifest per-entry digests recomputed and matched where declared",
        "every method of every class decoded with the same pcs and mnemonics as javap",
        ...(recompiled === null
          ? []
          : [
              "Vineflower source for a sample of each JAR's top-level classes",
              "reconstructed ordinary Java recompiles with javac; an unresolved pattern switch is flagged as partial",
            ]),
      ],
      omitted: [
        "behavioral equivalence of reconstructed source",
        "StackMapTable and type-annotation decoding",
        "signature verification",
      ],
    }),
  );
  console.error(
    `PASS: ${String(results.length)} JARs, ${String(totals.classes)} classes, ${String(totals.methods)} methods, ${String(totals.instructions)} instructions match javap.`,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
