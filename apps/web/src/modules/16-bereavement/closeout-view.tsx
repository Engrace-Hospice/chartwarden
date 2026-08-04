// apps/web/src/modules/16-bereavement — the CLOSEOUT VIEW (§5.1 #18, Track B / ADR-0030).
// Spec: docs/design/screens/clinical — "Use Record Detail."
//
// The end of the 13-month obligation: the final-contact composer, and the closure record once it exists.
//
// WHAT THIS SCREEN DOES NOT DO, AND WHY. §5.1 describes "plan transitions to `closed_completed`" from here.
// M16 publishes NO route that requests that transition, and correctly so: §2.2 makes the 13-month
// completion a CASCADE the month-13 cron fires, and the four system-driven closure reasons are explicitly
// excluded from `CloseEarlyBody` — a counselor may not declare the obligation met early by pressing a
// button. So this screen composes the FINAL CONTACT (route 26's ad-hoc log, the touchpoint the counselor
// actually makes) and then reports the closure record the cron wrote. A "close completed" button here
// would have had to call a route that does not exist, or misuse the early-close path — which would record
// a curtailed obligation as a fulfilled one on the survey record.
import { EmptyState, LoadingSpinner, PageHeader, StatusPill, t, useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Link, useParams } from "react-router-dom";
import {
  type BereavementLogKind,
  type BereavementLogOutcome,
  type ClosureView,
  type PlanDetail,
  errorMessage,
  getClosure,
  getPlan,
  logDirectContact,
} from "./bereavement-api";
import {
  CLOSURE_REASON_TONE,
  DEFAULT_LOG_OUTCOME,
  LOG_OUTCOMES,
  NON_ENCOUNTER_OUTREACH_KINDS,
  dateTime,
  daysUntil,
  humanize,
  outreachKindLabel,
  shortDate,
  shortId,
  toneOf,
} from "./bereavement-status";
import {
  Card,
  CheckboxField,
  Field,
  Modal,
  Notice,
  SelectField,
  SummaryGrid,
  TextAreaField,
  TextField,
  alertStyle,
  columnStyle,
  ghostButtonStyle,
  mutedStyle,
  pageTitleStyle,
  primaryButtonStyle,
} from "./bereavement-ui";

export function BereavementCloseoutView(): JSX.Element {
  const client = useApiClient();
  const { planId } = useParams<{ planId: string }>();
  const [plan, setPlan] = useState<PlanDetail | null>(null);
  const [closure, setClosure] = useState<ClosureView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [composing, setComposing] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!planId) return;
    setLoading(true);
    setError(null);
    const [detail, closureRes] = await Promise.all([
      getPlan(client, planId),
      getClosure(client, planId),
    ]);
    if (detail.error) {
      setError(errorMessage(detail.error, "This bereavement plan could not be loaded."));
      setLoading(false);
      return;
    }
    setPlan(detail.plan);
    // A plan still open answers 404 on the closure route. That is an ordinary state, not an error.
    setClosure(closureRes.closure);
    setLoading(false);
  }, [client, planId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;
  if (!plan || !planId)
    return (
      <EmptyState
        title="Not found"
        description="This bereavement plan does not exist, or is not on your caseload."
      />
    );

  const daysLeft = daysUntil(plan.windowEndsAt);
  const activeContacts = plan.contacts.filter((c) => c.status === "active");

  return (
    <div style={columnStyle}>
      <PageHeader
        title={<span style={pageTitleStyle}>Bereavement closeout</span>}
        breadcrumb={`Bereavement — plan ${shortId(planId)}`}
        actions={
          <Link to={`/bereavement/plans/${planId}`} style={ghostButtonStyle}>
            Back to plan
          </Link>
        }
      />

      {closure ? (
        <Notice tone={closure.reason === "thirteen_month_completion" ? "success" : "info"}>
          This plan closed {dateTime(closure.closedAt)} — {humanize(closure.reason)}.
        </Notice>
      ) : daysLeft !== null && daysLeft >= 0 ? (
        <Notice tone={daysLeft <= 30 ? "warning" : "info"} live>
          The 13-month window ends {shortDate(plan.windowEndsAt)} — {daysLeft}{" "}
          {daysLeft === 1 ? "day" : "days"} remaining. The plan closes as `closed_completed` by the
          month-13 job; it is not closed from this screen.
        </Notice>
      ) : (
        <Notice tone="warning">
          The 13-month window has passed ({shortDate(plan.windowEndsAt)}). The closeout job closes
          the plan and renders the summary letter.
        </Notice>
      )}

      <Card title="Program">
        <SummaryGrid>
          <Field label="Death date" value={shortDate(plan.deathDate)} />
          <Field label="Window ends" value={shortDate(plan.windowEndsAt)} />
          <Field label="Status" value={humanize(plan.status)} />
          <Field label="Touchpoints completed" value={plan.stats.completedCount} />
          <Field label="Touchpoints missed" value={plan.stats.missedCount} />
          <Field label="Active survivors" value={plan.stats.contactsActiveCount} />
          <Field label="Opted out" value={plan.stats.contactsOptedOutCount} />
        </SummaryGrid>
      </Card>

      {closure ? (
        <Card
          title="Closure record"
          actions={
            <StatusPill
              label={humanize(closure.reason)}
              tone={toneOf(CLOSURE_REASON_TONE, closure.reason)}
            />
          }
        >
          <SummaryGrid>
            <Field label="Closed" value={dateTime(closure.closedAt)} />
            <Field label="Close kind" value={humanize(closure.closeKind)} />
            <Field label="Closed by" value={shortId(closure.closedByUserId)} mono />
            <Field label="Cosigned by" value={shortId(closure.cosignedByUserId)} mono />
            <Field label="Cosigned" value={dateTime(closure.cosignedAt)} />
            <Field label="Completed at close" value={closure.stats.completedCount} />
            <Field label="Missed at close" value={closure.stats.missedCount} />
            <Field
              label="Summary document"
              value={
                closure.bereavementSummaryDocumentId
                  ? shortId(closure.bereavementSummaryDocumentId)
                  : "not yet rendered"
              }
              mono
            />
          </SummaryGrid>
          {closure.reason === "thirteen_month_completion" ? (
            <span style={mutedStyle}>
              The 13-month obligation was met in full. Every other closure reason ended the program
              early or by cascade, which is why the reason — not merely the closed status — is what
              a surveyor reads.
            </span>
          ) : null}
        </Card>
      ) : (
        <Card title="Closure record">
          <span style={mutedStyle}>
            No closure record exists yet. It is written when the plan closes — by the month-13 job
            for a completed program, or by the cosigned early-close path.
          </span>
        </Card>
      )}

      <Card title="Final contact">
        {activeContacts.length === 0 ? (
          <span style={mutedStyle}>
            No survivors on this plan are still active, so there is no final contact to compose.
          </span>
        ) : (
          <div style={{ display: "flex", gap: t.space2, flexWrap: "wrap" }}>
            {activeContacts.map((c) => (
              <button
                key={c.contactId}
                type="button"
                style={ghostButtonStyle}
                onClick={() => setComposing(c.contactId)}
              >
                Compose for {c.displayName}
              </button>
            ))}
          </div>
        )}
        <span style={mutedStyle}>
          The closeout letter is rendered by Module 22 from the document artifact this contact log
          references. Attach the rendered document id when it exists.
        </span>
      </Card>

      {composing ? (
        <FinalContactModal
          contactId={composing}
          name={plan.contacts.find((c) => c.contactId === composing)?.displayName ?? ""}
          onClose={() => setComposing(null)}
          onDone={() => {
            setComposing(null);
            void load();
          }}
        />
      ) : null}
    </div>
  );
}

