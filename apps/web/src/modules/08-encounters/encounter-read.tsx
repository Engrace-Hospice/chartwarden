import { SCALE_TYPES } from "@wardenx/types";
import {
  CeremonyModal,
  EmptyState,
  Glyph,
  LoadingSpinner,
  Modal,
  PatientBanner,
  PatientWorkspaceLayout,
  StatusPill,
  ageYears,
  cardSurface,
  ghostBorder,
  t,
  useApiClient,
} from "@wardenx/ui";
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, JSX, ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ChartModuleRail,
  PatientChartBail,
} from "../../shell/chart-module-rail";
import {
  COSIGN_TONE,
  ENCOUNTER_TONE,
  lateEntryTone,
  stateLabel,
} from "./encounter-status";
import { authFailureRedirect } from "./write-workflow";

type CeremonyMode =
  | "sign"
  | "acknowledge"
  | "cosign-sign"
  | "supervisor-release"
  | null;

const REASON_MIN = 40;

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

type EncounterSection =
  | "documentation"
  | "vitals"
  | "carePlan"
  | "assessments"
  | "mileage"
  | "global";

function errorMessage(error: unknown, fallback: string): string {
  const body = error as {
    message?: string;
    title?: string;
    detail?: string;
    code?: string;
    error?: {
      message?: string;
      title?: string;
      detail?: string;
      code?: string;
    };
  } | null;

  if (body?.detail) return body.detail;
  if (body?.message) return body.message;
  if (body?.title) return body.title;
  if (body?.error?.detail) return body.error.detail;
  if (body?.error?.message) return body.error.message;
  if (body?.error?.title) return body.error.title;

  return fallback;
}

type FieldErrors = Record<string, string>;

function validationDetails(
  error: unknown,
): Array<{ field?: string; message?: string }> {
  const body = error as {
    details?: unknown;
    error?: {
      details?: unknown;
    };
  } | null;

  const raw = body?.error?.details ?? body?.details;
  if (!Array.isArray(raw)) return [];

  return raw.flatMap((detail) => {
    if (typeof detail !== "object" || detail === null) return [];

    const row = detail as {
      field?: unknown;
      path?: unknown;
      message?: unknown;
    };

    const field =
      typeof row.field === "string"
        ? row.field
        : typeof row.path === "string"
          ? row.path
          : undefined;

    return [
      {
        field,
        message: typeof row.message === "string" ? row.message : undefined,
      },
    ];
  });
}

function fieldKeyFromPath(path: string | undefined): string | null {
  if (!path) return null;

  const normalized = path
    .replace(/^body\./, "")
    .replace(/^data\./, "")
    .replace(/^selections\./, "");

  if (
    normalized.includes("clinicalSummary") ||
    normalized === "finalDocumentation" ||
    normalized === "documentation" ||
    normalized === "narrative"
  ) {
    return "clinicalSummary";
  }

  return normalized.split(".").filter(Boolean).at(-1) ?? null;
}

function fieldErrorsFrom(error: unknown, supportedFields: readonly string[]): FieldErrors {
  const supported = new Set(supportedFields);
  const result: FieldErrors = {};

  for (const detail of validationDetails(error)) {
    const key = fieldKeyFromPath(detail.field);

    if (key && supported.has(key) && detail.message && !result[key]) {
      result[key] = detail.message;
    }
  }

  return result;
}

function FieldError({ message }: { message?: string }): JSX.Element | null {
  if (!message) return null;

  return (
    <span role="alert" style={fieldErrorStyle}>
      {message}
    </span>
  );
}

function hasCarePlanLink(
  links: readonly CarePlanLink[],
  kind: "problem" | "goal" | "intervention",
  id: string,
): boolean {
  return links.some((link) =>
    kind === "problem"
      ? link.problemId === id
      : kind === "goal"
        ? link.goalId === id
        : link.interventionId === id,
  );
}

/**
 * UX-only helper.
 *
 * It is intentionally NOT used as a business-rule validator.
 * Its only purpose is to tell the UI whether a section appears to contain
 * information so the visit workflow can orient the user.
 */
function hasAnyValue(
  record: Record<string, unknown> | null | undefined,
): boolean {
  if (!record) return false;

  return Object.values(record).some(
    (value) =>
      value !== null &&
      value !== undefined &&
      (typeof value !== "string" || value.trim().length > 0),
  );
}

