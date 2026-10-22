import { createHash } from "node:crypto";

import { DOMParser, ParseError } from "@xmldom/xmldom";

import { MAX_JVM_LISTED } from "../domain/jvm/jvm.js";

export interface ManifestAttribute {
  readonly name: string;
  readonly value: string;
}

export interface Manifest {
  readonly main: readonly ManifestAttribute[];
  readonly sections: readonly {
    readonly name: string;
    readonly attributes: readonly ManifestAttribute[];
  }[];
  readonly problems: readonly string[];
}

/**
 * Parse a JAR manifest (JAR File Specification, "Manifest Specification"):
 * `Name: value` headers, continuation lines that start with one space, and
 * blank lines between sections. Attributes are kept in file order.
 */
export const parseManifest = (bytes: Uint8Array): Manifest => {
  const text = new TextDecoder("utf-8").decode(bytes);
  const problems: string[] = [];
  if (text.includes("�")) problems.push("The manifest is not valid UTF-8.");
  const blocks: ManifestAttribute[][] = [[]];
  let current: { name: string; value: string } | null = null;
  const flush = () => {
    if (current !== null) blocks.at(-1)?.push(current);
    current = null;
  };
  for (const [index, line] of text.split(/\r\n|\r|\n/u).entries()) {
    if (line.startsWith(" ")) {
      if (current === null)
        problems.push(`Line ${String(index + 1)} continues nothing.`);
      else current.value += line.slice(1);
      continue;
    }
    flush();
    if (line === "") {
      if ((blocks.at(-1)?.length ?? 0) > 0) blocks.push([]);
      continue;
    }
    const colon = line.indexOf(": ");
    if (colon <= 0) {
      problems.push(`Line ${String(index + 1)} is not a "Name: value" header.`);
      continue;
    }
    current = { name: line.slice(0, colon), value: line.slice(colon + 2) };
  }
  flush();
  const [main = [], ...rest] = blocks.filter((block) => block.length > 0);
  const sections = [];
  for (const block of rest) {
    const name = block.find((attribute) => attribute.name === "Name")?.value;
    if (name === undefined) {
      problems.push("A manifest section has no Name attribute.");
      continue;
    }
    sections.push({
      name,
      attributes: block.filter((attribute) => attribute.name !== "Name"),
    });
  }
  return { main, sections, problems };
};

/** Manifest attribute names are case-insensitive. */
export const attribute = (
  attributes: readonly ManifestAttribute[],
  name: string,
): string | null =>
  attributes.find((entry) => entry.name.toLowerCase() === name.toLowerCase())
    ?.value ?? null;

const JAVA_NAME = /^[\p{L}_$][\p{L}\p{N}_$]*(?:\.[\p{L}_$][\p{L}\p{N}_$]*)*$/u;

/** Provider names from a `META-INF/services` file; `#` starts a comment. */
export const parseServiceFile = (
  bytes: Uint8Array,
): { providers: string[]; invalid: number } => {
  const providers: string[] = [];
  let invalid = 0;
  for (const raw of new TextDecoder("utf-8")
    .decode(bytes)
    .split(/\r\n|\r|\n/u)) {
    const line = raw.replace(/#.*$/u, "").trim();
    if (line === "") continue;
    if (!JAVA_NAME.test(line)) invalid += 1;
    else if (!providers.includes(line) && providers.length < MAX_JVM_LISTED)
      providers.push(line);
  }
  return { providers, invalid };
};

/** JAR digest attribute names map to these hash algorithms; others are counted as unchecked. */
const DIGESTS: Readonly<Record<string, string>> = {
  "SHA-512": "sha512",
  "SHA-384": "sha384",
  "SHA-256": "sha256",
  "SHA-1": "sha1",
  SHA1: "sha1",
  MD5: "md5",
};

/** Digest attributes (`SHA-256-Digest: base64`) declared for one manifest section. */
export const declaredDigests = (
  attributes: readonly ManifestAttribute[],
): { algorithm: string; hash: string | null; value: string }[] =>
  attributes
    .filter((entry) => /-Digest$/iu.test(entry.name))
    .map((entry) => {
      const algorithm = entry.name.slice(0, -"-Digest".length).toUpperCase();
      return {
        algorithm,
        hash: DIGESTS[algorithm] ?? null,
        value: entry.value.trim(),
      };
    });

export const digestMatches = (
  bytes: Uint8Array,
  hash: string,
  expected: string,
): boolean => createHash(hash).update(bytes).digest("base64") === expected;

const ANDROID = "http://schemas.android.com/apk/res/android";

/** Package and SDK levels from an AAR's text AndroidManifest.xml; nothing is fetched or expanded. */
export const readAndroidManifest = (
  bytes: Uint8Array,
): {
  package: string | null;
  min_sdk: string | null;
  target_sdk: string | null;
  error: string | null;
} => {
  const none = { package: null, min_sdk: null, target_sdk: null };
  if (bytes[0] === 0x03 && bytes[1] === 0x00)
    return {
      ...none,
      error:
        "The manifest is compiled Android binary XML, which this reader does not decode.",
    };
  try {
    const document = new DOMParser({
      onError: () => undefined,
    }).parseFromString(new TextDecoder("utf-8").decode(bytes), "text/xml");
    const root = document.documentElement;
    if (root?.nodeName !== "manifest")
      return { ...none, error: "The root element is not <manifest>." };
    const sdk = root.getElementsByTagName("uses-sdk").item(0);
    const read = (name: string) =>
      sdk === null
        ? null
        : (sdk.getAttributeNS(ANDROID, name) ??
            sdk.getAttribute(`android:${name}`)) ||
          null;
    return {
      package: root.getAttribute("package") || null,
      min_sdk: read("minSdkVersion"),
      target_sdk: read("targetSdkVersion"),
      error: null,
    };
  } catch (cause) {
    if (!(cause instanceof ParseError)) throw cause;
    return {
      ...none,
      error: `The manifest is not well-formed XML: ${cause.message.split("\n")[0] ?? ""}`,
    };
  }
};

const ELF_MACHINES: Readonly<Record<number, string>> = {
  3: "x86",
  40: "arm",
  62: "x86_64",
  183: "aarch64",
  243: "riscv",
};

/** ELF class and machine from a native library header, or null when it is not ELF. */
export const elfHeader = (
  bytes: Uint8Array,
): { class: "32" | "64"; machine: string } | null => {
  if (
    bytes.length < 20 ||
    bytes[0] !== 0x7f ||
    bytes[1] !== 0x45 ||
    bytes[2] !== 0x4c ||
    bytes[3] !== 0x46
  )
    return null;
  const elfClass = bytes[4] === 1 ? "32" : bytes[4] === 2 ? "64" : null;
  if (elfClass === null) return null;
  const little = bytes[5] !== 2;
  const machine = little
    ? (bytes[18] ?? 0) | ((bytes[19] ?? 0) << 8)
    : ((bytes[18] ?? 0) << 8) | (bytes[19] ?? 0);
  return {
    class: elfClass,
    machine: ELF_MACHINES[machine] ?? `e_machine ${String(machine)}`,
  };
};
