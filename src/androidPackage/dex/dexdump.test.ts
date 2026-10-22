import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { dexAccessFlags, dexAccessFlagsText } from "./accessFlags.js";
import { DexFile } from "./dexFile.js";
import { adler32 } from "./DexReader.js";
import { decodeDalvik, type DalvikInstruction } from "./instructions.js";
import { DALVIK_OPCODES } from "./opcodes.js";
import { escapeDexString, printfG } from "./valueText.js";
import {
  ANDROID_TOOLS,
  buildAndroidFixtures,
} from "../../../tests/fixtures/androidProducers.js";
import {
  encodeModifiedUtf8,
  renderDexdumpListing,
} from "../../../tests/support/android/dexdumpListing.js";
import { removeTestWorkspace } from "../../../tests/support/workspace/workspaceFixture.js";

/**
 * The Dalvik decoder and the DEX structure parser checked line by line
 * against Google's dexdump (`-d -a`) over real d8 output: the F04 fixtures, a
 * coverage corpus compiled here with javac + d8 for min API 21, 24, 26 and 28
 * (DEX 035/037/038/039), d8 `--no-desugaring` output with invoke-custom and
 * call sites, a class written with the JDK's ClassFile API for
 * const-method-handle/const-method-type, and any DEX files named in
 * REA_DEX_ORACLE_INPUTS (colon-separated absolute paths).
 */

const run = promisify(execFile);

const javaEnvironment = (javaHome: string): NodeJS.ProcessEnv => ({
  PATH: `${join(javaHome, "bin")}:/usr/bin:/bin`,
  JAVA_HOME: javaHome,
  HOME: process.env.HOME ?? "/tmp",
});

const exec = async (
  command: string,
  args: readonly string[],
  javaHome = ANDROID_TOOLS?.javaHome ?? "",
): Promise<string> =>
  (
    await run(command, [...args], {
      env: javaEnvironment(javaHome),
      maxBuffer: 64 * 1024 ** 2,
    })
  ).stdout;

const ANNOTATIONS = String.raw`package org.oops.dalvik;

import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;

@Retention(RetentionPolicy.RUNTIME)
@interface Every {
  byte b() default 1; short s() default -2; char c() default 'c'; int i() default 4; long j() default 5L;
  float f() default 6.5f; double d() default -7.25; boolean z() default true; String str() default "s\"q";
  Class<?> type() default Object.class; Kind kind() default Kind.ONE; Mark mark() default @Mark;
  int[] ints() default {1, 2}; String[] none() default {}; Class<?>[] types() default {int.class, String[].class, void.class};
}

@interface Mark { String value() default "m"; }

enum Kind { ONE, TWO }

interface Shape {
  int area(int w);
  long many(long a, long b, long c);
  default String name() { return "shape"; }
  static int unit() { return 1; }
}

abstract class Base {
  protected Base() {}
  protected Base(long a, long b, long c) {}
  int base(int x) { return x + 1; }
  int six(int a, int b, int c, int d, int e, int f) { return a + f; }
}
`;

