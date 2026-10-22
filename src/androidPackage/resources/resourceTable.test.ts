import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from "@zip.js/zip.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ANDROID_TOOLS,
  aapt2Dump,
  buildAndroidFixtures,
  writeZip,
  type AndroidFixtures,
} from "../../../tests/fixtures/androidProducers.js";
import { removeTestWorkspace } from "../../../tests/support/workspace/workspaceFixture.js";
import { u16, u32 } from "../xml/binaryXml.js";
import {
  ResourceTableFormatError,
  readArscTable,
  readProtoTable,
  type ResourceTable,
} from "./resourceTable.js";

const run = promisify(execFile);

const zipMembers = async (path: string): Promise<Map<string, Uint8Array>> => {
  const reader = new ZipReader(new Uint8ArrayReader(await readFile(path)));
  const members = new Map<string, Uint8Array>();
  for (const entry of await reader.getEntries())
    if (!entry.directory)
      members.set(entry.filename, await entry.getData(new Uint8ArrayWriter()));
  await reader.close();
  return members;
};

const member = (members: Map<string, Uint8Array>, name: string): Uint8Array => {
  const bytes = members.get(name);
  if (bytes === undefined) throw new Error(`${name} is missing`);
  return bytes;
};

// ---- `aapt2 dump resources` as data ----

interface DumpEntry {
  readonly id: number;
  readonly type: string;
  readonly name: string;
  readonly values: { config: string; text: string }[];
}
interface DumpPackage {
  readonly id: number;
  readonly name: string;
  readonly types: { id: number; name: string; entry_count: number }[];
  readonly entries: DumpEntry[];
}

/**
 * Values sit 6 spaces deep; a multi-line string continues at the same depth
 * without a leading "(". Proto dumps add " src=…" and "(featureFlag=) ",
 * which are not part of the value.
 */
const parseResourcesDump = (text: string): DumpPackage[] => {
  const packages: DumpPackage[] = [];
  let entry: DumpEntry | undefined;
  for (const line of text.split("\n")) {
    const body = line.trimStart();
    const value = line.length - body.length === 6;
    const owner = packages.at(-1);
    const pkg = /^Package name=(\S*) id=([0-9a-f]+)$/u.exec(body);
    const type = /^type (\S+) id=([0-9a-f]+) entryCount=(\d+)$/u.exec(body);
    const resource = /^resource (0x[0-9a-f]{8}) ([^/\s]+)\/(\S+)/u.exec(body);
    const config = value ? /^\(([^)]*)\) (.*)$/su.exec(body) : null;
    if (pkg !== null)
      packages.push({
        name: pkg[1] ?? "",
        id: Number.parseInt(pkg[2] ?? "", 16),
        types: [],
        entries: [],
      });
    else if (type !== null)
      owner?.types.push({
        name: type[1] ?? "",
        id: Number.parseInt(type[2] ?? "", 16),
        entry_count: Number(type[3]),
      });
    else if (resource !== null) {
      entry = {
        id: Number.parseInt(resource[1] ?? "", 16),
        type: resource[2] ?? "",
        name: resource[3] ?? "",
        values: [],
      };
      owner?.entries.push(entry);
    } else if (config !== null)
      entry?.values.push({ config: config[1] ?? "", text: config[2] ?? "" });
    else if (value) {
      const last = entry?.values.at(-1);
      if (last !== undefined) last.text += `\n${body}`;
    }
  }
  for (const found of packages.flatMap((owner) => owner.entries))
    for (const item of found.values)
      item.text = item.text
        .replace(/^\(featureFlag=[^)]*\) /u, "")
        .replace(/ src=\S*$/u, "");
  return packages;
};

/**
 * aapt2's dump reads a complex mantissa as unsigned, so the rich table's
 * -4.5sp prints as 507.500000sp; the runtime and this reader read it signed.
 */
const NEGATIVE: Readonly<Record<string, string>> = {
  "507.500000sp": "-4.500000sp",
};

