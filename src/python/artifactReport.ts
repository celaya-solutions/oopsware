import {
  DecodeBudget,
  MemberReadFailure,
  sha256Hex,
  type ZipMember,
} from "../artifacts/zipMemberView.js";
import type { FacetCoverage } from "../domain/formatRegistry.js";
import type {
  InspectPythonArtifactInput,
  PythonArtifactReport,
} from "../domain/python/python.js";
import { latin1 } from "./bytecode/marshal.js";
import { readPycHeader } from "./bytecode/pyc.js";
import { headerFacts } from "./bytecodeReport.js";
import { moduleKind, moduleName, type PythonSource } from "./source.js";
import {
  binaryKind,
  entryPointsOf,
  extensionTag,
  isLicenseMember,
  isNativeMember,
  metadataOf,
  parseRecord,
  recordAlgorithmAccepted,
  recordDigest,
  wheelFileOf,
  wheelFilename,
} from "./wheel.js";

type Wheel = NonNullable<PythonArtifactReport["wheel"]>;
type ModuleSummary = PythonArtifactReport["modules"][number];
type Archive = Extract<PythonSource, { zip: unknown }>;

export const NO_PYTHON_DECOMPILER =
  "Not requested: decompile_python_code reconstructs inferred source for a .pyc of Python 2.7 or 3.5-3.13 with an owner-installed, digest-pinned pycdc; inspect_python_code gives the decoded bytecode.";

const RECONSTRUCT: FacetCoverage = {
  facet: "reconstruct",
  state: "not_requested",
  examined: null,
  omitted: null,
  reason: NO_PYTHON_DECOMPILER,
  continuation: null,
};

interface MemberRead {
  readonly bytes: Uint8Array | null;
  readonly sha256: string | null;
  readonly failure: MemberReadFailure | null;
}

const summaryOfBytecode = (bytes: Uint8Array) => {
  const header = readPycHeader(bytes);
  return header === null
    ? {
        magic: null,
        release: null,
        admitted: null,
        problem: "The member has no .pyc header.",
      }
    : {
        magic: header.magic,
        release: header.release,
        admitted: header.admitted,
        problem: header.problem,
      };
};

/** Read every member the report needs once, inside one decompression budget. */
const readMembers = async (
  source: Archive,
  wanted: readonly ZipMember[],
  budget: DecodeBudget,
  signal?: AbortSignal,
): Promise<Map<string, MemberRead>> => {
  const reads = new Map<string, MemberRead>();
  for (const member of wanted) {
    try {
      const bytes = await source.zip.read(member.path, budget, signal);
      reads.set(member.path, {
        bytes,
        sha256: sha256Hex(bytes),
        failure: null,
      });
    } catch (cause) {
      if (!(cause instanceof MemberReadFailure)) throw cause;
      if (cause.reason === "cancelled") throw cause;
      reads.set(member.path, { bytes: null, sha256: null, failure: cause });
    }
  }
  return reads;
};

