import {
  GateStepper,
  Glyph,
  PageHeader,
  StatusPill,
  StepperWorkflowLayout,
  StickyFooterActions,
  useApiClient,
} from "@chartwarden/ui";
import type { GateItem, GateStatus } from "@chartwarden/ui";
// apps/web/src/modules/23-billing-medicare — M23 Billing — Medicare, the CLAIM ASSEMBLY WIZARD (R2, §5.1 #4).
// The §10 PR-J stepper: pick PE + patient + service-date range → choose / derive the Type-of-Bill → review
// what will be assembled → confirm. The single server action is the existing route #1 POST
// /api/v1/billing/claims/assemble: it is server-AUTHORITATIVE — it derives the lines, the per-diem class + rate,
// and the SIA snapshot, then runs the initial validation_run, all inside one tx. There is no client-side
// dry-run seam, so the wizard's "preview" step reviews the REQUEST (the inputs the server will assemble from)
// and the confirm step surfaces the assembled RESULT (claim id, per-diem class, line count, total, initial validation
// outcome) returned by the route. The server is the only authz point (ADR-0030): a 409
// NON_MEDICARE_PRIMARY_PAYER (D15) / PATIENT_NOT_ELECTED, a 422 ASSEMBLY_VALIDATION_FAILED, and a 503
// (seams unbound, fail-closed) each surface inline (role="alert"), never a toast. Lantern:
// StepperWorkflowLayout + GateStepper steps + StickyFooterActions footer, mono identifiers, CSS-var tokens
// only; status tones flow through billing-status.ts (§6.6).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX, ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { PatientLookupField, ProviderEntityLookupField } from "../../shell/entity-lookups";
import { dollars, statusLabel, tobLabel } from "./billing-status";
import { assembleErrorMessage } from "./claim-assembly-errors";
import { authFailureRedirect, clearDraft, loadDraft, saveDraft } from "./write-workflow";

// The four assemblable Type-of-Bill codes (§4.1: 817/818 route through :replace / :void, not assembly).
const ASSEMBLABLE_TOBS = ["811", "812", "813", "814"] as const;
type AssemblableTob = (typeof ASSEMBLABLE_TOBS)[number];

interface AssembleResult {
  claimId: string;
  state: string;
  totalChargeCents: number;
  perDiemClassCode: string;
  perDiemRateCents: number;
  lineCount: number;
  initialValidationRunId: string;
  initialValidationOutcome: "all_pass" | "failures_present" | "overrides_required";
}

interface WizardForm {
  providerEntityId: string;
  patientId: string;
  serviceFrom: string;
  serviceTo: string;
  tob: AssemblableTob;
}

const EMPTY_FORM: WizardForm = {
  providerEntityId: "",
  patientId: "",
  serviceFrom: "",
  serviceTo: "",
  tob: "811",
};

// TASK-021 — the wizard's in-progress step/form draft (never the assembled `result`, which the server can
// re-derive) survives an in-SPA navigation away and back via the write-workflow draft cache (process memory
// only — see write-workflow.ts for why this can't be sessionStorage/localStorage: patientId is PHI).
const WIZARD_DRAFT_KEY = "claim-assembly-wizard";
interface WizardDraft {
  step: number;
  form: WizardForm;
}

// The §6.6 outcome → tone mapping for the assembled initial validation roll-up.
const OUTCOME_TONE = {
  all_pass: "success",
  failures_present: "error",
  overrides_required: "warning",
} as const;

const STEP_TITLES = ["Identify", "Type of bill", "Preview", "Confirm"] as const;

// A wizard step is `complete` once we have advanced past it, `in-progress` on the active step, else not-started.
function stepStatus(stepIndex: number, activeIndex: number): GateStatus {
  if (stepIndex < activeIndex) return "complete";
  if (stepIndex === activeIndex) return "in-progress";
  return "not-started";
}

