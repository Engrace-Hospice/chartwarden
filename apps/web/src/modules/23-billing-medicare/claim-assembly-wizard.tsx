import { Glyph, PageHeader, useApiClient } from "@chartwarden/ui";
// apps/web/src/modules/23-billing-medicare — M23 Billing — Medicare, the CLAIM ASSEMBLY screen (R2, §5.1 #4).
// One compact screen (it was a four-step stepper): provider entity + patient + service-date range + Type-of-Bill on
// the left, what the server will assemble on the right. The single server action is the existing route #1 POST
// /api/v1/billing/claims/assemble with the same body as before: it is server-AUTHORITATIVE — it derives the lines,
// the per-diem class + rate and the SIA snapshot, then runs the initial validation_run, all inside one tx. There is
// no client-side dry-run seam, so the summary shows the REQUEST (the inputs the server assembles from), never a
// guessed result. On success the claim opens in the existing editor by id (/billing/claims/:id), which shows the
// lines, pricing and validation outcome. The server is the only authz point (ADR-0030): a 409
// NON_MEDICARE_PRIMARY_PAYER (D15) / PATIENT_NOT_ELECTED, a 422 ASSEMBLY_VALIDATION_FAILED and a 503 (seams unbound,
// fail-closed) each surface inline (role="alert"), never a toast. CSS-var tokens only; tones via billing-status.ts.
import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { BillingTabs } from "../../shell/billing-tabs";
import { PatientLookupField, ProviderEntityLookupField } from "../../shell/entity-lookups";
import { tobLabel } from "./billing-status";
import { assembleErrorMessage } from "./claim-assembly-errors";
import {
  BLOCKING_STATUSES,
  PAYER_PREFLIGHT_MESSAGES,
  type PayerPreflightStatus,
  usePayerPreflight,
} from "./payer-preflight";
import { authFailureRedirect, clearDraft, loadDraft, saveDraft } from "./write-workflow";

// The four assemblable Type-of-Bill codes (§4.1: 817/818 route through :replace / :void, not assembly).
const ASSEMBLABLE_TOBS = ["811", "812", "813", "814"] as const;
type AssemblableTob = (typeof ASSEMBLABLE_TOBS)[number];

interface AssembleResult {
  claimId: string;
}

interface AssemblyForm {
  providerEntityId: string;
  patientId: string;
  serviceFrom: string;
  serviceTo: string;
  tob: AssemblableTob;
}

const EMPTY_FORM: AssemblyForm = {
  providerEntityId: "",
  patientId: "",
  serviceFrom: "",
  serviceTo: "",
  tob: "811",
};

// TASK-021 — the in-progress form survives an in-SPA navigation away and back via the write-workflow draft cache
// (process memory only — see write-workflow.ts for why this can't be sessionStorage/localStorage: patientId is PHI).
const DRAFT_KEY = "claim-assembly-wizard";
interface AssemblyDraft {
  form: AssemblyForm;
}

