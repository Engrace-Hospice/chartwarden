import {
  Button,
  InlineAlert,
  LoadingSpinner,
  StatusPill,
  TextField,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/25-remittance — the SUBMISSION section of an ADR, appeal or reopening panel (hospice ADR/TPE/QIC
// PRD, milestone 6a). WardenX does not send anything to a MAC, QIC or esMD gateway yet: the filing is made outside
// WardenX through the channel the MAC or QIC instructs, and this section tracks the attempt and keeps the proof. It
// shows the attempt timeline with its status, a generic guided checklist (ticks are local to this screen), and the
// receipt form (confirmation reference, receipt time, an optional retained copy of the receipt) under a step-up. A
// filing with no receipt shows "Proof missing", never a blank. "Approve and send" is disabled with its reason: the
// electronic channels are not configured. The server owns every rule and its refusal is shown verbatim (ADR-0030).
import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useSession } from "../../shell/session";
import {
  clearStepUpDraft,
  peekStepUpDraft,
  stashStepUpDraft,
  stepUpDraftKey,
} from "../../shell/step-up-redirect";
import { ButtonRow, ErrorAlert, Facts, Hint, NoticeAlert } from "./action-ui";
import { SUBMISSION_STATUS_TONE, humanize, toneOf } from "./remittance-status";
import {
  type SubmissionAttempt,
  type SubmissionSubject,
  type SubmissionView,
  cancelAttempt,
  loadSubmission,
  recordReceipt,
} from "./submission-api";

export const SUBMISSION_DRAFT_ACTION = "m25-submission";
export const ELECTRONIC_NOT_CONFIGURED =
  "Electronic channel not configured. Use guided manual submission.";

const PURPOSE_LABEL: Record<string, string> = {
  adr_response: "ADR response",
  appeal_request: "Appeal request",
  reopening_request: "Reopening request",
  qic_escalation_request: "OMHA escalation request",
};

interface ReceiptDraft {
  readonly attemptId: string;
  readonly confirmationRef: string;
  readonly receiptAt: string;
  readonly receiptDocumentId: string;
}

const toLocalInput = (d: Date): string => {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const isoOrNull = (local: string): string | null =>
  local && !Number.isNaN(Date.parse(local)) ? new Date(local).toISOString() : null;
const when = (iso: string | null): string => (iso ? new Date(iso).toLocaleString() : "");

export interface SubmissionPanelProps {
  readonly kind: SubmissionSubject;
  readonly subjectId: string;
  /** Called after any change so the parent reloads what it shows. */
  readonly onChanged?: () => void;
}

export function SubmissionPanel({ kind, subjectId, onChanged }: SubmissionPanelProps): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const location = useLocation();
  const session = useSession();
  const draftKey = stepUpDraftKey(session, SUBMISSION_DRAFT_ACTION, subjectId);
  const [restored] = useState(() => peekStepUpDraft<ReceiptDraft>(draftKey));
  const [view, setView] = useState<SubmissionView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [openAttempt, setOpenAttempt] = useState<string | null>(restored?.attemptId ?? null);
  const [confirmationRef, setConfirmationRef] = useState(restored?.confirmationRef ?? "");
  const [receiptAt, setReceiptAt] = useState(restored?.receiptAt ?? toLocalInput(new Date()));
  const [receiptDocumentId, setReceiptDocumentId] = useState(restored?.receiptDocumentId ?? "");
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const res = await loadSubmission(client, kind, subjectId);
    if (!mounted.current) return;
    if (!res.ok) {
      setLoadError(res.message);
      return;
    }
    setLoadError(null);
    setView(res.value);
  }, [client, kind, subjectId]);

  useEffect(() => {
    void load();
  }, [load]);

  function closeForm(): void {
    setOpenAttempt(null);
    setConfirmationRef("");
    setReceiptDocumentId("");
    setReceiptAt(toLocalInput(new Date()));
  }

  async function save(attempt: SubmissionAttempt): Promise<void> {
    const receiptIso = isoOrNull(receiptAt);
    if (receiptIso === null) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const docId = receiptDocumentId.trim();
    const res = await recordReceipt(client, kind, subjectId, attempt.version, {
      attemptId: attempt.id,
      confirmationRef: confirmationRef.trim(),
      receiptAt: receiptIso,
      ...(docId ? { receiptDocumentId: docId } : {}),
    });
    if (!mounted.current) return;
    if (!res.ok) {
      if (res.stepUp) {
        setBusy(false);
        stashStepUpDraft(draftKey, {
          attemptId: attempt.id,
          confirmationRef,
          receiptAt,
          receiptDocumentId,
        } satisfies ReceiptDraft);
        navigate(
          `/step-up?returnTo=${encodeURIComponent(`${location.pathname}${location.search}`)}`,
        );
        return;
      }
      setError(res.message);
      await load();
      if (mounted.current) setBusy(false);
      return;
    }
    clearStepUpDraft(draftKey);
    setNotice(res.value.amended ? "Correction recorded." : "Receipt recorded.");
    closeForm();
    await load();
    onChanged?.();
    if (mounted.current) setBusy(false);
  }

  async function cancel(attempt: SubmissionAttempt): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    const res = await cancelAttempt(client, kind, subjectId, attempt.version, attempt.id);
    if (!mounted.current) return;
    if (!res.ok) setError(res.message);
    else setNotice("Attempt cancelled.");
    await load();
    if (res.ok) onChanged?.();
    if (mounted.current) setBusy(false);
  }

  if (loadError) return <ErrorAlert message={loadError} />;
  if (!view) return <LoadingSpinner />;

  const attempts = Array.isArray(view.attempts) ? view.attempts : [];
  const checklist = Array.isArray(view.checklist) ? view.checklist : [];
  const adapters = Array.isArray(view.adapters) ? view.adapters : [];
  const receiptBlocked = confirmationRef.trim() === "" || isoOrNull(receiptAt) === null;

  return (
    <>
      <h3 className="wx-action-title">Submission</h3>
      <NoticeAlert message={notice} />
      <ErrorAlert message={error} />
      <Hint>
        WardenX does not send this to the MAC yet. File it through the channel the MAC or QIC
        instructs, then record the confirmation here.
      </Hint>
      <Facts
        items={adapters.map((a) => [
          humanize(a.kind),
          a.bound ? "Available" : `Not configured. ${a.reason}`,
        ])}
      />

      {view.noAttemptRecord ? (
        <Hint>
          No submission record for this case. Cases filed before submission tracking existed have
          none.
        </Hint>
      ) : null}

      {attempts.map((attempt) => {
        const formOpen = openAttempt === attempt.id;
        const awaitingProof = attempt.status === "needs_manual";
        const acknowledged = attempt.status === "acknowledged";
        return (
          <section
            key={attempt.id}
            aria-label={`${PURPOSE_LABEL[attempt.purpose] ?? attempt.purpose} attempt ${attempt.attemptNo}`}
          >
            <Facts
              items={[
                [
                  PURPOSE_LABEL[attempt.purpose] ?? humanize(attempt.purpose),
                  <StatusPill
                    key="s"
                    label={humanize(attempt.status)}
                    tone={toneOf(SUBMISSION_STATUS_TONE, attempt.status)}
                  />,
                ],
                ["Attempt", String(attempt.attemptNo)],
                ["Sent by", attempt.channel ? humanize(attempt.channel) : "Not recorded"],
                ...(acknowledged
                  ? ([
                      ["Confirmation", attempt.confirmationRef ?? ""],
                      ["Received", when(attempt.receiptAt)],
                      ["Receipt copy", attempt.receiptDocumentId ?? "None kept"],
                    ] as const)
                  : []),
              ]}
            />
            {awaitingProof ? (
              <InlineAlert>
                Proof missing: {attempt.needsManualReason ?? "no confirmation has been recorded."}
              </InlineAlert>
            ) : null}
            {attempt.amendments.length > 0 ? (
              <ul className="wx-action-hint wx-action-list">
                {attempt.amendments.map((a) => (
                  <li key={a.recordedAt}>
                    Correction {when(a.recordedAt)}: {a.confirmationRef}, received{" "}
                    {when(a.receiptAt)}
                  </li>
                ))}
              </ul>
            ) : null}

            {formOpen ? (
              <>
                <TextField
                  label="Confirmation or tracking reference"
                  value={confirmationRef}
                  onChange={(e) => setConfirmationRef(e.target.value)}
                  maxLength={200}
                />
                <TextField
                  label="Received on"
                  type="datetime-local"
                  value={receiptAt}
                  onChange={(e) => setReceiptAt(e.target.value)}
                />
                <TextField
                  label="Receipt copy document ID (optional)"
                  value={receiptDocumentId}
                  onChange={(e) => setReceiptDocumentId(e.target.value)}
                />
                <Hint>
                  {acknowledged
                    ? "The recorded receipt cannot be edited; this adds a correction beside it."
                    : "Recording the receipt needs a recent step-up verification and cannot be edited afterwards."}
                </Hint>
                <ButtonRow end>
                  <Button tone="tertiary" disabled={busy} onClick={closeForm}>
                    Close form
                  </Button>
                  <Button disabled={busy || receiptBlocked} onClick={() => void save(attempt)}>
                    {acknowledged ? "Add correction" : "Record receipt"}
                  </Button>
                </ButtonRow>
              </>
            ) : (
              <ButtonRow end>
                {awaitingProof ? (
                  <Button
                    tone="tertiary"
                    size="sm"
                    disabled={busy}
                    onClick={() => void cancel(attempt)}
                  >
                    Cancel attempt
                  </Button>
                ) : null}
                {awaitingProof || acknowledged ? (
                  <Button
                    tone="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() => setOpenAttempt(attempt.id)}
                  >
                    {acknowledged ? "Add a correction" : "Record receipt"}
                  </Button>
                ) : null}
              </ButtonRow>
            )}
          </section>
        );
      })}

      <h4 className="wx-action-title">Guided steps</h4>
      <ul className="wx-action-list">
        {checklist.map((step) => (
          <li key={step.key}>
            <label>
              <input
                type="checkbox"
                checked={ticked.has(step.key)}
                onChange={(e) =>
                  setTicked((cur) => {
                    const next = new Set(cur);
                    if (e.target.checked) next.add(step.key);
                    else next.delete(step.key);
                    return next;
                  })
                }
              />{" "}
              {step.text}
            </label>
          </li>
        ))}
      </ul>
      <ButtonRow end>
        <Button tone="secondary" size="sm" disabled>
          Approve and send
        </Button>
      </ButtonRow>
      <Hint>{ELECTRONIC_NOT_CONFIGURED}</Hint>
    </>
  );
}
