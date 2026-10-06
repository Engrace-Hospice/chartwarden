// apps/web/src/modules/16-bereavement — the PLAN DETAIL (§5.1 #3, Track B / ADR-0030), carrying the
// §5.1 #8 add-contact modal and the §5.1 #16 close-plan modal. Spec: docs/design/screens/clinical —
// "Use Record Detail."
//
// The plan header (decedent, death date, anniversary countdown), the bereaved-contact roster, the risk
// rollup, the pause/resume/close lifecycle and the D18-gated first-contact button.
//
// D18 IS THE POINT OF THIS SCREEN. `firstContactAllowed` / `firstContactGateReason` come from the SERVER
// (§4.3.2): the button is disabled and the banner names the exact gate. The disable is a courtesy, not the
// control — the service refuses first contact on a pending external-source plan regardless of role or
// ABAC grant, and its 409 carries the machine-readable reason this screen renders. A UI that merely hid
// the button would leave the gate invisible when the refusal did fire.
//
// The §5.1 modals live here rather than as registry entries because each needs the plan `version` this
// screen already read for its `If-Match`.
import { EmptyState, LoadingSpinner, PageHeader, StatusPill, t, useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Link, useParams } from "react-router-dom";
import { useSession } from "../../shell/session";
import {
  type BereavementCloseEarlyReason,
  type BereavementInitiateContactKind,
  type BereavementPauseKind,
  type BereavementRelationshipCode,
  type ContactDraft,
  type PlanDetail,
  closeEarly,
  cosignClose,
  createContact,
  errorMessage,
  getPlan,
  initiateContact,
  pausePlan,
  resumePlan,
} from "./bereavement-api";
import {
  CONTACT_STATUS_TONE,
  DEFAULT_EARLY_CLOSE_REASON,
  DEFAULT_PAUSE_KIND,
  EARLY_CLOSE_REASONS,
  OUTREACH_KINDS,
  PAUSE_KINDS,
  PLAN_STATUS_TONE,
  RELATIONSHIP_CODES,
  anniversaryCountdown,
  dateTime,
  firstContactGateLabel,
  humanize,
  outreachKindLabel,
  redactionLabel,
  shortDate,
  shortId,
  toneOf,
} from "./bereavement-status";
import {
  Card,
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
  disabledButtonStyle,
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

type Ceremony = "add-contact" | "pause" | "close" | "cosign" | "first-contact" | null;

export function BereavementPlanDetail(): JSX.Element {
  const client = useApiClient();
  const { planId } = useParams<{ planId: string }>();
  const [plan, setPlan] = useState<PlanDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ceremony, setCeremony] = useState<Ceremony>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const session = useSession();

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
  if (!plan || !planId)
    return (
      <EmptyState
        title="Not found"
        description="This bereavement plan does not exist, or is not on your caseload."
      />
    );

  const countdown = anniversaryCountdown(plan.deathDate);
  const redaction = redactionLabel(plan.redactedCategories);
  const closed = plan.status.startsWith("closed_");
  // GAP-047: a pending request is the plan's awaiting-cosign state. The requester may not cosign it
  // (server: 403 EARLY_CLOSE_SELF_COSIGN) — hiding the button is a courtesy, the server is the control.
  const earlyCloseRequest = closed ? null : (plan.earlyCloseRequest ?? null);
  const canCosign =
    earlyCloseRequest !== null &&
    session !== null &&
    session.userId !== earlyCloseRequest.requestedByUserId;

  const doResume = async () => {
    setBusy(true);
    setActionError(null);
    const { error: err } = await resumePlan(client, planId, plan.version);
    setBusy(false);
    if (err) {
      setActionError(errorMessage(err, "The plan could not be resumed."));
      return;
    }
    void load();
  };

  return (
    <div className="wx-kit-column" style={columnStyle}>
      <PageHeader
        title={<span style={pageTitleStyle}>Bereavement plan {shortId(plan.planId)}</span>}
        breadcrumb="Bereavement — plan detail"
        actions={
          <div style={{ display: "flex", gap: t.space2, flexWrap: "wrap" }}>
            <Link to={`/bereavement/plans/${planId}/outreach`} style={ghostButtonStyle}>
              Outreach planner
            </Link>
            <Link to={`/bereavement/plans/${planId}/risk`} style={ghostButtonStyle}>
              Risk scores
            </Link>
            <Link to={`/bereavement/plans/${planId}/history`} style={ghostButtonStyle}>
              History
            </Link>
          </div>
        }
      />

      {!plan.firstContactAllowed && plan.firstContactGateReason ? (
        <Notice tone="error">{firstContactGateLabel(plan.firstContactGateReason)}</Notice>
      ) : null}

      {countdown ? (
        <Notice tone="warning" live>
          Anniversary of death is in {countdown.days} {countdown.days === 1 ? "day" : "days"} (
          {countdown.mark}-day mark).{" "}
          <Link to={`/bereavement/plans/${planId}/outreach`} style={linkStyle}>
            Schedule the anniversary contact
          </Link>
        </Notice>
      ) : null}

      {redaction ? <Notice tone="info">{redaction}</Notice> : null}

      {plan.legalHoldId ? (
        <Notice tone="warning">
          A legal hold ({shortId(plan.legalHoldId)}) is in force on this plan. The 13-month window
          does not close it while the hold stands.
        </Notice>
      ) : null}

      {earlyCloseRequest ? (
        <Notice tone="warning" live>
          Pending supervisor cosign — an early close ({humanize(earlyCloseRequest.reason)}) was
          requested {dateTime(earlyCloseRequest.requestedAt)} by{" "}
          {shortId(earlyCloseRequest.requestedByUserId)}. The plan stays active until a different
          clinical supervisor cosigns.
        </Notice>
      ) : null}

      {actionError ? <p style={alertStyle}>{actionError}</p> : null}

      <Card
        title="Plan"
        actions={
          <StatusPill label={humanize(plan.status)} tone={toneOf(PLAN_STATUS_TONE, plan.status)} />
        }
      >
        <SummaryGrid>
          <Field label="Patient (decedent)" value={shortId(plan.patientId)} mono />
          <Field label="Admission" value={shortId(plan.admissionId)} mono />
          <Field label="Death date" value={shortDate(plan.deathDate)} />
          <Field label="Death time" value={dateTime(plan.deathTime)} />
          <Field label="Window ends" value={shortDate(plan.windowEndsAt)} />
          <Field label="Opened" value={dateTime(plan.openedAt)} />
          <Field label="Counselor" value={shortId(plan.assignedCounselorUserId)} mono />
          <Field label="Volunteer" value={shortId(plan.assignedVolunteerUserId)} mono />
          <Field label="Risk tier" value={<RiskTierPill tier={plan.currentRiskTier} />} />
          <Field label="Risk computed" value={dateTime(plan.currentRiskComputedAt ?? null)} />
          <Field label="Provider entity" value={shortId(plan.providerEntityId)} mono />
          <Field label="Version" value={plan.version} />
        </SummaryGrid>
        {plan.pausedAt ? (
          <Notice tone="warning">
            Paused {dateTime(plan.pausedAt)} ({humanize(plan.pauseKind)}). Resuming regenerates the
            schedule FROM NOW — a touchpoint whose due date passed during the pause is not
            resurrected as a backdated obligation.
          </Notice>
        ) : null}
        {plan.closedAt ? (
          <Notice tone="info">
            Closed {dateTime(plan.closedAt)}.{" "}
            <Link to={`/bereavement/plans/${planId}/closeout`} style={linkStyle}>
              Open the closeout record
            </Link>
          </Notice>
        ) : null}
      </Card>

      {plan.externalSource ? (
        <Card title="External source (HL7 ADT)">
          <SummaryGrid>
            <Field
              label="Source facility"
              value={String(plan.externalSource.sourceFacilityName ?? "—")}
            />
            <Field
              label="Source message"
              value={String(plan.externalSource.sourceMessageId ?? "—")}
            />
            <Field
              label="Acknowledged"
              value={dateTime(String(plan.externalSource.ackReceivedAt ?? "") || null)}
            />
            <Field
              label="Cosign status"
              value={humanize(String(plan.externalSource.cosignStatus ?? ""))}
            />
            <Field
              label="Cosigned"
              value={dateTime(String(plan.externalSource.cosignedAt ?? "") || null)}
            />
          </SummaryGrid>
        </Card>
      ) : null}

      <Card
        title="Actions"
        actions={
          <span style={mutedStyle}>
            Every action carries the plan version read above (`If-Match`).
          </span>
        }
      >
        <div style={{ display: "flex", gap: t.space2, flexWrap: "wrap" }}>
          {plan.firstContactAllowed ? (
            <button
              type="button"
              style={primaryButtonStyle}
              onClick={() => setCeremony("first-contact")}
            >
              Counselor first contact
            </button>
          ) : (
            <button
              type="button"
              style={disabledButtonStyle}
              disabled
              title={firstContactGateLabel(plan.firstContactGateReason)}
            >
              Counselor first contact (gated)
            </button>
          )}
          {plan.status === "initiating" ? (
            <Link to={`/bereavement/plans/${planId}/seed`} style={ghostButtonStyle}>
              Seed roster + schedule
            </Link>
          ) : null}
          <button
            type="button"
            style={ghostButtonStyle}
            onClick={() => setCeremony("add-contact")}
            disabled={closed}
          >
            Add bereaved contact
          </button>
          {plan.status === "active" ? (
            <button type="button" style={ghostButtonStyle} onClick={() => setCeremony("pause")}>
              Pause
            </button>
          ) : null}
          {plan.status === "paused" ? (
            <button type="button" style={ghostButtonStyle} disabled={busy} onClick={doResume}>
              {busy ? "Resuming…" : "Resume"}
            </button>
          ) : null}
          {!closed && !earlyCloseRequest ? (
            <button type="button" style={ghostButtonStyle} onClick={() => setCeremony("close")}>
              Close early
            </button>
          ) : null}
          {canCosign ? (
            <button type="button" style={ghostButtonStyle} onClick={() => setCeremony("cosign")}>
              Cosign the early close
            </button>
          ) : null}
        </div>
      </Card>

      <Card
        title="Bereaved contacts"
        actions={
          <span style={mutedStyle}>
            {plan.stats.contactsActiveCount} active · {plan.stats.contactsOptedOutCount} opted out
          </span>
        }
      >
        {plan.contacts.length === 0 ? (
          <span style={mutedStyle}>
            No survivors are on the roster yet. Seed the roster from the patient's caregivers to
            open the program.
          </span>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={th}>Name</th>
                <th style={th}>Relationship</th>
                <th style={th}>Status</th>
                <th style={th}>Risk</th>
                <th style={th}>Channels</th>
                <th style={th}>Portal</th>
                <th style={th} />
              </tr>
            </thead>
            <tbody>
              {plan.contacts.map((c) => (
                <tr key={c.contactId} style={rowLine}>
                  <td style={td}>{c.displayName}</td>
                  <td style={td}>{humanize(c.relationshipCode)}</td>
                  <td style={td}>
                    <StatusPill
                      label={humanize(c.status)}
                      tone={toneOf(CONTACT_STATUS_TONE, c.status)}
                    />
                    {c.unreachableProposed ? (
                      <div style={mutedStyle}>unreachable proposed · 3 no-response attempts</div>
                    ) : null}
                    {c.optedOutAt ? (
                      <div style={mutedStyle}>
                        opted out {shortDate(c.optedOutAt)}
                        {c.mayRescindOptOut ? " · rescind window open" : ""}
                      </div>
                    ) : null}
                  </td>
                  <td style={td}>
                    <RiskTierPill tier={c.currentRiskTier} />
                  </td>
                  <td style={td}>
                    {c.allowedOutreachKinds.length === 0
                      ? "—"
                      : c.allowedOutreachKinds.map(outreachKindLabel).join(", ")}
                  </td>
                  <td style={td}>{c.portalAccountId ? "linked" : "—"}</td>
                  <td style={td}>
                    <Link
                      to={`/bereavement/plans/${planId}/contacts/${c.contactId}`}
                      style={linkStyle}
                    >
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="Touchpoints">
        <SummaryGrid>
          <Field label="Completed" value={plan.stats.completedCount} />
          <Field label="Missed" value={plan.stats.missedCount} />
        </SummaryGrid>
        <Link to={`/bereavement/plans/${planId}/outreach`} style={linkStyle}>
          Open the outreach planner
        </Link>
      </Card>

      {ceremony === "add-contact" ? (
        <AddContactModal
          planId={planId}
          onClose={() => setCeremony(null)}
          onDone={() => {
            setCeremony(null);
            void load();
          }}
        />
      ) : null}
      {ceremony === "pause" ? (
        <PauseModal
          planId={planId}
          version={plan.version}
          onClose={() => setCeremony(null)}
          onDone={() => {
            setCeremony(null);
            void load();
          }}
        />
      ) : null}
      {ceremony === "close" ? (
        <CloseModal
          planId={planId}
          version={plan.version}
          onClose={() => setCeremony(null)}
          onDone={() => {
            setCeremony(null);
            void load();
          }}
        />
      ) : null}
      {ceremony === "cosign" ? (
        <CosignModal
          planId={planId}
          version={plan.version}
          onClose={() => setCeremony(null)}
          onDone={() => {
            setCeremony(null);
            void load();
          }}
        />
      ) : null}
      {ceremony === "first-contact" ? (
        <FirstContactModal
          planId={planId}
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

/** §5.1 #8 — custom bereaved-contact entry. Lands `proposed`; the contact detail confirms it, which is
 *  where the M39 consent verdict is resolved (D6 fail-CLOSED). */
function AddContactModal({
  planId,
  onClose,
  onDone,
}: { planId: string; onClose: () => void; onDone: () => void }): JSX.Element {
  const client = useApiClient();
  const [draft, setDraft] = useState<ContactDraft>({ displayName: "", relationshipCode: "friend" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const { error: err } = await createContact(client, planId, {
      ...draft,
      email: draft.email || undefined,
      phone: draft.phone || undefined,
      mailingAddress: draft.mailingAddress || undefined,
    });
    setBusy(false);
    if (err) {
      setError(errorMessage(err, "The bereaved contact could not be added."));
      return;
    }
    onDone();
  };

  return (
    <Modal
      title="Add bereaved contact"
      onClose={onClose}
      footer={
        <button
          type="button"
          style={primaryButtonStyle}
          disabled={busy || draft.displayName.trim().length === 0}
          onClick={submit}
        >
          {busy ? "Adding…" : "Add contact"}
        </button>
      }
    >
      <TextField
        label="Display name"
        value={draft.displayName}
        onChange={(v) => setDraft({ ...draft, displayName: v })}
      />
      <SelectField
        label="Relationship to the decedent"
        value={draft.relationshipCode}
        options={RELATIONSHIP_CODES.map((c) => ({ value: c, label: humanize(c) }))}
        onChange={(v) => setDraft({ ...draft, relationshipCode: v as BereavementRelationshipCode })}
      />
      <TextField
        label="Email (optional)"
        type="email"
        value={draft.email ?? ""}
        onChange={(v) => setDraft({ ...draft, email: v })}
      />
      <TextField
        label="Phone (optional)"
        type="tel"
        value={draft.phone ?? ""}
        onChange={(v) => setDraft({ ...draft, phone: v })}
      />
      <TextField
        label="Mailing address (optional)"
        value={draft.mailingAddress ?? ""}
        onChange={(v) => setDraft({ ...draft, mailingAddress: v })}
      />
      <TextField
        label="Consent record id (M39, optional)"
        value={draft.consentRecordId ?? ""}
        onChange={(v) => setDraft({ ...draft, consentRecordId: v || undefined })}
      />
      <Notice tone="info">
        The contact lands in `proposed`. Confirming it — on the contact's own screen — is where the
        M39 bereavement-outreach consent verdict is resolved server-side, and it fails CLOSED: an
        unconsented condolence call to a grieving family is the harm the rule exists to prevent.
      </Notice>
      {error ? <p style={alertStyle}>{error}</p> : null}
    </Modal>
  );
}

/** Route 6 — pause. §2.2 requires a recorded reason; a pause without one is a lapse, not a pause. */
function PauseModal({
  planId,
  version,
  onClose,
  onDone,
}: { planId: string; version: number; onClose: () => void; onDone: () => void }): JSX.Element {
  const client = useApiClient();
  const [pauseKind, setPauseKind] = useState(DEFAULT_PAUSE_KIND);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    // `pauseKind` is always one of the closed vocabulary the SelectField below offers.
    const { error: err } = await pausePlan(client, planId, version, {
      pauseKind: pauseKind as BereavementPauseKind,
      reason,
    });
    setBusy(false);
    if (err) {
      setError(errorMessage(err, "The plan could not be paused."));
      return;
    }
    onDone();
  };

  return (
    <Modal
      title="Pause bereavement plan"
      onClose={onClose}
      footer={
        <button
          type="button"
          style={primaryButtonStyle}
          disabled={busy || reason.trim().length === 0}
          onClick={submit}
        >
          {busy ? "Pausing…" : "Pause"}
        </button>
      }
    >
      <SelectField
        label="Pause kind"
        value={pauseKind}
        options={PAUSE_KINDS.map((k) => ({ value: k, label: humanize(k) }))}
        onChange={setPauseKind}
      />
      <TextAreaField
        label="Reason"
        value={reason}
        onChange={setReason}
        hint="Pausing cancels every future-dated touchpoint. The reason is recorded on the plan."
      />
      {error ? <p style={alertStyle}>{error}</p> : null}
    </Modal>
  );
}

/** §5.1 #16 — the early-close REQUEST ceremony (route 8; GAP-047 — records a pending request only). Step-up auth is enforced by the server; a ≥40-char
 *  narrative is enforced by the route schema AND by a DB CHECK, so the counter here is honest. */
function CloseModal({
  planId,
  version,
  onClose,
  onDone,
}: { planId: string; version: number; onClose: () => void; onDone: () => void }): JSX.Element {
  const client = useApiClient();
  const [reason, setReason] = useState(DEFAULT_EARLY_CLOSE_REASON);
  const [narrative, setNarrative] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    // `reason` is always one of the closed vocabulary the SelectField below offers.
    const { error: err } = await closeEarly(client, planId, version, {
      reason: reason as BereavementCloseEarlyReason,
      narrative,
    });
    setBusy(false);
    if (err) {
      setError(errorMessage(err, "The early close could not be requested."));
      return;
    }
    onDone();
  };

  return (
    <Modal
      title="Close bereavement plan early"
      onClose={onClose}
      footer={
        <button
          type="button"
          style={primaryButtonStyle}
          disabled={busy || narrative.trim().length < 40}
          onClick={submit}
        >
          {busy ? "Requesting…" : "Request early close"}
        </button>
      }
    >
      <Notice tone="warning">
        An early close cuts a regulatory 13-month obligation short. This records a request only — it
        does not close the plan. It requires step-up authentication and a documented narrative, and
        stays pending until a different clinical supervisor cosigns it.
      </Notice>
      <SelectField
        label="Reason"
        value={reason}
        options={EARLY_CLOSE_REASONS.map((r) => ({ value: r, label: humanize(r) }))}
        onChange={setReason}
      />
      <TextAreaField
        label="Narrative"
        value={narrative}
        onChange={setNarrative}
        rows={5}
        hint={`${narrative.trim().length} / 40 characters minimum.`}
      />
      {error ? <p style={alertStyle}>{error}</p> : null}
    </Modal>
  );
}

/** Route 9 — the clinical-supervisor cosign that ratifies the early close. */
function CosignModal({
  planId,
  version,
  onClose,
  onDone,
}: { planId: string; version: number; onClose: () => void; onDone: () => void }): JSX.Element {
  const client = useApiClient();
  const [attestation, setAttestation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const { error: err } = await cosignClose(client, planId, version, {
      attestation: attestation || undefined,
    });
    setBusy(false);
    if (err) {
      setError(errorMessage(err, "The early close could not be cosigned."));
      return;
    }
    onDone();
  };

  return (
    <Modal
      title="Cosign the early close"
      onClose={onClose}
      footer={
        <button type="button" style={primaryButtonStyle} disabled={busy} onClick={submit}>
          {busy ? "Cosigning…" : "Cosign"}
        </button>
      }
    >
      <Notice tone="warning">
        Cosigning is a step-up action attributed to you. The cosigner is the server-assembled acting
        membership — it is never taken from this form.
      </Notice>
      <TextAreaField label="Attestation (optional)" value={attestation} onChange={setAttestation} />
      {error ? <p style={alertStyle}>{error}</p> : null}
    </Modal>
  );
}

/** Route 33 — the D18-gated counselor first contact. A refusal renders the SERVER's reason verbatim. */
function FirstContactModal({
  planId,
  contacts,
  onClose,
  onDone,
}: {
  planId: string;
  contacts: { id: string; name: string }[];
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  const client = useApiClient();
  const [contactId, setContactId] = useState(contacts[0]?.id ?? "");
  const [kind, setKind] = useState("phone_call");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    // `kind` is always one of the closed vocabulary the SelectField below offers.
    const { error: err } = await initiateContact(client, planId, {
      contactId,
      kind: kind as BereavementInitiateContactKind,
    });
    setBusy(false);
    if (err) {
      setError(errorMessage(err, "First contact was refused."));
      return;
    }
    onDone();
  };

  return (
    <Modal
      title="Counselor first contact"
      onClose={onClose}
      footer={
        <button
          type="button"
          style={primaryButtonStyle}
          disabled={busy || !contactId}
          onClick={submit}
        >
          {busy ? "Opening…" : "Open first contact"}
        </button>
      }
    >
      {contacts.length === 0 ? (
        <Notice tone="warning">
          This plan has no bereaved contacts yet. Seed the roster before opening first contact.
        </Notice>
      ) : (
        <>
          <SelectField
            label="Contact"
            value={contactId}
            options={contacts.map((c) => ({ value: c.id, label: c.name }))}
            onChange={setContactId}
          />
          <SelectField
            label="Modality"
            value={kind}
            options={OUTREACH_KINDS.map((k) => ({ value: k, label: outreachKindLabel(k) }))}
            onChange={setKind}
          />
        </>
      )}
      {error ? <p style={alertStyle}>{error}</p> : null}
    </Modal>
  );
}
