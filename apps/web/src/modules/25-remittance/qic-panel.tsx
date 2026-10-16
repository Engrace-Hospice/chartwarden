import { Button, LoadingSpinner, SelectField, TextField, useApiClient } from "@wardenx/ui";
// apps/web/src/modules/25-remittance — the QIC RECONSIDERATION section of the appeal panel (hospice ADR/TPE/QIC PRD,
// milestone 4): the cited-evidence list (draft only), the QIC's own decision clock derived from the receipt date the
// person records, and the escalation to OMHA once the QIC is late. The server owns every rule (completeness, the
// clock, eligibility, the frozen request) and its message is shown verbatim; this component only collects facts and
// offers the moves the state allows. WardenX sends nothing: the escalation request records one made outside it.
// SME-unconfirmed items (day counting, the escalation procedure, the ALJ threshold) are marked on screen.
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
import {
  type EscalationChannel,
  MAX_QIC_EXTENSION_DAYS,
  type QicView,
  confirmEscalation,
  loadQic,
  recordQicClock,
  requestEscalation,
  saveCitedEvidence,
} from "./qic-api";
import { EvidenceEditor, PreclusionWarning } from "./qic-evidence-editor";
import { humanize } from "./remittance-status";

/** Keyed on the APPEAL id so the appeal panel restores the escalation form after a step-up round trip. */
export const QIC_DRAFT_ACTION = "m25-qic-escalation";

const CHANNELS: readonly { value: EscalationChannel; label: string }[] = [
  { value: "qic_portal", label: "QIC portal" },
  { value: "fax", label: "Fax" },
  { value: "mail", label: "Mail" },
  { value: "other", label: "Other" },
];

interface EscalationDraft {
  readonly channel: EscalationChannel;
  readonly confirmationRef: string;
  readonly requestedAt: string;
  readonly forwardedOn: string;
}

const pad = (n: number): string => String(n).padStart(2, "0");
/** Local `YYYY-MM-DDTHH:mm` for a datetime-local input. */
const toLocalInput = (d: Date): string =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const isoOrNull = (local: string): string | null =>
  local && !Number.isNaN(Date.parse(local)) ? new Date(local).toISOString() : null;

export interface QicPanelProps {
  readonly appealId: string;
  /** The parent's own copy of the appeal: a change to either means the QIC view must be re-read. */
  readonly appealState: string;
  readonly appealVersion: number;
  /** Called after any change so the parent reloads what it shows. */
  readonly onChanged: () => void;
}

