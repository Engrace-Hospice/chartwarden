// apps/backend/src/modules/27-cost-report/published-seams.ts — M27's FIRST M1 publish.
//
// M27 declared seven §4.3 seams in `@wardenx/cost-report` (registerM27PublishedSeams) but registered
// none: its seam names were not members of the M1 `SeamContracts`/`REQUIRED_SEAMS`, so M27 was a pure
// CONSUMER with an outbox-only outbound posture (`modules/27-cost-report/index.ts:9-15` says so).
//
// This file registers exactly ONE of the seven — `CostReportFilingStatusReader` — because it is the only
// one with a live consumer today: M30's CoP 418.310 compliance indicator. 42 CFR 418.310 makes failure to
// file a cost report grounds for TERMINATION, so the quality module needs the filing posture; it does not
// need the cost report's CONTENT. The other six stay declared-but-unregistered (the M24 posture: build the
// impl when a consumer exists, not before), and their M1 deny-stubs would stand if anyone reached for them.
//
// What crosses: the filing STATE + the statutory deadline + how far past it the report is. No worksheet
// figures, no wage data, no patient anything — metadata, hence phi:false in REQUIRED_SEAMS.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, desc, eq } from "drizzle-orm";
import { registerSeam } from "../../bootstrap/index";

const CR = schema.costReport;

/** CMS gives a provider five months after its fiscal-year end to file (42 CFR 413.24(f)(2)). */
const FILING_DEADLINE_MONTHS = 5;

/** The states that mean the report REACHED the MAC — anything earlier is still unfiled. */
const FILED_STATES = new Set(["submitted", "accepted", "reopened", "closed"]);

/** One provider entity's filing posture for its most recent fiscal year. */
export interface CostReportFilingStatus {
  readonly providerEntityId: string;
  readonly costReportId: string;
  readonly fiscalYearEndDate: string;
  readonly state: string;
  /** FYE + 5 months (42 CFR 413.24(f)(2)), or the granted extension when one exists. */
  readonly deadlineDate: string;
  /** True once the report has reached the MAC (submitted / accepted / reopened / closed). */
  readonly filed: boolean;
  /** True when the deadline has passed and the report is STILL not filed — the CoP 418.310 trigger. */
  readonly pastDeadlineUnfiled: boolean;
}

/** The M27 → M30 filing-posture seam contract. Opaque in the M1 registry (`unknown`); M30 casts to its
 *  own consumer view. Metadata only — no worksheet content crosses (D18). */
export interface CostReportFilingStatusReader {
  /** The most recent fiscal year's filing posture for EVERY provider entity in the org. */
  filingStatusForOrg(orgId: string): Promise<readonly CostReportFilingStatus[]>;
}

/** FYE + five months, unless the MAC granted an extension (which then governs). */
function deadlineFor(fiscalYearEndDate: string, extensionUntil: string | null): string {
  if (extensionUntil) return extensionUntil;
  const fye = new Date(`${fiscalYearEndDate}T00:00:00.000Z`);
  fye.setUTCMonth(fye.getUTCMonth() + FILING_DEADLINE_MONTHS);
  return fye.toISOString().slice(0, 10);
}

/**
 * Build the live `CostReportFilingStatusReader`. Reads the org's cost reports under `withOrgContext` (RLS
 * scopes to the caller's org via a synthetic system actor) and keeps the LATEST fiscal year per provider
 * entity — a provider with three years of history has one current filing obligation, not three.
 *
 * `nowIso` is injected so the past-deadline verdict is testable and so a single caller's reads share one
 * instant rather than racing the clock across provider entities.
 */
export function buildM27FilingStatusReader(
  db: DbClient,
  nowIso: () => string = () => new Date().toISOString(),
): CostReportFilingStatusReader {
  return {
    async filingStatusForOrg(orgId) {
      const rows = await withOrgContext(db, { organizationId: orgId, userId: "system" }, (tx) =>
        tx
          .select({
            id: CR.id,
            providerEntityId: CR.providerEntityId,
            fiscalYearEndDate: CR.fiscalYearEndDate,
            state: CR.state,
            deadlineExtensionUntilDate: CR.deadlineExtensionUntilDate,
          })
          .from(CR)
          .where(and(eq(CR.organizationId, orgId)))
          .orderBy(desc(CR.fiscalYearEndDate)),
      );

      const today = nowIso().slice(0, 10);
      const latestByProvider = new Map<string, CostReportFilingStatus>();
      for (const r of rows) {
        // Rows arrive newest-FYE-first, so the FIRST row per provider entity is its current obligation.
        if (latestByProvider.has(r.providerEntityId)) continue;
        const deadlineDate = deadlineFor(r.fiscalYearEndDate, r.deadlineExtensionUntilDate);
        const filed = FILED_STATES.has(r.state);
        latestByProvider.set(r.providerEntityId, {
          providerEntityId: r.providerEntityId,
          costReportId: r.id,
          fiscalYearEndDate: r.fiscalYearEndDate,
          state: r.state,
          deadlineDate,
          filed,
          pastDeadlineUnfiled: !filed && today > deadlineDate,
        });
      }
      return [...latestByProvider.values()];
    },
  };
}

/**
 * Register M27's published seams into the M1 registry. No-op without a db — the M1 deny-stub stands and
 * M30's compliance indicator degrades to SUPPRESSED rather than reading a fabricated filing posture.
 */
export function registerM27PublishedSeams(db: DbClient | undefined): void {
  if (!db) return;
  registerSeam("CostReportFilingStatusReader", buildM27FilingStatusReader(db));
}