export function EncounterRead(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();

  const { patientId, encounterId } = useParams<{
    patientId: string;
    encounterId: string;
  }>();

  const [encounter, setEncounter] = useState<Encounter | null>(null);
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [cosignStatus, setCosignStatus] = useState<string | null>(null);
  const [carePlan, setCarePlan] = useState<CarePlanRelevant | null>(null);
  const [assessments, setAssessments] = useState<AssessmentRow[]>([]);
  const [hopeAssessments, setHopeAssessments] = useState<AssessmentRow[]>([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [ceremony, setCeremony] = useState<CeremonyMode>(null);
  const [utilityModal, setUtilityModal] = useState<
    "void" | "addendum" | "assessment" | null
  >(null);

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [sectionErrors, setSectionErrors] = useState<
    Partial<Record<EncounterSection, string>>
  >({});
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
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
  ) => Promise<{
    data?: unknown;
    error?: unknown;
    response: Response;
  }>;

  const load = useCallback(async () => {
    if (!encounterId) return;

    setLoading(true);
    setError(null);

    const { data, error: err } = await client.GET(
      "/api/v1/encounters/{encounterId}",
      {
        params: {
          path: {
            encounterId,
          },
        },
      },
    );

    if (err || !data?.id) {
      setError("Could not load the encounter.");
      setLoading(false);
      return;
    }

    const selections =
      (
        data as {
          selections?: Record<string, unknown> | null;
        }
      ).selections ?? null;

    const loadedVitals = (
      data as {
        vitals?: Record<string, unknown> | null;
      }
    ).vitals;

    const loadedMileage = (
      data as {
        mileage?: Record<string, unknown> | null;
      }
    ).mileage;

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
      selections,
      finalDocumentation:
        (
          data as {
            finalDocumentation?: string | null;
          }
        ).finalDocumentation ?? null,
      vitals: loadedVitals ?? null,
      mileage: loadedMileage ?? null,
      carePlanLinks:
        (
          data as {
            carePlanLinks?: CarePlanLink[];
          }
        ).carePlanLinks ?? [],
    });

    const pid = patientId ?? data.patientId;

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

    if (loadedMileage) {
      setMileage({
        odometerStart: String(loadedMileage.odometerStart ?? ""),
        odometerEnd: String(loadedMileage.odometerEnd ?? ""),
        milesDriven: String(loadedMileage.milesDriven ?? ""),
        source: String(loadedMileage.source ?? "manual_override"),
        manualOverrideReason: String(loadedMileage.manualOverrideReason ?? ""),
      });
    }

    const [cos, pat, cp, ass, hope, sel] = await Promise.all([
      client.GET("/api/v1/encounters/{encounterId}/cosignature", {
        params: {
          path: {
            encounterId,
          },
        },
      }),

      client.GET("/api/v1/patients/{id}", {
        params: {
          path: {
            id: pid,
          },
        },
      }),

      client.GET(
        "/api/v1/internal/care-plan/relevant-elements" as never,
        {
          params: {
            query: {
              patientId: data.patientId,
              encounterType: data.encounterType,
              discipline: data.discipline,
            },
          },
        } as never,
      ),

      client.GET("/api/v1/patients/{patientId}/assessments", {
        params: {
          path: {
            patientId: data.patientId,
          },
        },
      } as never),

      client.GET("/api/v1/patients/{patientId}/hope/assessments", {
        params: {
          path: {
            patientId: data.patientId,
          },
        },
      } as never),

      // #114 — the stored HearthNote tree, assembled (Layer-1). The note is authored in the composer;
      // this screen shows what it currently reads as.
      client.GET("/api/v1/encounters/{encounterId}/selections", {
        params: { path: { encounterId } },
      }),
    ]);

    setCosignStatus(cos.data?.status ?? null);

    if (pat.data) {
      setPatient(pat.data as PatientSummary);
    }

    setCarePlan((cp.data ?? null) as CarePlanRelevant | null);

    setAssessments(
      (
        (
          ass.data as
            | {
                assessments?: AssessmentRow[];
              }
            | undefined
        )?.assessments ?? []
      ).filter((row) => row.sourceEncounterId === encounterId),
    );

    setHopeAssessments(
      ((
        hope.data as
          | {
              assessments?: AssessmentRow[];
            }
          | undefined
      )?.assessments ?? []) as AssessmentRow[],
    );
    // A preview only once something is documented — an empty tree still assembles the template's
    // headings, which would read as a note that says nothing.
    setNoteText(
      sel.data?.sections.some((s) => s.entries.length > 0 || Boolean(s.freeText))
        ? (sel.data?.layer1Preview ?? "")
        : "",
    );

    setLoading(false);
  }, [client, encounterId, patientId]);

  useEffect(() => {
    void load();
  }, [load]);

  const clearFieldError = useCallback((field: string) => {
    setFieldErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  }, []);

  const clearSectionError = useCallback((section: EncounterSection) => {
    setSectionErrors((current) => {
      if (!current[section]) return current;

      const next = { ...current };
      delete next[section];

      return next;
    });
  }, []);

  const setSectionError = useCallback(
    (section: EncounterSection, message: string) => {
      setSectionErrors((current) => ({
        ...current,
        [section]: message,
      }));
    },
    [],
  );

  const clearFieldErrors = useCallback((fields: readonly string[]) => {
    if (fields.length === 0) return;

    setFieldErrors((current) => {
      const next = { ...current };
      let changed = false;

      for (const field of fields) {
        if (next[field]) {
          delete next[field];
          changed = true;
        }
      }

      return changed ? next : current;
    });
  }, []);

  const closeCeremony = useCallback(() => {
    setCeremony(null);
    setReason("");
    setActionError(null);
    clearFieldError("reason");
  }, [clearFieldError]);

  const runWrite = useCallback(
    async (mode: Exclude<CeremonyMode, null>) => {
      if (!encounterId) return;

      if (mode === "supervisor-release" && reason.trim().length < REASON_MIN) {
        setActionError(null);
        setFieldErrors((current) => ({
          ...current,
          reason: `Provide a reason of at least ${REASON_MIN} characters.`,
        }));
        return;
      }

      setBusy(true);
      setActionError(null);
      if (mode === "supervisor-release") {
        clearFieldError("reason");
      }

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
          ? {
              attestationConfirmed: true as const,
            }
          : mode === "supervisor-release"
            ? {
                reason: reason.trim(),
                stepUpAuthAt,
              }
            : undefined;

      const init = {
        params: {
          path: {
            encounterId,
          },
        },
        ...(body ? { body } : {}),
      };

      const { error: err, response } = (await client.POST(
        path as never,
        init as never,
      )) as {
        error?: {
          message?: string;
          error?: {
            code?: string;
            message?: string;
          };
        };
        response?: Response;
      };

      if (err) {
        const errCode = err?.error?.code;
        const errMessage = err?.error?.message ?? err?.message;
        const currentPath = `${window.location.pathname}${window.location.search}`;

        const redirect = authFailureRedirect(
          response?.status,
          errCode,
          currentPath,
          errMessage,
        );

        if (redirect) {
          navigate(redirect);
          return;
        }

        setBusy(false);

        const mapped = mode === "supervisor-release" ? fieldErrorsFrom(err, ["reason"]) : {};

        if (Object.keys(mapped).length > 0) {
          setFieldErrors((current) => ({ ...current, ...mapped }));
          setActionError(null);
          return;
        }

        if (response?.status === 412 && errCode === "STEP_UP_AUTH_REQUIRED") {
          setActionError("Your step-up expired — try again.");
        } else if (response?.status === 412) {
          setActionError(
            "This encounter changed since you opened it — reload to retry.",
          );
        } else if (response?.status === 403) {
          setActionError("You do not have permission for this action.");
        } else {
          setActionError("The action could not be completed.");
        }

        return;
      }

      setBusy(false);
      closeCeremony();

      void load();
    },
    [
      encounterId,
      reason,
      client,
      navigate,
      closeCeremony,
      load,
      clearFieldError,
    ],
  );

  async function runMutation(
    action: () => Promise<{
      error?: unknown;
      data?: unknown;
      response?: Response;
    }>,
    success: string,
    supportedFields: readonly string[] = [],
    section?: EncounterSection,
  ): Promise<void> {
    setBusy(true);
    setActionError(null);
    setNotice(null);
    if (section) {
      clearSectionError(section);
    }
    clearFieldErrors(supportedFields);

    const res = await action();

    setBusy(false);

    if (res.error) {
      const mapped = fieldErrorsFrom(res.error, supportedFields);

      if (Object.keys(mapped).length > 0) {
        setFieldErrors((current) => ({
          ...current,
          ...mapped,
        }));

        setActionError(null);
      } else {
        const message = errorMessage(res.error, "The encounter action could not be completed.");

        if (section) {
          setSectionError(section, message);
          setActionError(null);
        } else {
          setActionError(message);
        }
      }

      return;
    }

    clearFieldErrors(supportedFields);
    setUtilityModal(null);
    setReason("");
    setNotice(success);

    if (section) {
      clearSectionError(section);
    }

    await load();
  }

  async function saveVitals(): Promise<void> {
    if (!encounterId) return;

    const n = (value: string): number | undefined =>
      value.trim() ? Number(value) : undefined;

    await runMutation(
      () =>
        post("/api/v1/encounters/{encounterId}/vitals", {
          params: {
            path: {
              encounterId,
            },
          },
          body: {
            bpSystolic: n(vitals.bpSystolic),
            bpDiastolic: n(vitals.bpDiastolic),
            heartRate: n(vitals.heartRate),
            respiratoryRate: n(vitals.respiratoryRate),
            temperature: vitals.temperature || undefined,
            temperatureUnit: vitals.temperature
              ? vitals.temperatureUnit
              : undefined,
            spo2: n(vitals.spo2),
            painScore: n(vitals.painScore),
            painScale: vitals.painScore ? vitals.painScale : undefined,
          },
        }),
      "Vitals saved.",
      [
        "bpSystolic",
        "bpDiastolic",
        "heartRate",
        "respiratoryRate",
        "temperature",
        "temperatureUnit",
        "spo2",
        "painScore",
        "painScale",
      ],
      "vitals",
    );
  }

  async function saveMileage(): Promise<void> {
    if (!encounterId) return;

    const n = (value: string): number | undefined =>
      value.trim() ? Number(value) : undefined;

    await runMutation(
      () =>
        post("/api/v1/encounters/{encounterId}/mileage", {
          params: {
            path: {
              encounterId,
            },
          },
          body: {
            odometerStart: n(mileage.odometerStart),
            odometerEnd: n(mileage.odometerEnd),
            milesDriven: mileage.milesDriven || undefined,
            source: mileage.source,
            manualOverrideReason: mileage.manualOverrideReason || undefined,
          },
        }),
      "Mileage saved.",
      ["odometerStart", "odometerEnd", "milesDriven", "source", "manualOverrideReason"],
      "mileage",
    );
  }

  async function addCarePlanLink(
    kind: "problem" | "goal" | "intervention",
    id: string,
  ): Promise<void> {
    if (!encounterId) return;

    await runMutation(
      () =>
        post("/api/v1/encounters/{encounterId}/care-plan-links", {
          params: {
            path: {
              encounterId,
            },
          },
          body:
            kind === "problem"
              ? {
                  problemId: id,
                }
              : kind === "goal"
                ? {
                    goalId: id,
                  }
                : {
                    interventionId: id,
                  },
        }),
      "Care Plan link saved.",
    );
  }

  async function createCarePlanFromEncounter(): Promise<void> {
    if (!encounter) return;

    setBusy(true);
    setActionError(null);
    setNotice(null);

    const res = await post("/api/v1/patients/{patientId}/care-plan", {
      params: {
        path: {
          patientId: encounter.patientId,
        },
      },
      body: {
        admissionId: encounter.admissionId,
      },
    });

    setBusy(false);

    if (res.error) {
      setActionError(
        errorMessage(res.error, "The Care Plan could not be created from this encounter."),
      );
      return;
    }

    navigate(`/patients/${encounter.patientId}/care-plan`);
  }

  async function finalizeEncounter(): Promise<void> {
    if (!encounterId) return;

    await runMutation(
      () =>
        post("/api/v1/encounters/{encounterId}/finalize", {
          params: {
            path: {
              encounterId,
            },
          },
          body: {},
        }),
      "Encounter finalized.",
      [
        "clinicalSummary",
        "bpSystolic",
        "bpDiastolic",
        "heartRate",
        "respiratoryRate",
        "temperature",
        "temperatureUnit",
        "spo2",
        "painScore",
        "painScale",
        "odometerStart",
        "odometerEnd",
        "milesDriven",
        "source",
        "manualOverrideReason",
      ],
    );
  }

  async function voidDraft(): Promise<void> {
    if (!encounterId) return;

    await runMutation(
      () =>
        post("/api/v1/encounters/{encounterId}/void", {
          params: {
            path: {
              encounterId,
            },
          },
          body: {
            reason: reason.trim(),
          },
        }),
      "Draft voided.",
      ["reason"],
    );
  }

  async function createAddendum(): Promise<void> {
    if (!encounterId) return;

    await runMutation(
      () =>
        post("/api/v1/encounters/{encounterId}/addenda", {
          params: {
            path: {
              encounterId,
            },
          },
          body: {
            reason: reason.trim(),
          },
        }),
      "Addendum opened.",
      ["reason"],
    );
  }

  async function launchAssessment(): Promise<void> {
    if (!encounterId || !encounter) return;

    let data: Record<string, unknown>;

    try {
      data = JSON.parse(assessment.data) as Record<string, unknown>;
    } catch {
      setActionError(null);
      setFieldErrors((current) => ({
        ...current,
        data: "Assessment payload must be valid JSON.",
      }));
      return;
    }

    setBusy(true);
    setActionError(null);
    clearFieldErrors(["scaleType", "data"]);

    const res = await post("/api/v1/patients/{patientId}/assessments", {
      params: {
        path: {
          patientId: encounter.patientId,
        },
      },
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
      const mapped = fieldErrorsFrom(res.error, ["scaleType", "data"]);

      if (Object.keys(mapped).length > 0) {
        setFieldErrors((current) => ({ ...current, ...mapped }));
        setActionError(null);
      } else {
        setActionError(
          errorMessage(res.error, "Assessment could not be created."),
        );
      }

      return;
    }

    const responseData = res.data as
      | {
          id?: string;
          assessmentId?: string;
        }
      | undefined;

    const id = responseData?.id ?? responseData?.assessmentId;

    if (id) {
      navigate(`/patients/${encounter.patientId}/assessments/${id}`);
      return;
    }

    setUtilityModal(null);
    await load();
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
      <PatientChartBail
        banner={bailBanner}
        patientId={patientId}
        current="encounters"
      >
        <LoadingSpinner />
      </PatientChartBail>
    );
  }

  if (error || !encounter) {
    return (
      <PatientChartBail
        banner={bailBanner}
        patientId={patientId}
        current="encounters"
      >
        <EmptyState title="Unavailable" description={error ?? "Not found."} />
      </PatientChartBail>
    );
  }

  const e = encounter;

  /*
   * Existing business-state rules.
   * These remain unchanged.
   */
  const canSign = e.status === "finalized";

  const canAcknowledge =
    cosignStatus === "pending" ||
    cosignStatus === "routed" ||
    cosignStatus === "escalated";

  const canCosignSign = cosignStatus === "acknowledged";

  const canSupervisorRelease =
    cosignStatus === "escalated" || cosignStatus === "hard_cap_reached";

  /*
   * UX progress.
   *
   * This does NOT mean that all five sections are mandatory.
   * It is not sent to the backend and does not gate Finalize.
   */
  const documentationStarted = noteText.trim().length > 0;

  const vitalsStarted =
    hasAnyValue(e.vitals) ||
    [
      vitals.bpSystolic,
      vitals.bpDiastolic,
      vitals.heartRate,
      vitals.respiratoryRate,
      vitals.temperature,
      vitals.spo2,
      vitals.painScore,
    ].some((value) => value.trim().length > 0);

  const carePlanStarted = e.carePlanLinks.length > 0;

  const assessmentsStarted = assessments.length > 0;

  const mileageStarted =
    hasAnyValue(e.mileage) ||
    [
      mileage.odometerStart,
      mileage.odometerEnd,
      mileage.milesDriven,
      mileage.manualOverrideReason,
    ].some((value) => value.trim().length > 0);

  const workflowSections = [
    {
      key: "documentation",
      label: "Documentation",
      started: documentationStarted,
    },
    {
      key: "vitals",
      label: "Vitals",
      started: vitalsStarted,
    },
    {
      key: "care-plan",
      label: "Care Plan",
      started: carePlanStarted,
    },
    {
      key: "assessments",
      label: "Assessments",
      started: assessmentsStarted,
    },
    // {
    //   key: "mileage",
    //   label: "Mileage",
    //   started: mileageStarted,
    // },
  ] as const;

  const startedSections = workflowSections.filter(
    (section) => section.started,
  ).length;

  const nextSuggestedSection =
    workflowSections.find((section) => !section.started)?.label ??
    "Review & finalize";

  const banner = patient ? (
    <PatientBanner
      name={`${patient.firstName} ${patient.lastName}`}
      meta={`DOB ${patient.dob}${
        ageYears(patient.dob) != null ? ` · ${ageYears(patient.dob)}y` : ""
      }`}
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
        <div style={bannerActions}>
          <button
            type="button"
            onClick={() => navigate(`/patients/${e.patientId}/encounters`)}
            style={ghostBtn}
          >
            Back to encounters
          </button>

          <button
            type="button"
            onClick={() => navigate(`/patients/${e.patientId}`)}
            style={ghostBtn}
          >
            Open chart
          </button>
        </div>
      }
    />
  ) : (
    <PatientBanner name="Encounter" />
  );

  return (
    <PatientWorkspaceLayout banner={banner}>
      <div style={workspace}>
        <div style={workspaceBody}>
          <ChartModuleRail patientId={e.patientId} current="encounters" />
          <div style={encounterContent}>
            {/* ─────────────────────────────────────────────────────────────
              MAIN VISIT DOCUMENTATION
          ────────────────────────────────────────────────────────────── */}
            <main style={mainColumn}>
              <header style={encounterHeader}>
                <div>
                  <div style={titleLine}>
                    <h1 style={pageTitle}>{stateLabel(e.encounterType)}</h1>

                    <StatusPill
                      label={stateLabel(e.status)}
                      tone={ENCOUNTER_TONE[e.status] ?? "neutral"}
                    />
                  </div>

                  <p style={meta}>
                    {stateLabel(e.discipline)} ·{" "}
                    <span className="tabular-nums">{e.serviceDate}</span>
                    {e.isF2f ? " · F2F" : ""} · v{e.version}
                  </p>
                </div>
              </header>

              {/* ───────────────────────────────────────────────────────
                PRIMARY UX GUIDANCE
            ──────────────────────────────────────────────────────── */}

              {e.status === "draft" ? (
                <section style={workflowCard}>
                  <div style={workflowCardTop}>
                    <div>
                      <span style={eyebrow}>VISIT WORKFLOW</span>

                      <h2 style={workflowTitle}>Complete the visit note</h2>

                      <p style={workflowHint}>
                        Suggested next:{" "}
                        <strong
                          style={{
                            color: t.onSurface,
                          }}
                        >
                          {nextSuggestedSection}
                        </strong>
                      </p>
                    </div>

                    <span style={workflowCount}>
                      {startedSections}/{workflowSections.length} sections
                      started
                    </span>
                  </div>

                  <div
                    style={workflowSteps}
                    aria-label="Visit documentation progress"
                  >
                    {workflowSections.map((section, index) => (
                      <div key={section.key} style={workflowStep}>
                        <span
                          style={
                            section.started ? workflowDotDone : workflowDot
                          }
                        >
                          {section.started ? "✓" : index + 1}
                        </span>

                        <span
                          style={{
                            color: section.started
                              ? t.onSurface
                              : t.onSurfaceVariant,
                            fontWeight: section.started ? 650 : 500,
                          }}
                        >
                          {section.label}
                        </span>
                      </div>
                    ))}
                  </div>

                  <p style={workflowDisclaimer}>
                    This guide helps with navigation only. Existing backend
                    rules remain the source of truth for finalization,
                    signatures, cosignature and compliance.
                  </p>
                </section>
              ) : null}

              {notice ? <div style={noticeStyle}>{notice}</div> : null}

              {actionError ? (
                <div role="alert" aria-live="assertive" style={pageAlertStyle}>
                  <Glyph name="alert" size={16} />
                  <span>{actionError}</span>
                </div>
              ) : null}

              {/* ───────────────────────────────────────────────────────
                1. DOCUMENTATION
            ──────────────────────────────────────────────────────── */}

            <section style={sectionCard}>
              <div style={sectionHeader}>
                <SectionHeading
                  step="1"
                  eyebrowText="CLINICAL NOTE"
                  title="Documentation"
                  description="Compose the visit note from the HearthNote template."
                  complete={documentationStarted}
                />

                {e.status === "draft" ? (
                  <button
                    type="button"
                    onClick={() => navigate(`/patients/${e.patientId}/encounters/${e.id}/compose`)}
                    disabled={busy}
                    style={primaryBtn}
                  >
                    {documentationStarted ? "Edit note" : "Compose note"}
                  </button>
                ) : null}
              </div>

              {/* #91/#114 — the note is AUTHORED in the HearthNote composer: the template's sections, the
                  vocabulary each accepts, and per-section free text (sealed under the tenant DEK). A
                  single free-text box here could not satisfy the §2.6 Layer-3 gate, which asks for every
                  REQUIRED section, and stored its prose in the clear. This panel shows the assembled
                  Layer-1 note as it currently reads. */}
              {e.status === "draft" ? (
                <div style={readOnlyPanel}>
                  <p style={noteBody}>
                    {noteText || "Nothing documented yet. Use Compose note to document this visit."}
                  </p>
                </div>
              ) : (
                <div style={readOnlyPanel}>
                  <p style={noteBody}>
                    {e.finalDocumentation || noteText || "No assembled documentation is available."}
                  </p>
                </div>
              )}
            </section>

              {/* ───────────────────────────────────────────────────────
                2. VITALS
            ──────────────────────────────────────────────────────── */}

              <section style={sectionCard}>
                <div style={sectionHeader}>
                  <SectionHeading
                    step="2"
                    eyebrowText="OBSERVATIONS"
                    title="Vitals"
                    description="Capture measurements collected during the visit."
                    complete={vitalsStarted}
                  />

                  {e.status === "draft" ? (
                    <button
                      type="button"
                      onClick={() => void saveVitals()}
                      disabled={busy}
                      style={secondaryBtn}
                    >
                      Save vitals
                    </button>
                  ) : null}
                </div>

                {sectionErrors.vitals ? (
                  <div
                    role="alert"
                    aria-live="assertive"
                    style={pageAlertStyle}
                  >
                    <Glyph name="alert" size={16} />
                    <span>{sectionErrors.vitals}</span>
                  </div>
                ) : null}

              <div style={vitalsGrid}>
                <Input
                  label="BP systolic"
                  suffix="mmHg"
                  value={vitals.bpSystolic}
                  onChange={(value) => {
                    setVitals((current) => ({
                      ...current,
                      bpSystolic: value,
                    }));
                    clearFieldError("bpSystolic");
                  }}
                  error={fieldErrors.bpSystolic}
                />

                <Input
                  label="BP diastolic"
                  suffix="mmHg"
                  value={vitals.bpDiastolic}
                  onChange={(value) => {
                    setVitals((current) => ({
                      ...current,
                      bpDiastolic: value,
                    }));
                    clearFieldError("bpDiastolic");
                  }}
                  error={fieldErrors.bpDiastolic}
                />

                <Input
                  label="Heart rate"
                  suffix="bpm"
                  value={vitals.heartRate}
                  onChange={(value) => {
                    setVitals((current) => ({
                      ...current,
                      heartRate: value,
                    }));
                    clearFieldError("heartRate");
                  }}
                  error={fieldErrors.heartRate}
                />

                <Input
                  label="Respiratory rate"
                  suffix="/min"
                  value={vitals.respiratoryRate}
                  onChange={(value) => {
                    setVitals((current) => ({
                      ...current,
                      respiratoryRate: value,
                    }));
                    clearFieldError("respiratoryRate");
                  }}
                  error={fieldErrors.respiratoryRate}
                />

                <Input
                  label="Temperature"
                  value={vitals.temperature}
                  onChange={(value) => {
                    setVitals((current) => ({
                      ...current,
                      temperature: value,
                    }));
                    clearFieldError("temperature");
                  }}
                  error={fieldErrors.temperature}
                />

                <Input
                  label="SpO₂"
                  suffix="%"
                  value={vitals.spo2}
                  onChange={(value) => {
                    setVitals((current) => ({
                      ...current,
                      spo2: value,
                    }));
                    clearFieldError("spo2");
                  }}
                  error={fieldErrors.spo2}
                />

                <Input
                  label="Pain"
                  suffix="/10"
                  value={vitals.painScore}
                  onChange={(value) => {
                    setVitals((current) => ({
                      ...current,
                      painScore: value,
                    }));
                    clearFieldError("painScore");
                  }}
                  error={fieldErrors.painScore}
                />
              </div>
            </section>

            {/* ───────────────────────────────────────────────────────
                3. CARE PLAN
            ──────────────────────────────────────────────────────── */}

              <section style={sectionCard}>
                <div style={sectionHeader}>
                  <SectionHeading
                    step="3"
                    eyebrowText="PLAN OF CARE"
                    title="Care Plan"
                    description="Link only the problems, goals and interventions addressed during this encounter."
                    complete={carePlanStarted}
                  />

                  {carePlan?.redacted ? (
                    <span style={restrictedBadge}>
                      <Glyph name="lock" size={13} />
                      Restricted content omitted
                    </span>
                  ) : null}

                  {/* {e.status === "draft" && !carePlan ? (
                    <button
                      type="button"
                      onClick={() => void createCarePlanFromEncounter()}
                      disabled={busy}
                      style={secondaryBtn}
                    >
                      Create care plan
                    </button>
                  ) : null} */}
                </div>

                <div style={sectionExplanation}>
                  <Glyph name="info" size={15} />

                  <span>
                    These links document what part of the active Care Plan was
                    addressed during this visit. If the patient does not have a
                    Care Plan yet, create it from this encounter using the
                    current patient and admission context.
                  </span>
                </div>

                <CarePlanPicker
                  encounter={e}
                  carePlan={carePlan}
                  onSelect={(kind, id) => void addCarePlanLink(kind, id)}
                  onCreate={() => void createCarePlanFromEncounter()}
                  onOpen={() => navigate(`/patients/${e.patientId}/care-plan`)}
                  busy={busy || e.status !== "draft"}
                />
              </section>

              {/* ───────────────────────────────────────────────────────
                4. ASSESSMENTS
            ──────────────────────────────────────────────────────── */}

              <section style={sectionCard}>
                <div style={sectionHeader}>
                  <SectionHeading
                    step="4"
                    eyebrowText="ASSESSMENTS"
                    title="Assessments"
                    description="Review assessments linked to this encounter or launch one when clinically appropriate."
                    complete={assessmentsStarted}
                  />

                  {e.status === "draft" ? (
                    <button
                      type="button"
                      onClick={() => setUtilityModal("assessment")}
                      style={secondaryBtn}
                    >
                      New assessment
                    </button>
                  ) : null}
                </div>

                <div style={assessmentPanel}>
                  <div>
                    <div style={subsectionHeader}>
                      <div>
                        <span style={subsectionTitle}>
                          Encounter assessments
                        </span>

                        <p style={subsectionHelp}>
                          Assessments linked directly to this encounter.
                        </p>
                      </div>

                      <button
                        type="button"
                        onClick={() =>
                          navigate(`/patients/${e.patientId}/assessments`)
                        }
                        style={textBtn}
                      >
                        View M9 timeline
                      </button>
                    </div>

                    <LinkedRows
                      rows={assessments}
                      empty="No M9 assessments are linked to this encounter."
                    />
                  </div>

                  <div style={divider} />

                  <div>
                    <div style={subsectionHeader}>
                      <div>
                        <span style={subsectionTitle}>HOPE context</span>

                        <p style={subsectionHelp}>
                          Recent HOPE records visible for this patient.
                        </p>
                      </div>

                      <button
                        type="button"
                        onClick={() =>
                          navigate(`/patients/${e.patientId}/hope`)
                        }
                        style={textBtn}
                      >
                        View HOPE timeline
                      </button>
                    </div>

                    <LinkedRows
                      rows={hopeAssessments.slice(0, 3)}
                      empty="No HOPE records are visible for this patient."
                    />
                  </div>
                </div>
              </section>

              {/* ───────────────────────────────────────────────────────
                5. MILEAGE
            ──────────────────────────────────────────────────────── */}

              <section
                style={{
                  ...sectionCard,
                  marginBottom: "1.5rem",
                }}
              >
                {sectionErrors.mileage ? (
                  <div role="alert" aria-live="assertive" style={pageAlertStyle}>
                    <Glyph name="alert" size={16} />
                    <span>{sectionErrors.mileage}</span>
                  </div>
                ) : null}
                <div style={sectionHeader}>
                  <SectionHeading
                    step="5"
                    eyebrowText="VISIT LOGISTICS"
                    title="Mileage"
                    description="Record travel information associated with this visit."
                    complete={mileageStarted}
                  />

                  {e.status === "draft" ? (
                    <button
                      type="button"
                      onClick={() => void saveMileage()}
                      disabled={busy}
                      style={secondaryBtn}
                    >
                      Save mileage
                    </button>
                  ) : null}
                </div>

                <div style={mileageGrid}>
                  <Input
                    label="Odometer start"
                    value={mileage.odometerStart}
                    onChange={(value) => {
                      setMileage((current) => ({
                        ...current,
                        odometerStart: value,
                      }));
                      clearFieldError("odometerStart");
                    }}
                    error={fieldErrors.odometerStart}
                  />

                  <Input
                    label="Odometer end"
                    value={mileage.odometerEnd}
                    onChange={(value) => {
                      setMileage((current) => ({
                        ...current,
                        odometerEnd: value,
                      }));
                      clearFieldError("odometerEnd");
                    }}
                    error={fieldErrors.odometerEnd}
                  />

                  <Input
                    label="Miles driven"
                    value={mileage.milesDriven}
                    onChange={(value) => {
                      setMileage((current) => ({
                        ...current,
                        milesDriven: value,
                      }));
                      clearFieldError("milesDriven");
                    }}
                    error={fieldErrors.milesDriven}
                  />

                  <label style={fieldStyle}>
                    <span style={fieldLabelStyle}>Source</span>

                    <select
                      value={mileage.source}
                      onChange={(event) => {
                        setMileage((current) => ({
                          ...current,
                          source: event.target.value,
                        }));
                        clearFieldError("source");
                      }}
                      style={{
                        ...inputStyle,
                        ...(fieldErrors.source ? fieldControlErrorStyle : null),
                      }}
                      aria-invalid={Boolean(fieldErrors.source)}
                    >
                      <option value="odometer">Odometer</option>

                      <option value="route_calc">Route calculation</option>

                      <option value="manual_override">Manual override</option>
                    </select>
                    <FieldError message={fieldErrors.source} />
                  </label>
                </div>

                {mileage.source === "manual_override" ? (
                  <label
                    style={{
                      ...fieldStyle,
                      marginTop: "0.875rem",
                    }}
                  >
                    <span style={fieldLabelStyle}>Override reason</span>

                    <textarea
                      value={mileage.manualOverrideReason}
                      onChange={(event) => {
                        setMileage((current) => ({
                          ...current,
                          manualOverrideReason: event.target.value,
                        }));
                        clearFieldError("manualOverrideReason");
                      }}
                      rows={3}
                      placeholder="Explain why mileage is being entered manually..."
                      style={{
                        ...textareaStyle,
                        ...(fieldErrors.manualOverrideReason
                          ? fieldControlErrorStyle
                          : null),
                      }}
                      aria-invalid={Boolean(fieldErrors.manualOverrideReason)}
                    />
                    <FieldError message={fieldErrors.manualOverrideReason} />
                  </label>
                ) : null}
              </section>
            </main>

            {/* ─────────────────────────────────────────────────────────
              RIGHT CONTEXT RAIL
          ────────────────────────────────────────────────────────── */}

            <aside style={rightRail}>
              {/* ─────────────────────────────────────────────────────────
      QUICK ACTIONS
  ────────────────────────────────────────────────────────── */}
              <div style={quickActionsCard}>
                <div style={railHeading}>
                  <div style={railIconBox}>
                    <Glyph name="arrow-right" size={16} />
                  </div>

                  <div>
                    <h2 style={railTitle}>Quick actions</h2>
                    <p style={railDescription}>Encounter workflow</p>
                  </div>
                </div>

                <div style={quickActionContext}>
                  {cosignStatus && !e.cosignedAt ? (
                    <>
                      <span style={guardChip}>
                        <Glyph name="lock" size={14} />
                        Co-signature pending
                      </span>

                      <span style={quickActionHelp}>
                        Complete the appropriate cosignature action to continue
                        the workflow.
                      </span>
                    </>
                  ) : e.status === "draft" ? (
                    <>
                      <strong style={quickActionTitle}>Draft visit</strong>

                      <span style={quickActionHelp}>
                        Complete the visit documentation, then finalize when
                        ready.
                      </span>
                    </>
                  ) : e.status === "finalized" ? (
                    <>
                      <strong style={quickActionTitle}>
                        Ready for signature
                      </strong>

                      <span style={quickActionHelp}>
                        The encounter has been finalized and can now be signed.
                      </span>
                    </>
                  ) : (
                    <>
                      <strong style={quickActionTitle}>
                        {stateLabel(e.status)}
                      </strong>

                      <span style={quickActionHelp}>
                        Encounter workflow status
                      </span>
                    </>
                  )}
                </div>

                <div style={quickActionButtons}>
                  {canSupervisorRelease ? (
                    <button
                      type="button"
                      onClick={() => setCeremony("supervisor-release")}
                      style={{
                        ...secondaryBtn,
                        width: "100%",
                      }}
                    >
                      Supervisor release
                    </button>
                  ) : null}

                  {canAcknowledge ? (
                    <button
                      type="button"
                      onClick={() => setCeremony("acknowledge")}
                      style={{
                        ...secondaryBtn,
                        width: "100%",
                      }}
                    >
                      Acknowledge cosignature
                    </button>
                  ) : null}

                  {canCosignSign ? (
                    <button
                      type="button"
                      onClick={() => setCeremony("cosign-sign")}
                      style={{
                        ...primaryBtn,
                        width: "100%",
                      }}
                    >
                      Sign cosignature
                    </button>
                  ) : null}

                  {canSign ? (
                    <button
                      type="button"
                      onClick={() => setCeremony("sign")}
                      style={{
                        ...primaryBtn,
                        width: "100%",
                      }}
                    >
                      Sign encounter
                    </button>
                  ) : null}

                  {e.status === "draft" ? (
                    <>
                      <button
                        type="button"
                        onClick={() => void finalizeEncounter()}
                        disabled={busy}
                        style={{
                          ...primaryBtn,
                          width: "100%",
                        }}
                      >
                        {busy ? "Working…" : "Review & finalize"}
                      </button>

                      <button
                        type="button"
                        onClick={() => setUtilityModal("void")}
                        style={{
                          ...dangerGhostBtn,
                          width: "100%",
                        }}
                      >
                        Void draft
                      </button>
                    </>
                  ) : null}

                  {e.status === "signed" || e.status === "cosigned" ? (
                    <button
                      type="button"
                      onClick={() => setUtilityModal("addendum")}
                      style={{
                        ...secondaryBtn,
                        width: "100%",
                      }}
                    >
                      Add addendum
                    </button>
                  ) : null}
                </div>
              </div>

              {/* ─────────────────────────────────────────────────────────
      SIGN-OFF
  ────────────────────────────────────────────────────────── */}
              <div style={railCard}>
                <div style={railHeading}>
                  <div style={railIconBox}>
                    <Glyph name="shield" size={16} />
                  </div>

                  <div>
                    <h2 style={railTitle}>Sign-off</h2>
                    <p style={railDescription}>Signature and review status</p>
                  </div>
                </div>

                <dl style={lifeGrid}>
                  <dt style={dt}>Encounter</dt>

                  <dd style={dd}>
                    <StatusPill
                      label={stateLabel(e.status)}
                      tone={ENCOUNTER_TONE[e.status] ?? "neutral"}
                    />
                  </dd>

                  <dt style={dt}>Cosignature</dt>

                  <dd style={dd}>
                    {cosignStatus ? (
                      <StatusPill
                        label={stateLabel(cosignStatus)}
                        tone={COSIGN_TONE[cosignStatus] ?? "neutral"}
                      />
                    ) : (
                      <span style={mutedValue}>No request</span>
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

                      <dd style={dd} className="tabular-nums">
                        {e.signedAt.slice(0, 16).replace("T", " ")}
                      </dd>
                    </>
                  ) : null}

                  {e.cosignedAt ? (
                    <>
                      <dt style={dt}>Cosigned</dt>

                      <dd style={dd} className="tabular-nums">
                        {e.cosignedAt.slice(0, 16).replace("T", " ")}
                      </dd>
                    </>
                  ) : null}
                </dl>

                {cosignStatus && !e.cosignedAt ? (
                  <div style={railWarningBox}>
                    <Glyph name="lock" size={14} />
                    <span>Co-signature is still pending.</span>
                  </div>
                ) : null}
              </div>

              <div style={railCard}>
                <div style={railHeading}>
                  <div style={railIconBox}>
                    <Glyph name="calendar" size={16} />
                  </div>

                  <div>
                    <h2 style={railTitle}>Visit</h2>

                    <p style={railDescription}>Scheduling and EVV context</p>
                  </div>
                </div>

                <dl style={lifeGrid}>
                  <dt style={dt}>Source</dt>

                  <dd style={dd}>
                    {e.visitId ? "Scheduled visit" : "PRN / unscheduled"}
                  </dd>

                  <dt style={dt}>Service date</dt>

                  <dd style={dd} className="tabular-nums">
                    {e.serviceDate}
                  </dd>

                  {e.visitId ? (
                    <>
                      <dt style={dt}>Linked visit</dt>

                      <dd style={dd}>
                        <button
                          type="button"
                          onClick={() =>
                            navigate(`/scheduling/visits/${e.visitId}`)
                          }
                          style={linkBtn}
                        >
                          Open visit
                        </button>
                      </dd>
                    </>
                  ) : null}
                </dl>
              </div>

              <div style={railCard}>
                <div style={railHeading}>
                  <div style={railIconBox}>
                    <Glyph name="arrow-right" size={16} />
                  </div>

                  <div>
                    <h2 style={railTitle}>Navigation</h2>

                    <p style={railDescription}>Secondary actions</p>
                  </div>
                </div>

                <div style={navigationActions}>
                  <button
                    type="button"
                    onClick={() => navigate(`/patients/${e.patientId}`)}
                    style={railActionBtn}
                  >
                    Back to patient chart
                  </button>

                  <button
                    type="button"
                    onClick={() => navigate("/work/cosignatures")}
                    style={railActionBtn}
                  >
                    Open cosignature queue
                  </button>
                </div>
              </div>
            </aside>
          </div>
        </div>
      </div>

      {/* ─────────────────────────────────────────────────────────────
          SIGN ENCOUNTER
      ────────────────────────────────────────────────────────────── */}

      <CeremonyModal
        open={ceremony === "sign"}
        title="Sign encounter"
        attestation={
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "0.5rem",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.4rem",
              }}
            >
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
        signer={{
          name: "Signing clinician",
          role: "This session",
        }}
        commitLabel={busy ? "Signing…" : "Sign & commit"}
        onCommit={() => void runWrite("sign")}
        onCancel={closeCeremony}
      />

      {/* ─────────────────────────────────────────────────────────────
          ACKNOWLEDGE COSIGNATURE
      ────────────────────────────────────────────────────────────── */}

      <CeremonyModal
        open={ceremony === "acknowledge"}
        title="Acknowledge cosignature request"
        attestation={
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "0.5rem",
            }}
          >
            <span
              style={{
                fontSize: "0.8125rem",
                color: t.onSurfaceVariant,
              }}
            >
              Confirms you have opened this encounter for cosignature review.
              This does not sign it.
            </span>

            {actionError ? (
              <p role="alert" aria-live="assertive" style={alertStyle}>
                {actionError}
              </p>
            ) : null}
          </div>
        }
        signer={{
          name: "Cosigner",
          role: "This session",
        }}
        commitLabel={busy ? "Acknowledging…" : "Acknowledge"}
        onCommit={() => void runWrite("acknowledge")}
        onCancel={closeCeremony}
      />

      {/* ─────────────────────────────────────────────────────────────
          COSIGN
      ────────────────────────────────────────────────────────────── */}

      <CeremonyModal
        open={ceremony === "cosign-sign"}
        title="Sign cosignature"
        attestation={
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "0.5rem",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.4rem",
              }}
            >
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
        signer={{
          name: "Cosigning RN",
          role: "This session",
        }}
        commitLabel={busy ? "Signing…" : "Sign & commit"}
        onCommit={() => void runWrite("cosign-sign")}
        onCancel={closeCeremony}
      />

      {/* ─────────────────────────────────────────────────────────────
          SUPERVISOR RELEASE
      ────────────────────────────────────────────────────────────── */}

      <CeremonyModal
        open={ceremony === "supervisor-release"}
        title="Supervisor release"
        attestation={
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "0.6rem",
            }}
          >
            <span
              style={{
                fontSize: "0.8125rem",
                color: t.onSurfaceVariant,
              }}
            >
              Releases this encounter from the 48-hour cosignature hard cap.
            </span>

            <label
              htmlFor="supervisor-release-reason"
              style={{
                fontSize: "0.75rem",
                fontWeight: 600,
                color: t.onSurfaceVariant,
              }}
            >
              Reason (≥ {REASON_MIN} characters)
            </label>

            <textarea
              id="supervisor-release-reason"
              aria-describedby="supervisor-release-reason-count"
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
                clearFieldError("reason");
              }}
              rows={3}
              style={{
                ...textareaStyle,
                ...(fieldErrors.reason ? fieldControlErrorStyle : null),
              }}
              aria-invalid={Boolean(fieldErrors.reason)}
            />
            <FieldError message={fieldErrors.reason} />

            <span
              id="supervisor-release-reason-count"
              style={{
                fontSize: "0.7rem",
                color:
                  reason.trim().length >= REASON_MIN
                    ? t.onSurfaceVariant
                    : t.warning,
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
        signer={{
          name: "Supervisor",
          role: "This session",
        }}
        commitLabel={busy ? "Releasing…" : "Release"}
        onCommit={() => void runWrite("supervisor-release")}
        onCancel={closeCeremony}
      />

      {/* ─────────────────────────────────────────────────────────────
          UTILITY MODAL
      ────────────────────────────────────────────────────────────── */}

      <Modal
        open={
          utilityModal === "void" ||
          utilityModal === "addendum" ||
          utilityModal === "assessment"
        }
        onClose={busy ? undefined : () => setUtilityModal(null)}
        ariaLabel="Encounter action"
        width="34rem"
      >
        <div style={modalBody}>
          <div>
            <span style={eyebrow}>ENCOUNTER ACTION</span>

            <h2 style={modalTitle}>
              {utilityModal === "void"
                ? "Void draft"
                : utilityModal === "addendum"
                  ? "Add addendum"
                  : "Launch assessment"}
            </h2>
          </div>

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
                  onChange={(event) => {
                    setAssessment((current) => ({
                      ...current,
                      scaleType: event.target.value,
                    }));
                    clearFieldError("scaleType");
                  }}
                  style={{
                    ...inputStyle,
                    ...(fieldErrors.scaleType ? fieldControlErrorStyle : null),
                  }}
                  aria-invalid={Boolean(fieldErrors.scaleType)}
                >
                  {SCALE_TYPES.map((scale) => (
                    <option key={scale} value={scale}>
                      {stateLabel(scale)}
                    </option>
                  ))}
                </select>
                <FieldError message={fieldErrors.scaleType} />
              </label>

              <label style={fieldStyle}>
                <span style={fieldLabelStyle}>Assessment data JSON</span>

                <textarea
                  value={assessment.data}
                  onChange={(event) => {
                    setAssessment((current) => ({
                      ...current,
                      data: event.target.value,
                    }));
                    clearFieldError("data");
                  }}
                  rows={5}
                  style={{
                    ...textareaStyle,
                    ...(fieldErrors.data ? fieldControlErrorStyle : null),
                  }}
                  aria-invalid={Boolean(fieldErrors.data)}
                />
                <FieldError message={fieldErrors.data} />
              </label>
            </>
          ) : (
            <label style={fieldStyle}>
              <span style={fieldLabelStyle}>Reason</span>

              <textarea
                value={reason}
                onChange={(event) => {
                  setReason(event.target.value);
                  clearFieldError("reason");
                }}
                rows={4}
                style={{
                  ...textareaStyle,
                  ...(fieldErrors.reason ? fieldControlErrorStyle : null),
                }}
                aria-invalid={Boolean(fieldErrors.reason)}
              />
              <FieldError message={fieldErrors.reason} />
            </label>
          )}

          <div style={modalActions}>
            <button
              type="button"
              onClick={() => setUtilityModal(null)}
              disabled={busy}
              style={secondaryBtn}
            >
              Cancel
            </button>

            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (utilityModal === "void") {
                  void voidDraft();
                } else if (utilityModal === "addendum") {
                  void createAddendum();
                } else {
                  void launchAssessment();
                }
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