/** The final-contact composer over route 26 (an ad-hoc contact log — the touchpoint actually made). */
function FinalContactModal({
  contactId,
  name,
  onClose,
  onDone,
}: { contactId: string; name: string; onClose: () => void; onDone: () => void }): JSX.Element {
  const client = useApiClient();
  const [kind, setKind] = useState("sympathy_letter");
  const [outcome, setOutcome] = useState(DEFAULT_LOG_OUTCOME);
  const [contactAt, setContactAt] = useState("");
  const [responded, setResponded] = useState(false);
  const [artifactDocumentId, setArtifactDocumentId] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    // `kind`/`outcome` are always one of the closed vocabularies the SelectFields below offer.
    const { error: err } = await logDirectContact(client, contactId, {
      kind: kind as BereavementLogKind,
      outcome: outcome as BereavementLogOutcome,
      contactAt: contactAt ? new Date(contactAt).toISOString() : new Date().toISOString(),
      contactResponded: responded,
      artifactDocumentId: artifactDocumentId || undefined,
      notes: notes || undefined,
    });
    setBusy(false);
    if (err) {
      setError(errorMessage(err, "The final contact could not be recorded."));
      return;
    }
    onDone();
  };

  return (
    <Modal
      title={`Final contact — ${name}`}
      onClose={onClose}
      footer={
        <button type="button" style={primaryButtonStyle} disabled={busy} onClick={submit}>
          {busy ? "Recording…" : "Record final contact"}
        </button>
      }
    >
      <SelectField
        label="Modality"
        value={kind}
        options={NON_ENCOUNTER_OUTREACH_KINDS.map((k) => ({
          value: k,
          label: outreachKindLabel(k),
        }))}
        onChange={setKind}
      />
      <SelectField
        label="Outcome"
        value={outcome}
        options={LOG_OUTCOMES.map((o) => ({ value: o, label: humanize(o) }))}
        onChange={setOutcome}
      />
      <TextField
        label="Contacted at"
        type="datetime-local"
        value={contactAt}
        onChange={setContactAt}
      />
      <CheckboxField
        label="The survivor responded directly"
        checked={responded}
        onChange={setResponded}
      />
      <TextField
        label="M22 rendered document id (optional)"
        value={artifactDocumentId}
        onChange={setArtifactDocumentId}
      />
      <TextAreaField label="Counselor note" value={notes} onChange={setNotes} />
      {error ? <p style={alertStyle}>{error}</p> : null}
    </Modal>
  );
}