export function ClaimAssemblyWizard(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [form, setForm] = useState<AssemblyForm>(
    () => loadDraft<AssemblyDraft>(DRAFT_KEY)?.form ?? EMPTY_FORM,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    saveDraft(DRAFT_KEY, { form });
  }, [form]);

  const dateOrderInvalid =
    form.serviceFrom !== "" && form.serviceTo !== "" && form.serviceFrom > form.serviceTo;
  // #851 — early, non-mutating payer check; the assemble call below stays authoritative.
  const { status: payerStatus, retry: retryPayerCheck } = usePayerPreflight(
    form.patientId,
    form.serviceFrom,
    form.serviceTo,
  );
  const payerBlocked = BLOCKING_STATUSES.has(payerStatus);
  // Fail closed while a check is in flight (it always settles to ok / error / blocking, and Retry re-runs it).
  const payerChecking = payerStatus === "loading";
  const valid =
    form.providerEntityId.trim() !== "" &&
    form.patientId.trim() !== "" &&
    form.serviceFrom !== "" &&
    form.serviceTo !== "" &&
    !dateOrderInvalid &&
    !payerBlocked &&
    !payerChecking;

  const assemble = useCallback(async () => {
    setBusy(true);
    setError(null);
    const body = {
      providerEntityId: form.providerEntityId.trim(),
      patientId: form.patientId.trim(),
      serviceFrom: form.serviceFrom,
      serviceTo: form.serviceTo,
      tob: form.tob,
    };
    let outcome: {
      data?: unknown;
      error?: { error?: { code?: string; message?: string } };
      response?: Response;
    };
    try {
      outcome = (await client.POST("/api/v1/billing/claims/assemble", {
        body,
      } as never)) as typeof outcome;
    } catch {
      setError(assembleErrorMessage(undefined, 503));
      setBusy(false);
      return;
    }
    const { data, error: err, response } = outcome;
    if (err || !data) {
      const redirect = authFailureRedirect(
        response?.status,
        err?.error?.code,
        window.location.pathname,
      );
      if (redirect) {
        navigate(redirect);
        return;
      }
      setError(assembleErrorMessage(err?.error?.code, response?.status));
      setBusy(false);
      return;
    }
    clearDraft(DRAFT_KEY);
    navigate(`/billing/claims/${(data as AssembleResult).claimId}`);
  }, [client, form, navigate]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem", padding: "1rem 1.5rem" }}>
      <PageHeader title="Assemble Claim" breadcrumb="Billing / Medicare / New claim">
        <BillingTabs />
      </PageHeader>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && !busy) void assemble();
        }}
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(20rem, 1fr))",
          gap: "1rem",
          alignItems: "start",
        }}
      >
        <section style={sectionStyle} aria-labelledby="assembly-h">
          <h2 id="assembly-h" style={sectionTitleStyle}>
            Claim details
          </h2>
          <p style={hintStyle}>
            The server assembles a DRAFT claim from the elected coverage that spans this
            service-date range — the patient must have an active Medicare hospice election covering
            the period.
          </p>
          <ProviderEntityLookupField
            label="Provider entity"
            value={form.providerEntityId}
            onChange={(v) => setForm((f) => ({ ...f, providerEntityId: v }))}
            required
          />
          <PatientLookupField
            label="Patient"
            value={form.patientId}
            onChange={(v) => setForm((f) => ({ ...f, patientId: v }))}
            required
          />
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(12rem, 1fr))",
              gap: "0.75rem",
            }}
          >
            <LabeledInput
              label="Service from"
              ariaLabel="Service from"
              type="date"
              value={form.serviceFrom}
              onChange={(v) => setForm((f) => ({ ...f, serviceFrom: v }))}
            />
            <LabeledInput
              label="Service to"
              ariaLabel="Service to"
              type="date"
              value={form.serviceTo}
              onChange={(v) => setForm((f) => ({ ...f, serviceTo: v }))}
            />
          </div>
          {dateOrderInvalid ? (
            <p role="alert" style={{ margin: 0, fontSize: "0.8rem", color: "var(--color-error)" }}>
              The service-from date must be on or before the service-to date.
            </p>
          ) : null}
          <PayerPreflightNote status={payerStatus} onRetry={retryPayerCheck} />
          <TobChoice form={form} setForm={setForm} />
        </section>

        <section style={sectionStyle} aria-labelledby="summary-h">
          <h2 id="summary-h" style={sectionTitleStyle}>
            What will be assembled
          </h2>
          <p style={hintStyle}>
            On assemble, the server derives the claim lines, the per-diem class + rate and the SIA
            snapshot from the elected periods, then runs the initial validation. Nothing is written
            until you assemble.
          </p>
          <dl
            style={{
              display: "grid",
              gridTemplateColumns: "auto 1fr",
              gap: "0.4rem 1rem",
              margin: 0,
            }}
          >
            <DtDd label="Provider entity" value={form.providerEntityId || "—"} mono />
            <DtDd label="Patient" value={form.patientId || "—"} mono />
            <DtDd
              label="Service dates"
              value={
                form.serviceFrom || form.serviceTo
                  ? `${form.serviceFrom || "?"} → ${form.serviceTo || "?"}`
                  : "—"
              }
            />
            <DtDd label="Type of bill" value={tobLabel(form.tob)} />
          </dl>
          {error ? (
            <p role="alert" style={{ margin: 0, fontSize: "0.85rem", color: "var(--color-error)" }}>
              {error}
            </p>
          ) : null}
          {!valid && !dateOrderInvalid && !payerBlocked && !payerChecking ? (
            <p style={hintStyle}>Complete provider, patient and both dates to assemble.</p>
          ) : null}
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            <button
              type="submit"
              style={!valid || busy ? disabledButtonStyle : primaryButtonStyle}
              disabled={!valid || busy}
              aria-describedby={payerBlocked ? "payer-preflight" : undefined}
            >
              {busy ? "Assembling…" : "Assemble claim"}
            </button>
            <button
              type="button"
              style={ghostButtonStyle}
              onClick={() => navigate("/billing/claims")}
            >
              Cancel
            </button>
          </div>
        </section>
      </form>
    </div>
  );
}

// The polite live region is ALWAYS mounted (a region inserted together with its text is often not announced), and
// only non-blocking text goes into it; a blocking refusal is a separate role="alert" so it is not announced twice.
function PayerPreflightNote({
  status,
  onRetry,
}: { status: PayerPreflightStatus; onRetry: () => void }): JSX.Element {
  const regionRef = useRef<HTMLOutputElement>(null);
  const message = PAYER_PREFLIGHT_MESSAGES[status];
  const blocking = BLOCKING_STATUSES.has(status);
  return (
    <>
      <output
        ref={regionRef}
        tabIndex={-1}
        aria-atomic="true"
        style={{ ...hintStyle, display: "block", outline: "none" }}
      >
        {message && !blocking ? message : null}
      </output>
      {status === "error" ? (
        <div>
          <button
            type="button"
            style={ghostButtonStyle}
            onClick={() => {
              onRetry();
              // The button unmounts once the retry starts; keep keyboard focus on the live region instead.
              regionRef.current?.focus();
            }}
          >
            Retry payer check
          </button>
        </div>
      ) : null}
      {message && blocking ? (
        <p id="payer-preflight" role="alert" style={{ ...hintStyle, color: "var(--color-error)" }}>
          {message}
        </p>
      ) : null}
    </>
  );
}

