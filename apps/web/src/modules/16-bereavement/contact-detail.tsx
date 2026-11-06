// apps/web/src/modules/16-bereavement — the BEREAVED CONTACT DETAIL (§5.1 #7, Track B / ADR-0030),
// carrying the §5.1 #15 opt-out review modal. Spec: docs/design/screens/clinical — "Use Record Detail."
//
// ROUTE SHAPE — §5.1 proposes `/app/bereavement/contacts/:contactId`, but M16's §4.1 read surface publishes
// NO "get one contact" route: a survivor is only ever read as part of their plan (route 2's rolled-up
// roster), which is what makes the §7.13 redaction and the D10 volunteer scope a single decision on a
// single body. Rather than invent a read the server does not have, this screen is plan-scoped —
// `/bereavement/plans/:planId/contacts/:contactId` — and resolves the survivor out of the plan detail. The
// architecture wins over the screen spec's proposed path (repo authority rule).
//
// The four §2.3 terminal/near-terminal transitions (opt-out, mark deceased, mark unreachable, confirm)
// all live here as modals over the row `version` this screen read, so each carries an honest `If-Match`.
// `flag_complicated_grief` deliberately does NOT: it ends the program for this survivor and belongs with
// the screening instrument that justifies it (§5.1 #13).
import {
  Button,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  t,
  useApiClient,
} from "@chartwarden/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { Link, useParams } from "react-router-dom";
import {
  type BereavementLogKind,
  type BereavementLogOutcome,
  type BereavementOptOutKind,
  type BereavementOutreachKind,
  type ContactRow,
  type OutreachRow,
  type PlanDetail,
  confirmContact,
  dismissUnreachableProposal,
  errorMessage,
  getPlan,
  isStaleWrite,
  listOutreach,
  logDirectContact,
  markContactDeceased,
  markContactUnreachable,
  optOutContact,
  rescindOptOut,
  setCareGoals,
  updateContact,
} from "./bereavement-api";
import {
  CARE_GOALS_MAX,
  CARE_GOAL_MAX_CHARS,
  CONTACT_STATUS_TONE,
  DEFAULT_LOG_OUTCOME,
  DEFAULT_NON_ENCOUNTER_KIND,
  DEFAULT_OPT_OUT_KIND,
  LOG_OUTCOMES,
  NON_ENCOUNTER_OUTREACH_KINDS,
  OPT_OUT_KINDS,
  OUTREACH_KINDS,
  OUTREACH_STATUS_TONE,
  dateTime,
  dueLabel,
  humanize,
  optOutKindLabel,
  outreachKindLabel,
  shortDate,
  shortId,
  toneOf,
  touchpointLabel,
} from "./bereavement-status";
import {
  Card,
  CheckboxField,
  ErrorText,
  Field,
  Modal,
  Notice,
  RiskTierPill,
  SelectField,
  SummaryGrid,
  TextAreaField,
  TextField,
  columnStyle,
  ghostButtonStyle,
  mutedStyle,
  pageTitleStyle,
  primaryButtonStyle,
  rowLine,
  tableStyle,
  td,
  th,
  useActionStatus,
  useIdempotencyKey,
} from "./bereavement-ui";

/** What a refused write on this page means: the contact moved (or was decided) under the reader, so the page reloads. */
const CONTACT_MOVED =
  "This contact changed while you were working on it. The page has been refreshed: check it and try again.";

/** This contact's schedule is a convenience beside the care plan; it says why when it is not there. */
type Schedule = { kind: "ready"; rows: OutreachRow[] } | { kind: "forbidden" } | { kind: "error" };

type Ceremony =
  | "opt-out"
  | "rescind"
  | "deceased"
  | "unreachable"
  | "confirm"
  | "log"
  | "channels"
  | null;

export function BereavedContactDetail(): JSX.Element {
  const { planId, contactId } = useParams<{ planId: string; contactId: string }>();
  // Keyed by plan + contact: a route-param change remounts, so one survivor's page is never shown under another's id.
  return <ContactForPlan key={`${planId}/${contactId}`} planId={planId} contactId={contactId} />;
}

