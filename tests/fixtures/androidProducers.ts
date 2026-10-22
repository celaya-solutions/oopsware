import { execFile } from "node:child_process";
import {
  access,
  constants,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { deflateSync, crc32 } from "node:zlib";

import {
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipReader,
  ZipWriter,
} from "@zip.js/zip.js";

const run = promisify(execFile);

/**
 * Real Android producers for F04 fixtures. DEX files come from javac + d8,
 * resources and manifests from aapt2 (binary and proto formats), native
 * libraries from clang + the SDK's lld, bundles and split APK sets from
 * bundletool, and APK signatures from zipalign + apksigner. Nothing binary is
 * committed; the producers run at test time and nothing is installed or run
 * on a device.
 */
export interface AndroidTools {
  readonly sdk: string;
  readonly buildTools: string;
  readonly androidJar: string;
  readonly bundletool: string;
  readonly javaHome: string;
  readonly clang: string;
}

const executable = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const readable = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
};

/** Build-tools and platform this family was checked with; others are not guessed. */
export const ANDROID_BUILD_TOOLS = "37.0.0";
export const ANDROID_PLATFORM = "android-36";

const findTools = async (): Promise<AndroidTools | null> => {
  const sdks = [
    process.env.REA_TEST_ANDROID_SDK,
    "/opt/homebrew/share/android-commandlinetools",
    join(process.env.HOME ?? "/nonexistent", "Library/Android/sdk"),
  ];
  let sdk: string | null = null;
  for (const candidate of sdks) {
    if (candidate === undefined || candidate === "") continue;
    const buildTools = join(candidate, "build-tools", ANDROID_BUILD_TOOLS);
    const ready = await Promise.all(
      ["aapt2", "d8", "zipalign", "apksigner", "dexdump"].map((name) =>
        executable(join(buildTools, name)),
      ),
    );
    if (
      ready.every(Boolean) &&
      (await readable(
        join(candidate, "platforms", ANDROID_PLATFORM, "android.jar"),
      ))
    ) {
      sdk = candidate;
      break;
    }
  }
  if (sdk === null) return null;
  const bundletools = [
    process.env.REA_TEST_BUNDLETOOL_JAR,
    "/opt/homebrew/opt/bundletool/libexec/bundletool-all.jar",
  ];
  let bundletool: string | null = null;
  for (const candidate of bundletools)
    if (
      candidate !== undefined &&
      candidate !== "" &&
      (await readable(candidate))
    ) {
      bundletool = candidate;
      break;
    }
  if (bundletool === null) return null;
  let javaHome: string | null = null;
  const homes = [process.env.REA_TEST_JDK_HOME, "/opt/homebrew/opt/openjdk@21"];
  if (process.platform === "darwin")
    try {
      homes.push(
        (await run("/usr/libexec/java_home", ["-v", "17+"])).stdout.trim(),
      );
    } catch {
      // No registered JDK.
    }
  for (const home of homes)
    if (
      home !== undefined &&
      home !== "" &&
      (await executable(join(home, "bin", "javac"))) &&
      (await executable(join(home, "bin", "keytool")))
    ) {
      javaHome = home;
      break;
    }
  if (javaHome === null) return null;
  const clang = ["/usr/bin/clang", "/opt/homebrew/opt/llvm/bin/clang"];
  let compiler: string | null = null;
  for (const candidate of clang)
    if (await executable(candidate)) {
      compiler = candidate;
      break;
    }
  if (compiler === null) return null;
  return {
    sdk,
    buildTools: join(sdk, "build-tools", ANDROID_BUILD_TOOLS),
    androidJar: join(sdk, "platforms", ANDROID_PLATFORM, "android.jar"),
    bundletool,
    javaHome,
    clang: compiler,
  };
};

export const ANDROID_TOOLS = await findTools();

const tools = (): AndroidTools => {
  if (ANDROID_TOOLS === null)
    throw new Error(
      `Android fixtures need build-tools ${ANDROID_BUILD_TOOLS}, ${ANDROID_PLATFORM}, bundletool, a JDK 17+ and clang.`,
    );
  return ANDROID_TOOLS;
};

