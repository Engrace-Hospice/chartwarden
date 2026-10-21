// apps/backend/src/modules/37-ipu/seams/restraint-admission-siting-for-org.ts — F-185 (#248).
//
// An org-explicit, worker-callable read of ONE `ipu_admission`'s siting facts, keyed by its own `id`
// (the value `m37.restraint.applied`'s `ipuAdmissionId` carries — confirmed against the real emit site,
// `routes/service-drizzle.ts` `applyRestraint`: `ipuAdmissionId: admissionId` where `admissionId` is the
// route param resolved via `eq(A.id, admissionId)`, NOT the separate M6-referencing `admissionId` column
// `consumers/m6-discharge-death.ts` matches on). Mirrors M16's `bereavementPlanSitingForOrg`
// (`../../16-bereavement/seams/plan-provider-entity-for-org.ts`) shape and reason exactly:
//
// WHY THIS IS NEEDED: `m37.restraint.applied`'s catalogued payload (`events-by-m37.ts`) carries only
// `{ipuAdmissionId, organizationId, restraintEventId, restraintKind}` — no `providerEntityId` — while
// `incident_report.provider_entity_id` (NOT NULL, ARCH-011) requires one before M30 can auto-file a
// `restraint_use` draft off this event (see `../../30-quality/outbox-consumers/m37-restraint-applied.ts`).
// `patientId`/`locationId` are read too (both already ON `ipu_admission` at zero extra cost) so the
// auto-created draft is patient-sited like every other incident, not left with a wider-than-necessary
// null on a column the fact is right there for.
//
// WHY NOT THE PUBLISHED SEAM: M37 has no published read seam for `ipu_admission` siting at all today
// (unlike M16's `BereavementPlanProvider.planById`, which exists but opens `withOrgContextFromRequest` —
// pinned from the ambient HTTP request context a relay tick does not have). This is a NEW, narrow,
// org-explicit read exported from M37's own `seams/` directory, the same cross-module-import precedent
// `bereavementPlanSitingForOrg`'s own header documents: an org-explicit "…ForOrg" function exported from
// a module's own `seams/` directory is itself the seam surface a background consumer imports, satisfying
// dependency-cruiser's "seam packages only, no raw schema-table imports across boundaries" rule because
// this file — not the raw `ipu_admission` Drizzle table — is what M30's consumer imports. M30's manifest
// `dependsOn` is `[1, 2, 3, 4, 10, 23, 27, 36, 38]` — it does NOT include 37 — so `ipu_admission` cannot be
// imported directly from M30 regardless (`arch:boundaries` refuses it, correctly); this function is
// injected as a PORT instead, the F-160 `CapConsumerStore` shape reused a second time.
//
// An `ipuAdmissionId` this org does not recognise (cross-tenant, or a stale redelivery against an
// admission this tenant never had) is a NO-OP, not a dead-letter — mirrors `bereavementPlanSitingForOrg`'s
// null-on-miss contract; a restraint-incident draft that cannot be sited is advisory-adjacent (a safety
// paper trail), not a write whose loss on an unrecognised org is itself a correctness bug worth blocking
// redelivery over.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq } from "drizzle-orm";

const ADMISSION = schema.ipuAdmission;

/** A consumer-driven read names no acting membership (the F-102 `CONSUMER_USER_ID` convention). */
const ADMISSION_READER_SYSTEM_USER_ID = "";

/** The facts a background M30 restraint-applied consumer needs beyond what the event payload already
 *  carries. Deliberately minimal — not the full IPU admission record. */
export interface RestraintAdmissionSitingForOrg {
  readonly ipuAdmissionId: string;
  readonly providerEntityId: string;
  readonly locationId: string | null;
  readonly patientId: string;
}

/**
 * One `ipu_admission`'s provider-entity / location / patient siting, org-explicit and worker-callable.
 * `null` when the id is unknown in `organizationId` — indistinguishable from another tenant's, which is
 * the point (the same `admissionSchedulingContextForOrg` / `bereavementPlanSitingForOrg` null-on-miss
 * contract).
 */
export function restraintAdmissionSitingForOrg(
  db: DbClient,
  organizationId: string,
  ipuAdmissionId: string,
): Promise<RestraintAdmissionSitingForOrg | null> {
  return withOrgContext(
    db,
    { organizationId, userId: ADMISSION_READER_SYSTEM_USER_ID },
    async (tx) => {
      const [row] = await (tx as DbClient)
        .select({
          id: ADMISSION.id,
          providerEntityId: ADMISSION.providerEntityId,
          locationId: ADMISSION.locationId,
          patientId: ADMISSION.patientId,
        })
        .from(ADMISSION)
        // The explicit organization_id predicate is the second wall behind RLS (the M6 precedent), so a
        // misconfigured GUC cannot widen this read.
        .where(and(eq(ADMISSION.organizationId, organizationId), eq(ADMISSION.id, ipuAdmissionId)))
        .limit(1);
      if (!row) return null;
      return {
        ipuAdmissionId: row.id,
        providerEntityId: row.providerEntityId,
        locationId: row.locationId,
        patientId: row.patientId,
      };
    },
  );
}
