import {
  Button,
  CountdownChip,
  LoadingSpinner,
  SelectField,
  StatusPill,
  TextAreaField,
  TextField,
  nowLocalInput,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/25-remittance — the APPEAL LIFECYCLE PANEL (GAP-074): attach packet document / submit /
// MAC acknowledgement / record decision / withdraw / close, over the live /api/v1/appeals/{id}/* routes
// (§2.4 appeal machine: draft → submitted → under_review → decided → closed, withdraw from any open state).
// The server owns the hard T-0 filing block (`appeal_within_deadline`), the §D15 step-up on submit and the
// reason/narrative floors; the panel reads the appeal fresh for its If-Match version, offers only the arcs the
// machine has from the appeal's own `state`, and shows every refusal verbatim.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useSession } from "../../shell/session";
import {
  clearStepUpDraft,
  peekStepUpDraft,
  stashStepUpDraft,
  stepUpDraftKey,
} from "../../shell/step-up-redirect";
import {
  ActionRail,
  ButtonRow,
  ErrorAlert,
  Facts,
  FormButtons,
  Hint,
  NoticeAlert,
  ReasonField,
} from "./action-ui";
import {
  EMPTY_RECONSIDERATION_SUBMIT,
  ReconsiderationSubmitFields,
  type ReconsiderationSubmitState,
  reconsiderationSubmitBlocked,
} from "./qic-evidence-editor";
import { QicPanel } from "./qic-panel";
import {
  type AppealAction,
  type AppealDetail,
  type AppealOutcome,
  MIN_APPEAL_NARRATIVE,
  MIN_REASON,
  isUuid,
  loadAppeal,
  runAppealAction,
} from "./remittance-api";
import { APPEAL_OUTCOME_TONE, APPEAL_STATE_TONE, humanize, toneOf } from "./remittance-status";
import { SubmissionPanel } from "./submission-panel";

const ACTIONS_BY_STATE: Record<string, readonly AppealAction["kind"][]> = {
  draft: ["attach", "submit", "withdraw"],
  submitted: ["ack", "withdraw"],
  under_review: ["decide", "withdraw"],
  decided: ["close"],
  escalated: ["close"],
};

const LABEL: Record<AppealAction["kind"], string> = {
  attach: "Attach packet document",
  submit: "Submit appeal",
  ack: "Record MAC acknowledgement",
  decide: "Record decision",
  withdraw: "Withdraw",
  close: "Close",
};

const OUTCOMES: readonly AppealOutcome[] = ["favorable", "partial", "unfavorable"];
const OPEN_STATES = new Set(["draft", "submitted", "under_review"]);

/** One UUID per line or comma-separated; blanks dropped. */
const splitIds = (raw: string): string[] =>
  raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

/** "label: number" per line → record; null when a non-blank line is malformed. */
function parseMacRefs(raw: string): Record<string, string> | null | undefined {
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const line of lines) {
    const at = line.indexOf(":");
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (at < 1 || !value) return null;
    out[key] = value;
  }
  return out;
}

export interface AppealDetailPanelProps {
  readonly appealId: string;
  readonly onClose: () => void;
  readonly onChanged: () => void;
}

interface AppealDraft {
  readonly act: AppealAction["kind"];
  readonly reason: string;
  readonly documentId: string;
  readonly documentIds: string;
  readonly narrative: string;
  readonly outcome: AppealOutcome;
  readonly decidedAt: string;
  readonly letterDate?: string;
  readonly macRefs: string;
  readonly recon?: ReconsiderationSubmitState;
}

export const APPEAL_DRAFT_ACTION = "m25-appeal";

