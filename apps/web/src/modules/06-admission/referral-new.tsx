import { isValidMedicaidNumber, isValidMedicareNumber } from "@chartwarden/types";
import { Button, Glyph, localInputToIso, nowLocalInput, useApiClient } from "@chartwarden/ui";
import type { JSX } from "react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
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
type ValidatedField =
  | "patientNameAtReceipt"
  | "receivedAt"
  | "medicareNumberAtReceipt"
  | "medicaidNumberAtReceipt";

export function ReferralNew(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const patientId = searchParams.get("patientId") ?? "";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invalidField, setInvalidField] = useState<ValidatedField | null>(null);
  const [prefillError, setPrefillError] = useState(false);
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
      let data: unknown;
      try {
        const response = await client.GET("/api/v1/patients/{id}", {
          params: { path: { id: patientId } },
        });
        data = response.data;
      } catch {
        if (!cancelled) setPrefillError(true);
        return;
      }
      if (cancelled) return;
      if (!data) {
        setPrefillError(true);
        return;
      }
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
    if (invalidField === field) setInvalidField(null);
    if (error) setError(null);
  }

  function fail(field: ValidatedField, message: string): void {
    setInvalidField(field);
    setError(message);
    document.getElementById(`referral-${field}`)?.focus();
  }

  async function submit(): Promise<void> {
    if (!form.patientNameAtReceipt.trim()) {
      fail("patientNameAtReceipt", "Patient full name is required.");
      return;
    }
    const receivedAtIso = localInputToIso(form.receivedAt);
    if (!receivedAtIso) {
      fail("receivedAt", "Enter the date and time the referral was received.");
      return;
    }
    if (
      form.medicareNumberAtReceipt.trim() &&
      !isValidMedicareNumber(form.medicareNumberAtReceipt)
    ) {
      fail(
        "medicareNumberAtReceipt",
        "Medicare number must be the 11-character MBI (e.g. 1EG4-TE5-MK73).",
      );
      return;
    }
    if (
      form.medicaidNumberAtReceipt.trim() &&
      !isValidMedicaidNumber(form.medicaidNumberAtReceipt)
    ) {
      fail("medicaidNumberAtReceipt", "Medicaid number must be up to 14 letters and digits.");
      return;
    }
    setBusy(true);
    setError(null);
    setInvalidField(null);
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
    <div className="wx-work-page wx-referral-create">
      <header className="wx-page-head">
        <div>
          <h1>New referral</h1>
          <p>
            Capture the source and patient details. You can match the patient and assign an owner
            during review.
          </p>
        </div>
        <Link to="/referrals" className="wx-btn-secondary">
          <Glyph name="chevron-left" size={16} /> Referral inbox
        </Link>
      </header>

      {prefillError ? (
        <output className="wx-form-alert is-info">
          <Glyph name="info" size={18} />
          <p>Patient details could not be prefilled. You can enter them below and continue.</p>
        </output>
      ) : null}
      {error ? (
        <div className="wx-form-alert" role="alert">
          <Glyph name="alert-circle" size={18} />
          <p>{error}</p>
        </div>
      ) : null}

      <form
        id="referral-create-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="wx-form-layout">
          <div className="wx-form-main">
            <section className="wx-form-section" aria-labelledby="referral-patient-heading">
              <div className="wx-form-section-head">
                <span className="wx-form-section-icon" aria-hidden>
                  <Glyph name="user" size={20} />
                </span>
                <div>
                  <h2 id="referral-patient-heading">Patient information</h2>
                  <p>Record the identity as it was given when the referral arrived.</p>
                </div>
              </div>
              <div className="wx-form-grid">
                <div className="wx-form-field wide">
                  <label htmlFor="referral-patientNameAtReceipt">Patient full name</label>
                  <input
                    id="referral-patientNameAtReceipt"
                    value={form.patientNameAtReceipt}
                    onChange={(event) => setField("patientNameAtReceipt", event.target.value)}
                    placeholder="First and last name"
                    autoComplete="name"
                    required
                    aria-invalid={invalidField === "patientNameAtReceipt"}
                    aria-describedby={
                      invalidField === "patientNameAtReceipt" ? "referral-name-error" : undefined
                    }
                  />
                  {invalidField === "patientNameAtReceipt" ? (
                    <span id="referral-name-error" className="wx-form-error">
                      Enter the patient's full name.
                    </span>
                  ) : null}
                </div>
                <div className="wx-form-field">
                  <label htmlFor="referral-patientDobAtReceipt">Date of birth</label>
                  <input
                    id="referral-patientDobAtReceipt"
                    type="date"
                    value={form.patientDobAtReceipt}
                    onChange={(event) => setField("patientDobAtReceipt", event.target.value)}
                  />
                </div>
                <div className="wx-form-field">
                  <label htmlFor="referral-sexAssignedAtBirth">Sex assigned at birth</label>
                  <select
                    id="referral-sexAssignedAtBirth"
                    value={form.sexAssignedAtBirth}
                    onChange={(event) => setField("sexAssignedAtBirth", event.target.value)}
                  >
                    <option value="U">Unknown / not known</option>
                    <option value="F">Female</option>
                    <option value="M">Male</option>
                    <option value="O">Other</option>
                  </select>
                </div>
                <div className="wx-form-field">
                  <label htmlFor="referral-medicareNumberAtReceipt">Medicare number (MBI)</label>
                  <input
                    id="referral-medicareNumberAtReceipt"
                    value={form.medicareNumberAtReceipt}
                    onChange={(event) => setField("medicareNumberAtReceipt", event.target.value)}
                    placeholder="1EG4-TE5-MK73"
                    maxLength={20}
                    autoComplete="off"
                    aria-describedby="referral-mbi-hint"
                    aria-invalid={
                      invalidField === "medicareNumberAtReceipt" ||
                      (form.medicareNumberAtReceipt.trim() !== "" &&
                        !isValidMedicareNumber(form.medicareNumberAtReceipt))
                    }
                  />
                  <span id="referral-mbi-hint" className="wx-form-hint">
                    Optional. Used to help match the patient and prefill HOPE.
                  </span>
                </div>
                <div className="wx-form-field">
                  <label htmlFor="referral-medicaidNumberAtReceipt">Medicaid number</label>
                  <input
                    id="referral-medicaidNumberAtReceipt"
                    value={form.medicaidNumberAtReceipt}
                    onChange={(event) => setField("medicaidNumberAtReceipt", event.target.value)}
                    placeholder="State Medicaid ID"
                    maxLength={24}
                    autoComplete="off"
                    aria-describedby="referral-medicaid-hint"
                    aria-invalid={
                      invalidField === "medicaidNumberAtReceipt" ||
                      (form.medicaidNumberAtReceipt.trim() !== "" &&
                        !isValidMedicaidNumber(form.medicaidNumberAtReceipt))
                    }
                  />
                  <span id="referral-medicaid-hint" className="wx-form-hint">
                    Optional. Helps prefill Medicaid coverage after patient matching.
                  </span>
                </div>
              </div>
            </section>

            <section className="wx-form-section" aria-labelledby="referral-source-heading">
              <div className="wx-form-section-head">
                <span className="wx-form-section-icon" aria-hidden>
                  <Glyph name="building" size={20} />
                </span>
                <div>
                  <h2 id="referral-source-heading">Referral source</h2>
                  <p>How the request arrived and who sent it.</p>
                </div>
              </div>
              <div className="wx-form-grid">
                <div className="wx-form-field">
                  <label htmlFor="referral-source">Source channel</label>
                  <select
                    id="referral-source"
                    value={form.source}
                    onChange={(event) => setField("source", event.target.value)}
                  >
                    {SOURCES.map(([value, sourceLabel]) => (
                      <option key={value} value={value}>
                        {sourceLabel}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="wx-form-field">
                  <label htmlFor="referral-referrerOrganization">Organization or facility</label>
                  <input
                    id="referral-referrerOrganization"
                    value={form.referrerOrganization}
                    onChange={(event) => setField("referrerOrganization", event.target.value)}
                    placeholder="Hospital, clinic, or agency"
                    autoComplete="organization"
                  />
                </div>
                <div className="wx-form-field">
                  <label htmlFor="referral-referrerName">Referrer name</label>
                  <input
                    id="referral-referrerName"
                    value={form.referrerName}
                    onChange={(event) => setField("referrerName", event.target.value)}
                    placeholder="Contact person's name"
                    autoComplete="name"
                  />
                </div>
                <div className="wx-form-field">
                  <label htmlFor="referral-referrerPhone">Referrer phone</label>
                  <input
                    id="referral-referrerPhone"
                    type="tel"
                    inputMode="tel"
                    value={form.referrerPhone}
                    onChange={(event) => setField("referrerPhone", event.target.value)}
                    placeholder="Phone number"
                    autoComplete="tel"
                  />
                </div>
                <div className="wx-form-field wide">
                  <label htmlFor="referral-externalReferralId">External referral ID</label>
                  <input
                    id="referral-externalReferralId"
                    value={form.externalReferralId}
                    onChange={(event) => setField("externalReferralId", event.target.value)}
                    placeholder="Reference from the referring organization"
                  />
                </div>
              </div>
            </section>

            <section className="wx-form-section" aria-labelledby="referral-clinical-heading">
              <div className="wx-form-section-head">
                <span className="wx-form-section-icon" aria-hidden>
                  <Glyph name="clipboard-list" size={20} />
                </span>
                <div>
                  <h2 id="referral-clinical-heading">Clinical context</h2>
                  <p>Briefly describe why hospice evaluation was requested.</p>
                </div>
              </div>
              <div className="wx-form-grid">
                <div className="wx-form-field wide">
                  <label htmlFor="referral-referringDxText">Referral reason or diagnosis</label>
                  <textarea
                    id="referral-referringDxText"
                    value={form.referringDxText}
                    onChange={(event) => setField("referringDxText", event.target.value)}
                    placeholder="Reason for referral, diagnosis, or relevant context"
                    rows={4}
                  />
                  <span className="wx-form-hint">
                    Use the source's wording. Clinical details can be reviewed in the referral
                    workspace.
                  </span>
                </div>
              </div>
            </section>

            <section className="wx-form-section" aria-labelledby="referral-intake-heading">
              <div className="wx-form-section-head">
                <span className="wx-form-section-icon" aria-hidden>
                  <Glyph name="clock" size={20} />
                </span>
                <div>
                  <h2 id="referral-intake-heading">Intake timing</h2>
                  <p>Record when the request was received, even if you enter it later.</p>
                </div>
              </div>
              <div className="wx-form-grid">
                <div className="wx-form-field">
                  <label htmlFor="referral-receivedAt">Received at</label>
                  <input
                    id="referral-receivedAt"
                    type="datetime-local"
                    value={form.receivedAt}
                    onChange={(event) => setField("receivedAt", event.target.value)}
                    required
                    aria-invalid={invalidField === "receivedAt"}
                    aria-describedby={
                      invalidField === "receivedAt" ? "referral-received-error" : undefined
                    }
                  />
                  {invalidField === "receivedAt" ? (
                    <span id="referral-received-error" className="wx-form-error">
                      Enter a valid date and time.
                    </span>
                  ) : null}
                </div>
              </div>
            </section>

            <div className="wx-form-actions">
              <Link to="/referrals" className="wx-btn-secondary">
                Cancel
              </Link>
              <Button type="submit" tone="primary" disabled={busy}>
                <Glyph name="plus" size={16} />
                {busy ? "Creating…" : "Create referral"}
              </Button>
            </div>
          </div>

          <aside className="wx-form-aside" aria-label="Referral intake guidance">
            <div className="wx-form-section-head">
              <span className="wx-form-section-icon" aria-hidden>
                <Glyph name="info" size={20} />
              </span>
              <div>
                <h2>What happens next</h2>
              </div>
            </div>
            <ol>
              <li>The referral opens in the intake workspace.</li>
              <li>Confirm or create the patient, then review clinical information.</li>
              <li>Set priority and ownership before moving toward admission.</li>
            </ol>
          </aside>
        </div>
      </form>
    </div>
  );
}

function errorMessage(err: unknown, fallback: string): string {
  const e = err as { error?: { message?: string; code?: string }; message?: string };
  return e.error?.message ?? e.message ?? fallback;
}
