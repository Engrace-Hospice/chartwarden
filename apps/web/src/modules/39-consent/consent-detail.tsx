import {
  CeremonyModal,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  PatientBanner,
  PatientWorkspaceLayout,
  StatusPill,
  cardSurface,
  t,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/39-consent — M39 CONSENT LIFECYCLE DETAIL (report 09 mini-spec #2, WX-PR-010).
// Route `/patients/:patientId/consents/:consentId`.
//
// Presents the immutable record + its two ancestor chains (supersedes / renewedFrom, D1/D8) and the
// three guarded lifecycle ceremonies over the real WX-PR-009 writes: revoke, supersede, renew. Every
// mutation is optimistic-version guarded server-side — a 409 here means "changed since you loaded
// it," not a bug, so the recovery is always "reload," never a silent retry.
//
// Recipients/DPOA agents are NOT re-rendered here — `consent-recipients-dpoa.tsx` already owns that
// surface (route `/consents/:consentId/recipients`); this screen links out rather than duplicating it.
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, JSX, ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  CaptureEvidenceFields,
  STAFF_CAPTURE_METHODS,
  type StaffCaptureMethod,
  emptyEvidence,
  evidencePayload,
  isEvidenceComplete,
} from "./consent-evidence-fields";
import { CONSENT_STATUS_TONE, humanize, readErrorMessage, toneOf } from "./consent-status";
import { authFailureRedirect } from "./write-workflow";

const GRANTOR_KINDS = [
  { value: "patient_self", label: "Patient (self)" },
  { value: "dpoa_healthcare_agent", label: "DPOA — healthcare agent" },
  { value: "dpoa_financial_agent", label: "DPOA — financial agent" },
  { value: "court_guardian", label: "Court-appointed guardian" },
  { value: "parent_for_minor", label: "Parent (for a minor)" },
  { value: "healthcare_surrogate", label: "Healthcare surrogate" },
] as const;
type GrantorKind = (typeof GRANTOR_KINDS)[number]["value"];

interface ConsentRecord {
  id: string;
  typeKey: string;
  grantorKind: string;
  captureMethod: string;
  scopeDescriptor: unknown;
  status: string;
  version: number;
  effectiveAt: string | null;
  expiresAt: string | null;
  signedAt: string | null;
  supersedesConsentRecordId?: string | null;
  renewedFromConsentRecordId?: string | null;
  survivesDeath?: boolean;
}
interface VersionChain {
  supersedes: ConsentRecord[];
  renewedFrom: ConsentRecord[];
}
interface RenewalCycle {
  id: string;
  status: string;
  nextActionDueAt: string | null;
}
interface PatientSummary {
  mrn: string;
  lastName: string;
  firstName: string;
  dob: string;
  status: string;
}

type Ceremony = "revoke" | "supersede" | "renew" | null;

const day = (iso: string | null): string => (iso ? iso.slice(0, 10) : "—");

export function ConsentDetail(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const { patientId, consentId } = useParams<{ patientId: string; consentId: string }>();

  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [record, setRecord] = useState<ConsentRecord | null>(null);
  const [chain, setChain] = useState<VersionChain>({ supersedes: [], renewedFrom: [] });
  const [cycles, setCycles] = useState<RenewalCycle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [ceremony, setCeremony] = useState<Ceremony>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const [revokeReason, setRevokeReason] = useState("");
  const [revokeEvidenceDocumentId, setRevokeEvidenceDocumentId] = useState("");

  const [supersedeCaptureMethod, setSupersedeCaptureMethod] =
    useState<StaffCaptureMethod>("typed_signature_in_app");
  const [supersedeGrantorKind, setSupersedeGrantorKind] = useState<GrantorKind>("patient_self");
  const [supersedeEvidence, setSupersedeEvidence] = useState(emptyEvidence());

  const [renewCaptureMethod, setRenewCaptureMethod] =
    useState<StaffCaptureMethod>("typed_signature_in_app");
  const [renewGrantorKind, setRenewGrantorKind] = useState<GrantorKind>("patient_self");
  const [renewExpiresAt, setRenewExpiresAt] = useState("");
  const [renewEvidence, setRenewEvidence] = useState(emptyEvidence());

  const load = useCallback(async () => {
    if (!consentId) return;
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/consents/{consentId}", {
      params: { path: { consentId } },
    });
    if (err || !data) {
      setError(readErrorMessage(undefined, "consent.read"));
      setLoading(false);
      return;
    }
    const rec = data.data as ConsentRecord;
    setRecord(rec);
    setSupersedeCaptureMethod(rec.captureMethod as StaffCaptureMethod);
    setSupersedeGrantorKind(rec.grantorKind as GrantorKind);
    setRenewCaptureMethod(rec.captureMethod as StaffCaptureMethod);
    setRenewGrantorKind(rec.grantorKind as GrantorKind);
    const [vRes, rRes, pRes] = await Promise.all([
      client.GET("/api/v1/consents/{consentId}/version-chain", { params: { path: { consentId } } }),
      client.GET("/api/v1/consents/{consentId}/renewal-cycle", { params: { path: { consentId } } }),
      patientId
        ? client.GET("/api/v1/patients/{id}", { params: { path: { id: patientId } } })
        : Promise.resolve({ data: undefined }),
    ]);
    if (vRes.data) setChain(vRes.data.data as VersionChain);
    if (rRes.data) setCycles((rRes.data.data ?? []) as RenewalCycle[]);
    if (pRes.data) setPatient(pRes.data as PatientSummary);
    setLoading(false);
  }, [client, consentId, patientId]);

  useEffect(() => {
    void load();
  }, [load]);

  const closeCeremony = useCallback(() => {
    setCeremony(null);
    setActionError(null);
    setRevokeReason("");
    setRevokeEvidenceDocumentId("");
    setSupersedeEvidence(emptyEvidence());
    setRenewEvidence(emptyEvidence());
    setRenewExpiresAt("");
  }, []);

  const branch = useCallback(
    (status: number | undefined, message: string | undefined, fallback: string): boolean => {
      const redirect = authFailureRedirect(status, message, window.location.pathname);
      if (redirect) {
        navigate(redirect);
        return true;
      }
      setBusy(false);
      if (status === 409)
        setActionError("This consent changed since you opened it — reload to retry.");
      else if (status === 403) setActionError("You do not have permission for this action.");
      else if (status === 422) setActionError("Validation failed — check the values you entered.");
      else setActionError(fallback);
      return false;
    },
    [navigate],
  );

  const revoke = useCallback(async () => {
    if (!consentId) return;
    if (revokeReason.trim().length < 40) {
      setActionError("A staff revocation requires a reason of at least 40 characters.");
      return;
    }
    setBusy(true);
    setActionError(null);
    const { error: err, response } = await client.POST("/api/v1/consents/{consentId}/revoke", {
      params: { path: { consentId } },
      body: {
        revokedByKind: "staff",
        reasonText: revokeReason.trim(),
        ...(revokeEvidenceDocumentId.trim()
          ? { evidenceDocumentId: revokeEvidenceDocumentId.trim() }
          : {}),
      },
    });
    if (err) {
      branch(response?.status, err?.error?.message, "The consent could not be revoked.");
      return;
    }
    setBusy(false);
    closeCeremony();
    void load();
  }, [consentId, revokeReason, revokeEvidenceDocumentId, client, branch, closeCeremony, load]);

  const supersede = useCallback(async () => {
    if (!consentId || !record) return;
    if (!isEvidenceComplete(supersedeCaptureMethod, supersedeEvidence)) {
      setActionError("Provide the evidence this capture method requires.");
      return;
    }
    setBusy(true);
    setActionError(null);
    const {
      data,
      error: err,
      response,
    } = await client.POST("/api/v1/consents/{consentId}/supersede", {
      params: { path: { consentId } },
      body: {
        scopeDescriptor: record.scopeDescriptor ?? {},
        captureMethod: supersedeCaptureMethod,
        grantorKind: supersedeGrantorKind,
        captureEvidence: evidencePayload(supersedeCaptureMethod, supersedeEvidence),
      },
    });
    if (err || !data) {
      branch(response?.status, err?.error?.message, "The consent could not be superseded.");
      return;
    }
    setBusy(false);
    closeCeremony();
    navigate(`/patients/${patientId}/consents/${data.data.id}`);
  }, [
    consentId,
    record,
    supersedeCaptureMethod,
    supersedeGrantorKind,
    supersedeEvidence,
    client,
    branch,
    closeCeremony,
    navigate,
    patientId,
  ]);

  const renew = useCallback(async () => {
    if (!consentId || !record) return;
    if (!isEvidenceComplete(renewCaptureMethod, renewEvidence)) {
      setActionError("Provide the evidence this capture method requires.");
      return;
    }
    setBusy(true);
    setActionError(null);
    const {
      data,
      error: err,
      response,
    } = await client.POST("/api/v1/consents/{consentId}/renew", {
      params: { path: { consentId } },
      body: {
        scopeDescriptor: record.scopeDescriptor ?? {},
        captureMethod: renewCaptureMethod,
        grantorKind: renewGrantorKind,
        ...(renewExpiresAt ? { expiresAt: new Date(renewExpiresAt).toISOString() } : {}),
        captureEvidence: evidencePayload(renewCaptureMethod, renewEvidence),
      },
    });
    if (err || !data) {
      branch(response?.status, err?.error?.message, "The consent could not be renewed.");
      return;
    }
    setBusy(false);
    closeCeremony();
    navigate(`/patients/${patientId}/consents/${data.data.id}`);
  }, [
    consentId,
    record,
    renewCaptureMethod,
    renewGrantorKind,
    renewExpiresAt,
    renewEvidence,
    client,
    branch,
    closeCeremony,
    navigate,
    patientId,
  ]);

  if (loading) return <LoadingSpinner />;
  if (error || !record)
    return <EmptyState title="Unavailable" description={error ?? "Not found."} />;

  const canAct = record.status === "active";
  const banner = patient ? (
    <PatientBanner
      name={`${patient.firstName} ${patient.lastName}`}
      mrn={patient.mrn}
      dob={patient.dob}
    />
  ) : null;

  return (
    <PatientWorkspaceLayout banner={banner}>
      <PageHeader
        title={humanize(record.typeKey)}
        breadcrumb="Consents"
        actions={
          <div style={{ display: "flex", alignItems: "center", gap: "0.625rem" }}>
            <StatusPill
              tone={toneOf(CONSENT_STATUS_TONE, record.status)}
              label={humanize(record.status)}
            />
            {canAct ? (
              <>
                <button type="button" onClick={() => setCeremony("renew")} style={ghostBtn}>
                  Renew
                </button>
                <button type="button" onClick={() => setCeremony("supersede")} style={ghostBtn}>
                  Supersede
                </button>
                <button type="button" onClick={() => setCeremony("revoke")} style={dangerBtn}>
                  Revoke
                </button>
              </>
            ) : null}
          </div>
        }
      />

      <section style={cardSurface}>
        <h2 style={heading}>Record</h2>
        <dl style={dl}>
          <Dt>Grantor</Dt>
          <Dd>{humanize(record.grantorKind)}</Dd>
          <Dt>Capture method</Dt>
          <Dd>{humanize(record.captureMethod)}</Dd>
          <Dt>Version</Dt>
          <Dd>{record.version}</Dd>
          <Dt>Effective</Dt>
          <Dd>{day(record.effectiveAt)}</Dd>
          <Dt>Expires</Dt>
          <Dd>{day(record.expiresAt)}</Dd>
          <Dt>Signed</Dt>
          <Dd>{day(record.signedAt)}</Dd>
          <Dt>Survives death</Dt>
          <Dd>{record.survivesDeath ? "Yes (D13)" : "No"}</Dd>
        </dl>
        <Link to={`/consents/${record.id}/recipients`} style={linkStyle}>
          View named recipients &amp; DPOA agents →
        </Link>
      </section>

      {cycles.length > 0 ? (
        <section style={{ ...cardSurface, marginTop: "1rem" }}>
          <h2 style={heading}>Renewal cycle</h2>
          <ul style={{ margin: 0, paddingLeft: "1.25rem" }}>
            {cycles.map((c) => (
              <li key={c.id} style={{ fontSize: "0.85rem" }}>
                {humanize(c.status)}
                {c.nextActionDueAt ? ` — due ${day(c.nextActionDueAt)}` : ""}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {chain.supersedes.length > 0 || chain.renewedFrom.length > 0 ? (
        <section style={{ ...cardSurface, marginTop: "1rem" }}>
          <h2 style={heading}>Version history</h2>
          {chain.supersedes.length > 0 ? (
            <ChainList
              title="Supersession chain (oldest first)"
              rows={chain.supersedes}
              patientId={patientId}
            />
          ) : null}
          {chain.renewedFrom.length > 0 ? (
            <ChainList
              title="Renewal chain (oldest first)"
              rows={chain.renewedFrom}
              patientId={patientId}
            />
          ) : null}
        </section>
      ) : null}

      <CeremonyModal
        open={ceremony === "revoke"}
        title="Revoke consent"
        attestation={
          <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
            <span style={{ fontSize: "0.8125rem", color: t.onSurfaceVariant }}>
              Revocation is immediate and irreversible, and triggers the disclosure-evaluator
              cascade.
            </span>
            <label style={fieldLabel} htmlFor="revoke-reason">
              Reason (≥40 characters) *
            </label>
            <textarea
              id="revoke-reason"
              value={revokeReason}
              onChange={(ev) => setRevokeReason(ev.target.value)}
              style={{ ...input, minHeight: "4.5rem" }}
            />
            <label style={fieldLabel} htmlFor="revoke-evidence">
              Evidence document id (optional)
            </label>
            <input
              id="revoke-evidence"
              value={revokeEvidenceDocumentId}
              onChange={(ev) => setRevokeEvidenceDocumentId(ev.target.value)}
              style={input}
            />
            {actionError ? <Alert>{actionError}</Alert> : null}
          </div>
        }
        legalText="I attest this revocation is authorized and accurately documented."
        signer={{ name: "Revoking staff member", role: "This session" }}
        commitLabel={busy ? "Revoking…" : "Revoke"}
        onCommit={() => void revoke()}
        onCancel={closeCeremony}
      />

      <CeremonyModal
        open={ceremony === "supersede"}
        title="Supersede consent"
        attestation={
          <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
            <span style={{ fontSize: "0.8125rem", color: t.onSurfaceVariant }}>
              Creates a NEW active version pointing at this one, which flips to superseded (D1:
              never an in-place edit).
            </span>
            <LifecycleFormFields
              idPrefix="supersede"
              captureMethod={supersedeCaptureMethod}
              onCaptureMethod={setSupersedeCaptureMethod}
              grantorKind={supersedeGrantorKind}
              onGrantorKind={setSupersedeGrantorKind}
              evidence={supersedeEvidence}
              onEvidence={setSupersedeEvidence}
            />
            {actionError ? <Alert>{actionError}</Alert> : null}
          </div>
        }
        legalText="I attest this supersession was captured accurately and the evidence above is authentic."
        signer={{ name: "Capturing staff member", role: "This session" }}
        commitLabel={busy ? "Signing…" : "Sign & commit"}
        onCommit={() => void supersede()}
        onCancel={closeCeremony}
      />

      <CeremonyModal
        open={ceremony === "renew"}
        title="Renew consent"
        attestation={
          <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
            <span style={{ fontSize: "0.8125rem", color: t.onSurfaceVariant }}>
              Creates a NEW active version on the D8 renewal chain. A consent already renewed once
              cannot be renewed again.
            </span>
            <label style={fieldLabel} htmlFor="renew-expires">
              New expiry (optional)
            </label>
            <input
              id="renew-expires"
              type="date"
              value={renewExpiresAt}
              onChange={(ev) => setRenewExpiresAt(ev.target.value)}
              style={input}
            />
            <LifecycleFormFields
              idPrefix="renew"
              captureMethod={renewCaptureMethod}
              onCaptureMethod={setRenewCaptureMethod}
              grantorKind={renewGrantorKind}
              onGrantorKind={setRenewGrantorKind}
              evidence={renewEvidence}
              onEvidence={setRenewEvidence}
            />
            {actionError ? <Alert>{actionError}</Alert> : null}
          </div>
        }
        legalText="I attest this renewal was captured accurately and the evidence above is authentic."
        signer={{ name: "Capturing staff member", role: "This session" }}
        commitLabel={busy ? "Signing…" : "Sign & commit"}
        onCommit={() => void renew()}
        onCancel={closeCeremony}
      />
    </PatientWorkspaceLayout>
  );
}

function LifecycleFormFields({
  idPrefix,
  captureMethod,
  onCaptureMethod,
  grantorKind,
  onGrantorKind,
  evidence,
  onEvidence,
}: {
  idPrefix: string;
  captureMethod: StaffCaptureMethod;
  onCaptureMethod: (v: StaffCaptureMethod) => void;
  grantorKind: GrantorKind;
  onGrantorKind: (v: GrantorKind) => void;
  evidence: ReturnType<typeof emptyEvidence>;
  onEvidence: (v: ReturnType<typeof emptyEvidence>) => void;
}): JSX.Element {
  return (
    <>
      <label style={fieldLabel} htmlFor={`${idPrefix}-grantor`}>
        Grantor
      </label>
      <select
        id={`${idPrefix}-grantor`}
        value={grantorKind}
        onChange={(ev) => onGrantorKind(ev.target.value as GrantorKind)}
        style={input}
      >
        {GRANTOR_KINDS.map((g) => (
          <option key={g.value} value={g.value}>
            {g.label}
          </option>
        ))}
      </select>
      <label style={fieldLabel} htmlFor={`${idPrefix}-method`}>
        Capture method
      </label>
      <select
        id={`${idPrefix}-method`}
        value={captureMethod}
        onChange={(ev) => onCaptureMethod(ev.target.value as StaffCaptureMethod)}
        style={input}
      >
        {STAFF_CAPTURE_METHODS.map((m) => (
          <option key={m.value} value={m.value}>
            {m.label}
          </option>
        ))}
      </select>
      <CaptureEvidenceFields method={captureMethod} value={evidence} onChange={onEvidence} />
    </>
  );
}

function ChainList({
  title,
  rows,
  patientId,
}: {
  title: string;
  rows: ConsentRecord[];
  patientId: string | undefined;
}): JSX.Element {
  return (
    <div style={{ marginTop: "0.5rem" }}>
      <h3 style={{ margin: "0 0 0.4rem", fontSize: "0.85rem", color: t.onSurfaceVariant }}>
        {title}
      </h3>
      <ul style={{ margin: 0, paddingLeft: "1.25rem" }}>
        {rows.map((r) => (
          <li key={r.id} style={{ fontSize: "0.85rem" }}>
            <Link to={`/patients/${patientId}/consents/${r.id}`} style={linkStyle}>
              v{r.version} · {humanize(r.status)} · {day(r.signedAt)}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Dt({ children }: { children: ReactNode }): JSX.Element {
  return (
    <dt style={{ fontSize: "0.72rem", color: t.onSurfaceVariant, fontWeight: 600 }}>{children}</dt>
  );
}
function Dd({ children }: { children: ReactNode }): JSX.Element {
  return <dd style={{ margin: "0 0 0.5rem", fontSize: "0.85rem" }}>{children}</dd>;
}
function Alert({ children }: { children: JSX.Element | string }): JSX.Element {
  return (
    <p role="alert" aria-live="assertive" style={alertStyle}>
      {children}
    </p>
  );
}

const heading: CSSProperties = { margin: "0 0 0.5rem", fontSize: "1.05rem" };
const dl: CSSProperties = {
  margin: 0,
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(10rem, 1fr))",
  columnGap: "1rem",
};
const linkStyle: CSSProperties = {
  fontSize: "0.8125rem",
  color: "var(--color-primary)",
  textDecoration: "none",
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
const ghostBtn: CSSProperties = {
  padding: "0.4rem 0.85rem",
  borderRadius: "9999px",
  background: "var(--color-surface-container)",
  color: "var(--color-on-surface)",
  fontSize: "0.8125rem",
  fontWeight: 600,
  border: "none",
  cursor: "pointer",
};
const dangerBtn: CSSProperties = {
  ...ghostBtn,
  background: "var(--color-error-container, var(--color-surface-container))",
  color: "var(--color-error)",
};
