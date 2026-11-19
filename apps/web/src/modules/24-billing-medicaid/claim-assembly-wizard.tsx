import {
  Button,
  ClaimsBillingNotice,
  GateStepper,
  Glyph,
  PageHeader,
  StatusPill,
  StepperWorkflowLayout,
  useApiClient,
  useClaimsBilling,
} from "@chartwarden/ui";
import type { GateItem } from "@chartwarden/ui";
// apps/web/src/modules/24-billing-medicaid — M24, the MEDICAID ASSEMBLY WIZARD (R2, §5.1 #4). The stepped
// draft-creation flow: patient + service range → claim kind (combined / hospice-only / R&B-only) → MCO
// routing preview (from the patient's latest eligibility check) → Medicare coordination notice → assemble.
// The assemble POST is the only write (Idempotency-Key is added server-side by the route guard); the server
// re-resolves payer coverage and the R&B day set, so every preview here is
// advisory and clearly labelled as such. A 503 is the Phase-1 reader deferral (the assembly readers are not
// bound yet) and is surfaced as a precise inline message, not a crash. Lantern: StepperWorkflowLayout +
// GateStepper (§6.5), CSS-var tokens only.
import { useCallback, useMemo, useState } from "react";
import type { JSX } from "react";
import {
  AdmissionLookupField,
  PatientLookupField,
  ProviderEntityLookupField,
} from "../../shell/entity-lookups";
import { MedicaidBillingTabs } from "../../shell/medicaid-billing-tabs";
import { assembleErrorMessage } from "./assembly-errors";
import { ELIGIBILITY_OUTCOME_TONE, humanize, kindLabel, shortId, toneOf } from "./medicaid-status";
import { Card, Field, alertStyle, inputStyle, mutedStyle, selectStyle } from "./medicaid-ui";

type ClaimKind = "combined_hospice_rb" | "hospice_only" | "rb_only";

interface EligibilityCheck {
  id: string;
  patientId: string;
  serviceState: string;
  asOfServiceDate: string;
  outcome: string;
  mcoId: string | null;
  checkedAt: string;
}

