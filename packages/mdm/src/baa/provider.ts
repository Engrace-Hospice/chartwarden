// @wardenx/mdm — the REAL `BaaStatusProvider` (M40-T06, spec §4.6.2, §7.7).
//
// The implementation M40 registers into the M1 seam registry for the focused BAA gate. Pure
// ORCHESTRATION over the injected {@link BaaStore}: resolve the entity (a facility by sending-code,
// or a kind+id directly), read the per-(org,kind) required policy + the candidate records, and run
// the pure {@link decideBaaStatus} engine as-of the disclosure moment. The §7.10 time-travel
// guarantee lives in the engine, not here — this just threads `asOf` through unchanged.
//
// SCOPE (T06): the slice store answers from in-memory seed; the Drizzle-backed store + the §4.6.2
// 60s Valkey cache are T07. The cache is a pure performance layer over this same decision, so it
// changes nothing about the gate result.

import type {
  BaaEntityKind,
  BaaStatusProvider,
  BaaStatusResult,
} from "../interfaces/baa-status-provider";
import { type BaaRecordRow, NO_MATCH_RESULT, decideBaaStatus, defaultBaaRequired } from "./gate";
import type { BaaStore } from "./store";

/**
 * Build the real {@link BaaStatusProvider} over an injected {@link BaaStore}. The boot slice passes
 * the in-memory store; production passes the Drizzle/Valkey-backed store (T07).
 */
export function createBaaStatusProvider(store: BaaStore): BaaStatusProvider {
  async function compute(
    orgId: string,
    kind: BaaEntityKind,
    canonicalId: string,
    asOf: Date,
  ): Promise<BaaStatusResult> {
    // §4.6.2 step 1: is a BAA required for this (org, kind)? Fall back to the HIPAA default.
    const configured = await store.isBaaRequired(orgId, kind);
    const requiredByPolicy = configured ?? defaultBaaRequired(kind);
    // §4.6.2 step 2: gate the candidate records as-of the disclosure moment.
    const records: readonly BaaRecordRow[] = await store.baaRecords(orgId, kind, canonicalId);
    return decideBaaStatus({ requiredByPolicy, records, asOf });
  }

  return {
    async baaStatusBySendingFacility({ orgId, sendingFacility, asOf }) {
      const facilityId = await store.facilityIdBySendingFacility(sendingFacility);
      // No facility matches the free-text MSH-4 code → conservative `missing` (§4.6.2 / §7.9).
      if (facilityId === null) return NO_MATCH_RESULT;
      return compute(orgId, "facility", facilityId, asOf);
    },

    async baaStatusByMdmEntity({ orgId, kind, id, asOf }) {
      return compute(orgId, kind, id, asOf);
    },
  };
}
