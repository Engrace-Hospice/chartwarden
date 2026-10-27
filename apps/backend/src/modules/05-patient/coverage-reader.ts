// apps/backend/src/modules/05-patient/coverage-reader.ts — M5 §3.4 `PatientCoverageReader` seam impl.
//
// The coverage projection the BILLING modules resolve a claim's payer from. Before this seam, M5's
// `patient_payer` rows were reachable only through the M5 HTTP route, so M23 (Medicare) and M24 (Medicaid)
// each carried "resolve the patient's payer" as an open deferral and degraded claim assembly to a 503. This
// closes that for both — it is deliberately a seam, not a shared service import, so neither billing module
// gains a schema edge into M5 (ADR-0005).
//
// Reads run under `withOrgContext` so Postgres RLS scopes them to the calling org; the caller passes the org
// explicitly (a seam has no request context of its own). Returns the coverage identity + member id and
// nothing clinical — a consumer that only needs to CHOOSE a coverage reads `id` and leaves `subscriberId`
// alone (M24 stores only the masked tail; D12 / §3.6).
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type { PatientCoverage, PatientCoverageReader } from "@chartwarden/types";
import { and, eq } from "drizzle-orm";
import { coverageForRange, inForceOn } from "./coverage-intervals";

const day = (d: Date | string | null): string | null => {
  if (d === null) return null;
  return (d instanceof Date ? d.toISOString() : new Date(d).toISOString()).slice(0, 10);
};

export function buildPatientCoverageReader(db: DbClient): PatientCoverageReader {
  const PAYER = schema.patientPayers;

  const load = async (organizationId: string, patientId: string): Promise<PatientCoverage[]> =>
    withOrgContext(db, { organizationId, userId: "system" }, async (tx) => {
      const rows = await tx
        .select()
        .from(PAYER)
        .where(and(eq(PAYER.organizationId, organizationId), eq(PAYER.patientId, patientId)));
      return rows.map(
        (r): PatientCoverage => ({
          id: r.id,
          patientId: r.patientId,
          payerId: r.payerId,
          rank: r.rank,
          coverageKind: r.coverageKind,
          subscriberId: r.subscriberId,
          groupNumber: r.groupNumber ?? null,
          current: r.effectiveTo === null,
          effectiveFrom: day(r.effectiveFrom) ?? "",
          effectiveTo: day(r.effectiveTo),
        }),
      );
    });

  return {
    async coveragesForPatient({ organizationId, patientId }) {
      const rows = await load(organizationId, patientId);
      return [...rows].sort((a, b) => a.rank - b.rank);
    },

    // The assembly hot path: the highest-ranked coverage of a kind in force ON the service date. Rank
    // order decides when a patient carries two of the same kind (a plan switch mid-period), and an
    // out-of-force coverage is never returned — billing a terminated coverage is the failure mode here.
    async activeCoverageOfKind({ organizationId, patientId, coverageKind, onDate }) {
      const rows = await load(organizationId, patientId);
      const eligible = rows
        .filter((c) => c.coverageKind === coverageKind && inForceOn(c, onDate))
        .sort((a, b) => a.rank - b.rank);
      return eligible[0] ?? null;
    },

    // #845 — the range-wide, cross-kind resolver. A billing gate asks this, never two point reads at the endpoints.
    async coverageForRange({ organizationId, patientId, from, to, coverageKind }) {
      return coverageForRange(await load(organizationId, patientId), { from, to }, coverageKind);
    },
  };
}
