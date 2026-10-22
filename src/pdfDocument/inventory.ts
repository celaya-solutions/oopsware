import { createHash } from "node:crypto";

import { MemberReadFailure } from "../artifacts/zipMemberView.js";
import type {
  PdfAction,
  PdfAttachment,
  PdfSignature,
} from "../domain/pdfDocument/pdfDocument.js";
import { PdfEncryptedError } from "./file.js";
import {
  label,
  MAX_ANNOTATIONS_PER_PAGE,
  MAX_TREE_NODES,
  type PageEntry,
  type PdfStructure,
} from "./structure.js";
import {
  asArray,
  asCount,
  asDict,
  asName,
  asRef,
  asStream,
  asString,
  type PdfDict,
  type PdfRef,
  type PdfValue,
} from "./syntax.js";
import { clip, printable, textString } from "./text.js";

const MAX_FIELDS = 100_000;
const MAX_OUTLINE_ITEMS = 5_000;
/** Annotations are scanned on this many pages for the package view's inventories. */
export const ANNOTATION_SCAN_PAGES = 2_000;
/** Annotations parsed for the inventories, over all pages. */
export const MAX_ANNOTATIONS_SCANNED = 100_000;
export const MAX_LISTED = 500;
const MAX_SCRIPT_CHARS = 2_000;
const MAX_TRIGGER_CHARS = 600;
const MAX_NAME_CHARS = 256;
const MAX_NEXT_FANOUT = 1_000;
/** Steps across the name-tree, action and form walks together; shared hubs cannot multiply past it. */
const MAX_WALK_STEPS = 1_000_000;
/** Longest gap between signed ranges that is checked byte by byte. */
const MAX_GAP_CHECK = 16 * 1024 ** 2;

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const sha = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
const isHexOrSpace = (code: number): boolean =>
  (code >= 0x30 && code <= 0x39) ||
  (code >= 0x41 && code <= 0x46) ||
  (code >= 0x61 && code <= 0x66) ||
  [0, 9, 10, 12, 13, 32].includes(code);

/** Annotation subtypes that carry media or 3D content, listed so they are not missed. */
const MEDIA_ANNOTATIONS: ReadonlyMap<string, PdfAction["kind"]> = new Map([
  ["RichMedia", "RichMedia"],
  ["Movie", "Movie"],
  ["Sound", "Sound"],
  ["3D", "ThreeD"],
  ["Screen", "Rendition"],
]);

/** Collected inventories from the annotations, forms, outlines and name trees. */
export interface Inventories {
  readonly attachments: PdfAttachment[];
  attachmentTotal: number;
  readonly actions: PdfAction[];
  actionTotal: number;
  readonly signatures: PdfSignature[];
  signatureTotal: number;
  annotationPagesScanned: number;
  budgetHit: boolean;
  /** Where a walk stopped early, in words. */
  readonly notes: string[];
  form: {
    fields: number;
    signature_fields: number;
    need_appearances: boolean;
    xfa: boolean;
  } | null;
}

const emptyAction = (
  kind: PdfAction["kind"],
  trigger: string,
  object: string | null,
  target: string | null,
): PdfAction => ({
  kind,
  trigger: clip(trigger, MAX_TRIGGER_CHARS).text,
  object,
  target,
  script_bytes: null,
  script_sha256: null,
  script: null,
  script_truncated: false,
});

