import {
  readGoBinaryImage,
  GoBinaryFormatFailure,
} from "../go/GoBinaryImage.js";
import { parseGoModuleBytes, parseGoModuleText } from "../go/GoModuleText.js";
import { readRustBinaryImage } from "../rust/RustBinaryImage.js";
import { RustAuditableFormatFailure } from "../rust/RustAuditableReader.js";
import type { SbomBuilder, SbomSource } from "./sbomMetadata.js";

export const inspectNative = (
  builder: SbomBuilder,
  source: SbomSource,
  bytes: Buffer,
): void => {
  try {
    const info = readGoBinaryImage(bytes).build_info;
    if (info !== null) {
      const module =
        info.module_text === null
          ? parseGoModuleBytes(
              Buffer.from(info.module_bytes_base64, "base64").subarray(16, -16),
            )
          : parseGoModuleText(info.module_text);
      const refs = [module.main, ...module.dependencies].map((pkg) => {
        if (pkg === null) return null;
        const actual = pkg.replacement ?? pkg;
        const version =
          actual.version === "" || actual.version === "(devel)"
            ? undefined
            : actual.version;
        return builder.add("golang", source, {
          name: actual.path || undefined,
          version,
          properties: {
            "oopsware:go:declared_module": JSON.stringify(pkg),
            "oopsware:go:compiler": info.go_version ?? "unknown",
            "oopsware:go:module_offset": String(info.module_location.offset),
          },
        });
      });
      // Build info gives a dependency inventory, not direct edges from the main module.
      if (refs.some((ref) => ref !== null))
        builder.limitation(
          "Go build information lists modules used by the build; direct dependency edges, licenses and package authenticity are unknown. Replacements are reported as the effective module and retain the original declaration.",
        );
      if (!module.complete)
        builder.limitation(
          `${source.path}: Go module metadata has unparsed records; component coverage is partial.`,
        );
    }
  } catch (cause) {
    if (!(cause instanceof GoBinaryFormatFailure)) throw cause;
    builder.limitation(
      `${source.path}: Go metadata could not be read: ${cause.message}`,
    );
  }
  try {
    const metadata = readRustBinaryImage(bytes).auditable_metadata;
    if (metadata === null) return;
    const refs = metadata.packages.map((pkg) =>
      builder.add("cargo", source, {
        name: pkg.name,
        version: pkg.version,
        properties: {
          "oopsware:cargo:source": pkg.source,
          "oopsware:cargo:kind": pkg.kind ?? "unknown",
          "oopsware:cargo:root": String(pkg.root),
          "oopsware:cargo:section_offset": String(metadata.file_offset),
        },
      }),
    );
    metadata.packages.forEach((pkg, index) => {
      const ref = refs[index];
      if (ref !== null && ref !== undefined)
        builder.edges(
          ref,
          pkg.dependencies.flatMap((at) => refs[at] ?? []),
        );
    });
    builder.limitation(
      "cargo-auditable dependency declarations are embedded claims; licenses, authenticity and dependencies omitted by the producer are unknown.",
    );
  } catch (cause) {
    if (!(cause instanceof RustAuditableFormatFailure)) throw cause;
    builder.limitation(
      `${source.path}: Rust metadata could not be read: ${cause.message}`,
    );
  }
};