/** Compare a decoded table with aapt2's dump: packages, types, every entry and every value. */
const expectMatchesDump = (
  table: ResourceTable,
  dump: DumpPackage[],
): number => {
  expect(table.summary.packages.map(({ id, name }) => ({ id, name }))).toEqual(
    dump.map(({ id, name }) => ({ id, name })),
  );
  let compared = 0;
  for (const [index, owner] of dump.entries()) {
    const ours = table.summary.packages[index];
    expect(
      ours?.types.map(({ id, name, entry_count }) => ({
        id,
        name,
        entry_count,
      })),
    ).toEqual(owner.types);
    for (const type of ours?.types ?? []) {
      const expected = owner.entries
        .filter((entry) => entry.type === type.name)
        .flatMap((entry) => entry.values.map((value) => value.config));
      expect([...type.configs].sort(), type.name).toEqual(
        [...new Set(expected)].sort(),
      );
    }
    for (const entry of owner.entries) {
      const found = table.resolve(entry.id);
      const values = entry.values.map((value) => ({
        ...value,
        text: NEGATIVE[value.text] ?? value.text,
      }));
      expect(found, `${entry.type}/${entry.name}`).toEqual({
        package: owner.name,
        type: entry.type,
        name: entry.name,
        values,
      });
      compared += entry.values.length;
    }
  }
  return compared;
};

// ---- A qualifier- and value-rich table built by aapt2 ----

const QUALIFIERS = [
  "es",
  "es-rMX",
  "b+sr+Latn",
  "b+es+419",
  "b+ca+ES+valencia",
  "sr-rRS-port",
  "fil",
  "zh-rTW",
  "mcc310",
  "mcc310-mnc004",
  "ldrtl",
  "ldltr",
  "sw600dp",
  "w720dp",
  "h480dp",
  "small",
  "normal",
  "large",
  "xlarge",
  "long",
  "notlong",
  "round",
  "notround",
  "widecg",
  "nowidecg",
  "highdr",
  "lowdr",
  "port",
  "land",
  "car",
  "desk",
  "television",
  "appliance",
  "watch",
  "vrheadset",
  "night",
  "notnight",
  "ldpi",
  "mdpi",
  "tvdpi",
  "hdpi",
  "xhdpi",
  "xxhdpi",
  "xxxhdpi",
  "nodpi",
  "anydpi",
  "560dpi",
  "notouch",
  "finger",
  "keysexposed",
  "keyshidden",
  "keyssoft",
  "nokeys",
  "qwerty",
  "12key",
  "navexposed",
  "navhidden",
  "nonav",
  "dpad",
  "trackball",
  "wheel",
  "v26",
  "v34",
  "en-rUS-sw600dp-land-xhdpi-v26",
  "b+sr+Latn+RS",
  "feminine",
  "masculine",
  "neuter",
  "mcc310-en-feminine-ldrtl-sw320dp-w320dp-h480dp-large-long-round-widecg-highdr-port-car-night-xhdpi-finger-keyshidden-qwerty-navhidden-dpad-v33",
];

/** Float probes chosen around aapt2's "%.0f" / "%g" / "%e" switch points. */
const FLOATS = [
  "1e10",
  "1e-5",
  "0.1",
  "100",
  "1e7",
  "123456789",
  "3.4e38",
  "-0.5",
  "1e-7",
  "1234567.8",
  "0.000123",
  "1e16",
  "1.0",
  "0",
  "-0",
  "0.3",
  "99999.99",
  "1e17",
  "123456.7",
  "16777217",
  "7e22",
  "-1e10",
  "9.2e18",
  "9.3e18",
  "-9.3e18",
  "1e-38",
  "4294967295",
];