/** One action dictionary as an inventory record, or null when it is not one of the kinds worth listing. */
const actionRecord = (
  s: PdfStructure,
  dict: PdfDict,
  trigger: string,
  object: string | null,
): PdfAction | null => {
  const kind = asName(s.file.resolve(dict.map.get("S")));
  if (kind === null) return null;
  const target = (value: PdfValue | undefined): string | null => {
    const resolved = s.file.resolve(value);
    const direct = s.text(resolved);
    if (direct !== null) return direct;
    const spec = asDict(resolved);
    if (spec === null) return null;
    return (
      s.text(spec.map.get("UF")) ??
      s.text(spec.map.get("F")) ??
      s.text(spec.map.get("Unix")) ??
      s.text(spec.map.get("DOS"))
    );
  };
  switch (kind) {
    case "JavaScript":
      return javascriptRecord(s, dict, trigger, object);
    case "URI":
      return emptyAction("URI", trigger, object, target(dict.map.get("URI")));
    case "Launch":
      return emptyAction(
        "Launch",
        trigger,
        object,
        target(dict.map.get("F")) ?? target(dict.map.get("Win")),
      );
    case "GoToR":
    case "GoToE":
    case "ImportData":
    case "SubmitForm":
      return emptyAction(kind, trigger, object, target(dict.map.get("F")));
    case "Rendition":
      return emptyAction("Rendition", trigger, object, null);
    default:
      return null;
  }
};

const javascriptRecord = (
  s: PdfStructure,
  dict: PdfDict,
  trigger: string,
  object: string | null,
): PdfAction => {
  const base = emptyAction("JavaScript", trigger, object, null);
  const js = s.file.resolve(dict.map.get("JS"));
  const stream = asStream(js);
  let bytes: Uint8Array | null = null;
  if (stream !== null) {
    try {
      const decoded = s.file.decoded(stream);
      if (decoded.state === "complete") bytes = decoded.bytes;
    } catch (cause) {
      if (cause instanceof MemberReadFailure) s.budgetHit = true;
      else if (!(cause instanceof PdfEncryptedError)) throw cause;
    }
  } else bytes = asString(js)?.bytes ?? null;
  if (bytes === null) return base;
  const utf16 = bytes[0] === 0xfe && bytes[1] === 0xff;
  const source =
    stream !== null && !utf16
      ? new TextDecoder().decode(bytes)
      : textString({ t: "str", bytes });
  const shown = clip(printable(source), MAX_SCRIPT_CHARS);
  return {
    ...base,
    script_bytes: bytes.length,
    script_sha256: sha(bytes),
    script: shown.text,
    script_truncated: shown.truncated,
  };
};

const attachmentRecord = (
  s: PdfStructure,
  spec: PdfValue | undefined,
  source: PdfAttachment["source"],
  key: string | null,
  found: Inventories,
): PdfAttachment => {
  const ref = asRef(spec);
  const dict = s.dict(spec);
  const empty: PdfAttachment = {
    source,
    name: key,
    description: null,
    object: label(ref),
    media_type: null,
    relationship: null,
    declared_bytes: null,
    decoded_bytes: null,
    sha256: null,
    declared_md5: null,
    created: null,
    modified: null,
    filters: [],
    state: "unreadable",
    note: "The file specification is not a dictionary.",
  };
  if (dict === null) return empty;
  const ef = s.dict(dict.map.get("EF"));
  const name = s.text(dict.map.get("UF")) ?? s.text(dict.map.get("F")) ?? key;
  const description = s.text(dict.map.get("Desc"));
  const relationship = asName(s.file.resolve(dict.map.get("AFRelationship")));
  const embedded = ef?.map.get("UF") ?? ef?.map.get("F");
  const stream = asStream(s.file.resolve(embedded));
  if (stream === null) {
    // A specification without embedded data points outside the file; it is listed as an action, never opened.
    found.actionTotal += 1;
    if (found.actions.length < MAX_LISTED)
      found.actions.push(
        emptyAction("FileSpec", "file specification", label(ref), name),
      );
    return {
      ...empty,
      name,
      description,
      relationship:
        relationship === null ? null : clip(relationship, MAX_NAME_CHARS).text,
      note: "The specification names a file but embeds no data; nothing was opened.",
    };
  }
  const params = s.dict(stream.dict.map.get("Params"));
  const subtype = asName(s.file.resolve(stream.dict.map.get("Subtype")));
  const md5 = asString(s.file.resolve(params?.map.get("CheckSum")));
  const common = {
    source,
    name,
    description,
    object: label(asRef(embedded)),
    media_type: subtype === null ? null : clip(subtype, MAX_NAME_CHARS).text,
    relationship:
      relationship === null ? null : clip(relationship, MAX_NAME_CHARS).text,
    declared_bytes: asCount(s.file.resolve(params?.map.get("Size"))),
    declared_md5: md5 === null ? null : hex(md5.bytes.subarray(0, 32)),
    created: s.text(params?.map.get("CreationDate")),
    modified: s.text(params?.map.get("ModDate")),
    filters: s.file
      .filters(stream)
      .names.map((filter) => clip(filter, MAX_NAME_CHARS).text),
  };
  try {
    const decoded = s.file.decoded(stream);
    if (decoded.state !== "complete")
      return {
        ...common,
        decoded_bytes: null,
        sha256: null,
        state: "not-decoded",
        note:
          decoded.state === "truncated"
            ? `${decoded.note ?? "The data ends early."} No hash is given for a partial stream.`
            : (decoded.note ??
              `The ${decoded.filters.join(", ")} filter is not decoded here.`),
      };
    return {
      ...common,
      decoded_bytes: decoded.bytes.length,
      sha256: sha(decoded.bytes),
      state: "read",
      note: null,
    };
  } catch (cause) {
    if (cause instanceof MemberReadFailure) {
      s.budgetHit = true;
      return {
        ...common,
        decoded_bytes: null,
        sha256: null,
        state: "over-budget",
        note: cause.message,
      };
    }
    throw cause;
  }
};

