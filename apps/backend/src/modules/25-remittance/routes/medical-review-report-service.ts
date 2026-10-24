// apps/backend/src/modules/25-remittance/routes/medical-review-report-service.ts - M25 milestone 9a-2: the leadership
// medical-review report. FIGURES AND PERIOD-OVER-PERIOD CHANGE ONLY: no target, benchmark, threshold, colour rule or
// "compliant" wording, and nothing is stored (no table). The only threshold that can appear is a TPE exit threshold the
// organization itself recorded, read through the TPE service exactly as the tracker shows it. Every figure is computed live
// under `withOrgContext` (FORCE RLS) and the actor's provider-entity scope by SQL aggregates (never rows in memory), and the
// result carries no patient, claim or person field. Deadline figures are "against the due date on the case"; the count of
// due dates that came from unverified windows is returned beside them.
import type { DbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { ChartWardenError } from "@chartwarden/types";
import {
  NON_RESPONSE_MAC_REASON_CODE,
  type PeriodFigure,
  REPORT_TOP_REASONS,
  type ReportWindow,
  comparePeriods,
  rate,
  resolveReportWindow,
  topN,
  windowUnconfirmed,
} from "../domain";
import type { AppealTier } from "../domain";
import type { M25ReadActor } from "./actor";
import {
  type AdrByMac,
  type DayRange,
  type InstantRange,
  type ScopeArgs,
  adrByMac,
  adrFigures,
  appealsDecided,
  appealsFiled,
  appealsOpenByTier,
  auditFigures,
  denialClosures,
  denialReasons,
  denialTotals,
  denialsByMonth,
  reopeningsDecided,
  reopeningsOpened,
} from "./medical-review-report-queries";
import type { TpeService } from "./tpe-service";

/** Programs read for the TPE section; a tenant with more shows the first of them and says so. */
export const REPORT_TPE_PROGRAM_CAP = 200;

export interface ReasonLine {
  readonly codeKind: string;
  readonly code: string;
  readonly count: number;
  readonly dollars: number;
}

export interface MedicalReviewReport {
  readonly window: {
    readonly from: string;
    readonly to: string;
    readonly days: number;
    readonly previous: { readonly from: string; readonly to: string };
  };
  readonly generatedAt: string;
  readonly adrs: {
    readonly received: PeriodFigure;
    readonly filed: PeriodFigure;
    readonly filedOnOrBeforeDue: PeriodFigure;
    readonly filedAfterDue: PeriodFigure;
    /** filedOnOrBeforeDue / filed; null when nothing was filed. */
    readonly onOrBeforeDueShareOfFiled: PeriodFigure;
    readonly withRecordedProof: PeriodFigure;
    readonly medianDaysToFile: PeriodFigure;
    readonly deniedNoResponse: PeriodFigure;
    readonly dueDatesFromUnverifiedWindows: PeriodFigure;
    readonly byMac: readonly AdrByMac[];
  };
  readonly denials: {
    readonly opened: PeriodFigure;
    readonly openedDollars: PeriodFigure;
    /** Denials whose MAC reason field was typed as this code: a label count, shown apart from the ADR non-responses. */
    readonly macReasonAsTyped: { readonly code: string; readonly figure: PeriodFigure };
    readonly byReason: { readonly rows: readonly ReasonLine[]; readonly omitted: number };
    readonly byMonth: readonly { month: string; count: number; dollars: number }[];
    readonly closureOutcomes: readonly { outcome: string; count: number }[];
  };
  readonly appeals: {
    readonly filed: PeriodFigure;
    readonly decided: PeriodFigure;
    readonly filedByTier: readonly {
      tier: string;
      filed: number;
      filedOnOrBeforeDeadline: number;
      /** True when this tier's window is not SME-confirmed: the deadline on the case is a shipped default. */
      deadlineWindowUnconfirmed: boolean;
    }[];
    readonly decidedByOutcome: readonly { outcome: string; count: number }[];
    /** favorable / decided with an outcome, labelled as such; partial and unfavorable stay separate counts above. */
    readonly favorableShareOfDecided: number | null;
    readonly openByTier: readonly { tier: string; count: number }[];
  };
  readonly reopenings: {
    readonly opened: PeriodFigure;
    readonly decidedByOutcome: readonly { outcome: string; count: number }[];
  };
  readonly tpe: {
    readonly available: boolean;
    readonly truncated: boolean;
    readonly byState: readonly { state: string; count: number }[];
    readonly active: readonly {
      macName: string;
      currentRound: number | null;
      latestMacErrorRatePct: number | null;
      /** Only an exit threshold this organization recorded; null = none confirmed. */
      thresholdPct: number | null;
      thresholdVerified: boolean;
      aboveThreshold: boolean | null;
    }[];
  };
  readonly audits: { readonly open: number; readonly openWithNoRecordedDeadline: number };
  readonly playbookCoverage: {
    readonly reasonsSeen: number;
    readonly reasonsWithoutPlaybook: number;
    readonly withoutPlaybook: { readonly rows: readonly ReasonLine[]; readonly omitted: number };
  };
}

export interface MedicalReviewReportService {
  getReport(
    actor: M25ReadActor,
    query: { readonly from: string; readonly to: string; readonly providerEntityId?: string },
  ): Promise<MedicalReviewReport>;
}

const REFUSAL_MESSAGE = {
  INVALID_DAY: "from and to must be real calendar days (YYYY-MM-DD)",
  FROM_AFTER_TO: "from must not be after to",
  TO_IN_FUTURE: "to cannot be in the future",
  RANGE_TOO_LONG: "the window is longer than a report may cover",
} as const;

const instantOf = (w: ReportWindow, previous: boolean): InstantRange =>
  previous
    ? { startsAt: w.previousStartsAt, endsBefore: w.startsAt }
    : { startsAt: w.startsAt, endsBefore: w.endsBefore };

/** The appeal hierarchy, lowest tier first (the database enum is not stored in this order). */
const TIER_ORDER: readonly string[] = [
  "redetermination",
  "reconsideration",
  "alj",
  "council",
  "federal_court",
];
const byTier = <T extends { tier: string }>(rows: readonly T[]): T[] =>
  [...rows].sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier));