const RICH_VALUES = `<resources>
  <string name="plain">Plain text</string>
  <string name="styled">A <b>bold</b> and <i>italic</i> word</string>
  <string name="escapes">line\\nbreak\\ttab &amp; &lt;lt&gt; ü 😀</string>
  <dimen name="pad">16dp</dimen>
  <dimen name="neg">-4.5sp</dimen>
  <dimen name="mm">3mm</dimen>
  <dimen name="eighth">0.0078125dp</dimen>
  <item name="half" type="fraction">50%</item>
  <item name="halfp" type="fraction">25.5%p</item>
  ${FLOATS.map((value, index) => `<item name="f${String(index).padStart(2, "0")}" type="dimen" format="float">${value}</item>`).join("\n  ")}
  <integer name="count">-42</integer>
  <integer name="hex">0x1F</integer>
  <bool name="yes">true</bool>
  <color name="argb4">#8F00</color>
  <color name="rgb8">#00FF00</color>
  <item name="nothing" type="drawable">@null</item>
  <item name="empty" type="string">@empty</item>
  <item name="alias" type="string">@string/plain</item>
  <item name="framework" type="color">@android:color/black</item>
  <item name="themeattr" type="color">?android:attr/textColorPrimary</item>
  <item name="localattr" type="color">?attr/oopsColor</item>
  <id name="marker" />
  <attr name="oopsColor" format="color|reference" />
  <attr name="oopsMode"><enum name="off" value="0" /><enum name="on" value="1" /></attr>
  <attr name="oopsFlags"><flag name="a" value="0x1" /><flag name="b" value="0x2" /></attr>
  <attr name="oopsAny" />
  <declare-styleable name="OopsView"><attr name="oopsColor" /><attr name="oopsMode" /></declare-styleable>
  <style name="Oops" parent="android:Theme.Material"><item name="oopsColor">#123456</item></style>
  <style name="Oops.Child"><item name="android:windowNoTitle">true</item></style>
  <string-array name="names"><item>one</item><item>@string/plain</item></string-array>
  <integer-array name="numbers"><item>1</item><item>2</item></integer-array>
  <plurals name="apples"><item quantity="one">%d apple</item><item quantity="other">%d apples</item></plurals>
</resources>
`;

interface Rich {
  readonly binary: string;
  readonly proto: string;
  readonly sparse: string;
  readonly compact: string;
  readonly collapsed: string;
}

const buildRich = async (root: string): Promise<Rich> => {
  if (ANDROID_TOOLS === null) throw new Error("Android tools are missing");
  const aapt2 = join(ANDROID_TOOLS.buildTools, "aapt2");
  const base = join(root, "rich");
  const files: Record<string, string> = {
    "AndroidManifest.xml":
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="org.oops.rich" />\n',
    "res/values/values.xml": RICH_VALUES,
    "res/raw/blob.bin": "raw bytes\n",
    "res/xml/prefs.xml": "<prefs />\n",
  };
  for (const qualifier of QUALIFIERS)
    files[`res/values-${qualifier}/strings.xml`] =
      `<resources><string name="plain">q ${qualifier}</string></resources>\n`;
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(base, path, ".."), { recursive: true });
    await writeFile(join(base, path), content);
  }
  const compiled = join(base, "compiled.zip");
  await run(aapt2, ["compile", "--dir", join(base, "res"), "-o", compiled]);
  const link = async (
    name: string,
    minSdk: number,
    extra: readonly string[] = [],
  ) => {
    const out = join(base, name);
    await run(aapt2, [
      "link",
      "-o",
      out,
      "-I",
      ANDROID_TOOLS?.androidJar ?? "",
      "--manifest",
      join(base, "AndroidManifest.xml"),
      "--min-sdk-version",
      String(minSdk),
      ...extra,
      compiled,
    ]);
    return out;
  };
  const binary = await link("rich.apk", 21);
  const collapsed = join(base, "rich-collapsed.apk");
  await run(aapt2, [
    "optimize",
    "--collapse-resource-names",
    "-o",
    collapsed,
    binary,
  ]);
  return {
    binary,
    proto: await link("rich-proto.zip", 21, ["--proto-format"]),
    // Sparse type chunks need a min SDK of at least 32.
    sparse: await link("rich-sparse.apk", 33, ["--enable-sparse-encoding"]),
    // aapt2 writes compact entries and FLAG_OFFSET16 type chunks from min SDK 34.
    compact: await link("rich-compact.apk", 34, ["--enable-compact-entries"]),
    collapsed,
  };
};

