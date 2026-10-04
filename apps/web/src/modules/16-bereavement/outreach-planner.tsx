// apps/web/src/modules/16-bereavement — the OUTREACH PLANNER (§5.1 #9, Track B / ADR-0030), carrying the
// §5.1 #10 start-outreach and §5.1 #11 complete-outreach modals. Spec: docs/design/screens/clinical —
// "Use Worklist."
//
// Route 19's touchpoint book — past and future — with the §2.4 transitions each row can take.
//
// D15 IS ENFORCED IN THE FORM SHAPE. `in_person_visit` is the ONLY kind backed by an M8 encounter, so the
// completion body is a DISCRIMINATED UNION: the in-person branch REQUIRES `sourceEncounterId` and every
// other kind must NOT carry one. The DB carries the same rule as a CHECK pair, so a form that let a letter
// acquire an encounter id would only surface the violation at the end of a long transaction. Here the
// field simply is not offered for the eight non-encounter kinds.
//
// §5.1's "drag-to-reschedule within tenant tighten-only bounds" is NOT built: M16 publishes no route that
// moves ONE touchpoint's date. What the server does publish is route 27 — regenerate the FORWARD book,
// whole-plan or per-contact — so that is what this screen offers, and it says so rather than shipping a
// drag affordance that would have to fabricate a per-row PATCH.
import { EmptyState, LoadingSpinner, PageHeader, StatusPill, t, useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Link, useParams } from "react-router-dom";
import {
  type BereavementLogOutcome,
  type BereavementOutreachStatus,
  type OutreachRow,
  type PlanDetail,
  cancelOutreach,
  completeOutreach,
  declineOutreach,
  errorMessage,
  getPlan,
  lateAttemptOutreach,
  listOutreach,
  noResponseOutreach,
  regenerateSchedule,
  startOutreach,
} from "./bereavement-api";
import {
  DEFAULT_LOG_OUTCOME,
  LOG_OUTCOMES,
  OUTREACH_STATUS_TONE,
  anniversaryMarkLabel,
  dateTime,
  dueLabel,
  humanize,
  outreachKindLabel,
  shortDate,
  shortId,
  toneOf,
} from "./bereavement-status";
import {
  Card,
  CheckboxField,
  FilterRow,
  Modal,
  Notice,
  SelectField,
  TextAreaField,
  TextField,
  alertStyle,
  columnStyle,
  ghostButtonStyle,
  linkStyle,
  mutedStyle,
  pageTitleStyle,
  primaryButtonStyle,
  rowLine,
  tableStyle,
  td,
  th,
} from "./bereavement-ui";

const STATUS_FILTERS = [
  { value: "", label: "all statuses" },
  { value: "scheduled", label: "scheduled" },
  { value: "in_progress", label: "in progress" },
  { value: "completed", label: "completed" },
  { value: "declined", label: "declined" },
  { value: "no_response", label: "no response" },
  { value: "missed", label: "missed" },
  { value: "cancelled", label: "cancelled" },
];

type Ceremony =
  | { kind: "complete"; row: OutreachRow }
  | { kind: "decline"; row: OutreachRow }
  | { kind: "no-response"; row: OutreachRow }
  | { kind: "cancel"; row: OutreachRow }
  | { kind: "regenerate" }
  | null;