function ContactForPlan({
  planId,
  contactId,
}: { planId: string | undefined; contactId: string | undefined }): JSX.Element {
  const client = useApiClient();
  const [plan, setPlan] = useState<PlanDetail | null>(null);
  // `loading` is the FIRST load only: after an action the page stays up with its data (no unmount, no lost focus or typing).
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [ceremony, setCeremony] = useState<Ceremony>(null);
  const [keepTryingBusy, setKeepTryingBusy] = useState(false);
  const [keepTryingError, setKeepTryingError] = useState<string | null>(null);
  const [resumeBusy, setResumeBusy] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);
  // ADR-0109 — this contact's own schedule (null until the first load).
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const { announce, region } = useActionStatus();
  const keepTryingKey = useIdempotencyKey();
  const resumeKey = useIdempotencyKey();
  const latestRequest = useRef(0);
  const hasPlan = useRef(false);

  const load = useCallback(async () => {
    if (!planId) return;
    const mine = ++latestRequest.current;
    const [{ plan: p, error: err }, outreach] = await Promise.all([
      getPlan(client, planId),
      contactId
        ? listOutreach(client, planId, { contactId, limit: 100 })
        : Promise.resolve({ page: null, error: null, status: 200 }),
    ]);
    if (mine !== latestRequest.current) return; // a newer load, or an unmount, superseded this response
    if (err) {
      const message = errorMessage(err, "This bereavement plan could not be loaded.");
      if (hasPlan.current) setRefreshError(message);
      else setError(message);
      setLoading(false);
      return;
    }
    hasPlan.current = true;
    setPlan(p);
    // The schedule is a convenience beside the care plan: an unreadable one never hides the contact.
    setSchedule(
      Array.isArray(outreach.page?.data)
        ? { kind: "ready", rows: outreach.page.data.filter((row) => row.contactId === contactId) }
        : outreach.status === 403
          ? { kind: "forbidden" }
          : { kind: "error" },
    );
    setError(null);
    setRefreshError(null);
    setLoading(false);
  }, [client, planId, contactId]);

  useEffect(() => {
    void load();
    return () => {
      latestRequest.current += 1;
    };
  }, [load]);

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;
  const contact = plan?.contacts.find((c) => c.contactId === contactId);
  if (!plan || !contact || !contactId || !planId)
    return (
      <EmptyState
        title="Not found"
        description="This bereaved contact is not on this plan's roster, or the plan is not on your caseload."
      />
    );

  /** A write succeeded: reload (the page stays mounted) and say so, moving focus off a trigger that may be gone. */
  const acted = (message: string) => {
    announce(message);
    void load();
  };

  const refresh = () => {
    setCeremony(null);
    acted("Saved. The page shows the latest version.");
  };

  const keepTrying = async () => {
    setKeepTryingBusy(true);
    setKeepTryingError(null);
    const { error: err, status } = await dismissUnreachableProposal(
      client,
      contact.contactId,
      contact.version,
      keepTryingKey.keyFor(String(contact.version)),
    );
    keepTryingKey.settle(status);
    setKeepTryingBusy(false);
    if (err) {
      if (isStaleWrite(status)) void load();
      setKeepTryingError(
        isStaleWrite(status)
          ? CONTACT_MOVED
          : errorMessage(
              err,
              "The unreachable proposal could not be dismissed. Reload and try again.",
            ),
      );
      return;
    }
    acted("Kept trying: the unreachable proposal was dismissed.");
  };

  // ADR-0109 D10 — mailings resume by rescinding the open `no_mailings` row; the contact never left the program.
  const resumeMailings = async () => {
    setResumeBusy(true);
    setResumeError(null);
    const { error: err, status } = await rescindOptOut(
      client,
      contact.contactId,
      contact.version,
      {},
      resumeKey.keyFor(String(contact.version)),
    );
    resumeKey.settle(status);
    setResumeBusy(false);
    if (err) {
      if (isStaleWrite(status)) void load();
      setResumeError(
        isStaleWrite(status)
          ? CONTACT_MOVED
          : errorMessage(err, "Mailings could not be resumed. Reload and try again."),
      );
      return;
    }
    acted("Mailings resumed.");
  };

  return (
    <div className="wx-kit-column" style={columnStyle}>
      <PageHeader
        title={<span style={pageTitleStyle}>{contact.displayName}</span>}
        actions={
          <div style={{ display: "flex", gap: t.space2, flexWrap: "wrap" }}>
            <Link to={`/bereavement/plans/${planId}`} style={ghostButtonStyle}>
              Back to plan
            </Link>
            <Link
              to={`/bereavement/plans/${planId}/contacts/${contactId}/screen`}
              style={ghostButtonStyle}
            >
              Grief screen
            </Link>
          </div>
        }
      />
      {region}
      {refreshError ? (
        <div style={{ display: "flex", gap: t.space2, alignItems: "center", flexWrap: "wrap" }}>
          <ErrorText>{refreshError}</ErrorText>
          <Button size="sm" tone="secondary" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      ) : null}

      {contact.status === "proposed" ? (
        <Notice tone="warning">
          This survivor is `proposed` — no outreach may be attempted until they are confirmed, and
          confirming resolves the M39 bereavement-outreach consent server-side. That check fails
          CLOSED.
        </Notice>
      ) : null}

      {contact.unreachableProposed ? (
        <Notice tone="warning" live>
          <div style={{ display: "flex", gap: t.space2, flexWrap: "wrap", alignItems: "center" }}>
            <span>
              Contact may be unreachable: 3 consecutive no-response attempts
              {contact.unreachableProposedAt
                ? ` (latest ${dateTime(contact.unreachableProposedAt)})`
                : ""}
              . The nightly check only proposes this; nothing changes until a counselor confirms.
            </span>
            <button
              type="button"
              style={primaryButtonStyle}
              onClick={() => setCeremony("unreachable")}
            >
              Mark unreachable
            </button>
            <button
              type="button"
              style={ghostButtonStyle}
              disabled={keepTryingBusy}
              onClick={keepTrying}
            >
              {keepTryingBusy ? "Saving…" : "Keep trying"}
            </button>
          </div>
          {keepTryingError ? <ErrorText>{keepTryingError}</ErrorText> : null}
        </Notice>
      ) : null}

      {contact.optedOutAt ? (
        <Notice tone="info">
          Opted out {dateTime(contact.optedOutAt)}.{" "}
          {contact.mayRescindOptOut
            ? "The 90-day self-service rescind window is still open."
            : "The 90-day self-service rescind window has closed; a counselor rescind with a documented reason is still possible."}
        </Notice>
      ) : null}

      <Card
        title="Survivor"
        actions={
          <StatusPill
            label={humanize(contact.status)}
            tone={toneOf(CONTACT_STATUS_TONE, contact.status)}
          />
        }
      >
        <SummaryGrid>
          <Field label="Relationship" value={humanize(contact.relationshipCode)} />
          <Field label="Preferred language" value={contact.preferredLanguageIso639} />
          <Field label="Risk tier" value={<RiskTierPill tier={contact.currentRiskTier} />} />
          <Field label="Confirmed" value={dateTime(contact.confirmedAt)} />
          <Field label="Opted out" value={dateTime(contact.optedOutAt)} />
          <Field
            label="Mailings"
            value={
              contact.mailingsAllowed ? (
                "allowed"
              ) : (
                <StatusPill label="Mailings stopped" tone="warning" />
              )
            }
          />
          <Field label="Unreachable" value={dateTime(contact.unreachableAt)} />
          <Field label="Deceased" value={dateTime(contact.deceasedAt)} />
          <Field
            label="M39 consent record"
            value={contact.consentRecordId ? shortId(contact.consentRecordId) : "—"}
            mono
          />
          <Field
            label="M31 portal account"
            value={contact.portalAccountId ? "linked" : "not linked"}
          />
          <Field
            label="Volunteer-visible only"
            value={contact.volunteerVisibleOnly ? "yes" : "no"}
          />
          <Field label="Version" value={contact.version} />
        </SummaryGrid>
        <span style={mutedStyle}>
          Email, phone and mailing address are envelope-encrypted at rest and are not returned on
          this read surface — the allowed CHANNELS are, because those drive what may be sent.
        </span>
      </Card>

      <Card title="Outreach preferences">
        <span style={mutedStyle}>
          {contact.allowedOutreachKinds.length === 0
            ? "No channels are allowed. No scheduled touchpoint can be delivered to this survivor."
            : contact.allowedOutreachKinds.map(outreachKindLabel).join(" · ")}
        </span>
        <div style={{ display: "flex", gap: t.space2, flexWrap: "wrap" }}>
          <button type="button" style={ghostButtonStyle} onClick={() => setCeremony("channels")}>
            Edit channels
          </button>
        </div>
      </Card>

      <Card title="Care plan">
        <CarePlanGoals
          contact={contact}
          onSaved={() => acted("Care goals saved.")}
          onStale={() => void load()}
        />
        <ContactSchedule schedule={schedule} onRetry={() => void load()} />
      </Card>

      <Card title="Actions">
        <div style={{ display: "flex", gap: t.space2, flexWrap: "wrap" }}>
          {contact.status === "proposed" ? (
            <button type="button" style={primaryButtonStyle} onClick={() => setCeremony("confirm")}>
              Confirm contact
            </button>
          ) : null}
          {contact.status === "active" ? (
            <button type="button" style={ghostButtonStyle} onClick={() => setCeremony("opt-out")}>
              Record opt-out
            </button>
          ) : null}
          {contact.status === "opted_out" ? (
            <button type="button" style={ghostButtonStyle} onClick={() => setCeremony("rescind")}>
              Rescind opt-out
            </button>
          ) : null}
          {contact.status === "active" && !contact.mailingsAllowed ? (
            <button
              type="button"
              style={ghostButtonStyle}
              disabled={resumeBusy}
              onClick={resumeMailings}
            >
              {resumeBusy ? "Resuming…" : "Resume mailings"}
            </button>
          ) : null}
          <button type="button" style={ghostButtonStyle} onClick={() => setCeremony("log")}>
            Log an ad-hoc contact
          </button>
          <button type="button" style={ghostButtonStyle} onClick={() => setCeremony("unreachable")}>
            Mark unreachable
          </button>
          <button type="button" style={ghostButtonStyle} onClick={() => setCeremony("deceased")}>
            Mark deceased
          </button>
        </div>
        {resumeError ? <ErrorText>{resumeError}</ErrorText> : null}
        <span style={mutedStyle}>
          Marking a survivor deceased is §2.3's only terminal state, so the verification source is
          required. Marking unreachable accepts the nightly three-strikes proposal — the machine
          enforces the threshold, so firing this early is refused rather than silently trusted.
        </span>
      </Card>

      {ceremony === "confirm" ? (
        <ConfirmModal contact={contact} onClose={() => setCeremony(null)} onDone={refresh} />
      ) : null}
      {ceremony === "opt-out" ? (
        <OptOutModal contact={contact} onClose={() => setCeremony(null)} onDone={refresh} />
      ) : null}
      {ceremony === "rescind" ? (
        <RescindModal contact={contact} onClose={() => setCeremony(null)} onDone={refresh} />
      ) : null}
      {ceremony === "deceased" ? (
        <DeceasedModal contact={contact} onClose={() => setCeremony(null)} onDone={refresh} />
      ) : null}
      {ceremony === "unreachable" ? (
        <UnreachableModal contact={contact} onClose={() => setCeremony(null)} onDone={refresh} />
      ) : null}
      {ceremony === "log" ? (
        <LogDirectModal contact={contact} onClose={() => setCeremony(null)} onDone={refresh} />
      ) : null}
      {ceremony === "channels" ? (
        <ChannelsModal contact={contact} onClose={() => setCeremony(null)} onDone={refresh} />
      ) : null}
    </div>
  );
}

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((value, i) => value === b[i]);