/* ──────────────────────────────────────────────────────────────────────────
   PRESENTATIONAL COMPONENTS
────────────────────────────────────────────────────────────────────────── */

function SectionHeading({
  step,
  eyebrowText,
  title,
  description,
  complete,
}: {
  step: string;
  eyebrowText: string;
  title: string;
  description: string;
  complete: boolean;
}): JSX.Element {
  return (
    <div style={sectionHeading}>
      <div style={complete ? sectionNumberComplete : sectionNumber}>
        {complete ? "✓" : step}
      </div>

      <div>
        <span style={eyebrow}>{eyebrowText}</span>

        <h2 style={sectionTitle}>{title}</h2>

        <p style={sectionHelp}>{description}</p>
      </div>
    </div>
  );
}

function Input({
  label,
  value,
  onChange,
  suffix,
  error,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  suffix?: string;
  error?: string;
}): JSX.Element {
  return (
    <label style={fieldStyle}>
      <span style={fieldLabelStyle}>{label}</span>

      <div
        style={{
          ...inputWrapper,
          ...(error ? fieldControlErrorStyle : null),
        }}
      >
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          style={plainInputStyle}
          aria-invalid={Boolean(error)}
        />

        {suffix ? <span style={inputSuffix}>{suffix}</span> : null}
      </div>

      <FieldError message={error} />
    </label>
  );
}

