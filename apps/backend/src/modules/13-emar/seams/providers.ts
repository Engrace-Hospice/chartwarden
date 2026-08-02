// apps/backend/src/modules/13-emar/seams/providers.ts — M13-T07 the §2.12 D16 seam implementations: pure
// orchestration over an injected {@link EmarSeamStore}. Each returns the leaf-typed seam interface
// (@wardenx/types) the M1 registry validates and M14/M28/M30/M31/M33/M37 resolve. The providers add NO tenant
// logic — RLS scopes every store read by the consumer's `app.org_id` (§3.6); they project store DTOs and derive
// the read-side signals (PRN-effectiveness / missed-dose / comfort-kit-timeliness measure inputs, the
// lay-language portal summary with the §7.8 / D12 SUD redaction, the FHIR status mapping, the IV-session
// projection, the reconciliation-timeliness measure). Both seams are READ-only — M13 owns the administration +
// reconciliation workflows internally and never mutates through a seam. Mirrors the M9/M10/M11/M12 read-seam
// provider precedents.
import type {
  AdministrationDto,
  FhirMedicationAdministrationPayload,
  MedicationAdministrationProvider,
  PortalAdministrationSummary,
  ReconciliationProvider,
} from "@wardenx/types";
import type { EmarSeamStore } from "./store";

/** Ascending-by-`administeredAt` comparator (ISO-8601 lexicographic order == chronological order). */
function byAdministeredAtAsc(a: AdministrationDto, b: AdministrationDto): number {
  return a.administeredAt < b.administeredAt ? -1 : a.administeredAt > b.administeredAt ? 1 : 0;
}

/** Map the M13 lifecycle status + mode onto the narrow FHIR `MedicationAdministration.status` value set (§2.11
 * / M28). A voided / superseded row is `entered-in-error`; a caregiver-attested row awaiting RN review is
 * `in-progress`; an in-flight IV segment (start / rate-change / pause / resume) is `in-progress`; a single dose
 * or a closed IV session (`iv_continuous_stop`) is `completed`. */
function fhirStatusOf(row: AdministrationDto): FhirMedicationAdministrationPayload["status"] {
  if (row.status === "voided" || row.status === "superseded") return "entered-in-error";
  if (row.status === "pending_caregiver_review") return "in-progress";
  // status === "committed":
  if (row.mode === "single_dose" || row.mode === "iv_continuous_stop") return "completed";
  return "in-progress"; // an open IV segment
}

/** Whole hours (precise float) between two ISO instants, or null if either is absent. */
function hoursBetween(fromIso: string, toIso: string | null): number | null {
  if (toIso === null) return null;
  return (Date.parse(toIso) - Date.parse(fromIso)) / 3_600_000;
}

/** Whole minutes (rounded) between two ISO instants, or null if either is absent. */
function minutesBetween(fromIso: string | null, toIso: string | null): number | null {
  if (fromIso === null || toIso === null) return null;
  return Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 60_000);
}

/**
 * §2.12 D16 MedicationAdministrationProvider over the store — the administration read seam M14 (IDG "since last
 * meeting"), M28 (FHIR `MedicationAdministration`), M30 (PRN-effectiveness / missed-dose / comfort-kit-timeliness
 * measures), M31 (portal summary), M33 (dashboards), and M37 (IPU IV-pump overlay) consume. Pure projection +
 * the derived read-side measure inputs; RLS pins the tenant.
 */
/**
 * Was a reassessment of `scaleType` captured for `patientId` at or before `dueIso` (and after the PRN was
 * administered)? Injected so M13 consumes M9's ScaleSeriesProvider OPAQUELY (no schema import, no dependsOn
 * edge) — see seams/index.ts, which binds it to the M1 registry. Absent → the prn-effectiveness measure
 * suppresses (the provider throws) rather than scoring a fabricated zero (D6/D13).
 */
export interface ReassessmentCoverageReader {
  wasReassessed(
    patientId: string,
    scaleType: string,
    fromIso: string,
    toIso: string,
  ): Promise<boolean>;
}

