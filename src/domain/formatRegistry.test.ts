import { describe, expect, it } from "vitest";

import {
  formatFacetSchema,
  formatFamilySchema,
  formatIdSchema,
  PACKAGE_ROLE_IDS,
  SEMANTIC_PROFILE_IDS,
  STORAGE_FORMAT_IDS,
  type FormatId,
} from "./formatIdentifiers.js";
import {
  ARTIFACT_GRAPH_FORMAT_IDS,
  advertisedFormats,
  facetCoverageSchema,
  formatCapabilities,
  formatCapability,
  formatEntry,
  formatsHintedByName,
  HOSTED_CAPABILITY_CONTEXT,
  parseFormatId,
  type CapabilityContext,
} from "./formatRegistry.js";
import { FORMAT_REGISTRY } from "./formatRegistryEntries.js";
import { ZIP_PACKAGE_FORMATS } from "./zipPackageFormat.js";
import {
  ARCHIVE_STREAM_FORMATS,
  isArchiveStreamFormat,
  isContainerImageFormat,
} from "./archiveStreamFormat.js";

const LOCAL_DARWIN: CapabilityContext = {
  surface: "local",
  platform: "darwin",
};
const LOCAL_LINUX: CapabilityContext = { surface: "local", platform: "linux" };
const CONTEXTS = [LOCAL_DARWIN, LOCAL_LINUX, HOSTED_CAPABILITY_CONTEXT];

describe("format registry identity", () => {
  it("keeps one entry per identifier, unique across dimensions", () => {
    const ids = FORMAT_REGISTRY.map((format) => format.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...formatIdSchema.options].sort());
    const dimensions = [
      ["storage", STORAGE_FORMAT_IDS],
      ["package-role", PACKAGE_ROLE_IDS],
      ["semantic-profile", SEMANTIC_PROFILE_IDS],
    ] as const;
    for (const [dimension, members] of dimensions)
      for (const id of members)
        expect(formatEntry(id).dimension).toBe(dimension);
  });

  it("layers roles and profiles only on registered storage formats", () => {
    for (const format of FORMAT_REGISTRY) {
      if (format.dimension === "storage") expect(format.storage).toEqual([]);
      for (const storage of format.storage)
        expect(formatEntry(storage).dimension).toBe("storage");
      for (const extension of format.extensions)
        expect(extension).toMatch(/^\.[a-z0-9.]+$/u);
    }
  });

  it("maps every artifact-graph format, keeping file and unknown unrecognized", () => {
    for (const [graphFormat, id] of Object.entries(ARTIFACT_GRAPH_FORMAT_IDS)) {
      if (graphFormat === "file" || graphFormat === "unknown")
        expect(id).toBeNull();
      else
        expect(id === null ? null : formatEntry(id).family).toBe(
          ["deb", "rpm", "squashfs", "appimage"].includes(graphFormat)
            ? "F05"
            : ["msi", "msixbundle", "appxbundle"].includes(graphFormat)
              ? "F08"
              : isContainerImageFormat(graphFormat)
                ? "F09"
                : isArchiveStreamFormat(graphFormat)
                  ? "F06"
                  : "existing",
        );
    }
    for (const zip of ZIP_PACKAGE_FORMATS)
      expect(ARTIFACT_GRAPH_FORMAT_IDS[zip]).toBe(zip);
  });

  it("parses untrusted identifiers into a tagged failure", () => {
    expect(parseFormatId("wheel")).toEqual({ ok: true, value: "wheel" });
    for (const value of ["exe", "", 7, null, "ZIP"]) {
      const parsed = parseFormatId(value);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.error._tag).toBe("UnknownFormatIdError");
        expect(parsed.error.value).toBe(value);
      }
    }
  });
});

