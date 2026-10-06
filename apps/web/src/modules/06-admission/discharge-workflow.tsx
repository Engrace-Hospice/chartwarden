import {
  EmptyState,
  Glyph,
  type GlyphName,
  InfoRows,
  InlineAlert,
  LoadingSpinner,
  Panel,
  PatientWorkspaceLayout,
  StatusPill,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/06-admission — Discharge / Revocation / Transfer-out workflow (M6 routes 36/37/39).
// Spec: docs/design/screens/clinical/WARDENX_UI_DISCHARGE_REVOCATION_TRANSFER.md — "Patient Workspace +
// Stepper": 1 reason → 2 reason-specific data → 3 effective date → 4 review cascades → 5 confirm.
// Drawn in the 2026-09-25 redesign idiom (the same primitives the HOPE workspace uses): patient banner,
// a step navigator on the left, flat clinical sections in the centre, cascades/compliance in the right
// context rail.
//
// The SERVER stays authoritative for everything this screen pre-checks: route 39 derives its permission
// key from `reason` (discharge/permission-map.ts) and re-applies the per-reason narrative gates; the
// date order and the one-transfer-per-period rule are state-machine guards. The client checks mirror
// them only so a clinician learns about a problem before submitting, and every server code is mapped to
// a human message below.
//
// Out of scope here (other workflows own them): death (Death / Pronouncement workflow), the for-cause
// medical-director cosign (route 40), and transfer-in (a new admission).
import { type JSX, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ChartBanner,
  PatientSummaryPanel,
  fmtDate,
  useChartIdentity,
} from "../../shell/patient-context";
import { useSession } from "../../shell/session";
import { ADMISSION_TONE, DISCHARGEABLE_STATES, stateLabel } from "./admission-status";
import { authFailureRedirect } from "./write-workflow";

// ---------- reasons ----------

export type EndReason =
  | "moved_out_of_service_area"
  | "transfer_out"
  | "revocation"
  | "no_longer_terminal"
  | "for_cause"
  | "other";

type Endpoint = "discharge" | "revocation" | "transfer-out";

interface ReasonDef {
  value: EndReason;
  label: string;
  hint: string;
  endpoint: Endpoint;
  /** The permission key the server checks for this reason (route 39 derives it from `reason`). */
  permission: string;
  /** Minimum narrative length — mirrors DISCHARGE_POLICY / the route schemas (server re-checks). */
  minNarrative: number;
  dateLabel: string;
  narrativeLabel: string;
  narrativePrompt: string;
}

const NARRATIVE_MAX = 4000;

export const REASONS: readonly ReasonDef[] = [
  {
    value: "moved_out_of_service_area",
    label: "Moved out of service area",
    hint: "The patient has left the area the hospice serves, with no immediate hospice handoff.",
    endpoint: "discharge",
    permission: "discharge.moved",
    minNarrative: 10,
    dateLabel: "Discharge date",
    narrativeLabel: "Discharge narrative",
    narrativePrompt:
      "Where the patient moved and the date of the move; whether the patient/family was notified of the " +
      "discharge; where records were sent (receiving physician or hospice).",
  },
  {
    value: "transfer_out",
    label: "Transfer out to another hospice",
    hint: "Another hospice takes over care. The benefit period carries over — no new election.",
    endpoint: "transfer-out",
    permission: "transfer.out",
    minNarrative: 10,
    dateLabel: "Transfer effective date",
    narrativeLabel: "Transfer narrative",
    narrativePrompt:
      "Why the patient is transferring, the hand-off contact at the receiving hospice, and what records " +
      "were sent.",
  },
  {
    value: "revocation",
    label: "Revocation",
    hint: "The patient or representative chooses to end the hospice election.",
    endpoint: "revocation",
    permission: "revocation.create",
    minNarrative: 10,
    dateLabel: "Revocation date",
    narrativeLabel: "Revocation narrative",
    narrativePrompt:
      "The patient's stated reason in their own words, who signed the revocation statement, and the " +
      "education given about re-electing the benefit later.",
  },
  {
    value: "no_longer_terminal",
    label: "No longer terminally ill",
    hint: "The patient's condition no longer supports a prognosis of six months or less.",
    endpoint: "discharge",
    permission: "discharge.no_longer_terminal",
    minNarrative: 20,
    dateLabel: "Discharge date",
    narrativeLabel: "Clinical narrative",
    narrativePrompt:
      "The clinical findings that no longer support a terminal prognosis, the physician's determination, " +
      "and the education given to the patient/family (including how to re-elect hospice).",
  },
  {
    value: "for_cause",
    label: "Discharge for cause",
    hint: "Safety or compliance grounds. Needs a medical-director cosign before it takes effect.",
    endpoint: "discharge",
    permission: "discharge.for_cause",
    minNarrative: 10,
    dateLabel: "Proposed discharge date",
    narrativeLabel: "Discharge narrative",
    narrativePrompt:
      "The sequence of events, what was done to resolve the problem, and how the patient/family was " +
      "told about the proposed discharge.",
  },
  {
    value: "other",
    label: "Other live discharge",
    hint: "A live discharge that fits none of the reasons above. A detailed narrative is required.",
    endpoint: "discharge",
    permission: "discharge.other",
    minNarrative: 40,
    dateLabel: "Discharge date",
    narrativeLabel: "Discharge narrative",
    narrativePrompt:
      "Explain the reason in full: what happened, who decided, who was notified, and where records went.",
  },
];

const REASON_BY_VALUE = new Map(REASONS.map((r) => [r.value, r]));

const REVOCATION_REASONS = [
  { value: "seek_curative_treatment", label: "Seeking curative treatment" },
  { value: "dissatisfaction", label: "Dissatisfied with hospice care" },
  { value: "transferred_out", label: "Transferred out" },
  { value: "other", label: "Other" },
] as const;
type RevocationReason = (typeof REVOCATION_REASONS)[number]["value"];

const CCN_PATTERN = /^[0-9A-Z]{6}$/;

// ---------- data ----------

interface AdmissionView {
  id: string;
  state: string;
  version: number;
  patientId?: string;
  admissionAt?: string | null;
}

interface PeriodView {
  id: string;
  state: string;
  sequenceNumber: number;
  effectiveAt: string | null;
}

interface FormState {
  reason: EndReason | null;
  narrative: string;
  date: string;
  forCauseReason: string;
  otherHospiceName: string;
  otherHospiceCcn: string;
  revocationReason: RevocationReason | "";
  signingRole: "patient" | "legal_representative";
  signingPatientName: string;
  attested: boolean;
}

const EMPTY_FORM: FormState = {
  reason: null,
  narrative: "",
  date: "",
  forCauseReason: "",
  otherHospiceName: "",
  otherHospiceCcn: "",
  revocationReason: "",
  signingRole: "patient",
  signingPatientName: "",
  attested: false,
};

type StepId = "reason" | "details" | "date" | "review" | "confirm";
const STEPS: { id: StepId; title: string }[] = [
  { id: "reason", title: "Reason" },
  { id: "details", title: "Details" },
  { id: "date", title: "Effective date" },
  { id: "review", title: "Review what happens" },
  { id: "confirm", title: "Confirm" },
];

// ---------- dates ----------

/** Today as a local calendar date (YYYY-MM-DD) — the clinician's day, not UTC's. */
export function localToday(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------- validation (client mirror of the server gates) ----------

type Errors = Partial<Record<keyof FormState, string>>;

export function validateDetails(form: FormState): Errors {
  const def = form.reason ? REASON_BY_VALUE.get(form.reason) : undefined;
  if (!def) return {};
  const errors: Errors = {};
  const len = form.narrative.trim().length;
  if (len < def.minNarrative)
    errors.narrative = `Enter at least ${def.minNarrative} characters (${len} so far).`;
  else if (form.narrative.length > NARRATIVE_MAX)
    errors.narrative = `Keep the narrative under ${NARRATIVE_MAX} characters.`;
  if (def.value === "for_cause") {
    const n = form.forCauseReason.trim().length;
    if (n < 20) errors.forCauseReason = `Enter at least 20 characters (${n} so far).`;
    else if (form.forCauseReason.length > 2000)
      errors.forCauseReason = "Keep the reason under 2000 characters.";
  }
  if (def.value === "transfer_out") {
    if (form.otherHospiceName.trim().length === 0)
      errors.otherHospiceName = "Enter the receiving hospice's name.";
    const ccn = form.otherHospiceCcn.trim();
    if (ccn && !CCN_PATTERN.test(ccn))
      errors.otherHospiceCcn = "A CCN is 6 characters — digits and capital letters.";
  }
  if (def.value === "revocation") {
    if (!form.revocationReason) errors.revocationReason = "Choose the revocation reason.";
    if (form.signingPatientName.trim().length === 0)
      errors.signingPatientName = "Enter the name of the person who signed.";
  }
  return errors;
}

export function validateDate(
  date: string,
  admissionDate: string | null,
  today: string,
): string | null {
  if (!date) return "Choose the effective date.";
  if (date > today) return "The effective date cannot be in the future.";
  if (admissionDate && date < admissionDate)
    return `The effective date cannot be before the admission date (${fmtDate(admissionDate)}).`;
  return null;
}

// ---------- server error mapping ----------

const CODE_MESSAGES: Record<string, string> = {
  DISCHARGE_NARRATIVE_TOO_SHORT:
    "The narrative is shorter than this reason requires. Add more detail and submit again.",
  NARRATIVE_REQUIRED_FOR_CAUSE:
    "A for-cause discharge needs a for-cause reason of at least 20 characters.",
  DISCHARGE_BEFORE_ADMISSION:
    "The effective date is before the admission date. Choose a later date.",
  REVOCATION_EFFECTIVE_BEFORE_SIGNED:
    "The revocation cannot take effect before the date it was signed.",
  TRANSFER_LIMIT_EXCEEDED:
    "A transfer out has already been recorded in this benefit period — only one is allowed per period.",
  FOR_CAUSE_REQUIRES_COSIGN:
    "A for-cause discharge cannot take effect until the medical director cosigns it.",
  ILLEGAL_TRANSITION:
    "This admission can no longer be ended this way — it may already be discharged, or it has no active " +
    "benefit period. Reload the admission to see its current state.",
};

export function messageForError(status: number | undefined, code: string | undefined): string {
  if (code && CODE_MESSAGES[code]) return CODE_MESSAGES[code];
  if (status === 403) return "You do not have permission to record this reason for this patient.";
  if (status === 404) return "This admission was not found or is no longer visible to you.";
  if (status === 409) return "The admission changed since you opened it. Reload and try again.";
  if (status === 422 || status === 400)
    return "Some values were rejected — check the details and dates.";
  return "The request could not be completed. Nothing was changed; try again.";
}

// ---------- screen ----------

export function DischargeWorkflow(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const session = useSession();
  const { id } = useParams<{ id: string }>();
  const [admission, setAdmission] = useState<AdmissionView | null>(null);
  const [period, setPeriod] = useState<PeriodView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [step, setStep] = useState<StepId>("reason");
  const [showErrors, setShowErrors] = useState<Partial<Record<StepId, boolean>>>({});
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [pendingCosign, setPendingCosign] = useState(false);
  const identity = useChartIdentity(admission?.patientId);
  const today = localToday();

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setLoadError(null);
    const { data, error } = await client.GET("/api/v1/admissions/{id}", {
      params: { path: { id } },
    });
    if (error || !data) {
      setLoadError("Admission not found or not visible to you.");
      setLoading(false);
      return;
    }
    const adm = data as unknown as AdmissionView;
    setAdmission(adm);
    // Best-effort context for the rail: the benefit period this action closes.
    if (adm.patientId) {
      try {
        const ec = await client.GET("/api/v1/patients/{patientId}/election-certification", {
          params: { path: { patientId: adm.patientId } },
        });
        const periods = (ec.data as { periods?: PeriodView[] } | undefined)?.periods ?? [];
        setPeriod(periods.find((p) => p.state === "active") ?? null);
      } catch {
        setPeriod(null);
      }
    }
    setLoading(false);
  }, [client, id]);

  useEffect(() => {
    void load();
  }, [load]);

  const def = form.reason ? REASON_BY_VALUE.get(form.reason) : undefined;
  const admissionDate = admission?.admissionAt ? admission.admissionAt.slice(0, 10) : null;
  const detailErrors = useMemo(() => validateDetails(form), [form]);
  const dateError = validateDate(form.date, admissionDate, today);
  const valid: Record<StepId, boolean> = {
    reason: Boolean(def),
    details: Boolean(def) && Object.keys(detailErrors).length === 0,
    date: dateError === null,
    review: true,
    confirm: form.attested,
  };
  const order = STEPS.map((s) => s.id);
  const reachable = (target: StepId): boolean => {
    const idx = order.indexOf(target);
    return order.slice(0, idx).every((s) => valid[s]);
  };
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

  const submit = useCallback(async () => {
    if (!id || !def) return;
    setBusy(true);
    setSubmitError(null);
    const narrative = form.narrative.trim();
    let result: {
      data?: unknown;
      error?: unknown;
      response?: Response;
    };
    if (def.endpoint === "revocation") {
      result = await client.POST("/api/v1/admissions/{id}/revocation", {
        params: { path: { id } },
        body: {
          revocationDate: form.date,
          narrative,
          signingPatientName: form.signingPatientName.trim(),
          signingRole: form.signingRole,
          revocationReason: form.revocationReason as RevocationReason,
        },
      });
    } else if (def.endpoint === "transfer-out") {
      const ccn = form.otherHospiceCcn.trim();
      result = await client.POST("/api/v1/admissions/{id}/transfer-out", {
        params: { path: { id } },
        body: {
          direction: "out",
          effectiveDate: form.date,
          otherHospiceName: form.otherHospiceName.trim(),
          ...(ccn ? { otherHospiceCcn: ccn } : {}),
          narrative,
        },
      });
    } else {
      result = await client.POST("/api/v1/admissions/{id}/discharge", {
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
        },
      });
    }
    if (result.error) {
      const status = result.response?.status;
      const code = (result.error as { error?: { code?: string } } | undefined)?.error?.code;
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
    const requiresCosign = (result.data as { requiresMedicalDirectorCosign?: boolean } | undefined)
      ?.requiresMedicalDirectorCosign;
    if (requiresCosign) {
      setPendingCosign(true);
      return;
    }
    navigate(`/admissions/${id}`, {
      state: { notice: `${noticeVerb(def.value)} effective ${fmtDate(form.date)}.` },
    });
  }, [id, def, form, client, navigate]);

  if (loading) return <LoadingSpinner />;
  if (loadError || !admission)
    return <EmptyState title="Unavailable" description={loadError ?? "Not found."} />;

  const banner = identity ? (
    <ChartBanner
      identity={identity}
      actions={
        <Link to={`/admissions/${admission.id}`} className="wx-btn-secondary">
          <Glyph name="chevron-left" size={16} /> Back to admission
        </Link>
      }
    />
  ) : (
    <div className="wx-patient-banner" aria-busy="true" style={{ minHeight: "6.25rem" }} />
  );

  const rail = (
    <>
      <Panel title="Admission" icon="clipboard-check">
        <InfoRows
          labelWidth="7rem"
          rows={[
            {
              label: "Status",
              value: (
                <StatusPill
                  label={stateLabel(admission.state)}
                  tone={ADMISSION_TONE[admission.state] ?? "neutral"}
                />
              ),
            },
            { label: "Admitted", value: admissionDate ? fmtDate(admissionDate) : "—" },
            {
              label: "Benefit period",
              value: period
                ? `Period ${period.sequenceNumber}${period.effectiveAt ? ` · from ${fmtDate(period.effectiveAt)}` : ""}`
                : "—",
            },
          ]}
        />
      </Panel>
      <Panel title="What happens on submit" icon="activity">
        {def ? (
          <CascadeList reason={def.value} date={form.date || null} compact />
        ) : (
          <p className="wx-rail-empty" style={{ padding: 0 }}>
            Choose a reason to see what this action changes.
          </p>
        )}
      </Panel>
      {def && def.value !== "for_cause" ? (
        <Panel title="Filing window" icon="calendar-check">
          <InfoRows
            labelWidth="7rem"
            rows={[
              {
                label: "NOTR due",
                value: form.date ? fmtDate(addDays(form.date, 5)) : "5 days after the date",
                hint: "42 CFR 418.26 — 5 calendar days from the effective date.",
              },
            ]}
          />
        </Panel>
      ) : null}
      <PatientSummaryPanel identity={identity} />
    </>
  );

  if (!DISCHARGEABLE_STATES.has(admission.state) && !pendingCosign) {
    return (
      <PatientWorkspaceLayout banner={banner} rail={rail}>
        <div className="wx-hope-main" style={{ paddingBottom: "1.5rem" }}>
          <WorkflowHead />
          <InlineAlert tone="info">
            This admission is {stateLabel(admission.state).toLowerCase()}. Only an active or on-hold
            admission can be discharged, revoked, or transferred out.
          </InlineAlert>
        </div>
      </PatientWorkspaceLayout>
    );
  }

  if (pendingCosign && def) {
    return (
      <PatientWorkspaceLayout banner={banner} rail={rail}>
        <div className="wx-hope-main" style={{ paddingBottom: "1.5rem" }}>
          <WorkflowHead />
          <Section icon="clock" title="Pending medical-director cosign">
            <div style={{ display: "grid", gap: "0.875rem" }}>
              <InlineAlert tone="success">
                The for-cause discharge was filed. It is pending the medical director's cosign — the
                patient stays on service until then.
              </InlineAlert>
              <p style={bodyText}>
                Nothing has ended yet: the admission stays{" "}
                {stateLabel(admission.state).toLowerCase()}, the benefit period stays open, and the
                NOTR is drafted only once the medical director cosigns. If the cosign is declined,
                the discharge is voided.
              </p>
              <div>
                <Link to={`/admissions/${admission.id}`} className="wx-btn-primary">
                  Back to admission
                </Link>
              </div>
            </div>
          </Section>
        </div>
      </PatientWorkspaceLayout>
    );
  }

  const stepStatus = (s: StepId): { line: string; state: "complete" | "attention" | "empty" } => {
    if (s === "review")
      return reachable("review")
        ? { line: "Ready", state: "complete" }
        : { line: "Not started", state: "empty" };
    if (valid[s]) return { line: "Complete", state: "complete" };
    if (showErrors[s]) return { line: "Needs attention", state: "attention" };
    return { line: "Not started", state: "empty" };
  };

  const err = (key: keyof FormState, s: StepId): string | undefined =>
    showErrors[s] ? detailErrors[key] : undefined;

  return (
    <PatientWorkspaceLayout banner={banner} rail={rail}>
      <div className="wx-hope-workspace">
        <aside className="wx-hope-admission-rail">
          <nav className="wx-hope-nav wx-hope-admission-section-nav" aria-label="Discharge steps">
            <div className="wx-hope-nav-title">End of service</div>
            <ol>
              {STEPS.map((s, i) => {
                const isActive = s.id === step;
                const st = stepStatus(s.id);
                const open = reachable(s.id);
                return (
                  <li key={s.id} className={isActive ? "active" : undefined}>
                    <button
                      type="button"
                      onClick={() => open && setStep(s.id)}
                      disabled={!open}
                      aria-current={isActive ? "step" : undefined}
                      aria-label={`${s.title} — ${st.line}`}
                    >
                      <span
                        className={`wx-hope-step wx-hope-step-${isActive ? "active" : st.state}`}
                      >
                        {st.state === "complete" && !isActive ? (
                          <Glyph name="check" size={14} strokeWidth={3} />
                        ) : (
                          i + 1
                        )}
                      </span>
                      <span className="wx-hope-nav-text">
                        <span className="wx-hope-nav-label">{s.title}</span>
                        <span className={`wx-hope-nav-status wx-hope-nav-status-${st.state}`}>
                          {st.line}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </nav>
        </aside>

        <main className="wx-hope-main">
          <WorkflowHead
            stepLine={`Step ${order.indexOf(step) + 1} of ${STEPS.length} · ${STEPS.find((s) => s.id === step)?.title}`}
            reason={def?.label}
          />

          {step === "reason" ? (
            <Section
              icon="clipboard-list"
              title="Why is hospice care ending?"
              description="Death is recorded in the Death & Pronouncement workflow, not here."
            >
              <fieldset className="wx-choice-fieldset">
                <legend className="wx-sr-only">Reason</legend>
                <div className="wx-option-rows">
                  {REASONS.map((r) => {
                    const allowed = can(r.permission);
                    const checked = form.reason === r.value;
                    return (
                      <label
                        key={r.value}
                        className={
                          checked
                            ? "wx-option-row checked"
                            : allowed
                              ? "wx-option-row"
                              : "wx-option-row blocked"
                        }
                        style={{ alignItems: "flex-start", padding: "0.65rem 0.875rem" }}
                      >
                        <input
                          type="radio"
                          name="discharge-reason"
                          value={r.value}
                          checked={checked}
                          disabled={!allowed}
                          aria-label={r.label}
                          onChange={() => chooseReason(r.value)}
                        />
                        <span className="wx-tile-text">
                          <span style={{ fontWeight: 600 }}>{r.label}</span>
                          <small>
                            {allowed ? r.hint : "You do not have permission for this reason."}
                          </small>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>
              {showErrors.reason && !def ? (
                <p className="wx-hope-field-msg wx-hope-field-msg-error" role="alert">
                  Choose a reason to continue.
                </p>
              ) : null}
              {form.reason === "moved_out_of_service_area" ? (
                <MovedGuidance
                  canTransfer={can("transfer.out")}
                  onSwitch={() => chooseReason("transfer_out")}
                />
              ) : null}
            </Section>
          ) : null}

          {step === "details" && def ? (
            <>
              {def.value === "moved_out_of_service_area" ? (
                <MovedGuidance
                  canTransfer={can("transfer.out")}
                  onSwitch={() => chooseReason("transfer_out")}
                />
              ) : null}
              {def.value === "for_cause" ? (
                <InlineAlert tone="info">
                  A for-cause discharge needs the medical director's cosign. Until then the patient
                  stays on service and nothing ends.
                </InlineAlert>
              ) : null}
              {def.value === "transfer_out" ? (
                <Section icon="send" title="Receiving hospice">
                  <div className="wx-field-grid">
                    <Field
                      id="dw-hospice-name"
                      label="Receiving hospice name"
                      required
                      error={err("otherHospiceName", "details")}
                    >
                      <input
                        id="dw-hospice-name"
                        value={form.otherHospiceName}
                        maxLength={200}
                        onChange={(e) => update("otherHospiceName", e.target.value)}
                      />
                    </Field>
                    <Field
                      id="dw-hospice-ccn"
                      label="Receiving hospice CCN"
                      optional
                      hint="Medicare CCN — 6 characters."
                      error={err("otherHospiceCcn", "details")}
                    >
                      <input
                        id="dw-hospice-ccn"
                        value={form.otherHospiceCcn}
                        maxLength={6}
                        onChange={(e) => update("otherHospiceCcn", e.target.value.toUpperCase())}
                      />
                    </Field>
                  </div>
                </Section>
              ) : null}
              {def.value === "revocation" ? (
                <Section icon="pencil" title="Revocation statement">
                  <div className="wx-field-grid">
                    <Field
                      id="dw-rev-reason"
                      label="Revocation reason"
                      required
                      error={err("revocationReason", "details")}
                    >
                      <select
                        id="dw-rev-reason"
                        value={form.revocationReason}
                        onChange={(e) =>
                          update("revocationReason", e.target.value as RevocationReason | "")
                        }
                      >
                        <option value="">Choose…</option>
                        {REVOCATION_REASONS.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field id="dw-rev-role" label="Signed by" required>
                      <select
                        id="dw-rev-role"
                        value={form.signingRole}
                        onChange={(e) =>
                          update("signingRole", e.target.value as FormState["signingRole"])
                        }
                      >
                        <option value="patient">Patient</option>
                        <option value="legal_representative">Legal representative</option>
                      </select>
                    </Field>
                    <Field
                      id="dw-rev-signer"
                      label="Signer's name"
                      required
                      error={err("signingPatientName", "details")}
                    >
                      <input
                        id="dw-rev-signer"
                        value={form.signingPatientName}
                        maxLength={200}
                        onChange={(e) => update("signingPatientName", e.target.value)}
                      />
                    </Field>
                  </div>
                </Section>
              ) : null}
              {def.value === "for_cause" ? (
                <Section icon="shield" title="Grounds for discharge">
                  <Field
                    id="dw-for-cause"
                    label="For-cause reason"
                    required
                    hint={`${form.forCauseReason.trim().length} / at least 20 characters`}
                    error={err("forCauseReason", "details")}
                  >
                    <textarea
                      id="dw-for-cause"
                      rows={3}
                      maxLength={2000}
                      value={form.forCauseReason}
                      onChange={(e) => update("forCauseReason", e.target.value)}
                    />
                  </Field>
                </Section>
              ) : null}
              <Section
                icon="file-text"
                title={def.narrativeLabel}
                description={def.narrativePrompt}
              >
                <Field
                  id="dw-narrative"
                  label="Narrative"
                  required
                  hint={`${form.narrative.trim().length} / at least ${def.minNarrative} characters`}
                  error={err("narrative", "details")}
                >
                  <textarea
                    id="dw-narrative"
                    rows={6}
                    maxLength={NARRATIVE_MAX}
                    value={form.narrative}
                    placeholder={def.narrativePrompt}
                    onChange={(e) => update("narrative", e.target.value)}
                  />
                </Field>
              </Section>
            </>
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
                <Field
                  id="dw-admitted"
                  label="Admission date"
                  locked
                  source="From the admission record"
                >
                  <div className="wx-locked-value">
                    <input
                      id="dw-admitted"
                      readOnly
                      aria-readonly="true"
                      value={admissionDate ? fmtDate(admissionDate) : "Not recorded"}
                    />
                    <span aria-hidden>
                      <Glyph name="lock" size={15} strokeWidth={1.75} />
                    </span>
                  </div>
                </Field>
              </div>
            </Section>
          ) : null}

          {step === "review" && def ? (
            <Section
              icon="activity"
              title="What will happen"
              description={`${def.label} · ${fmtDate(form.date)}`}
            >
              <CascadeList reason={def.value} date={form.date} />
            </Section>
          ) : null}

          {step === "confirm" && def ? (
            <Section icon="check-circle" title="Confirm">
              <div style={{ display: "grid", gap: "0.875rem" }}>
                <dl className="wx-kv">
                  <dt>Reason</dt>
                  <dd>{def.label}</dd>
                  <dt>{def.dateLabel}</dt>
                  <dd className="wx-nums">{fmtDate(form.date)}</dd>
                  {def.value === "transfer_out" ? (
                    <>
                      <dt>Receiving hospice</dt>
                      <dd>
                        {form.otherHospiceName.trim()}
                        {form.otherHospiceCcn.trim() ? ` · CCN ${form.otherHospiceCcn.trim()}` : ""}
                      </dd>
                    </>
                  ) : null}
                  {def.value === "revocation" ? (
                    <>
                      <dt>Signed by</dt>
                      <dd>
                        {form.signingPatientName.trim()} (
                        {form.signingRole === "patient" ? "patient" : "legal representative"})
                      </dd>
                    </>
                  ) : null}
                  <dt>Narrative</dt>
                  <dd style={{ whiteSpace: "pre-wrap" }}>{form.narrative.trim()}</dd>
                </dl>
                <label className={form.attested ? "wx-tile checked" : "wx-tile"}>
                  <input
                    type="checkbox"
                    checked={form.attested}
                    onChange={(e) => update("attested", e.currentTarget.checked)}
                  />
                  <span className="wx-tile-text">
                    <span>{attestationText(def.value)}</span>
                  </span>
                </label>
                {showErrors.confirm && !form.attested ? (
                  <p className="wx-hope-field-msg wx-hope-field-msg-error" role="alert">
                    Confirm the statement above to submit.
                  </p>
                ) : null}
                {submitError ? <InlineAlert tone="error">{submitError}</InlineAlert> : null}
              </div>
            </Section>
          ) : null}

          <footer className="wx-hope-footer">
            <span className="wx-hope-footer-note">
              {def ? def.label : "Choose a reason to begin."}
            </span>
            <div style={{ display: "flex", gap: "0.625rem" }}>
              {step === "reason" ? (
                <Link to={`/admissions/${admission.id}`} className="wx-btn-secondary">
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
            </div>
          </footer>
        </main>
      </div>
    </PatientWorkspaceLayout>
  );
}

// ---------- pieces ----------

function WorkflowHead({ stepLine, reason }: { stepLine?: string; reason?: string }): JSX.Element {
  return (
    <header className="wx-hope-head">
      <div>
        <p className="wx-hope-eyebrow">Admission</p>
        <h1 className="wx-hope-title">Discharge, revocation or transfer</h1>
        {stepLine ? (
          <p className="wx-hope-step-line">
            {stepLine}
            {reason ? <span> · {reason}</span> : null}
          </p>
        ) : null}
      </div>
    </header>
  );
}

function Section({
  icon,
  title,
  description,
  children,
}: {
  icon: GlyphName;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="wx-clinical-section">
      <header>
        <span className="wx-clinical-section-icon" aria-hidden>
          <Glyph name={icon} size={22} strokeWidth={1.6} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3>{title}</h3>
          {description ? <p>{description}</p> : null}
        </div>
      </header>
      <div className="wx-clinical-section-body">{children}</div>
    </section>
  );
}

/** Field anatomy of the redesign: label · required/optional mark, control, then hint/source or error. */
function Field({
  id,
  label,
  required,
  optional,
  locked,
  source,
  hint,
  error,
  children,
}: {
  id: string;
  label: ReactNode;
  required?: boolean;
  optional?: boolean;
  locked?: boolean;
  source?: string;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="wx-hope-field">
      <div className="wx-hope-field-head">
        <label htmlFor={id} className="wx-hope-field-label">
          {label}
          {required && !locked ? (
            <span className="wx-required-mark" aria-hidden>
              {" "}
              *
            </span>
          ) : null}
          {optional ? (
            <span className="wx-optional-mark" aria-hidden>
              Optional
            </span>
          ) : null}
        </label>
      </div>
      {children}
      {error ? (
        <div className="wx-hope-field-msg wx-hope-field-msg-error" role="alert">
          {error}
        </div>
      ) : source || hint ? (
        <div className="wx-hope-field-hint">{source ?? hint}</div>
      ) : null}
    </div>
  );
}

function MovedGuidance({
  canTransfer,
  onSwitch,
}: {
  canTransfer: boolean;
  onSwitch: () => void;
}): JSX.Element {
  return (
    <div
      role="note"
      aria-label="Moved or transferring?"
      style={{
        display: "grid",
        gap: "0.5rem",
        marginTop: "0.875rem",
        padding: "0.75rem 0.875rem",
        borderRadius: "var(--radius-md)",
        background: "var(--color-primary-tint)",
        color: "var(--color-on-surface)",
        fontSize: "0.8125rem",
      }}
    >
      <strong style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
        <Glyph name="info" size={16} /> Is another hospice in the new area taking over care?
      </strong>
      <span>
        Use <b>Transfer out</b> instead — the benefit period carries over to the receiving hospice
        and no new election is needed. Use <b>Moved out of service area</b> when the patient leaves
        the area without an immediate hospice hand-off.
      </span>
      {canTransfer ? (
        <div>
          <button type="button" className="wx-btn-secondary wx-btn-sm" onClick={onSwitch}>
            Switch to Transfer out
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** The cascades the backend runs for each path, stated plainly (spec "Cascades" + the M23/M22 consumers). */
function CascadeList({
  reason,
  date,
  compact = false,
}: {
  reason: EndReason;
  date: string | null;
  compact?: boolean;
}): JSX.Element {
  const items: { icon: GlyphName; text: ReactNode }[] =
    reason === "for_cause"
      ? [
          {
            icon: "clock",
            text: "The discharge is filed as pending the medical director's cosign.",
          },
          {
            icon: "heart",
            text: "Until the cosign, the patient stays on service: the admission stays open and the benefit period continues.",
          },
          {
            icon: "receipt",
            text: "Once cosigned, the period closes, the level of care ends, the admission becomes discharged and billing drafts the NOTR.",
          },
        ]
      : [
          {
            icon: "calendar-check",
            text: `The active benefit (election) period closes${
              reason === "revocation"
                ? " — cause: revocation"
                : reason === "transfer_out"
                  ? " — cause: transfer; the receiving hospice continues it, no new election needed"
                  : " — cause: discharge"
            }.`,
          },
          { icon: "bed", text: "The current level of care ends." },
          { icon: "clipboard-check", text: "The admission becomes Discharged." },
          {
            icon: "receipt",
            text: date
              ? `Billing drafts the NOTR — due within 5 calendar days, by ${fmtDate(addDays(date, 5))}.`
              : "Billing drafts the NOTR — due within 5 calendar days of the effective date.",
          },
          {
            icon: "file-text",
            text:
              reason === "revocation"
                ? "A revocation document is generated for the chart."
                : reason === "transfer_out"
                  ? "A transfer discharge summary is generated for the chart."
                  : "A discharge summary is generated for the chart.",
          },
        ];
  return (
    <ul
      aria-label={compact ? "Summary of what happens on submit" : "What happens"}
      style={{
        listStyle: "none",
        margin: 0,
        padding: 0,
        display: "grid",
        gap: compact ? "0.5rem" : "0.75rem",
        fontSize: compact ? "0.8125rem" : "0.875rem",
        color: "var(--color-on-surface)",
      }}
    >
      {items.map((item, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static, ordered list.
        <li key={i} style={{ display: "flex", gap: "0.625rem", alignItems: "flex-start" }}>
          <span style={{ color: "var(--color-primary)", marginTop: "0.0625rem" }} aria-hidden>
            <Glyph name={item.icon} size={compact ? 15 : 18} />
          </span>
          <span>{item.text}</span>
        </li>
      ))}
    </ul>
  );
}

function attestationText(reason: EndReason): string {
  switch (reason) {
    case "revocation":
      return "I confirm the patient or their legal representative signed a revocation statement on this date.";
    case "transfer_out":
      return "I confirm the receiving hospice has accepted the patient and the transfer date is agreed.";
    case "for_cause":
      return "I confirm the grounds above are documented and the patient/family has been told about the proposed discharge.";
    default:
      return "I confirm the patient/family has been notified of the discharge and the details above are accurate.";
  }
}

function submitLabel(reason: EndReason | undefined): string {
  switch (reason) {
    case "revocation":
      return "Record revocation";
    case "transfer_out":
      return "Transfer out";
    case "for_cause":
      return "File for cosign";
    default:
      return "Discharge patient";
  }
}

function noticeVerb(reason: EndReason): string {
  if (reason === "revocation") return "Revocation recorded";
  if (reason === "transfer_out") return "Transfer out recorded";
  return "Patient discharged";
}

const bodyText = {
  margin: 0,
  fontSize: "0.875rem",
  color: "var(--color-on-surface-variant)",
} as const;