/**
 * Where the bytes a signature's ranges leave out lie, and what they hold.
 * `ok` only when the gap is exactly the `Contents` hex string, so a signature
 * whose range skips other bytes (a signature-wrapping trick) is not called whole.
 */
const gapIsContents = (
  bytes: Uint8Array,
  start: number,
  end: number,
): boolean => {
  if (end - start > MAX_GAP_CHECK || end - start < 2) return false;
  if (bytes[start] !== 0x3c || bytes[end - 1] !== 0x3e) return false;
  for (let at = start + 1; at < end - 1; at += 1)
    if (!isHexOrSpace(bytes[at] as number)) return false;
  return true;
};

const signatureRecord = (
  s: PdfStructure,
  value: PdfDict,
  ref: PdfRef | null,
  field: string | null,
  found: Inventories,
  seen: Set<number>,
): void => {
  if (ref !== null) {
    if (seen.has(ref.num)) return;
    seen.add(ref.num);
  }
  const subFilter = asName(s.file.resolve(value.map.get("SubFilter")));
  const type = asName(s.file.resolve(value.map.get("Type")));
  if (
    subFilter === null &&
    !value.map.has("ByteRange") &&
    !value.map.has("Contents")
  )
    return;
  found.signatureTotal += 1;
  if (found.signatures.length >= MAX_LISTED) return;
  const range = asArray(s.file.resolve(value.map.get("ByteRange")))?.items.map(
    (item) => asCount(s.file.resolve(item)),
  );
  const bytes = s.file.bytes;
  let byteRange: number[] | null = null;
  let coverage: PdfSignature["coverage"] = "no-range";
  let trailing: number | null = null;
  let gap: number | null = null;
  if (range !== undefined) {
    if (range.length === 4 && range.every((item) => item !== null)) {
      const [a, b, c, d] = range as [number, number, number, number];
      byteRange = [a, b, c, d];
      gap = c - (a + b);
      if (a !== 0 || c < a + b || c + d > bytes.length)
        coverage = "invalid-range";
      else if (!gapIsContents(bytes, a + b, c)) coverage = "gap-mismatch";
      else {
        let end = bytes.length;
        while (
          end > c + d &&
          [0, 9, 10, 12, 13, 32].includes(bytes[end - 1] as number)
        )
          end -= 1;
        trailing = Math.max(0, end - (c + d));
        coverage = trailing === 0 ? "whole-file" : "earlier-revision";
      }
    } else coverage = "invalid-range";
  }
  const contents = asString(s.file.resolve(value.map.get("Contents")));
  let permission: number | null = null;
  const references = asArray(s.file.resolve(value.map.get("Reference")));
  if (references !== null)
    for (const item of references.items.slice(0, 16)) {
      const reference = s.dict(item);
      if (
        reference !== null &&
        asName(s.file.resolve(reference.map.get("TransformMethod"))) ===
          "DocMDP"
      ) {
        const params = s.dict(reference.map.get("TransformParams"));
        const p = asCount(s.file.resolve(params?.map.get("P")));
        permission = p;
      }
    }
  const subFilterText =
    subFilter === null ? null : clip(subFilter, MAX_NAME_CHARS).text;
  found.signatures.push({
    field,
    object: label(ref),
    type: type === "DocTimeStamp" ? "timestamp" : "signature",
    sub_filter: subFilterText,
    byte_range: byteRange,
    coverage,
    gap_bytes: gap !== null && gap >= 0 ? gap : null,
    uncovered_trailing_bytes: trailing,
    contents_bytes: contents?.bytes.length ?? null,
    signer: s.text(value.map.get("Name")),
    reason: s.text(value.map.get("Reason")),
    location: s.text(value.map.get("Location")),
    signing_time: s.text(value.map.get("M"), MAX_NAME_CHARS),
    contact: s.text(value.map.get("ContactInfo")),
    doc_mdp_permission: permission,
  });
};