// ── Type of Bill: admit-through-discharge, or the interim sequence ────────────────────────────────────────
function TobChoice({
  form,
  setForm,
}: {
  form: AssemblyForm;
  setForm: React.Dispatch<React.SetStateAction<AssemblyForm>>;
}): JSX.Element {
  return (
    <fieldset aria-describedby="tob-help" style={{ border: "none", margin: 0, padding: 0 }}>
      <legend style={{ ...hintStyle, padding: 0, marginBottom: "0.4rem" }}>
        Type of bill — <strong>811</strong> when the whole stay is one claim, or the interim
        sequence (812 first → 813 continuing → 814 last). The server re-derives the final TOB from
        the election timeline and rejects an inconsistent choice.
      </legend>
      <div style={{ display: "grid", gap: "0.5rem" }}>
        {ASSEMBLABLE_TOBS.map((code) => (
          <label
            key={code}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.6rem",
              padding: "0.6rem 0.85rem",
              borderRadius: "var(--radius-md)",
              cursor: "pointer",
              background:
                form.tob === code ? "var(--color-primary-tint)" : "var(--color-surface-low)",
              minHeight: "3rem",
            }}
          >
            <input
              type="radio"
              name="tob"
              value={code}
              checked={form.tob === code}
              onChange={() => setForm((f) => ({ ...f, tob: code }))}
            />
            <span style={{ fontSize: "0.9rem", color: "var(--color-on-surface)" }}>
              {tobLabel(code)}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

// ── shared field primitives ───────────────────────────────────────────────────────────────────────────
function LabeledInput({
  label,
  ariaLabel,
  value,
  onChange,
  placeholder,
  type = "text",
  mono,
}: {
  label: string;
  ariaLabel: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  mono?: boolean;
}): JSX.Element {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
      <span style={{ fontSize: "0.75rem", color: "var(--color-on-surface-variant)" }}>{label}</span>
      <input
        aria-label={ariaLabel}
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={{ ...inputStyle, fontFamily: mono ? "var(--font-mono)" : undefined }}
      />
    </label>
  );
}

function DtDd({
  label,
  value,
  mono,
}: { label: string; value: ReactNode; mono?: boolean }): JSX.Element {
  return (
    <>
      <dt style={{ fontSize: "0.75rem", color: "var(--color-on-surface-variant)" }}>{label}</dt>
      <dd
        style={{
          margin: 0,
          fontSize: "0.85rem",
          color: "var(--color-on-surface)",
          fontFamily: mono ? "var(--font-mono)" : undefined,
          fontVariantNumeric: "tabular-nums",
          wordBreak: "break-all",
        }}
      >
        {value}
      </dd>
    </>
  );
}

const sectionStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.75rem",
  background: "var(--color-surface-lowest)",
  borderRadius: "var(--radius-lg, 0.75rem)",
  boxShadow: "var(--shadow-soft)",
  padding: "1.25rem 1.5rem",
};
const sectionTitleStyle = {
  margin: 0,
  fontFamily: "var(--font-display)",
  fontSize: "1.05rem",
  fontWeight: 500,
  color: "var(--color-on-surface)",
};
const hintStyle = {
  margin: 0,
  fontSize: "0.8rem",
  lineHeight: 1.5,
  color: "var(--color-on-surface-variant)",
};
const inputStyle = {
  height: "2.35rem",
  padding: "0.45rem 0.6rem",
  borderRadius: "var(--radius-md)",
  border: "none",
  background: "var(--color-surface-low)",
  color: "var(--color-on-surface)",
  fontSize: "0.9rem",
  minWidth: "14rem",
};
const primaryButtonStyle = {
  padding: "0.5rem 1rem",
  borderRadius: "var(--radius-md)",
  border: "none",
  cursor: "pointer",
  background: "var(--color-primary)",
  color: "var(--color-on-primary)",
  fontSize: "0.85rem",
  fontWeight: 600,
};
const ghostButtonStyle = {
  padding: "0.5rem 1rem",
  borderRadius: "var(--radius-md)",
  border: "none",
  cursor: "pointer",
  background: "var(--color-surface-container)",
  color: "var(--color-on-surface)",
  fontSize: "0.85rem",
  fontWeight: 600,
};
const disabledButtonStyle = { ...ghostButtonStyle, cursor: "not-allowed", opacity: 0.5 };
