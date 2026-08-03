import { EmptyState, PageHeader, useApiClient } from "@wardenx/ui";
// apps/web/src/modules/06-admission — Admission Create / direct intake (M6 §5.2.3, Track B / ADR-0030,
// TASK-031). The manual walk-in/phone/transfer-in path — distinct from `referral-detail.tsx`'s Accept
// ceremony, which auto-seeds an admission from an already-triaged referral. `intakeMethod` deliberately
// excludes `referral_auto` here — that value is the accept-driven path's signature, not something a
// human picks on a form. A plain form (no shared field kit exists yet — see
// apps/web/src/modules/20-field-safety/incident-new.tsx for the same local-field convention this
// mirrors) ending in a direct submit, not a CeremonyModal: this is data entry, not an attestation of an
// already-recorded clinical fact.
import { useCallback, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { authFailureRedirect } from "./write-workflow";

const INTAKE_METHODS = [
  { value: "in_person", label: "In person" },
  { value: "phone", label: "Phone" },
  { value: "transfer_in", label: "Transfer in" },
] as const;
type IntakeMethod = (typeof INTAKE_METHODS)[number]["value"];

export function AdmissionCreate(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const [patientId, setPatientId] = useState("");
  const [referralId, setReferralId] = useState(params.get("referralId") ?? "");
  const [intakeMethod, setIntakeMethod] = useState<IntakeMethod>("in_person");
  const [attendingPhysicianId, setAttendingPhysicianId] = useState("");
  const [hospiceMedicalDirectorId, setHospiceMedicalDirectorId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = patientId.trim().length > 0 && hospiceMedicalDirectorId.trim().length > 0;

  const submit = useCallback(async () => {
    setSaving(true);
    setError(null);
    const { data, error: err, response } = await client.POST("/api/v1/admissions", {
      body: {
        patientId: patientId.trim(),
        ...(referralId.trim() ? { referralId: referralId.trim() } : {}),
        intakeMethod,
        ...(attendingPhysicianId.trim() ? { attendingPhysicianId: attendingPhysicianId.trim() } : {}),
        hospiceMedicalDirectorId: hospiceMedicalDirectorId.trim(),
      },
    });
    if (err || !data) {
      const redirect = authFailureRedirect(response?.status, err?.error?.code, window.location.pathname);
      if (redirect) {
        navigate(redirect);
        return;
      }
      setSaving(false);
      if (response?.status === 422) setError("Validation failed — check the ids and try again.");
      else if (response?.status === 403) setError("You do not have permission to create an admission.");
      else setError("The admission was not created.");
      return;
    }
    navigate(`/admissions/${data.id}`);
  }, [client, patientId, referralId, intakeMethod, attendingPhysicianId, hospiceMedicalDirectorId, navigate]);

  return (
    <div style={columnStyle}>
      <PageHeader
        title="New admission (direct intake)"
        breadcrumb="Admissions"
        actions={
          <Link to="/admissions" style={ghostBtn}>
            Back to census
          </Link>
        }
      />

      <EmptyState
        title="Manual intake"
        description="For walk-in, phone, or transfer-in patients. A referral that has already been triaged and
accepted seeds its own admission automatically — see the referral's detail page instead."
      />

      <div style={fieldGroup}>
        <Field label="Patient id" value={patientId} onChange={setPatientId} required />
        <Field label="Referral id (optional)" value={referralId} onChange={setReferralId} />
        <label style={fieldLabel} htmlFor="intake-method">
          Intake method
        </label>
        <select
          id="intake-method"
          value={intakeMethod}
          onChange={(ev) => setIntakeMethod(ev.target.value as IntakeMethod)}
        >
          {INTAKE_METHODS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
        <Field
          label="Attending physician id (optional)"
          value={attendingPhysicianId}
          onChange={setAttendingPhysicianId}
        />
        <Field
          label="Hospice medical director id"
          value={hospiceMedicalDirectorId}
          onChange={setHospiceMedicalDirectorId}
          required
        />
      </div>

      {error ? (
        <p role="alert" aria-live="assertive" style={alertStyle}>
          {error}
        </p>
      ) : null}

      <div style={{ display: "flex", gap: "0.625rem" }}>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={saving || !ready}
          style={saving || !ready ? disabledBtn : primaryBtn}
        >
          {saving ? "Creating…" : "Create admission"}
        </button>
        <Link to="/admissions" style={ghostBtn}>
          Cancel
        </Link>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  required,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
}): JSX.Element {
  return (
    <>
      <label style={fieldLabel} htmlFor={`admission-create-${label}`}>
        {label}
        {required ? " *" : ""}
      </label>
      <input
        id={`admission-create-${label}`}
        value={value}
        onChange={(ev) => onChange(ev.target.value)}
        style={inputStyle}
      />
    </>
  );
}

const columnStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "1rem",
  padding: "1.5rem",
  maxWidth: "36rem",
};
const fieldGroup: CSSProperties = { display: "flex", flexDirection: "column", gap: "0.5rem" };
const fieldLabel: CSSProperties = {
  fontSize: "0.75rem",
  fontWeight: 600,
  color: "var(--color-on-surface-variant)",
  marginTop: "0.5rem",
};
const inputStyle: CSSProperties = {
  padding: "0.5rem 0.625rem",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--color-outline-variant)",
};
const alertStyle: CSSProperties = { margin: 0, fontSize: "0.8rem", color: "var(--color-error)" };
const primaryBtn: CSSProperties = {
  padding: "0.5rem 1rem",
  borderRadius: "9999px",
  background: "var(--color-primary)",
  color: "var(--color-on-primary)",
  fontSize: "0.8125rem",
  fontWeight: 600,
  border: "none",
  cursor: "pointer",
};
const disabledBtn: CSSProperties = { ...primaryBtn, background: "var(--color-surface-container)", color: "var(--color-on-surface-variant)", cursor: "not-allowed" };
const ghostBtn: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  padding: "0.5rem 1rem",
  borderRadius: "9999px",
  background: "var(--color-surface-container)",
  color: "var(--color-on-surface)",
  fontSize: "0.8125rem",
  fontWeight: 600,
  textDecoration: "none",
};