function CarePlanPicker({
  encounter,
  carePlan,
  busy,
  onSelect,
  onCreate,
  onOpen,
}: {
  encounter: Encounter;
  carePlan: CarePlanRelevant | null;
  busy: boolean;
  onSelect: (kind: "problem" | "goal" | "intervention", id: string) => void;
  onCreate: () => void;
  onOpen: () => void;
}): JSX.Element {
  if (!carePlan) {
    return (
      <div style={carePlanEmptyState}>
        <div style={carePlanEmptyIcon}>
          <Glyph name="clipboard-list" size={20} />
        </div>

        <div style={carePlanEmptyContent}>
          <strong style={carePlanEmptyTitle}>No Care Plan yet</strong>

          <span style={carePlanEmptyDescription}>
            Create the patient's Care Plan before linking problems, goals, or
            interventions to this visit.
          </span>

          {encounter.status === "draft" ? (
            <button
              type="button"
              onClick={onCreate}
              disabled={busy}
              style={primaryBtn}
            >
              {busy ? "Creating…" : "Create Care Plan"}
            </button>
          ) : (
            <button type="button" onClick={onOpen} style={secondaryBtn}>
              Open Care Plan
            </button>
          )}
        </div>
      </div>
    );
  }

  const totalItems =
    carePlan.problems.length +
    carePlan.goals.length +
    carePlan.interventions.length;

  if (totalItems === 0) {
    return (
      <div style={carePlanEmptyState}>
        <div style={carePlanEmptyIcon}>
          <Glyph name="clipboard-list" size={20} />
        </div>

        <div style={carePlanEmptyContent}>
          <strong style={carePlanEmptyTitle}>No active Care Plan items</strong>

          <span style={carePlanEmptyDescription}>
            The patient's Care Plan exists, but there are no active problems,
            goals, or interventions available to link to this visit.
          </span>

          <button type="button" onClick={onOpen} style={secondaryBtn}>
            Open Care Plan
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={carePlanGrid}>
      <PickerGroup
        title="Problems addressed"
        description="Clinical problems worked on during this visit."
        rows={carePlan.problems.map((problem) => ({
          id: problem.problemId,
          label: problem.description,
          checked: hasCarePlanLink(
            encounter.carePlanLinks,
            "problem",
            problem.problemId,
          ),
        }))}
        disabled={busy}
        onSelect={(id) => onSelect("problem", id)}
      />

      <PickerGroup
        title="Goals worked toward"
        description="Goals advanced during this visit."
        rows={carePlan.goals.map((goal) => ({
          id: goal.goalId,
          label: goal.text,
          checked: hasCarePlanLink(
            encounter.carePlanLinks,
            "goal",
            goal.goalId,
          ),
        }))}
        disabled={busy}
        onSelect={(id) => onSelect("goal", id)}
      />

      <PickerGroup
        title="Interventions performed"
        description="Care Plan interventions actually performed."
        rows={carePlan.interventions.map((intervention) => ({
          id: intervention.interventionId,
          label: `${intervention.scopeText}${
            intervention.frequencyText ? ` · ${intervention.frequencyText}` : ""
          }`,
          checked: hasCarePlanLink(
            encounter.carePlanLinks,
            "intervention",
            intervention.interventionId,
          ),
        }))}
        disabled={busy}
        onSelect={(id) => onSelect("intervention", id)}
      />
    </div>
  );
}

function PickerGroup({
  title,
  description,
  rows,
  disabled,
  onSelect,
}: {
  title: string;
  description: string;
  rows: Array<{
    id: string;
    label: string;
    checked: boolean;
  }>;
  disabled: boolean;
  onSelect: (id: string) => void;
}): JSX.Element {
  return (
    <div style={pickerGroup}>
      <div style={pickerHeader}>
        <div>
          <span style={pickerTitle}>{title}</span>

          <p style={pickerDescription}>{description}</p>
        </div>

        <span style={pickerCount}>
          {rows.filter((row) => row.checked).length}/{rows.length}
        </span>
      </div>

      {rows.length === 0 ? (
        <p style={meta}>No active items.</p>
      ) : (
        <div style={pickerRows}>
          {rows.map((row) => (
            <label
              key={row.id}
              style={row.checked ? checkboxLineChecked : checkboxLine}
            >
              <input
                type="checkbox"
                checked={row.checked}
                disabled={disabled || row.checked}
                onChange={() => onSelect(row.id)}
              />

              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                }}
              >
                {row.label}
              </span>

              {row.checked ? <span style={linkedLabel}>Linked</span> : null}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function LinkedRows({
  rows,
  empty,
}: {
  rows: AssessmentRow[];
  empty: string;
}): JSX.Element {
  if (rows.length === 0) {
    return (
      <div style={inlineEmptyState}>
        <span style={meta}>{empty}</span>
      </div>
    );
  }

  return (
    <div style={linkedRows}>
      {rows.map((row) => (
        <div key={row.id ?? row.assessmentId} style={linkedRow}>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "0.15rem",
              minWidth: 0,
            }}
          >
            <span
              style={{
                fontSize: "0.85rem",
                color: t.onSurface,
                fontWeight: 600,
              }}
            >
              {stateLabel(row.scaleType ?? row.kind ?? "assessment")}
            </span>

            {row.capturedAt ? (
              <span style={meta}>
                {row.capturedAt.slice(0, 16).replace("T", " ")}
              </span>
            ) : null}
          </div>

          <StatusPill label={stateLabel(row.status)} tone="neutral" />
        </div>
      ))}
    </div>
  );
}

function EmptySection({
  title,
  description,
}: {
  title: string;
  description: string;
}): JSX.Element {
  return (
    <div style={emptySection}>
      <div style={emptyIcon}>
        <Glyph name="dot" size={16} />
      </div>

      <div>
        <span style={emptyTitle}>{title}</span>

        <p style={emptyDescription}>{description}</p>
      </div>
    </div>
  );
}

function RowField({
  label,
  value,
  mono,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
}): JSX.Element {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "0.1rem",
      }}
    >
      <span
        style={{
          fontSize: "0.7rem",
          color: t.onSurfaceVariant,
        }}
      >
        {label}
      </span>

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
  return <span style={monoChip}>{children}</span>;
}

/* ──────────────────────────────────────────────────────────────────────────
   LAYOUT
────────────────────────────────────────────────────────────────────────── */

const workspace: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  width: "100%",
  minWidth: 0,
  maxWidth: "100%",
};

const workspaceBody: CSSProperties = {
  display: "flex",
  alignItems: "stretch",
  width: "100%",
  minWidth: 0,
  maxWidth: "100%",
};

const encounterContent: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) 20rem",
  alignItems: "start",
  flex: 1,
  minWidth: 0,
};

