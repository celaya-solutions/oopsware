import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  detectFormatCandidates,
  formatDetectionSchema,
  type FormatDetection,
} from "./formatDetection.js";
import {
  FORMAT_SIGNATURE_PREFIX_BYTES,
  hasUdifTrailer,
  hasXarSignature,
  UDIF_TRAILER_BYTES,
} from "./formatSignatures.js";

const detect = (
  bytes: Buffer,
  name: string | null,
  trailer: Buffer | null = null,
  fileSize = bytes.length,
): FormatDetection =>
  detectFormatCandidates({
    prefix: bytes.subarray(0, FORMAT_SIGNATURE_PREFIX_BYTES),
    fileSize,
    name,
    trailer,
  });

const formats = (detection: FormatDetection) =>
  detection.candidates.map((candidate) => candidate.format);

const candidate = (detection: FormatDetection, format: string) => {
  const found = detection.candidates.find((entry) => entry.format === format);
  if (found === undefined) throw new Error(`No ${format} candidate`);
  return found;
};

/** The runtime's WebAssembly validator; this project's lib omits its types. */
const validateWasm = (bytes: Uint8Array): boolean =>
  (
    Reflect.get(globalThis, "WebAssembly") as {
      validate: (bytes: Uint8Array) => boolean;
    }
  ).validate(bytes);

