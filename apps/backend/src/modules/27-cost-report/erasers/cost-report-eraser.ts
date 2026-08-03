// apps/backend/src/modules/27-cost-report/erasers/cost-report-eraser.ts — the M27 `cost_report_class`
// data eraser (M4 destruction registry, §3.7 / §8.4). M27 carries NO PHI (D18); the destruction path is
// the tenant-offboarding cleanup of the org's OPERATIONAL config rows (cost_center_mapping +
// cost_report_validation_rule) while every COMPLIANCE-class survey-evidence table (the cost_report /
// worksheet / snapshot / validation chain, the trial-balance/wage imports, bad_debt_record, statistic_data,
// ecr_submission, the compliance window) is destruction-BLOCKED — the agency's own filed cost report is
// survey-evidence for the next five years (42 CFR §413.20 / §164.308) and may be reached only via M4's
// elevated destruction-cert path (the package's `mayDestroyCostReport` gate). Like M30/M33/M34, `subjectId`
// here is the ORG being offboarded (no patient subject), so the `DataEraser.erase(scope, subjectId)` bridge
// passes `subjectId` (the org) straight to the package's pure `CostReportEraseStore` ports.
//
// The pure store contract + the §3.7 elevated-approval gate live in `@wardenx/cost-report` (eraser.ts);
// this backend wrapper only adapts them to the M1 `DataEraser` contract and registers the REAL eraser over
// the Phase-0 deny-stub via the composition-root hook (after wireErasers(), before validateErasers() — the
// same M22/M30/M33/M34/M36/M40 registration shape).
import {
  CostReportEraseRefused,
  type CostReportEraseStore,
  type CostReportEraseTableCounts,
} from "@wardenx/cost-report";
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { DataClass, DataEraser } from "@wardenx/types";
import { and, eq, exists, notExists, sql } from "drizzle-orm";
import type { AnyPgColumn, AnyPgTable } from "drizzle-orm/pg-core";
import { registerEraser } from "../../../bootstrap/index";

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

/**
 * The M27 destruction data class. NOT yet a member of the `@wardenx/types` `DataClass` union (M4-owned);
 * the Integrate phase adds `"cost_report_class"` to that union + to `REQUIRED_ERASERS`
 * (apps/backend/src/bootstrap/erasers/registry.ts) so boot fails closed if M27's real eraser is never
 * registered. Kept here as the single string literal so that wiring lands in one place (the M30
 * `quality_class` precedent).
 */
export const COST_REPORT_DATA_CLASS = "cost_report_class" satisfies DataClass;

/** Deps for the M27 eraser registration; absent ⇒ the in-memory slice store (prod injects the Drizzle store). */
export interface CostReportEraserDeps {
  /** The Drizzle-backed `CostReportEraseStore` in prod (each DELETE / COUNT under the offboarding tenancy
   *  context); the in-memory slice store by default. */
  readonly store?: CostReportEraseStore;
}

/** Sum every per-table count in the §3.7 erase-count map (the M4 destruction-cert `tableCounts`). */
function sumCounts(counts: CostReportEraseTableCounts): number {
  return Object.values(counts).reduce((total, n) => total + n, 0);
}

/**
 * The Drizzle-backed {@link CostReportEraseStore}: the REAL §3.7 tenant-offboarding path (TASK-003 /
 * ARCH-007). Every statement runs inside `withOrgContext` pinned to the OFFBOARDING org, so RLS scopes
 * each DELETE/COUNT to that tenant.
 *
 * · `deleteOperationalConfig` deletes the org's `cost_center_mapping` rows and its `cost_report_validation_rule`
 *   rows — EXCEPT rules still referenced by a `cost_report_validation_result` (SQL FK `result.rule_id → rule`,
 *   no cascade): a result is survey evidence and is meaningless without the rule it evaluated, so a
 *   referenced rule has become part of the evidence chain and is RETAINED (it surfaces in
 *   `countComplianceEvidence` as `cost_report_validation_rule_retained`). Platform-default rules
 *   (`organization_id IS NULL`) are never matched by the org-equality predicate.
 * · `countComplianceEvidence` COUNTS (never deletes) every compliance-class survey-evidence table — the
 *   cost_report/worksheet/snapshot/validation chain, the trial-balance/wage imports, bad_debt_record,
 *   statistic_data, ecr_submission and the compliance window (42 CFR §413.20 / §164.308).
 * · `deleteComplianceEvidence` REFUSES with a typed {@link CostReportEraseRefused}
 *   (`elevated_destruction_cert_not_bound`): the §3.7 elevated destruction path may only run under an M4
 *   destruction certificate carrying the elevated `compliance_officer` co-sign (`mayDestroyCostReport`),
 *   and that cert-driven binding has not landed — fail-closed, never a silent evidence delete.
 */
