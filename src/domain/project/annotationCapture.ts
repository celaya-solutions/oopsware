import { z } from "zod";
import { evidenceSchema, type Evidence } from "../evidence.js";
import { err, ok, type Result } from "../result.js";
import { limit } from "./projectEdits.js";
import {
  PROJECT_LIMITS,
  ProjectEditError,
  lineSchema,
  noteTextSchema,
  plainLine,
  projectSchema,
  type Anchor,
  type Project,
  type ProjectTarget,
  type Provenance,
} from "./projectSchema.js";

/** The stored run fields a project reads; `WebToolRun` satisfies it structurally. */
export interface ProjectRunRecord {
  readonly id: string;
  readonly tool: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly status: string;
  readonly createdAt: string;
  readonly completedAt?: string | undefined;
  readonly targetPath?: string | undefined;
  result?: unknown;
}

export type AnnotationKind = "name" | "comment" | "inline_comment" | "bookmark";

/** One change a successful annotation run made, ready to fold into a project. */
export interface AnnotationCapture {
  readonly op: "upsert" | "delete";
  readonly kind: AnnotationKind;
  readonly target_sha256: string;
  readonly address: string;
  /** New text; null on a bookmark upsert means "keep the existing label". */
  readonly value: string | null;
  readonly provenance: Provenance;
}

const resultEnvelope = z.object({
  isError: z.boolean().optional(),
  structuredContent: z.unknown().optional(),
});

/**
 * Read the Evidence a run delivered. Stored runs are redacted at write time,
 * which can change hashed content, so this checks structure, not the digest.
 */
export const runEvidence = (run: ProjectRunRecord): Evidence | null => {
  const envelope = resultEnvelope.safeParse(run.result);
  if (!envelope.success || envelope.data.isError === true) return null;
  const evidence = evidenceSchema.safeParse(envelope.data.structuredContent);
  return evidence.success ? evidence.data : null;
};

/** Name the run's target from its Evidence subject, else its declared path. */
export const targetFromRun = (
  run: ProjectRunRecord,
  now: string,
): ProjectTarget | null => {
  const subject = runEvidence(run)?.subject;
  if (subject)
    return {
      id: crypto.randomUUID(),
      name: plainLine(subject.name, 1024),
      path: subject.local_path,
      kind: subject.format === "directory" ? "folder" : "file",
      size: null,
      sha256: subject.digest.sha256,
      format: subject.format,
      architecture: subject.architecture,
      addedAt: now,
      source: "run",
    };
  if (run.targetPath === undefined || run.targetPath === "") return null;
  return {
    id: crypto.randomUUID(),
    name: plainLine(
      run.targetPath.split(/[\\/]/).pop() || run.targetPath,
      1024,
    ),
    path: run.targetPath,
    kind: "file",
    size: null,
    sha256: null,
    format: null,
    architecture: null,
    addedAt: now,
    source: "run",
  };
};

const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const fromReadback = (
  tool: string,
  args: Readonly<Record<string, unknown>>,
  readback: unknown,
): Omit<AnnotationCapture, "target_sha256" | "provenance">[] => {
  const address = text(args.address);
  const held = readback === true && address !== undefined;
  switch (tool) {
    case "set_address_name": {
      const name = text(args.name);
      return held && name
        ? [{ op: "upsert", kind: "name", address, value: name }]
        : [];
    }
    case "set_addresses_names": {
      const names = z.record(z.string(), z.string()).safeParse(args.names);
      const results = z.record(z.string(), z.boolean()).safeParse(readback);
      if (!names.success || !results.success) return [];
      return Object.entries(names.data)
        .filter(([key, name]) => results.data[key] === true && name !== "")
        .map(([key, name]) => ({
          op: "upsert",
          kind: "name",
          address: key,
          value: name,
        }));
    }
    case "set_comment":
    case "set_inline_comment": {
      const comment = text(args.comment);
      if (!held || comment === undefined) return [];
      const kind = tool === "set_comment" ? "comment" : "inline_comment";
      return [
        comment === ""
          ? { op: "delete", kind, address, value: null }
          : { op: "upsert", kind, address, value: comment },
      ];
    }
    case "set_bookmark":
      return held
        ? [
            {
              op: "upsert",
              kind: "bookmark",
              address,
              value: text(args.name) ?? null,
            },
          ]
        : [];
    case "unset_bookmark":
      return held
        ? [{ op: "delete", kind: "bookmark", address, value: null }]
        : [];
    case "annotate_native_function":
      return fromFunctionAnnotations(args, readback);
    default:
      return [];
  }
};

const functionReadback = z.object({
  annotations: z.object({
    address: z.string().min(1),
    name: z.string().min(1),
    comment: z.string().nullable(),
    inline_comment: z.string().nullable(),
  }),
});

// Only the fields the analyst asked to change are captured; the readback says
// what the provider now holds for them.
const fromFunctionAnnotations = (
  args: Readonly<Record<string, unknown>>,
  readback: unknown,
): Omit<AnnotationCapture, "target_sha256" | "provenance">[] => {
  const parsed = functionReadback.safeParse(readback);
  if (!parsed.success) return [];
  const { address, name, comment, inline_comment } = parsed.data.annotations;
  const captures: Omit<AnnotationCapture, "target_sha256" | "provenance">[] =
    [];
  if (args.name !== undefined)
    captures.push({ op: "upsert", kind: "name", address, value: name });
  for (const [kind, value] of [
    ["comment", comment],
    ["inline_comment", inline_comment],
  ] as const)
    if (args[kind] !== undefined)
      captures.push(
        value === null || value === ""
          ? { op: "delete", kind, address, value: null }
          : { op: "upsert", kind, address, value },
      );
  return captures;
};

