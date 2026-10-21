// @chartwarden/terminology — in-memory adapters for the terminology job processors (M38-T10, §4.3).
//
// Deterministic, infra-free ports the job unit tests run against — the same forward pattern as the
// M4 audit job ports. Each adapter records what the processor asked it to do so a run's effects are
// assertable; the production Drizzle/Valkey/loader adapters bind the identical port shapes at boot.
import type { ExpansionRow, ValueSetMemberRow } from "../expansion/index";
import type { CodeSystemId } from "../interfaces/kinds";
import type { RemediationReport, TenantCodeRecord } from "../remediation/index";
import type {
  RefreshExpansionsPorts,
  ScanDeprecation,
  TenantDeprecationScanPorts,
} from "./processors";

/** In-memory `RefreshExpansionsPorts`: serves seeded members + captures the written expansion rows. */
export function createInMemoryRefreshExpansionsPorts(seed: {
  readonly membersBySystem?: Partial<Record<CodeSystemId, readonly ValueSetMemberRow[]>>;
}): { ports: RefreshExpansionsPorts; written(): ExpansionRow[] } {
  const written: ExpansionRow[] = [];
  const ports: RefreshExpansionsPorts = {
    loadMembersForSystem: (system) => Promise.resolve(seed.membersBySystem?.[system] ?? []),
    writeExpansion: (rows) => {
      written.push(...rows);
      return Promise.resolve();
    },
  };
  return { ports, written: () => written };
}

/** In-memory `TenantDeprecationScanPorts`: seeded records + deprecations; captures emitted alerts. */
export function createInMemoryTenantDeprecationScanPorts(seed: {
  readonly recordsByOrg?: Readonly<Record<string, readonly TenantCodeRecord[]>>;
  readonly deprecations?: readonly ScanDeprecation[];
}): {
  ports: TenantDeprecationScanPorts;
  alerts(): { orgId: string; report: RemediationReport }[];
} {
  const alerts: { orgId: string; report: RemediationReport }[] = [];
  const ports: TenantDeprecationScanPorts = {
    loadTenantRecords: (orgId) => Promise.resolve(seed.recordsByOrg?.[orgId] ?? []),
    loadDeprecations: () => Promise.resolve(seed.deprecations ?? []),
    emitRemediationAlert: (orgId, report) => {
      alerts.push({ orgId, report });
      return Promise.resolve();
    },
  };
  return { ports, alerts: () => alerts };
}
