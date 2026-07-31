// apps/backend/src/modules/16-bereavement/seams/consumed.ts — the seams M16 CONSUMES (M16-T03, +T04).
//
// Architecture §25.15: M16 never imports M5's, M6's, M9's or M15's Drizzle schema. Every cross-module fact
// the §2.2 lifecycle and the D3/D17 risk rubric need — the death instant and its D16 provenance behind
// `m6.bereavement.eligible` (M6), the admission's provider entity and discharge date (M6), the decedent's
// identity for the §7.2 roster seed (M5), the MSW psychosocial findings (M15) and the pre-death PPS
// trajectory (M9) — is resolved through the M1 boot-registered seam registry and passed into the pure
// machines and the pure derivation as a plain value.
//
// M16-T04's two additions are READ-ONLY consumers of seams M9 and M15 already publish live (M9-T04,
// M15-T05); no manifest edge is added, because the resolution goes through M1's registry and the CONTRACT
// types are leaf `@wardenx/types` (ADR-0005 D1/D2) — exactly the shape the existing M6/M5 consumers use.
//
// The seams M16 PUBLISHES (§4.6: `BereavementPlanProvider`, `BereavementOutreachProvider`,
// `BereavementRiskTierProvider`, …) land in M16-T05.
import type {
  AdmissionStatusReader,
  DeathDischargeReader,
  MswRiskFactorReader,
  PatientReader,
  ScaleSeriesProvider,
} from "@wardenx/types";
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

/** M16-T04 CONSUMES M15's §4.3 MswRiskFactorReader — the psychosocial findings the D3 rubric scores. M15
 *  exposes the FACTORS and never a score (M15 §1.2); the weights, the tier and the 13-month obligation are
 *  M16's. Its §7.13 42 CFR Part 2 SQL filter is why `sudDisclosureAllowed` rides the extraction input. */
export function getMswRiskFactorReader(): MswRiskFactorReader {
  return getSeam("MswRiskFactorReader");
}

/** M16-T04 CONSUMES M9's §4.7 ScaleSeriesProvider — the pre-death PPS trajectory behind D3's
 *  `suddenUnexpectedDeath`. A slope needs two comparable captures; anything less is `unknown` (§7.17). */
export function getScaleSeriesProvider(): ScaleSeriesProvider {
  return getSeam("ScaleSeriesProvider");
}
