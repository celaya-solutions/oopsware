import { execFile, spawn } from "node:child_process";
import {
  access,
  constants,
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
import { DOMParser, type Element } from "@xmldom/xmldom";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ANDROID_TOOLS,
  aapt2Dump,
  buildAndroidFixtures,
  writeZip,
  type AndroidFixtures,
} from "../../../tests/fixtures/androidProducers.js";
import { removeTestWorkspace } from "../../../tests/support/workspace/workspaceFixture.js";
import { readManifestFacts } from "../manifest.js";
import { readArscTable } from "../resources/resourceTable.js";
import {
  AndroidXmlFormatError,
  MAX_XML_DEPTH,
  MAX_XML_NODES,
  type AndroidXmlDocument,
  type AndroidXmlElement,
  type AndroidXmlNode,
} from "./androidXml.js";
import { decodeBinaryXml, u32 } from "./binaryXml.js";
import { decodeProtoXml } from "./protoXml.js";
import { renderAndroidXml } from "./renderXml.js";

const run = promisify(execFile);

const PROTOC = await (async () => {
  for (const candidate of ["/opt/homebrew/bin/protoc", "/usr/local/bin/protoc"])
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not installed here.
    }
  return null;
})();

/** `protoc --decode=<type>` of `bytes`, the field-exact protobuf oracle. */
const protocDecode = (
  protoc: string,
  includes: string,
  type: string,
  bytes: Uint8Array,
): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn(protoc, [
      `--decode=${type}`,
      "-I",
      includes,
      "Resources.proto",
    ]);
    const out: Buffer[] = [];
    const errors: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out).toString("utf8"));
      else reject(new Error(Buffer.concat(errors).toString("utf8")));
    });
    child.stdin.end(Buffer.from(bytes));
  });

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

// ---- `aapt2 dump xmltree` as a tree ----

interface DumpAttribute {
  readonly namespace: string | null;
  readonly name: string;
  readonly id: number | null;
  readonly value: string;
  readonly raw: string | null;
}
interface DumpElement {
  readonly kind: "element";
  readonly namespace: string | null;
  readonly name: string;
  readonly line: number;
  readonly namespaces: { readonly prefix: string; readonly uri: string }[];
  readonly attributes: DumpAttribute[];
  readonly children: DumpNode[];
}
type DumpNode = DumpElement | { readonly kind: "text"; readonly text: string };

const qualified = (
  full: string,
): { namespace: string | null; name: string } => {
  const cut = full.lastIndexOf(":");
  return cut < 0
    ? { namespace: null, name: full }
    : { namespace: full.slice(0, cut), name: full.slice(cut + 1) };
};

const dumpAttribute = (body: string): DumpAttribute => {
  const match = /^A: (.*?)(?:\((0x[0-9a-f]{8})\))?=(.*)$/su.exec(body);
  if (match === null) throw new Error(`Unexpected attribute line: ${body}`);
  const rest = match[3] ?? "";
  const cut = rest.lastIndexOf(' (Raw: "');
  return {
    ...qualified(match[1] ?? ""),
    id: match[2] === undefined ? null : Number.parseInt(match[2], 16),
    value: cut < 0 ? rest : rest.slice(0, cut),
    raw: cut < 0 ? null : rest.slice(cut + 8, -2),
  };
};

/** Rebuild aapt2's indented xmltree dump: attributes sit 2 deeper than their element, children 4. */
class XmltreeParser {
  readonly stack: { indent: number; element: DumpElement }[] = [];
  pending: { prefix: string; uri: string }[] = [];
  root: DumpElement | null = null;

  /** Close elements that cannot contain a node at `indent`. */
  closeTo(indent: number): void {
    while ((this.stack.at(-1)?.indent ?? -Infinity) + 4 > indent)
      this.stack.pop();
  }

  element(body: string, indent: number): void {
    const match = /^E: (.*) \(line=(\d+)\)$/u.exec(body);
    const element: DumpElement = {
      kind: "element",
      ...qualified(match?.[1] ?? ""),
      line: Number(match?.[2]),
      namespaces: this.pending,
      attributes: [],
      children: [],
    };
    this.closeTo(indent - 2 * this.pending.length);
    this.pending = [];
    const parent = this.stack.at(-1);
    if (parent === undefined) this.root = element;
    else parent.element.children.push(element);
    this.stack.push({ indent, element });
  }

  line(line: string): void {
    const body = line.trimStart();
    const indent = line.length - body.length;
    const kind = body.slice(0, 3);
    if (kind === "N: ") {
      const match = /^N: (.*?)=(.*) \(line=\d+\)$/u.exec(body);
      this.pending.push({ prefix: match?.[1] ?? "", uri: match?.[2] ?? "" });
    } else if (kind === "E: ") this.element(body, indent);
    else if (kind === "A: ")
      this.stack
        .findLast((open) => open.indent + 2 === indent)
        ?.element.attributes.push(dumpAttribute(body));
    else if (kind === "T: ") {
      this.closeTo(indent);
      this.stack
        .at(-1)
        ?.element.children.push({ kind: "text", text: body.slice(4, -1) });
    }
  }
}

