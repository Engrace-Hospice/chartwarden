import {
  CeremonyModal,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  PatientBanner,
  PatientWorkspaceLayout,
  cardSurface,
  t,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/39-consent — M39 CONSENT CAPTURE AND SIGNATURE (report 09 mini-spec #1,
// FLOW-003, WX-PR-010). Route `/patients/:patientId/consents/new`.
//
// Draft → (recipients/DPOA, when the type requires them) → sign, over the real WX-PR-009 Drizzle
// lifecycle (draft create/edit, add-recipient, add-DPOA-agent, sign) — every write here is a live
// transactional call, not a stub. `electronic_portal_signature` is intentionally not offered here;
// see consent-evidence-fields.tsx for why. A single-column form (accessibility §5.4: no hidden
// terms on small screens) ending in a `CeremonyModal` attestation for the irreversible sign act —
// same posture as M6 admission-detail's Activate ceremony: data entry is a plain form, the
// signature itself is a ceremony.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  CaptureEvidenceFields,
  STAFF_CAPTURE_METHODS,
  type StaffCaptureMethod,
  emptyEvidence,
  evidencePayload,
  isEvidenceComplete,
} from "./consent-evidence-fields";
import { authFailureRedirect } from "./write-workflow";

/**
 * Catalog types a STAFF member cannot capture. `portal_access`'s `captureMethodFloor` is only
 * `electronic_portal_signature` — the patient's own portal e-signature — while every method this form
 * offers (`STAFF_CAPTURE_METHODS`) is outside it, so the server refuses the draft with a 422 whichever
 * method is picked. The catalog is in enum order and `portal_access` is the FIRST row, so without this
 * filter the form opened on a type that could never be created ("Validation failed" on a pristine form).
 */
const PATIENT_SELF_SERVICE_TYPE_KEYS: ReadonlySet<string> = new Set(["portal_access"]);

const GRANTOR_KINDS = [
  { value: "patient_self", label: "Patient (self)" },
  { value: "dpoa_healthcare_agent", label: "DPOA — healthcare agent" },
  { value: "dpoa_financial_agent", label: "DPOA — financial agent" },
  { value: "court_guardian", label: "Court-appointed guardian" },
  { value: "parent_for_minor", label: "Parent (for a minor)" },
  { value: "healthcare_surrogate", label: "Healthcare surrogate" },
] as const;
type GrantorKind = (typeof GRANTOR_KINDS)[number]["value"];

const RECIPIENT_KINDS = [
  { value: "external_physician", label: "External physician" },
  { value: "facility", label: "Facility" },
  { value: "pharmacy", label: "Pharmacy" },
  { value: "irb", label: "IRB" },
  { value: "family_member", label: "Family member" },
  { value: "attorney", label: "Attorney" },
  { value: "employer", label: "Employer" },
  { value: "researcher", label: "Researcher" },
  { value: "free_text", label: "Other (free text)" },
] as const;

const DPOA_AGENT_KINDS = [
  { value: "primary", label: "Primary" },
  { value: "alternate_1", label: "Alternate 1" },
  { value: "alternate_2", label: "Alternate 2" },
] as const;
const DPOA_SCOPE_KINDS = [
  { value: "healthcare_full", label: "Healthcare — full" },
  { value: "healthcare_end_of_life_only", label: "Healthcare — end-of-life only" },
  { value: "financial_narrow", label: "Financial — narrow" },
  { value: "financial_broad", label: "Financial — broad" },
] as const;
const DPOA_ACTIVATIONS = [
  { value: "immediate", label: "Immediate" },
  { value: "upon_incapacity_attested", label: "Upon incapacity (attested)" },
  { value: "upon_physician_determination", label: "Upon physician determination" },
  { value: "upon_incompetence_court_order", label: "Upon incompetence (court order)" },
] as const;
const DPOA_TERM_KINDS = [
  { value: "indefinite", label: "Indefinite" },
  { value: "until_date", label: "Until a date" },
  { value: "event_driven", label: "Event-driven" },
] as const;

interface CatalogRow {
  typeKey: string;
  displayNameEn: string;
  scopeDiscriminator: string;
  isPerRecipient: boolean;
}
interface ConsentDraft {
  id: string;
  status: string;
  typeKey: string;
}
interface RecipientRow {
  id: string;
  recipientDisplayName: string;
  recipientKind: string;
  active: boolean;
}
interface AgentRow {
  id: string;
  agentName: string;
  agentKind: string;
  active: boolean;
}
interface PatientSummary {
  mrn: string;
  lastName: string;
  firstName: string;
  dob: string;
  status: string;
}

export function ConsentCapture(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const { patientId } = useParams<{ patientId: string }>();

  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [catalog, setCatalog] = useState<CatalogRow[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  const [typeKey, setTypeKey] = useState("");
  const [grantorKind, setGrantorKind] = useState<GrantorKind>("patient_self");
  const [captureMethod, setCaptureMethod] = useState<StaffCaptureMethod>("typed_signature_in_app");
  const [scopeDescription, setScopeDescription] = useState("");
  const [effectiveAt, setEffectiveAt] = useState(() => new Date().toISOString().slice(0, 10));
  const [expiresAt, setExpiresAt] = useState("");

  const [draft, setDraft] = useState<ConsentDraft | null>(null);
  const [draftBusy, setDraftBusy] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);

  const [recipients, setRecipients] = useState<RecipientRow[]>([]);
  const [recipientKind, setRecipientKind] = useState<string>(RECIPIENT_KINDS[0].value);
  const [recipientName, setRecipientName] = useState("");
  const [recipientBusy, setRecipientBusy] = useState(false);
  const [recipientError, setRecipientError] = useState<string | null>(null);

  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [agentKind, setAgentKind] = useState<string>(DPOA_AGENT_KINDS[0].value);
  const [agentName, setAgentName] = useState("");
  const [agentRelationship, setAgentRelationship] = useState("");
  const [agentScopeKind, setAgentScopeKind] = useState<string>(DPOA_SCOPE_KINDS[0].value);
  const [agentActivation, setAgentActivation] = useState<string>(DPOA_ACTIVATIONS[0].value);
  const [agentTermKind, setAgentTermKind] = useState<string>(DPOA_TERM_KINDS[0].value);
  const [agentTermUntil, setAgentTermUntil] = useState("");
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentError, setAgentError] = useState<string | null>(null);

  const [evidence, setEvidence] = useState(emptyEvidence());
  const [ceremonyOpen, setCeremonyOpen] = useState(false);
  const [signBusy, setSignBusy] = useState(false);
  const [signError, setSignError] = useState<string | null>(null);

  useEffect(() => {
    if (!patientId) return;
    let active = true;
    void (async () => {
      setCatalogLoading(true);
      const [pRes, cRes] = await Promise.all([
        client.GET("/api/v1/patients/{id}", { params: { path: { id: patientId } } }),
        client.GET("/api/v1/consent-types", {}),
      ]);
      if (!active) return;
      if (pRes.data) setPatient(pRes.data as PatientSummary);
      if (cRes.error) setCatalogError("Could not load the consent-type catalog.");
      else {
        const rows = ((cRes.data?.data ?? []) as CatalogRow[]).filter(
          (r) => !PATIENT_SELF_SERVICE_TYPE_KEYS.has(r.typeKey),
        );
        setCatalog(rows);
        if (rows[0]) setTypeKey(rows[0].typeKey);
      }
      setCatalogLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [client, patientId]);

  const selected = useMemo(() => catalog.find((c) => c.typeKey === typeKey), [catalog, typeKey]);
  const needsRecipient = selected?.scopeDiscriminator === "per_recipient";
  const needsAgent = selected?.scopeDiscriminator === "per_named_agent";
  const activeRecipientCount = recipients.filter((r) => r.active).length;
  const activePrimaryAgent = agents.find((a) => a.active && a.agentKind === "primary");

  const branch = useCallback(
    (
      status: number | undefined,
      code: string | undefined,
      fallback: string,
      setErr: (m: string | null) => void,
    ): boolean => {
      const redirect = authFailureRedirect(status, code, window.location.pathname);
      if (redirect) {
        navigate(redirect);
        return true;
      }
      if (status === 409) setErr("This consent changed since you loaded it — reload to retry.");
      else if (status === 403) setErr("You do not have permission for this action.");
      else if (status === 422) setErr("Validation failed — check the values you entered.");
      else setErr(fallback);
      return false;
    },
    [navigate],
  );

  const createDraft = useCallback(async () => {
    if (!patientId || !typeKey) return;
    setDraftBusy(true);
    setDraftError(null);
    const {
      data,
      error: err,
      response,
    } = await client.POST("/api/v1/patients/{patientId}/consents", {
      params: { path: { patientId } },
      body: {
        typeKey: typeKey as never,
        grantorKind,
        captureMethod,
        scopeDescriptor: scopeDescription.trim() ? { description: scopeDescription.trim() } : {},
        effectiveAt: new Date(effectiveAt).toISOString(),
        ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
      },
    });
    setDraftBusy(false);
    if (err || !data) {
      branch(response?.status, err?.error?.code, "The draft could not be created.", setDraftError);
      return;
    }
    setDraft(data.data as ConsentDraft);
  }, [
    patientId,
    typeKey,
    grantorKind,
    captureMethod,
    scopeDescription,
    effectiveAt,
    expiresAt,
    client,
    branch,
  ]);

  const addRecipient = useCallback(async () => {
    if (!draft || recipientName.trim().length === 0) return;
    setRecipientBusy(true);
    setRecipientError(null);
    const {
      data,
      error: err,
      response,
    } = await client.POST("/api/v1/consents/{consentId}/recipients", {
      params: { path: { consentId: draft.id } },
      body: { recipientKind: recipientKind as never, recipientDisplayName: recipientName.trim() },
    });
    setRecipientBusy(false);
    if (err || !data) {
      branch(
        response?.status,
        err?.error?.code,
        "The recipient could not be added.",
        setRecipientError,
      );
      return;
    }
    setRecipients((rows) => [...rows, data.data as RecipientRow]);
    setRecipientName("");
  }, [draft, recipientKind, recipientName, client, branch]);

  const addAgent = useCallback(async () => {
    if (!draft || agentName.trim().length === 0 || agentRelationship.trim().length === 0) return;
    setAgentBusy(true);
    setAgentError(null);
    const {
      data,
      error: err,
      response,
    } = await client.POST("/api/v1/consents/{consentId}/dpoa-agents", {
      params: { path: { consentId: draft.id } },
      body: {
        agentKind: agentKind as never,
        agentName: agentName.trim(),
        agentRelationship: agentRelationship.trim(),
        agentContact: {},
        scopeKind: agentScopeKind as never,
        activationCondition: agentActivation as never,
        termKind: agentTermKind as never,
        ...(agentTermKind === "until_date" && agentTermUntil
          ? { termUntil: new Date(agentTermUntil).toISOString() }
          : {}),
      },
    });
    setAgentBusy(false);
    if (err || !data) {
      branch(
        response?.status,
        err?.error?.code,
        "The DPOA agent could not be added.",
        setAgentError,
      );
      return;
    }
    setAgents((rows) => [...rows, data.data as AgentRow]);
    setAgentName("");
    setAgentRelationship("");
  }, [
    draft,
    agentKind,
    agentName,
    agentRelationship,
    agentScopeKind,
    agentActivation,
    agentTermKind,
    agentTermUntil,
    client,
    branch,
  ]);

  const sign = useCallback(async () => {
    if (!draft) return;
    setSignBusy(true);
    setSignError(null);
    const {
      data,
      error: err,
      response,
    } = await client.POST("/api/v1/consents/{consentId}/sign", {
      params: { path: { consentId: draft.id } },
      body: { captureEvidence: evidencePayload(captureMethod, evidence) },
    });
    setSignBusy(false);
    if (err || !data) {
      branch(response?.status, err?.error?.code, "The consent could not be signed.", setSignError);
      return;
    }
    setCeremonyOpen(false);
    navigate(`/patients/${patientId}/consents/${data.data.id}`);
  }, [draft, captureMethod, evidence, client, branch, navigate, patientId]);

  const canSign =
    draft?.status === "draft" &&
    isEvidenceComplete(captureMethod, evidence) &&
    (!needsRecipient || activeRecipientCount > 0) &&
    (!needsAgent || Boolean(activePrimaryAgent));

  const banner = patient ? (
    <PatientBanner
      name={`${patient.firstName} ${patient.lastName}`}
      mrn={patient.mrn}
      dob={patient.dob}
    />
  ) : null;

  if (catalogLoading) return <LoadingSpinner />;
  if (catalogError) return <EmptyState title="Unavailable" description={catalogError} />;

  return (
    <PatientWorkspaceLayout banner={banner}>
      <PageHeader title="Capture a new consent" breadcrumb="Consents" />

      <section style={card}>
        <h2 style={heading}>1. Type & terms</h2>
        <div style={grid}>
          <Field label="Consent type" htmlFor="capture-type">
            <select
              id="capture-type"
              value={typeKey}
              disabled={Boolean(draft)}
              onChange={(ev) => setTypeKey(ev.target.value)}
              style={input}
            >
              {catalog.map((c) => (
                <option key={c.typeKey} value={c.typeKey}>
                  {c.displayNameEn}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Grantor" htmlFor="capture-grantor">
            <select
              id="capture-grantor"
              value={grantorKind}
              onChange={(ev) => setGrantorKind(ev.target.value as GrantorKind)}
              style={input}
            >
              {GRANTOR_KINDS.map((g) => (
                <option key={g.value} value={g.value}>
                  {g.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Capture method" htmlFor="capture-method">
            <select
              id="capture-method"
              value={captureMethod}
              onChange={(ev) => setCaptureMethod(ev.target.value as StaffCaptureMethod)}
              style={input}
            >
              {STAFF_CAPTURE_METHODS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Effective date" htmlFor="capture-effective">
            <input
              id="capture-effective"
              type="date"
              value={effectiveAt}
              onChange={(ev) => setEffectiveAt(ev.target.value)}
              style={input}
            />
          </Field>
          <Field label="Expires (optional)" htmlFor="capture-expires">
            <input
              id="capture-expires"
              type="date"
              value={expiresAt}
              onChange={(ev) => setExpiresAt(ev.target.value)}
              style={input}
            />
          </Field>
        </div>
        <Field label="Scope description" htmlFor="capture-scope">
          <textarea
            id="capture-scope"
            value={scopeDescription}
            onChange={(ev) => setScopeDescription(ev.target.value)}
            style={{ ...input, minHeight: "4.5rem" }}
            placeholder="What this consent authorises, in plain language."
          />
        </Field>
        {draftError ? <Alert>{draftError}</Alert> : null}
        {!draft ? (
          <button
            type="button"
            onClick={() => void createDraft()}
            disabled={draftBusy || !typeKey}
            style={draftBusy || !typeKey ? disabledBtn : primaryBtn}
          >
            {draftBusy ? "Creating draft…" : "Create draft"}
          </button>
        ) : (
          <p style={{ margin: 0, fontSize: "0.8125rem", color: t.onSurfaceVariant }}>
            Draft {draft.id} created. Type and grantor are locked; complete the sections below to
            sign.
          </p>
        )}
      </section>

      {draft && needsRecipient ? (
        <section style={{ ...card, marginTop: "1rem" }}>
          <h2 style={heading}>2. Named recipients</h2>
          <p style={hint}>
            This type discloses to a named recipient — at least one is required before signing.
          </p>
          {recipients.length > 0 ? (
            <ul style={{ margin: "0 0 0.75rem", paddingLeft: "1.25rem" }}>
              {recipients.map((r) => (
                <li key={r.id} style={{ fontSize: "0.85rem" }}>
                  {r.recipientDisplayName}
                </li>
              ))}
            </ul>
          ) : null}
          <div style={grid}>
            <Field label="Recipient kind" htmlFor="recipient-kind">
              <select
                id="recipient-kind"
                value={recipientKind}
                onChange={(ev) => setRecipientKind(ev.target.value)}
                style={input}
              >
                {RECIPIENT_KINDS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Recipient name" htmlFor="recipient-name">
              <input
                id="recipient-name"
                value={recipientName}
                onChange={(ev) => setRecipientName(ev.target.value)}
                style={input}
              />
            </Field>
          </div>
          {recipientError ? <Alert>{recipientError}</Alert> : null}
          <button
            type="button"
            onClick={() => void addRecipient()}
            disabled={recipientBusy || recipientName.trim().length === 0}
            style={recipientBusy || recipientName.trim().length === 0 ? disabledBtn : ghostBtn}
          >
            {recipientBusy ? "Adding…" : "+ Add recipient"}
          </button>
        </section>
      ) : null}

      {draft && needsAgent ? (
        <section style={{ ...card, marginTop: "1rem" }}>
          <h2 style={heading}>2. DPOA agents</h2>
          <p style={hint}>
            Exactly one active primary agent is required before signing.
            {activePrimaryAgent ? ` Primary: ${activePrimaryAgent.agentName}.` : ""}
          </p>
          {agents.length > 0 ? (
            <ul style={{ margin: "0 0 0.75rem", paddingLeft: "1.25rem" }}>
              {agents.map((a) => (
                <li key={a.id} style={{ fontSize: "0.85rem" }}>
                  {a.agentName} ({a.agentKind})
                </li>
              ))}
            </ul>
          ) : null}
          <div style={grid}>
            <Field label="Agent kind" htmlFor="agent-kind">
              <select
                id="agent-kind"
                value={agentKind}
                onChange={(ev) => setAgentKind(ev.target.value)}
                style={input}
              >
                {DPOA_AGENT_KINDS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Agent name" htmlFor="agent-name">
              <input
                id="agent-name"
                value={agentName}
                onChange={(ev) => setAgentName(ev.target.value)}
                style={input}
              />
            </Field>
            <Field label="Relationship" htmlFor="agent-relationship">
              <input
                id="agent-relationship"
                value={agentRelationship}
                onChange={(ev) => setAgentRelationship(ev.target.value)}
                style={input}
              />
            </Field>
            <Field label="Scope" htmlFor="agent-scope">
              <select
                id="agent-scope"
                value={agentScopeKind}
                onChange={(ev) => setAgentScopeKind(ev.target.value)}
                style={input}
              >
                {DPOA_SCOPE_KINDS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Activates" htmlFor="agent-activation">
              <select
                id="agent-activation"
                value={agentActivation}
                onChange={(ev) => setAgentActivation(ev.target.value)}
                style={input}
              >
                {DPOA_ACTIVATIONS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Term" htmlFor="agent-term">
              <select
                id="agent-term"
                value={agentTermKind}
                onChange={(ev) => setAgentTermKind(ev.target.value)}
                style={input}
              >
                {DPOA_TERM_KINDS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </select>
            </Field>
            {agentTermKind === "until_date" ? (
              <Field label="Term until" htmlFor="agent-term-until">
                <input
                  id="agent-term-until"
                  type="date"
                  value={agentTermUntil}
                  onChange={(ev) => setAgentTermUntil(ev.target.value)}
                  style={input}
                />
              </Field>
            ) : null}
          </div>
          {agentError ? <Alert>{agentError}</Alert> : null}
          <button
            type="button"
            onClick={() => void addAgent()}
            disabled={
              agentBusy || agentName.trim().length === 0 || agentRelationship.trim().length === 0
            }
            style={
              agentBusy || agentName.trim().length === 0 || agentRelationship.trim().length === 0
                ? disabledBtn
                : ghostBtn
            }
          >
            {agentBusy ? "Adding…" : "+ Add agent"}
          </button>
        </section>
      ) : null}

      {draft ? (
        <section style={{ ...card, marginTop: "1rem" }}>
          <h2 style={heading}>{needsRecipient || needsAgent ? "3." : "2."} Sign</h2>
          {signError ? <Alert>{signError}</Alert> : null}
          <button
            type="button"
            onClick={() => setCeremonyOpen(true)}
            disabled={!canSign}
            style={canSign ? primaryBtn : disabledBtn}
          >
            Continue to sign
          </button>
        </section>
      ) : null}

      <CeremonyModal
        open={ceremonyOpen}
        title="Sign consent"
        attestation={
          <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            <span style={{ fontSize: "0.8125rem", color: t.onSurfaceVariant }}>
              This creates an immutable, versioned consent record and starts the M22 render.
            </span>
            <CaptureEvidenceFields method={captureMethod} value={evidence} onChange={setEvidence} />
          </div>
        }
        legalText="I attest this consent was captured accurately and the evidence above is authentic."
        signer={{ name: "Capturing staff member", role: "This session" }}
        commitLabel={signBusy ? "Signing…" : "Sign & commit"}
        onCommit={() => void sign()}
        onCancel={() => setCeremonyOpen(false)}
      />
    </PatientWorkspaceLayout>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: JSX.Element;
}): JSX.Element {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
      <label style={fieldLabel} htmlFor={htmlFor}>
        {label}
      </label>
      {children}
    </div>
  );
}

function Alert({ children }: { children: JSX.Element | string }): JSX.Element {
  return (
    <p role="alert" aria-live="assertive" style={alertStyle}>
      {children}
    </p>
  );
}

const card: CSSProperties = {
  ...cardSurface,
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
};
const heading: CSSProperties = { margin: 0, fontSize: "1.05rem" };
const hint: CSSProperties = { margin: 0, fontSize: "0.8125rem", color: t.onSurfaceVariant };
const grid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(14rem, 1fr))",
  gap: "0.75rem",
};
const fieldLabel: CSSProperties = {
  fontSize: "0.75rem",
  fontWeight: 600,
  color: t.onSurfaceVariant,
};
const input: CSSProperties = {
  padding: "0.5rem 0.625rem",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--color-outline-variant)",
};
const alertStyle: CSSProperties = { margin: 0, fontSize: "0.8rem", color: "var(--color-error)" };
const primaryBtn: CSSProperties = {
  alignSelf: "flex-start",
  padding: "0.5rem 1rem",
  borderRadius: "9999px",
  background: "var(--color-primary)",
  color: "var(--color-on-primary)",
  fontSize: "0.8125rem",
  fontWeight: 600,
  border: "none",
  cursor: "pointer",
};
const disabledBtn: CSSProperties = {
  ...primaryBtn,
  background: "var(--color-surface-container)",
  color: "var(--color-on-surface-variant)",
  cursor: "not-allowed",
};
const ghostBtn: CSSProperties = {
  ...primaryBtn,
  background: "var(--color-surface-container)",
  color: "var(--color-on-surface)",
};