export function BereavementOutreachPlanner(): JSX.Element {
  const client = useApiClient();
  const { planId } = useParams<{ planId: string }>();
  const [plan, setPlan] = useState<PlanDetail | null>(null);
  const [rows, setRows] = useState<OutreachRow[]>([]);
  const [status, setStatus] = useState("");
  const [contactFilter, setContactFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [ceremony, setCeremony] = useState<Ceremony>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!planId) return;
    setLoading(true);
    setError(null);
    const [detail, page] = await Promise.all([
      getPlan(client, planId),
      listOutreach(client, planId, {
        // `status` is always "" or one of the closed vocabulary the SelectField below offers.
        status: (status || undefined) as BereavementOutreachStatus | undefined,
        contactId: contactFilter || undefined,
        limit: 200,
      }),
    ]);
    if (detail.error) {
      setError(errorMessage(detail.error, "This bereavement plan could not be loaded."));
      setLoading(false);
      return;
    }
    if (page.error) {
      setError(errorMessage(page.error, "The touchpoint book could not be loaded."));
      setLoading(false);
      return;
    }
    setPlan(detail.plan);
    setRows(page.page?.data ?? []);
    setLoading(false);
  }, [client, planId, status, contactFilter]);

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

  const nameOf = (contactId: string) =>
    plan.contacts.find((c) => c.contactId === contactId)?.displayName ?? shortId(contactId);

  const inlineAction = async (
    row: OutreachRow,
    fn: () => Promise<{ error: unknown }>,
    fallback: string,
  ) => {
    setBusyId(row.outreachId);
    setActionError(null);
    const { error: err } = await fn();
    setBusyId(null);
    if (err) {
      setActionError(errorMessage(err, fallback));
      return;
    }
    void load();
  };

  return (
    <div className="wx-kit-column" style={columnStyle}>
      <PageHeader
        title={<span style={pageTitleStyle}>Outreach planner</span>}
        breadcrumb={`Bereavement — plan ${shortId(planId)}`}
        actions={
          <div style={{ display: "flex", gap: t.space2, flexWrap: "wrap" }}>
            <button
              type="button"
              style={ghostButtonStyle}
              onClick={() => setCeremony({ kind: "regenerate" })}
            >
              Regenerate forward schedule
            </button>
            <Link to={`/bereavement/plans/${planId}`} style={ghostButtonStyle}>
              Back to plan
            </Link>
          </div>
        }
      />

      <Notice tone="info">
        The touchpoint book runs to {shortDate(plan.windowEndsAt)} — 396 days from the death, plus
        the 30-day grace the schedule ceiling allows. Regeneration only ever writes FORWARD: a
        touchpoint whose due date has already passed is never resurrected as a backdated obligation.
      </Notice>

      {actionError ? <p style={alertStyle}>{actionError}</p> : null}

      <FilterRow>
        <SelectField label="Status" value={status} options={STATUS_FILTERS} onChange={setStatus} />
        <SelectField
          label="Survivor"
          value={contactFilter}
          options={[
            { value: "", label: "all survivors" },
            ...plan.contacts.map((c) => ({ value: c.contactId, label: c.displayName })),
          ]}
          onChange={setContactFilter}
        />
      </FilterRow>

      <Card title={`Touchpoints (${rows.length})`}>
        {rows.length === 0 ? (
          <span style={mutedStyle}>No touchpoints match this filter.</span>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={th}>Due</th>
                <th style={th}>Survivor</th>
                <th style={th}>Kind</th>
                <th style={th}>Mark</th>
                <th style={th}>Status</th>
                <th style={th}>Completed</th>
                <th style={th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => {
                const busy = busyId === o.outreachId;
                return (
                  <tr key={o.outreachId} style={rowLine}>
                    <td style={td}>
                      {shortDate(o.dueAt)}
                      <div style={mutedStyle}>{dueLabel(o.dueAt)}</div>
                    </td>
                    <td style={td}>{nameOf(o.contactId)}</td>
                    <td style={td}>{outreachKindLabel(o.kind)}</td>
                    <td style={td}>
                      {o.anniversaryMark ? anniversaryMarkLabel(o.anniversaryMark) : "—"}
                    </td>
                    <td style={td}>
                      <StatusPill
                        label={humanize(o.status)}
                        tone={toneOf(OUTREACH_STATUS_TONE, o.status)}
                      />
                    </td>
                    <td style={td}>{dateTime(o.completedAt)}</td>
                    <td style={td}>
                      <div style={{ display: "flex", gap: "0.35rem", flexWrap: "wrap" }}>
                        {o.status === "scheduled" ? (
                          <button
                            type="button"
                            style={ghostButtonStyle}
                            disabled={busy}
                            onClick={() =>
                              inlineAction(
                                o,
                                () => startOutreach(client, o.outreachId, o.version),
                                "This touchpoint could not be started.",
                              )
                            }
                          >
                            {busy ? "…" : "Start"}
                          </button>
                        ) : null}
                        {o.status === "missed" ? (
                          <button
                            type="button"
                            style={ghostButtonStyle}
                            disabled={busy}
                            onClick={() =>
                              inlineAction(
                                o,
                                () => lateAttemptOutreach(client, o.outreachId, o.version),
                                "The late attempt could not be opened. The 7-day grace window may have closed.",
                              )
                            }
                          >
                            {busy ? "…" : "Late attempt"}
                          </button>
                        ) : null}
                        {o.status === "in_progress" ? (
                          <>
                            <button
                              type="button"
                              style={primaryButtonStyle}
                              onClick={() => setCeremony({ kind: "complete", row: o })}
                            >
                              Complete
                            </button>
                            <button
                              type="button"
                              style={ghostButtonStyle}
                              onClick={() => setCeremony({ kind: "decline", row: o })}
                            >
                              Declined
                            </button>
                            <button
                              type="button"
                              style={ghostButtonStyle}
                              onClick={() => setCeremony({ kind: "no-response", row: o })}
                            >
                              No response
                            </button>
                          </>
                        ) : null}
                        {o.status === "scheduled" || o.status === "in_progress" ? (
                          <button
                            type="button"
                            style={ghostButtonStyle}
                            onClick={() => setCeremony({ kind: "cancel", row: o })}
                          >
                            Cancel
                          </button>
                        ) : null}
                        {o.renderedDocumentId ? (
                          <span style={mutedStyle}>doc {shortId(o.renderedDocumentId)}</span>
                        ) : null}
                        {o.sourceEncounterId ? (
                          <span style={mutedStyle}>encounter {shortId(o.sourceEncounterId)}</span>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      {ceremony?.kind === "complete" ? (
        <CompleteModal
          row={ceremony.row}
          onClose={() => setCeremony(null)}
          onDone={() => {
            setCeremony(null);
            void load();
          }}
        />
      ) : null}
      {ceremony?.kind === "decline" || ceremony?.kind === "no-response" ? (
        <OutcomeModal
          row={ceremony.row}
          variant={ceremony.kind}
          onClose={() => setCeremony(null)}
          onDone={() => {
            setCeremony(null);
            void load();
          }}
        />
      ) : null}
      {ceremony?.kind === "cancel" ? (
        <CancelModal
          row={ceremony.row}
          onClose={() => setCeremony(null)}
          onDone={() => {
            setCeremony(null);
            void load();
          }}
        />
      ) : null}
      {ceremony?.kind === "regenerate" ? (
        <RegenerateModal
          planId={planId}
          version={plan.version}
          contacts={plan.contacts.map((c) => ({ id: c.contactId, name: c.displayName }))}
          onClose={() => setCeremony(null)}
          onDone={() => {
            setCeremony(null);
            void load();
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * §5.1 #11 — the completion ceremony (route 21). The form SHAPE carries D15: the encounter field appears
 * for `in_person_visit` and for nothing else, because the server's body is a discriminated union and the
 * contact-log table carries the same rule in both directions as a CHECK pair.
 */
function CompleteModal({
  row,
  onClose,
  onDone,
}: { row: OutreachRow; onClose: () => void; onDone: () => void }): JSX.Element {
  const client = useApiClient();
  const inPerson = row.kind === "in_person_visit";
  const [sourceEncounterId, setSourceEncounterId] = useState(row.sourceEncounterId ?? "");
  const [artifactDocumentId, setArtifactDocumentId] = useState(row.renderedDocumentId ?? "");
  const [outcome, setOutcome] = useState(DEFAULT_LOG_OUTCOME);
  const [responded, setResponded] = useState(true);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    // `outcome` is always one of the closed vocabulary the SelectField below offers.
    const body = inPerson
      ? {
          kind: "in_person_visit" as const,
          sourceEncounterId,
          outcome: outcome as BereavementLogOutcome,
          contactResponded: responded,
          notes: notes || undefined,
        }
      : {
          // `row.kind` is never "in_person_visit" here — that arm is handled above.
          kind: row.kind as Exclude<OutreachRow["kind"], "in_person_visit">,
          outcome: outcome as BereavementLogOutcome,
          contactResponded: responded,
          artifactDocumentId: artifactDocumentId || undefined,
          notes: notes || undefined,
        };
    const { error: err } = await completeOutreach(client, row.outreachId, row.version, body);
    setBusy(false);
    if (err) {
      setError(errorMessage(err, "This touchpoint could not be completed."));
      return;
    }
    onDone();
  };

  return (
    <Modal
      title={`Complete — ${outreachKindLabel(row.kind)}`}
      onClose={onClose}
      footer={
        <button
          type="button"
          style={primaryButtonStyle}
          disabled={busy || (inPerson && sourceEncounterId.trim().length === 0)}
          onClick={submit}
        >
          {busy ? "Completing…" : "Complete"}
        </button>
      }
    >
      {inPerson ? (
        <Notice tone="info">
          An in-person bereavement visit is an M8 encounter. The signed encounter id is required —
          it is what links this touchpoint to the clinical record, and the database refuses the row
          without it.
        </Notice>
      ) : null}
      {inPerson ? (
        <TextField
          label="Signed M8 encounter id"
          value={sourceEncounterId}
          onChange={setSourceEncounterId}
        />
      ) : (
        <TextField
          label="M22 rendered document id (optional)"
          value={artifactDocumentId}
          onChange={setArtifactDocumentId}
        />
      )}
      <SelectField
        label="Outcome"
        value={outcome}
        options={LOG_OUTCOMES.map((o) => ({ value: o, label: humanize(o) }))}
        onChange={setOutcome}
      />
      <CheckboxField
        label="The survivor responded directly"
        checked={responded}
        onChange={setResponded}
      />
      <TextAreaField
        label="Counselor note"
        value={notes}
        onChange={setNotes}
        hint="Counselor notes are encrypted at rest and are NOT what the family portal shows."
      />
      {error ? <p style={alertStyle}>{error}</p> : null}
    </Modal>
  );
}

/** Routes 22 / 23 — the two fixed-outcome completions. Neither is an opt-out: the schedule continues. */
function OutcomeModal({
  row,
  variant,
  onClose,
  onDone,
}: {
  row: OutreachRow;
  variant: "decline" | "no-response";
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  const client = useApiClient();
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const { error: err } =
      variant === "decline"
        ? await declineOutreach(client, row.outreachId, row.version, { notes: notes || undefined })
        : await noResponseOutreach(client, row.outreachId, row.version, {
            notes: notes || undefined,
          });
    setBusy(false);
    if (err) {
      setError(errorMessage(err, "This touchpoint outcome could not be recorded."));
      return;
    }
    onDone();
  };

  return (
    <Modal
      title={
        variant === "decline" ? "Survivor declined this touchpoint" : "No response after retries"
      }
      onClose={onClose}
      footer={
        <button type="button" style={primaryButtonStyle} disabled={busy} onClick={submit}>
          {busy ? "Recording…" : "Record"}
        </button>
      }
    >
      <Notice tone="info">
        {variant === "decline"
          ? "Declining ONE touchpoint is not an opt-out: the forward schedule continues untouched and no plan-level consent evaluation runs."
          : "A no-response feeds the three-strikes proposal that can later mark this survivor unreachable. The threshold is the lifecycle machine's, not this form's."}
      </Notice>
      <TextAreaField label="Note (optional)" value={notes} onChange={setNotes} />
      {error ? <p style={alertStyle}>{error}</p> : null}
    </Modal>
  );
}

/** Route 24 — cancel a scheduled touchpoint (a reason is mandatory). */
function CancelModal({
  row,
  onClose,
  onDone,
}: { row: OutreachRow; onClose: () => void; onDone: () => void }): JSX.Element {
  const client = useApiClient();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const { error: err } = await cancelOutreach(client, row.outreachId, row.version, { reason });
    setBusy(false);
    if (err) {
      setError(errorMessage(err, "This touchpoint could not be cancelled."));
      return;
    }
    onDone();
  };

  return (
    <Modal
      title="Cancel touchpoint"
      onClose={onClose}
      footer={
        <button
          type="button"
          style={primaryButtonStyle}
          disabled={busy || reason.trim().length === 0}
          onClick={submit}
        >
          {busy ? "Cancelling…" : "Cancel touchpoint"}
        </button>
      }
    >
      <TextAreaField label="Reason" value={reason} onChange={setReason} />
      {error ? <p style={alertStyle}>{error}</p> : null}
    </Modal>
  );
}

/** Route 27 — regenerate the FORWARD book, whole-plan or for one survivor. */
function RegenerateModal({
  planId,
  version,
  contacts,
  onClose,
  onDone,
}: {
  planId: string;
  version: number;
  contacts: { id: string; name: string }[];
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  const client = useApiClient();
  const [contactId, setContactId] = useState("");
  const [fromAt, setFromAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const { result, error: err } = await regenerateSchedule(client, planId, version, {
      contactId: contactId || undefined,
      fromAt: fromAt ? new Date(fromAt).toISOString() : undefined,
    });
    setBusy(false);
    if (err) {
      setError(errorMessage(err, "The schedule could not be regenerated."));
      return;
    }
    setSummary(
      result
        ? `${result.cancelledCount} touchpoints cancelled · ${result.generatedCount} generated.`
        : null,
    );
    onDone();
  };

  return (
    <Modal
      title="Regenerate forward schedule"
      onClose={onClose}
      footer={
        <button type="button" style={primaryButtonStyle} disabled={busy} onClick={submit}>
          {busy ? "Regenerating…" : "Regenerate"}
        </button>
      }
    >
      <Notice tone="warning">
        Regeneration cancels the remaining FUTURE touchpoints and re-materializes them from the
        platform floor plus your organization's tightening. Past touchpoints, and their contact-log
        rows, are never touched.
      </Notice>
      <SelectField
        label="Scope"
        value={contactId}
        options={[
          { value: "", label: "the whole plan" },
          ...contacts.map((c) => ({ value: c.id, label: c.name })),
        ]}
        onChange={setContactId}
      />
      <TextField
        label="Regenerate from (optional)"
        type="datetime-local"
        value={fromAt}
        onChange={setFromAt}
      />
      {summary ? <p style={mutedStyle}>{summary}</p> : null}
      {error ? <p style={alertStyle}>{error}</p> : null}
    </Modal>
  );
}