describe("format expansion scope", () => {
  // Admitted inputs from section 3 of the format expansion specification.
  const SPEC_SCOPE: Readonly<Record<string, readonly string[]>> = {
    F01: [".wasm", ".wat"],
    F02: [".class", ".jar", ".aar"],
    F03: [".py", ".pyc", ".whl", ".pyz"],
    F04: [".dex", ".aab", ".apks", ".xapk"],
    F05: [".deb", ".rpm", ".AppImage"],
    F06: [
      ".tar",
      ".tar.gz",
      ".tgz",
      ".gz",
      ".xz",
      ".tar.xz",
      ".txz",
      ".7z",
      ".rar",
    ],
    F07: [".sqlite", ".sqlite3", ".db"],
    F08: [".msi", ".msixbundle", ".appxbundle"],
    F09: [".tar"],
    F10: [".pdb", ".dSYM", ".debug"],
    F11: [
      ".md",
      ".markdown",
      ".json",
      ".jsonl",
      ".yaml",
      ".yml",
      ".toml",
      ".xml",
      ".csv",
      ".tsv",
      ".txt",
    ],
    F12: [
      ".pdf",
      ".docx",
      ".xlsx",
      ".pptx",
      ".doc",
      ".xls",
      ".ppt",
      ".docm",
      ".xlsm",
      ".pptm",
    ],
  };

  it("names a registry format for every admitted input of every family", () => {
    for (const [family, extensions] of Object.entries(SPEC_SCOPE))
      for (const extension of extensions) {
        const hint = formatsHintedByName(`sample${extension}`);
        expect(hint.extension, `${family} ${extension}`).toBe(
          extension.toLowerCase(),
        );
        expect(
          hint.formats.some((id) => formatEntry(id).family === family),
          `${family} ${extension}`,
        ).toBe(true);
      }
    for (const family of formatFamilySchema.options)
      expect(FORMAT_REGISTRY.some((format) => format.family === family)).toBe(
        true,
      );
  });

  it("prefers the longest name suffix and ignores bare suffix names", () => {
    expect(formatsHintedByName("release.TAR.GZ")).toEqual({
      extension: ".tar.gz",
      formats: ["gzip"],
    });
    expect(formatsHintedByName("image.tar").formats).toEqual([
      "tar",
      "oci-image-archive",
      "docker-save-archive",
    ]);
    expect(formatsHintedByName("README")).toEqual({
      extension: null,
      formats: [],
    });
    expect(formatsHintedByName(".zip").formats).toEqual([]);
  });
});

/** Families whose milestone acceptance passed and which may be advertised. */
const IMPLEMENTED_FAMILIES: readonly string[] = [
  "existing",
  "F01",
  "F02",
  "F03",
  "F04",
  "F05",
  "F08",
  // F10 part 1 reads DWARF; PDB (pdb-msf) is still planned and is held to the planned rule below.
  "F10",
  "F11",
  // F12 parts 1 to 3 read Office Open XML, PDF and legacy Office files.
  "F12",
];

/** Formats inside an implemented family whose reader is not built yet. */
const STILL_PLANNED: readonly string[] = ["pdb-msf"];

