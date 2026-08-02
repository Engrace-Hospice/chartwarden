// apps/backend/src/modules/13-emar/seams/store.ts — M13-T07 the data PORT the §2.12 D16 seam providers
// (MedicationAdministrationProvider + ReconciliationProvider) compose over, plus an in-memory slice for tests /
// boot-without-DB. The providers (./providers.ts) are pure orchestration over this port; production injects a
// Drizzle-backed store that reads M13's `administration_record` / `medication_reconciliation_worksheet` (+ the
// scheduled-dose / PRN-effectiveness / comfort-kit / IV-session rollups) under the CONSUMER's `withOrgContext` —
// the providers never switch tenants; RLS scopes every read by `app.org_id` (§3.6). Mirrors the M9/M10/M11/M12
// read-seam store precedents.
//
// Both M13 seams are READ-only (no mutate path — M13 owns the administration + reconciliation workflows
// internally and never writes through a seam). Reads project the read-only DTO shapes from @wardenx/types (never
// Drizzle rows); the per-mode / per-row free-text PHI (notes / refusal_reason / decision_notes, D12) NEVER
// crosses the seam — only the server-resolved snapshot projections do.
import type {
  AdministrationDto,
  AdministrationMode,
  AdmissionId,
  PatientId,
  ReconciliationWorksheetDto,
  ScaleType,
  ScheduledDoseStatus,
} from "@wardenx/types";

/** One PRN administration in the window with whether an M9 reassessment scale row was linked (the
 * PRN-effectiveness-documented-rate numerator input; M30 owns the measure, M13 publishes the count surface). */
export interface PrnEffectivenessRow {
  readonly administeredAt: string;
  readonly hasReassessment: boolean;
}

/** One PRN administration that CARRIES a reassessment obligation (a recommended scale + a due-at), over an
 * org window. This is M13-internal data (patient rows) the PROVIDER joins against M9's ScaleSeriesProvider to
 * decide `hasReassessment` — only the aggregate count crosses the M1 seam to M30 (D6). `administeredAt` is the
 * coverage-window START, `reassessmentDueAt` its END (and the obligation timestamp the org window keys on). */
export interface PrnReassessmentObligation {
  readonly patientId: PatientId;
  readonly scaleType: ScaleType;
  readonly administeredAt: string;
  readonly reassessmentDueAt: string;
}

/** One materialized `scheduled_dose` row's outcome (the missed-dose-rate-by-shift measure input). `cancelled`
 * rows are excluded from the denominator by the provider — a discharge/discontinuation cancellation was never an
 * expected administration. */
export interface DoseScheduleRow {
  readonly dueAt: string;
  readonly status: ScheduledDoseStatus;
}

/** The §2.7 comfort-kit deployment-to-first-administration timeline `getComfortKitDeploymentTimeline` reads
 * (M30 comfort-kit-timeliness measure). One row per admission that has a comfort kit deployed. */
export interface ComfortKitAdministrationTimeline {
  readonly admissionId: AdmissionId;
  readonly deployedAt: string | null;
  readonly firstAdministrationAt: string | null;
}

/** The §2.11 D11 IV-continuous session projection `getIvContinuousSession` reads (M37 IPU IV-pump overlay) —
 * the start / rate-change / pause / resume / stop row sequence correlated by `iv_session_id`. */
export interface IvContinuousSessionRow {
  readonly sessionId: string;
  readonly medicationOrderId: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly segments: ReadonlyArray<{
    readonly kind: AdministrationMode;
    readonly recordedAt: string;
    readonly rate?: number;
    readonly rateUnit?: string;
  }>;
  readonly pumpVerifiedByMembershipId: string | null;
}

/** The §2.8 D17 reconciliation-timeliness anchor `getReconciliationTimelinessByAdmission` reads (M30 measure):
 * the `m6.admission.activated` timestamp (resolved through M6's seam in prod) + the admission-triggered
 * worksheet's `finalizedAt`. One row per admission. */
export interface ReconciliationTimelinessAnchor {
  readonly admissionId: AdmissionId;
  readonly admissionAt: string;
  readonly reconciliationFinalizedAt: string | null;
}

