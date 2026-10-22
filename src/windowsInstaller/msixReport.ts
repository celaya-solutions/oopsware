import {
  type DecodeBudget,
  MemberReadFailure,
  ZipView,
} from "../artifacts/zipMemberView.js";
import {
  appxManifestSchema,
  type MsixPackageReport,
} from "../domain/windowsInstaller/msixPackage.js";
import { checkBundleLayout, parseAppxBundleManifest } from "./appx/bundle.js";
import { parseAppxBlockMap, verifyBlockMap } from "./appx/blockMap.js";
import { parseAppxManifest } from "./appx/manifest.js";
import { readAppxSignature } from "./appx/signature.js";

type Report = MsixPackageReport;
type Parts = NonNullable<Report["parts"]>;
type Diagnostic = Report["diagnostics"][number];

const MANIFEST = "AppxManifest.xml";
const BUNDLE_MANIFEST = "AppxMetadata/AppxBundleManifest.xml";
const BLOCK_MAP = "AppxBlockMap.xml";
const SIGNATURE = "AppxSignature.p7x";
const CODE_INTEGRITY = "AppxMetadata/CodeIntegrity.cat";
const CONTENT_TYPES = "[Content_Types].xml";

/** A ZIP without an AppX manifest or bundle manifest. */
export class NotMsixPackageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotMsixPackageError";
  }
}

/** The selection a caller has to change; the message names the packages. */
export class MsixSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MsixSelectionError";
  }
}

const recoverable = (cause: unknown): cause is MemberReadFailure =>
  cause instanceof MemberReadFailure && cause.reason !== "cancelled";

/** One package's manifest, block map (recomputed), signature part and markers. */
const packageParts = async (
  zip: ZipView,
  container: string | null,
  budget: DecodeBudget,
  diagnostics: Diagnostic[],
  signal?: AbortSignal,
): Promise<Parts> => {
  const names = zip.members
    .filter((member) => !member.directory)
    .map((member) => member.path);
  const unreadable = new Set<string>();
  const read = async (name: string): Promise<Uint8Array | null> => {
    if (!zip.has(name)) return null;
    try {
      return await zip.read(name, budget, signal);
    } catch (cause) {
      if (!recoverable(cause)) throw cause;
      unreadable.add(name);
      diagnostics.push({
        location: container === null ? name : `${container} ! ${name}`,
        message: cause.message,
      });
      return null;
    }
  };
  let manifest: Parts["manifest"] = null;
  let manifestError: string | null = null;
  const manifestBytes = await read(MANIFEST);
  if (manifestBytes === null) manifestError = `The package has no ${MANIFEST}.`;
  else {
    const parsed = parseAppxManifest(manifestBytes);
    // The schema parse also checks the reader's output against the report contract.
    if (parsed.ok) manifest = appxManifestSchema.parse(parsed.value);
    else manifestError = `${MANIFEST}: ${parsed.error.message}`;
  }
  let blockMap: Parts["block_map"] = null;
  let blockMapError: string | null = null;
  const mapBytes = await read(BLOCK_MAP);
  if (mapBytes === null) blockMapError = `The package has no ${BLOCK_MAP}.`;
  else {
    const parsed = parseAppxBlockMap(mapBytes);
    if (!parsed.ok) blockMapError = `${BLOCK_MAP}: ${parsed.error.message}`;
    else {
      const checked = await verifyBlockMap(parsed.value, (path) => read(path), {
        names,
        ...(signal === undefined ? {} : { signal }),
      });
      blockMap = {
        hash: checked.hash,
        files: checked.files.length,
        verified: checked.verified,
        mismatched: checked.files
          .filter((file) => file.mismatched_blocks.length > 0)
          .map((file) => ({
            path: file.path,
            blocks: [...file.mismatched_blocks],
          })),
        missing: checked.files
          .filter((file) => file.missing && !unreadable.has(file.path))
          .map((file) => file.path),
        unreadable: checked.files
          .filter((file) => file.missing && unreadable.has(file.path))
          .map((file) => file.path),
        size_mismatches: checked.files
          .filter(
            (file) => !file.missing && file.size.declared !== file.size.actual,
          )
          .map((file) => file.path),
        unlisted: [...checked.unlisted],
      };
    }
  }
  const signatureBytes = await read(SIGNATURE);
  const signature =
    signatureBytes === null ? null : readAppxSignature(signatureBytes);
  return {
    container,
    manifest,
    manifest_error: manifestError,
    block_map: blockMap,
    block_map_error: blockMapError,
    signature:
      signature === null
        ? null
        : {
            bytes: signature.size,
            magic: signature.magic,
            pkcs7_bytes: signature.pkcs7_bytes,
            pkcs7_sha256: signature.pkcs7_sha256,
            der_length: signature.der_length,
            problems: [...signature.problems],
            verified: false,
          },
    code_integrity_catalog: zip.has(CODE_INTEGRITY),
    content_types: zip.has(CONTENT_TYPES),
    members: names.length,
  };
};

/** Data offset of a stored member: after its local header's fixed part, name and extra field. */
const dataOffset = (bytes: Uint8Array, header: number): number | null => {
  if (header + 30 > bytes.length) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(header, true) !== 0x04034b50) return null;
  return (
    header +
    30 +
    view.getUint16(header + 26, true) +
    view.getUint16(header + 28, true)
  );
};

const SUFFIX_KINDS: readonly (readonly [string, Report["package"]["kind"]])[] =
  [
    [".msixbundle", "msixbundle"],
    [".appxbundle", "appxbundle"],
    [".msix", "msix"],
    [".appx", "appx"],
  ];

