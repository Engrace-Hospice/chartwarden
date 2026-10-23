import { isValidMedicaidNumber, isValidMedicareNumber } from "@chartwarden/types";
import {
  Button,
  DetailPageLayout,
  PageHeader,
  localInputToIso,
  nowLocalInput,
  useApiClient,
} from "@chartwarden/ui";
import type { CSSProperties, JSX } from "react";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { createReferral } from "./referrals-api";

const SOURCES = [
  ["phone", "Phone"],
  ["fax", "Fax"],
  ["portal", "Portal"],
  ["walk_in", "Walk-in"],
  ["self_referral", "Self referral"],
  ["physician_office", "Physician office"],
  ["hospital_discharge_planner", "Hospital discharge planner"],
] as const;

export function ReferralNew(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const patientId = searchParams.get("patientId") ?? "";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    patientNameAtReceipt: "",
    patientDobAtReceipt: "",
    medicareNumberAtReceipt: "",
    medicaidNumberAtReceipt: "",
    sexAssignedAtBirth: "U",
    source: "phone",
    referrerOrganization: "",
    referrerName: "",
    referrerPhone: "",
    externalReferralId: "",
    referringDxText: "",
    receivedAt: nowLocalInput(),
  });

  useEffect(() => {
    if (!patientId) return;
    let cancelled = false;
    async function loadPatient(): Promise<void> {
      const { data } = await client.GET("/api/v1/patients/{id}", {
        params: { path: { id: patientId } },
      });
      if (!data || cancelled) return;
      const patient = data as {
        firstName?: string;
        lastName?: string;
        dob?: string;
        sexAssignedAtBirth?: string;
      };
      setForm((prev) => ({
        ...prev,
        patientNameAtReceipt:
          prev.patientNameAtReceipt ||
          [patient.firstName, patient.lastName].filter(Boolean).join(" "),
        patientDobAtReceipt: prev.patientDobAtReceipt || patient.dob || "",
        sexAssignedAtBirth:
          prev.sexAssignedAtBirth === "U"
            ? patient.sexAssignedAtBirth || "U"
            : prev.sexAssignedAtBirth,
      }));
    }
    void loadPatient();
    return () => {
      cancelled = true;
    };
  }, [client, patientId]);

  function setField(field: keyof typeof form, value: string): void {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function submit(): Promise<void> {
    if (!form.patientNameAtReceipt.trim()) {
      setError("Patient full name is required.");
      return;
    }
    const receivedAtIso = localInputToIso(form.receivedAt);
    if (!receivedAtIso) {
      setError("Enter the date and time the referral was received.");
      return;
    }
    if (
      form.medicareNumberAtReceipt.trim() &&
      !isValidMedicareNumber(form.medicareNumberAtReceipt)
    ) {
      setError("Medicare number must be the 11-character MBI (e.g. 1EG4-TE5-MK73).");
      return;
    }
    if (
      form.medicaidNumberAtReceipt.trim() &&
      !isValidMedicaidNumber(form.medicaidNumberAtReceipt)
    ) {
      setError("Medicaid number must be up to 14 letters and digits.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await createReferral(client, {
        source: form.source,
        receivedAt: receivedAtIso,
        ...(patientId ? { patientId } : {}),
        patientNameAtReceipt: form.patientNameAtReceipt.trim(),
        ...(form.patientDobAtReceipt ? { patientDobAtReceipt: form.patientDobAtReceipt } : {}),
        ...(form.medicareNumberAtReceipt.trim()
          ? { medicareNumberAtReceipt: form.medicareNumberAtReceipt.trim() }
          : {}),
        ...(form.medicaidNumberAtReceipt.trim()
          ? { medicaidNumberAtReceipt: form.medicaidNumberAtReceipt.trim() }
          : {}),
        sexAssignedAtBirth: form.sexAssignedAtBirth,
        ...(form.referrerOrganization.trim()
          ? { referrerOrganization: form.referrerOrganization.trim() }
          : {}),
        ...(form.referrerName.trim() ? { referrerName: form.referrerName.trim() } : {}),
        ...(form.referrerPhone.trim() ? { referrerPhone: form.referrerPhone.trim() } : {}),
        ...(form.externalReferralId.trim()
          ? { externalReferralId: form.externalReferralId.trim() }
          : {}),
        ...(form.referringDxText.trim() ? { referringDxText: form.referringDxText.trim() } : {}),
      });
      navigate(`/referrals/${created.id}`);
    } catch (err) {
      setError(errorMessage(err, "Referral could not be created."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <DetailPageLayout
      header={
        <PageHeader
          title="New Referral"
          breadcrumb="Admissions / Intake"
          actions={
            <Button tone="primary" onClick={() => void submit()} disabled={busy}>
              {busy ? "Creating..." : "Create referral"}
            </Button>
          }
        >
          <div style={muted}>
            Capture the referral quickly. The patient can be resolved after review.
          </div>
        </PageHeader>
      }
    >
      {error ? (
        <div role="alert" style={alert}>
          {error}
        </div>
      ) : null}
      <div style={grid}>
        <section style={section}>
          <h2 style={heading}>Patient information</h2>
          <label style={label}>
            Patient full name
            <input
              value={form.patientNameAtReceipt}
              onChange={(ev) => setField("patientNameAtReceipt", ev.target.value)}
              required
            />
          </label>
          <label style={label}>
            Date of birth
            <input
              type="date"
              value={form.patientDobAtReceipt}
              onChange={(ev) => setField("patientDobAtReceipt", ev.target.value)}
            />
          </label>
          <label style={label}>
            Medicare number (MBI)
            <input
              value={form.medicareNumberAtReceipt}
              onChange={(ev) => setField("medicareNumberAtReceipt", ev.target.value)}
              placeholder="1EG4-TE5-MK73"
              maxLength={20}
              autoComplete="off"
              aria-describedby="referral-mbi-hint"
              aria-invalid={
                form.medicareNumberAtReceipt.trim() !== "" &&
                !isValidMedicareNumber(form.medicareNumberAtReceipt)
              }
            />
            <span id="referral-mbi-hint" style={hint}>
              Optional. Added to the patient's chart when the patient is created or matched, and
              pre-fills HOPE.
            </span>
          </label>
          <label style={label}>
            Medicaid number
            <input
              value={form.medicaidNumberAtReceipt}
              onChange={(ev) => setField("medicaidNumberAtReceipt", ev.target.value)}
              maxLength={24}
              autoComplete="off"
              aria-describedby="referral-medicaid-hint"
              aria-invalid={
                form.medicaidNumberAtReceipt.trim() !== "" &&
                !isValidMedicaidNumber(form.medicaidNumberAtReceipt)
              }
            />
            <span id="referral-medicaid-hint" style={hint}>
              Optional, if the patient has Medicaid. Pre-fills the Medicaid coverage on the referral
              once the patient is resolved.
            </span>
            Sex assigned at birth
            <select
              value={form.sexAssignedAtBirth}
              onChange={(ev) => setField("sexAssignedAtBirth", ev.target.value)}
            >
              <option value="F">Female</option>
              <option value="M">Male</option>
              <option value="O">Other</option>
              <option value="U">Unknown / not known</option>
            </select>
          </label>
        </section>

        <section style={section}>
          <h2 style={heading}>Referral source</h2>
          <label style={label}>
            Source channel
            <select value={form.source} onChange={(ev) => setField("source", ev.target.value)}>
              {SOURCES.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label style={label}>
            Organization or facility
            <input
              value={form.referrerOrganization}
              onChange={(ev) => setField("referrerOrganization", ev.target.value)}
            />
          </label>
          <label style={label}>
            Referrer name
            <input
              value={form.referrerName}
              onChange={(ev) => setField("referrerName", ev.target.value)}
            />
          </label>
          <label style={label}>
            Referrer phone
            <input
              value={form.referrerPhone}
              onChange={(ev) => setField("referrerPhone", ev.target.value)}
            />
          </label>
          <label style={label}>
            External referral ID
            <input
              value={form.externalReferralId}
              onChange={(ev) => setField("externalReferralId", ev.target.value)}
            />
          </label>
        </section>

        <section style={section}>
          <h2 style={heading}>Clinical information</h2>
          <label style={label}>
            Referral reason or diagnosis
            <textarea
              value={form.referringDxText}
              onChange={(ev) => setField("referringDxText", ev.target.value)}
              rows={5}
            />
          </label>
        </section>

        <section style={section}>
          <h2 style={heading}>Operational intake</h2>
          <label style={label}>
            Received at
            <input
              type="datetime-local"
              value={form.receivedAt}
              onChange={(ev) => setField("receivedAt", ev.target.value)}
            />
          </label>
          <div style={muted}>Priority and owner can be set from the referral workspace.</div>
        </section>
      </div>
    </DetailPageLayout>
  );
}

function errorMessage(err: unknown, fallback: string): string {
  const e = err as { error?: { message?: string; code?: string }; message?: string };
  return e.error?.message ?? e.message ?? fallback;
}

const grid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(20rem, 1fr))",
  gap: "1rem",
};
const section: CSSProperties = {
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "8px",
  background: "var(--color-surface)",
  padding: "1rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.8rem",
};
const heading: CSSProperties = { margin: 0, fontSize: "1rem" };
const label: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.35rem",
  fontSize: "0.85rem",
  fontWeight: 600,
};
const muted: CSSProperties = { color: "var(--color-on-surface-variant)", fontSize: "0.875rem" };
const hint: CSSProperties = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.75rem",
  fontWeight: 400,
};
const alert: CSSProperties = {
  marginBottom: "1rem",
  padding: "0.75rem 1rem",
  border: "1px solid color-mix(in srgb, var(--color-error) 35%, transparent)",
  borderRadius: "8px",
  color: "var(--color-error)",
};
