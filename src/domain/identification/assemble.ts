import { formatEntry } from "../formatRegistry.js";
import type { FormatId } from "../formatIdentifiers.js";
import {
  MAX_UNRECOGNIZED_EXTENSIONS,
  artifactIdentificationSchema,
  type ArtifactIdentification,
  type IdentificationWalk,
  type IdentifiedPiece,
  type IdentifyArtifactInput,
  type IdentifyNextStep,
  type WalkedPiece,
} from "./identification.js";
import { readerRoutesFor, type ReaderRoute } from "./readerRoutes.js";

/** Next steps offered in one answer. */
export const MAX_NEXT_STEPS = 16;
/** Formats named in the summary sentence before "and N more kinds". */
const SUMMARY_FORMATS = 4;

const number = (value: number): string => value.toLocaleString("en-US");

const UNITS = ["bytes", "KiB", "MiB", "GiB", "TiB"] as const;

/** Binary units, one decimal above a KiB. */
export const sizeText = (bytes: number): string => {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0
    ? `${number(bytes)} ${bytes === 1 ? "byte" : "bytes"}`
    : `${value.toFixed(1)} ${UNITS[unit] ?? "TiB"}`;
};

const labelOf = (format: FormatId | null): string =>
  format === null ? "unrecognized" : formatEntry(format).label;

const tally = (
  pieces: readonly WalkedPiece[],
): ArtifactIdentification["formats"] => {
  const groups = new Map<FormatId | null, { count: number; bytes: number }>();
  for (const piece of pieces) {
    if (piece.kind !== "file") continue;
    const group = groups.get(piece.format) ?? { count: 0, bytes: 0 };
    group.count += 1;
    group.bytes += piece.bytes ?? 0;
    groups.set(piece.format, group);
  }
  return [...groups]
    .map(([format, group]) => ({
      format,
      label: format === null ? "Unrecognized" : formatEntry(format).label,
      dimension: format === null ? null : formatEntry(format).dimension,
      count: group.count,
      bytes: group.bytes,
    }))
    .sort(
      (left, right) =>
        right.count - left.count ||
        right.bytes - left.bytes ||
        left.label.localeCompare(right.label),
    );
};

const formatList = (formats: ArtifactIdentification["formats"]): string => {
  const known = formats.filter(({ format }) => format !== null);
  const unknown = formats.find(({ format }) => format === null);
  const named = known
    .slice(0, SUMMARY_FORMATS)
    .map(({ label, count }) => `${label} (${number(count)})`);
  if (known.length > SUMMARY_FORMATS)
    named.push(`${number(known.length - SUMMARY_FORMATS)} more kinds`);
  if (unknown !== undefined)
    named.push(`unrecognized (${number(unknown.count)})`);
  return named.join(", ");
};

const rootTitle = (root: WalkedPiece): string =>
  root.headline?.title ??
  (root.format === null
    ? "Unrecognized file"
    : root.format_basis === "name"
      ? `${labelOf(root.format)} (from the name; contents not confirmed)`
      : labelOf(root.format));

const isFile = (piece: WalkedPiece) => piece.kind === "file";

/** One sentence about a folder: what is on disk, then what opened archives hold. */
const folderSentences = (
  walk: IdentificationWalk,
  root: WalkedPiece,
): string[] => {
  const onDisk = walk.pieces.filter(
    (piece) => piece.depth === 0 && piece !== root,
  );
  const files = onDisk.filter(isFile);
  const folders = onDisk.filter((piece) => piece.kind === "directory").length;
  const inside = walk.pieces.filter(
    (piece) => piece.depth > 0 && isFile(piece),
  );
  const sentences = [
    `Folder with ${number(files.length)} files in ${number(folders)} subfolders (${sizeText(walk.bytes)})${
      files.length === 0 ? "" : `: ${formatList(tally(files))}`
    }.`,
  ];
  if (inside.length > 0)
    sentences.push(
      `${number(walk.counters.containersOpened)} opened containers hold ${number(inside.length)} more files: ${formatList(tally(inside))}.`,
    );
  if (root.headline !== null) sentences.push(`${root.headline.title}.`);
  return sentences;
};