/** Read an MSIX/AppX package or bundle; `container` names one bundle package to read in full. */
export const readMsixPackage = async (
  bytes: Uint8Array,
  path: string,
  container: string | undefined,
  budget: DecodeBudget,
  signal?: AbortSignal,
): Promise<Omit<Report, "artifact" | "coverage" | "limitations">> => {
  const zip = await ZipView.open(bytes);
  const opened: ZipView[] = [];
  try {
    const diagnostics: Diagnostic[] = [];
    const bundled = zip.has(BUNDLE_MANIFEST);
    if (!bundled && !zip.has(MANIFEST))
      throw new NotMsixPackageError(
        "The ZIP has neither AppxManifest.xml nor AppxMetadata/AppxBundleManifest.xml; it is not an MSIX or AppX package.",
      );
    const hinted = SUFFIX_KINDS.find(([suffix]) =>
      path.toLowerCase().endsWith(suffix),
    )?.[1];
    const kind: Report["package"]["kind"] = bundled
      ? hinted === "appxbundle" || hinted === "appx"
        ? "appxbundle"
        : "msixbundle"
      : hinted === "appx" || hinted === "appxbundle"
        ? "appx"
        : "msix";
    const nameConflict =
      hinted !== undefined && hinted.endsWith("bundle") !== bundled
        ? `The name suggests ${hinted}; the bytes are ${bundled ? "a bundle" : "a single package"}.`
        : null;
    if (!bundled) {
      if (container !== undefined)
        throw new MsixSelectionError(
          "container names a package inside a bundle; this file is a single package.",
        );
      return {
        package: { kind, basis: "layout", name_conflict: nameConflict },
        parts: await packageParts(zip, null, budget, diagnostics, signal),
        bundle: null,
        diagnostics,
      };
    }
    const manifestBytes = await zip.read(BUNDLE_MANIFEST, budget, signal);
    const parsed = parseAppxBundleManifest(manifestBytes);
    const bundleParts = await packageParts(
      zip,
      null,
      budget,
      diagnostics,
      signal,
    );
    if (!parsed.ok)
      return {
        package: { kind, basis: "layout", name_conflict: nameConflict },
        parts: null,
        bundle: {
          schema_version: null,
          identity: null,
          packages: [],
          optional_bundles: [],
          architectures: [],
          problems: [`${BUNDLE_MANIFEST}: ${parsed.error.message}`],
          parts: bundleParts,
        },
        diagnostics,
      };
    const manifest = parsed.value;
    const members = new Map(zip.members.map((member) => [member.path, member]));
    const layout = checkBundleLayout(manifest, (fileName) => {
      const member = members.get(fileName);
      if (member === undefined) return null;
      const offset = dataOffset(bytes, member.local_header_offset);
      return offset === null
        ? null
        : { data_offset: offset, stored_size: member.stored_bytes };
    });
    const packages: NonNullable<Report["bundle"]>["packages"] = [];
    let selected: Parts | null = null;
    for (const [index, entry] of manifest.packages.entries()) {
      const check = layout[index];
      let identity: NonNullable<
        Report["bundle"]
      >["packages"][number]["manifest_identity"] = null;
      let blockMapVerified: boolean | null = null;
      let error: string | null = null;
      if (entry.file_name !== null && zip.has(entry.file_name)) {
        try {
          const nested = await ZipView.open(
            await zip.read(entry.file_name, budget, signal),
          );
          opened.push(nested);
          const parts = await packageParts(
            nested,
            entry.file_name,
            budget,
            diagnostics,
            signal,
          );
          identity = parts.manifest?.identity ?? null;
          blockMapVerified = parts.block_map?.verified ?? null;
          if (entry.file_name === container) selected = parts;
        } catch (cause) {
          if (
            cause instanceof MemberReadFailure &&
            cause.reason === "cancelled"
          )
            throw cause;
          error = cause instanceof Error ? cause.message : String(cause);
        }
      } else
        error = `${entry.file_name ?? "A package"} is declared but not a member of the bundle.`;
      packages.push({
        ...entry,
        resources: entry.resources.map((resource) => ({ ...resource })),
        target_device_families: entry.target_device_families.map((family) => ({
          ...family,
        })),
        layout_matches: check?.found === true ? check.matches : null,
        actual_offset: check?.offset.actual ?? null,
        actual_size: check?.size.actual ?? null,
        manifest_identity: identity,
        block_map_verified: blockMapVerified,
        error,
      });
      if (check !== undefined && check.found && !check.matches)
        diagnostics.push({
          location: entry.file_name,
          message:
            "The bundle manifest's Offset or Size does not match where the package is in the ZIP.",
        });
    }
    if (container !== undefined && selected === null)
      throw new MsixSelectionError(
        `${container} is not a readable package of this bundle; packages: ${manifest.packages.map((entry) => entry.file_name ?? "?").join(", ")}.`,
      );
    const architectures = [
      ...new Set(
        manifest.packages
          .filter(
            (entry) =>
              entry.type === "application" && entry.architecture !== null,
          )
          .map((entry) => entry.architecture ?? ""),
      ),
    ].sort();
    return {
      package: { kind, basis: "layout", name_conflict: nameConflict },
      parts: selected,
      bundle: {
        schema_version: manifest.schema_version,
        identity: manifest.identity === null ? null : { ...manifest.identity },
        packages,
        optional_bundles: manifest.optional_bundles.map((optional) => ({
          ...optional,
          packages: optional.packages.map((entry) => ({
            ...entry,
            resources: entry.resources.map((resource) => ({ ...resource })),
            target_device_families: entry.target_device_families.map(
              (family) => ({ ...family }),
            ),
          })),
        })),
        architectures,
        problems: [...manifest.problems],
        parts: bundleParts,
      },
      diagnostics,
    };
  } finally {
    await Promise.allSettled([...opened, zip].map((view) => view.close()));
  }
};
