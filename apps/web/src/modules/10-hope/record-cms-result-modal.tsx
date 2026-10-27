import { Button, Modal, TextAreaField, TextField, t, useApiClient } from "@chartwarden/ui";
// apps/web/src/modules/10-hope — "Record CMS result" ceremony for a downloaded/uploaded HOPE batch.
// iQIES has no result API: after uploading in the CMS portal the user keys the Final Validation Report here,
// either per item or by pasting it (parsed defensively by cms-result-parser.ts, which only PRE-FILLS the form
// so the user reviews before anything is sent). Recording flips the batch status and the HQRP acceptance rate,
// so a confirmation step sits between the form and the POST. Matching/validation stay the server's (ADR-0030):
// its 409/422 reasons are shown inline verbatim.
import { useEffect, useRef, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { type CmsItemOutcome, normalizeOutcome, parseCmsReport } from "./cms-result-parser";
import { type SubmissionResultBody, recordSubmissionResult } from "./hope-api";

export interface ResultItem {
  readonly assessmentId: string;
  /** Human label for the row (patient name + timepoint) — also its accessible name. */
  readonly label: string;
}

interface RowState {
  /** "" until the user (or the pasted report) sets it: nothing defaults to Accepted, because a result is final. */
  status: CmsItemOutcome | "";
  code: string;
  itemCode: string;
  message: string;
}

const OUTCOME_OPTIONS: ReadonlyArray<{ value: CmsItemOutcome; label: string }> = [
  { value: "accepted", label: "Accepted" },
  { value: "accepted_with_warnings", label: "Accepted with warnings" },
  { value: "rejected", label: "Rejected" },
];
const MAX_REFERENCE = 128;
const MAX_SHOWN_ERRORS = 3;
const OUTCOME_RANK: Record<CmsItemOutcome, number> = {
  accepted: 1,
  accepted_with_warnings: 2,
  rejected: 3,
};
const BLANK_ROW: RowState = { status: "", code: "", itemCode: "", message: "" };

export function buildResultBody(
  items: readonly ResultItem[],
  rows: Readonly<Record<string, RowState>>,
  reportReference: string,
): SubmissionResultBody {
  return {
    ...(reportReference.trim() ? { reportReference: reportReference.trim() } : {}),
    results: items.flatMap((item) => {
      const r = rows[item.assessmentId] ?? BLANK_ROW;
      if (r.status === "") return []; // never invent an outcome; the dialog only submits once every row is set
      return {
        assessmentId: item.assessmentId,
        status: r.status,

        ...(r.code.trim() ? { code: r.code.trim() } : {}),
        ...(r.itemCode.trim() ? { itemCode: r.itemCode.trim() } : {}),
        ...(r.message.trim() ? { message: r.message.trim() } : {}),
      };
    }),
  };
}

export interface RecordCmsResultModalProps {
  readonly open: boolean;
  readonly submissionId: string;
  readonly items: readonly ResultItem[];
  readonly onClose: () => void;
  readonly onDone: () => void;
  /** The server said 409 (already recorded / status changed): refresh the page so it stops offering Record. */
  readonly onConflict?: () => void;
}

export function RecordCmsResultModal({
  open,
  submissionId,
  items,
  onClose,
  onDone,
  onConflict,
}: RecordCmsResultModalProps): JSX.Element | null {
  const client = useApiClient();
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [reference, setReference] = useState("");
  const [paste, setPaste] = useState("");
  const [importNote, setImportNote] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Synchronous guard: `busy` only lands on the next render, and this is a final, non-editable write.
  const submitting = useRef(false);
  // Focus targets: the step heading (confirm / discard) when a step opens, the dialog title when it closes.
  const titleRef = useRef<HTMLHeadingElement>(null);
  const stepRef = useRef<HTMLHeadingElement>(null);
  const hadStep = useRef(false);

  // Reset only when the dialog opens: `items` is a fresh array each render (names load late) and must not wipe edits.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional, see above
  useEffect(() => {
    if (!open) return;
    setRows(Object.fromEntries(items.map((i) => [i.assessmentId, { ...BLANK_ROW }])));
    setReference("");
    setPaste("");
    setImportNote("");
    setConfirming(false);
    setDiscarding(false);
    setBusy(false);
    setError(null);
  }, [open]);

  const inStep = confirming || discarding;
  // Keyed on the step's identity so confirm <-> discard moves focus too (inStep alone stays true across them).
  const step = discarding ? "discard" : confirming ? "confirm" : null;
  useEffect(() => {
    if (step) stepRef.current?.focus();
    else if (hadStep.current) titleRef.current?.focus();
    hadStep.current = step !== null;
  }, [step]);

  if (!open) return null;

  const patchRow = (id: string, patch: Partial<RowState>): void =>
    setRows((prev) => ({ ...prev, [id]: { ...(prev[id] ?? BLANK_ROW), ...patch } }));

  function importPaste(): void {
    const parsed = parseCmsReport(paste);
    const known = new Set(items.map((i) => i.assessmentId));
    const matched = parsed.rows.filter((r) => known.has(r.assessmentId));
    // One report row per finding: the worst outcome per assessment wins (a later warning never hides a rejection).
    const merged: Record<string, RowState> = {};
    for (const r of matched) {
      const prev = merged[r.assessmentId];
      if (prev && OUTCOME_RANK[prev.status as CmsItemOutcome] >= OUTCOME_RANK[r.status]) continue;
      merged[r.assessmentId] = {
        status: r.status,
        code: r.code,
        itemCode: r.itemCode,
        message: r.message,
      };
    }
    setRows((prev) => ({ ...prev, ...merged }));
    const skipped = parsed.rows.length - matched.length;
    const notes = [
      `Imported ${matched.length} of ${items.length} item${items.length === 1 ? "" : "s"}.`,
      ...(skipped > 0
        ? [`${skipped} row${skipped === 1 ? "" : "s"} not in this batch ignored.`]
        : []),
      ...parsed.errors.slice(0, MAX_SHOWN_ERRORS),
      ...(parsed.errors.length > MAX_SHOWN_ERRORS
        ? [`+${parsed.errors.length - MAX_SHOWN_ERRORS} more errors.`]
        : []),
    ];
    setImportNote(notes.join(" "));
  }

  const isDirty =
    reference.trim() !== "" ||
    paste.trim() !== "" ||
    Object.values(rows).some(
      (r) => r.status !== "" || r.code !== "" || r.itemCode !== "" || r.message !== "",
    );

  /** Escape / Cancel: a clean form closes at once; a dirty one asks first (no window.confirm). */
  function requestClose(): void {
    if (busy) return;
    if (discarding) {
      setDiscarding(false); // Escape on the question means "keep editing"
      return;
    }
    if (isDirty) setDiscarding(true);
    else onClose();
  }

  async function submit(): Promise<void> {
    if (!allSet || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    let res: Awaited<ReturnType<typeof recordSubmissionResult>>;
    try {
      res = await recordSubmissionResult(
        client,
        submissionId,
        buildResultBody(items, rows, reference),
      );
    } catch {
      // The request may have reached the server: reload so the page reflects a result that did land.
      setError("The result may not have been recorded; refresh to check.");
      setConfirming(false);
      onConflict?.();
      return;
    } finally {
      submitting.current = false;
      setBusy(false);
    }
    if (!res.ok) {
      setError(res.message);
      setConfirming(false);
      if (res.status === 409) onConflict?.();
      return;
    }
    // Outside the try: a throwing callback must not read as "nothing was recorded".
    onDone();
    onClose();
  }

  const statusOf = (id: string): RowState["status"] => rows[id]?.status ?? "";
  const unsetCount = items.filter((i) => statusOf(i.assessmentId) === "").length;
  const allSet = items.length > 0 && unsetCount === 0;
  const counts = OUTCOME_OPTIONS.map((o) => ({
    ...o,
    n: items.filter((i) => statusOf(i.assessmentId) === o.value).length,
  }));

  return (
    <Modal
      open={open}
      onClose={busy ? undefined : requestClose}
      ariaLabel="Record CMS result"
      width="56rem"
      accent={t.primary}
      dismissOnScrim={false}
    >
      <div style={body}>
        <h2 ref={titleRef} tabIndex={-1} style={title}>
          Record CMS result
        </h2>
        <p style={meta}>
          Enter the outcome of each record from the CMS Final Validation Report. You can paste the
          report to pre-fill the form; nothing is sent until you confirm.
        </p>

        {discarding ? (
          <div style={body}>
            <h3 ref={stepRef} tabIndex={-1} style={stepTitle}>
              Discard changes?
            </h3>
            <p style={{ margin: 0 }}>
              The outcomes and pasted report you entered have not been recorded and will be lost.
            </p>
          </div>
        ) : confirming ? (
          <div style={body}>
            <h3 ref={stepRef} tabIndex={-1} style={stepTitle}>
              Record this result?
            </h3>
            <p style={{ margin: 0 }}>
              It changes the batch status and the HQRP acceptance rate and cannot be edited
              afterwards.
            </p>
            <p style={{ margin: 0 }}>
              Report reference: {reference.trim() === "" ? "none" : reference.trim()}
            </p>
            <ul style={{ margin: 0 }}>
              {counts.map((c) => (
                <li key={c.value}>
                  {c.label}: {c.n}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <>
            <TextField
              label="Report reference (optional)"
              value={reference}
              maxLength={MAX_REFERENCE}
              onChange={(e) => setReference(e.target.value)}
            />
            <TextAreaField
              label="Paste CMS report (JSON, CSV, or one line per record)"
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
              rows={3}
            />
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
              <Button tone="secondary" onClick={importPaste} disabled={paste.trim() === ""}>
                Import pasted report
              </Button>
              <output style={meta}>{importNote}</output>
            </div>
            <div style={{ maxHeight: "22rem", overflow: "auto" }}>
              <table className="wx-list-table" style={{ width: "100%" }}>
                <thead>
                  <tr>
                    <th scope="col">Record</th>
                    <th scope="col">Outcome</th>
                    <th scope="col">CMS code</th>
                    <th scope="col">Item</th>
                    <th scope="col">Message</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item, idx) => {
                    const r = rows[item.assessmentId] ?? BLANK_ROW;
                    // Labels can repeat (same patient + RFA): the row number keeps each accessible name unique.
                    const name = `${item.label}, row ${idx + 1}`;
                    return (
                      <tr key={item.assessmentId}>
                        <td>{item.label}</td>
                        <td>
                          <select
                            className="wx-select"
                            aria-label={`Outcome for ${name}`}
                            value={r.status}
                            onChange={(e) =>
                              patchRow(item.assessmentId, {
                                status: normalizeOutcome(e.target.value) ?? "",
                              })
                            }
                          >
                            <option value="">Select outcome</option>
                            {OUTCOME_OPTIONS.map((o) => (
                              <option key={o.value} value={o.value}>
                                {o.label}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <input
                            className="wx-select"
                            aria-label={`CMS code for ${name}`}
                            value={r.code}
                            maxLength={64}
                            onChange={(e) => patchRow(item.assessmentId, { code: e.target.value })}
                          />
                        </td>
                        <td>
                          <input
                            className="wx-select"
                            aria-label={`Item for ${name}`}
                            value={r.itemCode}
                            maxLength={64}
                            onChange={(e) =>
                              patchRow(item.assessmentId, { itemCode: e.target.value })
                            }
                          />
                        </td>
                        <td>
                          <input
                            className="wx-select"
                            aria-label={`Message for ${name}`}
                            value={r.message}
                            maxLength={1000}
                            onChange={(e) =>
                              patchRow(item.assessmentId, { message: e.target.value })
                            }
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}

        {!inStep && items.length > 0 && !allSet ? (
          <p style={meta}>
            Set an outcome for every record ({unsetCount} remaining) before reviewing.
          </p>
        ) : null}

        {error ? (
          <p role="alert" style={errorText}>
            {error}
          </p>
        ) : null}

        <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
          <Button
            tone="tertiary"
            onClick={
              discarding
                ? () => setDiscarding(false)
                : confirming
                  ? () => setConfirming(false)
                  : requestClose
            }
            disabled={busy}
          >
            {discarding ? "Keep editing" : confirming ? "Back" : "Cancel"}
          </Button>
          {discarding ? (
            <Button tone="primary" onClick={onClose}>
              Discard
            </Button>
          ) : confirming ? (
            <Button tone="primary" onClick={submit} disabled={busy}>
              {busy ? "Recording…" : "Confirm and record"}
            </Button>
          ) : (
            <Button
              tone="primary"
              onClick={() => {
                setError(null);
                setConfirming(true);
              }}
              disabled={!allSet}
            >
              Review and record
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}

const body: CSSProperties = {
  padding: "1.5rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.875rem",
};
const stepTitle: CSSProperties = { margin: 0, fontSize: "0.95rem", fontWeight: 600 };
const title: CSSProperties = { margin: 0, fontSize: "1.05rem", fontWeight: 600 };
const meta: CSSProperties = {
  margin: 0,
  fontSize: "0.75rem",
  color: "var(--color-on-surface-variant)",
};
const errorText: CSSProperties = { margin: 0, fontSize: "0.8rem", color: "var(--color-error)" };
