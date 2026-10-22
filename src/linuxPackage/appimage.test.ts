import { execFile } from "node:child_process";
import {
  access,
  constants,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AppImageFormatError,
  hasAppImageMagic,
  readAppImageRuntime,
} from "./appimage.js";
import { parseDesktopEntry } from "./desktopEntry.js";
import {
  expectMatchesUnsquashfs,
  expectSuperblockMatches,
  listEntries,
  memoryImage,
  openImage,
  unsquashfs,
} from "./squashfs/unsquashfs.fixture.js";
import {
  buildLinuxFixtures,
  LINUX_TOOLS,
  type LinuxFixtures,
} from "../../tests/fixtures/linuxProducers.js";
import { removeTestWorkspace } from "../../tests/support/workspace/workspaceFixture.js";

/**
 * The AppImage runtime reader over the pinned type2-runtime ELF files and
 * the AppImages built from them: unsquashfs `-o` confirms where the payload
 * starts, and LLVM's objdump (when installed) lists the same sections and
 * entry point. Runtimes are only read as bytes.
 */

const run = promisify(execFile);
const OBJDUMP = "/usr/bin/objdump";
const HAS_OBJDUMP = await access(OBJDUMP, constants.X_OK).then(
  () => true,
  () => false,
);

let root: string | undefined;
let building: Promise<LinuxFixtures> | undefined;

const fixtures = (): Promise<LinuxFixtures> => {
  building ??= (async () => {
    root = await realpath(
      await mkdtemp(join(await realpath(tmpdir()), "rea-appimage-")),
    );
    return buildLinuxFixtures(root);
  })();
  return building;
};

const useFixtures = () => {
  beforeAll(async () => {
    await fixtures();
  }, 300_000);
};

afterAll(async () => {
  if (root !== undefined) await removeTestWorkspace(root);
});

const runtimeOf = async (bytes: Uint8Array) =>
  readAppImageRuntime(memoryImage(bytes).read, bytes.length);

const ARCHITECTURES = ["x86_64", "aarch64"] as const;

describe.skipIf(LINUX_TOOLS === null)(
  "AppImage payloads against unsquashfs",
  () => {
    useFixtures();

    it.each(ARCHITECTURES)(
      "finds the %s SquashFS image where unsquashfs -o reads it",
      async (architecture) => {
        const path = (await fixtures()).appimage[architecture];
        const bytes = await readFile(path);
        expect(hasAppImageMagic(bytes.subarray(0, 16))).toBe(2);
        const runtime = await runtimeOf(bytes);
        expect(runtime).toMatchObject({
          type: 2,
          elf: { class: "64", endianness: "little", machine: architecture },
          update_information: null,
          signature: null,
          signing_key: null,
          digest_md5: null,
          problems: [],
        });
        // The fixture is the runtime file followed by the image, as appimagetool writes it.
        const runtimeBytes = await readFile(
          join(LINUX_TOOLS?.runtimes ?? "", `runtime-${architecture}`),
        );
        expect(runtime.payload_offset).toBe(runtimeBytes.length);
        const image = await openImage(path, runtime.payload_offset);
        await expectSuperblockMatches(path, image, runtime.payload_offset);
        await expect(
          unsquashfs(["-o", String(runtime.payload_offset + 1), "-s", path]),
        ).rejects.toThrow();
        const { entries } = await expectMatchesUnsquashfs(
          path,
          image,
          runtime.payload_offset,
        );
        expect(entries).toEqual(
          await listEntries(await openImage((await fixtures()).squashfs.zstd)),
        );
      },
    );

    it("parses the AppImage's desktop file as unsquashfs prints it", async () => {
      const path = (await fixtures()).appimage.x86_64;
      const bytes = await readFile(path);
      const runtime = await runtimeOf(bytes);
      const image = await openImage(path, runtime.payload_offset);
      const desktop = await image.find("oops.desktop");
      if (desktop === null) throw new Error("oops.desktop is not listed");
      const chunks: Uint8Array[] = [];
      for await (const chunk of image.read(desktop)) chunks.push(chunk);
      const text = Buffer.concat(chunks).toString("utf8");
      const printed = (
        await unsquashfs([
          "-o",
          String(runtime.payload_offset),
          "-cat",
          path,
          "oops.desktop",
        ])
      ).toString("utf8");
      expect(text).toBe(printed);
      const [header, ...lines] = printed.trimEnd().split("\n");
      expect(header).toBe("[Desktop Entry]");
      expect(parseDesktopEntry(text)).toEqual({
        groups: [
          {
            name: "Desktop Entry",
            entries: lines.map((line) => ({
              key: line.slice(0, line.indexOf("=")),
              locale: null,
              value: line.slice(line.indexOf("=") + 1),
            })),
          },
        ],
        problems: [],
      });
    });
  },
);