/** Sentences about a file: what it is, then what it holds or why that is unknown. */
const fileSentences = (
  walk: IdentificationWalk,
  root: WalkedPiece,
): string[] => {
  const files = walk.pieces.filter((piece) => isFile(piece) && piece !== root);
  const sentences = [`${rootTitle(root)} (${sizeText(walk.bytes)}).`];
  const { container } = root;
  if (container.state === "opened")
    sentences.push(
      `It holds ${number(files.length)} files${
        walk.counters.containersOpened > 1
          ? ` across ${number(walk.counters.containersOpened)} opened containers`
          : ""
      }${files.length === 0 ? "" : `: ${formatList(tally(files))}`}.`,
    );
  if (container.reason !== null)
    sentences.push(
      container.state === "opened"
        ? `${container.reason}.`
        : `Its contents were not opened: ${container.reason}`,
    );
  if (root.name_conflict !== null) sentences.push(root.name_conflict);
  return sentences;
};

const summarize = (walk: IdentificationWalk): string => {
  const [root] = walk.pieces;
  if (root === undefined) return "Nothing was examined.";
  const sentences =
    walk.kind === "directory"
      ? folderSentences(walk, root)
      : fileSentences(walk, root);
  const stopped =
    walk.counters.containersStopped -
    (root.container.state === "opened" && root.container.reason !== null
      ? 1
      : 0);
  if (stopped > 0)
    sentences.push(
      `${number(stopped)} nested containers could not be read to the end; their pieces say why.`,
    );
  if (walk.counters.entryLimit)
    sentences.push(
      `The walk stopped at the ${number(walk.counters.entries)}-entry budget (max_entries), so the counts are partial.`,
    );
  return sentences.join(" ");
};