export function ClaimAssemblyWizard(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const draft = loadDraft<WizardDraft>(WIZARD_DRAFT_KEY);
  const [step, setStep] = useState(draft?.step ?? 0);
  const [form, setForm] = useState<WizardForm>(draft?.form ?? EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AssembleResult | null>(null);

  // Persist the in-progress draft as the caller types — once assembled there is nothing left to lose
  // (the server-authoritative `result` is what matters, and it clears the draft below).
  useEffect(() => {
    if (!result) saveDraft(WIZARD_DRAFT_KEY, { step, form });
  }, [step, form, result]);

  // Step 1 is complete once all four identifying fields are present; step 2 always has a default TOB.
  const step1Valid =
    form.providerEntityId.trim() !== "" &&
    form.patientId.trim() !== "" &&
    form.serviceFrom !== "" &&
    form.serviceTo !== "" &&
    form.serviceFrom <= form.serviceTo;

  const steps: GateItem[] = useMemo(
    () =>
      STEP_TITLES.map((title, i) => ({
        id: `step-${i}`,
        label: `${i + 1}. ${title}`,
        status: result && i === 3 ? "complete" : stepStatus(i, step),
      })),
    [step, result],
  );

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
    const {
      data,
      error: err,
      response,
    } = (await client.POST("/api/v1/billing/claims/assemble", {
      body,
    } as never)) as {
      data?: unknown;
      error?: { error?: { code?: string; message?: string } };
      response?: Response;
    };
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
    setResult(data as AssembleResult);
    clearDraft(WIZARD_DRAFT_KEY);
    setBusy(false);
  }, [client, form, navigate]);

  return (
    <StepperWorkflowLayout
      header={
        <PageHeader
          title="Assemble Claim"
          breadcrumb="Billing / Medicare / New claim"
          actions={
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
              <Link to="/billing/claims" style={{ ...ghostButtonStyle, textDecoration: "none" }}>
                Claim workbench
              </Link>
              <Link to="/billing" style={{ ...ghostButtonStyle, textDecoration: "none" }}>
                AR dashboard
              </Link>
            </div>
          }
        >
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Build a Medicare claim from server-derived coverage, rates, lines, and initial
            validation.
          </div>
        </PageHeader>
      }
      steps={
        <GateStepper items={steps} ariaLabel="Claim assembly steps" surfaceBlockersFirst={false} />
      }
      context={<WizardContext form={form} />}
      footer={
        <StickyFooterActions>
          {result ? (
            <>
              <button
                type="button"
                style={ghostButtonStyle}
                onClick={() => navigate(`/billing/claims/${result.claimId}`)}
              >
                Open claim editor
              </button>
              <button
                type="button"
                style={primaryButtonStyle}
                onClick={() => navigate(`/billing/claims/${result.claimId}/validation`)}
              >
                Review validation →
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                style={step === 0 ? disabledButtonStyle : ghostButtonStyle}
                disabled={step === 0 || busy}
                onClick={() => setStep((s) => Math.max(0, s - 1))}
              >
                Back
              </button>
              {step < 3 ? (
                <button
                  type="button"
                  style={step === 0 && !step1Valid ? disabledButtonStyle : primaryButtonStyle}
                  disabled={(step === 0 && !step1Valid) || busy}
                  onClick={() => setStep((s) => Math.min(3, s + 1))}
                >
                  Next
                </button>
              ) : (
                <button
                  type="button"
                  style={busy ? disabledButtonStyle : primaryButtonStyle}
                  disabled={busy}
                  onClick={() => void assemble()}
                >
                  {busy ? "Assembling…" : "Assemble claim"}
                </button>
              )}
            </>
          )}
        </StickyFooterActions>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "1rem", maxWidth: "52rem" }}>
        {result ? (
          <AssembledResult result={result} />
        ) : (
          <>
            {step === 0 ? <IdentifyStep form={form} setForm={setForm} valid={step1Valid} /> : null}
            {step === 1 ? <TobStep form={form} setForm={setForm} /> : null}
            {step === 2 ? <PreviewStep form={form} /> : null}
            {step === 3 ? <ConfirmStep form={form} /> : null}
          </>
        )}
        {error ? (
          <p role="alert" style={{ margin: 0, fontSize: "0.85rem", color: "var(--color-error)" }}>
            {error}
          </p>
        ) : null}
      </div>
    </StepperWorkflowLayout>
  );
}

// ── Step 1: identify the provider entity, patient, and service-date range ──────────────────────────────
function IdentifyStep({
  form,
  setForm,
  valid,
}: {
  form: WizardForm;
  setForm: React.Dispatch<React.SetStateAction<WizardForm>>;
  valid: boolean;
}): JSX.Element {
  const dateOrderInvalid =
    form.serviceFrom !== "" && form.serviceTo !== "" && form.serviceFrom > form.serviceTo;
  return (
    <section style={sectionStyle} aria-labelledby="identify-h">
      <h2 id="identify-h" style={sectionTitleStyle}>
        Identify the claim
      </h2>
      <p style={hintStyle}>
        The server assembles a DRAFT claim from the elected coverage that spans this service-date
        range — the patient must have an active Medicare hospice election covering the period.
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
          gridTemplateColumns: "repeat(auto-fit, minmax(14rem, 1fr))",
          gap: "0.75rem",
        }}
      >
        <LabeledInput
          label="Service from"
          ariaLabel="Service date from"
          type="date"
          value={form.serviceFrom}
          onChange={(v) => setForm((f) => ({ ...f, serviceFrom: v }))}
        />
        <LabeledInput
          label="Service to"
          ariaLabel="Service date to"
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
      {!valid && !dateOrderInvalid ? (
        <p style={hintStyle}>Complete all four fields to continue.</p>
      ) : null}
    </section>
  );
}

// ── Step 2: choose / derive the Type of Bill ──────────────────────────────────────────────────────────
function TobStep({
  form,
  setForm,
}: {
  form: WizardForm;
  setForm: React.Dispatch<React.SetStateAction<WizardForm>>;
}): JSX.Element {
  return (
    <section style={sectionStyle} aria-labelledby="tob-h">
      <h2 id="tob-h" style={sectionTitleStyle}>
        Type of bill
      </h2>
      <p style={hintStyle}>
        Choose how this period bills: an <strong>admit-through-discharge</strong> claim (811) when
        the whole stay is in one claim, or the <strong>interim</strong> sequence (812 first → 813
        continuing → 814 last) for an ongoing election. The server re-derives the final TOB from the
        election timeline and rejects an inconsistent choice.
      </p>
      <fieldset style={{ border: "none", margin: 0, padding: 0 }}>
        <legend
          style={{
            position: "absolute",
            width: 1,
            height: 1,
            overflow: "hidden",
            clip: "rect(0 0 0 0)",
          }}
        >
          Type of bill
        </legend>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(16rem, 1fr))",
            gap: "0.5rem",
          }}
        >
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
    </section>
  );
}