/** The contact's 1-3 care goals (ADR-0109). ABSENT `careGoals` means the D10 scope withheld them — no editor then. */
function CarePlanGoals({
  contact,
  onSaved,
  onStale,
}: { contact: ContactRow; onSaved: () => void; onStale: () => void }): JSX.Element {
  const client = useApiClient();
  const recorded = contact.careGoals;
  const [goals, setGoals] = useState<string[]>([...(recorded ?? [])]);
  // The server's goals the editor was last seeded from. A reload for an unrelated action keeps what was typed: the editor
  // is re-seeded only when the contact's version moved AND the reader has not edited it.
  const [seeded, setSeeded] = useState({ version: contact.version, goals: recorded ?? [] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idempotency = useIdempotencyKey();

  if (seeded.version !== contact.version) {
    if (sameList(goals, seeded.goals)) setGoals([...(recorded ?? [])]);
    setSeeded({ version: contact.version, goals: recorded ?? [] });
  }

  if (recorded === undefined) {
    return (
      <span style={mutedStyle}>
        Care goals are not shown in your scope. A volunteer sees the contact's name and schedule,
        not the goals a counselor recorded with the family.
      </span>
    );
  }

  const trimmed = goals.map((g) => g.trim());
  const blank = trimmed.some((g) => g.length === 0);
  const unchanged = sameList(trimmed, recorded);

  const save = async () => {
    setBusy(true);
    setError(null);
    const { error: err, status } = await setCareGoals(
      client,
      contact.contactId,
      contact.version,
      trimmed,
      idempotency.keyFor(`${contact.version}:${JSON.stringify(trimmed)}`),
    );
    idempotency.settle(status);
    setBusy(false);
    if (err) {
      if (isStaleWrite(status)) {
        // What was typed stays in the editor; the page reloads so the next save carries the version now current.
        setError(CONTACT_MOVED);
        onStale();
        return;
      }
      setError(errorMessage(err, "The care goals could not be saved."));
      return;
    }
    onSaved();
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: t.space2 }}>
      <span style={mutedStyle}>
        Up to three goals recorded with the family, in their words. They are sealed at rest and not
        shown to volunteers.
      </span>
      {goals.map((goal, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: an editable list of free text with no stable id
        <div key={i} style={{ display: "flex", gap: t.space2, alignItems: "flex-end" }}>
          <TextField
            label={`Care goal ${i + 1}`}
            value={goal}
            maxLength={CARE_GOAL_MAX_CHARS}
            onChange={(v) => setGoals(goals.map((g, j) => (j === i ? v : g)))}
          />
          <button
            type="button"
            style={ghostButtonStyle}
            aria-label={`Remove care goal ${i + 1}`}
            onClick={() => setGoals(goals.filter((_, j) => j !== i))}
          >
            Remove
          </button>
        </div>
      ))}
      <div style={{ display: "flex", gap: t.space2, flexWrap: "wrap" }}>
        {goals.length < CARE_GOALS_MAX ? (
          <button type="button" style={ghostButtonStyle} onClick={() => setGoals([...goals, ""])}>
            Add goal
          </button>
        ) : null}
        <button
          type="button"
          style={primaryButtonStyle}
          disabled={busy || blank || unchanged}
          onClick={save}
        >
          {busy ? "Saving…" : "Save care goals"}
        </button>
      </div>
      {error ? <ErrorText>{error}</ErrorText> : null}
    </div>
  );
}