/** Every instruction family javac + d8 emit, with values that keep d8 from folding them away. */
const CORPUS = String.raw`package org.oops.dalvik;

import java.util.ArrayList;
import java.util.List;

@Every(b = -1, s = 300, c = '\n', i = -100000, j = Long.MAX_VALUE, f = Float.NaN, d = 1e-300,
    z = false, str = "x\tyé", type = int[][].class, kind = Kind.TWO, mark = @Mark("inner"),
    ints = {}, types = {})
public class Corpus extends Base implements Shape, Comparable<Corpus> {
  public static final byte B = -128;
  public static final short S = -32768;
  public static final char C = '￿';
  public static final int I = Integer.MIN_VALUE;
  public static final long J = Long.MIN_VALUE, J2 = 0x123456789abcdefL;
  public static final float F_NAN = Float.NaN, F_NEG_ZERO = -0.0f, F_INF = Float.NEGATIVE_INFINITY;
  public static final float F_MIN = Float.MIN_VALUE, F_TIE = 12345.25f;
  public static final double D_TIE = 100000.5, D_TIE2 = 1234565.0, D_SMALL = 1.25e-5;
  public static final double D_MIN = Double.MIN_VALUE, D_BIG = -1e300;
  public static final boolean Z = true;
  public static final String TEXT =
      "esc: \" \\ \t \r \n \b \f \u000b \u0001 \u001f \u007f nul:\u0000 latin:é cjk:中 astral:😀 end";
  public static final String EMPTY = "";
  static final Class<?> NOT_CONSTANT = Corpus.class;
  static final List<String> NAMES = new ArrayList<>();

  @Mark("field") boolean z;
  byte b; char c; short s; int i; long j; float f; double d; Object o;
  volatile int vol;
  transient int tr;
  static boolean sz; static byte sb; static char sc; static short ss; static int si;
  static long sj; static float sf; static double sd; static Object so;

  public Corpus() {}
  Corpus(long a, long b, long c) { super(a, b, c); }

  @Every @Override public int area(@Mark("w") int w) { return w * w; }
  @Override public long many(long a, long b, long c) { return a + b + c; }
  @Override int base(int x) { return super.base(x) + 1; }
  @Override int six(int a, int b, int c, int d, int e, int f) { return super.six(a, b, c, d, e, f) + 1; }
  @Override public int compareTo(Corpus other) { return Integer.compare(i, other.i); }
  private int hidden(int a) { return a + i; }
  private long hiddenWide(long a, long b, long c) { return a - b - c; }
  static int staticSix(int a, int b, int c, int d, int e, int f) { return a * f; }

  long invokes(Shape shape) {
    long r = shape.area(1);
    r += shape.many(1, 2, 3);
    r += area(2);
    r += many(4, 5, 6);
    r += hidden(3);
    r += hiddenWide(7, 8, 9);
    r += staticSix(1, 2, 3, 4, 5, 6);
    r += Shape.unit();
    r += shape.name().length();
    r += base(4) + six(1, 2, 3, 4, 5, 6);
    r += new Corpus(1L, 2L, 3L).i;
    return r;
  }

  void fields(Corpus other) {
    other.z = !z; other.b = (byte) (b + 1); other.c = (char) (c + 1); other.s = (short) (s + 1);
    other.i = i + 1; other.j = j + 1; other.f = f + 1; other.d = d + 1; other.o = o;
    sz = !sz; sb = (byte) (sb + 1); sc = (char) (sc + 1); ss = (short) (ss + 1);
    si = si + 1; sj = sj + 1; sf = sf + 1; sd = sd + 1; so = other;
  }

  static int ints(int a, int b) {
    int r = a + b;
    r += a - b; r += a * b; r += a / b; r += a % b; r += a & b; r += a | b; r += a ^ b;
    r += a << b; r += a >> b; r += a >>> b;
    int t = a;
    t += b; t -= b; t *= b; t /= b; t %= b; t &= b; t |= b; t ^= b; t <<= b; t >>= b; t >>>= b;
    r += a + 7; r += 7 - a; r += a * 7; r += a / 7; r += a % 7; r += a & 7; r += a | 7; r += a ^ 7;
    r += a << 7; r += a >> 7; r += a >>> 7;
    r += a + 1000; r += 1000 - a; r += a * 1000; r += a / 1000; r += a % 1000; r += a & 1000;
    r += a | 1000; r += a ^ 1000;
    r += -a; r += ~a;
    return r + t;
  }

  static long longs(long a, long b, int sh) {
    long r = a + b;
    r += a - b; r += a * b; r += a / b; r += a % b; r += a & b; r += a | b; r += a ^ b;
    r += a << sh; r += a >> sh; r += a >>> sh;
    long t = a;
    t += b; t -= b; t *= b; t /= b; t %= b; t &= b; t |= b; t ^= b; t <<= sh; t >>= sh; t >>>= sh;
    r += -a; r += ~a;
    return r + t;
  }

  static float floats(float a, float b) {
    float r = a + b;
    r += a - b; r += a * b; r += a / b; r += a % b;
    float t = a;
    t += b; t -= b; t *= b; t /= b; t %= b;
    return -r + t;
  }

  static double doubles(double a, double b) {
    double r = a + b;
    r += a - b; r += a * b; r += a / b; r += a % b;
    double t = a;
    t += b; t -= b; t *= b; t /= b; t %= b;
    return -r + t;
  }

  static float remFloat(float a, float b) { float x = a % b; return x + a + b; }
  static double remDouble(double a, double b) { double x = a % b; return x + a + b; }
  static int ushr(int a, int b) { a >>>= b; return a; }
  static long moveWide(long a, long b) { long c = a; a = b; b = c; return a - b; }

  static long conversions(int i, long l, float f, double d) {
    long r = i;
    r += (long) (float) i; r += (long) (double) i;
    r += (int) l; r += (long) (float) l; r += (long) (double) l;
    r += (int) f; r += (long) f; r += (long) (double) f;
    r += (int) d; r += (long) d; r += (long) (float) d;
    r += (byte) i + (char) i + (short) i;
    return r;
  }

  static int compares(int a, int b, long x, long y, float f, float g, double d, double e, Object o) {
    int r = 0;
    if (a == b) r++; if (a != b) r++; if (a < b) r++; if (a >= b) r++; if (a > b) r++; if (a <= b) r++;
    if (a == 0) r++; if (a != 0) r++; if (a < 0) r++; if (a >= 0) r++; if (a > 0) r++; if (a <= 0) r++;
    if (x < y) r++; if (f < g) r++; if (f > g) r++; if (d < e) r++; if (d > e) r++;
    if (o == null) r++; if (o != null) r++;
    return r;
  }

  static long constants(int k) {
    int a = 5 + k, b = 1000 + k, c = 100000 + k, d = 0x12340000 + k, m = -1 + k, n = -32768 + k;
    long e = 1000L + k, f = 100000L + k, g = 0x123456789L + k, h = 0x1234000000000000L + k, w = -1L + k;
    float fl = 1.5f + k, ft = 0.1f + k, fz = -0.0f + k;
    double db = 2.5 + k, pi = 3.141592653589793 + k, tiny = 4.9e-324 + k;
    double nan = Double.NaN + k, inf = Double.POSITIVE_INFINITY + k;
    return a + b + c + d + m + n + e + f + g + h + w + (long) (fl + ft + fz) + (long) (db + pi + tiny + nan + inf);
  }

  static long arrays(boolean[] z, byte[] b, char[] c, short[] s, int[] i, long[] j, float[] f, double[] d, Object[] o, int k) {
    z[k] = !z[k + 1]; b[k] = b[k + 1]; c[k] = c[k + 1]; s[k] = s[k + 1]; i[k] = i[k + 1];
    j[k] = j[k + 1]; f[k] = f[k + 1]; d[k] = d[k + 1]; o[k] = o[k + 1];
    return z.length + b.length + c.length + s.length + i.length + j.length + f.length + d.length + o.length;
  }

  static Object fills(int a, int b, int c, int d, int e, int f) {
    Object[] all = new Object[12];
    all[0] = new byte[] {1, 2, 3, -4, 5};
    all[1] = new short[] {1, -2, 300, 4};
    all[2] = new char[] {'a', 'b', '￿', 'd'};
    all[3] = new int[] {1, -2, 100000, 7};
    all[4] = new long[] {1L, -2L, 1L << 40, 5L};
    all[5] = new float[] {1.5f, -2f, Float.NaN, 4f};
    all[6] = new double[] {1.5, -2.25, 1e300, 4.0};
    all[7] = new boolean[] {true, false, true, true, false};
    all[8] = new int[] {a, b, c};
    all[9] = new int[] {a, b, c, d, e, f};
    all[10] = new int[a][b];
    all[11] = new String[a];
    return all;
  }

  static int packed(int k) {
    switch (k) {
      case -2: return 10; case -1: return 20; case 0: return 30; case 1: return 40; case 2: return 50; case 3: return 60;
      default: return 0;
    }
  }

  static int sparse(int k) {
    switch (k) {
      case Integer.MIN_VALUE: return 1; case -100000: return 2; case -5: return 3; case 7: return 4;
      case 1 << 20: return 5; case Integer.MAX_VALUE: return 6;
      default: return 0;
    }
  }

  static String strings(String s) {
    switch (s) {
      case "alpha": return "\u0000";
      case "beta": return "tab\there";
      case "gamma": return "quote\"back\\slash";
      default: return "é中😀\u007f\u0001";
    }
  }

  synchronized int objects(Object x) throws Exception {
    int r = 0;
    synchronized (x) { r += x.hashCode(); }
    if (x instanceof String) r += ((String) x).length();
    Class<?> type = String[].class;
    Class<?> prim = int.class;
    r += type.getName().length() + prim.getName().length();
    try {
      r += Integer.parseInt((String) x);
    } catch (NumberFormatException | ClassCastException e) {
      r -= 1;
    } catch (RuntimeException e) {
      throw new Exception(e);
    } finally {
      r += 2;
    }
    if (r < 0) throw new IllegalStateException("negative");
    return r;
  }

  int lambdas(int seed) {
    Runnable run = () -> NAMES.add("run");
    run.run();
    java.util.function.IntUnaryOperator op = x -> x + seed + i;
    return op.applyAsInt(seed);
  }

  long loops(long[] values) {
    long total = 0;
    for (long value : values) {
      total = total * 31 + value;
      if (total > 1000) break;
    }
    Object last = null;
    for (int index = 0; index < values.length; index++) last = index % 2 == 0 ? values : this;
    return total + (last == null ? 0 : 1);
  }

  static long medium(long n) {
    long r = 0;
    for (long k = 0; k < n; k++) {
      ${Array.from({ length: 40 }, (_, index) => `r = r * ${String(31 + index)} + k;`).join(" ")}
    }
    return r;
  }

  static native int nativeMethod(int x);

  abstract static class Inner { abstract void nothing(); }

  class Member { int outer() { return i; } }
}
`;