const mainColumn: CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: "1.5rem",
  background: t.surfaceLowest,
};

const encounterHeader: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: "1rem",
};

const titleLine: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
  flexWrap: "wrap",
};

const bannerActions: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-end",
  gap: "0.5rem",
  flexWrap: "wrap",
};

const pageTitle: CSSProperties = {
  margin: 0,
  fontFamily: t.fontDisplay,
  fontWeight: 500,
  fontSize: "1.45rem",
  color: t.onSurface,
};

/* ──────────────────────────────────────────────────────────────────────────
   WORKFLOW CARD
────────────────────────────────────────────────────────────────────────── */

const workflowCard: CSSProperties = {
  ...cardSurface,
  padding: "1.125rem 1.25rem",
  marginTop: "1.125rem",
  background: t.surfaceLow,
};

const workflowCardTop: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: "1rem",
};

const workflowTitle: CSSProperties = {
  margin: 0,
  fontFamily: t.fontDisplay,
  fontWeight: 600,
  fontSize: "1.05rem",
  color: t.onSurface,
};

const workflowHint: CSSProperties = {
  margin: "0.3rem 0 0",
  fontSize: "0.78rem",
  color: t.onSurfaceVariant,
};

const workflowCount: CSSProperties = {
  flexShrink: 0,
  padding: "0.3rem 0.6rem",
  borderRadius: "9999px",
  background: t.surfaceContainer,
  fontSize: "0.72rem",
  color: t.onSurfaceVariant,
};

