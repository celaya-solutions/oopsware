import { useState } from "react";
import {
  Bookmark,
  Pencil,
  Save,
  StickyNote,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "../components/ui/button";
import type { Anchor, Project, ProjectEdit } from "./projectApi";

/** Save one edit; resolves true only when it was stored, so typed text is kept otherwise. */
type SaveEdit = (label: string, edit: ProjectEdit) => Promise<boolean>;

const shortSha = (sha: string | null) =>
  sha ? `${sha.slice(0, 12)}…` : "unknown";

/** Say where an item points, in the words the analyst used. */
export function anchorText(anchor: Anchor | null, project: Project): string {
  if (!anchor) return "Whole project";
  const target =
    project.targets.find(
      (item) =>
        (anchor.target_id !== null && item.id === anchor.target_id) ||
        (anchor.target_sha256 !== null && item.sha256 === anchor.target_sha256),
    )?.name ??
    (anchor.target_sha256 ? `file ${shortSha(anchor.target_sha256)}` : "");
  const location = anchor.location;
  const where =
    location === null
      ? ""
      : location.kind === "address"
        ? location.address
        : location.kind === "symbol"
          ? location.symbol
          : location.kind === "member_path"
            ? location.path
            : location.kind === "graph_node"
              ? location.label
              : `run ${location.run_id.slice(0, 8)}`;
  return [where, target].filter(Boolean).join(" in ") || "Whole project";
}

const KIND_LABEL = {
  note: "Note",
  comment: "Comment",
  inline_comment: "Inline comment",
};

function TargetPicker({
  project,
  value,
  onChange,
  digestOnly = false,
}: {
  project: Project;
  value: string;
  onChange: (id: string) => void;
  digestOnly?: boolean;
}) {
  const choices = project.targets.filter(
    (item) => !digestOnly || item.sha256 !== null,
  );
  return (
    <select
      aria-label="File"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">
        {digestOnly ? "Choose a file…" : "Whole project"}
      </option>
      {choices.map((item) => (
        <option key={item.id} value={item.id}>
          {item.name}
        </option>
      ))}
    </select>
  );
}

const anchorFor = (
  project: Project,
  targetId: string,
  address: string,
): Anchor => {
  const target = project.targets.find((item) => item.id === targetId);
  return {
    target_sha256: target?.sha256 ?? null,
    target_id: target?.id ?? null,
    location: address.trim()
      ? { kind: "address", address: address.trim() }
      : null,
  };
};

const source = (item: {
  provenance: Project["notes"][number]["provenance"];
}) =>
  item.provenance.provider
    ? `from ${item.provenance.provider.name}`
    : "added here";

export function NotesTab({
  project,
  save,
}: {
  project: Project;
  save: SaveEdit;
}) {
  const [text, setText] = useState("");
  const [targetId, setTargetId] = useState("");
  const [address, setAddress] = useState("");
  const [editing, setEditing] = useState<{ id: string; text: string }>();
  return (
    <div className="project-items">
      <form
        className="project-add"
        onSubmit={(event) => {
          event.preventDefault();
          if (!text.trim()) return;
          void save("Saving note", {
            kind: "add_note",
            text,
            anchor:
              targetId || address
                ? anchorFor(project, targetId, address)
                : null,
          }).then((saved) => {
            if (!saved) return;
            setText("");
            setAddress("");
          });
        }}
      >
        <textarea
          aria-label="New note"
          placeholder="Write a note…"
          rows={3}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <div className="project-add-row">
          <TargetPicker
            project={project}
            value={targetId}
            onChange={setTargetId}
          />
          <input
            aria-label="Address (optional)"
            placeholder="Address (optional)"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
          />
          <Button type="submit" size="sm" disabled={!text.trim()}>
            <StickyNote size={14} />
            Add note
          </Button>
        </div>
      </form>
      {project.notes.length === 0 && <p className="subtle">No notes yet.</p>}
      <ul className="project-item-list">
        {[...project.notes].reverse().map((note) => (
          <li key={note.id} className="project-item">
            <div className="project-item-head">
              <span className="badge">{KIND_LABEL[note.kind]}</span>
              <small className="subtle">
                {anchorText(note.anchor, project)} · {source(note)}
              </small>
            </div>
            {editing?.id === note.id ? (
              <div className="project-edit">
                <textarea
                  aria-label="Edit note"
                  rows={3}
                  value={editing.text}
                  onChange={(event) =>
                    setEditing({ id: note.id, text: event.target.value })
                  }
                />
                <Button
                  size="sm"
                  onClick={() => {
                    void save("Saving note", {
                      kind: "update_note",
                      id: note.id,
                      text: editing.text,
                    }).then((saved) => saved && setEditing(undefined));
                  }}
                >
                  <Save size={14} /> Save
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setEditing(undefined)}
                >
                  <X size={14} /> Cancel
                </Button>
              </div>
            ) : (
              <p className="project-note-text">{note.text}</p>
            )}
            <div className="project-item-actions">
              <Button
                size="sm"
                variant="ghost"
                aria-label="Edit note"
                onClick={() => setEditing({ id: note.id, text: note.text })}
              >
                <Pencil size={14} />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                aria-label="Delete note"
                onClick={() =>
                  save("Deleting note", { kind: "delete_note", id: note.id })
                }
              >
                <Trash2 size={14} />
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function BookmarksTab({
  project,
  save,
}: {
  project: Project;
  save: SaveEdit;
}) {
  const [label, setLabel] = useState("");
  const [targetId, setTargetId] = useState("");
  const [address, setAddress] = useState("");
  return (
    <div className="project-items">
      <form
        className="project-add project-add-row"
        onSubmit={(event) => {
          event.preventDefault();
          void save("Saving bookmark", {
            kind: "add_bookmark",
            label: label.trim(),
            anchor: anchorFor(project, targetId, address),
          }).then((saved) => {
            if (!saved) return;
            setLabel("");
            setAddress("");
          });
        }}
      >
        <input
          aria-label="Bookmark label"
          placeholder="Label"
          maxLength={1024}
          value={label}
          onChange={(event) => setLabel(event.target.value)}
        />
        <TargetPicker
          project={project}
          value={targetId}
          onChange={setTargetId}
        />
        <input
          aria-label="Bookmark address"
          placeholder="Address"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
        />
        <Button
          type="submit"
          size="sm"
          disabled={!label.trim() && !address.trim()}
        >
          <Bookmark size={14} />
          Add bookmark
        </Button>
      </form>
      {project.bookmarks.length === 0 && (
        <p className="subtle">No bookmarks yet.</p>
      )}
      <ul className="project-item-list">
        {project.bookmarks.map((item) => (
          <li key={item.id} className="project-item project-item-inline">
            <strong>{item.label || "Unnamed bookmark"}</strong>
            <small className="subtle">
              {anchorText(item.anchor, project)} · {source(item)}
            </small>
            <Button
              size="sm"
              variant="ghost"
              aria-label="Delete bookmark"
              onClick={() =>
                save("Deleting bookmark", {
                  kind: "delete_bookmark",
                  id: item.id,
                })
              }
            >
              <Trash2 size={14} />
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function RenamesTab({
  project,
  save,
}: {
  project: Project;
  save: SaveEdit;
}) {
  const [targetId, setTargetId] = useState("");
  const [address, setAddress] = useState("");
  const [name, setName] = useState("");
  const target = project.targets.find((item) => item.id === targetId);
  return (
    <div className="project-items">
      <form
        className="project-add project-add-row"
        onSubmit={(event) => {
          event.preventDefault();
          if (!target?.sha256) return;
          void save("Saving name", {
            kind: "add_rename",
            target_sha256: target.sha256,
            address: address.trim(),
            name: name.trim(),
          }).then((saved) => {
            if (!saved) return;
            setAddress("");
            setName("");
          });
        }}
      >
        <TargetPicker
          project={project}
          value={targetId}
          onChange={setTargetId}
          digestOnly
        />
        <input
          aria-label="Address"
          placeholder="Address"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
        />
        <input
          aria-label="Name"
          placeholder="Name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <Button
          type="submit"
          size="sm"
          disabled={!target?.sha256 || !address.trim() || !name.trim()}
        >
          <Tag size={14} />
          Add name
        </Button>
      </form>
      {project.renames.length === 0 && <p className="subtle">No names yet.</p>}
      <ul className="project-item-list">
        {project.renames.map((item) => (
          <li key={item.id} className="project-item project-item-inline">
            <code>{item.address}</code>
            <strong>{item.name}</strong>
            <small className="subtle">
              {anchorText(
                {
                  target_sha256: item.target_sha256,
                  target_id: null,
                  location: null,
                },
                project,
              )}{" "}
              · {source(item)}
            </small>
            <Button
              size="sm"
              variant="ghost"
              aria-label="Delete name"
              onClick={() =>
                save("Deleting name", { kind: "delete_rename", id: item.id })
              }
            >
              <Trash2 size={14} />
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