/** Type chunks using FLAG_SPARSE / FLAG_OFFSET16 and entries using FLAG_COMPACT, to prove which encodings a build used. */
const encodings = (
  bytes: Uint8Array,
): { sparse: number; offset16: number; compact: number } => {
  const seen = { sparse: 0, offset16: 0, compact: 0 };
  const walk = (start: number, end: number): void => {
    for (let at = start; at + 8 <= end; at += u32(bytes, at + 4)) {
      const type = u16(bytes, at);
      if (type === 0x0200)
        walk(at + u16(bytes, at + 2), at + u32(bytes, at + 4));
      if (type !== 0x0201) continue;
      const flags = bytes[at + 9] ?? 0;
      const header = u16(bytes, at + 2);
      const count = u32(bytes, at + 12);
      const entries = at + u32(bytes, at + 16);
      if ((flags & 1) !== 0) seen.sparse += 1;
      else if ((flags & 2) !== 0) seen.offset16 += 1;
      for (let index = 0; index < count; index += 1) {
        const offset =
          (flags & 1) !== 0
            ? u16(bytes, at + header + index * 4 + 2) * 4
            : (flags & 2) !== 0
              ? u16(bytes, at + header + index * 2) === 0xffff
                ? null
                : u16(bytes, at + header + index * 2) * 4
              : u32(bytes, at + header + index * 4) === 0xffff_ffff
                ? null
                : u32(bytes, at + header + index * 4);
        if (offset !== null && (u16(bytes, entries + offset + 2) & 0x08) !== 0)
          seen.compact += 1;
      }
    }
  };
  walk(u16(bytes, 2), bytes.length);
  return seen;
};

const describeAndroid = describe.skipIf(ANDROID_TOOLS === null);

describeAndroid("resource tables against aapt2 dump resources", () => {
  let root: string | undefined;
  let fixtures: AndroidFixtures;
  let rich: Rich;

  beforeAll(async () => {
    root = await realpath(
      await mkdtemp(join(await realpath(tmpdir()), "rea-android-res-")),
    );
    fixtures = await buildAndroidFixtures(root);
    rich = await buildRich(root);
  }, 180_000);

  afterAll(async () => {
    if (root !== undefined) await removeTestWorkspace(root);
  });

  it("reads app.apk's resources.arsc as aapt2 does", async () => {
    const table = readArscTable(
      member(await zipMembers(fixtures.apk), "resources.arsc"),
    );
    const compared = expectMatchesDump(
      table,
      parseResourcesDump(await aapt2Dump("resources", fixtures.apk)),
    );
    expect(compared).toBe(7);
    expect(table.summary.problems).toEqual([]);
    expect(table.summary.encoding).toBe("arsc");
    expect(table.summary.string_count).toBeGreaterThan(0);
    expect(
      table.summary.packages[0]?.types.find((type) => type.name === "string")
        ?.configs,
    ).toEqual(["", "es"]);
    expect(table.resolve(0x7f04_0000)?.values).toEqual([
      { config: "", text: '"Oops Demo"' },
      { config: "es", text: '"Oops Demostración"' },
    ]);
    expect(table.resolve(0x7f04_0002)).toBeNull();
    expect(table.resolve(0x7f99_0000)).toBeNull();
  });

  it("reads the bundle's proto resources.pb as aapt2 does", async () => {
    if (root === undefined) return;
    const aab = await zipMembers(fixtures.aab);
    for (const module of ["base", "camera"]) {
      const bytes = member(aab, `${module}/resources.pb`);
      const wrapped = join(root, `${module}-resources.zip`);
      await writeZip(wrapped, [
        [
          "AndroidManifest.xml",
          member(aab, `${module}/manifest/AndroidManifest.xml`),
        ],
        ["resources.pb", bytes],
      ]);
      const table = readProtoTable(bytes);
      expect(table.summary.encoding).toBe("proto");
      expectMatchesDump(
        table,
        parseResourcesDump(await aapt2Dump("resources", wrapped)),
      );
    }
  });

  it("reads every resources.arsc bundletool wrote into the split APK set", async () => {
    if (root === undefined) return;
    const set = await zipMembers(fixtures.apks);
    let values = 0;
    let tables = 0;
    for (const [name, bytes] of set) {
      if (!name.endsWith(".apk")) continue;
      const path = await writeTemporary(root, name, bytes);
      const arsc = (await zipMembers(path)).get("resources.arsc");
      if (arsc === undefined) continue;
      const table = readArscTable(arsc);
      expect(table.summary.problems, name).toEqual([]);
      values += expectMatchesDump(
        table,
        parseResourcesDump(await aapt2Dump("resources", path)),
      );
      tables += 1;
    }
    expect(tables).toBeGreaterThan(20);
    expect(values).toBeGreaterThan(tables);
  });

  it("renders every config qualifier and value kind as aapt2 does, in all encodings", async () => {
    for (const [label, path] of [
      ["binary", rich.binary],
      ["sparse", rich.sparse],
      ["compact", rich.compact],
      ["collapsed", rich.collapsed],
    ] as const) {
      const bytes = member(await zipMembers(path), "resources.arsc");
      const table = readArscTable(bytes);
      expect(table.summary.problems, label).toEqual([]);
      const compared = expectMatchesDump(
        table,
        parseResourcesDump(await aapt2Dump("resources", path)),
      );
      expect(compared, label).toBeGreaterThan(
        QUALIFIERS.length + FLOATS.length,
      );
    }
    const used = async (path: string) =>
      encodings(member(await zipMembers(path), "resources.arsc"));
    expect((await used(rich.sparse)).sparse).toBeGreaterThan(0);
    expect((await used(rich.compact)).compact).toBeGreaterThan(100);
    expect((await used(rich.compact)).offset16).toBeGreaterThan(0);
    expect((await used(rich.binary)).compact).toBe(0);
    const proto = readProtoTable(
      member(await zipMembers(rich.proto), "resources.pb"),
    );
    expectMatchesDump(
      proto,
      parseResourcesDump(await aapt2Dump("resources", rich.proto)),
    );
    const plain =
      proto.summary.packages[0]?.types.find((type) => type.name === "string")
        ?.configs ?? [];
    expect(plain).toContain(
      "mcc310-en-feminine-ldrtl-sw320dp-w320dp-h480dp-large-long-round-widecg-highdr-port-car-night-xhdpi-finger-keyshidden-qwerty-navhidden-dpad-v34",
    );
    expect(plain).toEqual(
      expect.arrayContaining(["b+sr+Latn+RS", "es-r419", "fil", "mcc310-mnc4"]),
    );
  });
});

