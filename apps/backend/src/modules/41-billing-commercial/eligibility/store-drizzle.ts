// apps/backend/src/modules/41-billing-commercial/eligibility/store-drizzle.ts - the Postgres adapter of the eligibility store.
//
// Every call runs in `withOrgContext`, so the canonical app.org_id RLS applies and the write-audit triggers attribute the actor.
// An org filter is repeated in each WHERE as defence in depth (RLS is the guarantee, the filter is the belt).
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type {
  CommercialEligibilityOutcome,
  CommercialEligibilityStalenessPolicy,
  CommercialEnrollmentStatus,
} from "@chartwarden/types";
import { and, desc, eq } from "drizzle-orm";
import type {
  EligibilityStore,
  EnrollmentPatch,
  NewEligibilityCheck,
  NewEnrollment,
  OrgScope,
  StoredEligibilityCheck,
  StoredEnrollment,
} from "./store";

const PLAN = schema.commercialPayerPlan;
const ROUTE = schema.commercialPayerRoute;
const ENROLL = schema.commercialPayerEnrollment;
const CHECK = schema.commercialEligibilityCheck;

const asIso = (d: Date | string): string => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());

type CheckRow = typeof CHECK.$inferSelect;
type EnrollRow = typeof ENROLL.$inferSelect;

const toCheck = (r: CheckRow): StoredEligibilityCheck => ({
  id: r.id,
  organizationId: r.organizationId,
  providerEntityId: r.providerEntityId,
  locationId: r.locationId,
  patientId: r.patientId,
  planId: r.planId,
  patientPayerId: r.patientPayerId,
  clearinghouseKey: r.clearinghouseKey,
  clearinghousePayerId: r.clearinghousePayerId,
  serviceDate: r.serviceDate,
  outcome: r.outcome as CommercialEligibilityOutcome,
  asOfDate: r.asOfDate,
  requestId: r.requestId,
  idempotencyKey: r.idempotencyKey,
  checkedByUserId: r.checkedByUserId,
  checkedAt: asIso(r.checkedAt),
});

const toEnrollment = (r: EnrollRow): StoredEnrollment => ({
  id: r.id,
  organizationId: r.organizationId,
  providerEntityId: r.providerEntityId,
  payerId: r.payerId,
  clearinghouseKey: r.clearinghouseKey,
  status: r.status as CommercialEnrollmentStatus,
  effectiveFrom: r.effectiveFrom,
  effectiveTo: r.effectiveTo,
  evidenceRef: r.evidenceRef,
  createdAt: asIso(r.createdAt),
  updatedAt: asIso(r.updatedAt),
});