const STEP_TITLES = ["Patient & dates", "Claim kind", "Routing", "Confirm"] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function MedicaidAssemblyWizard(): JSX.Element {
  const client = useApiClient();
  const [step, setStep] = useState(0);

  const [patientId, setPatientId] = useState("");
  const [admissionId, setAdmissionId] = useState("");
  const [providerEntityId, setProviderEntityId] = useState("");
  const [serviceFrom, setServiceFrom] = useState("");
  const [serviceTo, setServiceTo] = useState("");
  const [kind, setKind] = useState<ClaimKind>("hospice_only");
  const [rbArrangementId, setRbArrangementId] = useState("");

  const [eligibility, setEligibility] = useState<EligibilityCheck | null>(null);
  const [eligibilityLoadState, setEligibilityLoadState] = useState<
    "idle" | "loading" | "loaded" | "failed"
  >("idle");
  const [busy, setBusy] = useState(false);
  // ADR-0110 — creating a claim is new claims-billing work: paused without the add-on (when enforced).
  const claimsBilling = useClaimsBilling();
  const [error, setError] = useState<string | null>(null);
  const [assembledId, setAssembledId] = useState<string | null>(null);

  const step1Valid =
    UUID_RE.test(patientId) &&
    UUID_RE.test(admissionId) &&
    UUID_RE.test(providerEntityId) &&
    ISO_DATE_RE.test(serviceFrom) &&
    ISO_DATE_RE.test(serviceTo) &&
    serviceFrom <= serviceTo;
  const needsRb = kind !== "hospice_only";
  const step2Valid = !needsRb || UUID_RE.test(rbArrangementId);
  const step3Valid = true; // routing is advisory — the server resolves the real channel (§4.4)
  const step4Valid = true;

  const stepValid = [step1Valid, step2Valid, step3Valid, step4Valid][step] ?? false;

  const gates: GateItem[] = useMemo(
    () =>
      STEP_TITLES.map((title, i) => ({
        id: `step-${i}`,
        label: title,
        status: i < step ? "complete" : i === step ? "in-progress" : "not-started",
      })),
    [step],
  );

  // Advisory eligibility context only. A stored MCO assignment is not a verified payer route, and a
  // missing MCO does not prove fee-for-service. The claim API reports unresolved routing until an
  // authoritative state-program mapping is available.
  const loadRouting = useCallback(async () => {
    setEligibilityLoadState("loading");
    setEligibility(null);
    const res = await client.GET("/api/v1/medicaid-eligibility-checks", {
      params: { query: { patientId } },
    } as never);
    if (res.error) {
      setEligibilityLoadState("failed");
      return;
    }
    const rows = (res.data as unknown as EligibilityCheck[]) ?? [];
    setEligibility(rows[0] ?? null);
    setEligibilityLoadState("loaded");
  }, [client, patientId]);

  const goNext = useCallback(() => {
    if (!stepValid) return;
    const next = step + 1;
    setStep(next);
    if (next === 2 && eligibilityLoadState === "idle") void loadRouting();
  }, [step, stepValid, eligibilityLoadState, loadRouting]);

  const assemble = useCallback(async () => {
    setBusy(true);
    setError(null);
    const body: Record<string, unknown> = {
      patientId,
      admissionId,
      providerEntityId,
      serviceFrom,
      serviceTo,
      kind,
    };
    if (needsRb) body.rbArrangementId = rbArrangementId;
    const {
      data,
      error: err,
      response,
    } = (await client.POST("/api/v1/medicaid-claims", {
      body,
    } as never)) as { data?: unknown; error?: unknown; response?: Response };
    setBusy(false);
    if (err) {
      setError(assembleErrorMessage(response?.status, err));
      return;
    }
    setAssembledId((data as { id?: string } | undefined)?.id ?? null);
  }, [
    client,
    patientId,
    admissionId,
    providerEntityId,
    serviceFrom,
    serviceTo,
    kind,
    needsRb,
    rbArrangementId,
  ]);

  if (assembledId) {
    return (
      <StepperWorkflowLayout
        header={
          <PageHeader
            title="Assemble Medicaid Claim"
            actions={
              <a href="/medicaid/billing/claims" style={linkButtonStyle}>
                Claim workbench
              </a>
            }
          >
            <div style={{ marginTop: "0.75rem" }}>
              <MedicaidBillingTabs />
            </div>
          </PageHeader>
        }
        steps={
          <GateStepper items={gates} surfaceBlockersFirst={false} ariaLabel="Assembly steps" />
        }
      >
        <div style={workspaceStyle}>
          <Card title="Draft assembled">
            <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
              <Glyph name="check" size={16} />
              <span>The draft claim was created. Open it to review lines and validate.</span>
            </div>
            <a href={`/medicaid/billing/claims/${assembledId}`} style={primaryLinkButtonStyle}>
              Open claim
            </a>
          </Card>
        </div>
      </StepperWorkflowLayout>
    );
  }

  return (
    <StepperWorkflowLayout
      header={
        <PageHeader
          title="Assemble Medicaid Claim"
          actions={
            <a href="/medicaid/billing/claims" style={linkButtonStyle}>
              Claim workbench
            </a>
          }
        >
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Assemble a server-authoritative Medicaid draft from patient, episode, and applicable
            R&amp;B inputs.
          </div>
          <div style={{ marginTop: "0.75rem" }}>
            <MedicaidBillingTabs />
          </div>
          <div style={{ marginTop: "0.75rem" }}>
            <ClaimsBillingNotice />
          </div>
        </PageHeader>
      }
      steps={<GateStepper items={gates} surfaceBlockersFirst={false} ariaLabel="Assembly steps" />}
      context={
        <Card title="How assembly works">
          <span style={mutedStyle}>
            Everything previewed here is advisory. At assemble the server re-resolves payer coverage
            and the R&amp;B day set from the record of truth, then runs the validation registry.
          </span>
        </Card>
      }
      footer={
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <Button
            tone="secondary"
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            disabled={step === 0 || busy}
          >
            Back
          </Button>
          {step < STEP_TITLES.length - 1 ? (
            <Button onClick={goNext} disabled={!stepValid}>
              Continue
            </Button>
          ) : (
            <Button
              onClick={() => void assemble()}
              disabled={!stepValid || busy || claimsBilling.blocked}
              loading={busy}
            >
              {busy ? "Assembling…" : "Assemble draft"}
            </Button>
          )}
          {error ? (
            <p role="alert" aria-live="assertive" style={alertStyle}>
              {error}
            </p>
          ) : null}
        </div>
      }
    >
      <div style={workspaceStyle}>
        {step === 0 ? (
          <Card title="Patient and service range">
            <div style={fieldGridStyle}>
              <PatientLookupField
                label="Patient"
                value={patientId}
                // F-066 — changing the patient CLEARS the admission. `step1Valid` only checks that the
                // admission is uuid-shaped, so a stale id from the previously selected patient would
                // have passed every client-side check and assembled a Medicaid claim against another
                // patient's admission. The server re-derives and would refuse, but a wizard that lets
                // you get that far has already made the mistake.
                onChange={(next) => {
                  setPatientId(next);
                  setAdmissionId("");
                }}
                required
              />
              <AdmissionLookupField
                label="Admission"
                value={admissionId}
                onChange={setAdmissionId}
                patientId={patientId}
                required
              />
              <ProviderEntityLookupField
                label="Provider entity"
                value={providerEntityId}
                onChange={setProviderEntityId}
                required
              />
              <TextField
                label="Service from"
                value={serviceFrom}
                onChange={setServiceFrom}
                type="date"
              />
              <TextField label="Service to" value={serviceTo} onChange={setServiceTo} type="date" />
            </div>
            {!step1Valid ? (
              <span style={mutedStyle}>
                Enter the patient, admission, and provider-entity identifiers plus a service range
                that starts on or before it ends.
              </span>
            ) : null}
          </Card>
        ) : null}

        {step === 1 ? (
          <Card title="Claim kind">
            <div style={fieldGridStyle}>
              <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
                <span style={mutedStyle}>Kind</span>
                <select
                  aria-label="Claim kind"
                  value={kind}
                  onChange={(e) => setKind(e.target.value as ClaimKind)}
                  style={selectStyle}
                >
                  <option value="hospice_only">{kindLabel("hospice_only")}</option>
                  <option value="combined_hospice_rb">{kindLabel("combined_hospice_rb")}</option>
                  <option value="rb_only">{kindLabel("rb_only")}</option>
                </select>
              </label>
              {needsRb ? (
                <div>
                  <TextField
                    label="R&B arrangement id"
                    value={rbArrangementId}
                    onChange={setRbArrangementId}
                    mono
                    required
                    hint="Use the arrangement for this patient and provider entity that covers the service dates."
                    error={
                      rbArrangementId.length > 0 && !UUID_RE.test(rbArrangementId)
                        ? "Enter a valid arrangement identifier."
                        : undefined
                    }
                  />
                </div>
              ) : (
                <span style={mutedStyle}>
                  A hospice-only claim carries no NF Room &amp; Board pass-through lines.
                </span>
              )}
            </div>
          </Card>
        ) : null}

        {step === 2 ? (
          <Card title="Routing preview">
            {eligibilityLoadState === "idle" || eligibilityLoadState === "loading" ? (
              <span style={mutedStyle}>Resolving the patient's latest eligibility check…</span>
            ) : eligibilityLoadState === "failed" ? (
              <div role="alert" aria-live="polite" style={{ display: "grid", gap: "0.5rem" }}>
                <span style={mutedStyle}>
                  The eligibility-check history could not be retrieved. This read failure is not an
                  eligibility determination; retry the lookup or continue only using the
                  server-validated billing record.
                </span>
                <Button tone="secondary" size="sm" onClick={() => void loadRouting()}>
                  Retry eligibility history
                </Button>
              </div>
            ) : eligibility ? (
              <>
                <Field
                  label="Latest eligibility"
                  value={
                    <StatusPill
                      label={humanize(eligibility.outcome)}
                      tone={toneOf(ELIGIBILITY_OUTCOME_TONE, eligibility.outcome)}
                    />
                  }
                />
                <Field label="Service state" value={eligibility.serviceState} />
                <Field
                  label="Routes to"
                  value={
                    eligibility.mcoId
                      ? `MCO ${shortId(eligibility.mcoId)} (unverified)`
                      : "State program not determined"
                  }
                />
                <Field label="Checked" value={eligibility.checkedAt.slice(0, 10)} />
              </>
            ) : (
              <span style={mutedStyle}>
                No eligibility check on file for this patient. Assembly will still proceed — the
                validation registry flags a missing or stale check as a finding on the resulting
                claim.
              </span>
            )}
          </Card>
        ) : null}

        {step === 3 ? (
          <Card title="Medicare coordination">
            <span style={mutedStyle}>
              Medicare claim linkage and adjudication evidence are not available on this assembly
              path. A Medicare claim identifier alone does not prove adjudication or payment, so do
              not enter an unrelated claim ID. Secondary Medicaid claim formats remain blocked
              pending the applicable billing policy and COB requirements.
            </span>
            <Field label="Claim kind" value={kindLabel(kind)} />
            <Field label="Service range" value={`${serviceFrom} → ${serviceTo}`} />
            <Field
              label="Routing"
              value={
                eligibility?.mcoId
                  ? `MCO ${shortId(eligibility.mcoId)} (unverified)`
                  : "State program not determined"
              }
            />
          </Card>
        ) : null}
      </div>
    </StepperWorkflowLayout>
  );
}

