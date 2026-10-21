// apps/backend/src/modules/18-evv/seams/evv-visit-provider-entity-for-org.ts — F-194 (#248).
//
// An org-explicit, worker-callable read of one EVV-registered visit's `providerEntityId`, keyed by
// `visitId`. Mirrors `../../37-ipu/seams/restraint-admission-siting-for-org.ts` (F-185) shape and reason
// exactly:
//
// WHY THIS IS NEEDED: `m18.evv.visit_verified`'s catalogued payload (`events-by-m18.ts`) carries only
// `{visitId, patientId, organizationId, verifiedAt}` — no `providerEntityId` — while M30's
// `enqueueRecompute` port requires one (every recompute request is provider-entity-scoped). M18's own
// `evv_visit_registration` table (the M17-publication snapshot this module already owns) has the fact on
// hand at zero extra cost.
//
// WHY NOT THE PUBLISHED `EvvMetricsProvider` SEAM: that seam answers org-wide aggregate rates over a
// window (`getComplianceRate`/`getLateCheckoutRate`/…), not a single visit's provider-entity id — the
// wrong shape for this read, not merely an unregistered one.
//
// WHY A NEW, NARROW FUNCTION INSTEAD OF A `getSeam` REGISTRATION: M30's manifest `dependsOn` is
// `[1, 2, 3, 4, 10, 23, 27, 36, 38]` — it does NOT include 18 — so `evv_visit_registration` cannot be
// imported directly from M30 regardless (`arch:boundaries` refuses it, correctly). This function is
// injected as a PORT instead, the F-185 `restraintAdmissionSitingForOrg` shape reused.
//
// A `visitId` this org does not recognise (cross-tenant, or a stale redelivery) is a NO-OP, not a
// dead-letter — the same null-on-miss contract `restraintAdmissionSitingForOrg`/`bereavementPlanSitingForOrg`
// already establish.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq } from "drizzle-orm";

const VISIT_REGISTRATION = schema.evvVisitRegistrations;

/** A consumer-driven read names no acting membership (the F-102 `CONSUMER_USER_ID` convention). */
const VISIT_REGISTRATION_READER_SYSTEM_USER_ID = "";

/**
 * One EVV-registered visit's `providerEntityId`, org-explicit and worker-callable. `null` when the visit
 * is unknown in `organizationId` — indistinguishable from another tenant's, which is the point.
 */
export function evvVisitProviderEntityForOrg(
  db: DbClient,
  organizationId: string,
  visitId: string,
): Promise<{ readonly providerEntityId: string } | null> {
  return withOrgContext(
    db,
    { organizationId, userId: VISIT_REGISTRATION_READER_SYSTEM_USER_ID },
    async (tx) => {
      const [row] = await (tx as DbClient)
        .select({ providerEntityId: VISIT_REGISTRATION.providerEntityId })
        .from(VISIT_REGISTRATION)
        // The explicit organization_id predicate is the second wall behind RLS (the M6 precedent), so a
        // misconfigured GUC cannot widen this read.
        .where(
          and(
            eq(VISIT_REGISTRATION.organizationId, organizationId),
            eq(VISIT_REGISTRATION.visitId, visitId),
          ),
        )
        .limit(1);
      if (!row) return null;
      return { providerEntityId: row.providerEntityId };
    },
  );
}