describe("capability states", () => {
  it("advertises only existing formats and implemented families", () => {
    for (const context of CONTEXTS)
      for (const format of advertisedFormats(context))
        if (!isArchiveStreamFormat(format.id))
          expect(
            IMPLEMENTED_FAMILIES,
            `${format.id} ${context.surface}`,
          ).toContain(format.family);
  });

  it("declares the F06 archive facets that passed their real-producer checks", () => {
    for (const context of CONTEXTS) {
      for (const id of ["tar", "gzip"] as const) {
        expect(formatCapability(id, "inventory", context).state).toBe(
          "partial",
        );
        expect(formatCapability(id, "extract", context).state).toBe("partial");
      }
      expect(formatCapability("rar", "identify", context).state).toBe(
        "complete",
      );
      expect(formatCapability("rar", "inventory", context).reason).toMatch(
        /No real RAR producer/u,
      );
      for (const id of ["bzip2", "zstd"] as const)
        expect(formatCapability(id, "inventory", context).state).toBe(
          "unsupported",
        );
    }
    for (const id of ["xz", "7z", "iso"] as const) {
      expect(formatCapability(id, "inventory", LOCAL_DARWIN).state).toBe(
        "partial",
      );
      const hosted = formatCapability(id, "extract", HOSTED_CAPABILITY_CONTEXT);
      expect(hosted.state).toBe("unavailable");
      expect(hosted.reason).toMatch(/external decoders/u);
    }
  });

  it("declares structured text (F11) without claiming members or reconstruction", () => {
    for (const format of FORMAT_REGISTRY.filter(
      (entry) => entry.family === "F11",
    ))
      for (const context of CONTEXTS) {
        const capabilities = formatCapabilities(format.id, context).facets;
        expect(capabilities.identify.state).toBe("partial");
        expect(["complete", "partial"]).toContain(capabilities.inspect.state);
        for (const facet of ["inventory", "extract", "reconstruct"] as const)
          expect(capabilities[facet].state).toBe("unsupported");
      }
    expect(formatCapability("json", "inspect", LOCAL_LINUX).state).toBe(
      "complete",
    );
    expect(formatCapability("toml", "inspect", LOCAL_LINUX).state).toBe(
      "partial",
    );
    expect(
      formatCapability("json", "inspect", HOSTED_CAPABILITY_CONTEXT).reason,
    ).toMatch(/16 MiB/u);
  });

  it("keeps every planned format unsupported on every facet with its milestone", () => {
    for (const format of FORMAT_REGISTRY.filter(
      (entry) =>
        (!IMPLEMENTED_FAMILIES.includes(entry.family) ||
          STILL_PLANNED.includes(entry.id)) &&
        !isArchiveStreamFormat(entry.id),
    ))
      for (const context of CONTEXTS)
        for (const facet of formatFacetSchema.options) {
          const capability = formatCapability(format.id, facet, context);
          expect(capability.state).toBe("unsupported");
          expect(capability.reason).toMatch(
            new RegExp(
              `^Format expansion ${format.family} is planned for milestone P[1-5]`,
              "u",
            ),
          );
        }
  });

  it("resolves host-bound facets to unavailable instead of unsupported", () => {
    expect(
      formatCapability("mach-o-universal", "inventory", LOCAL_DARWIN).state,
    ).toBe("complete");
    for (const context of [LOCAL_LINUX, HOSTED_CAPABILITY_CONTEXT]) {
      const resolved = formatCapability("mach-o-universal", "extract", context);
      expect(resolved.state).toBe("unavailable");
      expect(resolved.reason).toMatch(/macOS/u);
    }
    expect(
      formatCapability("udif", "inventory", HOSTED_CAPABILITY_CONTEXT).state,
    ).toBe("unavailable");
    expect(formatCapability("udif", "extract", LOCAL_DARWIN).state).toBe(
      "unsupported",
    );
  });

  it("claims nothing for an undeclared facet and states partial reasons", () => {
    const elf = formatCapabilities("elf", LOCAL_DARWIN);
    expect(elf.facets.identify).toEqual({ state: "complete", reason: null });
    expect(elf.facets.inspect.state).toBe("unsupported");
    expect(elf.facets.inspect.reason).toMatch(/No inspect capability/u);
    const apk = formatCapabilities("apk", HOSTED_CAPABILITY_CONTEXT);
    expect(apk.facets.identify.state).toBe("partial");
    expect(apk.facets.inventory.state).toBe("partial");
    expect(apk.facets.extract.state).toBe("complete");
    for (const id of formatIdSchema.options as readonly FormatId[])
      for (const context of CONTEXTS)
        for (const [facet, capability] of Object.entries(
          formatCapabilities(id, context).facets,
        ))
          if (capability.state !== "complete")
            expect(capability.reason, `${id} ${facet}`).not.toBeNull();
  });

  it("claims only the identification the artifact pipeline performs", () => {
    // A standalone XAR is a plain file to the graph; only .pkg checks it.
    for (const context of CONTEXTS) {
      const xar = formatCapability("xar", "identify", context);
      expect(xar.state).toBe("partial");
      expect(xar.reason).toMatch(/\.pkg/u);
    }
    // COM programs are identified only by an explicit local target format.
    expect(formatCapability("dos-com", "identify", LOCAL_DARWIN).state).toBe(
      "partial",
    );
    expect(
      formatCapability("dos-com", "identify", HOSTED_CAPABILITY_CONTEXT).state,
    ).toBe("unsupported");
  });

  it("never declares not_requested statically; only a result can", () => {
    for (const format of FORMAT_REGISTRY)
      for (const surface of Object.values(format.capabilities))
        for (const declaration of Object.values(surface))
          expect(declaration.state).not.toBe("not_requested");
  });
});

