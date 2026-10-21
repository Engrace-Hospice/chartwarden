import { Button, SelectField, TextField, useApiClient } from "@chartwarden/ui";
// apps/web/src/modules/22-documents — the §3.3 tag editor (#91's M22 row, unblocked by #153).
//
// This surface was not deferred by preference; it was UNBUILDABLE. `document_tag` had two writers and
// no reader anywhere in the repo, and the id its DELETE takes was returned exactly once by a POST whose
// contract declared no response body — so an editor could not have listed what was already on a
// document, and anything added through it would have been permanently invisible and undeletable on the
// next page load. A control that writes an invisible, unremovable row is worse than no control, which
// is why the M22 row shipped upload/edit/preview and stated this one instead of faking it.
//
// #153 built the reader, published the POST's response, and wired the cross-document `?tagKey=` query.
// What follows is the caller.
//
// Two things it does NOT do:
//   • It does not hide itself under legal hold. `ABAC_LEGAL_HOLD` refuses the write server-side and the
//     refusal is shown; a frontend that greys the control out is guessing at an authorization answer
//     only the server holds (ADR-0030).
//   • It does not warn about `free` vs `structured`. The distinction is real — free values may carry
//     PHI and are denylisted in the M4 audit trigger (§3.6) — so the choice is offered with that said
//     plainly, rather than defaulted silently to whichever is cheaper to explain.
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";
import {
  type TagKind,
  type TagView,
  addDocumentTag,
  listDocumentTags,
  removeDocumentTag,
} from "./documents-api";
import { Eyebrow, Mono } from "./lantern";

const KIND_OPTIONS: readonly { value: TagKind; label: string }[] = [
  { value: "structured", label: "Structured — a controlled key/value" },
  { value: "free", label: "Free text — may contain PHI" },
];

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "0.5rem",
  padding: "0.35rem 0",
};
const listStyle: CSSProperties = { display: "flex", flexDirection: "column" };
const formStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.5rem",
  marginTop: "0.75rem",
};
const errorText: CSSProperties = { color: "var(--color-error)", fontSize: "0.8rem" };
const mutedText: CSSProperties = { color: "var(--color-on-surface-variant)", fontSize: "0.8rem" };

export interface DocumentTagsProps {
  readonly documentId: string;
}

export function DocumentTags({ documentId }: DocumentTagsProps): JSX.Element {
  const client = useApiClient();
  const [tags, setTags] = useState<TagView[]>([]);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<TagKind>("structured");
  const [tagKey, setTagKey] = useState("");
  const [tagValue, setTagValue] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const res = await listDocumentTags(client, documentId);
    setLoading(false);
    if (!res.ok) {
      setReadError(res.message);
      return;
    }
    setReadError(null);
    setTags(res.value);
  }, [client, documentId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit(): Promise<void> {
    const key = tagKey.trim();
    if (!key) return;
    setBusy(true);
    setWriteError(null);
    const res = await addDocumentTag(client, documentId, {
      tagKind: kind,
      tagKey: key,
      // An empty value is a BARE KEY (null on the wire), not the empty string — the two are different
      // rows and the server distinguishes them.
      ...(tagValue.trim() ? { tagValue: tagValue.trim() } : {}),
    });
    setBusy(false);
    if (!res.ok) {
      setWriteError(res.message);
      return;
    }
    // The response carries the created row, so the list updates without a re-read. That is the whole
    // difference #153 made: before it, this id existed nowhere a client could hold it.
    setTags((current) => [res.value, ...current]);
    setTagKey("");
    setTagValue("");
    setAdding(false);
  }

  async function remove(tag: TagView): Promise<void> {
    setBusy(true);
    setWriteError(null);
    const res = await removeDocumentTag(client, documentId, tag.id);
    setBusy(false);
    if (!res.ok) {
      setWriteError(res.message);
      return;
    }
    setTags((current) => current.filter((t) => t.id !== tag.id));
  }

  return (
    <div>
      <Eyebrow>Tags</Eyebrow>
      {loading ? (
        <p style={mutedText}>Loading tags…</p>
      ) : readError ? (
        <p role="alert" style={errorText}>
          {readError}
        </p>
      ) : tags.length === 0 ? (
        <p style={mutedText}>No tags on this document.</p>
      ) : (
        <ul style={listStyle}>
          {tags.map((tag) => (
            <li key={tag.id} style={rowStyle}>
              <span>
                <Mono>{tag.tagKey}</Mono>
                {tag.tagValue ? ` · ${tag.tagValue}` : ""}
                {tag.tagKind === "free" ? <span style={mutedText}> (free text)</span> : null}
              </span>
              <Button
                size="sm"
                tone="tertiary"
                disabled={busy}
                aria-label={`Remove tag ${tag.tagKey}`}
                onClick={() => {
                  void remove(tag);
                }}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}

      {adding ? (
        <div style={formStyle}>
          <SelectField
            label="Kind"
            value={kind}
            disabled={busy}
            options={KIND_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
            onChange={(e) => setKind(e.target.value as TagKind)}
          />
          <TextField
            label="Key"
            value={tagKey}
            disabled={busy}
            onChange={(e) => setTagKey(e.target.value)}
          />
          <TextField
            label="Value"
            value={tagValue}
            disabled={busy}
            hint="Leave empty for a key with no value."
            onChange={(e) => setTagValue(e.target.value)}
          />
          {writeError ? (
            <p role="alert" style={errorText}>
              {writeError}
            </p>
          ) : null}
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <Button
              size="sm"
              disabled={busy || tagKey.trim() === ""}
              onClick={() => {
                void submit();
              }}
            >
              {busy ? "Adding…" : "Add tag"}
            </Button>
            <Button size="sm" tone="tertiary" disabled={busy} onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div style={{ marginTop: "0.5rem" }}>
          {writeError ? (
            <p role="alert" style={errorText}>
              {writeError}
            </p>
          ) : null}
          <Button size="sm" tone="tertiary" disabled={busy} onClick={() => setAdding(true)}>
            Add tag
          </Button>
        </div>
      )}
    </div>
  );
}