const wheelReport = (
  path: string,
  source: Archive,
  files: readonly ZipMember[],
  reads: ReadonlyMap<string, MemberRead>,
): Wheel => {
  const distInfo = source.distInfo;
  const problems: string[] = [];
  const text = (name: string) => {
    if (distInfo === null) return null;
    const read = reads.get(`${distInfo}/${name}`);
    if (read === undefined) return null;
    if (read.bytes === null) {
      problems.push(
        `${distInfo}/${name} could not be read: ${read.failure?.message ?? "unknown"}`,
      );
      return null;
    }
    return read.bytes;
  };
  const metadataBytes = text("METADATA");
  const wheelBytes = text("WHEEL");
  const entryBytes = text("entry_points.txt");
  const recordBytes = text("RECORD");
  if (
    distInfo !== null &&
    metadataBytes === null &&
    !reads.has(`${distInfo}/METADATA`)
  )
    problems.push(`${distInfo}/METADATA is missing.`);
  const filename = wheelFilename(path);
  if (filename === null && path.toLowerCase().endsWith(".whl"))
    problems.push("The file name does not follow the wheel naming convention.");
  let record: Wheel["record"] = null;
  if (distInfo !== null && recordBytes !== null) {
    const parsed = parseRecord(recordBytes);
    const listed = new Map(parsed.rows.map((row) => [row.path, row]));
    const mismatched: NonNullable<Wheel["record"]>["mismatched"] = [];
    const unhashed: string[] = [];
    const unsupported: string[] = [];
    const unread: string[] = [];
    let verified = 0;
    for (const row of parsed.rows) {
      const read = reads.get(row.path);
      if (read === undefined) continue;
      if (row.algorithm === null || row.digest === null || row.digest === "") {
        unhashed.push(row.path);
        continue;
      }
      if (!recordAlgorithmAccepted(row.algorithm)) {
        unsupported.push(row.path);
        continue;
      }
      if (read.bytes === null) {
        unread.push(row.path);
        continue;
      }
      const actual = recordDigest(row.algorithm, read.bytes);
      const sizeMatches = row.size === null || row.size === read.bytes.length;
      if (actual === row.digest && sizeMatches) verified += 1;
      else
        mismatched.push({
          entry: row.path,
          algorithm: row.algorithm,
          expected: row.digest,
          actual,
          expected_size: row.size,
          actual_size: read.bytes.length,
        });
    }
    record = {
      entry: `${distInfo}/RECORD`,
      rows: parsed.rows.length,
      verified,
      mismatched,
      unhashed,
      not_listed: files
        .filter((member) => !listed.has(member.path))
        .map((member) => member.path),
      absent: parsed.rows
        .filter((row) => !reads.has(row.path))
        .map((row) => row.path),
      unsupported_algorithm: unsupported,
      unread,
      problem: parsed.problem,
    };
  } else if (distInfo !== null)
    problems.push(`${distInfo}/RECORD is missing or unreadable.`);
  const dataPrefix =
    distInfo === null
      ? null
      : `${distInfo.slice(0, -".dist-info".length)}.data/`;
  const schemes = new Map<string, number>();
  if (dataPrefix !== null)
    for (const member of files)
      if (member.path.startsWith(dataPrefix)) {
        const scheme = member.path.slice(dataPrefix.length).split("/")[0] ?? "";
        schemes.set(scheme, (schemes.get(scheme) ?? 0) + 1);
      }
  return {
    filename,
    dist_info: distInfo,
    metadata: metadataBytes === null ? null : metadataOf(metadataBytes),
    wheel: wheelBytes === null ? null : wheelFileOf(wheelBytes),
    entry_points: entryBytes === null ? [] : entryPointsOf(entryBytes),
    record,
    licenses: files
      .filter((member) => isLicenseMember(member.path, distInfo))
      .map((member) => ({
        entry: member.path,
        bytes: member.bytes,
        sha256: reads.get(member.path)?.sha256 ?? null,
      })),
    native_extensions: [],
    data_schemes: [...schemes].map(([scheme, members]) => ({
      scheme,
      members,
    })),
    problems,
  };
};

const nativeOf = (
  files: readonly ZipMember[],
  reads: ReadonlyMap<string, MemberRead>,
) =>
  files
    .filter((member) => isNativeMember(member.path))
    .map((member) => {
      const read = reads.get(member.path);
      return {
        entry: member.path,
        bytes: member.bytes,
        sha256: read?.sha256 ?? null,
        binary:
          read?.bytes == null ? ("unread" as const) : binaryKind(read.bytes),
        abi_tag: extensionTag(member.path),
      };
    });

const page = <T>(items: readonly T[], start: number, limit: number) => {
  const slice = items.slice(start, start + limit);
  const next = start + slice.length;
  return {
    items: slice,
    page: {
      start,
      limit,
      returned: slice.length,
      next: next < items.length ? next : null,
    },
  };
};