describe("facet coverage contract", () => {
  const base = {
    facet: "inventory",
    examined: null,
    omitted: null,
    reason: null,
    continuation: null,
  } as const;

  it("accepts each state with its required explanation", () => {
    for (const coverage of [
      {
        ...base,
        state: "complete",
        examined: "All 12 central-directory entries.",
      },
      {
        ...base,
        state: "partial",
        examined: "First 1,000 entries.",
        omitted: "2,500 later entries.",
        reason: "The hosted entry budget is 1,000.",
        continuation: "offset=1000",
      },
      { ...base, state: "unsupported", reason: "No RAR reader is admitted." },
      { ...base, state: "unavailable", reason: "7-Zip is not installed." },
      { ...base, state: "not_requested" },
    ])
      expect(facetCoverageSchema.safeParse(coverage).success).toBe(true);
  });

  it("refuses coverage that hides an omission or claims unexamined scope", () => {
    for (const coverage of [
      { ...base, state: "complete" },
      { ...base, state: "complete", examined: "All.", omitted: "Some." },
      { ...base, state: "partial", examined: "Some.", reason: "Budget." },
      { ...base, state: "unsupported" },
      { ...base, state: "unavailable", reason: "Missing.", examined: "All." },
      { ...base, state: "not_requested", examined: "All." },
      { ...base, state: "complete", examined: "All.", extra: true },
    ])
      expect(facetCoverageSchema.safeParse(coverage).success).toBe(false);
  });
});

describe("WebAssembly capability declarations", () => {
  it("declares WebAssembly (F01) without members, with local C translation partial for core modules and none hosted", () => {
    for (const format of FORMAT_REGISTRY.filter(
      (entry) => entry.family === "F01",
    ))
      for (const context of CONTEXTS) {
        const capabilities = formatCapabilities(format.id, context).facets;
        for (const facet of ["inventory", "extract"] as const)
          expect(capabilities[facet].state).toBe("unsupported");
        expect(capabilities.reconstruct.state).toBe(
          context.surface === "local" && format.id !== "wasm-component"
            ? "partial"
            : "unsupported",
        );
      }
    expect(
      formatCapability("wasm-module", "reconstruct", LOCAL_DARWIN).reason,
    ).toMatch(/convert_wasm_to_c/u);
    for (const context of CONTEXTS) {
      expect(formatCapability("wasm-module", "inspect", context).state).toBe(
        "partial",
      );
      expect(
        formatCapability("wasm-component", "identify", context).state,
      ).toBe("complete");
      expect(formatCapability("wasm-component", "inspect", context).state).toBe(
        "unsupported",
      );
    }
    expect(formatCapability("wasm-text", "inspect", LOCAL_LINUX).state).toBe(
      "partial",
    );
    expect(
      formatCapability("wasm-text", "inspect", HOSTED_CAPABILITY_CONTEXT).state,
    ).toBe("unsupported");
    expect(
      formatCapability("wasm-module", "inspect", HOSTED_CAPABILITY_CONTEXT)
        .reason,
    ).toMatch(/32 MiB/u);
  });
});

describe("JVM capability declarations", () => {
  it("declares JVM formats (F02) locally, with reconstruction partial and nothing decoded by the hosted service", () => {
    for (const id of ["jvm-classfile", "jar", "aar"] as const) {
      for (const context of CONTEXTS) {
        expect(formatCapability(id, "identify", context).state).toBe(
          "complete",
        );
      }
      for (const context of [LOCAL_DARWIN, LOCAL_LINUX]) {
        expect(formatCapability(id, "inspect", context).state).toBe("partial");
        expect(formatCapability(id, "reconstruct", context).state).toBe(
          "partial",
        );
      }
      expect(
        formatCapability(id, "reconstruct", HOSTED_CAPABILITY_CONTEXT).state,
      ).toBe("unsupported");
      expect(
        formatCapability(id, "inspect", HOSTED_CAPABILITY_CONTEXT).state,
      ).toBe("unsupported");
    }
    expect(formatCapability("jar", "inventory", LOCAL_LINUX).state).toBe(
      "complete",
    );
    expect(
      formatCapability("jvm-classfile", "inventory", LOCAL_LINUX).state,
    ).toBe("unsupported");
  });
});

describe("Python capability declarations", () => {
  it("declares Python formats (F03) locally, with bytecode reconstruction partial and nothing decoded by the hosted service", () => {
    for (const id of [
      "python-source",
      "cpython-bytecode",
      "wheel",
      "pyz",
    ] as const) {
      for (const context of [LOCAL_DARWIN, LOCAL_LINUX]) {
        expect(formatCapability(id, "inspect", context).state).toBe("partial");
        expect(formatCapability(id, "reconstruct", context).state).toBe(
          id === "python-source" ? "unsupported" : "partial",
        );
      }
      expect(
        formatCapability(id, "inspect", HOSTED_CAPABILITY_CONTEXT).state,
      ).toBe("unsupported");
      expect(
        formatCapability(id, "reconstruct", HOSTED_CAPABILITY_CONTEXT).state,
      ).toBe("unsupported");
    }
    expect(formatCapability("wheel", "extract", LOCAL_LINUX).state).toBe(
      "complete",
    );
    expect(formatCapability("pyz", "extract", LOCAL_LINUX).state).toBe(
      "unsupported",
    );
    expect(
      formatCapability("cpython-bytecode", "identify", LOCAL_LINUX).state,
    ).toBe("partial");
  });
});

