// apps/backend/src/modules/30-quality/erasers/quality-eraser.ts — the M30 `quality_class` data eraser
// (M4 destruction registry, §3.7 / D6 / §8.4). On tenant offboarding M30's eraseFn deletes the org's
// OPERATIONAL quality rows (measure_recompute_queue → quality_measure_value → cahps_decedent_sample →
// cahps_vendor_binding) in FK-safe order and REFUSES every COMPLIANCE-class survey evidence table
// (incident_report / mortality_review / the SRA chain / the QAPI chain / cop_compliance_status /
// infection surveillance / cahps_result_summary) — that evidence is the agency's record of having done
// the work (§418.58 / §418.60 / §164.308) and is destruction-blocked: counted for the certificate, never
// deleted. Like M33/M34, `subjectId` here is the ORG being offboarded (the tenant-offboarding cleanup has
// no patient subject), so the `DataEraser.erase(scope, subjectId)` bridge passes `subjectId` (the org)
// straight to the package's pure `eraseTenantQuality(orgId, store)`. The patient-scoped PHI redaction of
// the four partitioned PHI tables is a SEPARATE per-table eraser path (§3.7), not this offboarding eraseFn.
//
// The pure eraseFn + its narrow store port + the in-memory store live in `@wardenx/quality` (eraser.ts);
// this backend wrapper only adapts them to the M1 `DataEraser` contract and registers the REAL eraser over
// the Phase-0 deny-stub via the composition-root hook (after wireErasers(), before validateErasers() — the
// same M22/M33/M34/M36/M40 registration shape).
import { type DbClient, schema } from "@wardenx/db";
import {
  type QualityEraseStore,
  createInMemoryQualityEraseStore,
  eraseTenantQuality,
} from "@wardenx/quality";
import { withOrgContext } from "@wardenx/tenancy";
import type { DataClass, DataEraser } from "@wardenx/types";
import { eq, sql } from "drizzle-orm";
import type { AnyPgColumn, AnyPgTable } from "drizzle-orm/pg-core";
import { registerEraser } from "../../../bootstrap/index";

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

/**
 * The M30 destruction data class. NOT yet a member of the `@wardenx/types` `DataClass` union (M4-owned);
 * the Integrate phase adds `"quality_class"` to that union + to `REQUIRED_ERASERS`
 * (apps/backend/src/bootstrap/erasers/registry.ts) so boot fails closed if M30's real eraser is never
 * registered. Kept here as the single string literal so that wiring lands in one place.
 */
export const QUALITY_DATA_CLASS = "quality_class" satisfies DataClass;

/** Deps for the M30 eraser registration; absent ⇒ the in-memory slice store (prod injects the Drizzle store). */
export interface QualityEraserDeps {
  /** The Drizzle-backed `QualityEraseStore` in prod (each DELETE / COUNT under the offboarding tenancy
   *  context); the in-memory slice store by default. */
  readonly store?: QualityEraseStore;
}

/** Optional side-effect deps the Drizzle store can carry (prod binds the outbox emit at the root). */
export interface DrizzleQualityEraseDeps {
  /** Route `m30.tenant_eraser.complete` (best-effort); absent ⇒ the optional port method is omitted. */
  readonly emitEraserComplete?: NonNullable<QualityEraseStore["emitEraserComplete"]>;
}

/**
 * The Drizzle-backed {@link QualityEraseStore}: the REAL §3.7 tenant-offboarding destruction path
 * (TASK-003 / ARCH-007). Every statement runs inside `withOrgContext` pinned to the OFFBOARDING org, so
 * RLS scopes each DELETE/COUNT to that tenant. The four OPERATIONAL tables are deleted with counts from
 * `returning(...)` lengths (rows ACTUALLY removed); every COMPLIANCE-class survey-evidence table is
 * COUNT-ONLY — `count(*)` under the same org scope, never a DELETE (destruction-blocked, §418.58 /
 * §418.60 / §164.308). The FK-safe operational order is the port's own (`cahps_decedent_sample` before
 * its parent `cahps_vendor_binding`), so no cross-method carry is needed here. The partitioned PHI
 * tables (`incident_report` / `mortality_review` / `infection_surveillance_event` /
 * `cahps_decedent_sample`) are counted/deleted through the partitioned parent — Postgres routes to the
 * leaves.
 */