export function createMedicationAdministrationProvider(
  store: EmarSeamStore,
  deps: { readonly reassessmentCoverage?: ReassessmentCoverageReader } = {},
): MedicationAdministrationProvider {
  return {
    async getAdministration(_orgId, administrationId) {
      return store.administrationById(administrationId);
    },
    async getAdministrationsForPatient(_orgId, patientId, opts) {
      const all = await store.administrationsForPatient(patientId);
      return all
        .filter((a) => {
          if (opts?.sinceIso !== undefined && a.administeredAt < opts.sinceIso) return false;
          if (opts?.untilIso !== undefined && a.administeredAt > opts.untilIso) return false;
          return true;
        })
        .sort(byAdministeredAtAsc);
    },
    async getAdministrationsForOrder(_orgId, medicationOrderId) {
      const all = await store.administrationsForOrder(medicationOrderId);
      return [...all].sort(byAdministeredAtAsc);
    },
    async getAdministrationsSince(_orgId, patientId, sinceIso) {
      const all = await store.administrationsForPatient(patientId);
      return all.filter((a) => a.administeredAt >= sinceIso).sort(byAdministeredAtAsc);
    },
    async getPrnEffectivenessSummary(_orgId, patientId, windowIso) {
      const rows = await store.prnEffectivenessRowsForPatient(patientId);
      const inWindow = rows.filter(
        (r) => r.administeredAt >= windowIso.from && r.administeredAt <= windowIso.to,
      );
      const prnCount = inWindow.length;
      const prnWithReassessmentCount = inWindow.filter((r) => r.hasReassessment).length;
      return {
        prnCount,
        prnWithReassessmentCount,
        reassessmentRate: prnCount === 0 ? 0 : prnWithReassessmentCount / prnCount,
      };
    },
    async getComfortKitDeploymentTimeline(_orgId, admissionId) {
      const timeline = await store.comfortKitTimelineForAdmission(admissionId);
      if (timeline === null) return null;
      return {
        deployedAt: timeline.deployedAt,
        firstAdministrationAt: timeline.firstAdministrationAt,
        intervalMinutes: minutesBetween(timeline.deployedAt, timeline.firstAdministrationAt),
      };
    },
    async getMissedDoseCountsForOrg(organizationId, window) {
      return store.missedDoseCountsForOrg(organizationId, window);
    },
    async getPrnEffectivenessCountsForOrg(organizationId, window) {
      const obligations = await store.prnReassessmentObligationsForOrg(organizationId, window);
      const coverage = deps.reassessmentCoverage;
      if (coverage === undefined) {
        // No M9 coverage seam bound → the measure cannot be computed. Suppress (do NOT score 0/N as if
        // every PRN went un-reassessed — that would publish a fabricated failing rate, D6/D13).
        throw new Error(
          "prn_effectiveness: reassessment-coverage reader (M9 ScaleSeriesProvider) is unbound",
        );
      }
      let numerator = 0;
      for (const o of obligations) {
        // "Documented" = an M9 assessment of the recommended scale captured between the administration and
        // the reassessment-due instant. Aggregate only — no obligation row leaves M13 (D6).
        if (await coverage.wasReassessed(o.patientId, o.scaleType, o.administeredAt, o.reassessmentDueAt)) {
          numerator++;
        }
      }
      return { numerator, denominator: obligations.length };
    },
    async getMissedDoseSummary(_orgId, patientId, windowIso) {
      const rows = await store.doseScheduleRowsForPatient(patientId);
      // A cancelled dose (discharge / discontinuation) was never an expected administration → out of the
      // denominator. The remaining due rows form the scheduled denominator (D14 — never retroactively missed).
      const relevant = rows.filter(
        (r) => r.dueAt >= windowIso.from && r.dueAt <= windowIso.to && r.status !== "cancelled",
      );
      const scheduledCount = relevant.length;
      const administeredCount = relevant.filter((r) => r.status === "administered").length;
      const missedCount = relevant.filter((r) => r.status === "missed").length;
      return {
        scheduledCount,
        administeredCount,
        missedCount,
        missedRate: scheduledCount === 0 ? 0 : missedCount / scheduledCount,
      };
    },
    async getPortalAdministrationSummary(_orgId, patientId, asOfIso) {
      const all = await store.administrationsForPatient(patientId);
      const summary: PortalAdministrationSummary[] = all
        .filter((a) => a.administeredAt <= asOfIso)
        // A voided / superseded row never appears on the lay-language portal surface.
        .filter((a) => a.status === "committed" || a.status === "pending_caregiver_review")
        .sort(byAdministeredAtAsc)
        .map((a) =>
          // §7.8 / D12 — SUD-treatment administrations are redacted by default in the lay-language portal
          // surface; M13 owns the redaction rule, M31 owns the consent-gated reveal.
          a.isSudTreatment
            ? {
                administrationRecordId: a.id,
                displayName: "Confidential medication",
                administeredAt: a.administeredAt,
                mode: a.mode,
                isRedacted: true,
              }
            : {
                administrationRecordId: a.id,
                displayName: a.drugNameSnapshot,
                administeredAt: a.administeredAt,
                mode: a.mode,
                isRedacted: false,
              },
        );
      return { summary };
    },
    async getIvContinuousSession(_orgId, ivSessionId) {
      const session = await store.ivContinuousSessionById(ivSessionId);
      if (session === null) return null;
      return {
        sessionId: session.sessionId,
        medicationOrderId: session.medicationOrderId,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        segments: session.segments.map((s) => ({
          kind: s.kind,
          recordedAt: s.recordedAt,
          ...(s.rate !== undefined ? { rate: s.rate } : {}),
          ...(s.rateUnit !== undefined ? { rateUnit: s.rateUnit } : {}),
        })),
        pumpVerifiedByMembershipId: session.pumpVerifiedByMembershipId,
      };
    },
    async asFhirMedicationAdministration(_orgId, administrationId) {
      const row = await store.administrationById(administrationId);
      if (row === null) return null;
      return {
        resourceType: "MedicationAdministration",
        id: row.id,
        status: fhirStatusOf(row),
        subjectPatientId: row.patientId,
        medicationDisplay: row.drugNameSnapshot,
        rxnormRxcui: row.rxnormRxcuiSnapshot,
        // A single dose carries a point-in-time `effectiveDateTime`; an IV segment's period is composed by M28
        // across the row sequence via `getIvContinuousSession`, so the single-row projection leaves it absent.
        effectiveDateTime: row.mode === "single_dose" ? row.administeredAt : null,
        effectivePeriod: null,
      };
    },
  };
}