describe("Android capability declarations", () => {
  it("declares Android formats (F04) locally, with class reconstruction partial and nothing decoded by the hosted service", () => {
    for (const id of [
      "dalvik-dex",
      "apk",
      "android-app-bundle",
      "apks",
      "xapk",
    ] as const) {
      for (const context of [LOCAL_DARWIN, LOCAL_LINUX]) {
        expect(formatCapability(id, "inspect", context).state).toBe("partial");
        expect(formatCapability(id, "reconstruct", context).state).toBe(
          "partial",
        );
      }
      expect(
        formatCapability(id, "inspect", HOSTED_CAPABILITY_CONTEXT).state,
      ).toBe("unsupported");
      expect(
        formatCapability(id, "reconstruct", HOSTED_CAPABILITY_CONTEXT).state,
      ).toBe("unsupported");
    }
    expect(formatCapability("apks", "extract", LOCAL_LINUX).state).toBe(
      "complete",
    );
    expect(formatCapability("dalvik-dex", "inventory", LOCAL_LINUX).state).toBe(
      "unsupported",
    );
    expect(formatCapability("xapk", "identify", LOCAL_LINUX).state).toBe(
      "partial",
    );
    expect(formatCapability("apk", "inspect", LOCAL_LINUX).state).toBe(
      "partial",
    );
    expect(
      formatCapability("apk", "inspect", HOSTED_CAPABILITY_CONTEXT).state,
    ).toBe("unsupported");
  });
});

describe("Linux package capability declarations", () => {
  it("declares Linux packages (F05) locally, with filesystem images local only", () => {
    for (const id of ["deb", "rpm", "appimage", "squashfs"] as const) {
      for (const context of [LOCAL_DARWIN, LOCAL_LINUX]) {
        expect(formatCapability(id, "inventory", context).state).toBe(
          "partial",
        );
        expect(formatCapability(id, "inspect", context).state).toBe("partial");
        expect(formatCapability(id, "reconstruct", context).state).toBe(
          "unsupported",
        );
      }
      expect(
        formatCapability(id, "inspect", HOSTED_CAPABILITY_CONTEXT).state,
      ).toBe("unsupported");
    }
    for (const id of ["deb", "rpm"] as const)
      expect(
        formatCapability(id, "extract", HOSTED_CAPABILITY_CONTEXT).reason,
      ).toMatch(/xz and lzma need the external decoder/u);
    for (const id of ["appimage", "squashfs"] as const) {
      expect(
        formatCapability(id, "inventory", HOSTED_CAPABILITY_CONTEXT).state,
      ).toBe("partial");
      expect(
        formatCapability(id, "extract", HOSTED_CAPABILITY_CONTEXT).state,
      ).toBe("unsupported");
    }
    expect(formatCapability("ar", "inventory", LOCAL_LINUX).state).toBe(
      "unsupported",
    );
  });
});

describe("Windows installer capability declarations", () => {
  it("declares MSI and MSIX bundles (F08) locally; hosted lists and extracts but does not inspect", () => {
    for (const id of ["msi", "msixbundle", "appxbundle"] as const) {
      for (const context of [LOCAL_DARWIN, LOCAL_LINUX])
        expect(formatCapability(id, "inspect", context).state).toBe("partial");
      expect(
        formatCapability(id, "inspect", HOSTED_CAPABILITY_CONTEXT).state,
      ).toBe("unsupported");
    }
    expect(
      formatCapability("msi", "extract", HOSTED_CAPABILITY_CONTEXT).state,
    ).toBe("partial");
    expect(formatCapability("msi", "inventory", LOCAL_LINUX).reason).toMatch(
      /External cabinets are not searched for/u,
    );
    expect(
      formatCapability("ole-compound", "inventory", LOCAL_LINUX).state,
    ).toBe("unsupported");
  });
});