/** objdump's file format line, architecture, entry point and sections after the null one. */
const objdump = async (path: string) => {
  const { stdout } = await run(OBJDUMP, [
    "--section-headers",
    "--file-headers",
    path,
  ]);
  return {
    format: /file format (\S+)/u.exec(stdout)?.[1] ?? "",
    architecture: /architecture: (\S+)/u.exec(stdout)?.[1] ?? "",
    start: BigInt(/start address: (0x[0-9a-f]+)/u.exec(stdout)?.[1] ?? "-1"),
    sections: [...stdout.matchAll(/^ *(\d+) (\S*) +([0-9a-f]{8}) /gmu)]
      .filter((match) => match[1] !== "0")
      .map((match) => ({
        name: match[2] ?? "",
        size: Number.parseInt(match[3] ?? "", 16),
      })),
  };
};

const sectionSizes = (runtime: Awaited<ReturnType<typeof runtimeOf>>) =>
  runtime.sections.map(({ name, size }) => ({ name, size }));

describe.skipIf(LINUX_TOOLS === null || !HAS_OBJDUMP)(
  "AppImage runtime ELF against objdump",
  () => {
    useFixtures();

    it.each(ARCHITECTURES)(
      "lists the %s runtime's sections and entry point as objdump does",
      async (architecture) => {
        const path = join(
          LINUX_TOOLS?.runtimes ?? "",
          `runtime-${architecture}`,
        );
        const runtime = await runtimeOf(await readFile(path));
        const view = await objdump(path);
        expect(sectionSizes(runtime)).toEqual(view.sections);
        expect(BigInt(runtime.elf.entry)).toBe(view.start);
        expect(runtime.sections.map((section) => section.name)).toEqual(
          expect.arrayContaining([
            ".upd_info",
            ".sha256_sig",
            ".sig_key",
            ".digest_md5",
            ".shstrtab",
          ]),
        );
      },
    );
  },
);

const CLANG = "/usr/bin/clang";
const HAS_CLANG = await access(CLANG, constants.X_OK).then(
  () => true,
  () => false,
);

/** clang targets for each ELF class and byte order, with objdump's architecture name and ours. */
const ELF_TARGETS = [
  { target: "i386-linux-gnu", architecture: "i386", machine: "x86" },
  { target: "armeb-linux-gnueabi", architecture: "arm", machine: "arm" },
  {
    target: "aarch64_be-linux-gnu",
    architecture: "aarch64_be",
    machine: "aarch64",
  },
  { target: "x86_64-linux-gnu", architecture: "x86_64", machine: "x86_64" },
] as const;

describe.skipIf(!HAS_CLANG || !HAS_OBJDUMP)(
  "ELF headers of every class and byte order against objdump",
  () => {
    it.each(ELF_TARGETS)(
      "reads a $target object as objdump does",
      async ({ target, architecture, machine }) => {
        const directory = await realpath(
          await mkdtemp(join(await realpath(tmpdir()), "rea-elf-")),
        );
        try {
          await writeFile(
            join(directory, "m.c"),
            "int x = 1;\nint main(void) { return x; }\n",
          );
          const object = join(directory, "m.o");
          await run(CLANG, [
            "-target",
            target,
            "-c",
            join(directory, "m.c"),
            "-o",
            object,
          ]);
          const bytes = await readFile(object);
          const runtime = await runtimeOf(bytes);
          const view = await objdump(object);
          expect(view.architecture).toBe(architecture);
          expect(runtime).toMatchObject({
            type: null,
            elf: {
              class: view.format.startsWith("elf32") ? "32" : "64",
              endianness: view.format.includes("big") ? "big" : "little",
              machine,
              type: "relocatable",
            },
            problems: [],
          });
          expect(BigInt(runtime.elf.entry)).toBe(view.start);
          expect(sectionSizes(runtime)).toEqual(view.sections);
          // LLVM writes the section header table last, so the ELF ends where the file does.
          expect(runtime.payload_offset).toBe(bytes.length);
        } finally {
          await removeTestWorkspace(directory);
        }
      },
    );
  },
);

