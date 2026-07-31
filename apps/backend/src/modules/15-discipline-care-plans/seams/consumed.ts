// apps/backend/src/modules/15-discipline-care-plans/seams/consumed.ts — the seams M15 CONSUMES (M15-T03).
//
// Architecture §25.15: M15 never imports M7's or M8's Drizzle schema. Every cross-module fact the §2.2
// lifecycle needs — the parent IPOC problem/goal a discipline goal hangs off (M7), the signed encounter an
// aide supervisory visit or a psychosocial assessment references (M8) — is resolved through the M1
// boot-registered seam registry and passed into the pure machines as a plain value.
//
// The seams M15 PUBLISHES live in `./index.ts` + `./providers.ts` (M15-T05).
import type { CarePlanReader, SignedEncountersReader } from "@wardenx/types";
import { getSeam } from "../../../bootstrap/index";

/** M15 CONSUMES M7's §7.8 CarePlanReader — the IPOC problems/goals a discipline plan references (§2.1). */
export function getCarePlanReader(): CarePlanReader {
  return getSeam("CarePlanReader");
}

/** M15 CONSUMES M8's §4.7 SignedEncountersReader — the signed encounter behind a supervisory visit
 *  (§2.2.4) and behind a discipline assessment (§2.3). */
export function getSignedEncountersReader(): SignedEncountersReader {
  return getSeam("SignedEncountersReader");
}