/** Extensions of unrecognized files: a fact about names, never a format claim. */
const unrecognizedExtensions = (
  walk: IdentificationWalk,
): ArtifactIdentification["unrecognized_extensions"] => {
  const counts = new Map<string, number>();
  for (const piece of walk.pieces) {
    if (!isFile(piece) || piece.format !== null) continue;
    const dot = piece.name.lastIndexOf(".");
    const extension = dot <= 0 ? "" : piece.name.slice(dot).toLowerCase();
    counts.set(extension, (counts.get(extension) ?? 0) + 1);
  }
  return [...counts]
    .sort(
      (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
    )
    .slice(0, MAX_UNRECOGNIZED_EXTENSIONS)
    .map(([extension, count]) => ({ extension, count }));
};

const largest = (walk: IdentificationWalk): ArtifactIdentification["largest"] =>
  walk.pieces
    .filter(
      (piece) =>
        piece.kind === "file" && piece.id !== "p0" && piece.bytes !== null,
    )
    .sort((left, right) => (right.bytes ?? 0) - (left.bytes ?? 0))
    .slice(0, 10)
    .map((piece) => ({ piece: piece.id, bytes: piece.bytes ?? 0 }));

const relativeTo = (outer: WalkedPiece, piece: WalkedPiece): string =>
  outer.path === "" ? piece.path : piece.path.slice(outer.path.length + 1);

const LIST_INSIDE: Omit<IdentifyNextStep, "piece" | "requires" | "open_first"> =
  {
    tool: "inspect_artifact",
    label: "List everything inside",
    arguments: { detail: "summary", integrity_policy: "record-and-continue" },
    why: "The complete content-addressed inventory with digests and integrity checks; extract_artifact writes the files out.",
  };

/** Inner pieces named in one extract step before "and N more". */
const EXTRACT_NAMES = 5;

/** Routes for a piece, plus routes its name alone suggests when nothing contradicts it. */
const routesOf = (
  piece: WalkedPiece,
): {
  readonly routes: readonly ReaderRoute[];
  readonly hinted: readonly ReaderRoute[];
} => {
  const routes = readerRoutesFor(piece.format, piece.candidates);
  // A name the bytes contradict suggests nothing.
  const hinted =
    piece.name_conflict === null
      ? readerRoutesFor(null, piece.hinted).filter(
          (route) => !routes.includes(route),
        )
      : [];
  return { routes, hinted };
};

/** Steps for a root or folder entry: every route on its real path, then listing it. */
const onDiskSteps = (
  piece: WalkedPiece,
  path: string,
  routes: readonly ReaderRoute[],
  hinted: readonly ReaderRoute[],
): IdentifyNextStep[] => [
  ...routes.map((route) => onDiskStep(piece, path, route, false)),
  ...hinted.map((route) => onDiskStep(piece, path, route, true)),
  ...(piece.openable && piece.kind === "file"
    ? [
        {
          ...LIST_INSIDE,
          piece: piece.id,
          requires: `Open ${path} with open_binary first.`,
          open_first: path,
        },
      ]
    : []),
];

interface Inside {
  readonly outer: WalkedPiece;
  readonly reads: string[];
  deeper: boolean;
}

/** One extract step for everything read inside one on-disk container. */
const extractStep = ({ outer, reads, deeper }: Inside): IdentifyNextStep => {
  const named = reads.slice(0, EXTRACT_NAMES).join("; ");
  const more =
    reads.length > EXTRACT_NAMES
      ? `; and ${String(reads.length - EXTRACT_NAMES)} more`
      : "";
  return {
    piece: outer.id,
    tool: "extract_artifact",
    label: `Extract ${outer.name} to read what is inside`,
    arguments: { integrity_policy: "record-and-continue" },
    requires: `Open ${outer.onDisk ?? outer.name} with open_binary first.`,
    open_first: outer.onDisk,
    why: `Writes its files to a fresh folder; then run each reader on the extracted file: ${named}${more}.${
      deeper
        ? " Some pieces sit more than one container deep: extract each inner container in turn."
        : ""
    }`,
  };
};

/** Root first, then one file of each format; others add nothing new. */
const notablePieces = (walk: IdentificationWalk): WalkedPiece[] => {
  const seen = new Set<string>();
  return walk.pieces.filter((piece) => {
    const isRoot = piece.id === "p0";
    if (!isRoot && piece.kind !== "file") return false;
    const { routes, hinted } = routesOf(piece);
    const key =
      piece.format ?? (hinted.length === 0 ? null : piece.hinted[0]) ?? null;
    if (key === null || (!isRoot && seen.has(key))) return false;
    if (routes.length === 0 && hinted.length === 0 && !piece.openable)
      return false;
    seen.add(key);
    return true;
  });
};

/**
 * Exact calls for the root and one piece of each other format. Pieces inside
 * a container share one extract step on the on-disk container that holds them.
 */
const nextSteps = (walk: IdentificationWalk): IdentifyNextStep[] => {
  const byId = new Map(walk.pieces.map((piece) => [piece.id, piece]));
  const rootSteps: IdentifyNextStep[] = [];
  const steps: IdentifyNextStep[] = [];
  const inside = new Map<string, Inside>();
  for (const piece of notablePieces(walk)) {
    const { routes, hinted } = routesOf(piece);
    if (piece.onDisk !== null) {
      (piece.id === "p0" ? rootSteps : steps).push(
        ...onDiskSteps(piece, piece.onDisk, routes, hinted),
      );
      continue;
    }
    const outer = piece.outer === null ? undefined : byId.get(piece.outer);
    const route = routes[0] ?? hinted[0];
    if (outer?.onDisk === null || outer === undefined || route === undefined)
      continue;
    const group = inside.get(outer.id) ?? { outer, reads: [], deeper: false };
    group.reads.push(`${relativeTo(outer, piece)} (${route.tool})`);
    group.deeper ||= piece.depth - outer.depth > 1;
    inside.set(outer.id, group);
  }
  // The root first, then one extract step per container, then other files.
  return [...rootSteps, ...[...inside.values()].map(extractStep), ...steps];
};

const onDiskStep = (
  piece: WalkedPiece,
  path: string,
  route: ReaderRoute,
  hinted: boolean,
): IdentifyNextStep => ({
  piece: piece.id,
  tool: route.tool,
  label: route.label,
  arguments: { ...route.step(path, piece.format) },
  requires: route.requires,
  open_first: route.opensFirst ? path : null,
  why: hinted
    ? `The name suggests ${piece.hinted.map(labelOf).join(" or ")}; the bytes were not recognized. ${route.why}`
    : route.why,
});

const visible = (piece: WalkedPiece): IdentifiedPiece => ({
  id: piece.id,
  parent: piece.parent,
  depth: piece.depth,
  path: piece.path,
  name: piece.name,
  kind: piece.kind,
  bytes: piece.bytes,
  format: piece.format,
  format_basis: piece.format_basis,
  label: piece.label,
  candidates: piece.candidates,
  name_conflict: piece.name_conflict,
  container: piece.container,
  reader: piece.reader,
  headline: piece.headline,
});

const SHARED_LIMITATIONS = [
  "Formats come from leading bytes (and the final 512 bytes of files on disk); a candidate is not proof the whole structure is valid.",
  "Built-in readers run only on one piece of each format, within max_readers; next steps name the call for every other piece.",
  "No file is run, installed or fetched. Nested containers are read with the existing readers, which may use installed decoders (xz, bsdtar) and, on macOS, mount a disk image read-only. Members are copied to a private scratch directory only to read them; it is removed before the answer returns.",
] as const;

/** Assemble the answer from a finished walk, then check it against its schema. */
export const assembleIdentification = (
  input: IdentifyArtifactInput,
  walk: IdentificationWalk,
): ArtifactIdentification => {
  const root = walk.pieces[0];
  const formats = tally(walk.pieces);
  const page = walk.pieces.slice(input.start, input.start + input.limit);
  const steps = nextSteps(walk);
  const next = input.start + page.length;
  return artifactIdentificationSchema.parse({
    subject: {
      path: walk.path,
      kind: walk.kind,
      bytes: walk.bytes,
      sha256: walk.sha256,
      sha256_of: walk.kind === "file" ? "content" : "listing",
    },
    answer: {
      summary: summarize(walk),
      format: root?.format ?? null,
      label: root?.label ?? null,
      headline: root?.headline ?? null,
    },
    detection: walk.detection,
    formats,
    unrecognized_extensions: unrecognizedExtensions(walk),
    largest: largest(walk),
    piece_count: walk.pieces.length,
    page: {
      start: input.start,
      limit: input.limit,
      returned: page.length,
      next: next < walk.pieces.length ? next : null,
    },
    pieces: page.map(visible),
    next_steps: steps.slice(0, MAX_NEXT_STEPS),
    next_steps_omitted: Math.max(0, steps.length - MAX_NEXT_STEPS),
    coverage: {
      depth: walk.depth,
      entries_examined: walk.counters.entries,
      entry_limit_reached: walk.counters.entryLimit,
      containers_opened: walk.counters.containersOpened,
      containers_not_opened: walk.counters.containersNotOpened,
      containers_stopped: walk.counters.containersStopped,
      readers_run: walk.counters.readersRun,
      readers_not_run: walk.counters.readersNotRun,
      spooled_bytes: walk.counters.spooledBytes,
      spool_limit_reached: walk.counters.spoolLimit,
      symlinks: walk.counters.symlinks,
      special_files: walk.counters.special,
      unreadable: walk.counters.unreadable,
      diagnostics_omitted: walk.counters.diagnosticsOmitted,
    },
    diagnostics: walk.diagnostics,
    limitations: [
      ...SHARED_LIMITATIONS,
      ...walk.limitations,
      ...(walk.kind === "directory"
        ? [
            "Symlinks are listed, never followed; folders the host refuses to open are named in diagnostics. The digest covers the sorted listing (kind, size, path), not file contents.",
          ]
        : []),
    ],
  });
};
