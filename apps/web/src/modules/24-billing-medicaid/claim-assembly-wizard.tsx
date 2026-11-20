import {
  Button,
  ClaimsBillingNotice,
  GateStepper,
  Glyph,
  PageHeader,
  StepperWorkflowLayout,
  useApiClient,
  useClaimsBilling,
} from "@chartwarden/ui";
import type { GateItem } from "@chartwarden/ui";
// apps/web/src/modules/24-billing-medicaid — M24, the MEDICAID ASSEMBLY WIZARD (R2, §5.1 #4). The stepped
// draft-creation flow: patient + service range → server-resolved claim kinds → coverage/R&B/Medicare context
// → review and assemble. The preview is advisory; the assembly service re-resolves payer coverage and R&B
// day ownership before writing. Electronic Medicaid submission is independently unavailable. Lantern:
// StepperWorkflowLayout +
// GateStepper (§6.5), CSS-var tokens only.
import { useCallback, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import {
  AdmissionLookupField,
  PatientLookupField,
  ProviderEntityLookupField,
} from "../../shell/entity-lookups";
import { MedicaidBillingTabs } from "../../shell/medicaid-billing-tabs";
import { assembleErrorMessage } from "./assembly-errors";
import { humanize, kindLabel, shortId } from "./medicaid-status";
import { Card, Field, alertStyle, inputStyle, mutedStyle, selectStyle } from "./medicaid-ui";

type ClaimKind = "combined_hospice_rb" | "hospice_only" | "rb_only";

interface AssemblyPreview {
  primaryCoverage: { status: string; coverageKind: string | null; rank: number | null };
  medicaidCoverage: { status: string; coverageKind: string | null; rank: number | null };
  payerResponsibility: string;
  recordedEligibility: {
    status: "current" | "stale" | "not_recorded" | "unavailable";
    outcome: string | null;
    serviceState: string | null;
    asOfServiceDate: string | null;
    checkedAt: string | null;
    staleAt: string | null;
  };
  claimKinds: {
    kind: ClaimKind;
    payerPolicy: "permitted" | "blocked" | "unresolved";
    reasonCode: string | null;
  }[];
  rbArrangements: {
    id: string;
    facilityName: string;
    effectiveFrom: string;
    effectiveTo: string | null;
    billableDayCount: number;
    status: "candidate" | "blocked" | "unresolved";
    reasonCode: string | null;
  }[];
  arrangementListStatus: "available" | "unavailable";
  medicareEvidence: {
    match: "not_applicable" | "unresolved" | "unavailable" | "none" | "ambiguous" | "single";
    evidenceStatus: string | null;
    rangeRelation: string | null;
    remittanceAdviceRecorded: boolean | null;
  };
  stateBillingPolicy: "not_applicable_to_primary_medicaid" | "unconfirmed" | "unresolved";
  electronicSubmissionAvailable: false;
  isAdvisorySnapshot: true;
}

function coverageLabel(coverage: AssemblyPreview["primaryCoverage"]): string {
  if (coverage.status !== "uniform") return `Unresolved (${humanize(coverage.status)})`;
  const kind = coverage.coverageKind
    ? humanize(coverage.coverageKind)
    : "Coverage type unavailable";
  return `${kind} · rank ${coverage.rank ?? "unknown"} · recorded coverage, not benefit verification`;
}

function responsibilityLabel(value: string): string {
  switch (value) {
    case "medicaid_primary":
      return "Medicaid is the recorded primary payer";
    case "medicare_primary_medicaid_secondary":
      return "Medicare is recorded primary; Medicaid is secondary";
    case "other_primary":
      return "Another payer is recorded primary; Medicaid TPL policy is unresolved";
    default:
      return "Payer responsibility is unresolved for this service period";
  }
}

function medicareEvidenceLabel(preview: AssemblyPreview): string {
  const evidence = preview.medicareEvidence;
  if (evidence.match === "not_applicable") return "Not applicable for the recorded primary payer";
  if (evidence.match === "unresolved")
    return "Payer responsibility unresolved; Medicare evidence applicability is unknown";
  if (evidence.match === "unavailable") return "Medicare evidence reader unavailable";
  if (evidence.match === "none")
    return "No matching Medicare claim is recorded in ChartWarden for this provider, admission, and date range";
  if (evidence.match === "ambiguous")
    return "More than one matching Medicare claim; manual review required";
  const state = evidence.evidenceStatus
    ? humanize(evidence.evidenceStatus)
    : "Evidence status unknown";
  const range = evidence.rangeRelation ? humanize(evidence.rangeRelation) : "range unknown";
  return `${state} · ${range}${evidence.remittanceAdviceRecorded ? " · remittance reference recorded" : " · no remittance reference recorded"}`;
}

const STEP_TITLES = ["Patient & dates", "Claim kind", "Billing context", "Review"] as const;
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

  const [preview, setPreview] = useState<AssemblyPreview | null>(null);
  const [previewLoadState, setPreviewLoadState] = useState<
    "idle" | "loading" | "loaded" | "failed"
  >("idle");
  const previewGeneration = useRef(0);
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
  const kindPreview = preview?.claimKinds.find((candidate) => candidate.kind === kind);
  const arrangementPreview = preview?.rbArrangements.find(
    (candidate) => candidate.id === rbArrangementId,
  );
  const step2Valid =
    previewLoadState === "loaded" &&
    kindPreview?.payerPolicy === "permitted" &&
    (!needsRb || (arrangementPreview?.status === "candidate" && UUID_RE.test(rbArrangementId)));
  const stepValid = [step1Valid, step2Valid, step2Valid, step2Valid][step] ?? false;

  const gates: GateItem[] = useMemo(
    () =>
      STEP_TITLES.map((title, i) => ({
        id: `step-${i}`,
        label: title,
        status: i < step ? "complete" : i === step ? "in-progress" : "not-started",
      })),
    [step],
  );

  const loadPreview = useCallback(async (): Promise<boolean> => {
    const generation = ++previewGeneration.current;
    setPreviewLoadState("loading");
    setPreview(null);
    setRbArrangementId("");
    setError(null);
    try {
      const { data, error: requestError } = (await client.POST(
        "/api/v1/medicaid-claims/assembly-preview",
        {
          body: { patientId, admissionId, providerEntityId, serviceFrom, serviceTo },
        } as never,
      )) as { data?: unknown; error?: unknown };
      if (generation !== previewGeneration.current) return false;
      if (requestError || !data) {
        setPreviewLoadState("failed");
        return false;
      }
      setPreview(data as AssemblyPreview);
      setPreviewLoadState("loaded");
      return true;
    } catch {
      if (generation !== previewGeneration.current) return false;
      setPreviewLoadState("failed");
      return false;
    }
  }, [client, patientId, admissionId, providerEntityId, serviceFrom, serviceTo]);

  const invalidatePreview = useCallback(() => {
    previewGeneration.current += 1;
    setPreview(null);
    setPreviewLoadState("idle");
    setRbArrangementId("");
    setError(null);
    setStep(0);
  }, []);

  const goNext = useCallback(async () => {
    if (step === 0) {
      if (!step1Valid || !(await loadPreview())) return;
      setStep(1);
      return;
    }
    if (!stepValid) return;
    setStep((current) => Math.min(current + 1, STEP_TITLES.length - 1));
  }, [step, step1Valid, stepValid, loadPreview]);

  const assemble = useCallback(async () => {
    if (busy || !step2Valid) return;
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
    try {
      const {
        data,
        error: err,
        response,
      } = (await client.POST("/api/v1/medicaid-claims", {
        body,
      } as never)) as { data?: unknown; error?: unknown; response?: Response };
      if (err) {
        setError(assembleErrorMessage(response?.status, err));
        return;
      }
      const id = (data as { id?: string } | undefined)?.id;
      if (!id) {
        setError(
          "The draft response could not be confirmed. Check the claim workbench before trying again.",
        );
        return;
      }
      setAssembledId(id);
    } catch {
      setError(
        "The draft response could not be confirmed. Check the claim workbench before trying again.",
      );
    } finally {
      setBusy(false);
    }
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
    busy,
    step2Valid,
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
            The server resolves payer responsibility and current R&amp;B candidates for this tenant,
            provider, admission, and date range. This snapshot is advisory; assembly rechecks
            coverage and day ownership. Medicaid electronic submission is unavailable.
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
            <Button
              onClick={goNext}
              disabled={!stepValid || (step === 0 && previewLoadState === "loading")}
            >
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
                  invalidatePreview();
                }}
                required
              />
              <AdmissionLookupField
                label="Admission"
                value={admissionId}
                onChange={(next) => {
                  setAdmissionId(next);
                  invalidatePreview();
                }}
                patientId={patientId}
                required
              />
              <ProviderEntityLookupField
                label="Provider entity"
                value={providerEntityId}
                onChange={(next) => {
                  setProviderEntityId(next);
                  setAdmissionId("");
                  invalidatePreview();
                }}
                required
              />
              <TextField
                label="Service from"
                value={serviceFrom}
                onChange={(next) => {
                  setServiceFrom(next);
                  invalidatePreview();
                }}
                type="date"
                required
              />
              <TextField
                label="Service to"
                value={serviceTo}
                onChange={(next) => {
                  setServiceTo(next);
                  invalidatePreview();
                }}
                type="date"
                required
              />
            </div>
            {!step1Valid ? (
              <output aria-live="polite" style={mutedStyle}>
                Enter the patient, admission, and provider-entity identifiers plus a service range
                with both dates, starting on or before the end date.
              </output>
            ) : null}
            <output aria-live="polite" style={{ display: "block", marginTop: "0.75rem" }}>
              {previewLoadState === "loading" ? (
                <span style={mutedStyle}>Checking payer responsibility and R&amp;B records…</span>
              ) : previewLoadState === "failed" ? (
                <span style={{ color: "var(--color-error)" }}>
                  The billing preview could not be loaded. No eligibility or payer conclusion was
                  made. Retry after confirming the selected records.
                </span>
              ) : previewLoadState === "loaded" ? (
                <span style={mutedStyle}>Server preview loaded for this service window.</span>
              ) : null}
            </output>
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
                  onChange={(e) => {
                    const nextKind = e.target.value as ClaimKind;
                    setKind(nextKind);
                    if (nextKind === "hospice_only") setRbArrangementId("");
                    setError(null);
                  }}
                  style={selectStyle}
                >
                  {preview?.claimKinds.map((candidate) => (
                    <option
                      key={candidate.kind}
                      value={candidate.kind}
                      disabled={candidate.payerPolicy !== "permitted"}
                    >
                      {kindLabel(candidate.kind)}
                      {candidate.payerPolicy === "permitted"
                        ? ""
                        : ` — ${candidate.reasonCode ? assembleErrorMessage(undefined, { error: { code: candidate.reasonCode } }) : "availability unresolved"}`}
                    </option>
                  )) ?? <option value={kind}>{kindLabel(kind)}</option>}
                </select>
              </label>
              {previewLoadState !== "loaded" ? (
                <p style={mutedStyle}>
                  Load the server preview from the first step to see available claim kinds.
                </p>
              ) : kindPreview?.payerPolicy !== "permitted" ? (
                <output aria-live="polite" style={{ ...alertStyle, display: "block" }}>
                  {kindPreview?.reasonCode
                    ? assembleErrorMessage(undefined, { error: { code: kindPreview.reasonCode } })
                    : "Payer responsibility is unresolved for this range."}
                </output>
              ) : (
                <p style={mutedStyle}>
                  This claim kind passes the current payer-responsibility policy. Clinical, rate,
                  arrangement, and state-format checks still apply.
                </p>
              )}
              {needsRb ? (
                <div>
                  <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
                    <span style={mutedStyle}>Room &amp; Board arrangement (required)</span>
                    <select
                      aria-label="Room and Board arrangement"
                      aria-required="true"
                      value={rbArrangementId}
                      onChange={(event) => setRbArrangementId(event.target.value)}
                      style={selectStyle}
                      disabled={previewLoadState !== "loaded"}
                    >
                      <option value="">Select an arrangement</option>
                      {preview?.rbArrangements.map((arrangement) => (
                        <option
                          key={arrangement.id}
                          value={arrangement.id}
                          disabled={arrangement.status !== "candidate"}
                        >
                          {arrangement.facilityName} · {arrangement.effectiveFrom}
                          {arrangement.effectiveTo ? ` to ${arrangement.effectiveTo}` : " onward"}
                          {arrangement.status === "candidate"
                            ? ` · ${arrangement.billableDayCount} available day${arrangement.billableDayCount === 1 ? "" : "s"}`
                            : " · unavailable"}
                        </option>
                      ))}
                    </select>
                  </label>
                  {arrangementPreview?.reasonCode ? (
                    <output aria-live="polite" style={mutedStyle}>
                      {assembleErrorMessage(undefined, {
                        error: { code: arrangementPreview.reasonCode },
                      })}
                    </output>
                  ) : null}
                  {previewLoadState === "loaded" &&
                  preview?.arrangementListStatus === "unavailable" ? (
                    <output aria-live="polite" style={{ ...mutedStyle, display: "block" }}>
                      Room &amp; Board candidates could not be determined because required admission
                      or level-of-care records are unavailable. No arrangement was treated as
                      billable.
                    </output>
                  ) : null}
                  {previewLoadState === "loaded" &&
                  preview?.arrangementListStatus === "available" ? (
                    <output aria-live="polite" style={{ ...mutedStyle, display: "block" }}>
                      An arrangement candidate has a stored contract reference; this preview does
                      not verify the M22 document type, active status, or signature.
                    </output>
                  ) : null}
                  {previewLoadState === "loaded"
                    ? preview?.rbArrangements
                        .filter(
                          (arrangement) =>
                            arrangement.status !== "candidate" && arrangement.reasonCode,
                        )
                        .map((arrangement) => (
                          <output
                            key={arrangement.id}
                            aria-live="polite"
                            style={{ ...mutedStyle, display: "block" }}
                          >
                            {arrangement.facilityName}:{" "}
                            {assembleErrorMessage(undefined, {
                              error: { code: arrangement.reasonCode },
                            })}
                          </output>
                        ))
                    : null}
                  {previewLoadState === "loaded" && preview?.rbArrangements.length === 0 ? (
                    <span style={mutedStyle}>
                      No arrangement overlaps this patient, provider, and service period.
                    </span>
                  ) : null}
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
          <Card title="Coverage and coordination">
            {previewLoadState === "failed" ? (
              <p role="alert" aria-live="assertive" style={alertStyle}>
                The billing preview failed. No claim or Room &amp; Board day was changed. Go back
                and retry.
              </p>
            ) : preview ? (
              <div style={{ display: "grid", gap: "0.75rem" }}>
                <Field label="Medicaid coverage" value={coverageLabel(preview.medicaidCoverage)} />
                <Field label="Primary coverage" value={coverageLabel(preview.primaryCoverage)} />
                <Field
                  label="Payer responsibility"
                  value={responsibilityLabel(preview.payerResponsibility)}
                />
                <Field
                  label="Recorded eligibility check"
                  value={
                    preview.recordedEligibility.status === "unavailable"
                      ? "Coverage is unresolved; no matching eligibility check can be identified"
                      : preview.recordedEligibility.status === "not_recorded"
                        ? "No check recorded for this Medicaid coverage and service range"
                        : `${humanize(preview.recordedEligibility.outcome ?? "unknown")} · ${preview.recordedEligibility.asOfServiceDate ?? "date unavailable"} · ${preview.recordedEligibility.status === "stale" ? "stale recorded result" : "current recorded result"}; not benefit verification`
                  }
                />
                {preview.recordedEligibility.serviceState ? (
                  <Field
                    label="Recorded service state"
                    value={preview.recordedEligibility.serviceState}
                  />
                ) : null}
                <Field label="Medicare claim evidence" value={medicareEvidenceLabel(preview)} />
                <Field
                  label="State secondary billing policy"
                  value={
                    preview.stateBillingPolicy === "not_applicable_to_primary_medicaid"
                      ? "Secondary COB policy does not apply to the recorded primary Medicaid scenario"
                      : preview.stateBillingPolicy === "unresolved"
                        ? "Cannot assess until payer responsibility is resolved"
                        : "Unconfirmed; secondary Medicaid claim formats remain unavailable"
                  }
                />
                {needsRb ? (
                  <Field
                    label="Selected R&B arrangement"
                    value={
                      arrangementPreview
                        ? `${arrangementPreview.facilityName} · ${arrangementPreview.billableDayCount} currently available day${arrangementPreview.billableDayCount === 1 ? "" : "s"}`
                        : "Select a server-listed arrangement in the previous step"
                    }
                  />
                ) : null}
                <output aria-live="polite" style={{ ...mutedStyle, display: "block" }}>
                  The preview does not reserve days or authorize transmission. Electronic Medicaid
                  submission is unavailable.
                </output>
              </div>
            ) : (
              <output aria-live="polite" style={{ ...mutedStyle, display: "block" }}>
                Load the server preview from the patient and dates step first.
              </output>
            )}
          </Card>
        ) : null}

        {step === 3 ? (
          <Card title="Review draft request">
            <div style={{ display: "grid", gap: "0.5rem" }}>
              <Field label="Patient" value={shortId(patientId)} />
              <Field label="Admission" value={shortId(admissionId)} />
              <Field label="Provider entity" value={shortId(providerEntityId)} />
              <Field label="Service period" value={`${serviceFrom} → ${serviceTo}`} />
              <Field label="Claim kind" value={kindLabel(kind)} />
              <Field
                label="Payer responsibility"
                value={
                  preview ? responsibilityLabel(preview.payerResponsibility) : "Preview unavailable"
                }
              />
              {needsRb ? (
                <Field
                  label="Room & Board arrangement"
                  value={
                    arrangementPreview
                      ? `${arrangementPreview.facilityName} · ${arrangementPreview.billableDayCount} days shown as available in the preview`
                      : "No valid arrangement selected"
                  }
                />
              ) : null}
              <Field
                label="Medicare evidence"
                value={preview ? medicareEvidenceLabel(preview) : "Unavailable"}
              />
              <output aria-live="polite" style={{ ...mutedStyle, display: "block" }}>
                Assembling creates a draft only; it does not submit to Medicaid or establish
                Medicare adjudication. The server revalidates coverage and day ownership. If this is
                an R&amp;B claim, assembly assigns the currently available days shown above to the
                draft. If the draft is later abandoned, those days require reconciliation before
                reuse and are not automatically released.
              </output>
            </div>
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