const parseXmltree = (text: string): DumpElement => {
  const parser = new XmltreeParser();
  for (const line of text.split("\n")) parser.line(line);
  if (parser.root === null) throw new Error("xmltree dump has no element");
  return parser.root;
};

/** ResTable::normalizeForOutput, as the dump escapes text nodes. */
const normalizeForOutput = (text: string): string =>
  text.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');

/** Our tree in the dump's shape: values print as aapt2 prints them, empty raws are not printed. */
const asDump = (node: AndroidXmlNode): DumpNode => {
  if (node.kind === "text")
    return { kind: "text", text: normalizeForOutput(node.text) };
  return {
    kind: "element",
    namespace: node.namespace,
    name: node.name,
    line: node.line ?? 0,
    namespaces: node.namespaces.map(({ prefix, uri }) => ({ prefix, uri })),
    attributes: node.attributes.map((attribute) => ({
      namespace: attribute.namespace,
      name: attribute.name,
      id: attribute.resource_id,
      value: attribute.value?.text ?? `"${attribute.raw ?? ""}"`,
      raw: attribute.raw === "" ? null : attribute.raw,
    })),
    children: node.children.map(asDump),
  };
};

const counts = (
  element: DumpElement,
): { elements: number; attributes: number } =>
  element.children.reduce(
    (total, child) => {
      if (child.kind === "text") return total;
      const inner = counts(child);
      return {
        elements: total.elements + inner.elements,
        attributes: total.attributes + inner.attributes,
      };
    },
    { elements: 1, attributes: element.attributes.length },
  );

const elementsOf = (element: AndroidXmlElement): AndroidXmlElement[] => [
  element,
  ...element.children.flatMap((child) =>
    child.kind === "element" ? elementsOf(child) : [],
  ),
];

// ---- protoc text format as plain objects ----

type TextValue = string | TextMessage;
interface TextMessage {
  readonly [field: string]: TextValue[];
}

const unescapeC = (text: string): string =>
  new TextDecoder().decode(
    Uint8Array.from(
      text
        .replace(/\\([0-7]{1,3}|.)/gsu, (_all, code: string) =>
          /^[0-7]+$/u.test(code)
            ? String.fromCharCode(Number.parseInt(code, 8))
            : (({ n: "\n", t: "\t", r: "\r" } as Record<string, string>)[
                code
              ] ?? code),
        )
        .split("")
        .flatMap((character) => {
          const code = character.charCodeAt(0);
          return code < 0x100
            ? [code]
            : [...new TextEncoder().encode(character)];
        }),
    ),
  );

/** protoc --decode output: `name: value` scalars and `name { ... }` messages, repeated as arrays. */
const parseTextFormat = (text: string): TextMessage => {
  const stack: Record<string, TextValue[]>[] = [{}];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const top = stack.at(-1) ?? {};
    if (line === "") continue;
    if (line === "}") stack.pop();
    else if (line.endsWith(" {")) {
      const child: Record<string, TextValue[]> = {};
      (top[line.slice(0, -2)] ??= []).push(child);
      stack.push(child);
    } else {
      const cut = line.indexOf(": ");
      const value = line.slice(cut + 2);
      (top[line.slice(0, cut)] ??= []).push(
        value.startsWith('"') ? unescapeC(value.slice(1, -1)) : value,
      );
    }
  }
  return stack[0] ?? {};
};

const one = (
  message: TextMessage | undefined,
  field: string,
): TextValue | undefined => message?.[field]?.[0];
const messagesOf = (
  message: TextMessage | undefined,
  field: string,
): TextMessage[] =>
  (message?.[field] ?? []).filter(
    (value): value is TextMessage => typeof value !== "string",
  );
const scalar = (
  message: TextMessage | undefined,
  field: string,
): string | undefined => {
  const value = one(message, field);
  return typeof value === "string" ? value : undefined;
};

/** The protoc view of an XmlElement, in our tree's shape (fields only, no rendering). */
const protocElement = (node: TextMessage): object => {
  const element = messagesOf(node, "element")[0];
  const line = scalar(messagesOf(node, "source")[0], "line_number");
  return {
    namespace: scalar(element, "namespace_uri") ?? null,
    name: scalar(element, "name") ?? "",
    line: messagesOf(node, "source").length === 0 ? null : Number(line ?? 0),
    namespaces: messagesOf(element, "namespace_declaration").map(
      (declaration) => ({
        prefix: scalar(declaration, "prefix") ?? "",
        uri: scalar(declaration, "uri") ?? "",
      }),
    ),
    attributes: messagesOf(element, "attribute").map((attribute) => ({
      namespace: scalar(attribute, "namespace_uri") ?? null,
      name: scalar(attribute, "name") ?? "",
      resource_id:
        attribute.resource_id === undefined
          ? null
          : Number(scalar(attribute, "resource_id")),
      raw: scalar(attribute, "value") ?? "",
    })),
    children: messagesOf(element, "child").map((child) =>
      child.text === undefined
        ? protocElement(child)
        : { text: scalar(child, "text") ?? "" },
    ),
  };
};

const ourFields = (element: AndroidXmlElement): object => ({
  namespace: element.namespace,
  name: element.name,
  line: element.line,
  namespaces: element.namespaces,
  attributes: element.attributes.map(
    ({ namespace, name, resource_id, raw }) => ({
      namespace,
      name,
      resource_id,
      raw,
    }),
  ),
  children: element.children.map((child) =>
    child.kind === "text" ? { text: child.text } : ourFields(child),
  ),
});