/**
 * §2.12 D16 ReconciliationProvider over the store — the reconciliation-worksheet read seam M14 (IDG packet) and
 * M30 (reconciliation-timeliness measure) consume. Pure projection + the five-day-deadline derivation; RLS pins
 * the tenant.
 */
export function createReconciliationProvider(store: EmarSeamStore): ReconciliationProvider {
  return {
    async getWorksheet(_orgId, worksheetId) {
      return store.worksheetById(worksheetId);
    },
    async getWorksheetsForAdmission(_orgId, admissionId) {
      const all = await store.worksheetsForAdmission(admissionId);
      return [...all];
    },
    async getReconciliationTimelinessByAdmission(_orgId, admissionId) {
      const anchor = await store.reconciliationTimelinessForAdmission(admissionId);
      // Production always resolves the admission anchor through M6's seam; the slice returns a null-safe shape
      // when the admission has no visible reconciliation context under the consumer's tenant.
      if (anchor === null) {
        return {
          admissionAt: "",
          reconciliationFinalizedAt: null,
          intervalHours: null,
          metFiveDayDeadline: null,
        };
      }
      const intervalHours = hoursBetween(anchor.admissionAt, anchor.reconciliationFinalizedAt);
      return {
        admissionAt: anchor.admissionAt,
        reconciliationFinalizedAt: anchor.reconciliationFinalizedAt,
        intervalHours,
        // The 5-day reconciliation deadline == 120 hours from admission (CMS initial-assessment window).
        metFiveDayDeadline: intervalHours === null ? null : intervalHours <= 120,
      };
    },
  };
}
