// @chartwarden/terminology — terminology job processors (M38-T10, spec §4.3, §7.3, §7.5, §8.1).
//
// The pure, infra-free logic the §4.3 workers run, each a function over injected ports — the same
// pattern as the M4 audit jobs: unit-tested against in-memory ports (./ports), with the production
// Drizzle/Valkey/loader/embedding adapters bound to the identical port shapes at the app boot.
//
//   • refresh expansions      → recompute `value_set_expansion` for the value sets an activated
//                               version touched, via the T07 computeExpansion engine (§7.5). Pure.
//   • tenant deprecation scan → roll a tenant's records up by deprecated code (T07
//                               buildRemediationReport, §7.3) + emit the M36 alert (§8.1). Pure.
//   • load version            → orchestration over the loader adapter (M1 §6.23, out of M38's
//                               codePath); modelled here as ports so the policy is testable and the
//                               production fetch/stage/diff binds at boot.
//   • refresh embeddings      → orchestration over the embeddings-worker adapter (architecture §12),
//                               same deferred-binding stance.
//
// No clock/RNG/I/O in this module — the engines are deterministic, so a run's effects are assertable.
import { type ExpansionRow, type ValueSetMemberRow, computeExpansion } from "../expansion/index";
import type { CodeSystemId } from "../interfaces/kinds";
import type { DeprecationMappingResponse } from "../interfaces/provider";
import {
  type RemediationReport,
  type TenantCodeRecord,
  buildRemediationReport,
} from "../remediation/index";

// --- refresh expansions (terminology.refresh_expansions, §4.3 / §7.5) -------------------------

/** What `refresh_expansions` reported: which value sets it recomputed + the total rows written. */
export interface RefreshExpansionsResult {
  readonly valueSetIds: readonly string[];
  readonly rowsWritten: number;
}

/** Ports the expansion-refresh processor binds (Drizzle reads/writes in production). */
export interface RefreshExpansionsPorts {
  /** Current member rows for the value sets that include `system` (the recompute input set). */
  loadMembersForSystem(system: CodeSystemId): Promise<readonly ValueSetMemberRow[]>;
  /** Replace the stored expansion rows for each recomputed value set (idempotent rebuild). */
  writeExpansion(rows: readonly ExpansionRow[]): Promise<void>;
}

/**
 * Recompute `value_set_expansion` for every value set that includes the activated `system` (§7.5).
 * Pure over the engine: loads the affected members, materialises the expansion via computeExpansion,
 * and writes it back. Returns the recomputed value-set ids (sorted, distinct) + the row count.
 */
export async function runRefreshExpansions(
  system: CodeSystemId,
  ports: RefreshExpansionsPorts,
): Promise<RefreshExpansionsResult> {
  const members = await ports.loadMembersForSystem(system);
  const rows = computeExpansion(members);
  await ports.writeExpansion(rows);
  const valueSetIds = [...new Set(rows.map((r) => r.valueSetId))].sort();
  return { valueSetIds, rowsWritten: rows.length };
}

// --- tenant deprecation scan (terminology.tenant_deprecation_scan, §4.3 / §7.3 / §8.1) --------

/** A deprecation mapping a scan considers, tagged with its system (the engine's input shape). */
export type ScanDeprecation = { readonly systemId: CodeSystemId } & DeprecationMappingResponse;

/** What `tenant_deprecation_scan` reported for one org: its remediation rollup. */
export interface TenantDeprecationScanResult {
  readonly orgId: string;
  readonly report: RemediationReport;
}

/** Ports the tenant-deprecation-scan processor binds (Drizzle reads + M36 alert emit). */
export interface TenantDeprecationScanPorts {
  /** The org's records that reference any code (problem list, claim line, order, …). */
  loadTenantRecords(orgId: string): Promise<readonly TenantCodeRecord[]>;
  /** The deprecations detected by the triggering load. */
  loadDeprecations(): Promise<readonly ScanDeprecation[]>;
  /** Emit the M36 alert to the org's Compliance Officer with the rollup summary (§7.3, §8.1). */
  emitRemediationAlert(orgId: string, report: RemediationReport): Promise<void>;
}

/**
 * Build the org's §7.3 remediation report and, when any record is affected, emit the M36 alert
 * (§8.1 `m38.tenant_deprecation_scan.completed`). An empty report emits no alert — a tenant with no
 * exposure is not paged. Pure over the engine; the alert emit is the one injected side effect.
 */
export async function runTenantDeprecationScan(
  orgId: string,
  ports: TenantDeprecationScanPorts,
): Promise<TenantDeprecationScanResult> {
  const [records, deprecations] = await Promise.all([
    ports.loadTenantRecords(orgId),
    ports.loadDeprecations(),
  ]);
  const report = buildRemediationReport(records, deprecations);
  if (report.totalAffected > 0) await ports.emitRemediationAlert(orgId, report);
  return { orgId, report };
}