describe.skipIf(LINUX_TOOLS === null)(
  "AppImage runtime sections and types",
  () => {
    useFixtures();

    it("reports update information, signature, key and digest written into the runtime's sections", async () => {
      const bytes = Buffer.from(
        await readFile((await fixtures()).appimage.x86_64),
      );
      const runtime = await runtimeOf(bytes);
      const at = (name: string): number => {
        const section = runtime.sections.find(
          (candidate) => candidate.name === name,
        );
        if (section === undefined) throw new Error(`${name} is missing`);
        return section.offset;
      };
      // What appimagetool -u and --sign write: NUL-padded text in .upd_info, .sha256_sig and .sig_key, and the MD5 in .digest_md5.
      const update =
        "gh-releases-zsync|oops|demo|latest|Oops_Demo-*x86_64.AppImage.zsync";
      const signature =
        "-----BEGIN PGP SIGNATURE-----\n\nAAAA\n-----END PGP SIGNATURE-----\n";
      const key = "-----BEGIN PGP PUBLIC KEY BLOCK-----\n";
      bytes.write(update, at(".upd_info"), "latin1");
      bytes.write(signature, at(".sha256_sig"), "latin1");
      bytes.write(key, at(".sig_key"), "latin1");
      Buffer.from("00112233445566778899aabbccddeeff", "hex").copy(
        bytes,
        at(".digest_md5"),
      );
      expect(await runtimeOf(bytes)).toMatchObject({
        update_information: update,
        signature: { section: ".sha256_sig", bytes: signature.length },
        signing_key: { section: ".sig_key", bytes: key.length },
        digest_md5: "00112233445566778899aabbccddeeff",
        payload_offset: runtime.payload_offset,
      });
    });

    it("identifies type 1, no AppImage magic, and refuses what is not a locatable ELF", async () => {
      const original = await readFile((await fixtures()).appimage.aarch64);
      // Byte 10 (the AppImage type) 2 -> 1: a type 1 magic.
      const typeOne = Buffer.from(original);
      typeOne[10] = 1;
      expect(hasAppImageMagic(typeOne)).toBe(1);
      expect((await runtimeOf(typeOne)).type).toBe(1);
      // Byte 8 "A" -> NUL: an ELF without the AppImage magic.
      const plain = Buffer.from(original);
      plain[8] = 0;
      expect(hasAppImageMagic(plain)).toBeNull();
      expect((await runtimeOf(plain)).type).toBeNull();
      // Byte 0 0x7f -> NUL: not ELF.
      const notElf = Buffer.from(original);
      notElf[0] = 0;
      await expect(runtimeOf(notElf)).rejects.toMatchObject({
        name: "AppImageFormatError",
        offset: 0,
      });
      // The first 100 000 bytes: the section header table lies past the end.
      await expect(runtimeOf(original.subarray(0, 100_000))).rejects.toThrow(
        /Section header table needs bytes/u,
      );
      // e_shnum (offset 60) -> 0: no section headers to locate the payload from.
      const noSections = Buffer.from(original);
      noSections.writeUInt16LE(0, 60);
      await expect(runtimeOf(noSections)).rejects.toBeInstanceOf(
        AppImageFormatError,
      );
    });
  },
);

describe("Desktop entry parsing", () => {
  it("reads groups, localized keys, comments and the string escapes", () => {
    const text = [
      "# A comment before the first group",
      "",
      "[Desktop Entry]",
      "Type=Application",
      "Name=Oops",
      "Name[de_DE@euro]=Hoppla",
      "Comment = spaced\\sout\\ttab\\nline\\rret\\\\slash",
      "Categories=Utility;Dev\\;Tools;",
      "Exec=oops --flag=1 %F",
      "  # indented comment",
      "\r",
      "[Desktop Action New]",
      "Name=New window\r",
    ].join("\n");
    expect(parseDesktopEntry(text)).toEqual({
      groups: [
        {
          name: "Desktop Entry",
          entries: [
            { key: "Type", locale: null, value: "Application" },
            { key: "Name", locale: null, value: "Oops" },
            { key: "Name", locale: "de_DE@euro", value: "Hoppla" },
            {
              key: "Comment",
              locale: null,
              value: "spaced out\ttab\nline\rret\\slash",
            },
            { key: "Categories", locale: null, value: "Utility;Dev\\;Tools;" },
            { key: "Exec", locale: null, value: "oops --flag=1 %F" },
          ],
        },
        {
          name: "Desktop Action New",
          entries: [{ key: "Name", locale: null, value: "New window" }],
        },
      ],
      problems: [],
    });
  });

  it("reports duplicate keys and groups, stray entries and lines that are not entries", () => {
    const parsed = parseDesktopEntry(
      [
        "Name=early",
        "[Other]",
        "Key=1",
        "Key=2",
        "Key[fr]=un",
        "Key[fr]=deux",
        "not an entry",
        "[Other]",
        "Bad Key=3",
      ].join("\n"),
    );
    expect(parsed.problems).toEqual([
      "Line 1: an entry appears before any group.",
      "Line 2: the first group is [Other], not [Desktop Entry].",
      "Line 4: Key appears more than once in [Other].",
      "Line 6: Key[fr] appears more than once in [Other].",
      'Line 7: "not an entry" is not a group header, an entry or a comment.',
      "Line 8: group [Other] appears more than once.",
      'Line 9: "Bad Key=3" is not a group header, an entry or a comment.',
    ]);
    expect(parsed.groups.map((group) => group.entries.length)).toEqual([4, 0]);
  });
});
