import { Button, DetailPageLayout, PageHeader, useApiClient } from "@wardenx/ui";
import type { CSSProperties, JSX } from "react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    patientNameAtReceipt: "",
    patientDobAtReceipt: "",
    source: "phone",
    referrerOrganization: "",
    referrerName: "",
    referrerPhone: "",
    externalReferralId: "",
    referringDxText: "",
    receivedAt: new Date().toISOString().slice(0, 16),
  });

  function setField(field: keyof typeof form, value: string): void {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function submit(): Promise<void> {
    if (!form.patientNameAtReceipt.trim()) {
      setError("Patient full name is required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await createReferral(client, {
        source: form.source,
        receivedAt: new Date(form.receivedAt).toISOString(),
        patientNameAtReceipt: form.patientNameAtReceipt.trim(),
        ...(form.patientDobAtReceipt ? { patientDobAtReceipt: form.patientDobAtReceipt } : {}),
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
          <div style={muted}>Capture the referral quickly. The patient can be resolved after review.</div>
        </PageHeader>
      }
    >
      {error ? <div role="alert" style={alert}>{error}</div> : null}
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
            <input value={form.referrerName} onChange={(ev) => setField("referrerName", ev.target.value)} />
          </label>
          <label style={label}>
            Referrer phone
            <input value={form.referrerPhone} onChange={(ev) => setField("referrerPhone", ev.target.value)} />
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
const alert: CSSProperties = {
  marginBottom: "1rem",
  padding: "0.75rem 1rem",
  border: "1px solid color-mix(in srgb, var(--color-error) 35%, transparent)",
  borderRadius: "8px",
  color: "var(--color-error)",
};