/** Smallest valid WebAssembly core module: magic plus version 1. */
const EMPTY_WASM_MODULE = Buffer.from([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);

const ustarHeader = (gnu: boolean): Buffer => {
  const header = Buffer.alloc(512);
  header.write("hello.txt", 0, "ascii");
  header.write(gnu ? "ustar  \0" : "ustar\0", 257, "latin1");
  return header;
};

const fatHeader = (count: number): Buffer => {
  const header = Buffer.alloc(64);
  header.writeUInt32BE(0xcafebabe, 0);
  header.writeUInt32BE(count, 4);
  return header;
};

const classFile = (major: number, minor = 0): Buffer => {
  const header = Buffer.alloc(32);
  header.writeUInt32BE(0xcafebabe, 0);
  header.writeUInt16BE(minor, 4);
  header.writeUInt16BE(major, 6);
  return header;
};

describe("byte-signature candidates", () => {
  it("recognizes a real WebAssembly module without claiming support", () => {
    expect(validateWasm(EMPTY_WASM_MODULE)).toBe(true);
    const detection = detect(EMPTY_WASM_MODULE, "module.wasm");
    expect(detection.state).toBe("recognized");
    expect(formats(detection)).toEqual(["wasm-binary", "wasm-module"]);
    expect(candidate(detection, "wasm-module")).toMatchObject({
      dimension: "semantic-profile",
      basis: "byte-signature",
      version: "1",
      evidence: { offset: 0, length: 8, observed_hex: "0061736d01000000" },
    });
    expect(detection.contradictions).toEqual([]);
  });

  it("separates a WebAssembly component from a core module", () => {
    const component = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x0d, 0, 1, 0]);
    expect(formats(detect(component, null))).toEqual([
      "wasm-binary",
      "wasm-component",
    ]);
  });

  it("recognizes a gzip stream produced by zlib", () => {
    const detection = detect(gzipSync("hello"), "notes.txt.gz");
    expect(formats(detection)).toEqual(["gzip"]);
    expect(candidate(detection, "gzip").evidence).toEqual({
      offset: 0,
      length: 3,
      observed_hex: "1f8b08",
    });
  });

  it("finds tar magic at its fixed header offset and adds no image role", () => {
    for (const gnu of [false, true]) {
      const detection = detect(ustarHeader(gnu), "bundle.tar");
      expect(formats(detection)).toEqual(["tar"]);
      expect(candidate(detection, "tar")).toMatchObject({
        version: gnu ? "gnu" : "ustar",
        evidence: { offset: 257 },
      });
    }
  });

  it("tells a universal Mach-O apart from a JVM class file", () => {
    const fat = detect(fatHeader(2), null);
    expect(formats(fat)).toEqual(["mach-o-universal"]);
    const java = detect(classFile(65), "Main.class");
    expect(formats(java)).toEqual(["jvm-classfile"]);
    expect(candidate(java, "jvm-classfile").version).toBe("65.0");
    expect(java.limitations.join(" ")).toMatch(
      /inventories a JVM class file as an unclassified file/u,
    );
    const short = detect(Buffer.from([0xca, 0xfe, 0xba, 0xbe]), null);
    expect(short.state).toBe("unrecognized");
    expect(short.limitations.join(" ")).toMatch(/cannot be told apart/u);
  });

  it("establishes package roles from bytes where structure allows", () => {
    const deb = Buffer.alloc(80, 0x20);
    deb.write("!<arch>\n", 0, "latin1");
    deb.write("debian-binary/", 8, "latin1");
    expect(formats(detect(deb, "tool.deb"))).toEqual(["ar", "deb"]);
    const appImage = Buffer.alloc(64);
    appImage.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0x41, 0x49, 0x02]);
    const detection = detect(appImage, "Tool.AppImage");
    expect(formats(detection)).toEqual(["elf", "appimage"]);
    expect(candidate(detection, "appimage")).toMatchObject({
      basis: "byte-structure",
      version: "2",
      evidence: { offset: 8, length: 3, observed_hex: "414902" },
    });
  });

  it("corroborates a ZIP-carried role from its name only", () => {
    const zip = Buffer.from("PK\x03\x04rest-of-archive", "latin1");
    const detection = detect(zip, "library.jar");
    expect(formats(detection)).toEqual(["zip", "jar"]);
    expect(candidate(detection, "jar")).toMatchObject({
      basis: "name-corroborated",
      evidence: null,
    });
    expect(formats(detect(zip, "archive.zip"))).toEqual(["zip"]);
    expect(formats(detect(zip, "app.apk"))).toEqual(["zip", "apk"]);
  });

  it("reports every remaining magic at its exact location", () => {
    const cases: readonly [string, Buffer, string, string | null][] = [
      ["xz", Buffer.from("fd377a585a0000", "hex"), "x.xz", null],
      ["bzip2", Buffer.from("BZh91AY&SY", "latin1"), "x.bz2", null],
      ["zstd", Buffer.from("28b52ffd00", "hex"), "x.zst", null],
      ["7z", Buffer.from("377abcaf271c0004", "hex"), "x.7z", "0.4"],
      ["rar", Buffer.from("Rar!\x1a\x07\x01\x00", "latin1"), "x.rar", "5"],
      ["rar", Buffer.from("Rar!\x1a\x07\x00", "latin1"), "x.rar", "4"],
      ["sqlite", Buffer.from("SQLite format 3\0", "latin1"), "x.db", null],
      ["ole-compound", Buffer.from("d0cf11e0a1b11ae1", "hex"), "x.bin", null],
      ["rpm", Buffer.from("edabeedb03000000", "hex"), "x.rpm", null],
      ["pdf", Buffer.from("%PDF-1.7\n", "latin1"), "x.pdf", "1.7"],
      ["dalvik-dex", Buffer.from("dex\n035\0", "latin1"), "classes.dex", "035"],
      ["squashfs", Buffer.from("hsqs", "latin1"), "x.squashfs", null],
      [
        "pdb-msf",
        Buffer.from("Microsoft C/C++ MSF 7.00\r\n\x1aDS\0\0\0", "latin1"),
        "x.pdb",
        null,
      ],
      ["xar", Buffer.from("xar!\0\x1c", "latin1"), "x.xar", null],
      ["ar", Buffer.from("!<thin>\n", "latin1"), "libthin.a", null],
    ];
    for (const [format, bytes, name, version] of cases) {
      const detection = detect(bytes, name);
      const found = candidate(detection, format);
      expect(found.evidence?.offset, format).toBe(0);
      expect(found.evidence?.observed_hex, format).toBe(
        bytes.subarray(0, found.evidence?.length).toString("hex"),
      );
      expect(found.version, format).toBe(version);
      expect(detection.contradictions, format).toEqual([]);
    }
  });

  it("establishes a disk image from its trailer only", () => {
    const size = 4_096;
    const trailer = Buffer.alloc(UDIF_TRAILER_BYTES);
    trailer.write("koly", 0, "ascii");
    const prefix = Buffer.alloc(64);
    const detection = detect(prefix, "Installer.dmg", trailer, size);
    expect(candidate(detection, "udif").evidence).toEqual({
      offset: size - UDIF_TRAILER_BYTES,
      length: 4,
      observed_hex: "6b6f6c79",
    });
    expect(detection.examined.trailer_offset).toBe(size - UDIF_TRAILER_BYTES);
    const unread = detect(prefix, "Installer.dmg", null, size);
    expect(unread.limitations.join(" ")).toMatch(/trailer was not examined/u);
    expect(unread.contradictions).toEqual([]);
  });
});

