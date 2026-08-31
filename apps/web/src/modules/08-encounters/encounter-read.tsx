import {
  CeremonyModal,
  EmptyState,
  Glyph,
  LoadingSpinner,
  PatientBanner,
  PatientWorkspaceLayout,
  StatusPill,
  ageYears,
  cardSurface,
  ghostBorder,
  t,
  useApiClient,
  Modal,
} from "@wardenx/ui";
import { SCALE_TYPES } from "@wardenx/types";
// apps/web/src/modules/08-encounters — Encounter Read (M8 §5.1/§5.2, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_ENCOUNTER_VISIT_DOCUMENTATION.md — "Use Patient Workspace + Documentation Workspace."
// Matched to the P1 Pencil frame (wardenx-P1-clinical.pen `AohyV`): a Patient Workspace (banner) over the
// visit-note document | a right rail (Sign-off + EVV/visit), with a sticky footer (cosign guard + actions).
// Honest gap: the encounter READ DTO exposes only the header (type/discipline/date/status/late-entry/
// version/signatures) — NOT the assembled HearthNote body (subjective/objective/assessment/plan) or the
// vitals strip the frame shows, and not the EVV match. Those regions render as honest placeholders naming
// the read that will fill them, never a fabricated note. Reads GET /api/v1/encounters/:encounterId
// (+ /cosignature, + the patient summary for the banner); the server enforces every scope (ADR-0030).
//
// Write ceremonies (TASK-031): Sign / Acknowledge cosignature / Sign cosignature / Supervisor release, each
// a CeremonyModal committing to the matching M8 route. PARAM-004/CoP-418.104(c) follow-up: the sign/
// cosign-sign routes now gate on a REAL M2 step-up (requireStepUp("encounter.sign"/"encounter.cosign")),
// server-verified from the session — the client no longer sends (and the server no longer trusts) a
// `stepUpAuthAt` timestamp. What's STILL a gap (pre-existing, cross-module — packages/auth's
// `requireAbac`/`requireStepUp` never emit a distinguishable `STEP_UP_REQUIRED` error code the way M23's
// pattern this file mirrors assumes): a stale/missing step-up surfaces as a PLAIN 403, so
// `write-workflow.ts`'s authFailureRedirect can't route this ceremony to `/step-up` specifically — it
// falls into the generic "you do not have permission" message below. Fixing that needs a
// packages/auth-level change (every `requireStepUp` caller, not just M8), out of scope here.
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, JSX, ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { PatientChartBail } from "../../shell/chart-module-rail";
import { COSIGN_TONE, ENCOUNTER_TONE, lateEntryTone, stateLabel } from "./encounter-status";
import { authFailureRedirect } from "./write-workflow";

type CeremonyMode = "sign" | "acknowledge" | "cosign-sign" | "supervisor-release" | null;
const REASON_MIN = 40; // SupervisorReleaseSchema's real floor (encounters-typebox.ts).

interface Encounter {
  id: string;
  patientId: string;
  admissionId: string;
  visitId: string | null;
  encounterType: string;
  discipline: string;
  serviceDate: string;
  status: string;
  lateEntryTier: string;
  version: number;
  isF2f: boolean;
  signedAt: string | null;
  cosignedAt: string | null;
  selections: Record<string, unknown> | null;
  finalDocumentation: string | null;
  vitals: Record<string, unknown> | null;
  mileage: Record<string, unknown> | null;
  carePlanLinks: CarePlanLink[];
}
interface PatientSummary {
  mrn: string;
  lastName: string;
  firstName: string;
  dob: string;
  status: string;
}
interface CarePlanProblem {
  problemId: string;
  description: string;
  status: string;
}
interface CarePlanGoal {
  goalId: string;
  problemId: string;
  text: string;
  status: string;
}
interface CarePlanIntervention {
  interventionId: string;
  problemId: string;
  scopeText: string;
  frequencyText: string;
  discipline: string;
  status: string;
}
interface CarePlanRelevant {
  problems: CarePlanProblem[];
  goals: CarePlanGoal[];
  interventions: CarePlanIntervention[];
  redacted: boolean;
}
interface CarePlanLink {
  linkId?: string;
  problemId: string | null;
  goalId: string | null;
  interventionId: string | null;
}
interface AssessmentRow {
  id: string;
  assessmentId?: string;
  scaleType?: string;
  kind?: string;
  status: string;
  sourceEncounterId?: string | null;
  capturedAt?: string;
  assessmentIdLabel?: string;
}

function errorMessage(error: unknown, fallback: string): string {
  const body = error as {
    message?: string;
    title?: string;
    detail?: string;
    code?: string;
    error?: { message?: string; title?: string; detail?: string; code?: string };
  } | null;
  if (body?.detail) return body.detail;
  if (body?.message) return body.message;
  if (body?.title) return body.title;
  if (body?.error?.detail) return body.error.detail;
  if (body?.error?.message) return body.error.message;
  if (body?.error?.title) return body.error.title;
  return fallback;
}

function docFromSelections(selections: Record<string, unknown> | null | undefined): string {
  const narrative = selections?.narrative;
  if (typeof narrative === "object" && narrative !== null) {
    const value = (narrative as { clinicalSummary?: unknown }).clinicalSummary;
    return typeof value === "string" ? value : "";
  }
  return "";
}

function hasCarePlanLink(links: readonly CarePlanLink[], kind: "problem" | "goal" | "intervention", id: string): boolean {
  return links.some((link) =>
    kind === "problem"
      ? link.problemId === id
      : kind === "goal"
        ? link.goalId === id
        : link.interventionId === id,
  );
}