export function createDrizzleCostReportEraseStore(db: DbClient): CostReportEraseStore {
  const MAPPING = schema.costCenterMapping;
  const RULE = schema.costReportValidationRule;
  const RESULT = schema.costReportValidationResult;

  const inOrg = <T>(organizationId: string, fn: (tx: Tx) => Promise<T>): Promise<T> =>
    withOrgContext(db, { organizationId, userId: "" }, fn);

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

  /** Rules referenced by ≥1 surviving validation result — evidence-locked, never deleted here. */
  const ruleIsReferenced = (tx: Tx) =>
    tx.select({ one: sql`1` }).from(RESULT).where(eq(RESULT.ruleId, RULE.id));

  return {
    async deleteOperationalConfig(organizationId) {
      return inOrg(organizationId, async (tx) => {
        const mappings = await tx
          .delete(MAPPING)
          .where(eq(MAPPING.organizationId, organizationId))
          .returning({ org: MAPPING.organizationId });
        const rules = await tx
          .delete(RULE)
          .where(and(eq(RULE.organizationId, organizationId), notExists(ruleIsReferenced(tx))))
          .returning({ id: RULE.id });
        return {
          cost_center_mapping: mappings.length,
          cost_report_validation_rule: rules.length,
        };
      });
    },

    async countComplianceEvidence(organizationId) {
      return inOrg(organizationId, async (tx) => {
        const counts: CostReportEraseTableCounts = {
          cost_report: await countOrg(tx, schema.costReport, organizationId),
          cost_report_worksheet: await countOrg(tx, schema.costReportWorksheet, organizationId),
          cost_report_snapshot: await countOrg(tx, schema.costReportSnapshot, organizationId),
          cost_report_validation: await countOrg(tx, schema.costReportValidation, organizationId),
          cost_report_validation_result: await countOrg(
            tx,
            schema.costReportValidationResult,
            organizationId,
          ),
          cost_report_validation_override: await countOrg(
            tx,
            schema.costReportValidationOverride,
            organizationId,
          ),
          trial_balance_import: await countOrg(tx, schema.trialBalanceImport, organizationId),
          wage_data_import: await countOrg(tx, schema.wageDataImport, organizationId),
          bad_debt_record: await countOrg(tx, schema.badDebtRecord, organizationId),
          statistic_data: await countOrg(tx, schema.statisticData, organizationId),
          ecr_submission: await countOrg(tx, schema.ecrSubmission, organizationId),
          cost_report_compliance_window: await countOrg(
            tx,
            schema.costReportComplianceWindow,
            organizationId,
          ),
        };
        // Operational-config rules that survived deleteOperationalConfig because a surviving
        // validation result still references them (evidence-locked; see the factory header).
        const [retained] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(RULE)
          .where(and(eq(RULE.organizationId, organizationId), exists(ruleIsReferenced(tx))));
        counts.cost_report_validation_rule_retained = retained?.n ?? 0;
        return counts;
      });
    },

    async deleteComplianceEvidence(_organizationId) {
      // §3.7: destroying submitted survey evidence needs the M4 ELEVATED destruction cert
      // (`mayDestroyCostReport` — elevated + compliance_officer co-sign). That cert-driven binding has
      // not landed, so this store REFUSES rather than expose an ungated evidence-destruction capability.
      throw new CostReportEraseRefused("elevated_destruction_cert_not_bound");
    },
  };
}

/**
 * Adapt the package's pure `CostReportEraseStore` to the M1 `DataEraser` contract. On ordinary tenant
 * offboarding the operational config rows are deleted and the compliance-class survey evidence is COUNTED
 * but NEVER deleted (fail-closed: the elevated destruction-cert path is M4's, not this offboarding eraseFn).
 */
export function createCostReportEraser(store: CostReportEraseStore): DataEraser {
  return {
    // `subjectId` IS the offboarding org for this cost-report class (no patient subject); the M4 destruction
    // registry hands it in as the subject the certificate records. The §3.7 elevated co-sign gate (which
    // needs the destruction certificate's approver list, `mayDestroyCostReport`) binds once the M4
    // cert-driven destruction binding lands.
    async erase(_scope, subjectId) {
      const operational = await store.deleteOperationalConfig(subjectId);
      await store.countComplianceEvidence(subjectId);
      return { erased: sumCounts(operational) };
    },
  };
}

/** Default in-memory `CostReportEraseStore` (the slice store): zero counts, never deletes evidence. Prod
 *  injects the Drizzle-backed store. Mirrors the M30 `createInMemoryQualityEraseStore` default. */
function createInMemoryCostReportEraseStore(): CostReportEraseStore {
  return {
    async deleteOperationalConfig(_organizationId) {
      return { cost_center_mapping: 0, cost_report_validation_rule: 0 };
    },
    async countComplianceEvidence(_organizationId) {
      return {};
    },
    async deleteComplianceEvidence(_organizationId) {
      return {};
    },
  };
}

/**
 * Register the REAL M27 cost-report eraser over the Phase-0 `cost_report_class` deny-stub. Called by the
 * composition root's `registerModuleErasers` hook (after wireErasers(), before validateErasers()), the same
 * hook M5/M6/M22/M30/M33/M34/M36/M40 use. The in-memory slice store is the default; prod injects the
 * Drizzle store.
 *
 * Prod injects `createDrizzleCostReportEraseStore(db)` via `deps.store` (each operational DELETE + each
 * compliance-class COUNT under the offboarding org's tenancy context; `deleteComplianceEvidence` refuses).
 *
 * TODO(M27 boot-wiring, Integrate phase): (1) add `"cost_report_class"` to the `@wardenx/types` `DataClass`
 * union + `REQUIRED_ERASERS` so the deny-stub exists to register over; (2) wire the §3.7 `decisionCert`
 * elevated co-sign gate (`mayDestroyCostReport`) once the M4 cert-driven destruction binding lands.
 */
export function registerCostReportErasers(deps: CostReportEraserDeps = {}): void {
  const store = deps.store ?? createInMemoryCostReportEraseStore();
  registerEraser(COST_REPORT_DATA_CLASS, createCostReportEraser(store));
}
