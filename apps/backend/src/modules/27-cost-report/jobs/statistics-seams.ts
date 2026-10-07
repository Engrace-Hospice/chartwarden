import { ImportsRepository } from "@wardenx/cost-report";
// apps/backend/src/modules/27-cost-report/jobs/statistics-seams.ts — GAP-080. The REAL Worksheet S-3 statistics
// sources (M27 spec §4.5 / D6 / D18), replacing the four fail-closed `statisticsSeams.*` thunks that made every
// `statistics-refresh` job throw `M27WorkerPortUnbound`:
//
//   Part I   monthly patient days / beneficiaries / admissions / discharges by month × level of care × program
//            ← M6's org-explicit service census + M5's payer program per patient;
//   Part III visits by discipline ← M8's org-explicit completed-visit count;
//   Part II  FTE by discipline ← M27's OWN wage import (`wage_data_import.normalized_wage_rows`, the Gusto paid hours):
//            paid hours ÷ (2,080 × the share of a year the fiscal window spans);
//   IV       bereavement census ← M16's org-explicit contact / visit counts.
//
// Every cross-module fact arrives through a locally-declared PORT bound at the composition root (the F-160 shape), so M27
// reads no M5 / M6 / M8 / M16 table. Everything persisted is AGGREGATE-ONLY (D18): the per-patient rows the M6 census
// returns are folded into counts here and never stored.
import type { DbClient } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { StatisticsSeamScope, StatisticsSeams } from "./m27-jobs";

// ── the ports (structural; the owning module's function satisfies each) ─────────────────────────────────────────────
export type ServiceCensusPort = (
  organizationId: string,
  window: { providerEntityId: string; from: string; to: string; asOf?: Date },
) => Promise<{
  days: ReadonlyArray<{
    patientId: string;
    levelOfCare: string;
    month: string;
    patientDays: number;
  }>;
  events: ReadonlyArray<{
    kind: "admission" | "discharge";
    patientId: string;
    month: string;
    levelOfCare: string;
    deathSetting?: "home" | "facility" | "unknown";
  }>;
}>;
export type PayerProgramsPort = (
  organizationId: string,
  patientIds: ReadonlyArray<string>,
  asOf: string,
) => Promise<ReadonlyMap<string, string>>;
export type VisitCountsPort = (
  organizationId: string,
  window: { providerEntityId: string; from: string; to: string },
) => Promise<Readonly<Record<string, number>>>;
export type BereavementCensusPort = (
  organizationId: string,
  window: { providerEntityId: string; from: string; to: string },
) => Promise<{ contactsCount: number; visitsCount: number; mailedContactsCount: number }>;

export interface M27StatisticsSeamDeps {
  readonly db: DbClient;
  readonly serviceCensus: ServiceCensusPort;
  readonly payerPrograms: PayerProgramsPort;
  readonly visitCounts: VisitCountsPort;
  readonly bereavementCensus: BereavementCensusPort;
  readonly now?: () => Date;
}

/** A full-time equivalent is 2,080 paid hours a year (52 weeks × 40 hours). */
export const FTE_HOURS_PER_YEAR = 2080;
const SYSTEM_USER_ID = "";

// ── pure core ───────────────────────────────────────────────────────────────────────────────────────────────────────
interface MonthlyCell {
  patientDays: number;
  uniqueBeneficiaries: number;
  admissions: number;
  discharges: number;
  deathsBySetting?: Record<string, number>;
}
type Breakdown = Record<string, Record<string, Record<string, MonthlyCell>>>;

/** Pure: fold the per-patient census rows into the aggregate month × level-of-care × program breakdown. */
export function buildMonthlyBreakdown(
  census: Awaited<ReturnType<ServiceCensusPort>>,
  programOf: (patientId: string) => string,
): Breakdown {
  const out: Breakdown = {};
  const beneficiaries = new Map<string, Set<string>>();
  const cell = (month: string, loc: string, program: string): MonthlyCell => {
    const byLoc = out[month] ?? {};
    out[month] = byLoc;
    const byProgram = byLoc[loc] ?? {};
    byLoc[loc] = byProgram;
    const existing = byProgram[program];
    if (existing) return existing;
    const fresh: MonthlyCell = {
      patientDays: 0,
      uniqueBeneficiaries: 0,
      admissions: 0,
      discharges: 0,
    };
    byProgram[program] = fresh;
    return fresh;
  };
  for (const d of census.days) {
    if (d.patientDays <= 0) continue;
    const program = programOf(d.patientId);
    const c = cell(d.month, d.levelOfCare, program);
    c.patientDays += d.patientDays;
    const key = `${d.month}|${d.levelOfCare}|${program}`;
    const set = beneficiaries.get(key) ?? new Set<string>();
    set.add(d.patientId);
    beneficiaries.set(key, set);
    c.uniqueBeneficiaries = set.size;
  }
  for (const e of census.events) {
    const c = cell(e.month, e.levelOfCare, programOf(e.patientId));
    if (e.kind === "admission") c.admissions += 1;
    else {
      c.discharges += 1;
      if (e.deathSetting) {
        c.deathsBySetting = c.deathsBySetting ?? {};
        c.deathsBySetting[e.deathSetting] = (c.deathsBySetting[e.deathSetting] ?? 0) + 1;
      }
    }
  }
  return out;
}