const environment = (): NodeJS.ProcessEnv => ({
  PATH: `${join(tools().javaHome, "bin")}:/usr/bin:/bin`,
  JAVA_HOME: tools().javaHome,
  HOME: process.env.HOME ?? "/tmp",
});

const exec = async (
  command: string,
  args: readonly string[],
  cwd?: string,
): Promise<string> => {
  const { stdout } = await run(command, [...args], {
    cwd,
    env: environment(),
    maxBuffer: 256 * 1024 ** 2,
  });
  return stdout;
};

const buildTool = (name: string) => join(tools().buildTools, name);
const javac = () => join(tools().javaHome, "bin", "javac");
const java = () => join(tools().javaHome, "bin", "java");

/** A PNG with one pixel of the given colour. */
const onePixelPng = (rgb: readonly [number, number, number]): Buffer => {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([head, body, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from([0, ...rgb]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};

export const PACKAGE_NAME = "com.example.oops";
export const VERSION_CODE = 7;
export const VERSION_NAME = "1.2.3";
export const MIN_SDK = 24;
export const TARGET_SDK = 36;
export const ABIS = ["arm64-v8a", "x86_64"] as const;

const BASE_MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:dist="http://schemas.android.com/apk/distribution"
    package="${PACKAGE_NAME}">
  <uses-permission android:name="android.permission.INTERNET" />
  <uses-permission android:name="android.permission.CAMERA" />
  <uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />
  <uses-feature android:name="android.hardware.camera" android:required="false" />
  <application android:label="@string/app_name" android:allowBackup="false" android:usesCleartextTraffic="true" android:extractNativeLibs="false">
    <activity android:name=".MainActivity" android:exported="true">
      <intent-filter>
        <action android:name="android.intent.action.MAIN" />
        <category android:name="android.intent.category.LAUNCHER" />
      </intent-filter>
      <intent-filter>
        <action android:name="android.intent.action.VIEW" />
        <category android:name="android.intent.category.DEFAULT" />
        <category android:name="android.intent.category.BROWSABLE" />
        <data android:scheme="https" android:host="oops.example.com" />
      </intent-filter>
    </activity>
    <service android:name=".SyncService" android:exported="false" />
    <receiver android:name=".BootReceiver" android:exported="true" android:permission="android.permission.RECEIVE_BOOT_COMPLETED">
      <intent-filter><action android:name="android.intent.action.BOOT_COMPLETED" /></intent-filter>
    </receiver>
    <provider android:name=".DataProvider" android:authorities="${PACKAGE_NAME}.data" android:exported="false" />
    <meta-data android:name="oops.flavor" android:value="demo" />
  </application>
</manifest>
`;

const FEATURE_MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:dist="http://schemas.android.com/apk/distribution"
    package="${PACKAGE_NAME}" split="camera">
  <dist:module dist:title="@string/camera_title">
    <dist:delivery><dist:on-demand /></dist:delivery>
    <dist:fusing dist:include="true" />
  </dist:module>
  <application android:hasCode="true">
    <activity android:name=".camera.CameraActivity" android:exported="false" />
  </application>
</manifest>
`;

const BASE_SOURCES: Readonly<Record<string, string>> = {
  "com/example/oops/MainActivity.java": `package com.example.oops;
import android.app.Activity;
import android.os.Bundle;
public class MainActivity extends Activity {
  static { System.loadLibrary("native"); }
  static native int oopsAnswer();
  @Override protected void onCreate(Bundle state) {
    super.onCreate(state);
    setContentView(R.layout.main);
    setTitle(getString(R.string.app_name) + " " + oopsAnswer());
  }
}
`,
  "com/example/oops/SyncService.java": `package com.example.oops;
import android.app.Service; import android.content.Intent; import android.os.IBinder;
public class SyncService extends Service { @Override public IBinder onBind(Intent i) { return null; } }
`,
  "com/example/oops/BootReceiver.java": `package com.example.oops;
import android.content.BroadcastReceiver; import android.content.Context; import android.content.Intent;
public class BootReceiver extends BroadcastReceiver {
  @Override public void onReceive(Context c, Intent i) { c.startService(new Intent(c, SyncService.class)); }
}
`,
  "com/example/oops/DataProvider.java": `package com.example.oops;
import android.content.ContentProvider; import android.content.ContentValues; import android.database.Cursor; import android.net.Uri;
public class DataProvider extends ContentProvider {
  @Override public boolean onCreate() { return true; }
  @Override public Cursor query(Uri u, String[] p, String s, String[] a, String o) { return null; }
  @Override public String getType(Uri u) { return "text/plain"; }
  @Override public Uri insert(Uri u, ContentValues v) { return null; }
  @Override public int delete(Uri u, String s, String[] a) { return 0; }
  @Override public int update(Uri u, ContentValues v, String s, String[] a) { return 0; }
}
`,
};

/** A separately dexed library, as a non-merging debug build places it in classes2.dex. */
const LIBRARY_SOURCES: Readonly<Record<string, string>> = {
  "org/oops/lib/Codes.java": `package org.oops.lib;
public final class Codes {
  public static final String NAME = "codes";
  private static int calls = 0;
  private final long seed;
  public Codes(long seed) { this.seed = seed; }
  public static int classify(int k) {
    switch (k) { case 0: return 10; case 1: return 20; case 2: return 30; case 3: return 40; default: return -1; }
  }
  public static int sparse(int k) {
    switch (k) { case 7: return 1; case 700: return 2; case 70000: return 3; default: return 0; }
  }
  public int[] table() { return new int[] { 1, 2, 3, 5, 8, 13 }; }
  public static int pick(int k) { return k * 3; }
  public static int pick(String s) { return s.length(); }
  public double mix(int a, float b) {
    calls++;
    try { return a / (b - 1.5f) + seed * 0.25 + (1L << 40); }
    catch (ArithmeticException e) { return Double.NaN; }
  }
  public synchronized String describe(Object o) {
    if (o instanceof CharSequence) return ((CharSequence) o).toString();
    Runnable r = () -> calls--;
    r.run();
    return String.valueOf(o) + NAME;
  }
}
`,
};

const FEATURE_SOURCES: Readonly<Record<string, string>> = {
  "com/example/oops/camera/CameraActivity.java": `package com.example.oops.camera;
import android.app.Activity;
public class CameraActivity extends Activity { public int shots() { return 3; } }
`,
};

const writeTree = async (
  root: string,
  files: Readonly<Record<string, string | Uint8Array>>,
): Promise<string[]> => {
  const paths: string[] = [];
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
    paths.push(target);
  }
  return paths;
};

const filesUnder = async (root: string): Promise<string[]> => {
  const found: string[] = [];
  for (const entry of await readdir(root, {
    withFileTypes: true,
    recursive: true,
  }))
    if (entry.isFile()) found.push(join(entry.parentPath, entry.name));
  return found.sort();
};

/** Compile Java against android.jar and dex the classes with d8. */
const dex = async (
  root: string,
  name: string,
  sources: Readonly<Record<string, string>>,
  classpath: readonly string[] = [],
): Promise<{ classes: string; dex: Uint8Array }> => {
  const sourceRoot = join(root, `${name}-src`);
  const classes = join(root, `${name}-classes`);
  const out = join(root, `${name}-dex`);
  await mkdir(classes, { recursive: true });
  await mkdir(out, { recursive: true });
  const files = await writeTree(sourceRoot, sources);
  await exec(javac(), [
    "--release",
    "11",
    "-cp",
    [tools().androidJar, ...classpath].join(":"),
    "-d",
    classes,
    ...files,
  ]);
  await exec(buildTool("d8"), [
    "--min-api",
    String(MIN_SDK),
    "--lib",
    tools().androidJar,
    ...classpath.flatMap((entry) => ["--classpath", entry]),
    "--output",
    out,
    ...(await filesUnder(classes)),
  ]);
  return { classes, dex: await readFile(join(out, "classes.dex")) };
};

const nativeLibrary = async (
  root: string,
  abi: (typeof ABIS)[number],
): Promise<Uint8Array> => {
  const target =
    abi === "arm64-v8a" ? "aarch64-linux-android24" : "x86_64-linux-android24";
  const directory = join(root, "native", abi);
  await mkdir(directory, { recursive: true });
  const source = join(directory, "native.c");
  await writeFile(source, "int oops_answer(void) { return 42; }\n");
  await exec(tools().clang, [
    "-target",
    target,
    "-fPIC",
    "-c",
    source,
    "-o",
    join(directory, "native.o"),
  ]);
  await exec(join(tools().buildTools, "lld"), [
    "-flavor",
    "gnu",
    "-shared",
    "-soname",
    "libnative.so",
    "-o",
    join(directory, "libnative.so"),
    join(directory, "native.o"),
  ]);
  return readFile(join(directory, "libnative.so"));
};

const readZip = async (path: string): Promise<Map<string, Uint8Array>> => {
  const reader = new ZipReader(new Uint8ArrayReader(await readFile(path)));
  const members = new Map<string, Uint8Array>();
  for (const entry of await reader.getEntries())
    if (!entry.directory)
      members.set(entry.filename, await entry.getData(new Uint8ArrayWriter()));
  await reader.close();
  return members;
};

/** Write members in the given order, stored (aapt2 and zipalign expect uncompressed resources). */
export const writeZip = async (
  path: string,
  members: Iterable<readonly [string, Uint8Array]>,
  level = 0,
): Promise<void> => {
  const writer = new ZipWriter(new Uint8ArrayWriter(), {
    level,
    useWebWorkers: false,
  });
  for (const [name, bytes] of members)
    await writer.add(name, new Uint8ArrayReader(bytes), {
      level,
      lastModDate: new Date(Date.UTC(2026, 0, 1)),
    });
  await writeFile(path, await writer.close());
};

export interface AndroidFixtures {
  /** Signed (v1, v2, v3) APK with classes.dex, classes2.dex, two ABIs and assets. */
  readonly apk: string;
  /** Bundle with the base module and the on-demand `camera` feature module. */
  readonly aab: string;
  /** bundletool's split APK set for `aab`, signed with the same key. */
  readonly apks: string;
  /** d8's base classes.dex (DEX 037 for min API 24). */
  readonly dex: string;
  /** d8's separately dexed library, placed in the APK as classes2.dex. */
  readonly libraryDex: string;
  /** The base module's binary-format resources.arsc as aapt2 wrote it. */
  readonly arsc: string;
  /** The keystore and alias that signed `apk` and `apks`. */
  readonly keystore: {
    readonly path: string;
    readonly alias: string;
    readonly password: string;
  };
}

const VERSION_FLAGS = [
  "--min-sdk-version",
  String(MIN_SDK),
  "--target-sdk-version",
  String(TARGET_SDK),
  "--version-code",
  String(VERSION_CODE),
  "--version-name",
  VERSION_NAME,
];

interface Linked {
  /** Binary-format APK (manifest + resources.arsc) for the standalone APK. */
  readonly binary: string;
  /** Proto-format base and feature modules for the bundle. */
  readonly proto: string;
  readonly featureProto: string;
  /** aapt2's generated R.java for the base package. */
  readonly rJava: string;
}

/** Compile resources and link the base (binary and proto) and feature manifests with aapt2. */
const linkResources = async (root: string): Promise<Linked> => {
  const aapt2 = buildTool("aapt2");
  const base = join(root, "base");
  await writeTree(base, {
    "AndroidManifest.xml": BASE_MANIFEST,
    "res/values/strings.xml":
      '<resources><string name="app_name">Oops Demo</string><string name="camera_title">Camera</string></resources>\n',
    "res/values-es/strings.xml":
      '<resources><string name="app_name">Oops Demostración</string></resources>\n',
    "res/layout/main.xml":
      '<?xml version="1.0" encoding="utf-8"?>\n<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android" android:layout_width="match_parent" android:layout_height="match_parent" android:orientation="vertical"><TextView android:id="@+id/title" android:layout_width="wrap_content" android:layout_height="wrap_content" android:text="@string/app_name" /></LinearLayout>\n',
    "res/drawable-hdpi/dot.png": onePixelPng([255, 0, 0]),
    "res/drawable-xxhdpi/dot.png": onePixelPng([0, 0, 255]),
  });
  const feature = join(root, "feature");
  await writeTree(feature, { "AndroidManifest.xml": FEATURE_MANIFEST });
  const compiled = join(root, "base-res.zip");
  await exec(aapt2, ["compile", "--dir", join(base, "res"), "-o", compiled]);
  const generated = join(root, "gen");
  const linked = {
    binary: join(root, "base-binary.apk"),
    proto: join(root, "base-proto.zip"),
    featureProto: join(root, "feature-proto.zip"),
  };
  const manifest = ["--manifest", join(base, "AndroidManifest.xml")];
  const resources = ["-R", compiled, "--auto-add-overlay", ...VERSION_FLAGS];
  await exec(aapt2, [
    "link",
    "-o",
    linked.binary,
    "-I",
    tools().androidJar,
    ...manifest,
    "--java",
    generated,
    ...resources,
  ]);
  await exec(aapt2, [
    "link",
    "--proto-format",
    "-o",
    linked.proto,
    "-I",
    tools().androidJar,
    ...manifest,
    ...resources,
  ]);
  // The feature manifest's title refers to a base string, so the base APK is an input.
  await exec(aapt2, [
    "link",
    "--proto-format",
    "-o",
    linked.featureProto,
    "-I",
    tools().androidJar,
    "-I",
    linked.binary,
    "--manifest",
    join(feature, "AndroidManifest.xml"),
    ...VERSION_FLAGS,
  ]);
  return {
    ...linked,
    rJava: await readFile(join(generated, "com/example/oops/R.java"), "utf8"),
  };
};

interface Code {
  readonly app: Awaited<ReturnType<typeof dex>>;
  readonly library: Awaited<ReturnType<typeof dex>>;
  readonly camera: Awaited<ReturnType<typeof dex>>;
  readonly natives: Map<string, Uint8Array>;
}

const buildCode = async (root: string, rJava: string): Promise<Code> => {
  const app = await dex(root, "app", {
    ...BASE_SOURCES,
    "com/example/oops/R.java": rJava,
  });
  const library = await dex(root, "library", LIBRARY_SOURCES);
  const camera = await dex(root, "camera", FEATURE_SOURCES, [app.classes]);
  const natives = new Map<string, Uint8Array>();
  for (const abi of ABIS) natives.set(abi, await nativeLibrary(root, abi));
  return { app, library, camera, natives };
};

const README = Buffer.from("hello from assets\n");

/** Members every APK of the fixture carries besides aapt2's output. */
const codeMembers = (
  code: Code,
  dexDirectory: string,
): (readonly [string, Uint8Array])[] => [
  [`${dexDirectory}classes.dex`, code.app.dex],
  [`${dexDirectory}classes2.dex`, code.library.dex],
  ["assets/readme.txt", README],
  ...ABIS.map(
    (abi) =>
      [
        `lib/${abi}/libnative.so`,
        code.natives.get(abi) ?? new Uint8Array(),
      ] as const,
  ),
];

/** Assemble bundletool modules, build the bundle and its signed split APK set. */
const buildBundle = async (
  root: string,
  linked: Linked,
  code: Code,
  keystore: AndroidFixtures["keystore"],
): Promise<{ aab: string; apks: string }> => {
  const baseModule = await readZip(linked.proto);
  const baseZip = join(root, "base.zip");
  await writeZip(baseZip, [
    [
      "manifest/AndroidManifest.xml",
      baseModule.get("AndroidManifest.xml") ?? new Uint8Array(),
    ],
    ...[...baseModule].filter(([name]) => name !== "AndroidManifest.xml"),
    ...codeMembers(code, "dex/"),
  ]);
  const featureModule = await readZip(linked.featureProto);
  const cameraZip = join(root, "camera.zip");
  await writeZip(cameraZip, [
    [
      "manifest/AndroidManifest.xml",
      featureModule.get("AndroidManifest.xml") ?? new Uint8Array(),
    ],
    ...[...featureModule].filter(([name]) => name !== "AndroidManifest.xml"),
    ["dex/classes.dex", code.camera.dex],
  ]);
  const bundletool = ["-jar", tools().bundletool];
  const aab = join(root, "app.aab");
  await exec(java(), [
    ...bundletool,
    "build-bundle",
    `--modules=${baseZip},${cameraZip}`,
    `--output=${aab}`,
  ]);
  const apks = join(root, "app.apks");
  await exec(java(), [
    ...bundletool,
    "build-apks",
    `--bundle=${aab}`,
    `--output=${apks}`,
    `--aapt2=${buildTool("aapt2")}`,
    `--ks=${keystore.path}`,
    `--ks-pass=pass:${keystore.password}`,
    `--ks-key-alias=${keystore.alias}`,
    `--key-pass=pass:${keystore.password}`,
  ]);
  return { aab, apks };
};

/** Standalone APK: aapt2's binary output plus code, aligned and signed v1-v3. */
const buildApk = async (
  root: string,
  binaryMembers: Map<string, Uint8Array>,
  code: Code,
  keystore: AndroidFixtures["keystore"],
): Promise<string> => {
  const unaligned = join(root, "unaligned.apk");
  await writeZip(unaligned, [...binaryMembers, ...codeMembers(code, "")]);
  const aligned = join(root, "aligned.apk");
  await exec(buildTool("zipalign"), [
    "-P",
    "16",
    "-f",
    "4",
    unaligned,
    aligned,
  ]);
  const apk = join(root, "app.apk");
  const password = `pass:${keystore.password}`;
  await exec(buildTool("apksigner"), [
    "sign",
    "--ks",
    keystore.path,
    "--ks-pass",
    password,
    "--key-pass",
    password,
    "--ks-key-alias",
    keystore.alias,
    "--v1-signing-enabled",
    "true",
    "--v2-signing-enabled",
    "true",
    "--v3-signing-enabled",
    "true",
    "--out",
    apk,
    aligned,
  ]);
  return apk;
};

const createKeystore = async (
  root: string,
): Promise<AndroidFixtures["keystore"]> => {
  const keystore = {
    path: join(root, "oops.jks"),
    alias: "oops",
    password: "oopspass",
  };
  await exec(join(tools().javaHome, "bin", "keytool"), [
    "-genkeypair",
    "-keystore",
    keystore.path,
    "-storepass",
    keystore.password,
    "-keypass",
    keystore.password,
    "-alias",
    keystore.alias,
    "-keyalg",
    "RSA",
    "-keysize",
    "2048",
    "-validity",
    "3650",
    "-dname",
    "CN=Oops Fixture",
  ]);
  return keystore;
};

/** Build the APK, bundle, split set and DEX fixtures under `root`. */
export const buildAndroidFixtures = async (
  root: string,
): Promise<AndroidFixtures> => {
  const linked = await linkResources(root);
  const code = await buildCode(root, linked.rJava);
  const keystore = await createKeystore(root);
  const { aab, apks } = await buildBundle(root, linked, code, keystore);
  const binaryMembers = await readZip(linked.binary);
  const apk = await buildApk(root, binaryMembers, code, keystore);
  const dexPath = join(root, "classes.dex");
  await writeFile(dexPath, code.app.dex);
  const libraryDex = join(root, "library.dex");
  await writeFile(libraryDex, code.library.dex);
  const arsc = join(root, "resources.arsc");
  await writeFile(
    arsc,
    binaryMembers.get("resources.arsc") ?? new Uint8Array(),
  );
  return { apk, aab, apks, dex: dexPath, libraryDex, arsc, keystore };
};

/** dexdump's text for one DEX file (`-d` disassembly with headers), the instruction oracle. */
export const dexdump = async (
  path: string,
  flags: readonly string[] = ["-d"],
): Promise<string> => exec(buildTool("dexdump"), [...flags, path]);

/** aapt2's own dump (`xmltree`, `resources`, `badging`) of an APK member, the XML and table oracle. */
export const aapt2Dump = async (
  kind: "xmltree" | "resources" | "badging",
  apk: string,
  file?: string,
): Promise<string> =>
  exec(buildTool("aapt2"), [
    "dump",
    kind,
    ...(file === undefined ? [] : ["--file", file]),
    apk,
  ]);

/** The relative member paths of every file under `root`, for assertions. */
export const relativeFiles = async (root: string): Promise<string[]> =>
  (await filesUnder(root)).map((path) => relative(root, path));