const workflowSteps: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(5, minmax(0, 1fr))",
  gap: "0.75rem",
  marginTop: "1.1rem",
};

const workflowStep: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.45rem",
  minWidth: 0,
  fontSize: "0.74rem",
};

const workflowDot: CSSProperties = {
  width: "1.45rem",
  height: "1.45rem",
  flexShrink: 0,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: "9999px",
  border: `1px solid ${t.outlineVariant}`,
  color: t.onSurfaceVariant,
  fontSize: "0.68rem",
  fontWeight: 700,
};

const workflowDotDone: CSSProperties = {
  ...workflowDot,
  background: t.primaryTint,
  border: `1px solid ${t.primary}`,
  color: t.primary,
};

const workflowDisclaimer: CSSProperties = {
  margin: "0.85rem 0 0",
  fontSize: "0.68rem",
  lineHeight: 1.45,
  color: t.muted,
};

/* ──────────────────────────────────────────────────────────────────────────
   SECTIONS
────────────────────────────────────────────────────────────────────────── */

const sectionCard: CSSProperties = {
  ...cardSurface,
  padding: "1.25rem",
  marginTop: "1rem",
};

const sectionHeader: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: "1rem",
  marginBottom: "1rem",
};

const sectionHeading: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: "0.75rem",
  minWidth: 0,
};