const sumBy = <T>(rows: readonly T[], pick: (r: T) => number): number =>
  rows.reduce((n, r) => n + pick(r), 0);

/** Group rows to one line per (kind, code), then rank. */
function rankReasons(
  rows: readonly { codeKind: string; code: string; count: number; dollars: number }[],
): { rows: ReasonLine[]; omitted: number } {
  const merged = new Map<string, ReasonLine>();
  for (const r of rows) {
    const key = `${r.codeKind}:${r.code}`;
    const cur = merged.get(key);
    merged.set(key, {
      codeKind: r.codeKind,
      code: r.code,
      count: (cur?.count ?? 0) + r.count,
      dollars: (cur?.dollars ?? 0) + r.dollars,
    });
  }
  const ranked = topN(
    [...merged.entries()].map(([key, v]) => ({ key, ...v })),
    REPORT_TOP_REASONS,
  );
  return {
    rows: ranked.shown.map(({ key: _key, ...line }) => line),
    omitted: ranked.omitted,
  };
}

export function buildMedicalReviewReportService(
  db: DbClient,
  deps: { readonly tpe?: Pick<TpeService, "listPrograms"> } = {},
): MedicalReviewReportService {
  return {
    async getReport(actor, query) {
      const resolved = resolveReportWindow(query, new Date());
      if (!resolved.ok) {
        throw new ChartWardenError("REPORT_WINDOW_INVALID", REFUSAL_MESSAGE[resolved.reason], 422);
      }
      const w = resolved.window;
      const s: ScopeArgs = {
        scope: actor.providerEntityScope,
        ...(query.providerEntityId ? { providerEntityId: query.providerEntityId } : {}),
      };
      const cur = instantOf(w, false);
      const prev = instantOf(w, true);
      const curDays: DayRange = { from: w.from, to: w.to };
      const prevDays: DayRange = w.previous;
      // An asked-for entity outside the actor's scope reads as nothing (providerEntityScopeCondition yields `false`).

      const body = await withOrgContext(db, actor, async (tx) => {
        const [aC, aP, byMac] = [
          await adrFigures(tx, curDays, s),
          await adrFigures(tx, prevDays, s),
          await adrByMac(tx, curDays, s),
        ];
        const [dC, dP] = [
          await denialTotals(tx, cur, NON_RESPONSE_MAC_REASON_CODE, s),
          await denialTotals(tx, prev, NON_RESPONSE_MAC_REASON_CODE, s),
        ];
        const reasons = await denialReasons(tx, cur, s);
        const months = await denialsByMonth(tx, cur, s);
        const closures = await denialClosures(tx, cur, s);
        const filedC = await appealsFiled(tx, cur, s);
        const filedP = await appealsFiled(tx, prev, s);
        const decidedC = await appealsDecided(tx, cur, s);
        const decidedP = await appealsDecided(tx, prev, s);
        const openTiers = await appealsOpenByTier(tx, s);
        const reoC = await reopeningsOpened(tx, cur, s);
        const reoP = await reopeningsOpened(tx, prev, s);
        const reoDecided = await reopeningsDecided(tx, cur, s);
        const audits = await auditFigures(tx, s);
        return {
          aC,
          aP,
          byMac,
          dC,
          dP,
          reasons,
          months,
          closures,
          filedC,
          filedP,
          decidedC,
          decidedP,
          openTiers,
          reoC,
          reoP,
          reoDecided,
          audits,
        };
      });

      const tpe = await tpeSection(deps.tpe, actor, query.providerEntityId);
      const uncovered = body.reasons.filter((r) => !r.covered);
      const seenKeys = new Set(body.reasons.map((r) => `${r.codeKind}:${r.code}`));
      const uncoveredKeys = new Set(uncovered.map((r) => `${r.codeKind}:${r.code}`));
      const decidedTotal = sumBy(body.decidedC, (r) => r.count);
      const favorable = body.decidedC.find((r) => r.outcome === "favorable")?.count ?? 0;
      const share = (c: number | null, p: number | null): PeriodFigure => comparePeriods(c, p);
      return {
        window: { from: w.from, to: w.to, days: w.days, previous: w.previous },
        generatedAt: new Date().toISOString(),
        adrs: {
          received: share(body.aC.received, body.aP.received),
          filed: share(body.aC.filed, body.aP.filed),
          filedOnOrBeforeDue: share(body.aC.filedOnOrBeforeDue, body.aP.filedOnOrBeforeDue),
          filedAfterDue: share(body.aC.filedAfterDue, body.aP.filedAfterDue),
          onOrBeforeDueShareOfFiled: share(
            rate(body.aC.filedOnOrBeforeDue, body.aC.filed),
            rate(body.aP.filedOnOrBeforeDue, body.aP.filed),
          ),
          withRecordedProof: share(body.aC.withRecordedProof, body.aP.withRecordedProof),
          medianDaysToFile: share(body.aC.medianDaysToFile, body.aP.medianDaysToFile),
          deniedNoResponse: share(body.aC.deniedNoResponse, body.aP.deniedNoResponse),
          dueDatesFromUnverifiedWindows: share(
            body.aC.dueDatesFromUnverifiedWindows,
            body.aP.dueDatesFromUnverifiedWindows,
          ),
          byMac: body.byMac,
        },
        denials: {
          opened: share(body.dC.opened, body.dP.opened),
          openedDollars: share(body.dC.dollars, body.dP.dollars),
          macReasonAsTyped: {
            code: NON_RESPONSE_MAC_REASON_CODE,
            figure: share(body.dC.macReasonAsTyped, body.dP.macReasonAsTyped),
          },
          byReason: rankReasons(body.reasons),
          byMonth: body.months,
          closureOutcomes: body.closures,
        },
        appeals: {
          filed: share(
            sumBy(body.filedC, (r) => r.filed),
            sumBy(body.filedP, (r) => r.filed),
          ),
          decided: share(
            decidedTotal,
            sumBy(body.decidedP, (r) => r.count),
          ),
          filedByTier: byTier(body.filedC).map((r) => ({
            tier: r.tier,
            filed: r.filed,
            filedOnOrBeforeDeadline: r.filedOnOrBeforeDeadline,
            deadlineWindowUnconfirmed: windowUnconfirmed(r.tier as AppealTier),
          })),
          decidedByOutcome: body.decidedC,
          favorableShareOfDecided: rate(favorable, decidedTotal),
          openByTier: byTier(body.openTiers),
        },
        reopenings: {
          opened: share(body.reoC, body.reoP),
          decidedByOutcome: body.reoDecided,
        },
        tpe,
        audits: body.audits,
        playbookCoverage: {
          reasonsSeen: seenKeys.size,
          reasonsWithoutPlaybook: uncoveredKeys.size,
          withoutPlaybook: rankReasons(uncovered),
        },
      } satisfies MedicalReviewReport;
    },
  };
}

async function tpeSection(
  tpe: Pick<TpeService, "listPrograms"> | undefined,
  actor: M25ReadActor,
  providerEntityId: string | undefined,
): Promise<MedicalReviewReport["tpe"]> {
  if (!tpe) return { available: false, truncated: false, byState: [], active: [] };
  const page = await tpe.listPrograms(actor, {}, REPORT_TPE_PROGRAM_CAP);
  const items = providerEntityId
    ? page.items.filter((p) => p.providerEntityId === providerEntityId)
    : page.items;
  const counts = new Map<string, number>();
  for (const p of items) counts.set(p.state, (counts.get(p.state) ?? 0) + 1);
  return {
    available: true,
    truncated: page.items.length >= REPORT_TPE_PROGRAM_CAP,
    byState: [...counts.entries()].sort().map(([state, count]) => ({ state, count })),
    active: items
      .filter((p) => p.state === "active")
      .map((p) => ({
        macName: p.macName,
        currentRound: p.currentRound,
        latestMacErrorRatePct: p.latestRound?.macErrorRatePct ?? null,
        thresholdPct: p.threshold.pct,
        thresholdVerified: p.threshold.verified,
        aboveThreshold: p.aboveThreshold,
      })),
  };
}