/** invoke-polymorphic(/range): d8 refuses it below min API 26. */
const HANDLES = String.raw`package org.oops.dalvik;

import java.lang.invoke.MethodHandle;
import java.lang.invoke.MethodHandles;
import java.lang.invoke.MethodType;

public class Handles {
  static int add(int a, int b) { return a + b; }
  static int sum5(int a, int b, int c, int d, int e) { return a + b + c + d + e; }

  static int call() throws Throwable {
    MethodHandles.Lookup lookup = MethodHandles.lookup();
    MethodHandle add = lookup.findStatic(Handles.class, "add", MethodType.methodType(int.class, int.class, int.class));
    MethodHandle sum = lookup.findStatic(Handles.class, "sum5",
        MethodType.methodType(int.class, int.class, int.class, int.class, int.class, int.class));
    int r = (int) add.invokeExact(1, 2);
    r += (int) sum.invoke(1, 2, 3, 4, 5);
    Object any = add.invoke((Object) 1, (Object) 2);
    return r + any.hashCode();
  }
}
`;

/** invoke-custom(/range), call sites and method handles: d8 `--no-desugaring` keeps invokedynamic. */
const INDY = String.raw`package org.oops.indy;

import java.util.List;
import java.util.function.Function;
import java.util.function.Supplier;
import java.util.function.ToIntFunction;

public class Indy {
  int field;
  static String concat(int a, long b, String c, char d, double e, Object f, float g) {
    return "a=" + a + ",b=" + b + ",c=" + c + ",d=" + d + ",e=" + e + ",f=" + f + ",g=" + g + "\u0001\u0002";
  }
  static String small(int a) { return "x" + a; }
  Runnable lambda(int seed) { return () -> System.out.println(seed + field); }
  Function<String, Integer> ref() { return String::length; }
  Supplier<Indy> ctor() { return Indy::new; }
  ToIntFunction<List<String>> size() { return List::size; }
  private int secret() { return field; }
  Supplier<Integer> direct() { return this::secret; }
}
`;

/** More than 256 live registers, so d8 needs move/from16 and move/16 in all three kinds. */
const registersSource = (): string => {
  const ints = Array.from({ length: 300 }, (_, index) => index);
  const twelve = Array.from({ length: 12 }, (_, index) => index);
  return `package org.oops.dalvik;

public class Registers {
  static long spill(int seed, long wide, Object obj) {
${ints.map((index) => `    int v${String(index)} = seed + ${String(index)};`).join("\n")}
${twelve.map((index) => `    long w${String(index)} = wide + ${String(index)};`).join("\n")}
${twelve.map((index) => `    Object o${String(index)} = k(obj, ${String(index)});`).join("\n")}
    for (int k = 0; k < seed; k++) {
      int t = v299; v299 = v298; v298 = t;
      long tw = w11; w11 = w10; w10 = tw;
      Object to = o11; o11 = o10; o10 = to;
    }
    long r = ${ints.map((index) => `v${String(index)}`).join(" + ")};
    r += ${twelve.map((index) => `w${String(index)}`).join(" + ")};
    r += ${twelve.map((index) => `o${String(index)}.hashCode()`).join(" + ")};
    synchronized (o11) { r += 1; }
    if (o10 instanceof String) r += ((String) o10).length();
    return r;
  }
  static Object k(Object o, int n) { return n == 0 ? o : String.valueOf(n); }
}
`;
};

/** A loop body longer than 32767 code units, so its back edge needs goto/32. */
const jumpSource = (): string => `package org.oops.dalvik;

public class Jump {
  static long sink;
  static void s(long v) { sink += v; }
  static void far(int n) {
    for (int k = 0; k < n; k++) {
${Array.from({ length: 5000 }, (_, index) => `      s(${(0x1122334455660000n + BigInt(index)).toString()}L);`).join("\n")}
    }
  }
}
`;

/** More than 65536 strings in one DEX file, so the late ones need const-string/jumbo. */
const jumboSources = (): Record<string, string> =>
  Object.fromEntries(
    [0, 1, 2].map((file) => [
      `org/oops/jumbo/Strings${String(file)}.java`,
      `package org.oops.jumbo;

public class Strings${String(file)} {
  static int n;
  static void s(String v) { n += v.length(); }
${[0, 1, 2]
  .map(
    (method) =>
      `  static void m${String(method)}() {\n${Array.from(
        { length: 7500 },
        (_, index) =>
          `    s("s${String(file * 22_500 + method * 7500 + index).padStart(6, "0")}");`,
      ).join("\n")}\n  }`,
  )
  .join("\n")}
}
`,
    ]),
  );

/**
 * javac never emits ldc of a MethodHandle or MethodType, so this generator
 * (run with a JDK 24+ for java.lang.classfile) writes one class that loads
 * every method handle kind and three method types; d8 --min-api 28 turns them
 * into const-method-handle and const-method-type.
 */