const sectionNumber: CSSProperties = {
  width: "1.75rem",
  height: "1.75rem",
  flexShrink: 0,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: "9999px",
  background: t.surfaceContainer,
  color: t.onSurfaceVariant,
  fontSize: "0.75rem",
  fontWeight: 700,
};

const sectionNumberComplete: CSSProperties = {
  ...sectionNumber,
  background: t.primaryTint,
  color: t.primary,
};

const eyebrow: CSSProperties = {
  display: "block",
  marginBottom: "0.22rem",
  fontSize: "0.65rem",
  fontWeight: 700,
  letterSpacing: "0.08em",
  color: t.muted,
};

const sectionTitle: CSSProperties = {
  margin: 0,
  fontFamily: t.fontDisplay,
  fontWeight: 500,
  fontSize: "1.05rem",
  color: t.onSurface,
};

const sectionHelp: CSSProperties = {
  margin: "0.22rem 0 0",
  maxWidth: "42rem",
  fontSize: "0.76rem",
  lineHeight: 1.45,
  color: t.onSurfaceVariant,
};

const sectionExplanation: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: "0.5rem",
  marginBottom: "1rem",
  padding: "0.65rem 0.75rem",
  borderRadius: t.radiusMd,
  background: t.surfaceLow,
  fontSize: "0.76rem",
  lineHeight: 1.45,
  color: t.onSurfaceVariant,
};

/* ──────────────────────────────────────────────────────────────────────────
   DOCUMENTATION
────────────────────────────────────────────────────────────────────────── */

const readOnlyPanel: CSSProperties = {
  padding: "0.75rem",
  borderRadius: t.radiusMd,
  background: t.surfaceLow,
};

const noteBody: CSSProperties = {
  margin: 0,
  whiteSpace: "pre-wrap",
  lineHeight: 1.55,
  color: t.onSurface,
  fontSize: "0.9rem",
};

/* ──────────────────────────────────────────────────────────────────────────
   FORM FIELDS
────────────────────────────────────────────────────────────────────────── */

const vitalsGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(8.5rem, 1fr))",
  gap: "0.75rem",
};

const mileageGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(10rem, 1fr))",
  gap: "0.75rem",
};

const fieldStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.35rem",
};

const fieldLabelStyle: CSSProperties = {
  fontSize: "0.72rem",
  color: t.onSurfaceVariant,
  fontWeight: 650,
};

const fieldErrorStyle: CSSProperties = {
  fontSize: "0.7rem",
  lineHeight: 1.35,
  color: t.error,
};

const fieldControlErrorStyle: CSSProperties = {
  borderColor: t.error,
  boxShadow:
    "0 0 0 1px color-mix(in srgb, var(--color-error) 25%, transparent)",
};

const inputWrapper: CSSProperties = {
  display: "flex",
  alignItems: "center",
  minHeight: "2.45rem",
  borderRadius: t.radiusMd,
  border: `1px solid ${t.outlineVariant}`,
  background: t.surfaceLowest,
  overflow: "hidden",
};

const plainInputStyle: CSSProperties = {
  width: "100%",
  minWidth: 0,
  minHeight: "2.35rem",
  padding: "0.45rem 0.6rem",
  border: "none",
  outline: "none",
  background: "transparent",
  color: t.onSurface,
  fontSize: "0.85rem",
};

const inputSuffix: CSSProperties = {
  flexShrink: 0,
  paddingRight: "0.6rem",
  fontSize: "0.7rem",
  color: t.muted,
};

const inputStyle: CSSProperties = {
  minHeight: "2.45rem",
  borderRadius: t.radiusMd,
  border: `1px solid ${t.outlineVariant}`,
  background: t.surfaceLowest,
  color: t.onSurface,
  padding: "0.45rem 0.6rem",
  fontSize: "0.85rem",
};

const textareaStyle: CSSProperties = {
  width: "100%",
  padding: "0.65rem",
  borderRadius: t.radiusMd,
  border: `1px solid ${t.outlineVariant}`,
  background: t.surfaceLowest,
  color: t.onSurface,
  fontFamily: t.fontSans,
  fontSize: "0.85rem",
  resize: "vertical",
};

/* ──────────────────────────────────────────────────────────────────────────
   CARE PLAN
────────────────────────────────────────────────────────────────────────── */

const carePlanGrid: CSSProperties = {
  display: "grid",
  gap: "0.75rem",
};

const pickerGroup: CSSProperties = {
  padding: "0.9rem",
  border: ghostBorder,
  borderRadius: t.radiusMd,
  background: t.surfaceLowest,
};

const pickerHeader: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: "1rem",
  marginBottom: "0.7rem",
};

const pickerTitle: CSSProperties = {
  display: "block",
  fontSize: "0.82rem",
  fontWeight: 650,
  color: t.onSurface,
};

const pickerDescription: CSSProperties = {
  margin: "0.18rem 0 0",
  fontSize: "0.72rem",
  color: t.onSurfaceVariant,
};

const pickerCount: CSSProperties = {
  flexShrink: 0,
  padding: "0.2rem 0.45rem",
  borderRadius: "9999px",
  background: t.surfaceContainer,
  color: t.onSurfaceVariant,
  fontSize: "0.68rem",
  fontWeight: 650,
};