export function AppealDetailPanel({
  appealId,
  onClose,
  onChanged,
}: AppealDetailPanelProps): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const location = useLocation();
  const session = useSession();
  const draftKey = stepUpDraftKey(session, APPEAL_DRAFT_ACTION, appealId);
  const [restored] = useState(() => peekStepUpDraft<AppealDraft>(draftKey));
  const [appeal, setAppeal] = useState<AppealDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [act, setAct] = useState<AppealAction["kind"] | null>(restored?.act ?? null);
  const [reason, setReason] = useState(restored?.reason ?? "");
  const [documentId, setDocumentId] = useState(restored?.documentId ?? "");
  const [documentIds, setDocumentIds] = useState(restored?.documentIds ?? "");
  const [narrative, setNarrative] = useState(restored?.narrative ?? "");
  const [outcome, setOutcome] = useState<AppealOutcome>(restored?.outcome ?? "favorable");
  const [decidedAt, setDecidedAt] = useState(restored?.decidedAt ?? nowLocalInput());
  // The date printed on the decision letter starts the next tier's clock, so it is never pre-filled.
  const [letterDate, setLetterDate] = useState(restored?.letterDate ?? "");
  const [macRefs, setMacRefs] = useState(restored?.macRefs ?? "");
  // Milestone 4: what only a QIC reconsideration adds to the submit form.
  const [recon, setRecon] = useState<ReconsiderationSubmitState>(
    restored?.recon ?? EMPTY_RECONSIDERATION_SUBMIT,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await loadAppeal(client, appealId);
    if (!res.ok) {
      setLoadError(res.message);
      return;
    }
    setLoadError(null);
    setAppeal(res.value);
  }, [client, appealId]);

  useEffect(() => {
    void load();
  }, [load]);

  function pick(next: AppealAction["kind"] | null): void {
    clearStepUpDraft(draftKey);
    setAct(next);
    setReason("");
    setDocumentId("");
    setDocumentIds(appeal?.appealPacketDocumentId ?? "");
    setNarrative("");
    setMacRefs("");
    setDecidedAt(nowLocalInput());
    setLetterDate("");
    setRecon(EMPTY_RECONSIDERATION_SUBMIT);
    setError(null);
  }

  const isReconsideration = appeal?.tier === "reconsideration";
  const submitIds = splitIds(documentIds);
  const mac = parseMacRefs(macRefs);
  const decidedIso =
    decidedAt && !Number.isNaN(Date.parse(decidedAt)) ? new Date(decidedAt).toISOString() : null;

  const blocked = (() => {
    switch (act) {
      case "attach":
        return !isUuid(documentId);
      case "submit":
        return (
          narrative.trim().length < MIN_APPEAL_NARRATIVE ||
          submitIds.length === 0 ||
          !submitIds.every(isUuid) ||
          (isReconsideration && reconsiderationSubmitBlocked(recon))
        );
      case "decide":
        return (
          reason.trim().length < MIN_REASON.decide ||
          decidedIso === null ||
          mac === null ||
          (outcome === "unfavorable" && !letterDate)
        );
      case "withdraw":
        return reason.trim().length < MIN_REASON.withdraw;
      case "ack":
      case "close":
        return false;
      default:
        return true;
    }
  })();

  function buildAction(kind: AppealAction["kind"]): AppealAction | null {
    switch (kind) {
      case "attach":
        return { kind, documentId: documentId.trim() };
      case "submit":
        return {
          kind,
          appealNarrative: narrative.trim(),
          attachedDocumentIds: submitIds,
          ...(isReconsideration
            ? {
                redeterminationMacName: recon.macName.trim(),
                redeterminationNoticeDocumentId: recon.noticeDocumentId.trim(),
                evidencePreclusionAcknowledged: recon.acknowledged,
              }
            : {}),
        };
      case "decide":
        return decidedIso
          ? {
              kind,
              outcome,
              decidedAt: decidedIso,
              ...(letterDate ? { decisionNoticeDate: letterDate } : {}),
              reason: reason.trim(),
              ...(mac ? { macReferenceNumbers: mac } : {}),
            }
          : null;
      case "withdraw":
        return { kind, reason: reason.trim() };
      default:
        return { kind };
    }
  }

  async function submit(): Promise<void> {
    if (!act || !appeal) return;
    const action = buildAction(act);
    if (!action) return;
    setBusy(true);
    setError(null);
    const res = await runAppealAction(client, appealId, appeal.version, action);
    setBusy(false);
    if (!res.ok) {
      if (res.stepUp) {
        stashStepUpDraft(draftKey, {
          act,
          reason,
          documentId,
          documentIds,
          narrative,
          outcome,
          decidedAt,
          letterDate,
          macRefs,
          recon,
        });
        navigate(
          `/step-up?returnTo=${encodeURIComponent(`${location.pathname}${location.search}`)}`,
        );
        return;
      }
      setError(res.message);
      return;
    }
    setNotice(`${LABEL[act]}: done.`);
    pick(null);
    onChanged();
    await load();
  }

  function closePanel(): void {
    clearStepUpDraft(draftKey);
    onClose();
  }

  const available = appeal ? (ACTIONS_BY_STATE[appeal.state] ?? []) : [];

  return (
    <ActionRail ariaLabel="Appeal case" onClose={closePanel}>
      {loadError ? (
        <ErrorAlert message={loadError} />
      ) : !appeal ? (
        <LoadingSpinner />
      ) : (
        <>
          <Facts
            items={[
              ["Tier", humanize(appeal.tier)],
              [
                "State",
                <StatusPill
                  key="s"
                  label={humanize(appeal.state)}
                  tone={toneOf(APPEAL_STATE_TONE, appeal.state)}
                />,
              ],
              [
                "Outcome",
                appeal.decisionOutcome ? (
                  <StatusPill
                    key="o"
                    label={humanize(appeal.decisionOutcome)}
                    tone={toneOf(APPEAL_OUTCOME_TONE, appeal.decisionOutcome)}
                  />
                ) : (
                  "—"
                ),
              ],
              // An ALJ case opened by an escalation was filed by the QIC forwarding it: no filing deadline of its own.
              appeal.filedByEscalation
                ? ["Filing deadline", "None: filed by escalation from the QIC reconsideration."]
                : [
                    "Filing deadline",
                    OPEN_STATES.has(appeal.state) ? (
                      <CountdownChip key="d" dueAt={appeal.tierDeadlineAt} label="files" />
                    ) : (
                      new Date(appeal.tierDeadlineAt).toLocaleDateString()
                    ),
                  ],
              ...(appeal.filedByEscalation
                ? []
                : ([
                    [
                      "Deadline basis",
                      appeal.noticeDatedOn
                        ? `Notice dated ${appeal.noticeDatedOn}; receipt presumed ${appeal.presumedReceiptOn}; ${appeal.windowDays}-day window; last filing day ${appeal.lastFilingDay}.`
                        : "Set before notice dates were recorded. Confirm the deadline against the notice.",
                    ],
                  ] as const)),
              ["Packet document", appeal.appealPacketDocumentId ?? "None attached"],
              ["Denial case", appeal.denialCaseId],
            ]}
          />
          {appeal.events.length > 0 ? (
            <ul className="wx-action-hint wx-action-list">
              {appeal.events.map((e) => (
                <li key={e.id}>
                  {humanize(e.eventKind)} — {new Date(e.occurredAt).toLocaleString()}
                </li>
              ))}
            </ul>
          ) : null}
          <NoticeAlert message={notice} />
          {appeal.tier === "reconsideration" || appeal.tier === "alj" ? (
            <QicPanel
              key={appealId}
              appealId={appealId}
              appealState={appeal.state}
              appealVersion={appeal.version}
              onChanged={() => {
                onChanged();
                void load();
              }}
            />
          ) : null}
          {appeal.state !== "draft" ? (
            <SubmissionPanel key={appealId} kind="appeal" subjectId={appealId} />
          ) : null}
          {act === null ? (
            <ButtonRow>
              {available.map((kind) => (
                <Button key={kind} tone="secondary" size="sm" onClick={() => pick(kind)}>
                  {LABEL[kind]}
                </Button>
              ))}
              {available.length === 0 ? <Hint>No action is available from this state.</Hint> : null}
            </ButtonRow>
          ) : (
            <>
              {act === "attach" ? (
                <TextField
                  label="Document ID"
                  value={documentId}
                  onChange={(e) => setDocumentId(e.target.value)}
                  error={documentId && !isUuid(documentId) ? "Enter a document UUID." : undefined}
                />
              ) : null}
              {act === "submit" ? (
                <>
                  <TextAreaField
                    label="Appeal narrative"
                    value={narrative}
                    onChange={(e) => setNarrative(e.target.value)}
                    rows={6}
                    maxLength={10000}
                  />
                  <Hint>
                    {narrative.trim().length}/{MIN_APPEAL_NARRATIVE} characters minimum — the server
                    enforces this floor.
                  </Hint>
                  <TextAreaField
                    label="Attached document IDs"
                    value={documentIds}
                    onChange={(e) => setDocumentIds(e.target.value)}
                    rows={2}
                  />
                  <Hint>
                    One or more document UUIDs, separated by commas or new lines. Submitting needs a
                    recent step-up verification and is refused after the tier deadline.
                  </Hint>
                  {isReconsideration ? (
                    <ReconsiderationSubmitFields value={recon} onChange={setRecon} />
                  ) : null}
                </>
              ) : null}
              {act === "decide" ? (
                <>
                  <SelectField
                    label="Outcome"
                    value={outcome}
                    onChange={(e) => setOutcome(e.target.value as AppealOutcome)}
                    options={OUTCOMES.map((o) => ({ value: o, label: humanize(o) }))}
                  />
                  <TextField
                    label="Decided at"
                    type="datetime-local"
                    value={decidedAt}
                    onChange={(e) => setDecidedAt(e.target.value)}
                  />
                  <TextField
                    label={
                      outcome === "unfavorable"
                        ? "Date printed on the decision letter (required: it starts the next appeal deadline)"
                        : "Date printed on the decision letter (optional)"
                    }
                    type="date"
                    value={letterDate}
                    onChange={(e) => setLetterDate(e.target.value)}
                  />
                  <TextAreaField
                    label="MAC reference numbers (optional)"
                    value={macRefs}
                    onChange={(e) => setMacRefs(e.target.value)}
                    rows={2}
                    error={mac === null ? "Use one 'label: number' per line." : undefined}
                  />
                </>
              ) : null}
              {act === "decide" || act === "withdraw" ? (
                <ReasonField
                  label="Reason"
                  value={reason}
                  min={act === "decide" ? MIN_REASON.decide : MIN_REASON.withdraw}
                  max={1000}
                  onChange={setReason}
                />
              ) : null}
              <ErrorAlert message={error} />
              <FormButtons
                submitLabel={LABEL[act]}
                busy={busy}
                blocked={blocked}
                danger={act === "withdraw"}
                onSubmit={() => void submit()}
                onCancel={() => pick(null)}
              />
            </>
          )}
        </>
      )}
      <ButtonRow end>
        <Button tone="tertiary" onClick={closePanel}>
          Close panel
        </Button>
      </ButtonRow>
    </ActionRail>
  );
}
