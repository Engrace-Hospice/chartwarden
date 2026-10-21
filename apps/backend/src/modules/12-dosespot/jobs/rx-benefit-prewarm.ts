// apps/backend/src/modules/12-dosespot/jobs/rx-benefit-prewarm.ts — the §4.8 `dosespot.rx_benefit_prewarm` per-org
// pass (GAP-037): off-peak, for each ACTIVE medication of a patient that has a recorded DoseSpot patient id and
// no still-fresh cache row, look the coverage up through the adapter and upsert `rx_benefit_cache`.
//
// A cache row is written ONLY from a real `lookupRxBenefit` response. If the adapter cannot answer (no verified
// RxBenefit endpoint yet — see `client/endpoints.ts` — or the vendor is down) nothing is written; after
// {@link MAX_CONSECUTIVE_FAILURES} failures in a row the pass stops so a dead endpoint is not hammered once per
// medication. Cached rows expire after {@link CACHE_TTL_MS}.
import { type DbClient, schema } from "@chartwarden/db";
import { isDegradedError } from "@chartwarden/dosespot";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { type M12CronDeps, inOrg, nowOf } from "./cron-common";

const MO = schema.medicationOrders;
const SYNC = schema.dosespotPatientSync;
const CACHE = schema.rxBenefitCache;

export const CACHE_TTL_MS = 24 * 3_600_000;
export const PREWARM_BATCH = 200;
export const MAX_CONSECUTIVE_FAILURES = 3;

export interface PrewarmResult {
  readonly candidates: number;
  readonly cached: number;
  readonly failed: number;
  readonly aborted: boolean;
}

export async function runRxBenefitPrewarmForOrg(
  deps: M12CronDeps,
  organizationId: string,
): Promise<PrewarmResult> {
  const now = nowOf(deps);
  const candidates = await inOrg(deps.db, organizationId, (tx) =>
    tx
      .selectDistinct({
        patientId: MO.patientId,
        rxcui: MO.rxnormRxcui,
        dosespotPatientId: SYNC.lastDosespotPatientId,
      })
      .from(MO)
      .innerJoin(
        SYNC,
        and(
          eq(SYNC.patientId, MO.patientId),
          eq(SYNC.organizationId, MO.organizationId),
          eq(SYNC.lastSyncOutcome, "success"),
        ),
      )
      .where(
        and(
          eq(MO.status, "active"),
          isNotNull(MO.rxnormRxcui),
          sql`NOT EXISTS (
            SELECT 1 FROM rx_benefit_cache c
             WHERE c.organization_id = ${MO.organizationId}
               AND c.patient_id = ${MO.patientId}
               AND c.rxnorm_rxcui = ${MO.rxnormRxcui}
               AND c.expires_at > ${now}
          )`,
        ),
      )
      .orderBy(asc(MO.patientId))
      .limit(PREWARM_BATCH),
  );
  let cached = 0;
  let failed = 0;
  let consecutive = 0;
  let aborted = false;
  for (const c of candidates) {
    if (!c.rxcui || !c.dosespotPatientId) continue;
    try {
      const res = await deps.client.lookupRxBenefit(organizationId, {
        dosespotPatientId: c.dosespotPatientId,
        rxnormRxcui: c.rxcui,
      });
      const lookedUpAt = new Date(res.lookedUpAt);
      await inOrg(deps.db, organizationId, async (tx) => {
        const rows = await tx
          .insert(CACHE)
          .values({
            organizationId,
            patientId: c.patientId,
            rxnormRxcui: c.rxcui as string,
            covered: res.covered,
            copayTier: res.copayTier ?? null,
            priorAuthRequired: res.priorAuthRequired,
            lookedUpAt,
            expiresAt: new Date(lookedUpAt.getTime() + CACHE_TTL_MS),
          })
          .onConflictDoUpdate({
            target: [CACHE.organizationId, CACHE.patientId, CACHE.rxnormRxcui],
            set: {
              covered: res.covered,
              copayTier: res.copayTier ?? null,
              priorAuthRequired: res.priorAuthRequired,
              lookedUpAt,
              expiresAt: new Date(lookedUpAt.getTime() + CACHE_TTL_MS),
              updatedAt: now,
            },
          })
          .returning({ id: CACHE.id });
        if (rows.length !== 1) throw new Error("rx_benefit_cache upsert returned no row");
      });
      cached += 1;
      consecutive = 0;
    } catch (error) {
      if (!isDegradedError(error)) throw error;
      failed += 1;
      consecutive += 1;
      if (consecutive >= MAX_CONSECUTIVE_FAILURES) {
        aborted = true;
        break;
      }
    }
  }
  return { candidates: candidates.length, cached, failed, aborted };
}

/** Drop a patient's cached coverage (the patient-sync worker calls this when demographics/payer changed). */
export async function invalidateRxBenefitCacheForPatient(
  tx: DbClient,
  organizationId: string,
  patientId: string,
): Promise<number> {
  const rows = await tx
    .delete(CACHE)
    .where(and(eq(CACHE.organizationId, organizationId), eq(CACHE.patientId, patientId)))
    .returning({ id: CACHE.id });
  return rows.length;
}
