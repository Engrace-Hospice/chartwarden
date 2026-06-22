// @wardenx/terminology — annual deprecation remediation rollup (M38-T07, spec §7.3, §2.6).
//
// The day a new code-system version activates and deprecates codes, every tenant with active
// records (problem list, claim line, order) on a now-deprecated code must be told (§7.3). The
// loader's per-tenant scan (§2.6 `terminology.tenant_deprecation_scan`) feeds this PURE rollup:
// given a tenant's candidate records and the version's deprecation mappings, produce the
// per-deprecated-code report the `/admin/terminology/remediation` page renders and the Module-36
// Compliance alert summarizes — affected count, successor codes, and a bounded sample of record
// ids for one-click drill-down.
//
// Pure and DB-agnostic (no scan, no alert dispatch — those are the job/seam layer): deterministic
// output for the same inputs, so the §7.3 "renders in < 1 s for 100 records" bound is a non-issue
// and the report is snapshot-testable. The loader/T10 jobs own the scan that gathers `records` and
// the M36 alert that ships the summary; this is the lens they share.

import type { CodeSystemId } from "../interfaces/kinds";
import type { DeprecationMappingResponse } from "../interfaces/provider";

/** A tenant record (problem list / claim line / order, §7.3) referencing a terminology code. */
export interface TenantCodeRecord {
  readonly recordId: string;
  /** Free-form record class for the rollup ("problem_list" | "claim_line" | "order" | …). */
  readonly recordType: string;
  readonly systemId: CodeSystemId;
  readonly code: string;
}

/** One per-deprecated-code line of the remediation report (§7.3 rollup row). */
export interface RemediationLine {
  readonly systemId: CodeSystemId;
  readonly deprecatedCode: string;
  readonly deprecationEffective: string;
  readonly successorCodes: readonly string[];
  readonly mappingKind: DeprecationMappingResponse["mappingKind"];
  readonly guidance: string | null;
  readonly affectedCount: number;
  /** A bounded, deterministic sample of affected record ids for drill-down. */
  readonly sampleRecordIds: readonly string[];
  /** Affected counts split by record class, for the page's per-area breakdown. */
  readonly affectedByType: Readonly<Record<string, number>>;
}

/** The full per-tenant remediation report (§7.3) — the alert summary + page model. */
export interface RemediationReport {
  /** Distinct records on a now-deprecated code (the alert's headline count). */
  readonly totalAffected: number;
  /** Distinct deprecated codes in use. */
  readonly affectedCodeCount: number;
  readonly lines: readonly RemediationLine[];
}

/** Options for {@link buildRemediationReport}. */
export interface RemediationOptions {
  /** Max sample record ids per line (default 5). The page links to the full filtered list. */
  readonly sampleSize?: number;
}

const DEFAULT_SAMPLE_SIZE = 5;

/** Map key for a (system, code) pair. */
function codeKey(systemId: CodeSystemId, code: string): string {
  return `${systemId} ${code}`;
}

/**
 * Build the §7.3 remediation report: roll a tenant's records up by the deprecated code each uses.
 * Only records whose (system, code) appears in `deprecations` contribute — active codes are not
 * remediation work. Lines are sorted by descending affected count, then code, so the page and alert
 * lead with the biggest exposure deterministically; record ids within a line keep input order and
 * are capped at `sampleSize`. No record is mutated — remediation is human-reviewed (§7.10 "no
 * automatic mutation").
 */
export function buildRemediationReport(
  records: readonly TenantCodeRecord[],
  deprecations: readonly ({ readonly systemId: CodeSystemId } & DeprecationMappingResponse)[],
  opts: RemediationOptions = {},
): RemediationReport {
  const sampleSize = opts.sampleSize ?? DEFAULT_SAMPLE_SIZE;

  const mappingByCode = new Map<string, { systemId: CodeSystemId } & DeprecationMappingResponse>();
  for (const d of deprecations) mappingByCode.set(codeKey(d.systemId, d.deprecatedCode), d);

  // Accumulate affected records per deprecated code, preserving input order for the sample.
  const acc = new Map<
    string,
    {
      mapping: { systemId: CodeSystemId } & DeprecationMappingResponse;
      recordIds: string[];
      byType: Map<string, number>;
    }
  >();

  let totalAffected = 0;
  for (const r of records) {
    const key = codeKey(r.systemId, r.code);
    const mapping = mappingByCode.get(key);
    if (mapping === undefined) continue; // active code — not remediation work
    totalAffected += 1;
    let bucket = acc.get(key);
    if (bucket === undefined) {
      bucket = { mapping, recordIds: [], byType: new Map() };
      acc.set(key, bucket);
    }
    bucket.recordIds.push(r.recordId);
    bucket.byType.set(r.recordType, (bucket.byType.get(r.recordType) ?? 0) + 1);
  }

  const lines: RemediationLine[] = [...acc.values()]
    .map(({ mapping, recordIds, byType }) => ({
      systemId: mapping.systemId,
      deprecatedCode: mapping.deprecatedCode,
      deprecationEffective: mapping.deprecationEffective,
      successorCodes: mapping.successorCodes,
      mappingKind: mapping.mappingKind,
      guidance: mapping.guidance,
      affectedCount: recordIds.length,
      sampleRecordIds: recordIds.slice(0, sampleSize),
      affectedByType: Object.fromEntries(
        [...byType.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
      ),
    }))
    .sort((a, b) =>
      a.affectedCount !== b.affectedCount
        ? b.affectedCount - a.affectedCount
        : a.deprecatedCode < b.deprecatedCode
          ? -1
          : 1,
    );

  return { totalAffected, affectedCodeCount: lines.length, lines };
}