const storable = (
  capture: Omit<AnnotationCapture, "target_sha256" | "provenance">,
) =>
  capture.value === null ||
  (capture.kind === "comment" || capture.kind === "inline_comment"
    ? noteTextSchema
    : lineSchema(capture.kind === "bookmark" ? 1024 : 4096)
  ).safeParse(capture.value).success;

/** Read what a settled annotation run changed; anything not confirmed is skipped. */
export const captureAnnotations = (
  run: ProjectRunRecord,
  workspaceId: string,
): AnnotationCapture[] => {
  if (run.status !== "completed") return [];
  const evidence = runEvidence(run);
  if (!evidence?.subject) return [];
  const provenance: Provenance = {
    run: { workspace_id: workspaceId, run_id: run.id },
    provider: evidence.provider,
    profile_digest: evidence.analysis_profile?.digest ?? null,
  };
  const target_sha256 = evidence.subject.digest.sha256;
  return fromReadback(run.tool, run.arguments, evidence.normalized_result)
    .filter(storable)
    .map((capture) => ({ ...capture, target_sha256, provenance }));
};

const sameSpot = (
  anchor: Anchor | null,
  provenance: Provenance,
  capture: AnnotationCapture,
) =>
  anchor?.target_sha256 === capture.target_sha256 &&
  anchor.location?.kind === "address" &&
  anchor.location.address === capture.address &&
  (provenance.provider?.id ?? null) ===
    (capture.provenance.provider?.id ?? null);

const addressAnchor = (capture: AnnotationCapture): Anchor => ({
  target_sha256: capture.target_sha256,
  target_id: null,
  location: { kind: "address", address: capture.address },
});

const foldName = (
  project: Project,
  capture: AnnotationCapture,
  now: string,
): Project => {
  const same = (item: Project["renames"][number]) =>
    item.target_sha256 === capture.target_sha256 &&
    item.address === capture.address &&
    (item.provenance.provider?.id ?? null) ===
      (capture.provenance.provider?.id ?? null);
  if (capture.op === "delete")
    return {
      ...project,
      renames: project.renames.filter((item) => !same(item)),
    };
  const name = capture.value ?? "";
  if (project.renames.some(same))
    return {
      ...project,
      renames: project.renames.map((item) =>
        same(item)
          ? { ...item, name, updatedAt: now, provenance: capture.provenance }
          : item,
      ),
    };
  limit(project.renames.length, PROJECT_LIMITS.renames, "renames");
  return {
    ...project,
    renames: [
      ...project.renames,
      {
        id: crypto.randomUUID(),
        target_sha256: capture.target_sha256,
        address: capture.address,
        name,
        createdAt: now,
        updatedAt: now,
        provenance: capture.provenance,
      },
    ],
  };
};

const foldComment = (
  project: Project,
  capture: AnnotationCapture,
  now: string,
): Project => {
  const same = (item: Project["notes"][number]) =>
    item.kind === capture.kind &&
    sameSpot(item.anchor, item.provenance, capture);
  if (capture.op === "delete")
    return { ...project, notes: project.notes.filter((item) => !same(item)) };
  const value = capture.value ?? "";
  if (project.notes.some(same))
    return {
      ...project,
      notes: project.notes.map((item) =>
        same(item)
          ? {
              ...item,
              text: value,
              updatedAt: now,
              provenance: capture.provenance,
            }
          : item,
      ),
    };
  limit(project.notes.length, PROJECT_LIMITS.notes, "notes");
  return {
    ...project,
    notes: [
      ...project.notes,
      {
        id: crypto.randomUUID(),
        text: value,
        anchor: addressAnchor(capture),
        kind: capture.kind === "inline_comment" ? "inline_comment" : "comment",
        createdAt: now,
        updatedAt: now,
        provenance: capture.provenance,
      },
    ],
  };
};

const foldBookmark = (
  project: Project,
  capture: AnnotationCapture,
  now: string,
): Project => {
  const same = (item: Project["bookmarks"][number]) =>
    sameSpot(item.anchor, item.provenance, capture);
  if (capture.op === "delete")
    return {
      ...project,
      bookmarks: project.bookmarks.filter((item) => !same(item)),
    };
  if (project.bookmarks.some(same))
    return {
      ...project,
      bookmarks: project.bookmarks.map((item) =>
        same(item)
          ? {
              ...item,
              label: capture.value ?? item.label,
              updatedAt: now,
              provenance: capture.provenance,
            }
          : item,
      ),
    };
  limit(project.bookmarks.length, PROJECT_LIMITS.bookmarks, "bookmarks");
  return {
    ...project,
    bookmarks: [
      ...project.bookmarks,
      {
        id: crypto.randomUUID(),
        label: capture.value ?? "",
        anchor: addressAnchor(capture),
        createdAt: now,
        updatedAt: now,
        provenance: capture.provenance,
      },
    ],
  };
};

/** Fold captures into a project: same key replaces, deletes remove. Revision is the caller's. */
export const applyCaptures = (
  project: Project,
  captures: readonly AnnotationCapture[],
  now: string,
): Result<Project, ProjectEditError> => {
  try {
    const next = captures.reduce(
      (current, capture) =>
        capture.kind === "name"
          ? foldName(current, capture, now)
          : capture.kind === "bookmark"
            ? foldBookmark(current, capture, now)
            : foldComment(current, capture, now),
      project,
    );
    const parsed = projectSchema.safeParse(next);
    return parsed.success
      ? ok(parsed.data)
      : err(
          new ProjectEditError(
            parsed.error.issues[0]?.message ?? "That change cannot be saved.",
          ),
        );
  } catch (cause) {
    if (cause instanceof ProjectEditError) return err(cause);
    throw cause;
  }
};