// ── Step 3: preview the assembly request (no client dry-run; the server computes lines/per-diem/SIA) ──────
function PreviewStep({ form }: { form: WizardForm }): JSX.Element {
  return (
    <section style={sectionStyle} aria-labelledby="preview-h">
      <h2 id="preview-h" style={sectionTitleStyle}>
        Review before assembly
      </h2>
      <p style={hintStyle}>
        On confirm, the server derives the claim lines, the per-diem class + rate, and the SIA
        snapshot from the elected periods, then runs the initial validation. Nothing is written
        until you confirm.
      </p>
      <dl
        style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "0.4rem 1rem", margin: 0 }}
      >
        <DtDd label="Provider entity" value={form.providerEntityId} mono />
        <DtDd label="Patient" value={form.patientId} mono />
        <DtDd label="Service dates" value={`${form.serviceFrom} → ${form.serviceTo}`} />
        <DtDd label="Type of bill" value={tobLabel(form.tob)} />
      </dl>
    </section>
  );
}

// ── Step 4: confirm ───────────────────────────────────────────────────────────────────────────────────
function ConfirmStep({ form }: { form: WizardForm }): JSX.Element {
  return (
    <section style={sectionStyle} aria-labelledby="confirm-h">
      <h2 id="confirm-h" style={sectionTitleStyle}>
        Confirm assembly
      </h2>
      <p style={hintStyle}>
        Assemble a DRAFT {tobLabel(form.tob)} claim for patient{" "}
        <span style={{ fontFamily: "var(--font-mono)" }}>{form.patientId}</span> over{" "}
        <span style={{ fontVariantNumeric: "tabular-nums" }}>
          {form.serviceFrom} → {form.serviceTo}
        </span>
        . You will then review the initial validation outcome.
      </p>
    </section>
  );
}

// ── assembled result panel (the route #1 response) ────────────────────────────────────────────────────
function AssembledResult({ result }: { result: AssembleResult }): JSX.Element {
  return (
    <section style={sectionStyle} aria-labelledby="assembled-h">
      <h2
        id="assembled-h"
        style={{ ...sectionTitleStyle, display: "flex", alignItems: "center", gap: "0.5rem" }}
      >
        <Glyph name="check-circle" size={18} label="assembled" />
        Draft claim assembled
      </h2>
      <dl
        style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "0.4rem 1rem", margin: 0 }}
      >
        <DtDd label="Claim id" value={result.claimId} mono />
        <DtDd label="State" value={statusLabel(result.state)} />
        <DtDd
          label="Initial validation"
          value={
            <StatusPill
              label={statusLabel(result.initialValidationOutcome)}
              tone={OUTCOME_TONE[result.initialValidationOutcome]}
            />
          }
        />
        <DtDd label="Per-diem class (internal)" value={result.perDiemClassCode} mono />
        <DtDd label="Per-diem rate" value={dollars(result.perDiemRateCents)} />
        <DtDd label="Lines" value={String(result.lineCount)} />
        <DtDd label="Total charge" value={dollars(result.totalChargeCents)} />
      </dl>
      {result.initialValidationOutcome !== "all_pass" ? (
        <p style={hintStyle}>
          The initial run found items to resolve. Open the validation worklist to remediate or
          override before submission.
        </p>
      ) : null}
    </section>
  );
}

// ── right-rail context (echo of the in-progress request) ──────────────────────────────────────────────
function WizardContext({ form }: { form: WizardForm }): JSX.Element {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
      <h3 style={{ ...sectionTitleStyle, fontSize: "0.85rem" }}>Draft so far</h3>
      <ContextLine label="Provider" value={form.providerEntityId || "—"} mono />
      <ContextLine label="Patient" value={form.patientId || "—"} mono />
      <ContextLine
        label="Dates"
        value={
          form.serviceFrom || form.serviceTo
            ? `${form.serviceFrom || "?"} → ${form.serviceTo || "?"}`
            : "—"
        }
      />
      <ContextLine label="TOB" value={tobLabel(form.tob)} />
    </div>
  );
}

function ContextLine({
  label,
  value,
  mono,
}: { label: string; value: string; mono?: boolean }): JSX.Element {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.1rem" }}>
      <span style={{ fontSize: "0.65rem", color: "var(--color-on-surface-variant)" }}>{label}</span>
      <span
        style={{
          fontSize: "0.8rem",
          color: "var(--color-on-surface)",
          fontFamily: mono ? "var(--font-mono)" : undefined,
          wordBreak: "break-all",
        }}
      >
        {value}
      </span>
    </div>
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
