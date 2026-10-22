import { execFile } from "node:child_process";
import { access, constants, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Real JVM producers for F02 fixtures. Classes, JARs, signatures and AARs are
 * built by the installed JDK (javac, jar, jarsigner, keytool) at test time;
 * no binary fixture is committed. The JDK must be 17 or newer.
 */
const executable = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const MINIMUM_RELEASE = 17;

const releaseOf = async (javac: string): Promise<number | null> => {
  try {
    const { stdout, stderr } = await run(javac, ["-version"]);
    const major = /javac (\d+)/u.exec(`${stdout}${stderr}`)?.[1];
    return major === undefined ? null : Number(major);
  } catch {
    return null;
  }
};

/** A JDK home is admitted only when all four tools exist and javac is new enough. */
const admitted = async (home: string): Promise<string | null> => {
  const tools = ["javac", "jar", "jarsigner", "keytool"].map((tool) =>
    join(home, "bin", tool),
  );
  for (const tool of tools) if (!(await executable(tool))) return null;
  const release = await releaseOf(join(home, "bin", "javac"));
  return release !== null && release >= MINIMUM_RELEASE ? home : null;
};

const findJdk = async (): Promise<string | null> => {
  const candidates = [
    process.env.REA_TEST_JDK_HOME,
    process.env.JAVA_HOME,
    "/opt/homebrew/opt/openjdk@21",
    "/opt/homebrew/opt/openjdk@17",
    "/opt/homebrew/opt/openjdk",
    "/usr/lib/jvm/default-java",
    "/usr/lib/jvm/java-21-openjdk-amd64",
    "/usr/lib/jvm/java-17-openjdk-amd64",
  ];
  // macOS's /usr/bin/javac is a stub that can open an install dialog; ask java_home instead.
  if (process.platform === "darwin")
    try {
      const { stdout } = await run("/usr/libexec/java_home", [
        "-v",
        `${String(MINIMUM_RELEASE)}+`,
      ]);
      candidates.push(stdout.trim());
    } catch {
      // No registered JDK.
    }
  for (const home of candidates)
    if (home !== undefined && home !== "" && (await admitted(home)) !== null)
      return home;
  return null;
};

export const JDK_HOME = await findJdk();

const tool = (name: string): string => {
  if (JDK_HOME === null)
    throw new Error("No JDK 17+ is available for JVM fixtures.");
  return join(JDK_HOME, "bin", name);
};

const SHAPES = `package demo;

import java.lang.annotation.*;
import java.util.*;
import java.util.function.*;

@Retention(RetentionPolicy.RUNTIME)
@interface Tag { String value(); int weight() default 3; ElementType[] on() default {ElementType.TYPE}; }

@Tag(value = "shape", weight = 7)
public sealed interface Shapes permits Shapes.Circle, Shapes.Square {
  double area();

  record Circle(double radius) implements Shapes {
    public double area() { return Math.PI * radius * radius; }
  }
  record Square(@Deprecated long side) implements Shapes {
    public double area() { return side * side; }
  }

  static int dense(int k) {
    switch (k) { case 0: return 10; case 1: return 20; case 2: return 30; default: return -1; }
  }
  static long guarded(Object lock, List<String> items) throws Exception {
    long total = 9_000_000_000L;
    synchronized (lock) {
      try {
        for (String item : items) total += item.length();
      } catch (IllegalStateException | IllegalArgumentException e) {
        total = -1;
      } finally {
        total ^= 0x5;
      }
    }
    return total;
  }
  static Supplier<String> lambda(String prefix) {
    Function<Integer, String> f = n -> prefix + n;
    return () -> f.apply(42);
  }
  static int area(int w, int h) { return w * h; }
  static int area(int side) { return side * side; }
}
`;

const TASK = `package demo;

public final class Task implements Runnable {
  public static final String NAME = "task";
  public void run() { System.out.println(Shapes.dense(1)); }
  public static void main(String[] args) { new Task().run(); }
}
`;

const MODULE = `module demo.shapes {
  requires java.base;
  requires static java.logging;
  exports demo;
  provides java.lang.Runnable with demo.Task;
}
`;

/** A Java 21 pattern switch with a guard; Vineflower 1.12 leaves it as an unresolved invokedynamic. */
const PATTERNS = `package lane;

public final class Patterns {
  sealed interface Shape permits Box, Dot {}
  record Box(int w, int h) implements Shape {}
  record Dot() implements Shape {}

  static int area(Shape shape) {
    return switch (shape) {
      case Box b when b.w() > 100 -> -1;
      case Box b -> b.w() * b.h();
      case Dot d -> 0;
    };
  }
}
`;

const versionSource = (label: string) => `package mr;

public class Version {
  public static String label() { return "${label}"; }
}
`;

/** A 64-byte ELF64 little-endian AArch64 shared-object header (the AAR reader looks only at the header). */
const elfHeader = (): Buffer => {
  const header = Buffer.alloc(64);
  header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
  header.writeUInt16LE(3, 16); // ET_DYN
  header.writeUInt16LE(183, 18); // EM_AARCH64
  header.writeUInt32LE(1, 20);
  header.writeUInt16LE(64, 52);
  return header;
};

const ANDROID_MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.lib">
  <uses-sdk android:minSdkVersion="24" android:targetSdkVersion="34" />
</manifest>
`;

export interface JvmFixtures {
  /** Directory of loose .class files compiled for release 17 with -g. */
  readonly classes: string;
  /** Signed modular JAR with Main-Class and a service provider. */
  readonly app: string;
  /** Multi-release JAR: base (release 8), versions/11 and versions/17 of mr.Version. */
  readonly multiRelease: string;
  /** JAR whose META-INF/versions member is not honoured (no Multi-Release attribute). */
  readonly undeclared: string;
  /** AAR with classes.jar, libs/extra.jar, a JNI library and resources. */
  readonly aar: string;
  /** JAR of a Java 21 pattern switch; null when the JDK cannot target release 21. */
  readonly patterns: string | null;
}

const javac = (release: number, output: string, sources: string[]) =>
  run(tool("javac"), [
    "-g",
    "--release",
    String(release),
    "-nowarn",
    "-Xlint:-options",
    "-d",
    output,
    ...sources,
  ]);

/** Write the Java sources and compile the loose classes (release 17). */
const compileSources = async (root: string) => {
  const source = join(root, "src");
  await mkdir(join(source, "demo"), { recursive: true });
  await mkdir(join(source, "mr8", "mr"), { recursive: true });
  await mkdir(join(source, "mr11", "mr"), { recursive: true });
  await mkdir(join(source, "mr17", "mr"), { recursive: true });
  await writeFile(join(source, "demo", "Shapes.java"), SHAPES);
  await writeFile(join(source, "demo", "Task.java"), TASK);
  await writeFile(join(source, "module-info.java"), MODULE);
  await writeFile(
    join(source, "mr8", "mr", "Version.java"),
    versionSource("base"),
  );
  await writeFile(
    join(source, "mr11", "mr", "Version.java"),
    versionSource("eleven"),
  );
  await writeFile(
    join(source, "mr17", "mr", "Version.java"),
    versionSource("seventeen"),
  );
  const classes = join(root, "classes");
  await javac(17, classes, [
    join(source, "module-info.java"),
    join(source, "demo", "Shapes.java"),
    join(source, "demo", "Task.java"),
  ]);

  return { source, classes };
};

/** A signed modular JAR with Main-Class and a service provider. */
const buildSignedJar = async (root: string, classes: string) => {
  const resources = join(root, "resources");
  await mkdir(join(resources, "META-INF", "services"), { recursive: true });
  await writeFile(
    join(resources, "META-INF", "services", "java.lang.Runnable"),
    "# providers\ndemo.Task\n\nnot a class name!\n",
  );
  const app = join(root, "app.jar");
  await run(tool("jar"), [
    "--create",
    "--file",
    app,
    "--main-class",
    "demo.Task",
    "-C",
    classes,
    ".",
    "-C",
    resources,
    ".",
  ]);
  const keystore = join(root, "test.p12");
  await run(tool("keytool"), [
    "-genkeypair",
    "-keystore",
    keystore,
    "-storetype",
    "PKCS12",
    "-storepass",
    "changeit",
    "-alias",
    "fixture",
    "-keyalg",
    "EC",
    "-groupname",
    "secp256r1",
    "-dname",
    "CN=Oopsware Fixture",
    "-validity",
    "2",
  ]);
  await run(tool("jarsigner"), [
    "-keystore",
    keystore,
    "-storepass",
    "changeit",
    "-sigfile",
    "FIXTURE",
    app,
    "fixture",
  ]);

  return app;
};

/** Multi-release JAR plus a JAR whose versioned members are not honoured. */
const buildMultiReleaseJars = async (root: string, source: string) => {
  const out8 = join(root, "mr-8");
  const out11 = join(root, "mr-11");
  const out17 = join(root, "mr-17");
  await javac(8, out8, [join(source, "mr8", "mr", "Version.java")]);
  await javac(11, out11, [join(source, "mr11", "mr", "Version.java")]);
  await javac(17, out17, [join(source, "mr17", "mr", "Version.java")]);
  const multiRelease = join(root, "mr.jar");
  await run(tool("jar"), [
    "--create",
    "--file",
    multiRelease,
    "-C",
    out8,
    ".",
    "--release",
    "11",
    "-C",
    out11,
    ".",
    "--release",
    "17",
    "-C",
    out17,
    ".",
  ]);

  const undeclaredTree = join(root, "undeclared");
  await mkdir(join(undeclaredTree, "META-INF", "versions", "17"), {
    recursive: true,
  });
  const undeclared = join(root, "undeclared.jar");
  await run("/bin/cp", [
    "-R",
    join(out17, "mr"),
    join(undeclaredTree, "META-INF", "versions", "17", "mr"),
  ]);
  await run("/bin/cp", ["-R", join(out8, "mr"), join(undeclaredTree, "mr")]);
  await run(tool("jar"), [
    "--create",
    "--file",
    undeclared,
    "-C",
    undeclaredTree,
    ".",
  ]);

  return { out8, multiRelease, undeclared };
};

/** An AAR with classes.jar, libs/extra.jar, a JNI library and resources. */
const buildAar = async (root: string, classes: string, out8: string) => {
  const aarTree = join(root, "aar");
  await mkdir(join(aarTree, "libs"), { recursive: true });
  await mkdir(join(aarTree, "jni", "arm64-v8a"), { recursive: true });
  await mkdir(join(aarTree, "res", "values"), { recursive: true });
  await writeFile(join(aarTree, "AndroidManifest.xml"), ANDROID_MANIFEST);
  await writeFile(join(aarTree, "R.txt"), "int string app_name 0x7f010001\n");
  await writeFile(
    join(aarTree, "res", "values", "strings.xml"),
    '<resources><string name="app_name">Lib</string></resources>\n',
  );
  await writeFile(
    join(aarTree, "jni", "arm64-v8a", "libnative.so"),
    elfHeader(),
  );
  await run(tool("jar"), [
    "--create",
    "--file",
    join(aarTree, "classes.jar"),
    "-C",
    classes,
    "demo",
  ]);
  await run(tool("jar"), [
    "--create",
    "--file",
    join(aarTree, "libs", "extra.jar"),
    "-C",
    out8,
    ".",
  ]);
  const aar = join(root, "library.aar");
  await run(tool("jar"), [
    "--create",
    "--no-manifest",
    "--file",
    aar,
    "-C",
    aarTree,
    ".",
  ]);
  return aar;
};

/** The pattern-switch JAR needs javac 21+; older JDKs leave it out. */
const buildPatterns = async (root: string): Promise<string | null> => {
  const directory = join(root, "src", "lane");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "Patterns.java"), PATTERNS);
  try {
    await javac(21, join(root, "patterns"), [join(directory, "Patterns.java")]);
  } catch {
    return null;
  }
  const jar = join(root, "patterns.jar");
  await run(tool("jar"), [
    "--create",
    "--file",
    jar,
    "-C",
    join(root, "patterns"),
    ".",
  ]);
  return jar;
};

/** Build every F02 fixture under `root` with the real JDK. */
export const buildJvmFixtures = async (root: string): Promise<JvmFixtures> => {
  const { source, classes } = await compileSources(root);
  const app = await buildSignedJar(root, classes);
  const { out8, multiRelease, undeclared } = await buildMultiReleaseJars(
    root,
    source,
  );
  const aar = await buildAar(root, classes, out8);
  return {
    classes,
    app,
    multiRelease,
    undeclared,
    aar,
    patterns: await buildPatterns(root),
  };
};