export const artifactReport = async (
  artifact: PythonArtifactReport["artifact"],
  source: PythonSource,
  input: InspectPythonArtifactInput,
  budget: DecodeBudget,
  signal?: AbortSignal,
): Promise<PythonArtifactReport> => {
  const container = {
    kind: source.kind,
    basis: source.basis,
    name_conflict: source.nameConflict,
  };
  if (!("zip" in source)) {
    const bytecode = source.kind === "bytecode";
    const header = bytecode ? readPycHeader(source.bytes) : null;
    const module: ModuleSummary = {
      entry: null,
      kind: bytecode ? "bytecode" : "source",
      module: moduleName(artifact.path.split("/").pop() ?? "", null),
      sha256: artifact.sha256,
      bytes: artifact.bytes,
      ...(bytecode
        ? summaryOfBytecode(source.bytes)
        : { magic: null, release: null, admitted: null, problem: null }),
    };
    const paged = page([module], input.start, input.limit);
    return {
      artifact,
      container,
      members: null,
      wheel: null,
      zipapp: null,
      header: header === null ? null : headerFacts(header),
      module_count: 1,
      page: paged.page,
      modules: paged.items,
      native_count: 0,
      coverage: [
        {
          facet: "identify",
          state: "complete",
          examined: bytecode
            ? "the .pyc magic number and header"
            : "the .py name and text bytes",
          omitted: null,
          reason: null,
          continuation: null,
        },
        {
          facet: "inspect",
          state: "not_requested",
          examined: null,
          omitted: null,
          reason: bytecode
            ? "inspect_python_module lists the code objects; inspect_python_code decodes one."
            : "inspect_python_module parses the source.",
          continuation: null,
        },
        bytecode
          ? RECONSTRUCT
          : {
              ...RECONSTRUCT,
              state: "unsupported",
              reason:
                "Source is already source; there is nothing to reconstruct.",
            },
      ],
      limitations: [
        "Nothing is imported, compiled or run.",
        ...(header !== null && !header.admitted
          ? [
              `Magic number ${String(header.magic)}${header.release === null ? " is not a known release" : ` (Python ${header.release})`} has no decoding profile; only the header is read.`,
            ]
          : []),
      ],
    };
  }
  const members = source.zip.members;
  const files = members.filter((member) => !member.directory);
  const wanted = files.filter(
    (member) =>
      source.kind === "wheel" ||
      moduleKind(member.path) !== null ||
      isNativeMember(member.path),
  );
  const reads = await readMembers(source, wanted, budget, signal);
  const modules: ModuleSummary[] = files.flatMap((member) => {
    const kind = moduleKind(member.path);
    if (kind === null) return [];
    const read = reads.get(member.path);
    const unreadProblem = read?.failure == null ? null : read.failure.message;
    return [
      {
        entry: member.path,
        kind,
        module: moduleName(member.path, source.distInfo),
        sha256: read?.sha256 ?? null,
        bytes: member.bytes,
        ...(kind === "bytecode" && read?.bytes != null
          ? summaryOfBytecode(read.bytes)
          : {
              magic: null,
              release: null,
              admitted: null,
              problem: unreadProblem,
            }),
      },
    ];
  });
  const native = nativeOf(files, reads);
  const wheel =
    source.kind === "wheel"
      ? {
          ...wheelReport(artifact.path, source, files, reads),
          native_extensions: native,
        }
      : null;
  const main = source.zip.has("__main__.py")
    ? "__main__.py"
    : source.zip.has("__main__.pyc")
      ? "__main__.pyc"
      : null;
  const shebangLine = latin1(source.prefix).replace(/\r?\n$/u, "");
  const zipapp =
    source.kind === "zipapp"
      ? {
          shebang: source.prefix.length > 0 ? shebangLine : null,
          prefix_bytes: source.prefix.length,
          main:
            main === null
              ? null
              : {
                  entry: main,
                  bytes:
                    files.find((member) => member.path === main)?.bytes ?? 0,
                  sha256: reads.get(main)?.sha256 ?? null,
                },
        }
      : null;
  const unread = [...reads.values()].filter((read) => read.failure !== null);
  const budgetHit = unread.some((read) => read.failure?.reason === "budget");
  const paged = page(modules, input.start, input.limit);
  const inspectExamined =
    source.kind === "wheel"
      ? "wheel metadata, entry points, RECORD digests, licenses, native extension headers and each module's header"
      : "the member list, zip application entry point, native extension headers and each module's header";
  return {
    artifact,
    container,
    members: {
      files: files.length,
      directories: members.length - files.length,
      duplicates: [...source.zip.duplicates],
      encrypted: members.filter((member) => member.encrypted).length,
    },
    wheel,
    zipapp,
    header: null,
    module_count: modules.length,
    page: paged.page,
    modules: paged.items,
    native_count: native.length,
    coverage: [
      {
        facet: "identify",
        state: "complete",
        examined: "ZIP members and wheel or zip application layout",
        omitted: null,
        reason: null,
        continuation: null,
      },
      source.zip.duplicates.length === 0
        ? {
            facet: "inventory",
            state: "complete",
            examined: `all ${String(members.length)} members`,
            omitted: null,
            reason: null,
            continuation: null,
          }
        : {
            facet: "inventory",
            state: "partial",
            examined: `${String(members.length)} distinct member names`,
            omitted: `${String(source.zip.duplicates.length)} later members with a repeated name`,
            reason: "A ZIP may repeat a member name; only the first is read.",
            continuation: null,
          },
      unread.length === 0
        ? {
            facet: "inspect",
            state: "complete",
            examined: inspectExamined,
            omitted: null,
            reason: null,
            continuation: null,
          }
        : {
            facet: "inspect",
            state: "partial",
            examined: `${String(reads.size - unread.length)} of ${String(reads.size)} members read`,
            omitted: `${String(unread.length)} members`,
            reason: budgetHit
              ? "The decompression budget ran out."
              : "Some members are damaged, encrypted or too large.",
            continuation: budgetHit ? "Raise max_decoded_bytes." : null,
          },
      RECONSTRUCT,
    ],
    limitations: [
      "Nothing is imported, installed or run; entry points and __main__.py are declarations.",
      ...(source.kind === "wheel"
        ? [
            "RECORD digests are recomputed; wheel signatures (RECORD.jws, RECORD.p7s) are not verified.",
          ]
        : []),
      "Module contents are parsed by inspect_python_module; this report reads only their headers.",
    ],
  };
};