/** This contact's own touchpoints, each named by the Medicare-floor mark it was generated for (ADR-0109 D2/D4). */
function ContactSchedule({
  schedule,
  onRetry,
}: { schedule: Schedule | null; onRetry: () => void }): JSX.Element {
  if (schedule === null || schedule.kind === "error") {
    return (
      <div style={{ display: "flex", gap: t.space2, alignItems: "center", flexWrap: "wrap" }}>
        <ErrorText>This survivor's schedule could not be loaded.</ErrorText>
        <Button size="sm" tone="secondary" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  }
  if (schedule.kind === "forbidden") {
    return (
      <span style={mutedStyle}>
        Your role does not include the touchpoint schedule, so it is not shown here.
      </span>
    );
  }
  const rows = schedule.rows;
  if (rows.length === 0) {
    return <span style={mutedStyle}>No touchpoints are scheduled for this survivor.</span>;
  }
  return (
    <table style={tableStyle}>
      <thead>
        <tr>
          <th style={th}>Touchpoint</th>
          <th style={th}>Modality</th>
          <th style={th}>Due</th>
          <th style={th}>Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((o) => (
          <tr key={o.outreachId} style={rowLine}>
            <td style={td}>{touchpointLabel(o)}</td>
            <td style={td}>{outreachKindLabel(o.kind)}</td>
            <td style={td}>
              {shortDate(o.dueAt)}
              <div style={mutedStyle}>{dueLabel(o.dueAt)}</div>
            </td>
            <td style={td}>
              <StatusPill
                label={humanize(o.status)}
                tone={toneOf(OUTREACH_STATUS_TONE, o.status)}
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Route 13 — proposed → active. */
function ConfirmModal({
  contact,
  onClose,
  onDone,
}: { contact: ContactRow; onClose: () => void; onDone: () => void }): JSX.Element {
  const client = useApiClient();
  const [consentRecordId, setConsentRecordId] = useState(contact.consentRecordId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const { error: err } = await confirmContact(client, contact.contactId, contact.version, {
      consentRecordId: consentRecordId || undefined,
    });
    setBusy(false);
    if (err) {
      setError(
        errorMessage(
          err,
          "This survivor could not be confirmed. The M39 bereavement-outreach consent check fails closed — an unresolvable consent is a refusal, not a warning.",
        ),
      );
      return;
    }
    onDone();
  };

  return (
    <Modal
      title="Confirm bereaved contact"
      onClose={onClose}
      footer={
        <button type="button" style={primaryButtonStyle} disabled={busy} onClick={submit}>
          {busy ? "Confirming…" : "Confirm"}
        </button>
      }
    >
      <TextField
        label="M39 consent record id (optional)"
        value={consentRecordId}
        onChange={setConsentRecordId}
      />
      <Notice tone="info">
        Consent is resolved by the server against Module 39. It is never decided by this form.
      </Notice>
      {error ? <ErrorText>{error}</ErrorText> : null}
    </Modal>
  );
}

/** §5.1 #15 — the opt-out review (route 14). Scope: full / channel-specific / pause-temporarily. */
function OptOutModal({
  contact,
  onClose,
  onDone,
}: { contact: ContactRow; onClose: () => void; onDone: () => void }): JSX.Element {
  const client = useApiClient();
  const [optOutKind, setOptOutKind] = useState(DEFAULT_OPT_OUT_KIND);
  const [channelKinds, setChannelKinds] = useState<string[]>([]);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (k: string) =>
    setChannelKinds(
      channelKinds.includes(k) ? channelKinds.filter((x) => x !== k) : [...channelKinds, k],
    );

  const submit = async () => {
    setBusy(true);
    setError(null);
    // `optOutKind`/`channelKinds` are always drawn from the closed vocabularies the SelectField /
    // checkbox list below offer.
    const { error: err } = await optOutContact(client, contact.contactId, contact.version, {
      optOutKind: optOutKind as BereavementOptOutKind,
      channelKinds:
        optOutKind === "channel_specific" ? (channelKinds as BereavementOutreachKind[]) : undefined,
      reason: reason || undefined,
      // This screen is the STAFF path. A survivor's own M31 portal opt-out carries
      // `portal_self_service` and rides the portal-self ABAC branch instead.
      sourceKind: "counselor_recorded",
    });
    setBusy(false);
    if (err) {
      setError(errorMessage(err, "The opt-out could not be recorded."));
      return;
    }
    onDone();
  };

  // `no_mailings` is not a departure: the survivor stays in the program, so the ceremony says what it does.
  const stopsMailings = optOutKind === "no_mailings";
  return (
    <Modal
      title={stopsMailings ? "Stop mailings" : "Record opt-out"}
      onClose={onClose}
      footer={
        <button
          type="button"
          style={primaryButtonStyle}
          disabled={busy || (optOutKind === "channel_specific" && channelKinds.length === 0)}
          onClick={submit}
        >
          {busy ? "Recording…" : stopsMailings ? "Stop mailings" : "Record opt-out"}
        </button>
      }
    >
      {stopsMailings ? (
        <Notice tone="info">
          Stops the cards, letters and invitations sent by post. The survivor stays in the program:
          calls and visits continue, and a mailed touchpoint on the schedule becomes a phone call.
          Mailings can be resumed at any time.
        </Notice>
      ) : (
        <Notice tone="info">
          A full opt-out cancels every future touchpoint for this survivor, and closes the plan if
          it was the last enrollee. A self-service opt-out may be rescinded for 90 days; a counselor
          rescind with a documented reason is not bound by that window.
        </Notice>
      )}
      <SelectField
        label="Scope"
        value={optOutKind}
        options={OPT_OUT_KINDS.map((k) => ({ value: k, label: optOutKindLabel(k) }))}
        onChange={setOptOutKind}
      />
      {optOutKind === "channel_specific" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
          <span style={{ fontSize: "0.7rem", color: t.onSurfaceVariant }}>Channels declined</span>
          {OUTREACH_KINDS.map((k) => (
            <CheckboxField
              key={k}
              label={outreachKindLabel(k)}
              checked={channelKinds.includes(k)}
              onChange={() => toggle(k)}
            />
          ))}
        </div>
      ) : null}
      <TextAreaField label="Reason (optional)" value={reason} onChange={setReason} />
      {error ? <ErrorText>{error}</ErrorText> : null}
    </Modal>
  );
}

/** Route 15 — undo an opt-out. */
function RescindModal({
  contact,
  onClose,
  onDone,
}: { contact: ContactRow; onClose: () => void; onDone: () => void }): JSX.Element {
  const client = useApiClient();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const { error: err } = await rescindOptOut(client, contact.contactId, contact.version, {
      reason: reason || undefined,
    });
    setBusy(false);
    if (err) {
      setError(errorMessage(err, "The opt-out could not be rescinded."));
      return;
    }
    onDone();
  };

  return (
    <Modal
      title="Rescind opt-out"
      onClose={onClose}
      footer={
        <button type="button" style={primaryButtonStyle} disabled={busy} onClick={submit}>
          {busy ? "Rescinding…" : "Rescind"}
        </button>
      }
    >
      <Notice tone="info">
        A survivor who calls back at month five asking to re-enrol should not be told the software
        forgot how. A counselor rescind is not bound by the 90-day self-service window, but it must
        say why.
      </Notice>
      <TextAreaField label="Reason" value={reason} onChange={setReason} />
      {error ? <ErrorText>{error}</ErrorText> : null}
    </Modal>
  );
}

/** Route 16 — the survivor themselves died. */
function DeceasedModal({
  contact,
  onClose,
  onDone,
}: { contact: ContactRow; onClose: () => void; onDone: () => void }): JSX.Element {
  const client = useApiClient();
  const [deceasedAt, setDeceasedAt] = useState("");
  const [deathSource, setDeathSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const { error: err } = await markContactDeceased(client, contact.contactId, contact.version, {
      deceasedAt: new Date(deceasedAt).toISOString(),
      deathSource,
    });
    setBusy(false);
    if (err) {
      setError(errorMessage(err, "This survivor could not be marked deceased."));
      return;
    }
    onDone();
  };

  return (
    <Modal
      title="Mark survivor deceased"
      onClose={onClose}
      footer={
        <button
          type="button"
          style={primaryButtonStyle}
          disabled={busy || !deceasedAt || deathSource.trim().length === 0}
          onClick={submit}
        >
          {busy ? "Recording…" : "Mark deceased"}
        </button>
      }
    >
      <Notice tone="warning">
        This is the only terminal state in the survivor lifecycle. A verified date and where the
        verification came from are both required.
      </Notice>
      <TextField
        label="Date of death"
        type="datetime-local"
        value={deceasedAt}
        onChange={setDeceasedAt}
      />
      <TextField
        label="Verification source"
        value={deathSource}
        onChange={setDeathSource}
        placeholder="e.g. family notification, obituary, state registry"
      />
      {error ? <ErrorText>{error}</ErrorText> : null}
    </Modal>
  );
}

/** Route 17 — accept the three-strikes proposal. */
function UnreachableModal({
  contact,
  onClose,
  onDone,
}: { contact: ContactRow; onClose: () => void; onDone: () => void }): JSX.Element {
  const client = useApiClient();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const { error: err } = await markContactUnreachable(
      client,
      contact.contactId,
      contact.version,
      {
        note: note || undefined,
      },
    );
    setBusy(false);
    if (err) {
      setError(
        errorMessage(
          err,
          "This survivor could not be marked unreachable. The three-strikes threshold is enforced by the lifecycle machine, so an early attempt is refused.",
        ),
      );
      return;
    }
    onDone();
  };

  return (
    <Modal
      title="Mark survivor unreachable"
      onClose={onClose}
      footer={
        <button type="button" style={primaryButtonStyle} disabled={busy} onClick={submit}>
          {busy ? "Recording…" : "Mark unreachable"}
        </button>
      }
    >
      <TextAreaField label="Note (optional)" value={note} onChange={setNote} />
      {error ? <ErrorText>{error}</ErrorText> : null}
    </Modal>
  );
}

/** Route 26 — an ad-hoc contact-log row for a touchpoint that never had a scheduled outreach. */
function LogDirectModal({
  contact,
  onClose,
  onDone,
}: { contact: ContactRow; onClose: () => void; onDone: () => void }): JSX.Element {
  const client = useApiClient();
  const [kind, setKind] = useState(DEFAULT_NON_ENCOUNTER_KIND);
  const [outcome, setOutcome] = useState(DEFAULT_LOG_OUTCOME);
  const [contactAt, setContactAt] = useState("");
  const [responded, setResponded] = useState(true);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    // `kind`/`outcome` are always one of the closed vocabularies the SelectFields below offer.
    const { error: err } = await logDirectContact(client, contact.contactId, {
      kind: kind as BereavementLogKind,
      outcome: outcome as BereavementLogOutcome,
      contactAt: contactAt ? new Date(contactAt).toISOString() : new Date().toISOString(),
      contactResponded: responded,
      notes: notes || undefined,
    });
    setBusy(false);
    if (err) {
      setError(errorMessage(err, "The contact log could not be recorded."));
      return;
    }
    onDone();
  };

  return (
    <Modal
      title="Log an ad-hoc contact"
      onClose={onClose}
      footer={
        <button type="button" style={primaryButtonStyle} disabled={busy} onClick={submit}>
          {busy ? "Logging…" : "Log contact"}
        </button>
      }
    >
      <Notice tone="info">
        An ad-hoc kind must be one this survivor allows — stricter than the scheduled book, because
        a counselor making an extra call has no regulatory obligation that overrides the family's
        wishes. An in-person visit is not offered here: that is an M8 encounter, completed from the
        outreach planner.
      </Notice>
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
      <TextAreaField label="Counselor note" value={notes} onChange={setNotes} />
      {error ? <ErrorText>{error}</ErrorText> : null}
    </Modal>
  );
}

/** Route 12 — the channel edit. `If-Match` is required: a blind overwrite could send a condolence letter
 *  to an address the family already corrected. */
function ChannelsModal({
  contact,
  onClose,
  onDone,
}: { contact: ContactRow; onClose: () => void; onDone: () => void }): JSX.Element {
  const client = useApiClient();
  const [allowed, setAllowed] = useState<string[]>([...contact.allowedOutreachKinds]);
  const [language, setLanguage] = useState(contact.preferredLanguageIso639);
  const [volunteerVisibleOnly, setVolunteerVisibleOnly] = useState(contact.volunteerVisibleOnly);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (k: string) =>
    setAllowed(allowed.includes(k) ? allowed.filter((x) => x !== k) : [...allowed, k]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const { error: err } = await updateContact(client, contact.contactId, contact.version, {
      preferredLanguageIso639: language,
      // `allowed` is always drawn from the closed vocabulary the checkbox list below offers.
      outreachPreferences: { allowedKinds: allowed as BereavementOutreachKind[] },
      volunteerVisibleOnly,
    });
    setBusy(false);
    if (err) {
      setError(errorMessage(err, "The outreach preferences could not be updated."));
      return;
    }
    onDone();
  };

  return (
    <Modal
      title="Outreach preferences"
      onClose={onClose}
      footer={
        <button type="button" style={primaryButtonStyle} disabled={busy} onClick={submit}>
          {busy ? "Saving…" : "Save"}
        </button>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
        <span style={{ fontSize: "0.7rem", color: t.onSurfaceVariant }}>Allowed channels</span>
        {OUTREACH_KINDS.map((k) => (
          <CheckboxField
            key={k}
            label={outreachKindLabel(k)}
            checked={allowed.includes(k)}
            onChange={() => toggle(k)}
          />
        ))}
      </div>
      <TextField label="Preferred language (ISO 639)" value={language} onChange={setLanguage} />
      <CheckboxField
        label="Volunteer-visible only"
        checked={volunteerVisibleOnly}
        onChange={setVolunteerVisibleOnly}
      />
      {error ? <ErrorText>{error}</ErrorText> : null}
    </Modal>
  );
}
