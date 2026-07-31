// apps/backend/src/modules/16-bereavement/seams/consumed.ts — the seams M16 CONSUMES (M16-T03).
//
// Architecture §25.15: M16 never imports M5's or M6's Drizzle schema. Every cross-module fact the §2.2
// lifecycle needs — the death instant and its D16 provenance behind `m6.bereavement.eligible` (M6), the
// admission's provider entity and discharge date (M6), the decedent's identity for the §7.2 roster seed
// (M5) — is resolved through the M1 boot-registered seam registry and passed into the pure machines as a
// plain value.
//
// The seams M16 PUBLISHES (§4.6: `BereavementPlanProvider`, `BereavementOutreachProvider`,
// `BereavementRiskTierProvider`, …) land in M16-T05.
import type { AdmissionStatusReader, DeathDischargeReader, PatientReader } from "@wardenx/types";
import { getSeam } from "../../../bootstrap/index";

/** M16 CONSUMES M6's §4.11 DeathDischargeReader — the death instant + the D16 `source`/`cosignStatus`
 *  discriminator behind an inbound `m6.bereavement.eligible` (§4.3.1). */
export function getDeathDischargeReader(): DeathDischargeReader {
  return getSeam("DeathDischargeReader");
}

/** M16 CONSUMES M6's §4.7 AdmissionStatusReader — the admission's provider entity (the NOT NULL column on
 *  every M16 PHI table) and its discharge date (the §2.5 death-date cross-check). */
export function getAdmissionStatusReader(): AdmissionStatusReader {
  return getSeam("AdmissionStatusReader");
}

/** M16 CONSUMES M5's §4.8 PatientReader — the decedent identity the §7.2 roster seed and the M22 condolence
 *  letter render off. */
export function getPatientReader(): PatientReader {
  return getSeam("PatientReader");
}