// ---- Fixtures ----

const TYPED_XML = `<?xml version="1.0" encoding="utf-8"?>
<oops xmlns:android="http://schemas.android.com/apk/res/android" xmlns:app="http://schemas.android.com/apk/res-auto" xmlns:x="urn:oops:x"
    android:alpha="0.5" android:textSize="14sp" android:layout_marginTop="-4dp" android:textColor="#ff112233"
    android:background="#0f0" android:layout_weight="2" android:visibility="gone" android:gravity="center|top"
    android:enabled="false" android:minHeight="48dp" android:fromXDelta="50%p" android:pivotX="25%"
    android:id="@+id/typed" android:theme="?android:attr/actionBarTheme" android:src="@null"
    android:maxLines="3" android:inputType="textPassword|textCapWords" android:fontFamily="sans" android:max="0x10"
    app:oopsColor="@color/tint" app:oopsMode="on" x:plain="v &amp; &lt;w&gt; &quot;q&quot;" untyped="hello">
  <child>Text &amp; more</child>
  <![CDATA[raw <cdata>]]>
  <x:named android:text="@string/styled" />
  <empty android:text="" />
</oops>
`;

const TYPED_VALUES = `<resources>
  <string name="styled">A <b>bold</b> word</string>
  <color name="tint">#80FF0000</color>
  <attr name="oopsColor" format="color|reference" />
  <attr name="oopsMode"><enum name="off" value="0" /><enum name="on" value="1" /></attr>
</resources>
`;

interface Typed {
  readonly binary: string;
  readonly proto: string;
}

/** A feature module manifest whose delivery has install-time conditions (bundletool's dist schema). */
const CONDITIONAL_MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:dist="http://schemas.android.com/apk/distribution"
    package="com.example.oops" split="ar" android:isFeatureSplit="true">
  <dist:module dist:title="AR" dist:instant="false">
    <dist:delivery>
      <dist:install-time>
        <dist:conditions>
          <dist:min-sdk dist:value="26" />
          <dist:device-feature dist:name="android.hardware.camera.ar" />
          <dist:user-countries dist:exclude="true">
            <dist:country dist:code="CN" />
            <dist:country dist:code="RU" />
          </dist:user-countries>
        </dist:conditions>
        <dist:removable dist:value="true" />
      </dist:install-time>
      <dist:on-demand />
    </dist:delivery>
    <dist:fusing dist:include="false" />
  </dist:module>
  <uses-split android:name="camera" />
  <application android:hasCode="false" />
