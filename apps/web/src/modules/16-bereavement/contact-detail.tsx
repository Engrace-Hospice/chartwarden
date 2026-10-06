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
import { EmptyState, LoadingSpinner, PageHeader, StatusPill, t, useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Link, useParams } from "react-router-dom";
import {
  type BereavementLogKind,
  type BereavementLogOutcome,
  type BereavementOptOutKind,
  type BereavementOutreachKind,
  type ContactRow,
  type PlanDetail,
  confirmContact,
  dismissUnreachableProposal,
  errorMessage,
  getPlan,
  logDirectContact,
  markContactDeceased,
  markContactUnreachable,
  optOutContact,
  rescindOptOut,
  updateContact,
} from "./bereavement-api";
import {
  CONTACT_STATUS_TONE,
  DEFAULT_LOG_OUTCOME,
  DEFAULT_NON_ENCOUNTER_KIND,
  DEFAULT_OPT_OUT_KIND,
  LOG_OUTCOMES,
  NON_ENCOUNTER_OUTREACH_KINDS,
  OPT_OUT_KINDS,
  OUTREACH_KINDS,
  dateTime,
  humanize,
  outreachKindLabel,
  shortId,
  toneOf,
} from "./bereavement-status";
import {
  Card,
  CheckboxField,
  Field,
  Modal,
  Notice,
  RiskTierPill,
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
  const client = useApiClient();
  const { planId, contactId } = useParams<{ planId: string; contactId: string }>();
  const [plan, setPlan] = useState<PlanDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ceremony, setCeremony] = useState<Ceremony>(null);
  const [keepTryingBusy, setKeepTryingBusy] = useState(false);
  const [keepTryingError, setKeepTryingError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!planId) return;
    setLoading(true);
    setError(null);
    const { plan: p, error: err } = await getPlan(client, planId);
    if (err) {
      setError(errorMessage(err, "This bereavement plan could not be loaded."));
      setLoading(false);
      return;
    }
    setPlan(p);
    setLoading(false);
  }, [client, planId]);

  useEffect(() => {
    void load();
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

  const refresh = () => {
    setCeremony(null);
    void load();
  };

  const keepTrying = async () => {
    setKeepTryingBusy(true);
    setKeepTryingError(null);
    const { error: err } = await dismissUnreachableProposal(
      client,
      contact.contactId,
      contact.version,
    );
    setKeepTryingBusy(false);
    if (err) {
      setKeepTryingError(
        errorMessage(err, "The unreachable proposal could not be dismissed. Reload and try again."),
      );
      return;
    }
    void load();
  };

  return (
    <div className="wx-kit-column" style={columnStyle}>
      <PageHeader
        title={<span style={pageTitleStyle}>{contact.displayName}</span>}
        breadcrumb={`Bereavement — plan ${shortId(planId)} · bereaved contact`}
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
          {keepTryingError ? <p style={alertStyle}>{keepTryingError}</p> : null}
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
      {error ? <p style={alertStyle}>{error}</p> : null}
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

  return (
    <Modal
      title="Record opt-out"
      onClose={onClose}
      footer={
        <button
          type="button"
          style={primaryButtonStyle}
          disabled={busy || (optOutKind === "channel_specific" && channelKinds.length === 0)}
          onClick={submit}
        >
          {busy ? "Recording…" : "Record opt-out"}
        </button>
      }
    >
      <Notice tone="info">
        A full opt-out cancels every future touchpoint for this survivor, and closes the plan if it
        was the last enrollee. A self-service opt-out may be rescinded for 90 days; a counselor
        rescind with a documented reason is not bound by that window.
      </Notice>
      <SelectField
        label="Scope"
        value={optOutKind}
        options={OPT_OUT_KINDS.map((k) => ({ value: k, label: humanize(k) }))}
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
      {error ? <p style={alertStyle}>{error}</p> : null}
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
      {error ? <p style={alertStyle}>{error}</p> : null}
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
      {error ? <p style={alertStyle}>{error}</p> : null}
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
      {error ? <p style={alertStyle}>{error}</p> : null}
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
      {error ? <p style={alertStyle}>{error}</p> : null}
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
      {error ? <p style={alertStyle}>{error}</p> : null}
    </Modal>
  );
}
