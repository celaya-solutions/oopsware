import { MemberReadFailure, sha256Hex } from "../artifacts/zipMemberView.js";
import type {
  AndroidArtifactReport,
  AndroidDiagnostic,
  DexClassSummary,
} from "../domain/android/androidArtifact.js";
import { dexAccessFlags } from "./dex/accessFlags.js";
import { DexFormatError } from "./dex/DexReader.js";
import { DexFile, NO_INDEX } from "./dex/dexFile.js";
import {
  dexOrder,
  isCodeDex,
  type AndroidPackageView,
} from "./package/view.js";

/** Where one DEX file is inside the artifact. */
export interface DexLocation {
  readonly container: string | null;
  readonly entry: string | null;
  readonly module: string | null;
  /** `code`: loaded as app code by the platform; `other`: a DEX elsewhere (assets, raw resources). */
  readonly role: "code" | "other";
}

export interface LoadedDex {
  readonly location: DexLocation;
  /** Why the bytes could not be read (budget, encryption, damage), when they could not. */
  readonly failure: MemberReadFailure | null;
  readonly sha256: string | null;
  readonly bytes: number;
  /** Null when the bytes could not be read or are not DEX at all. */
  readonly dex: DexFile | null;
  readonly summary: AndroidArtifactReport["dex_files"][number];
}

/** Binary name of a class descriptor: Lcom/example/Main$Inner; → com.example.Main$Inner. */
export const binaryName = (descriptor: string | null): string | null =>
  descriptor !== null && descriptor.startsWith("L") && descriptor.endsWith(";")
    ? descriptor.slice(1, -1).replaceAll("/", ".")
    : descriptor;

/** Descriptor for a caller's class name, accepting either form. */
export const classDescriptor = (name: string): string =>
  name.startsWith("L") && name.endsWith(";")
    ? name
    : `L${name.replaceAll(".", "/")};`;

/** DEX members of one ZIP (outer or nested), code DEX first in classes, classes2, ... order. */
export const dexMembers = (
  view: AndroidPackageView,
  container: string | null,
  module: (path: string) => string | null,
): DexLocation[] =>
  view
    .members(container)
    .filter((member) => !member.directory && member.path.endsWith(".dex"))
    .map((member) => {
      const owner = module(member.path);
      return {
        container,
        entry: member.path,
        module: owner,
        role: isCodeDex(member.path, owner)
          ? ("code" as const)
          : ("other" as const),
      };
    })
    .sort((left, right) =>
      left.role !== right.role
        ? left.role === "code"
          ? -1
          : 1
        : dexOrder(left.entry, right.entry),
    );

const hex8 = (value: number): string =>
  `0x${value.toString(16).padStart(8, "0")}`;

/** Read and parse one DEX; failures become a summary with the reason, not an exception. */
export const loadDex = async (
  view: AndroidPackageView,
  location: DexLocation,
): Promise<LoadedDex> => {
  const base = {
    container: location.container,
    entry: location.entry,
    module: location.module,
    role: location.role,
  };
  let bytes: Uint8Array;
  try {
    bytes =
      location.entry === null
        ? (view.dex ?? new Uint8Array())
        : await view.read(location.container, location.entry);
  } catch (cause) {
    if (!(cause instanceof MemberReadFailure) || cause.reason === "cancelled")
      throw cause;
    return {
      location,
      failure: cause,
      sha256: null,
      bytes: 0,
      dex: null,
      summary: {
        ...base,
        sha256: null,
        bytes: 0,
        read: "failed",
        error: cause.message,
        version: null,
        checksum: null,
        signature: null,
        counts: null,
        map: [],
        problems: [],
      },
    };
  }
  const sha256 = sha256Hex(bytes);
  try {
    const dex = DexFile.parse(bytes);
    const header = dex.header;
    const problems: AndroidDiagnostic[] = dex.problems.map((problem) => ({
      container: location.container,
      entry: location.entry,
      offset: problem.offset,
      message: problem.message,
    }));
    return {
      location,
      failure: null,
      sha256,
      bytes: bytes.length,
      dex,
      summary: {
        ...base,
        sha256,
        bytes: bytes.length,
        read: problems.length === 0 ? "complete" : "partial",
        error: null,
        version: header.magic_version,
        checksum: {
          declared: hex8(header.checksum),
          computed: hex8(header.computed_checksum),
          valid: header.checksum === header.computed_checksum,
        },
        signature: {
          declared: header.signature,
          computed: header.computed_signature,
          valid: header.signature === header.computed_signature,
        },
        counts: {
          strings: header.string_ids.size,
          types: header.type_ids.size,
          protos: header.proto_ids.size,
          fields: header.field_ids.size,
          methods: header.method_ids.size,
          classes: header.class_defs.size,
          call_sites: dex.call_site_ids.size,
          method_handles: dex.method_handles.size,
        },
        map: dex.map.map((item) => ({
          name: item.name,
          size: item.size,
          offset: item.offset,
        })),
        problems,
      },
    };
  } catch (cause) {
    if (!(cause instanceof DexFormatError)) throw cause;
    return {
      location,
      failure: null,
      sha256,
      bytes: bytes.length,
      dex: null,
      summary: {
        ...base,
        sha256,
        bytes: bytes.length,
        read: "failed",
        error: cause.message,
        version: null,
        checksum: null,
        signature: null,
        counts: null,
        map: [],
        problems: [
          {
            container: location.container,
            entry: location.entry,
            offset: cause.offset,
            message: cause.message,
          },
        ],
      },
    };
  }
};

/** One class-list row; a damaged class keeps what was read and says why. */
export const classSummary = (
  dex: DexFile,
  location: DexLocation,
  index: number,
): DexClassSummary => {
  const def = dex.classDef(index);
  const descriptor = dex.type(def.class_idx);
  const base = {
    container: location.container,
    entry: location.entry,
    descriptor,
    name: binaryName(descriptor),
    access_flags: def.access_flags,
    access: dexAccessFlags(def.access_flags, "class"),
    superclass:
      def.superclass_idx === NO_INDEX ? null : dex.type(def.superclass_idx),
    interfaces: (dex.typeList(def.interfaces_off) ?? []).map((type) =>
      dex.type(type),
    ),
    source_file:
      def.source_file_idx === NO_INDEX ? null : dex.string(def.source_file_idx),
  };
  try {
    const data = dex.classData(def);
    return {
      ...base,
      static_fields: data?.static_fields.length ?? 0,
      instance_fields: data?.instance_fields.length ?? 0,
      direct_methods: data?.direct_methods.length ?? 0,
      virtual_methods: data?.virtual_methods.length ?? 0,
      decode: "complete",
      error: null,
    };
  } catch (cause) {
    if (!(cause instanceof DexFormatError)) throw cause;
    return {
      ...base,
      static_fields: 0,
      instance_fields: 0,
      direct_methods: 0,
      virtual_methods: 0,
      decode: "failed",
      error: `class_data_item at ${String(cause.offset)}: ${cause.message}`,
    };
  }
};

/** A page of classes across `loaded`, in DEX order then class_def order. */
export const classPage = (
  loaded: readonly LoadedDex[],
  start: number,
  limit: number,
): { classes: DexClassSummary[]; total: number } => {
  const classes: DexClassSummary[] = [];
  let total = 0;
  for (const entry of loaded) {
    const dex = entry.dex;
    if (dex === null) continue;
    const count = dex.classCount;
    for (
      let index = Math.max(0, start - total);
      index < count && classes.length < limit;
      index += 1
    )
      classes.push(classSummary(dex, entry.location, index));
    total += count;
  }
  return { classes, total };
};
