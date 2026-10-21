// apps/backend/src/modules/38-terminology/remediation-service.ts — the §7.3 per-tenant deprecation
// remediation report, wired end to end (GAP-063).
//
// `buildRemediationReport` has existed in `packages/terminology/src/remediation/` since M38-T07 —
// tested, deterministic, and called by NOTHING. The audit's own phrasing: "the capability exists but
// is unreachable via API". This is the missing half: the two inputs and the route service that joins
// them.
//
//   right-hand input  — recent deprecations, from M38's own `deprecation_mapping` (§3.6).
//   left-hand input   — the tenant's records that USE those codes. M38 owns no patient data and
//                       `dependsOn [1,2,3,4]`, so it cannot read `problem` / `claim_line` / `order`.
//                       Producers project their own rows through a seam and M38 joins.
//
// WHAT IS ACTUALLY COVERED TODAY. §7.3 names three record classes — problem list, claim line, order.
// ONE producer is bound: M7's problem list, via `CarePlanReader.terminologyCodeUsageForOrg`. M23's
// claim lines and M11's orders are NOT contributed yet, so a code used only on a claim line does not
// appear in this report. That is stated in the response (`coveredRecordTypes`) rather than left for a
// Compliance Officer to infer from an empty section — an under-reporting compliance surface that
// looks complete is worse than one that says what it looked at.
//
// FAIL-CLOSED. An unbound or throwing producer propagates: this is a compliance report, and "you have
// no deprecated codes in use" is a materially different statement from "we could not check". The
// deny-stub throws `NotImplementedError`, so a boot that never registered M7 gets an error, not a
// reassuring empty page.
import {
  type CodeSystemId,
  type RemediationLine,
  type TenantCodeRecord,
  buildRemediationReport,
} from "@chartwarden/terminology";
import type { CarePlanCodeUsageRecord, CarePlanReader } from "@chartwarden/types";
import type { SystemDeprecation, TerminologyOpsStore } from "./ops-store";

/** Default lookback for the report — §4.2's "default last 18 months". */
export const REMEDIATION_DEFAULT_LOOKBACK_MONTHS = 18;

/** The record classes this report currently consults. See the header: two of §7.3's three are unbound. */
export const REMEDIATION_COVERED_RECORD_TYPES = ["problem_list"] as const;

/** A remediation line with the §4.2 `recommendedAction` the rollup engine does not itself decide. */
export interface RemediationResponseLine extends Omit<RemediationLine, "affectedCount"> {
  readonly affectedRecordCount: number;
  readonly recommendedAction: "update_to_successor" | "manual_review";
}

/** The report the route returns. */
export interface RemediationResponse {
  readonly since: string;
  readonly totalAffected: number;
  readonly affectedCodeCount: number;
  readonly coveredRecordTypes: readonly string[];
  readonly items: readonly RemediationResponseLine[];
  readonly nextCursor: null;
}

/** The producer surface the report reads tenant code usage from (M7's reader today). */
export interface CodeUsageProducer {
  readonly recordType: string;
  usage(
    organizationId: string,
    codes: readonly { readonly systemId: string; readonly code: string }[],
  ): Promise<readonly CarePlanCodeUsageRecord[]>;
}

/** Wrap M7's published `CarePlanReader` as the problem-list code-usage producer. */
export function carePlanCodeUsageProducer(reader: () => CarePlanReader): CodeUsageProducer {
  return {
    recordType: "problem_list",
    usage: (organizationId, codes) => reader().terminologyCodeUsageForOrg(organizationId, codes),
  };
}

/**
 * The §4.2 default `since`: today minus 18 months, as an ISO date. Injected clock so the route's tests
 * are deterministic (the engine below is already pure).
 */
export function defaultRemediationSince(now: Date): string {
  const d = new Date(now.getTime());
  d.setUTCMonth(d.getUTCMonth() - REMEDIATION_DEFAULT_LOOKBACK_MONTHS);
  return d.toISOString().slice(0, 10);
}

/**
 * §7.3's remediation guidance in one place: a deprecation that names EXACTLY ONE successor with an
 * `equivalent` relationship is a mechanical swap; anything else — several candidates, a broader or
 * narrower successor, or none at all — is a coding judgement a human must make. §7.10 forbids
 * automatic mutation either way; this only labels the work.
 */
export function recommendedActionFor(
  line: Pick<RemediationLine, "mappingKind" | "successorCodes">,
): "update_to_successor" | "manual_review" {
  return line.mappingKind === "equivalent" && line.successorCodes.length === 1
    ? "update_to_successor"
    : "manual_review";
}

/** Deps for the remediation route service. */
export interface RemediationServiceDeps {
  readonly ops: TerminologyOpsStore;
  readonly producers: readonly CodeUsageProducer[];
  /** Injected clock (defaults to the real one) so `since` is deterministic in tests. */
  readonly now?: () => Date;
}

/** Build the §7.3 report service. */
export function createRemediationService(deps: RemediationServiceDeps): {
  report(input: {
    organizationId: string;
    since?: string;
    system?: CodeSystemId;
    limit?: number;
  }): Promise<RemediationResponse>;
} {
  const now = deps.now ?? (() => new Date());

  return {
    async report({ organizationId, since, system, limit }) {
      const from = since ?? defaultRemediationSince(now());
      const deprecations: readonly SystemDeprecation[] = await deps.ops.deprecationsSince(
        from,
        system,
      );

      // No recent deprecations ⇒ nothing to remediate, and no reason to ask any producer. This is the
      // common case: the report costs one indexed read on a quiet year.
      if (deprecations.length === 0) {
        return {
          since: from,
          totalAffected: 0,
          affectedCodeCount: 0,
          coveredRecordTypes: deps.producers.map((p) => p.recordType),
          items: [],
          nextCursor: null,
        };
      }

      const codes = deprecations.map((d) => ({ systemId: d.systemId, code: d.deprecatedCode }));
      const perProducer = await Promise.all(
        deps.producers.map(async (p) => {
          const rows = await p.usage(organizationId, codes);
          // The producer labels its own rows, but pin the class here too: a producer that forgot to
          // set `recordType` would otherwise land in an unnamed bucket in `affectedByType`.
          return rows.map(
            (r): TenantCodeRecord => ({
              recordId: r.recordId,
              recordType: r.recordType || p.recordType,
              systemId: r.systemId as CodeSystemId,
              code: r.code,
            }),
          );
        }),
      );

      const report = buildRemediationReport(perProducer.flat(), deprecations);
      const items = report.lines.slice(0, limit ?? report.lines.length).map(
        (line): RemediationResponseLine => ({
          systemId: line.systemId,
          deprecatedCode: line.deprecatedCode,
          deprecationEffective: line.deprecationEffective,
          successorCodes: line.successorCodes,
          mappingKind: line.mappingKind,
          guidance: line.guidance,
          affectedRecordCount: line.affectedCount,
          sampleRecordIds: line.sampleRecordIds,
          affectedByType: line.affectedByType,
          recommendedAction: recommendedActionFor(line),
        }),
      );

      return {
        since: from,
        totalAffected: report.totalAffected,
        affectedCodeCount: report.affectedCodeCount,
        coveredRecordTypes: deps.producers.map((p) => p.recordType),
        items,
        nextCursor: null,
      };
    },
  };
}