const pickerRows: CSSProperties = {
  display: "grid",
  gap: "0.35rem",
};

const checkboxLine: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: "0.55rem",
  padding: "0.55rem",
  borderRadius: t.radiusMd,
  fontSize: "0.82rem",
  lineHeight: 1.4,
  color: t.onSurface,
  cursor: "pointer",
};

const checkboxLineChecked: CSSProperties = {
  ...checkboxLine,
  background: t.primaryTint,
};

const linkedLabel: CSSProperties = {
  flexShrink: 0,
  fontSize: "0.66rem",
  fontWeight: 650,
  color: t.primary,
};

const restrictedBadge: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.35rem",
  padding: "0.28rem 0.55rem",
  borderRadius: "9999px",
  background: t.surfaceContainer,
  fontSize: "0.7rem",
  color: t.onSurfaceVariant,
};

/* ──────────────────────────────────────────────────────────────────────────
   ASSESSMENTS
────────────────────────────────────────────────────────────────────────── */

const assessmentPanel: CSSProperties = {
  display: "grid",
  gap: "1rem",
};

const subsectionHeader: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: "1rem",
};

const subsectionTitle: CSSProperties = {
  fontSize: "0.82rem",
  fontWeight: 650,
  color: t.onSurface,
};

const subsectionHelp: CSSProperties = {
  margin: "0.15rem 0 0",
  fontSize: "0.72rem",
  color: t.onSurfaceVariant,
};

const divider: CSSProperties = {
  borderTop: ghostBorder,
};

const linkedRows: CSSProperties = {
  display: "grid",
  marginTop: "0.55rem",
};

const linkedRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "0.75rem",
  padding: "0.6rem 0",
  borderTop: ghostBorder,
};

const inlineEmptyState: CSSProperties = {
  marginTop: "0.55rem",
  padding: "0.8rem",
  borderRadius: t.radiusMd,
  background: t.surfaceLow,
};

/* ──────────────────────────────────────────────────────────────────────────
   EMPTY STATES
────────────────────────────────────────────────────────────────────────── */

const emptySection: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: "0.7rem",
  padding: "1rem",
  borderRadius: t.radiusMd,
  background: t.surfaceLow,
};

const emptyIcon: CSSProperties = {
  width: "2rem",
  height: "2rem",
  flexShrink: 0,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: "9999px",
  background: t.surfaceContainer,
  color: t.onSurfaceVariant,
};

const emptyTitle: CSSProperties = {
  display: "block",
  fontSize: "0.82rem",
  fontWeight: 650,
  color: t.onSurface,
};

const emptyDescription: CSSProperties = {
  margin: "0.2rem 0 0",
  fontSize: "0.74rem",
  lineHeight: 1.45,
  color: t.onSurfaceVariant,
};

/* ──────────────────────────────────────────────────────────────────────────
   RIGHT RAIL
────────────────────────────────────────────────────────────────────────── */

const rightRail: CSSProperties = {
  minWidth: 0,

  position: "sticky",
  top: "1rem",
  alignSelf: "start",

  padding: "1.25rem",
  background: t.surfaceLow,
  borderLeft: ghostBorder,

  display: "flex",
  flexDirection: "column",
  gap: "0.9rem",
};

const railCard: CSSProperties = {
  ...cardSurface,
  padding: "1rem",
};

const railHeading: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.65rem",
  marginBottom: "0.9rem",
};

const railIconBox: CSSProperties = {
  width: "2rem",
  height: "2rem",
  flexShrink: 0,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: t.radiusMd,
  background: t.surfaceContainer,
  color: t.onSurfaceVariant,
};

const railTitle: CSSProperties = {
  margin: 0,
  fontFamily: t.fontDisplay,
  fontWeight: 500,
  fontSize: "0.95rem",
  color: t.onSurface,
};

const railDescription: CSSProperties = {
  margin: "0.12rem 0 0",
  fontSize: "0.68rem",
  color: t.muted,
};

const quickActionsCard: CSSProperties = {
  ...cardSurface,
  padding: "1rem",
  border: `1px solid ${t.outlineVariant}`,
};

const quickActionContext: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.3rem",
  marginBottom: "0.9rem",
};

const quickActionTitle: CSSProperties = {
  fontSize: "0.82rem",
  fontWeight: 650,
  color: t.onSurface,
};

const quickActionHelp: CSSProperties = {
  fontSize: "0.72rem",
  lineHeight: 1.45,
  color: t.onSurfaceVariant,
};

const quickActionButtons: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.5rem",
};

const lifeGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "auto 1fr",
  alignItems: "center",
  gap: "0.65rem 0.8rem",
  margin: 0,
  fontSize: "0.77rem",
};

const dt: CSSProperties = {
  fontWeight: 600,
  color: t.onSurfaceVariant,
};

const dd: CSSProperties = {
  margin: 0,
  color: t.onSurface,
};

const mutedValue: CSSProperties = {
  color: t.muted,
};

const railWarningBox: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.4rem",
  marginTop: "0.9rem",
  padding: "0.55rem 0.65rem",
  borderRadius: t.radiusMd,
  background: "color-mix(in srgb, var(--color-warning) 12%, transparent)",
  color: t.warning,
  fontSize: "0.72rem",
};

const navigationActions: CSSProperties = {
  display: "grid",
  gap: "0.45rem",
};

const guardChip: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.4rem",
  width: "fit-content",
  fontSize: "0.76rem",
  fontWeight: 600,
  color: t.warning,
  background: "color-mix(in srgb, var(--color-warning) 14%, transparent)",
  borderRadius: "9999px",
  padding: "0.3rem 0.65rem",
};

/* ──────────────────────────────────────────────────────────────────────────
   BUTTONS
────────────────────────────────────────────────────────────────────────── */

const secondaryBtn: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minHeight: "2.25rem",
  padding: "0.45rem 0.85rem",
  borderRadius: "9999px",
  background: t.surfaceContainer,
  color: t.onSurface,
  fontSize: "0.78rem",
  fontWeight: 600,
  border: "none",
  cursor: "pointer",
};

const ghostBtn: CSSProperties = {
  ...secondaryBtn,
};

const primaryBtn: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minHeight: "2.25rem",
  padding: "0.45rem 0.95rem",
  borderRadius: "9999px",
  background: t.primary,
  color: t.onPrimary,
  fontSize: "0.78rem",
  fontWeight: 650,
  border: "none",
  cursor: "pointer",
};

const dangerBtn: CSSProperties = {
  ...primaryBtn,
  background: t.error,
  color: t.onEmphasis,
};

const dangerGhostBtn: CSSProperties = {
  ...secondaryBtn,
  color: t.error,
};

const railActionBtn: CSSProperties = {
  ...secondaryBtn,
  width: "100%",
  justifyContent: "flex-start",
  borderRadius: t.radiusMd,
};

const textBtn: CSSProperties = {
  border: "none",
  padding: 0,
  background: "transparent",
  color: t.primary,
  fontSize: "0.72rem",
  fontWeight: 650,
  cursor: "pointer",
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

/* ──────────────────────────────────────────────────────────────────────────
   FEEDBACK / MODAL / GENERIC
────────────────────────────────────────────────────────────────────────── */

const noticeStyle: CSSProperties = {
  marginTop: "1rem",
  padding: "0.65rem 0.85rem",
  borderRadius: t.radiusMd,
  background: t.primaryTint,
  color: t.onSurface,
  fontSize: "0.8rem",
};

const pageAlertStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: "0.45rem",
  marginTop: "1rem",
  marginBottom: "1rem",
  padding: "0.65rem 0.8rem",
  borderRadius: t.radiusMd,
  background: "color-mix(in srgb, var(--color-error) 12%, transparent)",
  color: t.error,
  fontSize: "0.8rem",
};

const alertStyle: CSSProperties = {
  margin: 0,
  fontSize: "0.8rem",
  color: t.error,
};

const modalBody: CSSProperties = {
  padding: "1.25rem",
  display: "flex",
  flexDirection: "column",
  gap: "1rem",
};

const modalTitle: CSSProperties = {
  margin: 0,
  fontFamily: t.fontDisplay,
  fontWeight: 500,
  fontSize: "1.1rem",
  color: t.onSurface,
};

const modalActions: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "0.5rem",
};

const monoChip: CSSProperties = {
  fontFamily: t.fontMono,
  fontSize: "0.78rem",
  color: t.onSurfaceVariant,
  background: t.surfaceContainer,
  borderRadius: "9999px",
  padding: "0.15rem 0.55rem",
};

const meta: CSSProperties = {
  fontSize: "0.76rem",
  color: t.onSurfaceVariant,
  margin: "0.25rem 0 0",
};

const carePlanEmptyState: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: "0.875rem",
  padding: "1rem",
  border: ghostBorder,
  borderRadius: "0.75rem",
  background: t.surfaceLow,
};

const carePlanEmptyIcon: CSSProperties = {
  width: "2.5rem",
  height: "2.5rem",
  flexShrink: 0,
  display: "grid",
  placeItems: "center",
  borderRadius: "0.65rem",
  background: t.surface,
  color: t.primary,
};

const carePlanEmptyContent: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: "0.5rem",
};

const carePlanEmptyTitle: CSSProperties = {
  fontSize: "0.9rem",
  fontWeight: 700,
  color: t.onSurface,
};

const carePlanEmptyDescription: CSSProperties = {
  maxWidth: "42rem",
  fontSize: "0.8rem",
  lineHeight: 1.5,
  color: t.onSurfaceVariant,
};