</manifest>
`;

/** Overwrite every occurrence of `from` (UTF-8 or UTF-16LE) inside the first string pool with `to`. */
const renameInPool = (bytes: Uint8Array, from: string, to: string): void => {
  const end = 8 + u32(bytes, 12);
  const utf8 = ((bytes[25] ?? 0) & 0x01) !== 0;
  const encode = (text: string) =>
    utf8
      ? new TextEncoder().encode(text)
      : new Uint8Array(Buffer.from(text, "utf16le"));
  const needle = encode(from);
  const replacement = encode(to);
  let replaced = 0;
  for (let at = 8; at + needle.length <= end; at += 1)
    if (needle.every((byte, index) => bytes[at + index] === byte)) {
      bytes.set(replacement, at);
      replaced += 1;
    }
  if (replaced === 0) throw new Error(`${from} is not in the string pool`);
};

/** typed.xml compiled by aapt2 into a binary APK and a proto zip. */
const buildTyped = async (root: string): Promise<Typed> => {
  if (ANDROID_TOOLS === null) throw new Error("Android tools are missing");
  const aapt2 = join(ANDROID_TOOLS.buildTools, "aapt2");
  const base = join(root, "typed");
  await mkdir(join(base, "res", "xml"), { recursive: true });
  await mkdir(join(base, "res", "values"), { recursive: true });
  await writeFile(join(base, "res", "xml", "typed.xml"), TYPED_XML);
  await writeFile(join(base, "res", "values", "values.xml"), TYPED_VALUES);
  await writeFile(
    join(base, "AndroidManifest.xml"),
    '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="org.oops.typed" />\n',
  );
  const compiled = join(base, "compiled.zip");
  await run(aapt2, ["compile", "--dir", join(base, "res"), "-o", compiled]);
  // A min SDK keeps aapt2 from versioning newer framework attributes into res/xml-vNN.
  const link = [
    "-I",
    ANDROID_TOOLS.androidJar,
    "--min-sdk-version",
    "24",
    "--manifest",
    join(base, "AndroidManifest.xml"),
    compiled,
  ];
  const binary = join(base, "typed.apk");
  const proto = join(base, "typed-proto.zip");
  await run(aapt2, ["link", "-o", binary, ...link]);
  await run(aapt2, ["link", "--proto-format", "-o", proto, ...link]);
  return { binary, proto };
};

const describeAndroid = describe.skipIf(ANDROID_TOOLS === null);

interface XmlState {
  readonly root: string;
  readonly fixtures: AndroidFixtures;
  readonly typed: Typed;
  readonly apk: Map<string, Uint8Array>;
  readonly aab: Map<string, Uint8Array>;
}

let building: Promise<XmlState> | undefined;
let workspace: string | undefined;

/** Build the fixtures once for every describe block in this file. */
const ready = (): Promise<XmlState> =>
  (building ??= (async () => {
    const root = await realpath(
      await mkdtemp(join(await realpath(tmpdir()), "rea-android-xml-")),
    );
    workspace = root;
    const fixtures = await buildAndroidFixtures(root);
    return {
      root,
      fixtures,
      typed: await buildTyped(root),
      apk: await zipMembers(fixtures.apk),
      aab: await zipMembers(fixtures.aab),
    };
  })());

afterAll(async () => {
  if (workspace !== undefined) await removeTestWorkspace(workspace);
});

/** Share the fixture state with one describe block. */
const sharedState = () => {
  const local = {} as { -readonly [K in keyof XmlState]: XmlState[K] };
  beforeAll(async () => {
    Object.assign(local, await ready());
  }, 180_000);
  return local;
};

describeAndroid("binary XML against aapt2 dump xmltree", () => {
  const state = sharedState();

  it("decodes app.apk's binary manifest and layout exactly as aapt2 dump xmltree reads them", async () => {
    for (const [file, expected] of [
      ["AndroidManifest.xml", { elements: 22, attributes: 39 }],
      ["res/layout/main.xml", { elements: 2, attributes: 7 }],
    ] as const) {
      const oracle = parseXmltree(
        await aapt2Dump("xmltree", state.fixtures.apk, file),
      );
      const doc = decodeBinaryXml(member(state.apk, file));
      expect(doc.problems).toEqual([]);
      expect(doc.encoding).toBe("binary-xml");
      expect(asDump(doc.root)).toEqual(oracle);
      expect(counts(oracle)).toEqual(expected);
      expect(doc.node_count).toBe(expected.elements);
    }
  });

  it("decodes every manifest bundletool wrote into the split APK set", async () => {
    const set = await zipMembers(state.fixtures.apks);
    const splits = [...set.keys()].filter((name) => name.endsWith(".apk"));
    expect(splits).toHaveLength(36);
    const directory = join(state.root, "splits");
    await mkdir(directory, { recursive: true });
    let attributes = 0;
    for (const name of splits) {
      const path = join(directory, name.replaceAll("/", "_"));
      await writeFile(path, member(set, name));
      const oracle = parseXmltree(
        await aapt2Dump("xmltree", path, "AndroidManifest.xml"),
      );
      const doc = decodeBinaryXml(
        member(await zipMembers(path), "AndroidManifest.xml"),
      );
      expect(doc.problems, name).toEqual([]);
      expect(asDump(doc.root), name).toEqual(oracle);
      attributes += counts(oracle).attributes;
    }
    expect(attributes).toBeGreaterThan(36 * 5);
  });

  it("renders typed values exactly as aapt2 prints them, in both encodings", async () => {
    const binary = decodeBinaryXml(
      member(await zipMembers(state.typed.binary), "res/xml/typed.xml"),
    );
    const proto = decodeProtoXml(
      member(await zipMembers(state.typed.proto), "res/xml/typed.xml"),
    );
    for (const [doc, path] of [
      [binary, state.typed.binary],
      [proto, state.typed.proto],
    ] as const) {
      const oracle = parseXmltree(
        await aapt2Dump("xmltree", path, "res/xml/typed.xml"),
      );
      const ours = asDump(doc.root) as DumpElement;
      // aapt2's dump reads a complex mantissa as unsigned (-4dp prints as 16777212.000000dp);
      // the runtime and this decoder read it signed.
      const margin = (element: DumpElement) =>
        element.attributes.find(
          (attribute) => attribute.name === "layout_marginTop",
        );
      expect(margin(oracle)?.value).toBe("16777212.000000dp");
      expect(margin(ours)?.value).toBe("-4.000000dp");
      const strip = (element: DumpElement): DumpElement => ({
        ...element,
        attributes: element.attributes.filter(
          (attribute) => attribute.name !== "layout_marginTop",
        ),
      });
      expect(strip(ours)).toEqual(strip(oracle));
      expect(counts(oracle).attributes).toBe(25);
    }
    const values = (doc: AndroidXmlDocument) =>
      Object.fromEntries(
        doc.root.attributes.map((attribute) => [
          attribute.name,
          attribute.value?.type ?? null,
        ]),
      );
    expect(values(binary)).toMatchObject({
      alpha: "float",
      textSize: "dimension",
      fromXDelta: "fraction",
      textColor: "color-argb8",
      background: "color-rgb4",
      gravity: "int-hex",
      maxLines: "int-dec",
      enabled: "boolean",
      theme: "attribute",
      id: "reference",
      src: "reference",
      untyped: "string",
    });
    expect(values(proto)).toMatchObject({
      theme: "attribute",
      untyped: null,
      background: "color-rgb4",
    });
  });
});

describeAndroid("proto XML against aapt2 and protoc", () => {
  const state = sharedState();

  it("decodes each bundle module's proto manifest as aapt2 and protoc read it", async () => {
    if (ANDROID_TOOLS === null) return;
    for (const module of ["base", "camera"]) {
      const bytes = member(state.aab, `${module}/manifest/AndroidManifest.xml`);
      const wrapped = join(state.root, `${module}-proto-manifest.zip`);
      await writeZip(wrapped, [
        ["AndroidManifest.xml", bytes],
        ["resources.pb", member(state.aab, `${module}/resources.pb`)],
      ]);
      const doc = decodeProtoXml(bytes);
      expect(doc.problems).toEqual([]);
      expect(doc.encoding).toBe("proto-xml");
      expect(asDump(doc.root)).toEqual(
        parseXmltree(
          await aapt2Dump("xmltree", wrapped, "AndroidManifest.xml"),
        ),
      );
      if (PROTOC !== null) {
        const protos = await extractProtos(state.root);
        const decoded = await protocDecode(
          PROTOC,
          protos,
          "aapt.pb.XmlNode",
          bytes,
        );
        expect(ourFields(doc.root)).toEqual(
          protocElement(parseTextFormat(decoded)),
        );
      }
    }
    const layout = decodeProtoXml(
      member(state.aab, "base/res/layout/main.xml"),
    );
    expect(elementsOf(layout.root).map((element) => element.name)).toEqual([
      "LinearLayout",
      "TextView",
    ]);
  });
});

describeAndroid("manifest facts against aapt2 badging", () => {
  const state = sharedState();

  it("reads manifest facts that match aapt2 dump badging", async () => {
    const badging = await aapt2Dump("badging", state.fixtures.apk);
    const table = readArscTable(member(state.apk, "resources.arsc"));
    const resolveText = (id: number) => {
      const text =
        table.resolve(id)?.values.find((value) => value.config === "")?.text ??
        null;
      return text?.startsWith('"') === true ? text.slice(1, -1) : text;
    };
    const binary = readManifestFacts(
      decodeBinaryXml(member(state.apk, "AndroidManifest.xml")).root,
      resolveText,
    );
    const field = (pattern: RegExp) => pattern.exec(badging)?.[1] ?? null;
    expect(binary.package_name).toBe(field(/package: name='([^']*)'/u));
    expect(String(binary.version_code)).toBe(field(/versionCode='([^']*)'/u));
    expect(binary.version_name).toBe(field(/versionName='([^']*)'/u));
    expect(binary.compile_sdk).toBe(field(/compileSdkVersion='([^']*)'/u));
    expect(binary.compile_sdk_codename).toBe(
      field(/compileSdkVersionCodename='([^']*)'/u),
    );
    expect(binary.platform_build_version).toBe(
      `${field(/platformBuildVersionCode='([^']*)'/u) ?? ""} (${field(/platformBuildVersionName='([^']*)'/u) ?? ""})`,
    );
    expect(binary.min_sdk).toBe(field(/minSdkVersion:'([^']*)'/u));
    expect(binary.target_sdk).toBe(field(/targetSdkVersion:'([^']*)'/u));
    expect(binary.application?.label).toBe(
      field(/application-label:'([^']*)'/u),
    );
    expect(
      binary.uses_permissions.map(
        ({ name, max_sdk }) =>
          `uses-permission: name='${name}'${max_sdk === null ? "" : ` maxSdkVersion='${String(max_sdk)}'`}`,
      ),
    ).toEqual(
      badging.split("\n").filter((line) => line.startsWith("uses-permission:")),
    );
    const launcher = binary.components.find((component) =>
      component.intent_filters.some((filter) =>
        filter.categories.includes("android.intent.category.LAUNCHER"),
      ),
    );
    expect(launcher?.class_name).toBe(
      field(/launchable-activity: name='([^']*)'/u),
    );
    expect(
      binary.uses_features
        .filter((feature) => feature.required === false)
        .map((feature) => feature.name),
    ).toEqual([field(/uses-feature-not-required: name='([^']*)'/u)]);
    expect(
      binary.components.map((component) => [
        component.kind,
        component.class_name,
        component.exported,
      ]),
    ).toEqual([
      ["activity", "com.example.oops.MainActivity", true],
      ["service", "com.example.oops.SyncService", false],
      ["receiver", "com.example.oops.BootReceiver", true],
      ["provider", "com.example.oops.DataProvider", false],
    ]);
    expect(binary.problems).toEqual([]);

    // The bundle's proto manifest states the same facts; only reference rendering differs.
    const proto = readManifestFacts(
      decodeProtoXml(member(state.aab, "base/manifest/AndroidManifest.xml"))
        .root,
    );
    expect({
      ...proto,
      application: { ...proto.application, label: null },
    }).toEqual({
      ...binary,
      application: { ...binary.application, label: null },
    });
    expect(proto.application?.label).toBe("@string/app_name");
  });

  it("reads a feature module's dist:module declarations", () => {
    const camera = readManifestFacts(
      decodeProtoXml(member(state.aab, "camera/manifest/AndroidManifest.xml"))
        .root,
    );
    expect(camera.split).toBe("camera");
    expect(camera.module).toEqual({
      title: "@string/camera_title",
      delivery: ["on-demand"],
      fusing_include: true,
      instant: null,
      type: null,
    });
    expect(camera.components[0]?.class_name).toBe(
      "com.example.oops.camera.CameraActivity",
    );
  });
});

describeAndroid("manifest facts from renamed and conditional manifests", () => {
  const state = sharedState();

  it("matches framework attributes by resource id when obfuscation renames them", () => {
    // Overwrite three attribute-name strings in the pool with same-length junk; the resource
    // map still gives their ids, so the facts must not change.
    const original = member(state.apk, "AndroidManifest.xml");
    const bytes = original.slice();
    for (const name of ["versionCode", "exported", "minSdkVersion"])
      renameInPool(bytes, name, "q".repeat(name.length));
    const doc = decodeBinaryXml(bytes);
    expect(
      doc.root.attributes.find(
        (attribute) => attribute.resource_id === 0x0101_021b,
      )?.name,
    ).toBe("qqqqqqqqqqq");
    expect(readManifestFacts(doc.root)).toEqual(
      readManifestFacts(decodeBinaryXml(original).root),
    );
  });

  it("reads install-time conditions that aapt2 compiled into both encodings", async () => {
    if (ANDROID_TOOLS === null) return;
    const directory = join(state.root, "conditional");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "AndroidManifest.xml"),
      CONDITIONAL_MANIFEST,
    );
    const link = async (name: string, extra: readonly string[]) => {
      const out = join(directory, name);
      await run(join(ANDROID_TOOLS?.buildTools ?? "", "aapt2"), [
        "link",
        ...extra,
        "-o",
        out,
        "-I",
        ANDROID_TOOLS?.androidJar ?? "",
        "--manifest",
        join(directory, "AndroidManifest.xml"),
      ]);
      return member(await zipMembers(out), "AndroidManifest.xml");
    };
    const expected = {
      title: "AR",
      delivery: [
        "install-time",
        "conditions: min-sdk 26, device-feature android.hardware.camera.ar, user-countries excluding CN,RU",
        "removable true",
        "on-demand",
      ],
      fusing_include: false,
      instant: false,
      type: null,
    };
    for (const facts of [
      readManifestFacts(decodeBinaryXml(await link("binary.apk", [])).root),
      readManifestFacts(
        decodeProtoXml(await link("proto.zip", ["--proto-format"])).root,
      ),
    ]) {
      expect(facts.module).toEqual(expected);
      expect(facts).toMatchObject({
        split: "ar",
        is_feature_split: true,
        uses_splits: ["camera"],
      });
      expect(facts.application?.has_code).toBe(false);
      expect(facts.problems).toEqual([]);
    }
  });
});

describeAndroid("readable XML against bundletool's manifest dump", () => {
  const state = sharedState();

  it("renders readable XML that bundletool's own manifest dump agrees with", async () => {
    if (ANDROID_TOOLS === null) return;
    for (const module of ["base", "camera"]) {
      const { stdout } = await run(
        join(ANDROID_TOOLS.javaHome, "bin", "java"),
        [
          "-jar",
          ANDROID_TOOLS.bundletool,
          "dump",
          "manifest",
          `--bundle=${state.fixtures.aab}`,
          `--module=${module}`,
        ],
        { encoding: "utf8" },
      );
      const ours = renderAndroidXml(
        decodeProtoXml(
          member(state.aab, `${module}/manifest/AndroidManifest.xml`),
        ),
      );
      const shape = (xml: string) => {
        const lines: string[] = [];
        const walk = (node: Element) => {
          const attributes: string[] = [];
          for (let index = 0; index < node.attributes.length; index += 1) {
            const attribute = node.attributes.item(index);
            if (attribute !== null)
              attributes.push(`${attribute.name}=${attribute.value}`);
          }
          lines.push(`${node.tagName} ${attributes.sort().join(" ")}`);
          for (let index = 0; index < node.childNodes.length; index += 1) {
            const child = node.childNodes.item(index);
            if (child !== null && child.nodeType === 1) walk(child as Element);
          }
        };
        const document = new DOMParser().parseFromString(xml, "text/xml");
        if (document.documentElement !== null) walk(document.documentElement);
        return lines;
      };
      expect(shape(ours)).toEqual(shape(stdout));
    }
    const table = readArscTable(member(state.apk, "resources.arsc"));
    const resolved = renderAndroidXml(
      decodeBinaryXml(member(state.apk, "res/layout/main.xml")),
      (id) => {
        const found = table.resolve(id);
        return found === null ? null : `${found.type}/${found.name}`;
      },
    );
    expect(resolved).toBe(
      [
        '<?xml version="1.0" encoding="utf-8"?>',
        "<LinearLayout",
        '    xmlns:android="http://schemas.android.com/apk/res/android"',
        '    android:orientation="1"',
        '    android:layout_width="-1"',
        '    android:layout_height="-1">',
        "  <TextView",
        '      android:id="@id/title"',
        '      android:layout_width="-2"',
        '      android:layout_height="-2"',
        '      android:text="@string/app_name" />',
        "</LinearLayout>",
        "",
      ].join("\n"),
    );
  });
});

/** The .proto files bundletool ships, extracted once for protoc. */
const extractProtos = async (root: string): Promise<string> => {
  if (ANDROID_TOOLS === null) throw new Error("bundletool is missing");
  const directory = join(root, "protos");
  try {
    await access(join(directory, "Resources.proto"));
    return directory;
  } catch {
    // Extract below.
  }
  for (const [name, bytes] of await zipMembers(ANDROID_TOOLS.bundletool))
    if (name.endsWith(".proto")) {
      const target = join(directory, name);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, bytes);
    }
  return directory;
};

describeAndroid("damaged binary XML derived from real aapt2 output", () => {
  let manifest: Uint8Array;

  beforeAll(async () => {
    manifest = member((await ready()).apk, "AndroidManifest.xml");
  }, 180_000);

  /** Offsets of every chunk directly inside the RES_XML_TYPE root. */
  const chunkOffsets = (
    bytes: Uint8Array,
  ): { offset: number; type: number }[] => {
    const offsets: { offset: number; type: number }[] = [];
    for (let at = 8; at < bytes.length; at += u32(bytes, at + 4))
      offsets.push({
        offset: at,
        type: (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8),
      });
    return offsets;
  };

  const startElements = () =>
    chunkOffsets(manifest).filter((chunk) => chunk.type === 0x0102);

  it("keeps what was read when the file is cut inside an element chunk", () => {
    // Cut 10 bytes into the 10th start-element chunk: the root's size now runs past the file.
    const cut = (startElements()[9]?.offset ?? 0) + 10;
    const doc = decodeBinaryXml(manifest.slice(0, cut));
    expect(doc.problems.map((problem) => problem.offset)).toEqual([
      4,
      cut - 10,
      cut - 10,
    ]);
    expect(doc.problems[1]?.message).toMatch(
      /declares \d+ bytes but its parent leaves 10/u,
    );
    expect(elementsOf(doc.root)).toHaveLength(9);
    expect(doc.root.name).toBe("manifest");
  });

  it("stops at a chunk whose size runs past its parent", () => {
    // Set the 6th start-element chunk's size to the whole document's size.
    const bytes = manifest.slice();
    const target = startElements()[5]?.offset ?? 0;
    new DataView(bytes.buffer).setUint32(target + 4, bytes.length, true);
    const doc = decodeBinaryXml(bytes);
    expect(doc.problems[0]).toEqual({
      offset: target,
      message: `Chunk 0x0102 declares ${String(bytes.length)} bytes but its parent leaves ${String(bytes.length - target)}.`,
    });
    expect(elementsOf(doc.root)).toHaveLength(5);
  });

  it("refuses a string pool that counts more strings than it holds", () => {
    // The pool is the first chunk (offset 8); its stringCount field sits 8 bytes in.
    const bytes = manifest.slice();
    new DataView(bytes.buffer).setUint32(16, 0x0100_0000, true);
    expect(() => decodeBinaryXml(bytes)).toThrow(AndroidXmlFormatError);
    try {
      decodeBinaryXml(bytes);
    } catch (error) {
      expect((error as AndroidXmlFormatError).offset).toBe(16);
    }
  });

  it("skips an unknown chunk type and reads everything around it", () => {
    // Insert a 16-byte chunk of unknown type 0x0199 before the first start-element and grow the root.
    const before = startElements()[0]?.offset ?? 0;
    const unknown = new Uint8Array(16);
    new DataView(unknown.buffer).setUint16(0, 0x0199, true);
    new DataView(unknown.buffer).setUint16(2, 8, true);
    new DataView(unknown.buffer).setUint32(4, 16, true);
    const bytes = new Uint8Array(manifest.length + 16);
    bytes.set(manifest.subarray(0, before));
    bytes.set(unknown, before);
    bytes.set(manifest.subarray(before), before + 16);
    new DataView(bytes.buffer).setUint32(4, bytes.length, true);
    const doc = decodeBinaryXml(bytes);
    expect(doc.root).toEqual(decodeBinaryXml(manifest).root);
    expect(doc.problems).toEqual([
      {
        offset: before,
        message: "Unknown chunk type 0x0199 (16 bytes) was skipped.",
      },
    ]);
  });

  it("caps the characters a pool may decode when its offsets point into one another", () => {
    // Hand-built: a UTF-16 pool whose data is 4096 copies of 0x0100, so every even offset reads as
    // a 256-unit string; 3000 offsets at successive positions would decode 768,000 characters.
    const count = 3000;
    const data = new Uint8Array(4096 * 2).fill(0);
    for (let at = 0; at < data.length; at += 2) data[at + 1] = 0x01;
    const pool = new Uint8Array(28 + count * 4 + data.length);
    const view = new DataView(pool.buffer);
    view.setUint16(0, 0x0001, true);
    view.setUint16(2, 28, true);
    view.setUint32(4, pool.length, true);
    view.setUint32(8, count, true);
    view.setUint32(20, 28 + count * 4, true);
    for (let index = 0; index < count; index += 1)
      view.setUint32(28 + index * 4, index * 2, true);
    pool.set(data, 28 + count * 4);
    // One element named by string 0 whose attributes are named by every string.
    const element = new Uint8Array(16 + 20 + count * 20);
    const node = new DataView(element.buffer);
    node.setUint16(0, 0x0102, true);
    node.setUint16(2, 16, true);
    node.setUint32(4, element.length, true);
    node.setUint32(12, 0xffff_ffff, true);
    node.setUint32(16, 0xffff_ffff, true);
    node.setUint16(24, 20, true);
    node.setUint16(26, 20, true);
    node.setUint16(28, count, true);
    for (let index = 0; index < count; index += 1) {
      const at = 36 + index * 20;
      node.setUint32(at, 0xffff_ffff, true);
      node.setUint32(at + 4, index, true);
      node.setUint32(at + 8, 0xffff_ffff, true);
      node.setUint16(at + 12, 8, true);
      element[at + 15] = 0x10;
    }
    const document = new Uint8Array(8 + pool.length + element.length);
    new DataView(document.buffer).setUint16(0, 0x0003, true);
    new DataView(document.buffer).setUint16(2, 8, true);
    new DataView(document.buffer).setUint32(4, document.length, true);
    document.set(pool, 8);
    document.set(element, 8 + pool.length);
    const doc = decodeBinaryXml(document);
    const decoded = doc.root.attributes.reduce(
      (total, attribute) => total + attribute.name.length,
      0,
    );
    expect(doc.root.attributes).toHaveLength(count);
    // The element's name is string 0, the same offset as the first attribute's name: decoded once.
    expect(doc.root.name).toBe(doc.root.attributes[0]?.name);
    expect(decoded).toBeLessThanOrEqual(2 * pool.length + 4096);
    expect(decoded).toBeGreaterThan(2 * pool.length + 4096 - 256);
    // Every refused name is recorded; the element itself is left open (no end chunk was built).
    const refused = doc.problems.filter((problem) =>
      problem.message.endsWith("the pool's decode budget is spent."),
    );
    expect(refused).toHaveLength(
      doc.root.attributes.filter((attribute) => attribute.name === "").length,
    );
    expect(refused.length).toBeGreaterThan(count / 2);
  });

  it("refuses a document whose root is not RES_XML_TYPE", () => {
    const bytes = manifest.slice();
    bytes[0] = 0x02;
    expect(() => decodeBinaryXml(bytes)).toThrow(
      /not a compiled XML document/u,
    );
    expect(() => decodeBinaryXml(manifest.slice(0, 6))).toThrow(
      AndroidXmlFormatError,
    );
  });
});

describeAndroid("damaged proto XML derived from real aapt2 output", () => {
  let protoManifest: Uint8Array;

  beforeAll(async () => {
    protoManifest = member(
      (await ready()).aab,
      "camera/manifest/AndroidManifest.xml",
    );
  }, 180_000);

  it("reports a truncated proto varint at its byte offset", () => {
    // Append a field-1 varint key (0x08) followed by a continuation byte with nothing after it.
    const bytes = new Uint8Array([...protoManifest, 0x08, 0x80]);
    try {
      decodeProtoXml(bytes);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AndroidXmlFormatError);
      expect((error as AndroidXmlFormatError).offset).toBe(
        protoManifest.length + 1,
      );
      expect((error as Error).message).toMatch(/truncated/u);
    }
  });

  /** XmlNode{element{name, child: inner}}: field 1 (element) holding field 3 (name) and field 5 (child). */
  const wrap = (inner: Uint8Array, name: string): Uint8Array => {
    const varint = (value: number) => {
      const out: number[] = [];
      let rest = value;
      while (rest >= 0x80) {
        out.push((rest & 0x7f) | 0x80);
        rest = Math.floor(rest / 128);
      }
      out.push(rest);
      return out;
    };
    const text = new TextEncoder().encode(name);
    const element = [
      0x1a,
      ...varint(text.length),
      ...text,
      0x2a,
      ...varint(inner.length),
      ...inner,
    ];
    return new Uint8Array([0x0a, ...varint(element.length), ...element]);
  };

  it("stops an over-deep proto document at the depth limit and keeps the outer levels", () => {
    let bytes = protoManifest;
    for (let level = 0; level < MAX_XML_DEPTH + 10; level += 1)
      bytes = wrap(bytes, `w${String(level)}`);
    const doc = decodeProtoXml(bytes);
    expect(doc.problems).toHaveLength(1);
    expect(doc.problems[0]?.message).toMatch(/deeper than 256/u);
    let depth = 1;
    for (
      let element = doc.root;
      element.children[0]?.kind === "element";
      element = element.children[0]
    )
      depth += 1;
    expect(depth).toBe(MAX_XML_DEPTH);
  });

  it("stops a proto document at the node limit", () => {
    // One element with MAX_XML_NODES + 5 text children (field 5 → XmlNode{text: "x"}).
    const child = [0x2a, 0x03, 0x12, 0x01, 0x78];
    const name = [0x1a, 0x01, 0x72];
    const element = new Uint8Array(
      name.length + child.length * (MAX_XML_NODES + 5),
    );
    element.set(name);
    for (let index = 0; index < MAX_XML_NODES + 5; index += 1)
      element.set(child, name.length + index * child.length);
    const header = [0x0a];
    let length = element.length;
    while (length >= 0x80) {
      header.push((length & 0x7f) | 0x80);
      length = Math.floor(length / 128);
    }
    header.push(length);
    const doc = decodeProtoXml(new Uint8Array([...header, ...element]));
    expect(doc.node_count).toBe(MAX_XML_NODES);
    expect(doc.root.children).toHaveLength(MAX_XML_NODES - 1);
    expect(doc.problems[0]?.message).toMatch(/more than 200000 nodes/u);
  });
});