const CLASSFILE_GENERATOR = String.raw`import java.lang.classfile.ClassFile;
import java.lang.constant.ClassDesc;
import java.lang.constant.ConstantDescs;
import java.lang.constant.DirectMethodHandleDesc.Kind;
import java.lang.constant.MethodHandleDesc;
import java.lang.constant.MethodTypeDesc;
import java.nio.file.Files;
import java.nio.file.Path;

public class Gen {
  public static void main(String[] args) throws Exception {
    ClassDesc self = ClassDesc.of("org.oops.consts.Consts");
    ClassDesc object = ConstantDescs.CD_Object;
    MethodTypeDesc intToInt = MethodTypeDesc.of(ConstantDescs.CD_int, ConstantDescs.CD_int);
    MethodTypeDesc toVoid = MethodTypeDesc.of(ConstantDescs.CD_void);
    MethodHandleDesc[] handles = {
      MethodHandleDesc.ofMethod(Kind.STATIC, self, "twice", intToInt),
      MethodHandleDesc.ofMethod(Kind.VIRTUAL, self, "half", intToInt),
      MethodHandleDesc.ofMethod(Kind.SPECIAL, self, "half", intToInt),
      MethodHandleDesc.ofMethod(Kind.CONSTRUCTOR, self, "<init>", toVoid),
      MethodHandleDesc.ofMethod(Kind.INTERFACE_VIRTUAL, ClassDesc.of("java.lang.Runnable"), "run", toVoid),
      MethodHandleDesc.ofField(Kind.STATIC_GETTER, self, "counter", ConstantDescs.CD_int),
      MethodHandleDesc.ofField(Kind.STATIC_SETTER, self, "counter", ConstantDescs.CD_int),
      MethodHandleDesc.ofField(Kind.GETTER, self, "value", ConstantDescs.CD_long),
      MethodHandleDesc.ofField(Kind.SETTER, self, "value", ConstantDescs.CD_long),
    };
    MethodTypeDesc[] types = { intToInt, toVoid, MethodTypeDesc.of(object, ConstantDescs.CD_long, ConstantDescs.CD_String.arrayType()) };
    byte[] bytes = ClassFile.of().build(self, cb -> {
      cb.withVersion(55, 0);
      cb.withSuperclass(object);
      cb.withField("counter", ConstantDescs.CD_int, ClassFile.ACC_STATIC);
      cb.withField("value", ConstantDescs.CD_long, 0);
      cb.withMethodBody("<init>", toVoid, ClassFile.ACC_PUBLIC, code -> code.aload(0).invokespecial(object, "<init>", toVoid).return_());
      cb.withMethodBody("twice", intToInt, ClassFile.ACC_STATIC, code -> code.iload(0).iconst_2().imul().ireturn());
      cb.withMethodBody("half", intToInt, ClassFile.ACC_PUBLIC, code -> code.iload(1).iconst_2().idiv().ireturn());
      cb.withMethodBody("constants", MethodTypeDesc.of(object.arrayType()), ClassFile.ACC_PUBLIC | ClassFile.ACC_STATIC, code -> {
        code.ldc(handles.length + types.length).anewarray(object);
        int index = 0;
        for (MethodHandleDesc handle : handles) code.dup().ldc(index++).ldc(handle).aastore();
        for (MethodTypeDesc type : types) code.dup().ldc(index++).ldc(type).aastore();
        code.areturn();
      });
    });
    Path out = Path.of(args[0], "org/oops/consts/Consts.class");
    Files.createDirectories(out.getParent());
    Files.write(out, bytes);
  }
}
`;

/** A JDK 24+ (java.lang.classfile is final there) at a fixed install path, or null. */
const findClassFileJdk = async (): Promise<string | null> => {
  for (const home of [
    process.env.REA_TEST_CLASSFILE_JDK_HOME,
    "/opt/homebrew/opt/openjdk@25",
    "/opt/homebrew/opt/openjdk",
  ]) {
    if (home === undefined || home === "") continue;
    try {
      const { stdout } = await run(join(home, "bin", "java"), ["--version"], {
        env: javaEnvironment(home),
      });
      const major = Number(/^\S+ (\d+)/u.exec(stdout)?.[1] ?? "0");
      if (major >= 24) return home;
    } catch {
      // Not installed here.
    }
  }
  return null;
};

const CLASSFILE_JDK = ANDROID_TOOLS === null ? null : await findClassFileJdk();

const ORACLE_INPUTS = (process.env.REA_DEX_ORACLE_INPUTS ?? "")
  .split(":")
  .filter((entry) => entry !== "");

const writeSources = async (
  root: string,
  sources: Readonly<Record<string, string>>,
): Promise<string[]> => {
  const paths: string[] = [];
  for (const [path, text] of Object.entries(sources)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text);
    paths.push(target);
  }
  return paths;
};

const classFilesUnder = async (root: string): Promise<string[]> =>
  (await readdir(root, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".class"))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();

const tools = () => {
  if (ANDROID_TOOLS === null)
    throw new Error("Android build-tools are missing.");
  return ANDROID_TOOLS;
};

const javac = async (
  sources: readonly string[],
  output: string,
): Promise<void> => {
  await mkdir(output, { recursive: true });
  await exec(join(tools().javaHome, "bin", "javac"), [
    "--release",
    "11",
    "-cp",
    tools().androidJar,
    "-d",
    output,
    ...sources,
  ]);
};

/** d8 the given class files into `output`/classes.dex and return its path. */
const d8 = async (
  output: string,
  classes: readonly string[],
  flags: readonly string[],
): Promise<string> => {
  await mkdir(output, { recursive: true });
  await exec(join(tools().buildTools, "d8"), [
    ...flags,
    "--lib",
    tools().androidJar,
    "--output",
    output,
    ...classes,
  ]);
  return join(output, "classes.dex");
};

interface Corpus {
  /** name -> DEX path */
  readonly inputs: ReadonlyMap<string, string>;
}

const buildCorpus = async (root: string): Promise<Corpus> => {
  const sources = join(root, "corpus-src");
  const classes = join(root, "corpus-classes");
  await javac(
    await writeSources(sources, {
      "org/oops/dalvik/Annotations.java": ANNOTATIONS,
      "org/oops/dalvik/Corpus.java": CORPUS,
      "org/oops/dalvik/Handles.java": HANDLES,
      "org/oops/dalvik/Registers.java": registersSource(),
      "org/oops/dalvik/Jump.java": jumpSource(),
      "org/oops/indy/Indy.java": INDY,
    }),
    classes,
  );
  const all = await classFilesUnder(join(classes, "org/oops/dalvik"));
  const handles = all.filter((path) => basename(path) === "Handles.class");
  const base = all.filter((path) => basename(path) !== "Handles.class");
  const inputs = new Map<string, string>();
  for (const [api, extra] of [
    ["21", ["--debug"]],
    ["24", ["--debug"]],
    ["26", ["--debug"]],
    ["28", ["--release"]],
  ] as const)
    inputs.set(
      `corpus (min API ${api}, ${extra[0]})`,
      await d8(
        join(root, `corpus-${api}`),
        Number(api) >= 26 ? [...base, ...handles] : base,
        ["--min-api", api, ...extra],
      ),
    );
  inputs.set(
    "invokedynamic kept (min API 26, --no-desugaring)",
    await d8(
      join(root, "indy"),
      await classFilesUnder(join(classes, "org/oops/indy")),
      ["--min-api", "26", "--no-desugaring"],
    ),
  );
  const jumbo = join(root, "jumbo-classes");
  await javac(
    await writeSources(join(root, "jumbo-src"), jumboSources()),
    jumbo,
  );
  inputs.set(
    "over 65536 strings (min API 26)",
    await d8(join(root, "jumbo"), await classFilesUnder(jumbo), [
      "--min-api",
      "26",
    ]),
  );
  if (CLASSFILE_JDK !== null) {
    const generator = join(root, "Gen.java");
    await writeFile(generator, CLASSFILE_GENERATOR);
    const generated = join(root, "consts-classes");
    await exec(
      join(CLASSFILE_JDK, "bin", "java"),
      [generator, generated],
      CLASSFILE_JDK,
    );
    inputs.set(
      "ldc MethodHandle/MethodType (min API 28)",
      await d8(join(root, "consts"), await classFilesUnder(generated), [
        "--min-api",
        "28",
      ]),
    );
  }
  return { inputs };
};

