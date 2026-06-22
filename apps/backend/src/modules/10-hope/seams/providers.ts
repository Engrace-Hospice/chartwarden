// apps/backend/src/modules/10-hope/seams/providers.ts — M10-T05 the §2 / D10 seam implementations: pure
// orchestration over an injected {@link HopeSeamStore}. Each returns the leaf-typed seam interface
// (@wardenx/types) the M1 registry validates and M14/M22/M30/M32 resolve. The providers add NO tenant
// logic — RLS scopes every store read by the consumer's `app.org_id` (§3.6); they only project store DTOs
// and apply the open/history read-time semantics with one home each.
import type {
  AdmissionId,
  HopeJ2051Event,
  HopeJ2051Provider,
  HopeSfvStatus,
  HopeSubmissionId,
  HopeSubmissionProvider,
  HopeSubmissionStatusView,
  HopeTimepointProvider,
  HopeTimepointStatus,
  PatientId,
  ProviderEntityId,
} from "@wardenx/types";
import type { HopeSeamStore } from "./store";

/** The SFV statuses that are still an OPEN obligation (a `completed` / `missed` SFV is terminal, D3). */
const OPEN_SFV_STATUSES: ReadonlySet<HopeSfvStatus> = new Set<HopeSfvStatus>(["open", "overdue"]);

/**
 * §2 / D10 HopeTimepointProvider over the store — the timepoint read M14 (open HOPE windows on the IDG
 * packet) + M22 (per-admission HOPE timeline PDF) + M30 (HOPE on-time rate / HCI) + M32 (decline-prediction
 * features) consume. `openTimepoints` narrows the patient's schedule to the not-yet-completed (`open`)
 * windows — the single home for "which windows still need a HOPE capture"; `forAdmission` returns the full
 * schedule set for one admission (the per-admission timeline). RLS pins the tenant; the store projects rows.
 */
export function createHopeTimepointProvider(store: HopeSeamStore): HopeTimepointProvider {
  return {
    async openTimepoints(patientId: PatientId): Promise<ReadonlyArray<HopeTimepointStatus>> {
      const all = await store.timepointsForPatient(patientId);
      return all.filter((t) => t.status === "open");
    },
    forAdmission(admissionId: AdmissionId): Promise<ReadonlyArray<HopeTimepointStatus>> {
      return store.timepointsForAdmission(admissionId);
    },
  };
}

/**
 * §2 / D10 HopeJ2051Provider over the store — the J2051 trigger read M30 (Timely Follow-Up for Pain /
 * Non-Pain Symptom Impact) + M32 (symptom-trajectory model, alongside M9's `ScaleSeriesProvider`) consume.
 * `history` returns the patient's J2051 trigger events ordered by `triggeredAt` ASCENDING (the trajectory
 * read-order); `openSfvs` narrows to the FIRED triggers whose SFV obligation is still open (the home for
 * "which SFVs are outstanding", D3). RLS pins the tenant; the store projects rows.
 */
export function createHopeJ2051Provider(store: HopeSeamStore): HopeJ2051Provider {
  return {
    async history(patientId: PatientId): Promise<ReadonlyArray<HopeJ2051Event>> {
      const events = await store.j2051EventsForPatient(patientId);
      return [...events].sort((a, b) =>
        a.triggeredAt < b.triggeredAt ? -1 : a.triggeredAt > b.triggeredAt ? 1 : 0,
      );
    },
    async openSfvs(patientId: PatientId): Promise<ReadonlyArray<HopeJ2051Event>> {
      const events = await store.j2051EventsForPatient(patientId);
      return events.filter((e) => e.triggerFired && e.sfvStatus !== null && OPEN_SFV_STATUSES.has(e.sfvStatus));
    },
  };
}

/**
 * §2 / D10 HopeSubmissionProvider over the store — the submission read M30 (submission-acceptance rate /
 * APU posture + the HQRP non-compliance counter, D12) + M33 (submission dashboards) consume.
 * `latestForProviderEntity` returns the most recent batch for a PE (HOPE is inherently per-PE; M10-F09);
 * `submission` resolves one batch by id. Pure pass-through — the store already projects the per-PE rollup.
 */
export function createHopeSubmissionProvider(store: HopeSeamStore): HopeSubmissionProvider {
  return {
    latestForProviderEntity(
      providerEntityId: ProviderEntityId,
    ): Promise<HopeSubmissionStatusView | null> {
      return store.latestSubmissionForProviderEntity(providerEntityId);
    },
    submission(submissionId: HopeSubmissionId): Promise<HopeSubmissionStatusView | null> {
      return store.submissionById(submissionId);
    },
  };
}
