import {
  CeremonyModal,
  DetailPageLayout,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/06-admission — Referral Detail (M6 §5.2.1/§5.2.2, Track B / ADR-0030, TASK-031).
// Fixes the dead `/referrals/:id` route `referral-inbox.tsx` has always linked to. Reads
// GET /api/v1/referrals/:id, whose DTO is honestly just `{id, state, version}` (the referral's intake
// facts — source, patient-at-receipt, referring dx — aren't on this read yet); this view renders exactly
// what the read exposes, the same convention as encounter-read.tsx's SOAP placeholder.
//
// Two ceremonies, gated on server-truth `state` only (the server is the only enforcement point — ADR-0030).
// Real DB enum (packages/db/src/schema/admission/referrals.ts): received, evaluated, accepted, rejected,
// withdrawn, admitted — NOT the in-memory reference service's `triaged`/`ineligible` naming.
//   Triage (`received` → `evaluated`/`rejected`) — without it `accepted` is unreachable through the UI,
//   since `POST /referrals/:id/accept` requires `state === "evaluated"` (ReferralNotTriagedError).
//   Accept (`evaluated` → `accepted`) — seeds the draft admission server-side and returns its id
//   (`admission.draft_from_referral`); this ceremony navigates straight into the new Admission Detail.
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { REFERRAL_TONE, stateLabel } from "./admission-status";
import { authFailureRedirect } from "./write-workflow";

interface Referral {
  id: string;
  state: string;
  version: number;
}

type CeremonyMode = "triage" | "accept" | null;

export function ReferralDetail(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const [referral, setReferral] = useState<Referral | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [ceremony, setCeremony] = useState<CeremonyMode>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const [outcome, setOutcome] = useState<"eligible" | "ineligible">("eligible");
  const [notes, setNotes] = useState("");
  const [primaryDiagnosisIcd10, setPrimaryDiagnosisIcd10] = useState("");
  const [attendingPhysicianId, setAttendingPhysicianId] = useState("");
  const [patientId, setPatientId] = useState("");

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/referrals/{id}", { params: { path: { id } } });
    if (err || !data) {
      setError("Referral not found or not visible to you.");
      setLoading(false);
      return;
    }
    setReferral(data);
    setLoading(false);
  }, [client, id]);

  useEffect(() => {
    void load();
  }, [load]);

  const closeCeremony = useCallback(() => {
    setCeremony(null);
    setActionError(null);
    setNotes("");
  }, []);

  const branchError = useCallback(
    (status: number | undefined, code: string | undefined) => {
      const redirect = authFailureRedirect(status, code, window.location.pathname);
      if (redirect) {
        navigate(redirect);
        return true;
      }
      setBusy(false);
      if (status === 412) setActionError("This referral changed since you opened it — reload to retry.");
      else if (status === 422) setActionError("Validation failed — check the values you entered.");
      else if (status === 403) setActionError("You do not have permission for this action.");
      else setActionError("The action could not be completed.");
      return false;
    },
    [navigate],
  );

  const submitTriage = useCallback(async () => {
    if (!id || !referral) return;
    setBusy(true);
    setActionError(null);
    const { error: err, response } = await client.POST("/api/v1/referrals/{id}/triage", {
      params: { path: { id } },
      body: { outcome, ...(notes.trim() ? { notes: notes.trim() } : {}), ifVersion: referral.version },
    });
    if (err) {
      branchError(response?.status, err?.error?.code);
      return;
    }
    setBusy(false);
    closeCeremony();
    void load();
  }, [id, referral, client, outcome, notes, branchError, closeCeremony, load]);

  const submitAccept = useCallback(async () => {
    if (!id || !referral) return;
    if (primaryDiagnosisIcd10.trim().length === 0) {
      setActionError("Provide the primary diagnosis (ICD-10).");
      return;
    }
    setBusy(true);
    setActionError(null);
    const { data, error: err, response } = await client.POST("/api/v1/referrals/{id}/accept", {
      params: { path: { id } },
      body: {
        primaryDiagnosisIcd10: primaryDiagnosisIcd10.trim(),
        ...(attendingPhysicianId.trim() ? { attendingPhysicianId: attendingPhysicianId.trim() } : {}),
        ...(patientId.trim() ? { patientId: patientId.trim() } : {}),
        ifVersion: referral.version,
      },
    });
    if (err || !data) {
      branchError(response?.status, err?.error?.code);
      return;
    }
    setBusy(false);
    // Straight into the seeded admission — the accept ceremony's whole point is to open it next.
    navigate(`/admissions/${data.admissionId}`);
  }, [id, referral, client, primaryDiagnosisIcd10, attendingPhysicianId, patientId, branchError, navigate]);

  if (loading) return <LoadingSpinner />;
  if (error || !referral) return <EmptyState title="Unavailable" description={error ?? "Not found."} />;

  const r = referral;
  const canTriage = r.state === "received";
  const canAccept = r.state === "evaluated";

  return (
    <DetailPageLayout
      header={
        <PageHeader
          title={`Referral ${r.id}`}
          actions={<StatusPill label={stateLabel(r.state)} tone={REFERRAL_TONE[r.state] ?? "neutral"} />}
        />
      }
    >
      <p style={meta}>
        Version {r.version}. This read carries only the referral's summary and state — the intake facts
        (source, patient-at-receipt, referring diagnosis) aren't exposed on this DTO yet.
      </p>

      <div style={{ display: "flex", gap: "0.625rem", marginTop: "1rem" }}>
        {canTriage ? (
          <button type="button" onClick={() => setCeremony("triage")} style={primaryBtn}>
            Triage
          </button>
        ) : null}
        {canAccept ? (
          <button type="button" onClick={() => setCeremony("accept")} style={primaryBtn}>
            Accept referral
          </button>
        ) : null}
      </div>

      <CeremonyModal
        open={ceremony === "triage"}
        title="Record triage outcome"
        attestation={
          <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
            <label htmlFor="triage-outcome" style={fieldLabel}>
              Outcome
            </label>
            <select
              id="triage-outcome"
              value={outcome}
              onChange={(ev) => setOutcome(ev.target.value as "eligible" | "ineligible")}
            >
              <option value="eligible">Eligible</option>
              <option value="ineligible">Ineligible</option>
            </select>
            <label htmlFor="triage-notes" style={fieldLabel}>
              Notes (optional)
            </label>
            <textarea id="triage-notes" value={notes} onChange={(ev) => setNotes(ev.target.value)} rows={3} />
            {actionError ? (
              <p role="alert" aria-live="assertive" style={alertStyle}>
                {actionError}
              </p>
            ) : null}
          </div>
        }
        signer={{ name: "Triaging clinician", role: "This session" }}
        commitLabel={busy ? "Recording…" : "Record outcome"}
        onCommit={() => void submitTriage()}
        onCancel={closeCeremony}
      />

      <CeremonyModal
        open={ceremony === "accept"}
        title="Accept referral"
        attestation={
          <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
            <span style={hint}>
              Seeds a draft admission (period-1 election period + an open Notice-of-Rights window).
            </span>
            <label htmlFor="accept-dx" style={fieldLabel}>
              Primary diagnosis (ICD-10)
            </label>
            <input
              id="accept-dx"
              value={primaryDiagnosisIcd10}
              onChange={(ev) => setPrimaryDiagnosisIcd10(ev.target.value)}
              placeholder="e.g. C34.90"
            />
            <label htmlFor="accept-attending" style={fieldLabel}>
              Attending physician id (optional)
            </label>
            <input
              id="accept-attending"
              value={attendingPhysicianId}
              onChange={(ev) => setAttendingPhysicianId(ev.target.value)}
            />
            <label htmlFor="accept-patient" style={fieldLabel}>
              Patient id (optional — leave blank to seed a placeholder)
            </label>
            <input id="accept-patient" value={patientId} onChange={(ev) => setPatientId(ev.target.value)} />
            {actionError ? (
              <p role="alert" aria-live="assertive" style={alertStyle}>
                {actionError}
              </p>
            ) : null}
          </div>
        }
        legalText="I attest this referral is accepted for hospice admission based on the information above."
        signer={{ name: "Accepting clinician", role: "This session" }}
        commitLabel={busy ? "Accepting…" : "Accept & seed admission"}
        onCommit={() => void submitAccept()}
        onCancel={closeCeremony}
      />
    </DetailPageLayout>
  );
}

const meta: CSSProperties = { fontSize: "0.85rem", color: "var(--color-on-surface-variant)" };
const hint: CSSProperties = { fontSize: "0.8125rem", color: "var(--color-on-surface-variant)" };
const fieldLabel: CSSProperties = { fontSize: "0.75rem", fontWeight: 600, color: "var(--color-on-surface-variant)" };
const alertStyle: CSSProperties = { margin: 0, fontSize: "0.8rem", color: "var(--color-error)" };
const primaryBtn: CSSProperties = {
  padding: "0.45rem 1rem",
  borderRadius: "9999px",
  background: "var(--color-primary)",
  color: "var(--color-on-primary)",
  fontSize: "0.8125rem",
  fontWeight: 600,
  border: "none",
  cursor: "pointer",
};