/** dexdump `-d -a` output without its `Processing`/`Opened` preamble. */
const dexdumpText = async (path: string, scratch: string): Promise<Buffer> => {
  const output = join(
    scratch,
    `${basename(path)}-${createHash("sha1").update(path).digest("hex").slice(0, 8)}.txt`,
  );
  await exec(join(tools().buildTools, "dexdump"), [
    "-d",
    "-a",
    "-o",
    output,
    path,
  ]);
  let text = await readFile(output);
  for (const prefix of ["Processing '", "Opened '"])
    if (text.subarray(0, prefix.length).toString("latin1") === prefix)
      text = text.subarray(text.indexOf(0x0a) + 1);
  return text;
};

const firstDifference = (
  expected: Buffer,
  actual: Buffer,
  label: string,
): string => {
  const left = expected.toString("latin1").split("\n");
  const right = actual.toString("latin1").split("\n");
  let line = 0;
  while (line < left.length && left[line] === right[line]) line += 1;
  const decode = (text: string | undefined) =>
    text === undefined
      ? "<end of output>"
      : Buffer.from(text, "latin1").toString("utf8");
  return [
    `${label}: first difference at line ${String(line + 1)}`,
    ...left
      .slice(Math.max(0, line - 3), line)
      .map((text) => `  same:     ${decode(text)}`),
    `  dexdump:  ${decode(left[line])}`,
    `  rendered: ${decode(right[line])}`,
  ].join("\n");
};

interface Compared {
  readonly classes: number;
  readonly methods: number;
  readonly instructions: number;
}