const writeTemporary = async (
  root: string,
  name: string,
  bytes: Uint8Array,
): Promise<string> => {
  const directory = join(root, "splits");
  await mkdir(directory, { recursive: true });
  const path = join(directory, name.replaceAll("/", "_"));
  await writeFile(path, bytes);
  return path;
};

describeAndroid(
  "damaged resource tables derived from real aapt2 output",
  () => {
    let root: string | undefined;
    let arsc: Uint8Array;
    let proto: Uint8Array;

    beforeAll(async () => {
      root = await realpath(
        await mkdtemp(join(await realpath(tmpdir()), "rea-android-res-bad-")),
      );
      const fixtures = await buildAndroidFixtures(root);
      // A fresh Uint8Array: Buffer#slice shares memory, and each case edits its own copy.
      arsc = new Uint8Array(await readFile(fixtures.arsc));
      proto = member(await zipMembers(fixtures.aab), "base/resources.pb");
    }, 180_000);

    afterAll(async () => {
      if (root !== undefined) await removeTestWorkspace(root);
    });

    /** Offset of the package chunk. */
    const packageOffset = (bytes: Uint8Array): number => {
      let at = u16(bytes, 2);
      while (at < bytes.length && u16(bytes, at) !== 0x0200)
        at += u32(bytes, at + 4);
      return at;
    };

    /** Offsets of the package's child chunks, in file order. */
    const typeChunks = (
      bytes: Uint8Array,
    ): { offset: number; type: number; id: number }[] => {
      const found: { offset: number; type: number; id: number }[] = [];
      const at = packageOffset(bytes);
      const end = at + u32(bytes, at + 4);
      for (
        let child = at + u16(bytes, at + 2);
        child + 8 <= end;
        child += u32(bytes, child + 4)
      )
        found.push({
          offset: child,
          type: u16(bytes, child),
          id: bytes[child + 8] ?? 0,
        });
      return found;
    };

    const strings = (bytes: Uint8Array) =>
      typeChunks(bytes).filter(
        (chunk) => chunk.type === 0x0201 && chunk.id === 4,
      );

    it("keeps the types read before a cut inside a type chunk", () => {
      // Cut 12 bytes into the last type chunk (string, es): the package and table now run past the file.
      const last = strings(arsc).at(-1)?.offset ?? 0;
      const table = readArscTable(arsc.slice(0, last + 12));
      expect(table.summary.problems.map((problem) => problem.offset)).toEqual([
        4,
        packageOffset(arsc),
        last,
      ]);
      expect(table.resolve(0x7f04_0000)?.values).toEqual([
        { config: "", text: '"Oops Demo"' },
      ]);
      expect(table.resolve(0x7f01_0000)?.values).toHaveLength(2);
    });

    it("skips a type chunk whose entry count runs past its entries", () => {
      // The default-config string chunk claims 0x10000 entries; its offsets cannot fit before entriesStart.
      const bytes = arsc.slice();
      const target = strings(bytes)[0]?.offset ?? 0;
      new DataView(bytes.buffer).setUint32(target + 12, 0x1_0000, true);
      const table = readArscTable(bytes);
      expect(table.summary.problems).toEqual([
        {
          offset: target + 12,
          message: expect.stringMatching(/65536 entry offsets do not fit/u),
        },
      ]);
      expect(table.resolve(0x7f04_0000)?.values).toEqual([
        { config: "es", text: '"Oops Demostración"' },
      ]);
    });

    it("keeps entry names when the value string pool counts more strings than it holds", () => {
      // The global pool follows the 12-byte table header; stringCount sits 8 bytes into it.
      const bytes = arsc.slice();
      new DataView(bytes.buffer).setUint32(20, 0x0100_0000, true);
      const table = readArscTable(bytes);
      expect(table.summary.problems[0]?.offset).toBe(20);
      expect(table.summary.string_count).toBeNull();
      expect(table.resolve(0x7f04_0000)).toEqual({
        package: "com.example.oops",
        type: "string",
        name: "app_name",
        values: [
          {
            config: "",
            text: expect.stringMatching(/^\(string #\d+ missing\)$/u),
          },
          {
            config: "es",
            text: expect.stringMatching(/^\(string #\d+ missing\)$/u),
          },
        ],
      });
    });

    it("skips an unknown chunk inside the package and reads everything else", () => {
      // Insert a 16-byte chunk of unknown type 0x0299 before the first type spec; grow package and table.
      const first =
        typeChunks(arsc).find((chunk) => chunk.type === 0x0202)?.offset ?? 0;
      const unknown = new Uint8Array(16);
      new DataView(unknown.buffer).setUint16(0, 0x0299, true);
      new DataView(unknown.buffer).setUint16(2, 8, true);
      new DataView(unknown.buffer).setUint32(4, 16, true);
      const bytes = new Uint8Array(arsc.length + 16);
      bytes.set(arsc.subarray(0, first));
      bytes.set(unknown, first);
      bytes.set(arsc.subarray(first), first + 16);
      const view = new DataView(bytes.buffer);
      view.setUint32(4, bytes.length, true);
      const pkg = packageOffset(bytes);
      view.setUint32(pkg + 4, u32(bytes, pkg + 4) + 16, true);
      const table = readArscTable(bytes);
      expect(table.summary.problems).toEqual([
        { offset: first, message: "Package chunk type 0x299 was skipped." },
      ]);
      const original = readArscTable(arsc);
      expect(table.summary.packages).toEqual(original.summary.packages);
      for (const id of [
        0x7f01_0000, 0x7f02_0000, 0x7f03_0000, 0x7f04_0000, 0x7f04_0001,
      ])
        expect(table.resolve(id)).toEqual(original.resolve(id));
    });

    it("refuses bytes that are not a resource table", () => {
      const bytes = arsc.slice();
      bytes[0] = 0x03;
      expect(() => readArscTable(bytes)).toThrow(ResourceTableFormatError);
      expect(() => readArscTable(arsc.slice(0, 10))).toThrow(/12-byte header/u);
    });

    it("reports a truncated proto varint at its byte offset", () => {
      // Append a field-2 varint key (0x10) and a continuation byte (0xff) that nothing follows.
      const bytes = new Uint8Array([...proto, 0x10, 0xff]);
      try {
        readProtoTable(bytes);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(ResourceTableFormatError);
        expect((error as ResourceTableFormatError).offset).toBe(
          proto.length + 1,
        );
      }
    });
  },
);
