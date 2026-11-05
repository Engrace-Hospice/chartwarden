// apps/backend/src/modules/35-subscription/billing-runtime/census.ts — ADR-0108 D8, the claims-billing add-on census.
//
// The `m35.patient-census` sweep (every 6 hours, through the M35 org fan-out) PULLS M5's active-patient ids for each
// org that holds the add-on now or held it during the current billing window, pseudonymizes every id with the billing
// HMAC key (M35 D6: the raw id lives in this function's memory only and never reaches an M35 table or a log), and
// inserts one `patient_active_period` row per patient per period, `ON CONFLICT DO NOTHING` (a rerun is a no-op).
//
// The period key is `toBillingYearMonth(usageWindowFor(sub, at).start)`: the same window the usage aggregator uses,
// so a census row, a deceased/merged row and the monthly aggregate always agree on which period a day belongs to.
//
// `createDrizzlePatientCounterProvider` is the real `PatientCounterProvider`: distinct pseudonyms for the period under
// the NEWEST key epoch recorded for it. ponytail: after a mid-period key rotation, a patient discharged before the
// rotation exists only under the old epoch and drops out of that period's count; good enough while keys rotate
// yearly, union the epochs if rotation ever becomes frequent.
import { type DbClient, schema } from "@chartwarden/db";
import {
  type PseudonymKeyProvider,
  computeBillingPseudonym,
  toBillingYearMonth,
} from "@chartwarden/subscription-billing";
import { withOrgContext } from "@chartwarden/tenancy";
import type { PatientCensusReader, PatientCounterProvider } from "@chartwarden/types";
import { and, countDistinct, desc, eq, max } from "drizzle-orm";
import { addonIsLive, latestClaimsBillingAddon } from "../addon/entitlement";
import { usageWindowFor } from "./jobs";

const PAP = schema.patientActivePeriod;
const S = schema.subscriptionRow;

export const CENSUS_PAGE_SIZE = 500;
/** Log a reconcile metric when this sweep's count and M5's own count differ by more than this fraction. */
export const CENSUS_RECONCILE_TOLERANCE = 0.01;

type SubscriptionWindowFields = {
  readonly currentPeriodStart: Date | null;
  readonly currentPeriodEnd: Date | null;
};

/** The `patient_active_period.period_year_month` key for instant `at` (aligned with the usage aggregator). */
export function activePeriodKeyFor(sub: SubscriptionWindowFields | null, at: Date): string {
  return toBillingYearMonth(
    usageWindowFor(sub ?? { currentPeriodStart: null, currentPeriodEnd: null }, at).start,
  );
}

/** The window fields of the org's most recent subscription (null when it has none). */
export async function latestSubscriptionWindow(
  tx: DbClient,
  organizationId: string,
): Promise<(SubscriptionWindowFields & { readonly id: string }) | null> {
  const [row] = await tx
    .select({
      id: S.id,
      currentPeriodStart: S.currentPeriodStart,
      currentPeriodEnd: S.currentPeriodEnd,
    })
    .from(S)
    .where(eq(S.organizationId, organizationId))
    .orderBy(desc(S.startedAt))
    .limit(1);
  return row ?? null;
}

export interface CensusDeps {
  readonly db: DbClient;
  readonly census: PatientCensusReader;
  readonly keyProvider: PseudonymKeyProvider;
  readonly now?: () => Date;
  readonly pageSize?: number;
  readonly log?: (message: string, detail: Record<string, unknown>) => void;
}

export interface CensusResult {
  readonly counted: boolean;
  readonly periodYearMonth?: string;
  readonly seen?: number;
  readonly inserted?: number;
}

/** Census one org. Skips (counted:false) an org with no add-on, or whose add-on ended before this window. */
export async function runPatientCensusForOrg(
  deps: CensusDeps,
  organizationId: string,
): Promise<CensusResult> {
  const at = (deps.now ?? (() => new Date()))();
  const scope = await withOrgContext(deps.db, { organizationId, userId: "" }, async (scoped) => {
    const tx = scoped as unknown as DbClient;
    const addon = await latestClaimsBillingAddon(tx, organizationId);
    if (!addon) return null;
    const [sub] = await tx
      .select({ currentPeriodStart: S.currentPeriodStart, currentPeriodEnd: S.currentPeriodEnd })
      .from(S)
      .innerJoin(schema.subscriptionAddon, eq(schema.subscriptionAddon.subscriptionId, S.id))
      .where(eq(schema.subscriptionAddon.id, addon.id))
      .limit(1);
    const window = usageWindowFor(sub ?? { currentPeriodStart: null, currentPeriodEnd: null }, at);
    const endedAt = addon.endsAt ?? (addon.status === "trialing" ? addon.trialEndsAt : null);
    const inWindow = addonIsLive(addon, at) || (endedAt !== null && endedAt >= window.start);
    return inWindow ? { periodYearMonth: toBillingYearMonth(window.start) } : null;
  });
  if (!scope) return { counted: false };

  const key = await deps.keyProvider.activeKey();
  const pageSize = deps.pageSize ?? CENSUS_PAGE_SIZE;
  let after: string | null = null;
  let seen = 0;
  let inserted = 0;
  do {
    const page = await deps.census.activePatientIdsPage(organizationId, { after, limit: pageSize });
    if (page.ids.length > 0) {
      // Raw ids are hashed here and dropped; only the 32-hex pseudonym is written.
      const values = page.ids.map((id) => ({
        organizationId,
        patientPseudonym: computeBillingPseudonym(key.keyMaterial, id),
        pseudonymKeyEpoch: key.keyEpoch,
        periodYearMonth: scope.periodYearMonth,
        wasActive: true,
        becameActiveAt: at,
        computedAt: at,
      }));
      const rows = await withOrgContext(deps.db, { organizationId, userId: "" }, (tx) =>
        (tx as unknown as DbClient)
          .insert(PAP)
          .values(values)
          .onConflictDoNothing()
          .returning({ id: PAP.id }),
      );
      seen += page.ids.length;
      inserted += rows.length;
    }
    after = page.nextAfter;
  } while (after !== null);

  const m5Count = await deps.census.activePatientCount(organizationId);
  const drift = m5Count === 0 ? seen : Math.abs(m5Count - seen) / m5Count;
  if (drift > CENSUS_RECONCILE_TOLERANCE) {
    deps.log?.("m35.patient-census reconcile drift", {
      metric: "m35_patient_census_reconcile_drift",
      organizationId,
      periodYearMonth: scope.periodYearMonth,
      m35Seen: seen,
      m5Count,
    });
  }
  return { counted: true, periodYearMonth: scope.periodYearMonth, seen, inserted };
}