function TextField({
  label,
  value,
  onChange,
  type,
  mono,
  required = false,
  hint,
  error,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  mono?: boolean;
  required?: boolean;
  hint?: string;
  error?: string;
}): JSX.Element {
  const hintId = `${label.replaceAll(" ", "-")}-hint`;
  const errorId = `${label.replaceAll(" ", "-")}-error`;
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
      <span style={mutedStyle}>
        {label}
        {required ? " (required)" : ""}
      </span>
      <input
        aria-label={label}
        aria-required={required || undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={
          [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined
        }
        type={type ?? "text"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{ ...inputStyle, width: "100%", fontFamily: mono ? "var(--font-mono)" : undefined }}
      />
      {hint ? (
        <span id={hintId} style={mutedStyle}>
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={errorId} role="alert" style={{ color: "var(--color-error)", fontSize: "0.8rem" }}>
          {error}
        </span>
      ) : null}
    </label>
  );
}

const workspaceStyle = {
  width: "100%",
  maxWidth: "52rem",
  display: "flex",
  flexDirection: "column" as const,
  gap: "1rem",
};
const fieldGridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(14rem, 1fr))",
  gap: "0.85rem",
};
const linkButtonStyle = {
  display: "inline-flex",
  alignItems: "center",
  minHeight: "2rem",
  padding: "0.35rem 0.7rem",
  borderRadius: "9999px",
  background: "var(--color-surface-container)",
  color: "var(--color-on-surface)",
  fontSize: "0.75rem",
  fontWeight: 650,
  textDecoration: "none",
};
const primaryLinkButtonStyle = {
  ...linkButtonStyle,
  background: "var(--color-primary)",
  color: "var(--color-on-primary)",
};
