import {
  Button,
  GateStepper,
  Glyph,
  PageHeader,
  StatusPill,
  StepperWorkflowLayout,
  useApiClient,
} from "@wardenx/ui";
import type { GateItem } from "@wardenx/ui";
// apps/web/src/modules/24-billing-medicaid — M24, the MEDICAID ASSEMBLY WIZARD (R2, §5.1 #4). The stepped
// draft-creation flow: patient + service range → claim kind (combined / hospice-only / R&B-only) → MCO
// routing preview (from the patient's latest eligibility check) → COB confirmation when a Medicare primary
// is asserted → assemble. The assemble POST is the only write (Idempotency-Key is added server-side by the
// route guard); the server re-derives eligibility, R&B days, and the COB chain, so every preview here is
// advisory and clearly labelled as such. A 503 is the Phase-1 reader deferral (the assembly readers are not
// bound yet) and is surfaced as a precise inline message, not a crash. Lantern: StepperWorkflowLayout +
// GateStepper (§6.5), CSS-var tokens only.
import { useCallback, useMemo, useState } from "react";
import type { JSX } from "react";
import {
  AdmissionLookupField,
  PatientLookupField,
  ProviderEntityLookupField,
} from "../../shared/entity-lookups";
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
  const [medicareClaimId, setMedicareClaimId] = useState("");

  const [eligibility, setEligibility] = useState<EligibilityCheck | null>(null);
  const [eligibilityChecked, setEligibilityChecked] = useState(false);
  const [busy, setBusy] = useState(false);
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
  const cobAsserted = medicareClaimId.length > 0;
  const step4Valid = !cobAsserted || UUID_RE.test(medicareClaimId);

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

  // Advisory routing preview: the patient's most recent eligibility check tells the biller whether the
  // claim will route to an MCO or to fee-for-service MMIS. The server re-derives this at assembly.
  const loadRouting = useCallback(async () => {
    setEligibilityChecked(true);
    setEligibility(null);
    const res = await client.GET("/api/v1/medicaid-eligibility-checks", {
      params: { query: { patientId } },
    } as never);
    if (res.error) return;
    const rows = (res.data as unknown as EligibilityCheck[]) ?? [];
    setEligibility(rows[0] ?? null);
  }, [client, patientId]);

  const goNext = useCallback(() => {
    if (!stepValid) return;
    const next = step + 1;
    setStep(next);
    if (next === 2 && !eligibilityChecked) void loadRouting();
  }, [step, stepValid, eligibilityChecked, loadRouting]);

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
    if (cobAsserted) body.medicareClaimId = medicareClaimId;
    const {
      data,
      error: err,
      response,
    } = (await client.POST("/api/v1/medicaid-claims", {
      body,
    } as never)) as { data?: unknown; error?: unknown; response?: Response };
    setBusy(false);
    if (err) {
      setError(assembleErrorMessage(response?.status));
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
    cobAsserted,
    medicareClaimId,
  ]);

  if (assembledId) {
    return (
      <StepperWorkflowLayout
        header={
          <PageHeader
            title="Assemble Medicaid Claim"
            breadcrumb="Billing / Medicaid / Claim assembly"
            actions={
              <a href="/medicaid/billing/claims" style={linkButtonStyle}>
                Claim workbench
              </a>
            }
          />
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
          breadcrumb={`Billing / Medicaid / Step ${step + 1} of ${STEP_TITLES.length}`}
          actions={
            <a href="/medicaid/billing/claims" style={linkButtonStyle}>
              Claim workbench
            </a>
          }
        >
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Assemble a server-authoritative Medicaid draft from patient, episode, R&B, and COB
            inputs.
          </div>
        </PageHeader>
      }
      steps={<GateStepper items={gates} surfaceBlockersFirst={false} ariaLabel="Assembly steps" />}
      context={
        <Card title="How assembly works">
          <span style={mutedStyle}>
            Everything previewed here is advisory. At assemble the server re-derives eligibility,
            the R&amp;B day set, and the COB chain from the record of truth, then runs the
            validation registry.
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
            <Button onClick={() => void assemble()} disabled={!stepValid || busy} loading={busy}>
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
                onChange={setPatientId}
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
                <TextField
                  label="R&B arrangement id"
                  value={rbArrangementId}
                  onChange={setRbArrangementId}
                  mono
                />
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
            {!eligibilityChecked ? (
              <span style={mutedStyle}>Resolving the patient's latest eligibility check…</span>
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
                    eligibility.mcoId ? `MCO ${shortId(eligibility.mcoId)}` : "Fee-for-service MMIS"
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
          <Card title="Coordination of benefits">
            <span style={mutedStyle}>
              If this patient is dual-eligible, link the Medicare (M23) claim that adjudicated
              first. Leave it blank for a Medicaid-primary claim.
            </span>
            <TextField
              label="Medicare claim id (optional)"
              value={medicareClaimId}
              onChange={setMedicareClaimId}
              mono
            />
            <Field label="Claim kind" value={kindLabel(kind)} />
            <Field label="Service range" value={`${serviceFrom} → ${serviceTo}`} />
            <Field
              label="Routing"
              value={
                eligibility?.mcoId ? `MCO ${shortId(eligibility.mcoId)}` : "Fee-for-service MMIS"
              }
            />
            {cobAsserted && !step4Valid ? (
              <span style={alertStyle}>The Medicare claim id must be a valid identifier.</span>
            ) : null}
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
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  mono?: boolean;
}): JSX.Element {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
      <span style={mutedStyle}>{label}</span>
      <input
        aria-label={label}
        type={type ?? "text"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{ ...inputStyle, width: "100%", fontFamily: mono ? "var(--font-mono)" : undefined }}
      />
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

/** Map an assemble status code to a precise, PHI-free inline message (§5.4). */
function assembleErrorMessage(status: number | undefined): string {
  if (status === 409) return "A claim already covers this patient and service range.";
  if (status === 422) return "The service range or R&B arrangement is not valid for this patient.";
  if (status === 401 || status === 403)
    return "You lack permission to assemble claims for this entity.";
  if (status === 503)
    return "Claim assembly is unavailable — the upstream clinical readers are not bound in this environment.";
  return "The claim could not be assembled.";
}