/** Compare the whole listing with dexdump's; throws with the first differing lines. */
const compareWithDexdump = async (
  path: string,
  scratch: string,
  label: string,
): Promise<Compared> => {
  const expected = await dexdumpText(path, scratch);
  const dex = DexFile.parse(await readFile(path));
  const actual = Buffer.from(
    encodeModifiedUtf8(renderDexdumpListing(dex, { annotations: true })),
  );
  if (!actual.equals(expected))
    throw new Error(firstDifference(expected, actual, label));
  const text = expected.toString("latin1");
  return {
    classes: dex.classCount,
    methods: text.match(/^[0-9a-f]{6}: {40}\|\[/gmu)?.length ?? 0,
    instructions:
      text.match(/^[0-9a-f]{6}:[ 0-9a-f.]{40}\|[0-9a-f]{4}: /gmu)?.length ?? 0,
  };
};

/** Every decoded method of a DEX file. */
const methodsOf = function* (dex: DexFile): Generator<{
  readonly name: string;
  readonly decoded: ReturnType<typeof decodeDalvik>;
}> {
  for (let index = 0; index < dex.classCount; index += 1) {
    const data = dex.classData(dex.classDef(index));
    for (const method of [
      ...(data?.direct_methods ?? []),
      ...(data?.virtual_methods ?? []),
    ]) {
      if (method.code_off === 0) continue;
      const id = dex.method(method.method_idx);
      yield {
        name: `${id?.class ?? "?"}.${id?.name ?? "?"}`,
        decoded: decodeDalvik(
          dex.codeUnits(dex.codeItem(method.code_off)),
          dex,
        ),
      };
    }
  }
};

let root: string | undefined;
let scratch = "";
let inputs = new Map<string, string>();
let rooting: Promise<string> | undefined;
let building: Promise<void> | undefined;

/** One temporary root per file, with the directory dexdump writes its listings to. */
const ensureRoot = async (): Promise<string> => {
  rooting ??= (async () => {
    const created = await realpath(
      await mkdtemp(join(await realpath(tmpdir()), "rea-dalvik-")),
    );
    root = created;
    scratch = join(created, "dexdump");
    await mkdir(scratch);
    return created;
  })();
  return rooting;
};

const useProducers = () =>
  beforeAll(async () => {
    building ??= (async () => {
      const base = await ensureRoot();
      const fixtures = await buildAndroidFixtures(join(base, "fixtures"));
      const corpus = await buildCorpus(join(base, "corpus"));
      inputs = new Map([
        ["F04 fixture classes.dex (min API 24)", fixtures.dex],
        ["F04 fixture library classes2.dex (min API 24)", fixtures.libraryDex],
        ...corpus.inputs,
      ]);
    })();
    await building;
  }, 300_000);

afterAll(async () => {
  if (root !== undefined) await removeTestWorkspace(root);
});

describe("Dalvik opcode table", () => {
  it("names all 256 opcodes with ART's formats, leaving 32 unused", () => {
    expect(DALVIK_OPCODES).toHaveLength(256);
    expect(
      DALVIK_OPCODES.filter((op) => op.unused).map((op) => op.name),
    ).toEqual([
      "unused-3e",
      "unused-3f",
      "unused-40",
      "unused-41",
      "unused-42",
      "unused-43",
      "unused-73",
      "unused-79",
      "unused-7a",
      ...Array.from(
        { length: 0xf9 - 0xe3 + 1 },
        (_, index) => `unused-${(0xe3 + index).toString(16)}`,
      ),
    ]);
    expect(
      DALVIK_OPCODES.filter((op) => op.index === "method_and_proto").map(
        (op) => op.name,
      ),
    ).toEqual(["invoke-polymorphic", "invoke-polymorphic/range"]);
  });
});

describe.skipIf(ANDROID_TOOLS === null)(
  "dexdump -d -a over real d8 output",
  () => {
    useProducers();

    it("prints every class, field, method, instruction, catch, position and local as dexdump does", async () => {
      const totals = { files: 0, classes: 0, methods: 0, instructions: 0 };
      const versions = new Set<string>();
      for (const [label, path] of inputs) {
        const counted = await compareWithDexdump(path, scratch, label);
        const dex = DexFile.parse(await readFile(path));
        expect(dex.problems, label).toEqual([]);
        for (const method of methodsOf(dex))
          expect(method.decoded.problems, `${label} ${method.name}`).toEqual(
            [],
          );
        versions.add(dex.header.magic_version);
        console.info(
          `${label}: ${String(counted.classes)} classes, ${String(counted.methods)} methods, ${String(counted.instructions)} instructions match dexdump`,
        );
        totals.files += 1;
        totals.classes += counted.classes;
        totals.methods += counted.methods;
        totals.instructions += counted.instructions;
      }
      expect([...versions].sort()).toEqual(["035", "037", "038", "039"]);
      expect(totals.instructions).toBeGreaterThan(100_000);
      console.info(
        `dexdump oracle: ${String(totals.files)} files, ${String(totals.classes)} classes, ${String(totals.methods)} methods, ${String(totals.instructions)} instructions`,
      );
    }, 300_000);

    it("meets every opcode javac + d8 can emit (all but the 32 unused ones)", async () => {
      const seen = new Set<string>();
      for (const path of inputs.values())
        for (const method of methodsOf(DexFile.parse(await readFile(path))))
          for (const instruction of method.decoded.instructions)
            seen.add(instruction.mnemonic);
      const missing = DALVIK_OPCODES.filter(
        (op) => !op.unused && !seen.has(op.name),
      ).map((op) => op.name);
      // Without a JDK 24+ there is no producer for const-method-handle/type here.
      expect(missing).toEqual(
        CLASSFILE_JDK === null
          ? ["const-method-handle", "const-method-type"]
          : [],
      );
      for (const payload of [
        "packed-switch-data",
        "sparse-switch-data",
        "array-data",
      ])
        expect(seen.has(payload), payload).toBe(true);
    }, 120_000);
  },
);

describe.skipIf(ANDROID_TOOLS === null || ORACLE_INPUTS.length === 0)(
  "dexdump -d -a over REA_DEX_ORACLE_INPUTS",
  () => {
    beforeAll(ensureRoot);

    it.each(ORACLE_INPUTS)(
      "matches dexdump for %s",
      async (path) => {
        const counted = await compareWithDexdump(path, scratch, path);
        for (const method of methodsOf(DexFile.parse(await readFile(path))))
          expect(method.decoded.problems, `${path} ${method.name}`).toEqual([]);
        console.info(
          `${path}: ${String(counted.classes)} classes, ${String(counted.methods)} methods, ${String(counted.instructions)} instructions match dexdump`,
        );
      },
      1_800_000,
    );
  },
);

/** Code units written as dexdump's raw columns show them: each pair is one unit's low then high byte. */
const code = (text: string): Uint16Array =>
  Uint16Array.from(text.trim().split(/\s+/u), (pair) =>
    Number.parseInt(`${pair.slice(2, 4)}${pair.slice(0, 2)}`, 16),
  );

const UNUSED = DALVIK_OPCODES.filter((op) => op.unused)
  .map((op) => `${hex2(op.code)}00`)
  .join(" ");

function hex2(value: number): string {
  return value.toString(16).padStart(2, "0");
}

/**
 * Hand-built code no local producer emits: the 32 unused opcodes, a nop and a
 * return-void with non-zero high bytes, out-of-range string/type/field/method/
 * proto indices, invoke-custom(/range) and const-method-handle/type with
 * arbitrary indices, empty and >65535 register lists, extreme literals,
 * backward branches of every width, switches with negative keys and offsets,
 * and array data of widths 8 and 1 (odd count, padded), one reached by a
 * negative fill-array-data offset. Addresses are in the comments.
 */
const HAND_BUILT = [
  UNUSED, // 0x00-0x1f
  "0012", // 0x20 nop, high byte 0x12
  "0e01", // 0x21 return-void, high byte 0x01
  "1a00 ffff", // 0x22
  "1b01 7856 3412", // 0x24
  "1f02 ffff", // 0x27
  "5221 ffff", // 0x29
  "6e20 ffff 2100", // 0x2b
  "6e55 0000 2143", // 0x2e
  "fa10 0000 0100 ffff", // 0x31
  "fb02 0000 0300 0000", // 0x35
  "fc10 0300 0000", // 0x39
  "fd00 0700 0000", // 0x3c
  "fe00 0700", // 0x3f
  "ff00 ffff", // 0x41
  "ff00 0000", // 0x43
  "2400 0000 0000", // 0x45
  "2500 0000 0000", // 0x48
  "7403 0000 feff", // 0x4b
  "1280", // 0x4e
  "1300 ffff", // 0x4f
  "1500 0080", // 0x51
  "1900 0080", // 0x53
  "1700 0000 c0ff", // 0x55
  "1800 0000 0000 0000 f0ff", // 0x58
  "1800 0100 0000 0000 0000", // 0x5d
  "d800 0180", // 0x62
  "d010 0080", // 0x64
  "28fe", // 0x66
  "2900 fdff", // 0x67
  "2a00 fbff ffff", // 0x69
  "3800 f8ff", // 0x6c
  "3210 f6ff", // 0x6e
  "2b00 0a00 0000", // 0x70 -> 0x7a
  "2c00 0f00 0000", // 0x73 -> 0x82
  "2600 1600 0000", // 0x76 -> 0x8c
  "0e00", // 0x79
  "0001 0200 0000 0080 0900 0000 f4ff ffff", // 0x7a keys -2^31, -2^31+1
  "0002 0200 ffff ffff 0700 0000 0600 0000 f1ff ffff", // 0x82 keys -1, 7
  "0003 0800 0100 0000 0100 0000 0000 0080", // 0x8c one long
  "0003 0100 0300 0000 0102 0300", // 0x94 three bytes
  "2600 faff ffff", // 0x9a -> 0x94
  "0e00", // 0x9d
].join(" ");

/** Rewrite one method's code units in a copy of `bytes` (nop-padded) and re-sign the file as d8 would. */
const patchMethodCode = (
  bytes: Uint8Array,
  insnsOffset: number,
  insnsSize: number,
  units: Uint16Array,
): Uint8Array => {
  const patched = Uint8Array.from(bytes);
  for (let index = 0; index < insnsSize; index += 1) {
    const unit = units[index] ?? 0;
    patched[insnsOffset + index * 2] = unit & 0xff;
    patched[insnsOffset + index * 2 + 1] = unit >> 8;
  }
  patched.set(createHash("sha1").update(patched.subarray(32)).digest(), 12);
  new DataView(patched.buffer).setUint32(
    8,
    adler32(patched.subarray(12)),
    true,
  );
  return patched;
};

const corpus = async () =>
  DexFile.parse(
    await readFile(inputs.get("corpus (min API 26, --debug)") ?? ""),
  );

describe.skipIf(ANDROID_TOOLS === null)("Dalvik code no producer emits", () => {
  useProducers();

  it("prints hand-built units exactly as dexdump prints them after patching them into a d8 method", async () => {
    const path = inputs.get("corpus (min API 26, --debug)") ?? "";
    const bytes = await readFile(path);
    const dex = DexFile.parse(bytes);
    const units = code(HAND_BUILT);
    let target: { offset: number; size: number } | null = null;
    for (let index = 0; index < dex.classCount && target === null; index += 1)
      for (const method of dex.classData(dex.classDef(index))?.direct_methods ??
        []) {
        if (method.code_off === 0) continue;
        const item = dex.codeItem(method.code_off);
        if (item.tries.length === 0 && item.insns_size >= units.length) {
          target = { offset: item.insns_offset, size: item.insns_size };
          break;
        }
      }
    if (target === null)
      throw new Error("No d8 method is long enough to patch.");
    const patchedPath = join(scratch, "patched.dex");
    await writeFile(
      patchedPath,
      patchMethodCode(bytes, target.offset, target.size, units),
    );
    await compareWithDexdump(patchedPath, scratch, "patched corpus");
    const padded = new Uint16Array(target.size);
    padded.set(units);
    const decoded = decodeDalvik(padded, dex);
    expect(decoded.problems).toEqual([]);
    expect(
      decoded.instructions.find((entry) => entry.address === 0x9a)?.target,
    ).toBe(0x94);
  });
});

describe.skipIf(ANDROID_TOOLS === null)(
  "Dalvik text rules for code no producer emits",
  () => {
    useProducers();

    it("renders opcodes and fallbacks no producer emits with dexdump's format rules", async () => {
      const dex = await corpus();
      const decoded = decodeDalvik(code(HAND_BUILT), dex);
      expect(decoded.problems).toEqual([]);
      const at = (address: number): DalvikInstruction => {
        const found = decoded.instructions.find(
          (entry) => entry.address === address,
        );
        if (found === undefined)
          throw new Error(`No instruction at ${String(address)}.`);
        return found;
      };
      const text = (address: number) =>
        `${at(address).mnemonic} ${at(address).operands}`.trimEnd();
      expect(
        decoded.instructions
          .slice(0, 32)
          .map((entry) => [entry.mnemonic, entry.operands, entry.units]),
      ).toEqual(
        DALVIK_OPCODES.filter((op) => op.unused).map((op) => [op.name, "", 1]),
      );
      expect(text(0x20)).toBe("nop // spacer");
      expect(text(0x21)).toBe("return-void");
      expect(text(0x22)).toBe("const-string v0, <string?> // string@ffff");
      expect(text(0x24)).toBe(
        "const-string/jumbo v1, <string?> // string@12345678",
      );
      expect(text(0x27)).toBe("check-cast v2, <type?> // type@ffff");
      expect(text(0x29)).toBe("iget v1, v2, <field?> // field@ffff");
      expect(text(0x2b)).toBe(
        "invoke-virtual {v1, v2}, <method?> // method@ffff",
      );
      expect(at(0x2e).registers).toEqual([1, 2, 3, 4, 5]);
      expect(text(0x31)).toBe(
        `invoke-polymorphic {v1}, ${at(0x31).reference?.text ?? ""}, <proto?> // method@0000, proto@ffff`,
      );
      expect(at(0x31).proto).toEqual({
        kind: "proto",
        index: 0xffff,
        text: null,
      });
      expect(at(0x35).registers).toEqual([3, 4]);
      expect(text(0x39)).toBe("invoke-custom {v0}, call_site@0003");
      expect(text(0x3c)).toBe("invoke-custom/range {}, call_site@0007");
      expect(at(0x3c).reference).toEqual({
        kind: "call_site",
        index: 7,
        text: null,
      });
      expect(text(0x3f)).toBe("const-method-handle v0, method_handle@0007");
      expect(text(0x41)).toBe("const-method-type v0, <?> // proto@ffff");
      expect(text(0x43)).toBe(
        `const-method-type v0, ${dex.protoDescriptor(0) ?? ""} // proto@0000`,
      );
      expect(text(0x45)).toBe(
        `filled-new-array {}, ${dex.type(0) ?? ""} // type@0000`,
      );
      expect(at(0x4b).operands).toMatch(/^\{v65534, v65535, v65536\}, /u);
      expect(text(0x4e)).toBe("const/4 v0, #int -8 // #f8");
      expect(text(0x4f)).toBe("const/16 v0, #int -1 // #ffff");
      expect(text(0x51)).toBe("const/high16 v0, #int -2147483648 // #8000");
      expect(text(0x53)).toBe(
        "const-wide/high16 v0, #long -9223372036854775808 // #8000",
      );
      expect(text(0x55)).toBe("const-wide/32 v0, #float nan // #ffc00000");
      expect(at(0x55).literal).toBe("-4194304");
      expect(text(0x58)).toBe(
        "const-wide v0, #double -inf // #fff0000000000000",
      );
      expect(at(0x58).literal).toBe("-4503599627370496");
      expect(text(0x5d)).toBe(
        "const-wide v0, #double 4.94066e-324 // #0000000000000001",
      );
      expect(text(0x62)).toBe("add-int/lit8 v0, v1, #int -128 // #80");
      expect(text(0x64)).toBe("add-int/lit16 v0, v1, #int -32768 // #8000");
      expect(text(0x66)).toBe("goto 0064 // -0002");
      expect(text(0x67)).toBe("goto/16 0064 // -0003");
      // dexdump prints goto/32's raw offset, not its target.
      expect(text(0x69)).toBe("goto/32 #fffffffb");
      expect(at(0x69).target).toBe(0x64);
      expect(text(0x6c)).toBe("if-eqz v0, 0064 // -0008");
      expect(text(0x6e)).toBe("if-eq v0, v1, 0064 // -000a");
      expect(text(0x70)).toBe("packed-switch v0, 0000007a // +0000000a");
      expect(at(0x70).switch_targets).toEqual([
        { key: -2147483648, target: 0x79 },
        { key: -2147483647, target: 0x64 },
      ]);
      expect(at(0x73).switch_targets).toEqual([
        { key: -1, target: 0x79 },
        { key: 7, target: 0x64 },
      ]);
      expect(at(0x76).array_data).toEqual({ element_width: 8, count: 1 });
      expect(text(0x7a)).toBe("packed-switch-data (8 units)");
      expect(text(0x82)).toBe("sparse-switch-data (10 units)");
      expect(text(0x8c)).toBe("array-data (8 units)");
      expect(at(0x94)).toMatchObject({
        opcode: 0x300,
        units: 6,
        array_data: { element_width: 1, count: 3 },
      });
      expect(text(0x9a)).toBe("fill-array-data v0, 00000094 // +fffffffa");
    });
  },
);

describe.skipIf(ANDROID_TOOLS === null)("malformed Dalvik code", () => {
  useProducers();

  it("stops at a truncated instruction or payload and keeps what came before", async () => {
    const dex = await corpus();
    const truncated = decodeDalvik(code("1200 6e20 0000"), dex);
    expect(truncated.instructions.map((entry) => entry.mnemonic)).toEqual([
      "const/4",
    ]);
    expect(truncated.problems).toEqual([
      {
        address: 1,
        message: "invoke-virtual at 0x0001 needs 3 code units; only 2 remain.",
      },
    ]);
    const pastEnd = decodeDalvik(code("0e00 0003 0400 0a00 0000"), dex);
    expect(pastEnd.instructions.map((entry) => entry.mnemonic)).toEqual([
      "return-void",
    ]);
    expect(pastEnd.problems).toEqual([
      {
        address: 1,
        message: "array-data at 0x0001 declares 24 code units; only 4 remain.",
      },
    ]);
    const header = decodeDalvik(code("0e00 0002"), dex);
    expect(header.problems).toEqual([
      {
        address: 1,
        message:
          "sparse-switch-data at 0x0001 needs a 2-unit header; only 1 remain.",
      },
    ]);
    const packed = decodeDalvik(
      code("0e00 0001 0300 0000 0000 0100 0000"),
      dex,
    );
    expect(packed.problems).toEqual([
      {
        address: 1,
        message:
          "packed-switch-data at 0x0001 declares 10 code units; only 6 remain.",
      },
    ]);
  });

  it("reports payloads and targets that do not fit without losing the instructions", async () => {
    const dex = await corpus();
    const width = decodeDalvik(
      code("2600 0400 0000 0e00 0003 0300 0200 0000 0102 0304 0506"),
      dex,
    );
    expect(width.instructions.map((entry) => entry.mnemonic)).toEqual([
      "fill-array-data",
      "return-void",
      "array-data",
    ]);
    expect(width.instructions[0]?.array_data).toEqual({
      element_width: 3,
      count: 2,
    });
    expect(width.problems).toEqual([
      {
        address: 4,
        message:
          "array-data at 0x0004 has element width 3; the format allows 1, 2, 4 or 8.",
      },
    ]);
    const noPayload = decodeDalvik(code("2b00 0300 0000 0e00"), dex);
    expect(noPayload.instructions[0]?.switch_targets).toBeNull();
    expect(noPayload.problems).toEqual([
      {
        address: 0,
        message:
          "packed-switch at 0x0000 points to 0x0003, which holds no packed-switch-data.",
      },
    ]);
    const branches = decodeDalvik(code("287f 1300 0100 28ff 0e00"), dex);
    expect(branches.problems).toEqual([
      {
        address: 0,
        message: "goto at 0x0000 jumps to 0x007f, which is outside the code.",
      },
      {
        address: 3,
        message:
          "goto at 0x0003 jumps to 0x0002, which is not an instruction start.",
      },
    ]);
    const six = decodeDalvik(code("6e60 0000 2143"), dex);
    expect(six.instructions[0]?.registers).toEqual([1, 2, 3, 4, 0]);
    expect(six.problems).toEqual([
      {
        address: 0,
        message: "invoke-virtual names 6 argument registers; at most 5 fit.",
      },
    ]);
  });
});

describe.skipIf(ANDROID_TOOLS === null)("Dalvik references", () => {
  useProducers();

  it("sorts references by use and resolves their text", async () => {
    const references = {
      invocations: new Set<string>(),
      fields: new Set<string>(),
      types: new Set<string>(),
      other: new Set<string>(),
      strings: 0,
    };
    for (const path of inputs.values())
      for (const method of methodsOf(DexFile.parse(await readFile(path)))) {
        const found = method.decoded.references;
        for (const entry of found.invocations) {
          references.invocations.add(entry.kind);
          expect(entry.reference.text, method.name).not.toBeNull();
        }
        for (const entry of found.field_accesses)
          references.fields.add(
            `${entry.static ? "static" : "instance"} ${entry.access}`,
          );
        for (const entry of found.types) references.types.add(entry.use);
        for (const entry of found.other)
          references.other.add(entry.reference.kind);
        references.strings += found.strings.length;
        for (const instruction of method.decoded.instructions)
          if (
            instruction.reference?.kind === "field" ||
            instruction.reference?.kind === "method"
          )
            expect(instruction.operands).toContain(
              instruction.reference.text ?? "<missing>",
            );
      }
    expect([...references.invocations].sort()).toEqual([
      "custom",
      "direct",
      "interface",
      "polymorphic",
      "static",
      "super",
      "virtual",
    ]);
    expect([...references.fields].sort()).toEqual([
      "instance read",
      "instance write",
      "static read",
      "static write",
    ]);
    expect([...references.types].sort()).toEqual([
      "check-cast",
      "const-class",
      "filled-new-array",
      "instance-of",
      "new-array",
      "new-instance",
    ]);
    expect([...references.other].sort()).toEqual(
      CLASSFILE_JDK === null ? ["proto"] : ["method_handle", "proto"],
    );
    expect(references.strings).toBeGreaterThan(60_000);
  }, 120_000);
});

describe("dexdump's text helpers", () => {
  it("names access flags per kind, '?' for unnamed bits, and ignores bits above 17", () => {
    expect(dexAccessFlagsText(0x3601, "class")).toBe(
      "0x3601 (PUBLIC INTERFACE ABSTRACT SYNTHETIC ANNOTATION)",
    );
    expect(dexAccessFlagsText(0x10001, "method")).toBe(
      "0x10001 (PUBLIC CONSTRUCTOR)",
    );
    expect(dexAccessFlagsText(0, "field")).toBe("0x0000 ()");
    expect(dexAccessFlags(0x40020, "class")).toEqual(["?"]);
    expect(dexAccessFlags(0x20020, "method")).toEqual([
      "SYNCHRONIZED",
      "DECLARED_SYNCHRONIZED",
    ]);
    expect(dexAccessFlags(0x40c0, "field")).toEqual([
      "VOLATILE",
      "TRANSIENT",
      "ENUM",
    ]);
  });

  it("formats %g as macOS printf does, rounding the exact value half to even", () => {
    // Each expectation was printed by Apple's printf("%g"), dexdump's own formatter on macOS.
    expect(
      [
        12345.25,
        100000.5,
        1234565,
        999999.5,
        0.0001,
        1e-5,
        5e-324,
        -0,
        Number.NaN,
        -Infinity,
        1e100,
        2.5,
        123456.5,
      ].map(printfG),
    ).toEqual([
      "12345.2",
      "100000",
      "1.23456e+06",
      "1e+06",
      "0.0001",
      "1e-05",
      "4.94066e-324",
      "-0",
      "nan",
      "-inf",
      "1e+100",
      "2.5",
      "123456",
    ]);
  });

  it("escapes strings as dexdump's escapeString does", () => {
    expect(escapeDexString('\u0001\u007f"\\\t\n\r\b\f\u000bé\u0000x')).toBe(
      '\\001\\177\\"\\\\\\t\\n\\r\\b\\f\\013é\u0000x',
    );
  });
});