describe("name hints and contradictions", () => {
  it("names a contradiction when bytes refute a checkable name", () => {
    const detection = detect(Buffer.from("not a database"), "records.db");
    expect(detection.state).toBe("unrecognized");
    expect(detection.contradictions).toEqual([
      {
        hinted: ["sqlite"],
        detail:
          "The .db name suggests sqlite, but the examined bytes do not match.",
      },
    ]);
    const jar = detect(Buffer.from("plain text"), "library.jar");
    expect(jar.contradictions[0]?.hinted).toEqual(["jar"]);
  });

  it("keeps names without a byte signature as hints, not contradictions", () => {
    for (const name of ["notes.txt", "data.json", "Info.plist", "a.py"]) {
      const detection = detect(Buffer.from("{}\n"), name);
      expect(detection.contradictions, name).toEqual([]);
      expect(detection.name_hint.formats.length, name).toBeGreaterThan(0);
    }
    const unnamed = detect(Buffer.from("{}\n"), null);
    expect(unnamed.name_hint).toEqual({ extension: null, formats: [] });
    expect(unnamed.state).toBe("unrecognized");
  });

  it("claims no contradiction the examined bytes cannot settle", () => {
    // A PE header beyond the examined prefix leaves the MZ image unclassified.
    const distantPe = Buffer.alloc(FORMAT_SIGNATURE_PREFIX_BYTES + 512);
    distantPe.write("MZ", 0, "latin1");
    distantPe.writeUInt32LE(FORMAT_SIGNATURE_PREFIX_BYTES + 64, 0x3c);
    distantPe.write("PE\0\0", FORMAT_SIGNATURE_PREFIX_BYTES + 64, "latin1");
    const exe = detect(distantPe, "setup.exe");
    expect(exe.candidates).toEqual([]);
    expect(exe.contradictions).toEqual([]);
    expect(exe.limitations.join(" ")).toMatch(/MZ signature was seen/u);
    // Four bytes of 0xCAFEBABE cannot tell a class file from a fat header.
    const shortClass = detect(classFile(52).subarray(0, 4), "A.class", null, 4);
    expect(shortClass.contradictions).toEqual([]);
    // A prefix shorter than the signature window of a longer file.
    const tar = ustarHeader(false);
    const truncated = detectFormatCandidates({
      prefix: tar.subarray(0, 100),
      fileSize: tar.length,
      name: "layers.tar",
    });
    expect(truncated.contradictions).toEqual([]);
    expect(truncated.limitations.join(" ")).toMatch(/not checked/u);
    // Universal binaries wrap Mach-O images and static archives.
    for (const name of ["libz.dylib", "libz.a"]) {
      const fat = detect(fatHeader(2), name);
      expect(formats(fat), name).toEqual(["mach-o-universal"]);
      expect(fat.contradictions, name).toEqual([]);
    }
    expect(
      detect(Buffer.from("plain text"), "libz.dylib").contradictions,
    ).not.toEqual([]);
  });

  it("leaves a PDF header after leading bytes undecided", () => {
    const shifted = Buffer.from("\r\n\r\n%PDF-1.7\n%\xe2\xe3\n", "latin1");
    const detection = detect(shifted, "report.pdf");
    expect(detection.candidates).toEqual([]);
    expect(detection.contradictions).toEqual([]);
    expect(detection.limitations.join(" ")).toMatch(/after 4 leading bytes/u);
    const atStart = detect(Buffer.from("%PDF-1.7\n"), "report.pdf");
    expect(candidate(atStart, "pdf").evidence?.offset).toBe(0);
    expect(atStart.contradictions).toEqual([]);
    const notPdf = detect(Buffer.from("<html></html>"), "report.pdf");
    expect(notPdf.contradictions[0]?.hinted).toEqual(["pdf"]);
  });

  it("keeps the byte observation when it disagrees with the name", () => {
    const detection = detect(EMPTY_WASM_MODULE, "image.png.zip");
    expect(formats(detection)).toEqual(["wasm-binary", "wasm-module"]);
    expect(detection.contradictions[0]?.hinted).toEqual(["zip"]);
  });
});

describe("detection boundary", () => {
  it("reads only the bytes it is given and never mutates them", () => {
    const bytes = Buffer.concat([EMPTY_WASM_MODULE, Buffer.alloc(16)]);
    const before = Buffer.from(bytes);
    const detection = detect(bytes, "module.wasm");
    expect(bytes.equals(before)).toBe(true);
    expect(detection.examined).toEqual({
      file_size: bytes.length,
      prefix_bytes: bytes.length,
      trailer_offset: null,
    });
    expect(formatDetectionSchema.parse(detection)).toEqual(detection);
  });

  it("ignores a trailer for files too small to carry one", () => {
    const tiny = detect(Buffer.from("koly"), "x.dmg", Buffer.from("koly"), 4);
    expect(tiny.examined.trailer_offset).toBeNull();
    expect(formats(tiny)).toEqual([]);
  });

  it("shares the XAR and UDIF predicates used by inventory and targets", () => {
    expect(hasXarSignature(Buffer.from("xar!"))).toBe(true);
    expect(hasXarSignature(Buffer.from("xar"))).toBe(false);
    expect(hasUdifTrailer(Buffer.from("koly"))).toBe(true);
    expect(hasUdifTrailer(Buffer.from("kol"))).toBe(false);
  });
});
