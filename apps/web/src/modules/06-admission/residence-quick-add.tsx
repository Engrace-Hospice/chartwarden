// Add the patient's home address from inside the admission-details dialog, so the user does not have to
// leave the dialog (and lose it) to satisfy the residence requirement. Same endpoint and body as the
// patient chart's address form (POST /patients/:id/addresses, `patient.edit`); the dialog re-reads
// the addresses afterwards via `onSaved`.
import { useApiClient } from "@chartwarden/ui";
import { useState } from "react";
import type { CSSProperties, JSX } from "react";

const inputStyle: CSSProperties = {
  padding: "0.5rem 0.625rem",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--color-outline-variant)",
};
const labelStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.2rem",
  fontSize: "0.75rem",
  fontWeight: 600,
  color: "var(--color-on-surface-variant)",
};
const EMPTY = { line1: "", line2: "", city: "", state: "", postalCode: "" };

export function ResidenceQuickAdd({
  patientId,
  onSaved,
}: { patientId: string; onSaved: () => void }): JSX.Element {
  const client = useApiClient();
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (key: keyof typeof EMPTY) => (value: string) =>
    setForm((f) => ({ ...f, [key]: value }));
  const state = form.state.trim().toUpperCase();
  const ready =
    form.line1.trim() !== "" &&
    form.city.trim() !== "" &&
    form.postalCode.trim().length >= 3 &&
    (state === "" || state.length === 2);

  async function save(): Promise<void> {
    setSaving(true);
    setError(null);
    const { error: err } = await client.POST("/api/v1/patients/{id}/addresses", {
      params: { path: { id: patientId } },
      body: {
        line1: form.line1.trim(),
        ...(form.line2.trim() ? { line2: form.line2.trim() } : {}),
        city: form.city.trim(),
        ...(state ? { state } : {}),
        postalCode: form.postalCode.trim(),
        kind: "home",
        isPrimary: true,
      },
    });
    setSaving(false);
    if (err) {
      setError(
        "Could not save the address. Check the fields, or ask someone who can edit the patient.",
      );
      return;
    }
    setForm(EMPTY);
    onSaved();
  }

  const field = (key: keyof typeof EMPTY, label: string, maxLength?: number): JSX.Element => (
    <label style={labelStyle}>
      {label}
      <input
        value={form[key]}
        maxLength={maxLength}
        onChange={(ev) => set(key)(ev.target.value)}
        style={inputStyle}
      />
    </label>
  );

  return (
    <fieldset
      aria-label="Add patient residence address"
      style={{
        border: 0,
        padding: 0,
        margin: 0,
        display: "flex",
        flexDirection: "column",
        gap: "0.5rem",
      }}
    >
      {field("line1", "Street address", 200)}
      {field("line2", "Apt / suite (optional)", 200)}
      {field("city", "City", 120)}
      {field("state", "State (2 letters)", 2)}
      {field("postalCode", "ZIP code", 12)}
      {error ? (
        <p role="alert" style={{ margin: 0, fontSize: "0.8rem", color: "var(--color-error)" }}>
          {error}
        </p>
      ) : null}
      <button
        type="button"
        className="wx-btn-secondary"
        disabled={!ready || saving}
        onClick={() => void save()}
      >
        {saving ? "Saving…" : "Save residence address"}
      </button>
    </fieldset>
  );
}