/** Run the name-tree, action, annotation, form, signature and outline walks, each bounded. */
export const collectInventories = (s: PdfStructure): Inventories => {
  const found: Inventories = {
    attachments: [],
    attachmentTotal: 0,
    actions: [],
    actionTotal: 0,
    signatures: [],
    signatureTotal: 0,
    annotationPagesScanned: 0,
    budgetHit: false,
    notes: [],
    form: null,
  };
  if (s.file.encrypted) return found;
  const catalog = s.catalog();
  if (catalog === null) return found;
  const file = s.file;
  const seenSignatures = new Set<number>();
  const seenActions = new Set<number>();
  let steps = 0;
  let stepNote = false;
  const step = (): boolean => {
    file.tick();
    steps += 1;
    if (steps <= MAX_WALK_STEPS) return true;
    if (!stepNote) {
      stepNote = true;
      found.notes.push(
        `The inventory walks stopped after ${String(MAX_WALK_STEPS)} steps; later entries are not listed.`,
      );
    }
    return false;
  };

  const nameTree = (
    root: PdfValue | undefined,
    visit: (key: string | null, value: PdfValue) => void,
  ): void => {
    const stack: PdfValue[] = [root as PdfValue];
    const seen = new Set<number>();
    let nodes = 0;
    while (stack.length > 0 && nodes < MAX_TREE_NODES && step()) {
      const raw = stack.pop() as PdfValue;
      const ref = asRef(raw);
      if (ref !== null) {
        if (seen.has(ref.num)) continue;
        seen.add(ref.num);
      }
      const node = s.dict(raw);
      if (node === null) continue;
      nodes += 1;
      const names = asArray(file.resolve(node.map.get("Names")));
      if (names !== null)
        for (let at = 0; at + 1 < names.items.length; at += 2) {
          if (!step()) return;
          visit(
            s.text(names.items[at], MAX_NAME_CHARS),
            names.items[at + 1] as PdfValue,
          );
        }
      const kids = asArray(file.resolve(node.map.get("Kids")));
      if (kids !== null)
        for (const kid of [...kids.items].reverse()) stack.push(kid);
    }
  };

  const addAttachment = (
    spec: PdfValue | undefined,
    source: PdfAttachment["source"],
    key: string | null,
  ): void => {
    found.attachmentTotal += 1;
    if (found.attachments.length >= MAX_LISTED) return;
    found.attachments.push(attachmentRecord(s, spec, source, key, found));
  };

  /** Follow `Next` links and arrays with an explicit stack; an action object is read once, whatever refers to it. */
  const addAction = (holder: PdfValue | undefined, trigger: string): void => {
    const stack: { value: PdfValue | undefined; trigger: string }[] = [
      { value: holder, trigger },
    ];
    while (stack.length > 0 && step()) {
      const frame = stack.pop() as (typeof stack)[number];
      const ref = asRef(frame.value);
      const dict = s.dict(frame.value);
      if (dict === null) continue;
      if (ref !== null) {
        if (seenActions.has(ref.num)) continue;
        seenActions.add(ref.num);
      }
      const record = actionRecord(s, dict, frame.trigger, label(ref));
      if (record !== null) {
        found.actionTotal += 1;
        if (found.actions.length < MAX_LISTED) found.actions.push(record);
      }
      const next = dict.map.get("Next");
      const chain = asArray(file.resolve(next));
      if (chain !== null)
        for (const item of chain.items.slice(0, MAX_NEXT_FANOUT))
          stack.push({ value: item, trigger: frame.trigger });
      else if (next !== undefined)
        stack.push({ value: next, trigger: frame.trigger });
    }
  };

  const addActionsOf = (holder: PdfDict, trigger: string): void => {
    addAction(holder.map.get("A"), trigger);
    const triggers = s.dict(holder.map.get("AA"));
    if (triggers !== null)
      for (const [event, value] of triggers.map)
        addAction(value, `${trigger} ${clip(event, 64).text}`);
  };

  // Catalog level.
  if (asDict(file.resolve(catalog.map.get("OpenAction"))) !== null)
    addAction(catalog.map.get("OpenAction"), "OpenAction");
  addActionsOf(catalog, "Catalog");
  const names = s.dict(catalog.map.get("Names"));
  nameTree(names?.map.get("JavaScript"), (key, value) =>
    addAction(
      value,
      `Names JavaScript ${key === null ? "" : JSON.stringify(key)}`.trim(),
    ),
  );
  nameTree(s.dict(names?.map.get("EmbeddedFiles")), (key, value) =>
    addAttachment(value, "name-tree", key),
  );

  // Pages: their triggers and annotations.
  const { entries } = s.pages();
  const wanted = Math.min(entries.length, ANNOTATION_SCAN_PAGES);
  let scanned = 0;
  let annotationsSeen = 0;
  for (
    ;
    scanned < wanted && annotationsSeen < MAX_ANNOTATIONS_SCANNED;
    scanned += 1
  ) {
    file.tick();
    const page = entries[scanned] as PageEntry;
    addActionsOf(page.dict, `page ${String(page.index + 1)}`);
    const annots = asArray(file.resolve(page.dict.map.get("Annots")));
    if (annots === null) continue;
    annotationsSeen += Math.min(annots.items.length, MAX_ANNOTATIONS_PER_PAGE);
    for (const item of annots.items.slice(0, MAX_ANNOTATIONS_PER_PAGE)) {
      file.tick();
      const annot = s.dict(item);
      if (annot === null) continue;
      const subtype = asName(file.resolve(annot.map.get("Subtype")));
      const shown = subtype === null ? "annotation" : clip(subtype, 64).text;
      const trigger = `page ${String(page.index + 1)} ${shown}`;
      if (subtype === "FileAttachment")
        addAttachment(
          annot.map.get("FS"),
          "annotation",
          s.text(annot.map.get("Contents"), MAX_NAME_CHARS),
        );
      const media =
        subtype === null ? undefined : MEDIA_ANNOTATIONS.get(subtype);
      if (media !== undefined) {
        found.actionTotal += 1;
        if (found.actions.length < MAX_LISTED)
          found.actions.push(
            emptyAction(media, trigger, label(asRef(item)), null),
          );
      }
      addActionsOf(annot, trigger);
    }
  }
  found.annotationPagesScanned = scanned;

  // Form fields: signatures, field actions and the form summary.
  const form = s.dict(catalog.map.get("AcroForm"));
  if (form !== null) {
    const summary = {
      fields: 0,
      signature_fields: 0,
      need_appearances: file.resolve(form.map.get("NeedAppearances")) === true,
      xfa: form.map.has("XFA"),
    };
    const stack: {
      value: PdfValue;
      type: string | null;
      parent: string | null;
    }[] = [];
    const roots = asArray(file.resolve(form.map.get("Fields")));
    if (roots !== null)
      for (const item of [...roots.items].reverse())
        stack.push({ value: item, type: null, parent: null });
    const seen = new Set<number>();
    let queued = stack.length;
    while (stack.length > 0 && summary.fields < MAX_FIELDS && step()) {
      const frame = stack.pop() as (typeof stack)[number];
      const ref = asRef(frame.value);
      if (ref !== null) {
        if (seen.has(ref.num)) continue;
        seen.add(ref.num);
      }
      const field = s.dict(frame.value);
      if (field === null) continue;
      const own = s.text(field.map.get("T"), MAX_NAME_CHARS);
      const fullName =
        own === null
          ? frame.parent
          : frame.parent === null
            ? own
            : clip(`${frame.parent}.${own}`, MAX_NAME_CHARS).text;
      const type = asName(file.resolve(field.map.get("FT"))) ?? frame.type;
      const kids = asArray(file.resolve(field.map.get("Kids")));
      if (kids !== null)
        for (const kid of [...kids.items].reverse()) {
          // Counting what is queued keeps a shared Kids array from multiplying.
          queued += 1;
          if (queued > MAX_FIELDS * 4) {
            found.notes.push(
              "The form field walk stopped at its queue limit; later fields are not listed.",
            );
            break;
          }
          stack.push({ value: kid, type, parent: fullName });
        }
      if (own === null && !field.map.has("FT")) continue;
      summary.fields += 1;
      addActionsOf(
        field,
        `form field${fullName === null ? "" : ` ${JSON.stringify(fullName)}`}`,
      );
      if (type === "Sig") {
        summary.signature_fields += 1;
        const value = s.dict(field.map.get("V"));
        if (value !== null)
          signatureRecord(
            s,
            value,
            asRef(field.map.get("V")),
            fullName,
            found,
            seenSignatures,
          );
      }
    }
    found.form = summary;
  }
  // Document-level signatures and time stamps that no field names.
  const perms = s.dict(catalog.map.get("Perms"));
  if (perms !== null)
    for (const key of ["DocMDP", "UR3"]) {
      const value = s.dict(perms.map.get(key));
      if (value !== null)
        signatureRecord(
          s,
          value,
          asRef(perms.map.get(key)),
          `Perms ${key}`,
          found,
          seenSignatures,
        );
    }

  // Outline items.
  const outline = s.dict(catalog.map.get("Outlines"));
  if (outline !== null) {
    const stack: PdfValue[] = [outline.map.get("First") as PdfValue];
    const seen = new Set<number>();
    let count = 0;
    while (stack.length > 0 && count < MAX_OUTLINE_ITEMS && step()) {
      const raw = stack.pop() as PdfValue;
      const ref = asRef(raw);
      if (ref !== null) {
        if (seen.has(ref.num)) continue;
        seen.add(ref.num);
      }
      const item = s.dict(raw);
      if (item === null) continue;
      count += 1;
      addAction(
        item.map.get("A"),
        `outline ${JSON.stringify(s.text(item.map.get("Title"), 128) ?? "")}`,
      );
      if (item.map.has("Next")) stack.push(item.map.get("Next") as PdfValue);
      if (item.map.has("First")) stack.push(item.map.get("First") as PdfValue);
    }
  }
  found.budgetHit = s.budgetHit;
  return found;
};