/**
 * The data port the §2.12 D16 seam providers compose over. Read methods return read-only DTO shapes (never
 * Drizzle rows); the Drizzle adapter projects rows to these under the consumer's RLS context. Reads key on
 * `administrationId` / `patientId` / `medicationOrderId` / `admissionId` / `ivSessionId` / `worksheetId` — the
 * org is already pinned by RLS — and return an empty slice / null when the subject has no visible rows under the
 * consumer's tenant.
 */
export interface EmarSeamStore {
  // ── administration reads (MedicationAdministrationProvider) ────────────────────────────────────────────
  administrationById(administrationId: string): Promise<AdministrationDto | null>;
  administrationsForPatient(patientId: PatientId): Promise<ReadonlyArray<AdministrationDto>>;
  administrationsForOrder(medicationOrderId: string): Promise<ReadonlyArray<AdministrationDto>>;
  prnEffectivenessRowsForPatient(patientId: PatientId): Promise<ReadonlyArray<PrnEffectivenessRow>>;
  doseScheduleRowsForPatient(patientId: PatientId): Promise<ReadonlyArray<DoseScheduleRow>>;
  /**
   * ORG-LEVEL missed-dose tally over a DUE-AT window — M30's `missed_dose_rate` input. Denominator =
   * scheduled doses due inside the window; numerator = those with a `missed_dose` row. Aggregate counts
   * only, no patient row crosses (D6).
   */
  missedDoseCountsForOrg(
    organizationId: string,
    window: { from: string; to: string },
  ): Promise<{ numerator: number; denominator: number }>;
  /**
   * ORG-LEVEL PRN reassessment obligations over a DUE-AT window — the raw M13 rows behind M30's
   * `prn_effectiveness_documented_rate` (a PRN administration with a recommended reassessment scale, whose
   * reassessment falls due inside the window). The PROVIDER joins each against M9's ScaleSeriesProvider to
   * decide coverage, so ONLY the aggregate count crosses the M1 seam (D6). Rows with no recommended scale
   * carry no obligation and are excluded (they can never be "documented").
   */
  prnReassessmentObligationsForOrg(
    organizationId: string,
    window: { from: string; to: string },
  ): Promise<ReadonlyArray<PrnReassessmentObligation>>;
  comfortKitTimelineForAdmission(
    admissionId: AdmissionId,
  ): Promise<ComfortKitAdministrationTimeline | null>;
  ivContinuousSessionById(ivSessionId: string): Promise<IvContinuousSessionRow | null>;
  // ── reconciliation reads (ReconciliationProvider) ─────────────────────────────────────────────────────
  worksheetById(worksheetId: string): Promise<ReconciliationWorksheetDto | null>;
  worksheetsForAdmission(admissionId: AdmissionId): Promise<ReadonlyArray<ReconciliationWorksheetDto>>;
  reconciliationTimelinessForAdmission(
    admissionId: AdmissionId,
  ): Promise<ReconciliationTimelinessAnchor | null>;
}

// ── in-memory slice store ─────────────────────────────────────────────────────────────────────────────

/** A PRN-effectiveness seed row keyed by patient (the store filters per call). */
export interface PrnEffectivenessSeedRow extends PrnEffectivenessRow {
  readonly patientId: PatientId;
}

/** A dose-schedule seed row keyed by patient (the store filters per call). */
export interface DoseScheduleSeedRow extends DoseScheduleRow {
  readonly patientId: PatientId;
}

/** Deterministic, I/O-free seed for the in-memory {@link EmarSeamStore} (slice + seam tests). */
export interface EmarSeamSeed {
  /** Administration rows the reads resolve (any order; filtered/projected per call). */
  readonly administrations?: readonly AdministrationDto[];
  /** PRN-effectiveness rows (the measure numerator/denominator inputs), keyed by `patientId`. */
  readonly prnEffectiveness?: readonly PrnEffectivenessSeedRow[];
  /** PRN reassessment obligations (the provider joins these vs M9 to produce the org counts). */
  readonly prnObligations?: readonly PrnReassessmentObligation[];
  /** Materialized scheduled-dose outcomes (the missed-dose-rate inputs), keyed by `patientId`. */
  readonly doseSchedule?: readonly DoseScheduleSeedRow[];
  /** Comfort-kit timelines keyed by their `admissionId`. */
  readonly comfortKitTimelines?: readonly ComfortKitAdministrationTimeline[];
  /** IV-continuous sessions keyed by their `sessionId`. */
  readonly ivSessions?: readonly IvContinuousSessionRow[];
  /** Reconciliation worksheets the reads resolve. */
  readonly worksheets?: readonly ReconciliationWorksheetDto[];
  /** Reconciliation-timeliness anchors keyed by their `admissionId`. */
  readonly reconciliationTimeliness?: readonly ReconciliationTimelinessAnchor[];
}