/** Distinct pseudonyms for one org and period key under the newest key epoch recorded for that period. */
export async function countActivePatientsForPeriod(
  tx: DbClient,
  organizationId: string,
  periodYearMonth: string,
): Promise<number> {
  const scope = and(
    eq(PAP.organizationId, organizationId),
    eq(PAP.periodYearMonth, periodYearMonth),
    eq(PAP.wasActive, true),
  );
  const [newest] = await tx
    .select({ epoch: max(PAP.pseudonymKeyEpoch) })
    .from(PAP)
    .where(scope);
  if (!newest?.epoch) return 0;
  const [row] = await tx
    .select({ n: countDistinct(PAP.patientPseudonym) })
    .from(PAP)
    .where(and(scope, eq(PAP.pseudonymKeyEpoch, newest.epoch)));
  return Number(row?.n ?? 0);
}

/** The real §4.5 `PatientCounterProvider` (tenant pool, RLS). The period is keyed by `periodStart`'s window. */
export function createDrizzlePatientCounterProvider(db: DbClient): PatientCounterProvider {
  return {
    async activePatientCountForPeriod({ organizationId, periodStart }) {
      return withOrgContext(db, { organizationId, userId: "" }, (tx) =>
        countActivePatientsForPeriod(
          tx as unknown as DbClient,
          organizationId,
          toBillingYearMonth(new Date(periodStart)),
        ),
      );
    },
  };
}

// ── ADR-0108 the monthly add-on aggregate ───────────────────────────────────────────────────────────────

const AGG = schema.usagePeriodAggregate;
export const ADDON_METER_EVENT_TYPE = "billing_addon_patient" as const;

/**
 * Write the add-on's active-patient count for the current window and finalize the window that just ended, as
 * `usage_period_aggregate` rows with event type `billing_addon_patient` (beside `runUsageAggregationForOrg`, which
 * only walks plan meters). Every counted patient is billable, so inclusive is 0 and overage is the total. A closed
 * window is final once an aggregate computed at/after its end exists. Returns the rows written.
 */
export async function aggregateAddonForOrg(
  deps: { readonly db: DbClient; readonly now?: () => Date },
  organizationId: string,
): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  return withOrgContext(deps.db, { organizationId, userId: "" }, async (scoped) => {
    const tx = scoped as unknown as DbClient;
    const addon = await latestClaimsBillingAddon(tx, organizationId);
    if (!addon) return 0;
    const [sub] = await tx
      .select({
        id: S.id,
        currentPeriodStart: S.currentPeriodStart,
        currentPeriodEnd: S.currentPeriodEnd,
      })
      .from(S)
      .innerJoin(schema.subscriptionAddon, eq(schema.subscriptionAddon.subscriptionId, S.id))
      .where(eq(schema.subscriptionAddon.id, addon.id))
      .limit(1);
    if (!sub) return 0;
    const current = usageWindowFor(sub, now);
    const previous = {
      start: new Date(current.start.getTime() - (current.end.getTime() - current.start.getTime())),
      end: current.start,
    };
    let written = 0;
    for (const [window, finalize] of [
      [previous, true],
      [current, false],
    ] as const) {
      const [existing] = await tx
        .select()
        .from(AGG)
        .where(
          and(
            eq(AGG.subscriptionId, sub.id),
            eq(AGG.eventType, ADDON_METER_EVENT_TYPE),
            eq(AGG.periodStart, window.start),
            eq(AGG.periodEnd, window.end),
          ),
        )
        .limit(1);
      if (finalize && existing && existing.computedAt >= window.end) continue;
      const total = await countActivePatientsForPeriod(
        tx,
        organizationId,
        toBillingYearMonth(window.start),
      );
      if (total === 0 && !existing) continue;
      const values = {
        organizationId,
        subscriptionId: sub.id,
        eventType: ADDON_METER_EVENT_TYPE,
        periodStart: window.start,
        periodEnd: window.end,
        totalQuantity: total,
        inclusiveQuantity: 0,
        overageQuantity: total,
        computedAt: now,
      };
      await tx
        .insert(AGG)
        .values(values)
        .onConflictDoUpdate({
          target: [AGG.subscriptionId, AGG.eventType, AGG.periodStart, AGG.periodEnd],
          set: values,
        });
      written += 1;
    }
    return written;
  });
}
