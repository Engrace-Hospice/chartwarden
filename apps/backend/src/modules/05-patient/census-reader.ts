// apps/backend/src/modules/05-patient/census-reader.ts — M5 `PatientCensusReader` seam impl (ADR-0108 D8).
//
// The census the M35 claims-billing add-on PULLS: ids of patients whose status is `active`, keyset-paged by id, plus
// M5's own count for reconciliation. Ids only — no name, MRN or DOB crosses. Reads run under `withOrgContext` so RLS
// scopes them to the asked org. A worker calls it (no request), hence the org-explicit signature.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type { PatientCensusReader } from "@chartwarden/types";
import { and, asc, count, eq, gt } from "drizzle-orm";

/** Upper bound on one page, whatever the caller asks for. */
export const CENSUS_PAGE_MAX = 1000;

export function buildPatientCensusReader(db: DbClient): PatientCensusReader {
  const P = schema.patients;
  const active = (organizationId: string) =>
    and(eq(P.organizationId, organizationId), eq(P.status, "active"));

  return {
    async activePatientIdsPage(organizationId, { after, limit }) {
      const size = Math.max(1, Math.min(Math.trunc(limit), CENSUS_PAGE_MAX));
      const rows = await withOrgContext(db, { organizationId, userId: "system" }, (tx) =>
        tx
          .select({ id: P.id })
          .from(P)
          .where(after ? and(active(organizationId), gt(P.id, after)) : active(organizationId))
          .orderBy(asc(P.id))
          .limit(size),
      );
      const ids = rows.map((r) => r.id);
      return { ids, nextAfter: ids.length === size ? (ids[ids.length - 1] ?? null) : null };
    },
    async activePatientCount(organizationId) {
      const [row] = await withOrgContext(db, { organizationId, userId: "system" }, (tx) =>
        tx.select({ n: count() }).from(P).where(active(organizationId)),
      );
      return Number(row?.n ?? 0);
    },
  };
}
