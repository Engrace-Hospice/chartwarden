// apps/backend/src/modules/38-terminology/jobs/tenant-scan.ts — `terminology.tenant_deprecation_scan` (GAP-108,
// §4.3 / §7.3 / §8.1): after a load that deprecated codes, build EACH active tenant's remediation rollup and
// raise the M36 alert to its Compliance Officer.
//
// TENANCY. M38 never reads another module's tables (ADR-0011 D1): the per-org code usage comes from the owner-
// published producers (today M7's problem list via `CarePlanReader.terminologyCodeUsageForOrg`, an ORG-EXPLICIT
// seam that scopes itself under RLS). The org list comes from the audited platform-pool enumerator
// (`buildActiveOrgEnumerator`), and every per-org step takes that org id explicitly — nothing here relies on an
// ambient request context, because a worker has none.
//
// BOUNDED + IDEMPOTENT + ISOLATED. Deprecated codes go to a producer in fixed-size slices; each org is processed
// independently (one org's failure never stops the rest); completed orgs are recorded in the job's progress, so a
// retry (BullMQ attempts) skips them and no tenant is alerted twice. A tenant with no exposure is not paged.
import { runTenantDeprecationScan } from "@wardenx/terminology";
import type { CodeSystemId, RemediationReport, TenantCodeRecord } from "@wardenx/terminology";
import type { TerminologyOpsStore } from "../ops-store";
import type { CodeUsageProducer } from "../remediation-service";
import { SCAN_CODES_PER_PRODUCER_CALL, type TenantScanJobData } from "./queues";

/** The M36 alert event type (seeded as a platform-default `alert_rule`, administrative, warn). */
export const TENANT_DEPRECATION_ALERT_EVENT = "m38.tenant_deprecation_scan.completed";
/** Codes named in the alert payload (the full list is on the remediation page). */
const ALERT_SAMPLE_CODES = 10;

export interface ActiveOrgList {
  listActiveOrgs(): Promise<readonly { readonly organizationId: string }[]>;
}

export interface TenantScanDeps {
  readonly activeOrgs: ActiveOrgList;
  readonly ops: Pick<TerminologyOpsStore, "deprecationsSince">;
  readonly producers: readonly CodeUsageProducer[];
  readonly alerts: {
    emit(
      organizationId: string,
      input: {
        eventType: string;
        payload: Record<string, unknown>;
        severity: string;
        correlationId: string;
      },
    ): Promise<unknown>;
  };
  readonly log: { error(obj: unknown, msg?: string): void; info(obj: unknown, msg?: string): void };
}

/** Which orgs already finished (so a retry does not re-alert them). Backed by the BullMQ job's progress. */
export interface ScanProgress {
  readonly completedOrgs: ReadonlySet<string>;
  markCompleted(organizationId: string): Promise<void>;
}

export interface TenantScanResult {
  readonly orgsScanned: number;
  readonly orgsAlerted: number;
  readonly orgsSkipped: number;
  readonly deprecatedCodes: number;
}

const chunks = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

async function usageFor(
  producers: readonly CodeUsageProducer[],
  organizationId: string,
  codes: readonly { systemId: string; code: string }[],
): Promise<TenantCodeRecord[]> {
  const out: TenantCodeRecord[] = [];
  for (const slice of chunks(codes, SCAN_CODES_PER_PRODUCER_CALL)) {
    for (const p of producers) {
      const rows = await p.usage(organizationId, slice);
      for (const r of rows) {
        out.push({
          recordId: r.recordId,
          recordType: r.recordType || p.recordType,
          systemId: r.systemId as CodeSystemId,
          code: r.code,
        });
      }
    }
  }
  return out;
}

function alertPayload(job: TenantScanJobData, report: RemediationReport): Record<string, unknown> {
  return {
    system: job.system,
    versionId: job.versionId,
    affectedRecordCount: report.totalAffected,
    affectedCodeCount: report.affectedCodeCount,
    sampleCodes: report.lines.slice(0, ALERT_SAMPLE_CODES).map((l) => l.deprecatedCode),
  };
}

/** One scan across every active org for the deprecations a load created. Throws after ALL orgs ran if any failed. */
export async function runTenantDeprecationScanJob(
  deps: TenantScanDeps,
  job: TenantScanJobData,
  progress: ScanProgress,
): Promise<TenantScanResult> {
  const deprecations = await deps.ops.deprecationsSince(
    job.effectiveFrom,
    job.system as CodeSystemId,
  );
  const codes = deprecations.map((d) => ({
    systemId: d.systemId as string,
    code: d.deprecatedCode,
  }));
  const orgs = await deps.activeOrgs.listActiveOrgs();
  const failures: { organizationId: string; error: unknown }[] = [];
  let alerted = 0;
  let skipped = 0;

  for (const { organizationId } of orgs) {
    if (progress.completedOrgs.has(organizationId)) {
      skipped++;
      continue;
    }
    try {
      await runTenantDeprecationScan(organizationId, {
        loadTenantRecords: (orgId) => usageFor(deps.producers, orgId, codes),
        loadDeprecations: async () => deprecations,
        emitRemediationAlert: async (orgId, rep) => {
          await deps.alerts.emit(orgId, {
            eventType: TENANT_DEPRECATION_ALERT_EVENT,
            payload: alertPayload(job, rep),
            severity: "warn",
            correlationId: `m38-scan-${job.versionId}-${orgId}`,
          });
          alerted++;
        },
      });
      await progress.markCompleted(organizationId);
    } catch (error) {
      failures.push({ organizationId, error });
      deps.log.error(
        {
          organizationId,
          versionId: job.versionId,
          reason: error instanceof Error ? error.message : String(error),
        },
        "tenant deprecation scan failed for an org",
      );
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((f) => f.error),
      `terminology.tenant_deprecation_scan: ${failures.length} org(s) failed`,
    );
  }
  return {
    orgsScanned: orgs.length - skipped,
    orgsAlerted: alerted,
    orgsSkipped: skipped,
    deprecatedCodes: codes.length,
  };
}
