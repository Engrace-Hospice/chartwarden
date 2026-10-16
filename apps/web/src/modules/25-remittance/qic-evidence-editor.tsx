import { Button, InlineAlert, TextField } from "@wardenx/ui";
// apps/web/src/modules/25-remittance — the cited-evidence editor of a QIC reconsideration draft (milestone 4) and the
// fields a reconsideration adds to the submit form. The redetermination notice names the documentation it found
// missing; each item is either enclosed (an attached document) or explained, and the person is warned that evidence
// left out may be excluded at later levels of appeal. The server decides completeness at submit; this only collects
// the list and refuses the shapes it would refuse.
import { useState } from "react";
import type { JSX } from "react";
import { ButtonRow, Hint } from "./action-ui";
import { MIN_UNAVAILABLE_REASON, type QicView } from "./qic-api";
import { isUuid } from "./remittance-api";

/** Always visible on a reconsideration draft (the PRD-verified consequence of leaving evidence out). */
export function PreclusionWarning(): JSX.Element {
  return (
    <InlineAlert tone="warning">
      Evidence that is not submitted before the reconsideration notice may be excluded at later
      levels of appeal unless good cause is shown. Include every document the redetermination notice
      named as missing.
    </InlineAlert>
  );
}

interface DraftItem {
  readonly label: string;
  readonly documentId: string;
  readonly reason: string;
}

const toDraft = (items: QicView["citedEvidence"]): readonly DraftItem[] =>
  items.map((i) => ({
    label: i.label,
    documentId: i.documentId ?? "",
    reason: i.notAvailableReason ?? "",
  }));

function itemProblem(item: DraftItem): string | null {
  if (item.label.trim() === "") return "Name the documentation.";
  if (item.documentId.trim() !== "") {
    return isUuid(item.documentId) ? null : "Enter the attached document's UUID.";
  }
  return item.reason.trim().length >= MIN_UNAVAILABLE_REASON
    ? null
    : `Say why it is not available (${MIN_UNAVAILABLE_REASON} characters minimum).`;
}

export interface EvidenceEditorProps {
  readonly view: QicView;
  readonly busy: boolean;
  readonly onSave: (body: {
    items: { label: string; documentId: string | null; notAvailableReason: string | null }[];
    none: boolean;
  }) => void;
}

export function EvidenceEditor({ view, busy, onSave }: EvidenceEditorProps): JSX.Element {
  const [items, setItems] = useState<readonly DraftItem[]>(() => toDraft(view.citedEvidence));
  const [none, setNone] = useState(view.citedEvidenceNone);

  const setItem = (at: number, patch: Partial<DraftItem>): void =>
    setItems((cur) => cur.map((it, i) => (i === at ? { ...it, ...patch } : it)));
  const blocked =
    (none && items.length > 0) ||
    (!none && items.length === 0) ||
    items.some((i) => itemProblem(i) !== null);

  return (
    <>
      <h4 className="wx-action-title">Documentation the redetermination notice named</h4>
      <Hint>
        List each item the notice said was missing, and attach its document to this request. If the
        notice named none, say so below. The list is part of the filed request and cannot be edited
        after submitting.
      </Hint>
      {items.map((item, at) => {
        const problem = itemProblem(item);
        return (
          // The list is edited in place and never reordered, so the position is a stable key.
          // biome-ignore lint/suspicious/noArrayIndexKey: draft rows have no id until saved
          <div key={at} className="wx-action-body">
            <TextField
              label={`Item ${at + 1}`}
              value={item.label}
              maxLength={300}
              onChange={(e) => setItem(at, { label: e.target.value })}
            />
            <TextField
              label="Attached document ID (leave blank if it cannot be enclosed)"
              value={item.documentId}
              onChange={(e) => setItem(at, { documentId: e.target.value })}
            />
            {item.documentId.trim() === "" ? (
              <TextField
                label="Why it is not available"
                value={item.reason}
                maxLength={1000}
                onChange={(e) => setItem(at, { reason: e.target.value })}
              />
            ) : null}
            {problem ? <Hint>{problem}</Hint> : null}
            <ButtonRow end>
              <Button
                tone="tertiary"
                size="sm"
                onClick={() => setItems((cur) => cur.filter((_, i) => i !== at))}
              >
                Remove item
              </Button>
            </ButtonRow>
          </div>
        );
      })}
      <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.85rem" }}>
        <input type="checkbox" checked={none} onChange={(e) => setNone(e.target.checked)} />
        <span>The redetermination notice named no missing documentation</span>
      </label>
      <ButtonRow end>
        <Button
          tone="secondary"
          size="sm"
          disabled={busy || none}
          onClick={() => setItems((cur) => [...cur, { label: "", documentId: "", reason: "" }])}
        >
          Add item
        </Button>
        <Button
          size="sm"
          disabled={busy || blocked}
          onClick={() =>
            onSave({
              none,
              items: items.map((i) => ({
                label: i.label.trim(),
                documentId: i.documentId.trim() === "" ? null : i.documentId.trim(),
                notAvailableReason: i.documentId.trim() === "" ? i.reason.trim() : null,
              })),
            })
          }
        >
          Save evidence list
        </Button>
      </ButtonRow>
    </>
  );
}

export interface ReconsiderationSubmitState {
  readonly macName: string;
  readonly noticeDocumentId: string;
  readonly acknowledged: boolean;
}

export const EMPTY_RECONSIDERATION_SUBMIT: ReconsiderationSubmitState = {
  macName: "",
  noticeDocumentId: "",
  acknowledged: false,
};

/** True while the reconsideration-only submit fields are incomplete (the server still checks the evidence). */
export const reconsiderationSubmitBlocked = (s: ReconsiderationSubmitState): boolean =>
  s.macName.trim() === "" || !isUuid(s.noticeDocumentId);

export function ReconsiderationSubmitFields({
  value,
  onChange,
}: {
  readonly value: ReconsiderationSubmitState;
  readonly onChange: (next: ReconsiderationSubmitState) => void;
}): JSX.Element {
  return (
    <>
      <PreclusionWarning />
      <TextField
        label="MAC that issued the redetermination notice"
        value={value.macName}
        maxLength={120}
        onChange={(e) => onChange({ ...value, macName: e.target.value })}
      />
      <TextField
        label="Document ID of the copy of the redetermination notice (also list it in the attached documents)"
        value={value.noticeDocumentId}
        onChange={(e) => onChange({ ...value, noticeDocumentId: e.target.value })}
        error={
          value.noticeDocumentId && !isUuid(value.noticeDocumentId)
            ? "Enter a document UUID."
            : undefined
        }
      />
      <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.85rem" }}>
        <input
          type="checkbox"
          checked={value.acknowledged}
          onChange={(e) => onChange({ ...value, acknowledged: e.target.checked })}
        />
        <span>
          I understand that evidence left out of this request may be excluded at later levels of
          appeal
        </span>
      </label>
    </>
  );
}
