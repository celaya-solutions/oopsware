import type { Project, Provenance } from "./projectSchema.js";

/** What the open native session says about itself, read from `binary_session`. */
export interface SessionIdentity {
  readonly sha256: string | null;
  readonly provider_id: string | null;
  readonly profile_digest: string | null;
  readonly capabilities: {
    readonly names: boolean;
    readonly comments: boolean;
    readonly bookmarks: boolean;
  };
}

export interface ApplyCall {
  readonly tool: string;
  readonly arguments: Record<string, unknown>;
}

export type ApplyPlan =
  | {
      readonly ok: true;
      readonly calls: ApplyCall[];
      readonly skipped: { kind: string; count: number; reason: string }[];
    }
  | { readonly ok: false; readonly reason: string };

const NOUNS: Readonly<Record<string, string>> = {
  name: "names",
  comment: "comments",
  inline_comment: "inline comments",
  bookmark: "bookmarks",
};

const address = (anchor: Project["notes"][number]["anchor"]) =>
  anchor?.location?.kind === "address" ? anchor.location.address : undefined;

/**
 * Plan the annotation tool calls that put a project's names, comments and
 * bookmarks for one file back into an open session, or say why not.
 */
export const planApplyToSession = (
  project: Project,
  targetSha256: string,
  session: SessionIdentity,
): ApplyPlan => {
  if (session.sha256 === null || session.provider_id === null)
    return { ok: false, reason: "The open session's identity is unknown." };
  if (session.sha256 !== targetSha256)
    return { ok: false, reason: "The open session is a different file." };

  const renames = project.renames.filter(
    (item) => item.target_sha256 === targetSha256,
  );
  const comments = project.notes.filter(
    (item) =>
      item.kind !== "note" &&
      item.anchor?.target_sha256 === targetSha256 &&
      address(item.anchor) !== undefined,
  );
  const bookmarks = project.bookmarks.filter(
    (item) =>
      item.anchor.target_sha256 === targetSha256 &&
      address(item.anchor) !== undefined,
  );
  const provenances: Provenance[] = [...renames, ...comments, ...bookmarks].map(
    (item) => item.provenance,
  );
  const foreign = provenances.find(
    (item) =>
      item.provider !== null && item.provider.id !== session.provider_id,
  );
  if (foreign?.provider)
    return {
      ok: false,
      reason: `These items were made in ${foreign.provider.name}, but the open session uses ${session.provider_id}. Addresses can differ between tools.`,
    };
  if (
    session.profile_digest !== null &&
    provenances.some(
      (item) =>
        item.profile_digest !== null &&
        item.profile_digest !== session.profile_digest,
    )
  )
    return {
      ok: false,
      reason:
        "The open session was analyzed with different settings, so addresses may not match.",
    };

  const calls: ApplyCall[] = [];
  const skipped: { kind: string; count: number; reason: string }[] = [];
  const skip = (kind: string, count: number) => {
    if (count > 0)
      skipped.push({
        kind,
        count,
        reason: `This provider cannot store ${NOUNS[kind] ?? kind}.`,
      });
  };
  if (session.capabilities.names) {
    if (renames.length > 0)
      calls.push({
        tool: "set_addresses_names",
        arguments: {
          names: Object.fromEntries(
            renames.map((item) => [item.address, item.name]),
          ),
        },
      });
  } else skip("name", renames.length);
  for (const kind of ["comment", "inline_comment"] as const) {
    const items = comments.filter((item) => item.kind === kind);
    if (!session.capabilities.comments) {
      skip(kind, items.length);
      continue;
    }
    for (const item of items)
      calls.push({
        tool: kind === "comment" ? "set_comment" : "set_inline_comment",
        arguments: { address: address(item.anchor), comment: item.text },
      });
  }
  if (session.capabilities.bookmarks)
    for (const item of bookmarks)
      calls.push({
        tool: "set_bookmark",
        arguments: { address: address(item.anchor), name: item.label },
      });
  else skip("bookmark", bookmarks.length);
  return { ok: true, calls, skipped };
};