export function buildDrizzleEligibilityStore(db: DbClient): EligibilityStore {
  const inOrg = <T>(scope: OrgScope, fn: (tx: DbClient) => Promise<T>): Promise<T> =>
    withOrgContext(db, scope, (tx) => fn(tx as DbClient));

  return {
    loadPlan: (scope, planId) =>
      inOrg(scope, async (tx) => {
        const [row] = await tx
          .select({
            id: PLAN.id,
            payerId: PLAN.payerId,
            policy: PLAN.eligibilityStalenessPolicy,
            maxAge: PLAN.eligibilityMaxAgeDays,
          })
          .from(PLAN)
          .where(and(eq(PLAN.organizationId, scope.organizationId), eq(PLAN.id, planId)))
          .limit(1);
        return row
          ? {
              id: row.id,
              payerId: row.payerId,
              eligibilityStalenessPolicy: row.policy as CommercialEligibilityStalenessPolicy,
              eligibilityMaxAgeDays: row.maxAge,
            }
          : null;
      }),

    setPlanEligibilityPolicy: (scope, planId, policy, maxAgeDays) =>
      inOrg(scope, async (tx) => {
        const [row] = await tx
          .update(PLAN)
          .set({
            eligibilityStalenessPolicy: policy,
            eligibilityMaxAgeDays: maxAgeDays,
            updatedAt: new Date(),
          })
          .where(and(eq(PLAN.organizationId, scope.organizationId), eq(PLAN.id, planId)))
          .returning({
            id: PLAN.id,
            payerId: PLAN.payerId,
            policy: PLAN.eligibilityStalenessPolicy,
            maxAge: PLAN.eligibilityMaxAgeDays,
          });
        return row
          ? {
              id: row.id,
              payerId: row.payerId,
              eligibilityStalenessPolicy: row.policy as CommercialEligibilityStalenessPolicy,
              eligibilityMaxAgeDays: row.maxAge,
            }
          : null;
      }),

    routesFor: (scope, planId, clearinghouseKey) =>
      inOrg(scope, async (tx) =>
        tx
          .select({
            clearinghousePayerId: ROUTE.clearinghousePayerId,
            effectiveFrom: ROUTE.effectiveFrom,
            effectiveTo: ROUTE.effectiveTo,
          })
          .from(ROUTE)
          .where(
            and(
              eq(ROUTE.organizationId, scope.organizationId),
              eq(ROUTE.planId, planId),
              eq(ROUTE.clearinghouseKey, clearinghouseKey),
            ),
          ),
      ),

    enrollmentsFor: (scope, providerEntityId, payerId, clearinghouseKey) =>
      inOrg(scope, async (tx) => {
        const rows = await tx
          .select({
            status: ENROLL.status,
            effectiveFrom: ENROLL.effectiveFrom,
            effectiveTo: ENROLL.effectiveTo,
          })
          .from(ENROLL)
          .where(
            and(
              eq(ENROLL.organizationId, scope.organizationId),
              eq(ENROLL.providerEntityId, providerEntityId),
              eq(ENROLL.payerId, payerId),
              eq(ENROLL.clearinghouseKey, clearinghouseKey),
            ),
          );
        return rows.map((r) => ({ ...r, status: r.status as CommercialEnrollmentStatus }));
      }),

    findCheckByIdempotencyKey: (scope, providerEntityId, idempotencyKey) =>
      inOrg(scope, async (tx) => {
        const [row] = await tx
          .select()
          .from(CHECK)
          .where(
            and(
              eq(CHECK.organizationId, scope.organizationId),
              eq(CHECK.providerEntityId, providerEntityId),
              eq(CHECK.idempotencyKey, idempotencyKey),
            ),
          )
          .limit(1);
        return row ? toCheck(row) : null;
      }),

    insertCheck: (scope, row: NewEligibilityCheck) =>
      inOrg(scope, async (tx) => {
        const [inserted] = await tx
          .insert(CHECK)
          .values({ ...row, organizationId: scope.organizationId })
          .onConflictDoNothing({
            target: [CHECK.organizationId, CHECK.providerEntityId, CHECK.idempotencyKey],
          })
          .returning();
        if (inserted) return { row: toCheck(inserted), replayed: false };
        // A concurrent request with the same key won; answer with its row.
        const [existing] = await tx
          .select()
          .from(CHECK)
          .where(
            and(
              eq(CHECK.organizationId, scope.organizationId),
              eq(CHECK.providerEntityId, row.providerEntityId),
              eq(CHECK.idempotencyKey, row.idempotencyKey),
            ),
          )
          .limit(1);
        if (!existing) throw new Error("eligibility check insert conflicted but no row was found");
        return { row: toCheck(existing), replayed: true };
      }),

    listChecks: (scope, filter) =>
      inOrg(scope, async (tx) => {
        const rows = await tx
          .select()
          .from(CHECK)
          .where(
            and(
              eq(CHECK.organizationId, scope.organizationId),
              eq(CHECK.providerEntityId, filter.providerEntityId),
              eq(CHECK.patientId, filter.patientId),
              ...(filter.planId ? [eq(CHECK.planId, filter.planId)] : []),
            ),
          )
          .orderBy(desc(CHECK.checkedAt), desc(CHECK.id))
          .limit(filter.limit);
        return rows.map(toCheck);
      }),

    listEnrollments: (scope, filter) =>
      inOrg(scope, async (tx) => {
        const rows = await tx
          .select()
          .from(ENROLL)
          .where(
            and(
              eq(ENROLL.organizationId, scope.organizationId),
              ...(filter.providerEntityId ? [eq(ENROLL.providerEntityId, filter.providerEntityId)] : []),
              ...(filter.payerId ? [eq(ENROLL.payerId, filter.payerId)] : []),
            ),
          )
          .orderBy(desc(ENROLL.effectiveFrom), desc(ENROLL.id))
          .limit(filter.limit);
        return rows.map(toEnrollment);
      }),

    createEnrollment: (scope, row: NewEnrollment) =>
      inOrg(scope, async (tx) => {
        const [inserted] = await tx
          .insert(ENROLL)
          .values({ ...row, organizationId: scope.organizationId })
          .returning();
        if (!inserted) throw new Error("enrollment insert returned no row");
        return toEnrollment(inserted);
      }),

    patchEnrollment: (scope, providerEntityId, id, patch: EnrollmentPatch) =>
      inOrg(scope, async (tx) => {
        const [updated] = await tx
          .update(ENROLL)
          .set({
            ...(patch.status !== undefined ? { status: patch.status } : {}),
            ...(patch.effectiveTo !== undefined ? { effectiveTo: patch.effectiveTo } : {}),
            ...(patch.evidenceRef !== undefined ? { evidenceRef: patch.evidenceRef } : {}),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(ENROLL.organizationId, scope.organizationId),
              eq(ENROLL.providerEntityId, providerEntityId),
              eq(ENROLL.id, id),
            ),
          )
          .returning();
        return updated ? toEnrollment(updated) : null;
      }),
  };
}
