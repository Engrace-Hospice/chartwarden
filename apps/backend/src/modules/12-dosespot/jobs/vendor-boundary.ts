// apps/backend/src/modules/12-dosespot/jobs/vendor-boundary.ts — the DoseSpot-side resolution the
// `dosespot_sync_queue` worker needs before it can call the (also-unbound) `DoseSpotClient` (M12
// `handlers-unbound` group, #248).
//
// The DoseSpot vendor call itself (`@wardenx/dosespot`'s `createUnboundDoseSpotClient`) is ALREADY a
// real, typed, fail-closed deny-stub — confirmed no `DOSESPOT_*` env var, base URL, or credential
// resolver exists anywhere in this repository, so building a "working" HTTP transport here would
// fabricate an integration that does not exist (explicitly out of scope for this pass). This file covers
// the edge one step before that call: resolving the data the vendor call needs.
//
//   • `PatientSyncSnapshotResolver` — REAL, not deferred. `@wardenx/dosespot`'s `PatientSyncSnapshot`
//     needs firstName/lastName/dateOfBirth/gender/address/phone/active/updatedAt, which M5's PUBLISHED
//     seams do not carry (`PatientReader.findById` → `PatientIdentity` has no address/phone;
//     `PatientAddressReader` returns only a 2-letter state code or a kind/facilityId/postalCode triple).
//     M12's manifest `dependsOn` includes `5` (Patient) — a DECLARED dependency — but `check-table-
//     ownership.ts`'s `CROSS_MODULE_SCHEMA_READ_EXEMPT` only covers the bare `patient` table (the
//     universal eraser-precondition read every module performs), never `patient_address`/`patient_phone`
//     — a declared dependency still requires a cross-module READ to go through the owner's exported
//     seam, not a direct schema import (`arch:tables` refuses the direct read, correctly: an earlier
//     draft of this file did exactly that and was caught). `createDrizzlePatientSyncSnapshotResolver`
//     is therefore a thin adapter over M5's own org-explicit
//     `dosespotSyncDemographicsForOrg` seam (`../../05-patient/index`), the `bereavementPlanSitingForOrg`
//     / `admissionSchedulingContextForOrg` port-injection shape — the composition root imports M5's seam
//     function directly (it may; only feature modules are boundary-restricted) and passes it in.
//   • `DosespotPatientIdResolver` — genuinely deferred. `DoseSpotMedHistoryPayload.dosespotPatientId` is
//     the VENDOR-side patient id a prior successful `upsertPatient` call would have returned. No table
//     anywhere in M12's schema (`dosespot_prescriber`, `dosespot_webhook_event`, `epcs_signing_attempt`,
//     `medication_order`, `medication_order_transmission`, `medication_order_idg_decision_application`,
//     `refill_request`) records this mapping — confirmed against the full `ownedTables` list
//     (`architecture/module-manifest.ts`, id 12), and there is no M5-side column to read directly either
//     (`patient` owns no DoseSpot-id column — M12 may not add one to a table it does not own). A MedHx
//     fetch has no id to fetch WITH until a mapping table is built (real, unbuilt M12-side schema — out of
//     this pass's isolated-file scope) and a successful upsert has somewhere to record its response.
//
// Both ports throw a typed, named error for their failure case (never return undefined and never
// silently no-op); `PatientSyncSnapshotResolver.resolve` still returns `null` for the DISTINCT, non-error
// case of "no such patient under this org any more" (deleted/merged/wrong tenant) — the worker treats
// that as a clean skip, not a failure. Naming mirrors `@wardenx/quality`'s `unboundWorkerPort`/
// `M30WorkerPortUnbound` (F-150, #248) and `@wardenx/dosespot`'s own `createUnboundDoseSpotClient`
// (retryable: false, no retry storm, DLQ immediately).
import type { PatientSyncSnapshot } from "@wardenx/dosespot";
import type { DosespotSyncDemographics } from "../../05-patient/index";

/** Raised by {@link createUnboundDosespotPatientIdResolver}. Never retryable — no mapping table exists
 *  in M12's schema to ever answer this until one is added. */
export class M12DosespotPatientIdUnbound extends Error {
  constructor(public readonly patientId: string) {
    super(
      "No DoseSpot-side patient id is recorded for this patient: M12's schema has no " +
        "patient→dosespot_patient_id mapping table (checked against the full ownedTables list, " +
        "architecture/module-manifest.ts id 12). A MedHx fetch cannot name which vendor patient to pull " +
        "history for until a successful patient-sync upsert has somewhere to record its response and " +
        "that table is built.",
    );
    this.name = "M12DosespotPatientIdUnbound";
  }
}

/** The §2.6 M5 demographic snapshot `planPatientSync`/`buildPatientUpsertPayload` (`@wardenx/dosespot`)
 *  need. `null` is the honest "no such patient under this org any more" outcome — a clean skip, not a
 *  failure. */
export interface PatientSyncSnapshotResolver {
  resolve(organizationId: string, patientId: string): Promise<PatientSyncSnapshot | null>;
}

/** The port M5's `dosespotSyncDemographicsForOrg` seam is injected as — see the file header for why this
 *  cannot be a direct schema import. */
export type DosespotSyncDemographicsForOrg = (
  organizationId: string,
  patientId: string,
) => Promise<DosespotSyncDemographics | null>;

/**
 * The REAL implementation — a thin adapter folding M5's org-explicit demographic read into the
 * `@wardenx/dosespot` wire shape. `addressLine1`/`city`/`postalCode` fall back to `""` when the patient
 * has no primary address on file — honest (an incomplete chart), not fabricated, and DoseSpot's own
 * upsert is a best-effort demographic sync, not a validation gate.
 */
export function createDrizzlePatientSyncSnapshotResolver(
  demographicsForOrg: DosespotSyncDemographicsForOrg,
): PatientSyncSnapshotResolver {
  return {
    async resolve(organizationId, patientId) {
      const demographics = await demographicsForOrg(organizationId, patientId);
      if (!demographics) return null;

      const snapshot: PatientSyncSnapshot = {
        patientId,
        firstName: demographics.firstName,
        lastName: demographics.lastName,
        dateOfBirth: demographics.dateOfBirth,
        gender: demographics.gender,
        addressLine1: demographics.addressLine1,
        ...(demographics.addressLine2 ? { addressLine2: demographics.addressLine2 } : {}),
        city: demographics.city,
        state: demographics.state,
        postalCode: demographics.postalCode,
        ...(demographics.phone ? { phone: demographics.phone } : {}),
        active: demographics.status !== "deceased" && demographics.status !== "merged",
        updatedAt: demographics.updatedAt,
      };
      return snapshot;
    },
  };
}

/** The §2.8 vendor-side patient id `DoseSpotMedHistoryPayload.dosespotPatientId` needs. `null` is the
 *  honest "this patient has never been synced to DoseSpot yet" outcome (distinct from the resolver being
 *  unbound, which throws) — a clean skip: the patient-sync worker's own upsert will eventually establish
 *  the mapping, at which point a future MedHx trigger (or a manual retry) can proceed. */
export interface DosespotPatientIdResolver {
  resolve(organizationId: string, patientId: string): Promise<string | null>;
}

/** The Phase-1 deny-stub — no mapping table exists yet (see the file header). The ONLY implementation
 *  today; there is no real one to prefer it over. */
export function createUnboundDosespotPatientIdResolver(): DosespotPatientIdResolver {
  return {
    resolve(_organizationId: string, patientId: string): Promise<never> {
      return Promise.reject(new M12DosespotPatientIdUnbound(patientId));
    },
  };
}