export function createDrizzleQualityEraseStore(
  db: DbClient,
  deps: DrizzleQualityEraseDeps = {},
): QualityEraseStore {
  const inOrg = <T>(organizationId: string, fn: (tx: Tx) => Promise<T>): Promise<T> =>
    withOrgContext(db, { organizationId, userId: "" }, fn);

  /** COUNT-ONLY helper for one destruction-blocked table (org-scoped; never deletes). */
  const countOrg = async (
    tx: Tx,
    table: AnyPgTable & { organizationId: AnyPgColumn },
    organizationId: string,
  ): Promise<number> => {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(table)
      .where(eq(table.organizationId, organizationId));
    return row?.n ?? 0;
  };

  return {
    async deleteRecomputeQueue(organizationId) {
      return inOrg(organizationId, async (tx) => {
        const rows = await tx
          .delete(schema.measureRecomputeQueue)
          .where(eq(schema.measureRecomputeQueue.organizationId, organizationId))
          .returning({ org: schema.measureRecomputeQueue.organizationId });
        return rows.length;
      });
    },

    async deleteMeasureValues(organizationId) {
      return inOrg(organizationId, async (tx) => {
        const rows = await tx
          .delete(schema.qualityMeasureValue)
          .where(eq(schema.qualityMeasureValue.organizationId, organizationId))
          .returning({ org: schema.qualityMeasureValue.organizationId });
        return rows.length;
      });
    },

    async deleteCahpsDecedentSamples(organizationId) {
      return inOrg(organizationId, async (tx) => {
        const rows = await tx
          .delete(schema.cahpsDecedentSample)
          .where(eq(schema.cahpsDecedentSample.organizationId, organizationId))
          .returning({ org: schema.cahpsDecedentSample.organizationId });
        return rows.length;
      });
    },

    async deleteCahpsVendorBindings(organizationId) {
      return inOrg(organizationId, async (tx) => {
        const rows = await tx
          .delete(schema.cahpsVendorBinding)
          .where(eq(schema.cahpsVendorBinding.organizationId, organizationId))
          .returning({ org: schema.cahpsVendorBinding.organizationId });
        return rows.length;
      });
    },

    // ── compliance-class survey evidence: COUNT ONLY, destruction-blocked (§3.7) ──────────────────
    async countIncidents(organizationId) {
      return inOrg(organizationId, (tx) => countOrg(tx, schema.incidentReport, organizationId));
    },
    async countMortalityReviews(organizationId) {
      return inOrg(organizationId, (tx) => countOrg(tx, schema.mortalityReview, organizationId));
    },
    async countSraEvidence(organizationId) {
      return inOrg(organizationId, async (tx) => {
        const cycles = await countOrg(tx, schema.sraCycle, organizationId);
        const findings = await countOrg(tx, schema.sraFinding, organizationId);
        const remediations = await countOrg(tx, schema.sraRemediation, organizationId);
        return cycles + findings + remediations;
      });
    },
    async countQapiEvidence(organizationId) {
      return inOrg(organizationId, async (tx) => {
        const programs = await countOrg(tx, schema.qapiProgram, organizationId);
        const indicators = await countOrg(tx, schema.qapiIndicator, organizationId);
        const projects = await countOrg(tx, schema.qapiProject, organizationId);
        const pips = await countOrg(tx, schema.qapiPip, organizationId);
        const minutes = await countOrg(tx, schema.qapiGovernanceMinutes, organizationId);
        return programs + indicators + projects + pips + minutes;
      });
    },
    async countCopCompliance(organizationId) {
      return inOrg(organizationId, (tx) =>
        countOrg(tx, schema.copComplianceStatus, organizationId),
      );
    },
    async countInfectionEvidence(organizationId) {
      return inOrg(organizationId, async (tx) => {
        const events = await countOrg(tx, schema.infectionSurveillanceEvent, organizationId);
        const outbreakCases = await countOrg(tx, schema.infectionOutbreakCase, organizationId);
        return events + outbreakCases;
      });
    },
    async countCahpsResults(organizationId) {
      return inOrg(organizationId, (tx) => countOrg(tx, schema.cahpsResultSummary, organizationId));
    },

    ...(deps.emitEraserComplete ? { emitEraserComplete: deps.emitEraserComplete } : {}),
  };
}

/** Adapt the package's pure `eraseTenantQuality(orgId, store)` to the M1 `DataEraser` contract. */
export function createQualityEraser(store: QualityEraseStore): DataEraser {
  return {
    // `subjectId` IS the offboarding org for this quality class (no patient subject); the M4 destruction
    // registry hands it in as the subject the certificate records. The §3.7 co-sign gate (which needs the
    // destruction certificate's approver list) binds once the M4 cert-driven destruction binding lands.
    async erase(_scope, subjectId) {
      const { erased } = await eraseTenantQuality(subjectId, store);
      return { erased };
    },
  };
}

/**
 * Register the REAL M30 quality eraser over the Phase-0 `quality_class` deny-stub. Called by the
 * composition root's `registerModuleErasers` hook (after wireErasers(), before validateErasers()), the same
 * hook M5/M6/M22/M33/M34/M36/M40 use. The in-memory slice store is the default; prod injects the Drizzle store.
 *
 * Prod injects `createDrizzleQualityEraseStore(db)` via `deps.store` (each operational DELETE + each
 * compliance-class COUNT under the offboarding org's tenancy context) so the eraser runs against the real
 * M30 tables.
 *
 * TODO(M30 boot-wiring, Integrate phase): (1) add `"quality_class"` to the `@wardenx/types` `DataClass`
 * union + `REQUIRED_ERASERS` so the deny-stub exists to register over; (2) wire the §3.7 `decisionCert`
 * co-sign gate once the M4 cert-driven destruction binding lands. The four partitioned-PHI per-table
 * erasers (patient-scoped redaction) register separately.
 */
export function registerQualityErasers(deps: QualityEraserDeps = {}): void {
  const store = deps.store ?? createInMemoryQualityEraseStore().store;
  registerEraser(QUALITY_DATA_CLASS, createQualityEraser(store));
}