const DISCIPLINE_ALIASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(rn|registered[ _-]?nurse|nurse|skilled[ _-]?nursing)$/, "rn"],
  [/^(lpn|lvn|licensed[ _-]?(practical|vocational)[ _-]?nurse)$/, "lpn"],
  [/^(chha|cna|hha|aide|home[ _-]?health[ _-]?aide|nursing[ _-]?assistant)$/, "chha"],
  [/^(msw|social[ _-]?work(er)?|medical[ _-]?social[ _-]?work(er)?)$/, "msw"],
  [/^(chaplain|spiritual([ _-]?care)?|pastoral|counselor)$/, "chaplain"],
  [/^(md|physician|doctor|medical[ _-]?director)$/, "md"],
  [/^(np|nurse[ _-]?practitioner|pa)$/, "np"],
  [/^(volunteer|volunteers)$/, "volunteer"],
];

/** Pure: a payroll discipline label → the clinical discipline code the visit counts use (`other` when unknown). */
export function canonicalDiscipline(label: string): string {
  const t = label.trim().toLowerCase();
  for (const [re, code] of DISCIPLINE_ALIASES) if (re.test(t)) return code;
  return "other";
}

/** Whole days in `[from, to]` inclusive (`YYYY-MM-DD`). */
export function inclusiveDays(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`);
  return Math.max(1, Math.round(ms / 86_400_000) + 1);
}

/** Pure: paid hours by discipline → FTE by discipline over the fiscal window (2 decimals). */
export function fteFromWageRows(
  rows: ReadonlyArray<{ discipline: string; paidHours: number }>,
  fiscalDays: number,
): Record<string, number> {
  const hours = new Map<string, number>();
  for (const r of rows) {
    const code = canonicalDiscipline(r.discipline);
    hours.set(code, (hours.get(code) ?? 0) + (Number.isFinite(r.paidHours) ? r.paidHours : 0));
  }
  const annualized = FTE_HOURS_PER_YEAR * (fiscalDays / 365);
  return Object.fromEntries(
    [...hours.entries()].map(([code, h]) => [code, Math.round((h / annualized) * 100) / 100]),
  );
}

// ── the seams ───────────────────────────────────────────────────────────────────────────────────────────────────────
export function buildM27StatisticsSeams(deps: M27StatisticsSeamDeps): StatisticsSeams {
  const now = deps.now ?? (() => new Date());
  const window = (scope: StatisticsSeamScope) => ({
    providerEntityId: scope.providerEntityId,
    from: scope.fiscalYearStartDate.slice(0, 10),
    to: scope.fiscalYearEndDate.slice(0, 10),
  });

  return {
    async serviceMonthlyBreakdown(scope) {
      const w = window(scope);
      const today = now();
      const census = await deps.serviceCensus(scope.organizationId, { ...w, asOf: today });
      const patientIds = [
        ...new Set([
          ...census.days.map((d) => d.patientId),
          ...census.events.map((e) => e.patientId),
        ]),
      ];
      const asOf = [w.to, today.toISOString().slice(0, 10)].sort()[0] as string;
      const programs = await deps.payerPrograms(scope.organizationId, patientIds, asOf);
      return buildMonthlyBreakdown(census, (id) => programs.get(id) ?? "other");
    },

    async visitCountsByDiscipline(scope) {
      return { ...(await deps.visitCounts(scope.organizationId, window(scope))) };
    },

    async fteByDiscipline(scope) {
      // M27's own wage import (the Gusto pull) is the only payroll source. No completed import ⇒ no FTE can be derived:
      // an EMPTY map (the refresh flags it) — never a fabricated headcount.
      if (!scope.costReportId) return {};
      const costReportId = scope.costReportId;
      const wage = await withOrgContext(
        deps.db,
        { organizationId: scope.organizationId, userId: SYSTEM_USER_ID },
        (tx) =>
          new ImportsRepository(tx as unknown as DbClient).findLatestCompleteWageData(
            scope.organizationId,
            costReportId,
          ),
      );
      if (!wage) return {};
      const w = window(scope);
      return fteFromWageRows(wage.normalizedWageRows, inclusiveDays(w.from, w.to));
    },

    async bereavementCensus(scope) {
      return { ...(await deps.bereavementCensus(scope.organizationId, window(scope))) };
    },
  };
}
