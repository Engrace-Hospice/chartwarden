import {
  EmptyState,
  Glyph,
  InfoRows,
  InlineAlert,
  LoadingSpinner,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/06-admission — Discharge / Revocation / Transfer-out workflow (M6 routes 36/37/39).
// Spec: docs/design/screens/clinical/WARDENX_UI_DISCHARGE_REVOCATION_TRANSFER.md — "Patient Workspace +
// Stepper": 1 reason → 2 reason-specific data → 3 effective date → 4 review cascades → 5 confirm.
// Drawn in the 2026-09-25 redesign idiom (the same primitives the HOPE workspace uses, shared with the
// other end-of-episode workflows through end-of-episode-ui.tsx): patient banner, a step navigator on the
// left, flat clinical sections in the centre, cascades/compliance in the right context rail. The reasons,
// validation, error map and cascades live in discharge-workflow-model.ts.
//
// The SERVER stays authoritative for everything this screen pre-checks: route 39 derives its permission
// key from `reason` (discharge/permission-map.ts) and re-applies the per-reason narrative gates; the
// date order and the one-transfer-per-period rule are state-machine guards. The client checks mirror
// them only so a clinician learns about a problem before submitting, and every server code is mapped to
// a human message.
//
// Out of scope here (other workflows own them): death (Death / Pronouncement workflow), the for-cause
// medical-director cosign (route 40), and transfer-in (a new admission).
import { type JSX, useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { fmtDate } from "../../shell/patient-context";
import { useSession } from "../../shell/session";
import { DISCHARGEABLE_STATES, stateLabel } from "./admission-status";
import {
  type DischargeOrderDraft,
  DischargeOrderFields,
  dischargeOrderBody,
  dischargeOrderComplete,
  dischargeOrderRequiredAtFiling,
  emptyDischargeOrder,
} from "./discharge-order-ui";
import {
  EMPTY_FORM,
  type EndReason,
  type FormState,
  NOTR_DUE_DAYS,
  REASON_BY_VALUE,
  type RevocationReason,
  STEPS,
  type StepId,
  attestationText,
  careSettingLabel,
  cascadeItems,
  messageForError,
  noticeVerb,
  submitLabel,
  validateDate,
  validateDetails,
} from "./discharge-workflow-model";
import { DischargeDetailsStep, ReasonStep } from "./discharge-workflow-steps";
import {
  AdmissionPanel,
  AttestTile,
  EpisodeWorkspace,
  Field,
  LockedField,
  type NavStep,
  ReviewList,
  Section,
  StepNav,
  WhatHappensList,
  WhatHappensPanel,
  WorkflowFooter,
  WorkflowHead,
  addDays,
  bodyText,
  dateOnly,
  errorCodeOf,
  localToday,
  useEpisodeAdmission,
} from "./end-of-episode-ui";
import { authFailureRedirect } from "./write-workflow";

const TITLE = "Discharge, revocation or transfer";

interface PeriodView {
  id: string;
  state: string;
  sequenceNumber: number;
  effectiveAt: string | null;
}

/** What route 39 answers for a for-cause filing (MutationResult): the discharge the cosign acts on. */
interface PendingCosign {
  dischargeId: string;
  version: number;
}

/** Best-effort context for the rail: the benefit period this action closes. */
function useActivePeriod(patientId: string | undefined): PeriodView | null {
  const client = useApiClient();
  const [period, setPeriod] = useState<PeriodView | null>(null);
  useEffect(() => {
    if (!patientId) return;
    let active = true;
    void client
      .GET("/api/v1/patients/{patientId}/election-certification", {
        params: { path: { patientId } },
      })
      .then((ec) => {
        const periods = (ec.data as { periods?: PeriodView[] } | undefined)?.periods ?? [];
        if (active) setPeriod(periods.find((p) => p.state === "active") ?? null);
      })
      .catch(() => {
        if (active) setPeriod(null);
      });
    return () => {
      active = false;
    };
  }, [client, patientId]);
  return period;
}

export function DischargeWorkflow(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const session = useSession();
  const { id } = useParams<{ id: string }>();
  const admission = useEpisodeAdmission(id);
  const period = useActivePeriod(
    admission && admission !== "error" ? admission.patientId : undefined,
  );
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [step, setStep] = useState<StepId>("reason");
  const [showErrors, setShowErrors] = useState<Partial<Record<StepId, boolean>>>({});
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [pendingCosign, setPendingCosign] = useState<PendingCosign | null>(null);
  // 42 CFR 418.26(b) (FY 2027) — the physician discharge order a live discharge must carry at filing.
  const [dischargeOrder, setDischargeOrder] = useState<DischargeOrderDraft>(emptyDischargeOrder);
  const today = localToday();

  const def = form.reason ? REASON_BY_VALUE.get(form.reason) : undefined;
  const admissionDate =
    admission && admission !== "error" ? dateOnly(admission.admissionAt) || null : null;
  const detailErrors = useMemo(() => validateDetails(form), [form]);
  const dateError = validateDate(form.date, admissionDate, today);
  // Only route 39 (`/discharge`) takes the order; death, for-cause (the cosign is the order), revocation and
  // transfer-out never do. `form.date` decides the pre/post 2026-10-01 rule.
  const takesDischargeOrder = def?.endpoint === "discharge" && def.value !== "for_cause";
  const orderRequired =
    takesDischargeOrder &&
    Boolean(form.date) &&
    dischargeOrderRequiredAtFiling(def.value, form.date);
  const orderMissing = orderRequired && !dischargeOrderComplete(dischargeOrder);
  const valid: Record<StepId, boolean> = {
    reason: Boolean(def),
    details: Boolean(def) && Object.keys(detailErrors).length === 0,
    date: dateError === null && !orderMissing,
    review: true,
    confirm: form.attested,
  };
  const order = STEPS.map((s) => s.id);
  const reachable = (target: StepId): boolean =>
    order.slice(0, order.indexOf(target)).every((s) => valid[s]);
  const can = (permission: string): boolean =>
    !session?.permissions || session.permissions.includes(permission);

  const update = <K extends keyof FormState>(key: K, value: FormState[K]): void => {
    setForm((f) => ({ ...f, [key]: value }));
    setSubmitError(null);
  };
  const chooseReason = (reason: EndReason): void => {
    // The narrative is kept across a reason switch (e.g. moved → transfer out) — it is the same story.
    setForm((f) => ({ ...f, reason, attested: false }));
    setSubmitError(null);
  };
  const goNext = (): void => {
    if (!valid[step]) {
      setShowErrors((s) => ({ ...s, [step]: true }));
      return;
    }
    const next = order[order.indexOf(step) + 1];
    if (next) setStep(next);
  };
  const goBack = (): void => {
    const prev = order[order.indexOf(step) - 1];
    if (prev) setStep(prev);
  };

  const post = useCallback(async () => {
    if (!id || !def) return null;
    const narrative = form.narrative.trim();
    if (def.endpoint === "revocation")
      return client.POST("/api/v1/admissions/{id}/revocation", {
        params: { path: { id } },
        body: {
          revocationDate: form.date,
          narrative,
          signingPatientName: form.signingPatientName.trim(),
          signingRole: form.signingRole,
          revocationReason: form.revocationReason as RevocationReason,
        },
      });
    if (def.endpoint === "transfer-out") {
      const ccn = form.otherHospiceCcn.trim();
      return client.POST("/api/v1/admissions/{id}/transfer-out", {
        params: { path: { id } },
        body: {
          direction: "out",
          effectiveDate: form.date,
          otherHospiceName: form.otherHospiceName.trim(),
          ...(ccn ? { otherHospiceCcn: ccn } : {}),
          receivingCareSetting: form.receivingCareSetting as "home" | "facility",
          narrative,
        },
      });
    }
    const orderBody = takesDischargeOrder ? dischargeOrderBody(dischargeOrder) : undefined;
    return client.POST("/api/v1/admissions/{id}/discharge", {
      params: { path: { id } },
      body: {
        reason: def.value as
          | "moved_out_of_service_area"
          | "no_longer_terminal"
          | "for_cause"
          | "other",
        dischargeDate: form.date,
        narrative,
        ...(def.value === "for_cause" ? { forCauseReason: form.forCauseReason.trim() } : {}),
        ...(orderBody ? { dischargeOrder: orderBody } : {}),
      },
    });
  }, [id, def, form, client, takesDischargeOrder, dischargeOrder]);

  const submit = useCallback(async () => {
    if (!id || !def) return;
    setBusy(true);
    setSubmitError(null);
    const result = (await post()) as {
      data?: unknown;
      error?: unknown;
      response?: Response;
    } | null;
    if (!result) return;
    if (result.error) {
      const status = result.response?.status;
      const code = errorCodeOf(result.error);
      const redirect = authFailureRedirect(status, code, window.location.pathname);
      if (redirect) {
        navigate(redirect);
        return;
      }
      setBusy(false);
      setSubmitError(messageForError(status, code));
      return;
    }
    setBusy(false);
    const data = result.data as
      | { id?: string; version?: number; requiresMedicalDirectorCosign?: boolean }
      | undefined;
    if (data?.requiresMedicalDirectorCosign) {
      setPendingCosign({ dischargeId: data.id ?? "", version: data.version ?? 0 });
      return;
    }
    navigate(`/admissions/${id}`, {
      state: { notice: `${noticeVerb(def.value)} effective ${fmtDate(form.date)}.` },
    });
  }, [id, def, form.date, post, navigate]);

  if (admission === null) return <LoadingSpinner />;
  if (admission === "error")
    return (
      <EmptyState title="Unavailable" description="Admission not found or not visible to you." />
    );

  const backTo = `/admissions/${admission.id}`;
  const rail = (
    <>
      <AdmissionPanel
        admission={admission}
        extra={[
          {
            label: "Benefit period",
            value: period
              ? `Period ${period.sequenceNumber}${period.effectiveAt ? ` · from ${fmtDate(period.effectiveAt)}` : ""}`
              : "—",
          },
        ]}
      />
      <WhatHappensPanel>
        {def ? (
          <WhatHappensList items={cascadeItems(def.value, form.date || null)} compact />
        ) : (
          <p className="wx-rail-empty" style={{ padding: 0 }}>
            Choose a reason to see what this action changes.
          </p>
        )}
      </WhatHappensPanel>
      {def && def.value !== "for_cause" ? (
        <WhatHappensPanel title="Filing window">
          <InfoRows
            labelWidth="7rem"
            rows={[
              {
                label: "NOTR due",
                value: form.date
                  ? fmtDate(addDays(form.date, NOTR_DUE_DAYS))
                  : "5 days after the date",
                hint: "42 CFR 418.26 — 5 calendar days from the effective date.",
              },
            ]}
          />
        </WhatHappensPanel>
      ) : null}
    </>
  );
  const frame = (body: JSX.Element) => (
    <EpisodeWorkspace patientId={admission.patientId} backTo={backTo} rail={rail}>
      {body}
    </EpisodeWorkspace>
  );

  if (pendingCosign && def)
    return frame(
      <div className="wx-hope-main" style={{ paddingBottom: "1.5rem" }}>
        <WorkflowHead title={TITLE} />
        <PendingCosignSection
          admissionId={admission.id}
          admissionState={admission.state}
          pending={pendingCosign}
        />
      </div>,
    );

  if (!DISCHARGEABLE_STATES.has(admission.state))
    return frame(
      <div className="wx-hope-main" style={{ paddingBottom: "1.5rem" }}>
        <WorkflowHead title={TITLE} />
        <InlineAlert tone="info">
          This admission is {stateLabel(admission.state).toLowerCase()}. Only an active or on-hold
          admission can be discharged, revoked, or transferred out.
        </InlineAlert>
      </div>,
    );

  const navSteps: NavStep[] = STEPS.map((s) => {
    const open = reachable(s.id);
    if (s.id === "review")
      return open
        ? { ...s, state: "complete", line: "Ready", open }
        : { ...s, state: "empty", line: "Not started", open };
    if (valid[s.id]) return { ...s, state: "complete", line: "Complete", open };
    if (showErrors[s.id]) return { ...s, state: "attention", line: "Needs attention", open };
    return { ...s, state: "empty", line: "Not started", open };
  });

  return frame(
    <div className="wx-hope-workspace">
      <StepNav
        label="Discharge steps"
        heading="End of service"
        steps={navSteps}
        activeId={step}
        onSelect={(s) => setStep(s as StepId)}
      />
      <main className="wx-hope-main">
        <WorkflowHead
          title={TITLE}
          stepLine={`Step ${order.indexOf(step) + 1} of ${STEPS.length} · ${STEPS.find((s) => s.id === step)?.title}`}
          detail={def?.label}
        />

        {step === "reason" ? (
          <ReasonStep
            reason={form.reason}
            can={can}
            showError={Boolean(showErrors.reason) && !def}
            onChoose={chooseReason}
          />
        ) : null}

        {step === "details" && def ? (
          <DischargeDetailsStep
            def={def}
            form={form}
            errors={showErrors.details ? detailErrors : {}}
            canTransfer={can("transfer.out")}
            onSwitchToTransfer={() => chooseReason("transfer_out")}
            update={update}
          />
        ) : null}

        {step === "date" && def ? (
          <Section
            icon="calendar"
            title={def.dateLabel}
            description="On or after the admission date, and not in the future."
          >
            <div className="wx-field-grid">
              <Field
                id="dw-date"
                label={def.dateLabel}
                required
                error={showErrors.date ? (dateError ?? undefined) : undefined}
              >
                <input
                  id="dw-date"
                  type="date"
                  value={form.date}
                  min={admissionDate ?? undefined}
                  max={today}
                  onChange={(e) => update("date", e.target.value)}
                />
              </Field>
              <LockedField
                id="dw-admitted"
                label="Admission date"
                value={admissionDate ? fmtDate(admissionDate) : "Not recorded"}
                source="From the admission record"
              />
            </div>
          </Section>
        ) : null}

        {step === "date" && def && takesDischargeOrder && form.date ? (
          <>
            <DischargeOrderFields
              admissionId={admission.id}
              reason={def.value}
              dischargeDate={form.date}
              value={dischargeOrder}
              onChange={(next) => {
                setDischargeOrder(next);
                setSubmitError(null);
              }}
            />
            {showErrors.date && orderMissing ? (
              <p className="wx-hope-field-msg wx-hope-field-msg-error" role="alert">
                Choose the ordering physician and when the order was signed.
              </p>
            ) : null}
          </>
        ) : null}

        {step === "review" && def ? (
          <Section
            icon="activity"
            title="What will happen"
            description={`${def.label} · ${fmtDate(form.date)}`}
          >
            <WhatHappensList items={cascadeItems(def.value, form.date)} />
          </Section>
        ) : null}

        {step === "confirm" && def ? (
          <Section icon="check-circle" title="Confirm">
            <div style={{ display: "grid", gap: "0.875rem" }}>
              <ReviewList
                rows={confirmRows(
                  def.value,
                  def.label,
                  def.dateLabel,
                  form,
                  takesDischargeOrder ? dischargeOrder : null,
                )}
              />
              <AttestTile checked={form.attested} onChange={(v) => update("attested", v)}>
                {attestationText(def.value)}
              </AttestTile>
              {showErrors.confirm && !form.attested ? (
                <p className="wx-hope-field-msg wx-hope-field-msg-error" role="alert">
                  Confirm the statement above to submit.
                </p>
              ) : null}
              {submitError ? <InlineAlert tone="error">{submitError}</InlineAlert> : null}
            </div>
          </Section>
        ) : null}

        <WorkflowFooter note={def ? def.label : "Choose a reason to begin."}>
          {step === "reason" ? (
            <Link to={backTo} className="wx-btn-secondary">
              Cancel
            </Link>
          ) : (
            <button type="button" className="wx-btn-secondary" onClick={goBack} disabled={busy}>
              Back
            </button>
          )}
          {step === "confirm" ? (
            <button
              type="button"
              className="wx-btn-primary"
              disabled={busy}
              onClick={() => {
                if (!form.attested) {
                  setShowErrors((s) => ({ ...s, confirm: true }));
                  return;
                }
                void submit();
              }}
            >
              {busy ? "Submitting…" : submitLabel(def?.value)}
            </button>
          ) : (
            <button type="button" className="wx-btn-primary" onClick={goNext}>
              Continue <Glyph name="arrow-right" size={16} />
            </button>
          )}
        </WorkflowFooter>
      </main>
    </div>,
  );
}

function confirmRows(
  reason: EndReason,
  label: string,
  dateLabel: string,
  form: FormState,
  order: DischargeOrderDraft | null,
): { term: string; value: string; multiline?: boolean }[] {
  const rows: { term: string; value: string; multiline?: boolean }[] = [
    { term: "Reason", value: label },
    { term: dateLabel, value: fmtDate(form.date) },
  ];
  if (reason === "transfer_out") {
    const ccn = form.otherHospiceCcn.trim();
    rows.push({
      term: "Receiving hospice",
      value: `${form.otherHospiceName.trim()}${ccn ? ` · CCN ${ccn}` : ""}`,
    });
    rows.push({
      term: "Receiving hospice cares for the patient",
      value: careSettingLabel(form.receivingCareSetting),
    });
  }
  if (reason === "revocation")
    rows.push({
      term: "Signed by",
      value: `${form.signingPatientName.trim()} (${form.signingRole === "patient" ? "patient" : "legal representative"})`,
    });
  if (order && dischargeOrderComplete(order))
    rows.push({
      term: "Physician discharge order",
      value: `Signed ${fmtDate(order.signedAtLocal.slice(0, 10))}${order.orderReference.trim() ? ` · ${order.orderReference.trim()}` : ""}`,
    });
  rows.push({ term: "Narrative", value: form.narrative.trim(), multiline: true });
  return rows;
}

function PendingCosignSection({
  admissionId,
  admissionState,
  pending,
}: {
  admissionId: string;
  admissionState: string;
  pending: PendingCosign;
}): JSX.Element {
  const cosignHref = `/discharges/${pending.dischargeId}/cosign?version=${pending.version}&admissionId=${admissionId}`;
  return (
    <Section icon="clock" title="Pending physician cosign">
      <div style={{ display: "grid", gap: "0.875rem" }}>
        <InlineAlert tone="success">
          The for-cause discharge was filed. It is pending the physician's cosign (the medical
          director, a physician designee or the patient's IDG physician) — the patient stays on
          service until then.
        </InlineAlert>
        <p style={bodyText}>
          Nothing has ended yet: the admission stays {stateLabel(admissionState).toLowerCase()}, the
          benefit period stays open, and the NOTR is drafted only once the physician cosigns. If the
          cosign is declined, the discharge is voided.
        </p>
        <div style={{ display: "flex", gap: "0.625rem", flexWrap: "wrap" }}>
          {pending.dischargeId ? (
            <Link to={cosignHref} className="wx-btn-primary">
              Open physician cosign
            </Link>
          ) : null}
          <Link to={`/admissions/${admissionId}`} className="wx-btn-secondary">
            Back to admission
          </Link>
        </div>
      </div>
    </Section>
  );
}