export function QicPanel({
  appealId,
  appealState,
  appealVersion,
  onChanged,
}: QicPanelProps): JSX.Element | null {
  const client = useApiClient();
  const navigate = useNavigate();
  const location = useLocation();
  const session = useSession();
  const draftKey = stepUpDraftKey(session, QIC_DRAFT_ACTION, appealId);
  const [restored] = useState(() => peekStepUpDraft<EscalationDraft>(draftKey));
  const [view, setView] = useState<QicView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [receivedOn, setReceivedOn] = useState("");
  const [extensionDays, setExtensionDays] = useState("");
  const [channel, setChannel] = useState<EscalationChannel>(restored?.channel ?? "qic_portal");
  const [confirmationRef, setConfirmationRef] = useState(restored?.confirmationRef ?? "");
  const [requestedAt, setRequestedAt] = useState(restored?.requestedAt ?? toLocalInput(new Date()));
  const [forwardedOn, setForwardedOn] = useState(restored?.forwardedOn ?? "");
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

  // Only the newest read may land: a slow earlier response must not overwrite a newer view.
  const readSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++readSeq.current;
    const res = await loadQic(client, appealId);
    if (!mounted.current || seq !== readSeq.current) return;
    if (!res.ok) {
      // Keep the last view (and what the person typed); the error shows inline.
      setLoadError(res.message);
      return;
    }
    setLoadError(null);
    setView(res.value);
  }, [client, appealId]);

  // Re-read when the parent's appeal changes (it was submitted, acknowledged, decided...): the draft-only editor and
  // the If-Match version must follow it, not the copy loaded at mount.
  // biome-ignore lint/correctness/useExhaustiveDependencies: appealState and appealVersion are the reload triggers
  useEffect(() => {
    void load();
  }, [load, appealState, appealVersion]);

  /** Runs one command; every refusal is shown verbatim and the case is reloaded so the next one carries its version. */
  async function run(
    label: string,
    call: (version: number) => Promise<{ ok: true } | { ok: false; message: string }>,
  ): Promise<boolean> {
    if (!view) return false;
    setBusy(true);
    setError(null);
    setNotice(null);
    const res = await call(view.version);
    if (!mounted.current) return false;
    if (!res.ok) setError(res.message);
    else setNotice(`${label}: done.`);
    await load();
    if (res.ok) onChanged();
    if (mounted.current) setBusy(false);
    return res.ok;
  }

  /** A step-up-gated command: on the step-up refusal the form is stashed and the person re-verifies, then returns. */
  async function runWithStepUp(
    label: string,
    call: (
      version: number,
    ) => Promise<{ ok: true } | { ok: false; message: string; stepUp?: boolean }>,
  ): Promise<void> {
    if (!view) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const res = await call(view.version);
    if (!mounted.current) return;
    if (!res.ok && res.stepUp) {
      setBusy(false);
      stashStepUpDraft(draftKey, {
        channel,
        confirmationRef,
        requestedAt,
        forwardedOn,
      } satisfies EscalationDraft);
      navigate(`/step-up?returnTo=${encodeURIComponent(`${location.pathname}${location.search}`)}`);
      return;
    }
    if (!res.ok) setError(res.message);
    else {
      clearStepUpDraft(draftKey);
      setNotice(`${label}: done.`);
    }
    await load();
    if (res.ok) onChanged();
    if (mounted.current) setBusy(false);
  }

  function escalate(): void {
    const sentAt = isoOrNull(requestedAt);
    if (sentAt === null) return;
    void runWithStepUp("Record escalation request", (v) =>
      requestEscalation(client, appealId, v, {
        channel,
        confirmationRef: confirmationRef.trim(),
        requestedAt: sentAt,
      }),
    );
  }

  if (!view) return loadError ? <ErrorAlert message={loadError} /> : <LoadingSpinner />;
  if (view.kind === "none") return null;

  if (view.kind === "escalated_alj") {
    return (
      <>
        <ErrorAlert message={loadError} />
        <h3 className="wx-action-title">Filed by escalation</h3>
        <Hint>
          The QIC did not decide by its date, so the reconsideration was escalated to OMHA. This
          case was opened from it: there is no filing deadline to meet.
        </Hint>
        <Facts items={[["Escalated from", view.escalatedFromAppealCaseId ?? "—"]]} />
      </>
    );
  }

  const open = view.state === "submitted" || view.state === "under_review";
  const requested = view.escalation !== null;
  const sentIso = isoOrNull(requestedAt);
  const extension = Number(extensionDays);
  const extensionValid =
    extensionDays !== "" &&
    Number.isInteger(extension) &&
    extension >= 0 &&
    extension <= MAX_QIC_EXTENSION_DAYS;

  return (
    <>
      <h3 className="wx-action-title">QIC reconsideration</h3>
      <NoticeAlert message={notice} />
      <ErrorAlert message={error} />
      <ErrorAlert message={loadError} />

      {view.state === "draft" ? (
        <>
          <PreclusionWarning />
          {view.evidenceEditable ? (
            <EvidenceEditor
              view={view}
              busy={busy}
              onSave={(body) =>
                void run("Evidence list", (v) => saveCitedEvidence(client, appealId, v, body))
              }
            />
          ) : null}
        </>
      ) : (
        <Facts
          items={[
            [
              "Documentation cited",
              view.citedEvidenceNone
                ? "The redetermination notice named none."
                : view.citedEvidence.length === 0
                  ? "None recorded."
                  : view.citedEvidence
                      .map(
                        (i) =>
                          `${i.label} (${i.documentId ? "enclosed" : `not enclosed: ${i.notAvailableReason ?? ""}`})`,
                      )
                      .join("; "),
            ],
          ]}
        />
      )}

      {open || view.state === "escalated" ? (
        <>
          <h4 className="wx-action-title">QIC decision date</h4>
          {view.clock ? (
            <Facts
              items={[
                ["QIC received the request", view.clock.receivedOn],
                [
                  "QIC decision due",
                  view.clock.overdue
                    ? `${view.clock.decisionDueOn} (overdue by ${view.clock.daysOverdue} day${view.clock.daysOverdue === 1 ? "" : "s"})`
                    : view.clock.decisionDueOn,
                ],
                [
                  "How it was worked out",
                  `Received ${view.clock.receivedOn} + ${view.clock.baseDays} days${
                    view.clock.extensionDays > 0
                      ? ` + ${view.clock.extensionDays} days of late-evidence extensions`
                      : ""
                  } = ${view.clock.decisionDueOn}, to the end of that day (${view.clock.zone}).`,
                ],
              ]}
            />
          ) : (
            <Facts
              items={[
                [
                  "QIC receipt date",
                  "QIC receipt date not recorded. No decision date is computed and escalation is not offered until it is.",
                ],
              ]}
            />
          )}
          <Hint>
            Counted as calendar days from the QIC's receipt, with no weekend or holiday adjustment.
            Not yet confirmed with your billing SME: the start date, the day counting and each
            extension's length. Enter the extension the QIC's letter states.
          </Hint>
        </>
      ) : null}

      {open && !requested ? (
        <>
          <TextField
            label="Date the QIC received the request (from its acknowledgement)"
            type="date"
            value={receivedOn}
            onChange={(e) => setReceivedOn(e.target.value)}
          />
          <ButtonRow end>
            <Button
              size="sm"
              disabled={busy || receivedOn === ""}
              onClick={() =>
                void run("Receipt date", (v) => recordQicClock(client, appealId, v, { receivedOn }))
              }
            >
              Record receipt date
            </Button>
          </ButtonRow>
          {view.clock ? (
            <>
              <TextField
                label={`Late-evidence extension, in days (0 to ${MAX_QIC_EXTENSION_DAYS})`}
                type="number"
                value={extensionDays}
                onChange={(e) => setExtensionDays(e.target.value)}
              />
              <ButtonRow end>
                <Button
                  size="sm"
                  disabled={busy || !extensionValid}
                  onClick={() =>
                    void run("Extension", (v) =>
                      recordQicClock(client, appealId, v, { extensionDays: extension }),
                    ).then((ok) => ok && mounted.current && setExtensionDays(""))
                  }
                >
                  Add extension
                </Button>
              </ButtonRow>
            </>
          ) : null}
        </>
      ) : null}

      {view.state === "under_review" &&
      !requested &&
      !view.escalationEligible &&
      view.escalationBlockedReason ? (
        <Hint>{view.escalationBlockedReason}</Hint>
      ) : null}

      {view.escalationEligible ? (
        <>
          <h4 className="wx-action-title">Escalate to OMHA</h4>
          <Hint>
            The QIC has not decided by its date. Record the escalation request you sent outside
            WardenX; WardenX does not send it for you. Recording it needs a recent step-up
            verification and cannot be edited afterwards. Not yet confirmed with your billing SME:
            the escalation procedure, any form, and the ALJ amount-in-controversy requirement.
          </Hint>
          <SelectField
            label="Sent by"
            value={channel}
            onChange={(e) => setChannel(e.target.value as EscalationChannel)}
            options={CHANNELS.map((c) => ({ value: c.value, label: c.label }))}
          />
          <TextField
            label="Confirmation or tracking reference"
            value={confirmationRef}
            onChange={(e) => setConfirmationRef(e.target.value)}
            maxLength={200}
          />
          <TextField
            label="Sent on"
            type="datetime-local"
            value={requestedAt}
            onChange={(e) => setRequestedAt(e.target.value)}
          />
          <ButtonRow end>
            <Button
              disabled={busy || confirmationRef.trim() === "" || sentIso === null}
              onClick={() => escalate()}
            >
              Record escalation request
            </Button>
          </ButtonRow>
        </>
      ) : null}

      {view.escalation ? (
        <Facts
          items={[
            ["Escalation requested", new Date(view.escalation.requestedAt).toLocaleString()],
            ["Sent by", humanize(view.escalation.channel)],
            ["Confirmation", view.escalation.confirmationRef],
            [
              "QIC forwarded the case",
              view.escalation.confirmedOn ?? "Not confirmed yet. The QIC may still decide.",
            ],
          ]}
        />
      ) : null}

      {view.state === "under_review" && view.escalation && !view.escalation.confirmedOn ? (
        <>
          <TextField
            label="Date the QIC forwarded the case to OMHA"
            type="date"
            value={forwardedOn}
            onChange={(e) => setForwardedOn(e.target.value)}
          />
          <ButtonRow end>
            <Button
              disabled={busy || forwardedOn === ""}
              onClick={() =>
                void runWithStepUp("Confirm forwarded", (v) =>
                  confirmEscalation(client, appealId, v, forwardedOn),
                )
              }
            >
              Confirm the case was forwarded
            </Button>
          </ButtonRow>
        </>
      ) : null}

      {view.state === "escalated" ? (
        <Hint>
          Escalated to OMHA. An ALJ case was opened from this reconsideration
          {view.nextAppealCaseId ? ` (${view.nextAppealCaseId})` : ""}.
        </Hint>
      ) : null}
    </>
  );
}