export function EncounterRead(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const { patientId, encounterId } = useParams<{ patientId: string; encounterId: string }>();
  const [encounter, setEncounter] = useState<Encounter | null>(null);
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [cosignStatus, setCosignStatus] = useState<string | null>(null);
  const [carePlan, setCarePlan] = useState<CarePlanRelevant | null>(null);
  const [assessments, setAssessments] = useState<AssessmentRow[]>([]);
  const [hopeAssessments, setHopeAssessments] = useState<AssessmentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [ceremony, setCeremony] = useState<CeremonyMode>(null);
  const [utilityModal, setUtilityModal] = useState<"void" | "addendum" | "assessment" | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [noteText, setNoteText] = useState("");
  const [vitals, setVitals] = useState({
    bpSystolic: "",
    bpDiastolic: "",
    heartRate: "",
    respiratoryRate: "",
    temperature: "",
    temperatureUnit: "f",
    spo2: "",
    painScore: "",
    painScale: "nrs_0_10",
  });
  const [mileage, setMileage] = useState({
    odometerStart: "",
    odometerEnd: "",
    milesDriven: "",
    source: "manual_override",
    manualOverrideReason: "",
  });
  const [assessment, setAssessment] = useState({
    scaleType: "pps",
    data: "{}",
  });
  const post = client.POST as unknown as (
    path: string,
    init?: unknown,
  ) => Promise<{ data?: unknown; error?: unknown; response: Response }>;

  const load = useCallback(async () => {
    if (!encounterId) return;
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/encounters/{encounterId}", {
      params: { path: { encounterId } },
    });
    if (err || !data?.id) {
      setError("Could not load the encounter.");
      setLoading(false);
      return;
    }
    setEncounter({
      id: data.id,
      patientId: data.patientId,
      admissionId: data.admissionId,
      visitId: data.visitId ?? null,
      encounterType: data.encounterType,
      discipline: data.discipline,
      serviceDate: data.serviceDate,
      status: data.status,
      lateEntryTier: data.lateEntryTier,
      version: data.version,
      isF2f: data.isF2f,
      signedAt: data.signedAt ?? null,
      cosignedAt: data.cosignedAt ?? null,
      selections: (data as { selections?: Record<string, unknown> | null }).selections ?? null,
      finalDocumentation: (data as { finalDocumentation?: string | null }).finalDocumentation ?? null,
      vitals: (data as { vitals?: Record<string, unknown> | null }).vitals ?? null,
      mileage: (data as { mileage?: Record<string, unknown> | null }).mileage ?? null,
      carePlanLinks: ((data as { carePlanLinks?: CarePlanLink[] }).carePlanLinks ?? []) as CarePlanLink[],
    });
    const pid = patientId ?? data.patientId;
    setNoteText(docFromSelections((data as { selections?: Record<string, unknown> | null }).selections));
    const loadedVitals = (data as { vitals?: Record<string, unknown> | null }).vitals;
    if (loadedVitals) {
      setVitals({
        bpSystolic: String(loadedVitals.bpSystolic ?? ""),
        bpDiastolic: String(loadedVitals.bpDiastolic ?? ""),
        heartRate: String(loadedVitals.heartRate ?? ""),
        respiratoryRate: String(loadedVitals.respiratoryRate ?? ""),
        temperature: String(loadedVitals.temperature ?? ""),
        temperatureUnit: String(loadedVitals.temperatureUnit ?? "f"),
        spo2: String(loadedVitals.spo2 ?? ""),
        painScore: String(loadedVitals.painScore ?? ""),
        painScale: String(loadedVitals.painScale ?? "nrs_0_10"),
      });
    }
    const loadedMileage = (data as { mileage?: Record<string, unknown> | null }).mileage;
    if (loadedMileage) {
      setMileage({
        odometerStart: String(loadedMileage.odometerStart ?? ""),
        odometerEnd: String(loadedMileage.odometerEnd ?? ""),
        milesDriven: String(loadedMileage.milesDriven ?? ""),
        source: String(loadedMileage.source ?? "manual_override"),
        manualOverrideReason: String(loadedMileage.manualOverrideReason ?? ""),
      });
    }
    const [cos, pat, cp, ass, hope] = await Promise.all([
      client.GET("/api/v1/encounters/{encounterId}/cosignature", {
        params: { path: { encounterId } },
      }),
      client.GET("/api/v1/patients/{id}", { params: { path: { id: pid } } }),
      client.GET("/api/v1/internal/care-plan/relevant-elements" as never, {
        params: {
          query: {
            patientId: data.patientId,
            encounterType: data.encounterType,
            discipline: data.discipline,
          },
        },
      } as never),
      client.GET("/api/v1/patients/{patientId}/assessments", {
        params: { path: { patientId: data.patientId } },
      } as never),
      client.GET("/api/v1/patients/{patientId}/hope/assessments", {
        params: { path: { patientId: data.patientId } },
      } as never),
    ]);
    setCosignStatus(cos.data?.status ?? null);
    if (pat.data) setPatient(pat.data as PatientSummary);
    setCarePlan((cp.data ?? null) as CarePlanRelevant | null);
    setAssessments(
      (((ass.data as { assessments?: AssessmentRow[] } | undefined)?.assessments ?? []) as AssessmentRow[]).filter(
        (row) => row.sourceEncounterId === encounterId,
      ),
    );
    setHopeAssessments(((hope.data as { assessments?: AssessmentRow[] } | undefined)?.assessments ?? []) as AssessmentRow[]);
    setLoading(false);
  }, [client, encounterId, patientId]);

  useEffect(() => {
    void load();
  }, [load]);

  const closeCeremony = useCallback(() => {
    setCeremony(null);
    setReason("");
    setActionError(null);
  }, []);

  const runWrite = useCallback(
    async (mode: Exclude<CeremonyMode, null>) => {
      if (!encounterId) return;
      if (mode === "supervisor-release" && reason.trim().length < REASON_MIN) {
        setActionError(`Provide a reason of at least ${REASON_MIN} characters.`);
        return;
      }
      setBusy(true);
      setActionError(null);
      // SupervisorReleaseSchema still requires stepUpAuthAt (untouched by this follow-up — the
      // supervisor-release route never actually reads it, but the body schema still demands it).
      const stepUpAuthAt = new Date().toISOString();
      const path =
        mode === "sign"
          ? "/api/v1/encounters/{encounterId}/sign"
          : mode === "acknowledge"
            ? "/api/v1/encounters/{encounterId}/cosignature/acknowledge"
            : mode === "cosign-sign"
              ? "/api/v1/encounters/{encounterId}/cosignature/sign"
              : "/api/v1/encounters/{encounterId}/cosignature/supervisor-release";
      const body =
        mode === "sign" || mode === "cosign-sign"
          ? { attestationConfirmed: true as const }
          : mode === "supervisor-release"
            ? { reason: reason.trim(), stepUpAuthAt }
            : undefined;
      const init = { params: { path: { encounterId } }, ...(body ? { body } : {}) };
      // The four routes have distinct request shapes (never a union client.POST can dispatch on
      // statically) — cast at the boundary, same as claim-editor.tsx's runWrite; the server is the
      // only real parser/enforcer (ADR-0030).
      const { error: err, response } = (await client.POST(path as never, init as never)) as {
        error?: { error?: { code?: string } };
        response?: Response;
      };
      if (err) {
        const errCode = err?.error?.code;
        const redirect = authFailureRedirect(response?.status, errCode, window.location.pathname);
        if (redirect) {
          navigate(redirect);
          return;
        }
        setBusy(false);
        if (response?.status === 412 && errCode === "STEP_UP_AUTH_REQUIRED")
          setActionError("Your step-up expired — try again.");
        else if (response?.status === 412)
          setActionError("This encounter changed since you opened it — reload to retry.");
        else if (response?.status === 403)
          setActionError("You do not have permission for this action.");
        else setActionError("The action could not be completed.");
        return;
      }
      setBusy(false);
      closeCeremony();
      void load();
    },
    [encounterId, reason, client, navigate, closeCeremony, load],
  );

  async function runMutation(
    action: () => Promise<{ error?: unknown; data?: unknown; response?: Response }>,
    success: string,
  ): Promise<void> {
    setBusy(true);
    setActionError(null);
    setNotice(null);
    const res = await action();
    setBusy(false);
    if (res.error) {
      setActionError(errorMessage(res.error, "The encounter action could not be completed."));
      return;
    }
    setUtilityModal(null);
    setReason("");
    setNotice(success);
    await load();
  }

  async function saveDocumentation(): Promise<void> {
    if (!encounterId) return;
    await runMutation(
      () =>
        post("/api/v1/encounters/{encounterId}/selections", {
          params: { path: { encounterId } },
          body: { selections: { narrative: { clinicalSummary: noteText.trim() } } },
        }),
      "Documentation saved.",
    );
  }

  async function saveVitals(): Promise<void> {
    if (!encounterId) return;
    const n = (value: string): number | undefined => (value.trim() ? Number(value) : undefined);
    await runMutation(
      () =>
        post("/api/v1/encounters/{encounterId}/vitals", {
          params: { path: { encounterId } },
          body: {
            bpSystolic: n(vitals.bpSystolic),
            bpDiastolic: n(vitals.bpDiastolic),
            heartRate: n(vitals.heartRate),
            respiratoryRate: n(vitals.respiratoryRate),
            temperature: vitals.temperature || undefined,
            temperatureUnit: vitals.temperature ? vitals.temperatureUnit : undefined,
            spo2: n(vitals.spo2),
            painScore: n(vitals.painScore),
            painScale: vitals.painScore ? vitals.painScale : undefined,
          },
        }),
      "Vitals saved.",
    );
  }

  async function saveMileage(): Promise<void> {
    if (!encounterId) return;
    const n = (value: string): number | undefined => (value.trim() ? Number(value) : undefined);
    await runMutation(
      () =>
        post("/api/v1/encounters/{encounterId}/mileage", {
          params: { path: { encounterId } },
          body: {
            odometerStart: n(mileage.odometerStart),
            odometerEnd: n(mileage.odometerEnd),
            milesDriven: mileage.milesDriven || undefined,
            source: mileage.source,
            manualOverrideReason: mileage.manualOverrideReason || undefined,
          },
        }),
      "Mileage saved.",
    );
  }

  async function addCarePlanLink(kind: "problem" | "goal" | "intervention", id: string): Promise<void> {
    if (!encounterId) return;
    await runMutation(
      () =>
        post("/api/v1/encounters/{encounterId}/care-plan-links", {
          params: { path: { encounterId } },
          body:
            kind === "problem"
              ? { problemId: id }
              : kind === "goal"
                ? { goalId: id }
                : { interventionId: id },
        }),
      "Care Plan link saved.",
    );
  }

  async function finalizeEncounter(): Promise<void> {
    if (!encounterId) return;
    await runMutation(
      () =>
        post("/api/v1/encounters/{encounterId}/finalize", {
          params: { path: { encounterId } },
          body: {},
        }),
      "Encounter finalized.",
    );
  }

  async function voidDraft(): Promise<void> {
    if (!encounterId) return;
    await runMutation(
      () =>
        post("/api/v1/encounters/{encounterId}/void", {
          params: { path: { encounterId } },
          body: { reason: reason.trim() },
        }),
      "Draft voided.",
    );
  }

  async function createAddendum(): Promise<void> {
    if (!encounterId) return;
    await runMutation(
      () =>
        post("/api/v1/encounters/{encounterId}/addenda", {
          params: { path: { encounterId } },
          body: { reason: reason.trim() },
        }),
      "Addendum opened.",
    );
  }

  async function launchAssessment(): Promise<void> {
    if (!encounterId || !encounter) return;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(assessment.data) as Record<string, unknown>;
    } catch {
      setActionError("Assessment payload must be valid JSON.");
      return;
    }
    setBusy(true);
    setActionError(null);
    const res = await post("/api/v1/patients/{patientId}/assessments", {
      params: { path: { patientId: encounter.patientId } },
      body: {
        admissionId: encounter.admissionId,
        scaleType: assessment.scaleType,
        capturedAt: new Date().toISOString(),
        sourceEncounterId: encounter.id,
        data,
      },
    });
    setBusy(false);
    if (res.error) {
      setActionError(errorMessage(res.error, "Assessment could not be created."));
      return;
    }
    const id = (res.data as { id?: string; assessmentId?: string } | undefined)?.id ?? (res.data as { assessmentId?: string } | undefined)?.assessmentId;
    if (id) navigate(`/patients/${encounter.patientId}/assessments/${id}`);
    else {
      setUtilityModal(null);
      await load();
    }
  }

  const bailBanner = patient ? (
    <PatientBanner
      name={`${patient.firstName} ${patient.lastName}`}
      meta={`DOB ${patient.dob}`}
      chips={<MonoChip>{patient.mrn}</MonoChip>}
    />
  ) : (
    <PatientBanner name="Encounter" />
  );
  if (loading) {
    return (
      <PatientChartBail banner={bailBanner}>
        <LoadingSpinner />
      </PatientChartBail>
    );
  }
  if (error || !encounter) {
    return (
      <PatientChartBail banner={bailBanner}>
        <EmptyState title="Unavailable" description={error ?? "Not found."} />
      </PatientChartBail>
    );
  }

  const e = encounter;
  const canSign = e.status === "finalized";
  const canAcknowledge =
    cosignStatus === "pending" || cosignStatus === "routed" || cosignStatus === "escalated";
  const canCosignSign = cosignStatus === "acknowledged";
  const canSupervisorRelease = cosignStatus === "escalated" || cosignStatus === "hard_cap_reached";
  const banner = patient ? (
    <PatientBanner
      name={`${patient.firstName} ${patient.lastName}`}
      meta={`DOB ${patient.dob}${ageYears(patient.dob) != null ? ` · ${ageYears(patient.dob)}y` : ""}`}
      chips={
        <>
          <MonoChip>{patient.mrn}</MonoChip>
          <StatusPill
            label={stateLabel(patient.status)}
            tone={ENCOUNTER_TONE[patient.status] ?? "neutral"}
          />
        </>
      }
      actions={
        <button type="button" onClick={() => navigate(`/patients/${e.patientId}`)} style={ghostBtn}>
          Open chart
        </button>
      }
    />
  ) : (
    <PatientBanner name="Encounter" />
  );

  return (
    <PatientWorkspaceLayout banner={banner}>
      <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
        <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
          {/* Center — the visit-note document */}
          <div style={{ flex: 1, overflow: "auto", padding: "1.5rem", minWidth: 0 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "1rem",
                marginBottom: "0.25rem",
              }}
            >
              <h1
                style={{
                  margin: 0,
                  fontFamily: t.fontDisplay,
                  fontWeight: 500,
                  fontSize: "1.375rem",
                  color: t.onSurface,
                }}
              >
                {stateLabel(e.encounterType)}
              </h1>
              <StatusPill
                label={stateLabel(e.status)}
                tone={ENCOUNTER_TONE[e.status] ?? "neutral"}
              />
            </div>
            <p style={meta}>
              {stateLabel(e.discipline)} · <span className="tabular-nums">{e.serviceDate}</span>
              {e.isF2f ? " · F2F" : ""} · v{e.version}
            </p>

            {notice ? <div style={noticeStyle}>{notice}</div> : null}
            {actionError ? (
              <p role="alert" aria-live="assertive" style={alertStyle}>
                {actionError}
              </p>
            ) : null}

            <section style={{ ...cardSurface, padding: "1.25rem", marginTop: "1rem" }}>
              <div style={sectionHeader}>
                <h2 style={railTitle}>Documentation</h2>
                {e.status === "draft" ? (
                  <button type="button" onClick={() => void saveDocumentation()} disabled={busy} style={primaryBtn}>
                    Save draft
                  </button>
                ) : null}
              </div>
              {e.status === "draft" ? (
                <textarea
                  aria-label="Clinical documentation"
                  value={noteText}
                  onChange={(ev) => setNoteText(ev.target.value)}
                  rows={8}
                  style={textareaStyle}
                />
              ) : (
                <p style={noteBody}>
                  {e.finalDocumentation || noteText || "No assembled documentation is available."}
                </p>
              )}
            </section>

            <section style={{ ...cardSurface, padding: "1.25rem", marginTop: "1rem" }}>
              <div style={sectionHeader}>
                <h2 style={railTitle}>Vitals</h2>
                {e.status === "draft" ? (
                  <button type="button" onClick={() => void saveVitals()} disabled={busy} style={ghostBtn}>
                    Save vitals
                  </button>
                ) : null}
              </div>
              <div style={grid}>
                <Input label="BP systolic" value={vitals.bpSystolic} onChange={(value) => setVitals((v) => ({ ...v, bpSystolic: value }))} />
                <Input label="BP diastolic" value={vitals.bpDiastolic} onChange={(value) => setVitals((v) => ({ ...v, bpDiastolic: value }))} />
                <Input label="Heart rate" value={vitals.heartRate} onChange={(value) => setVitals((v) => ({ ...v, heartRate: value }))} />
                <Input label="Respiratory rate" value={vitals.respiratoryRate} onChange={(value) => setVitals((v) => ({ ...v, respiratoryRate: value }))} />
                <Input label="Temperature" value={vitals.temperature} onChange={(value) => setVitals((v) => ({ ...v, temperature: value }))} />
                <Input label="SpO2" value={vitals.spo2} onChange={(value) => setVitals((v) => ({ ...v, spo2: value }))} />
                <Input label="Pain" value={vitals.painScore} onChange={(value) => setVitals((v) => ({ ...v, painScore: value }))} />
              </div>
            </section>

            <section style={{ ...cardSurface, padding: "1.25rem", marginTop: "1rem" }}>
              <div style={sectionHeader}>
                <h2 style={railTitle}>Care Plan</h2>
                {carePlan?.redacted ? <span style={meta}>Restricted content omitted</span> : null}
              </div>
              <CarePlanPicker
                encounter={e}
                carePlan={carePlan}
                onSelect={(kind, id) => void addCarePlanLink(kind, id)}
                busy={busy || e.status !== "draft"}
              />
            </section>

            <section style={{ ...cardSurface, padding: "1.25rem", marginTop: "1rem" }}>
              <div style={sectionHeader}>
                <h2 style={railTitle}>Assessments</h2>
                {e.status === "draft" ? (
                  <button type="button" onClick={() => setUtilityModal("assessment")} style={ghostBtn}>
                    Launch assessment
                  </button>
                ) : null}
              </div>
              <LinkedRows rows={assessments} empty="No M9 assessments are linked to this Encounter." />
              <div style={{ marginTop: "0.75rem", display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                <button type="button" onClick={() => navigate(`/patients/${e.patientId}/assessments`)} style={ghostBtn}>
                  M9 timeline
                </button>
                <button type="button" onClick={() => navigate(`/patients/${e.patientId}/hope`)} style={ghostBtn}>
                  HOPE timeline
                </button>
              </div>
              <LinkedRows rows={hopeAssessments.slice(0, 3)} empty="No HOPE records are visible for this patient." />
            </section>

            <section style={{ ...cardSurface, padding: "1.25rem", marginTop: "1rem" }}>
              <div style={sectionHeader}>
                <h2 style={railTitle}>Mileage</h2>
                {e.status === "draft" ? (
                  <button type="button" onClick={() => void saveMileage()} disabled={busy} style={ghostBtn}>
                    Save mileage
                  </button>
                ) : null}
              </div>
              <div style={grid}>
                <Input label="Odometer start" value={mileage.odometerStart} onChange={(value) => setMileage((m) => ({ ...m, odometerStart: value }))} />
                <Input label="Odometer end" value={mileage.odometerEnd} onChange={(value) => setMileage((m) => ({ ...m, odometerEnd: value }))} />
                <Input label="Miles driven" value={mileage.milesDriven} onChange={(value) => setMileage((m) => ({ ...m, milesDriven: value }))} />
                <label style={fieldStyle}>
                  <span style={fieldLabelStyle}>Source</span>
                  <select value={mileage.source} onChange={(ev) => setMileage((m) => ({ ...m, source: ev.target.value }))} style={inputStyle}>
                    <option value="odometer">Odometer</option>
                    <option value="route_calc">Route calculation</option>
                    <option value="manual_override">Manual override</option>
                  </select>
                </label>
              </div>
              {mileage.source === "manual_override" ? (
                <label style={{ ...fieldStyle, marginTop: "0.75rem" }}>
                  <span style={fieldLabelStyle}>Override reason</span>
                  <textarea value={mileage.manualOverrideReason} onChange={(ev) => setMileage((m) => ({ ...m, manualOverrideReason: ev.target.value }))} rows={2} style={textareaStyle} />
                </label>
              ) : null}
            </section>
          </div>

          {/* Right rail — Sign-off + EVV/visit */}
          <aside style={rightRail}>
            <div style={{ ...cardSurface, padding: "1.125rem" }}>
              <h2 style={railTitle}>Sign-off</h2>
              <dl style={lifeGrid}>
                <dt style={dt}>Cosignature</dt>
                <dd style={dd}>
                  {cosignStatus ? (
                    <StatusPill
                      label={stateLabel(cosignStatus)}
                      tone={COSIGN_TONE[cosignStatus] ?? "neutral"}
                    />
                  ) : (
                    <span style={meta}>No request</span>
                  )}
                </dd>
                <dt style={dt}>Late-entry</dt>
                <dd style={dd}>
                  <StatusPill
                    label={stateLabel(e.lateEntryTier)}
                    tone={lateEntryTone(e.lateEntryTier)}
                  />
                </dd>
                {e.signedAt ? (
                  <>
                    <dt style={dt}>Signed</dt>
                    <dd style={{ ...dd }} className="tabular-nums">
                      {e.signedAt.slice(0, 16).replace("T", " ")}
                    </dd>
                  </>
                ) : null}
                {e.cosignedAt ? (
                  <>
                    <dt style={dt}>Cosigned</dt>
                    <dd style={{ ...dd }} className="tabular-nums">
                      {e.cosignedAt.slice(0, 16).replace("T", " ")}
                    </dd>
                  </>
                ) : null}
              </dl>
            </div>

            <div style={{ ...cardSurface, padding: "1.125rem" }}>
              <h2 style={railTitle}>EVV / visit</h2>
              <dl style={lifeGrid}>
                <dt style={dt}>Source</dt>
                <dd style={dd}>{e.visitId ? "Scheduled Visit" : "PRN / unscheduled"}</dd>
                {e.visitId ? (
                  <>
                    <dt style={dt}>Visit</dt>
                    <dd style={dd}>
                      <button
                        type="button"
                        onClick={() => navigate(`/scheduling/visits/${e.visitId}`)}
                        style={linkBtn}
                      >
                        Open Visit
                      </button>
                    </dd>
                  </>
                ) : null}
                <dt style={dt}>Service date</dt>
                <dd style={dd} className="tabular-nums">
                  {e.serviceDate}
                </dd>
              </dl>
            </div>
          </aside>
        </div>

        {/* Sticky footer — cosign guard + actions */}
        <div style={footer}>
          {cosignStatus && !e.cosignedAt ? (
            <span style={guardChip}>
              <Glyph name="lock" size={14} /> Co-signature pending
            </span>
          ) : (
            <span style={{ flex: 0 }} />
          )}
          <span style={{ flex: 1 }} />
          {canSupervisorRelease ? (
            <button
              type="button"
              onClick={() => setCeremony("supervisor-release")}
              style={ghostBtn}
            >
              Supervisor release
            </button>
          ) : null}
          {canAcknowledge ? (
            <button type="button" onClick={() => setCeremony("acknowledge")} style={ghostBtn}>
              Acknowledge cosignature
            </button>
          ) : null}
          {canCosignSign ? (
            <button type="button" onClick={() => setCeremony("cosign-sign")} style={primaryBtn}>
              Sign cosignature
            </button>
          ) : null}
          {canSign ? (
            <button type="button" onClick={() => setCeremony("sign")} style={primaryBtn}>
              Sign
            </button>
          ) : null}
          {e.status === "draft" ? (
            <>
              <button type="button" onClick={() => setUtilityModal("void")} style={ghostBtn}>
                Void draft
              </button>
              <button type="button" onClick={() => void finalizeEncounter()} style={primaryBtn}>
                Finalize
              </button>
            </>
          ) : null}
          {(e.status === "signed" || e.status === "cosigned") ? (
            <button type="button" onClick={() => setUtilityModal("addendum")} style={ghostBtn}>
              Add addendum
            </button>
          ) : null}
          <button type="button" onClick={() => navigate("/work/cosignatures")} style={ghostBtn}>
            Cosignature queue
          </button>
          <button
            type="button"
            onClick={() => navigate(`/patients/${e.patientId}`)}
            style={primaryBtn}
          >
            Back to chart
          </button>
        </div>
      </div>

      {/* Sign — the author's own Layer-3 signature (§2.7). */}
      <CeremonyModal
        open={ceremony === "sign"}
        title="Sign encounter"
        attestation={
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
              <Glyph name="shield" size={16} />
              <strong>Sign {stateLabel(e.encounterType)}</strong>
            </div>
            <RowField label="Service date" value={e.serviceDate} mono />
            <RowField label="Discipline" value={stateLabel(e.discipline)} />
            {actionError ? (
              <p role="alert" aria-live="assertive" style={alertStyle}>
                {actionError}
              </p>
            ) : null}
          </div>
        }
        legalText="I attest this documentation is complete and accurate to the best of my knowledge."
        signer={{ name: "Signing clinician", role: "This session" }}
        commitLabel={busy ? "Signing…" : "Sign & commit"}
        onCommit={() => void runWrite("sign")}
        onCancel={closeCeremony}
      />

      {/* Acknowledge cosignature — a receipt of notice, not a signature: no legal text, no step-up. */}
      <CeremonyModal
        open={ceremony === "acknowledge"}
        title="Acknowledge cosignature request"
        attestation={
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            <span style={{ fontSize: "0.8125rem", color: t.onSurfaceVariant }}>
              Confirms you have opened this encounter for cosignature review. This does not sign it.
            </span>
            {actionError ? (
              <p role="alert" aria-live="assertive" style={alertStyle}>
                {actionError}
              </p>
            ) : null}
          </div>
        }
        signer={{ name: "Cosigner", role: "This session" }}
        commitLabel={busy ? "Acknowledging…" : "Acknowledge"}
        onCommit={() => void runWrite("acknowledge")}
        onCancel={closeCeremony}
      />

      {/* Sign cosignature — the RN cosigner's own Layer-3 signature (§4.6 m8.cosigner_role_match). */}
      <CeremonyModal
        open={ceremony === "cosign-sign"}
        title="Sign cosignature"
        attestation={
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
              <Glyph name="shield" size={16} />
              <strong>Cosign {stateLabel(e.encounterType)}</strong>
            </div>
            <RowField label="Service date" value={e.serviceDate} mono />
            {actionError ? (
              <p role="alert" aria-live="assertive" style={alertStyle}>
                {actionError}
              </p>
            ) : null}
          </div>
        }
        legalText="I attest I have reviewed this documentation and concur as the qualifying cosigner."
        signer={{ name: "Cosigning RN", role: "This session" }}
        commitLabel={busy ? "Signing…" : "Sign & commit"}
        onCommit={() => void runWrite("cosign-sign")}
        onCancel={closeCeremony}
      />

      {/* Supervisor release — past the 48h hard cap; reason at the real server floor (REASON_MIN). */}
      <CeremonyModal
        open={ceremony === "supervisor-release"}
        title="Supervisor release"
        attestation={
          <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
            <span style={{ fontSize: "0.8125rem", color: t.onSurfaceVariant }}>
              Releases this encounter from the 48-hour cosignature hard cap.
            </span>
            <label
              htmlFor="supervisor-release-reason"
              style={{ fontSize: "0.75rem", fontWeight: 600, color: t.onSurfaceVariant }}
            >
              Reason (≥ {REASON_MIN} characters)
            </label>
            <textarea
              id="supervisor-release-reason"
              aria-describedby="supervisor-release-reason-count"
              value={reason}
              onChange={(ev) => setReason(ev.target.value)}
              rows={3}
              style={textareaStyle}
            />
            <span
              id="supervisor-release-reason-count"
              style={{
                fontSize: "0.7rem",
                color: reason.trim().length >= REASON_MIN ? t.onSurfaceVariant : t.warning,
              }}
            >
              {reason.trim().length}/{REASON_MIN}
            </span>
            {actionError ? (
              <p role="alert" aria-live="assertive" style={alertStyle}>
                {actionError}
              </p>
            ) : null}
          </div>
        }
        signer={{ name: "Supervisor", role: "This session" }}
        commitLabel={busy ? "Releasing…" : "Release"}
        onCommit={() => void runWrite("supervisor-release")}
        onCancel={closeCeremony}
      />

      <Modal
        open={utilityModal === "void" || utilityModal === "addendum" || utilityModal === "assessment"}
        onClose={busy ? undefined : () => setUtilityModal(null)}
        ariaLabel="Encounter action"
        width="34rem"
      >
        <div style={{ padding: "1.25rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
          <h2 style={railTitle}>
            {utilityModal === "void"
              ? "Void draft"
              : utilityModal === "addendum"
                ? "Add addendum"
                : "Launch assessment"}
          </h2>
          {actionError ? (
            <p role="alert" aria-live="assertive" style={alertStyle}>
              {actionError}
            </p>
          ) : null}
          {utilityModal === "assessment" ? (
            <>
              <label style={fieldStyle}>
                <span style={fieldLabelStyle}>Assessment type</span>
                <select
                  value={assessment.scaleType}
                  onChange={(ev) => setAssessment((a) => ({ ...a, scaleType: ev.target.value }))}
                  style={inputStyle}
                >
                  {SCALE_TYPES.map((scale) => (
                    <option key={scale} value={scale}>
                      {stateLabel(scale)}
                    </option>
                  ))}
                </select>
              </label>
              <label style={fieldStyle}>
                <span style={fieldLabelStyle}>Assessment data JSON</span>
                <textarea
                  value={assessment.data}
                  onChange={(ev) => setAssessment((a) => ({ ...a, data: ev.target.value }))}
                  rows={5}
                  style={textareaStyle}
                />
              </label>
            </>
          ) : (
            <label style={fieldStyle}>
              <span style={fieldLabelStyle}>Reason</span>
              <textarea
                value={reason}
                onChange={(ev) => setReason(ev.target.value)}
                rows={4}
                style={textareaStyle}
              />
            </label>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
            <button type="button" onClick={() => setUtilityModal(null)} disabled={busy} style={ghostBtn}>
              Cancel
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (utilityModal === "void") void voidDraft();
                else if (utilityModal === "addendum") void createAddendum();
                else void launchAssessment();
              }}
              style={utilityModal === "void" ? dangerBtn : primaryBtn}
            >
              {busy ? "Working..." : "Confirm"}
            </button>
          </div>
        </div>
      </Modal>
    </PatientWorkspaceLayout>
  );
}

function Input({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}): JSX.Element {
  return (
    <label style={fieldStyle}>
      <span style={fieldLabelStyle}>{label}</span>
      <input value={value} onChange={(ev) => onChange(ev.target.value)} style={inputStyle} />
    </label>
  );
}

function CarePlanPicker({
  encounter,
  carePlan,
  busy,
  onSelect,
}: {
  encounter: Encounter;
  carePlan: CarePlanRelevant | null;
  busy: boolean;
  onSelect: (kind: "problem" | "goal" | "intervention", id: string) => void;
}): JSX.Element {
  if (!carePlan) return <p style={meta}>Care Plan context is unavailable.</p>;
  return (
    <div style={{ display: "grid", gap: "1rem" }}>
      <PickerGroup
        title="Problems addressed"
        rows={carePlan.problems.map((p) => ({
          id: p.problemId,
          label: p.description,
          checked: hasCarePlanLink(encounter.carePlanLinks, "problem", p.problemId),
        }))}
        disabled={busy}
        onSelect={(id) => onSelect("problem", id)}
      />
      <PickerGroup
        title="Goals worked toward"
        rows={carePlan.goals.map((g) => ({
          id: g.goalId,
          label: g.text,
          checked: hasCarePlanLink(encounter.carePlanLinks, "goal", g.goalId),
        }))}
        disabled={busy}
        onSelect={(id) => onSelect("goal", id)}
      />
      <PickerGroup
        title="Interventions performed"
        rows={carePlan.interventions.map((i) => ({
          id: i.interventionId,
          label: `${i.scopeText}${i.frequencyText ? ` · ${i.frequencyText}` : ""}`,
          checked: hasCarePlanLink(encounter.carePlanLinks, "intervention", i.interventionId),
        }))}
        disabled={busy}
        onSelect={(id) => onSelect("intervention", id)}
      />
    </div>
  );
}

function PickerGroup({
  title,
  rows,
  disabled,
  onSelect,
}: {
  title: string;
  rows: Array<{ id: string; label: string; checked: boolean }>;
  disabled: boolean;
  onSelect: (id: string) => void;
}): JSX.Element {
  return (
    <div>
      <span style={sectionLabel}>{title}</span>
      {rows.length === 0 ? (
        <p style={meta}>No active items.</p>
      ) : (
        <div style={{ display: "grid", gap: "0.35rem", marginTop: "0.45rem" }}>
          {rows.map((row) => (
            <label key={row.id} style={checkboxLine}>
              <input
                type="checkbox"
                checked={row.checked}
                disabled={disabled || row.checked}
                onChange={() => onSelect(row.id)}
              />
              <span>{row.label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function LinkedRows({ rows, empty }: { rows: AssessmentRow[]; empty: string }): JSX.Element {
  if (rows.length === 0) return <p style={meta}>{empty}</p>;
  return (
    <div style={{ display: "grid", gap: "0.4rem", marginTop: "0.5rem" }}>
      {rows.map((row) => (
        <div key={row.id ?? row.assessmentId} style={linkedRow}>
          <span>{stateLabel(row.scaleType ?? row.kind ?? "assessment")}</span>
          <StatusPill label={stateLabel(row.status)} tone="neutral" />
        </div>
      ))}
    </div>
  );
}

function RowField({
  label,
  value,
  mono,
}: { label: string; value: ReactNode; mono?: boolean }): JSX.Element {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.1rem" }}>
      <span style={{ fontSize: "0.7rem", color: t.onSurfaceVariant }}>{label}</span>
      <span
        style={{
          fontSize: "0.85rem",
          color: t.onSurface,
          fontFamily: mono ? t.fontMono : undefined,
        }}
      >
        {value}
      </span>
    </div>
  );
}

function MonoChip({ children }: { children: ReactNode }): JSX.Element {
  return (
    <span
      style={{
        fontFamily: t.fontMono,
        fontSize: "0.78rem",
        color: t.onSurfaceVariant,
        background: t.surfaceContainer,
        borderRadius: "9999px",
        padding: "0.15rem 0.55rem",
      }}
    >
      {children}
    </span>
  );
}

const rightRail: CSSProperties = {
  width: "19rem",
  flexShrink: 0,
  overflow: "auto",
  padding: "1.5rem",
  background: t.surfaceLow,
  display: "flex",
  flexDirection: "column",
  gap: "1rem",
};
const railTitle: CSSProperties = {
  margin: "0 0 0.625rem",
  fontFamily: t.fontDisplay,
  fontWeight: 500,
  fontSize: "1rem",
  color: t.onSurface,
};
const sectionHeader: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "0.75rem",
  marginBottom: "0.75rem",
};
const grid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(8rem, 1fr))",
  gap: "0.75rem",
};
const fieldStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.35rem",
};
const fieldLabelStyle: CSSProperties = {
  fontSize: "0.75rem",
  color: t.onSurfaceVariant,
  fontWeight: 650,
};
const inputStyle: CSSProperties = {
  minHeight: "2.25rem",
  borderRadius: t.radiusMd,
  border: `1px solid ${t.outlineVariant}`,
  background: t.surfaceLowest,
  color: t.onSurface,
  padding: "0.4rem 0.55rem",
  fontSize: "0.85rem",
};
const noteBody: CSSProperties = {
  margin: 0,
  whiteSpace: "pre-wrap",
  lineHeight: 1.55,
  color: t.onSurface,
  fontSize: "0.9rem",
};
const noticeStyle: CSSProperties = {
  marginTop: "1rem",
  padding: "0.65rem 0.85rem",
  borderRadius: t.radiusMd,
  background: t.primaryTint,
  color: t.onSurface,
  fontSize: "0.82rem",
};
const checkboxLine: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: "0.5rem",
  fontSize: "0.85rem",
  color: t.onSurface,
};
const linkedRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "0.75rem",
  padding: "0.45rem 0",
  borderTop: ghostBorder,
  fontSize: "0.85rem",
};
const vitalLabel: CSSProperties = {
  fontSize: "0.68rem",
  fontWeight: 600,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  color: t.muted,
};
const sectionLabel: CSSProperties = {
  fontSize: "0.6875rem",
  fontWeight: 600,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: t.muted,
};
const footer: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.625rem",
  padding: "0.875rem 1.5rem",
  borderTop: ghostBorder,
  background: t.surfaceLowest,
  flexShrink: 0,
};
const guardChip: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.4rem",
  fontSize: "0.78rem",
  fontWeight: 600,
  color: t.warning,
  background: "color-mix(in srgb, var(--color-warning) 14%, transparent)",
  borderRadius: "9999px",
  padding: "0.3rem 0.7rem",
};
const ghostBtn: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  padding: "0.45rem 0.9rem",
  borderRadius: "9999px",
  background: t.surfaceContainer,
  color: t.onSurface,
  fontSize: "0.8125rem",
  fontWeight: 600,
  textDecoration: "none",
  border: "none",
  cursor: "pointer",
};
const primaryBtn: CSSProperties = {
  padding: "0.45rem 1rem",
  borderRadius: "9999px",
  background: t.primary,
  color: t.onPrimary,
  fontSize: "0.8125rem",
  fontWeight: 600,
  border: "none",
  cursor: "pointer",
};
const dangerBtn: CSSProperties = {
  ...primaryBtn,
  background: t.error,
  color: t.onEmphasis,
};
const linkBtn: CSSProperties = {
  border: "none",
  padding: 0,
  background: "transparent",
  color: t.primary,
  font: "inherit",
  fontWeight: 650,
  cursor: "pointer",
};
const lifeGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "auto 1fr",
  alignItems: "center",
  gap: "0.5rem 1rem",
  margin: 0,
  fontSize: "0.8rem",
};
const dt: CSSProperties = { fontWeight: 600, color: t.onSurfaceVariant };
const dd: CSSProperties = { margin: 0, color: t.onSurface };
const meta: CSSProperties = {
  fontSize: "0.78rem",
  color: t.onSurfaceVariant,
  margin: "0.25rem 0 0",
};
const alertStyle: CSSProperties = { margin: 0, fontSize: "0.8rem", color: t.error };
const textareaStyle: CSSProperties = {
  width: "100%",
  padding: "0.5rem",
  borderRadius: t.radiusMd,
  border: `1px solid ${t.outlineVariant}`,
  fontFamily: t.fontSans,
  fontSize: "0.85rem",
  resize: "vertical",
};