/** An in-memory {@link EmarSeamStore} for the slice/tests — no DB, deterministic, RLS-free. */
export function createInMemoryEmarSeamStore(seed: EmarSeamSeed = {}): {
  store: EmarSeamStore;
} {
  const administrations = new Map<string, AdministrationDto>(
    (seed.administrations ?? []).map((a) => [a.id, a]),
  );
  const prnByPatient = new Map<PatientId, PrnEffectivenessRow[]>();
  for (const r of seed.prnEffectiveness ?? []) {
    const list = prnByPatient.get(r.patientId) ?? [];
    list.push({ administeredAt: r.administeredAt, hasReassessment: r.hasReassessment });
    prnByPatient.set(r.patientId, list);
  }
  const prnObligations = [...(seed.prnObligations ?? [])];
  const scheduleByPatient = new Map<PatientId, DoseScheduleRow[]>();
  for (const r of seed.doseSchedule ?? []) {
    const list = scheduleByPatient.get(r.patientId) ?? [];
    list.push({ dueAt: r.dueAt, status: r.status });
    scheduleByPatient.set(r.patientId, list);
  }
  const comfortKitTimelines = new Map<AdmissionId, ComfortKitAdministrationTimeline>(
    (seed.comfortKitTimelines ?? []).map((c) => [c.admissionId, c]),
  );
  const ivSessions = new Map<string, IvContinuousSessionRow>(
    (seed.ivSessions ?? []).map((s) => [s.sessionId, s]),
  );
  const worksheets = new Map<string, ReconciliationWorksheetDto>(
    (seed.worksheets ?? []).map((w) => [w.id, w]),
  );
  const reconciliationTimeliness = new Map<AdmissionId, ReconciliationTimelinessAnchor>(
    (seed.reconciliationTimeliness ?? []).map((t) => [t.admissionId, t]),
  );

  return {
    store: {
      async administrationById(administrationId) {
        return administrations.get(administrationId) ?? null;
      },
      async administrationsForPatient(patientId) {
        return [...administrations.values()].filter((a) => a.patientId === patientId);
      },
      async administrationsForOrder(medicationOrderId) {
        return [...administrations.values()].filter(
          (a) => a.medicationOrderId === medicationOrderId,
        );
      },
      async prnEffectivenessRowsForPatient(patientId) {
        return prnByPatient.get(patientId) ?? [];
      },
      async doseScheduleRowsForPatient(patientId) {
        return scheduleByPatient.get(patientId) ?? [];
      },
      /** Slice default: 0/0 — M30's kernel SUPPRESSES rather than scoring zero missed doses. */
      async missedDoseCountsForOrg() {
        return { numerator: 0, denominator: 0 };
      },
      async prnReassessmentObligationsForOrg(_organizationId, window) {
        // Obligation keys on the reassessment-due instant falling inside [from, to).
        return prnObligations.filter(
          (o) => o.reassessmentDueAt >= window.from && o.reassessmentDueAt < window.to,
        );
      },
      async comfortKitTimelineForAdmission(admissionId) {
        return comfortKitTimelines.get(admissionId) ?? null;
      },
      async ivContinuousSessionById(ivSessionId) {
        return ivSessions.get(ivSessionId) ?? null;
      },
      async worksheetById(worksheetId) {
        return worksheets.get(worksheetId) ?? null;
      },
      async worksheetsForAdmission(admissionId) {
        return [...worksheets.values()].filter((w) => w.admissionId === admissionId);
      },
      async reconciliationTimelinessForAdmission(admissionId) {
        return reconciliationTimeliness.get(admissionId) ?? null;
      },
    },
  };
}
