// apps/backend/src/modules/15-discipline-care-plans/abac-resolver-drizzle.ts — M15-T06 (§4.5).
//
// The Drizzle-backed {@link DisciplinePlanAbacResolver} the four §4.5 predicates load their subject facts
// through. Every read opens `withOrgContext` so RLS scopes it to the acting org — an ABAC predicate must
// never see across a tenant boundary, and a cross-tenant subject therefore resolves to `null`, which the
// predicates turn into a fail-CLOSED deny.
//
// The gate read is the one nullable-by-design method: an unreadable `volunteer_compliance_gate` set is
// `null`, which §8.7 / M15-F11 turns into `isActive: false` — a booking is denied, never waved through.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type { IsoInstant, MembershipId } from "@chartwarden/types";
import { eq } from "drizzle-orm";
import type { DisciplinePlanAbacResolver, DisciplinePlanScopeFacts } from "./abac-predicates";
import type { VolunteerGateFacts } from "./volunteer/index";

const iso = (d: Date | string | null): string =>
  d === null ? "" : d instanceof Date ? d.toISOString() : new Date(d).toISOString();
const isoN = (d: Date | string | null): string | null => (d === null ? null : iso(d));

/**
 * Build the Drizzle resolver. `userId` is empty on the ABAC path (a predicate is evaluated for a request
 * whose actor is already known to M3; the org is the only scoping fact RLS needs), so the org context is
 * opened with the caller's org and a blank user — the same posture the other modules' ABAC resolvers use.
 */
export function buildDrizzleDisciplinePlanAbacResolver(db: DbClient): DisciplinePlanAbacResolver {
  const P = schema.disciplineCarePlan;
  const GATE = schema.volunteerComplianceGate;

  return {
    async loadPlanScope(orgId, planId) {
      try {
        return await withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
          const [row] = await tx.select().from(P).where(eq(P.id, planId)).limit(1);
          if (!row) return null;
          const facts: DisciplinePlanScopeFacts = {
            organizationId: row.organizationId,
            patientId: row.patientId,
            locationId: row.locationId,
            supervisingRnMembershipId: (row.supervisingRnMembershipId ??
              null) as MembershipId | null,
            aideMembershipId: (row.aideMembershipId ?? null) as MembershipId | null,
          };
          return facts;
        });
      } catch {
        return null; // fail-CLOSED — an unreadable subject denies
      }
    },

    async loadVolunteerGates(orgId, volunteerMembershipId) {
      try {
        return await withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
          const rows = await tx
            .select()
            .from(GATE)
            .where(eq(GATE.volunteerMembershipId, volunteerMembershipId));
          return rows.map(
            (r): VolunteerGateFacts => ({
              gateId: r.id,
              volunteerMembershipId: r.volunteerMembershipId as MembershipId,
              gateKind: r.gateKind,
              status: r.status,
              validFrom: iso(r.validFrom) as IsoInstant,
              validUntil: isoN(r.validUntil) as IsoInstant | null,
              revokedAt: isoN(r.revokedAt) as IsoInstant | null,
            }),
          );
        });
      } catch {
        return null; // §8.7 — an unreadable gate store DENIES
      }
    },
  };
}
