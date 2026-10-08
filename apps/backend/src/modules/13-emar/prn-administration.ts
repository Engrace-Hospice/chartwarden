// apps/backend/src/modules/13-emar/prn-administration.ts -- GAP-021/022: the PRN write path.
//
// A PRN administration is a `single_dose` administration_record plus a 1:1 `prn_administration` wrapper
// (§2.4 D3). Two things used to be missing from the production write path:
//   GAP-021 -- the §2.4 D3 minimum-interval gate (`assertPrnInterval`) had no caller, so a PRN dose given
//              inside the order's minimum interval was recorded without complaint;
//   GAP-022 -- nothing ever INSERTed the wrapper row. The event carried a random uuid with no row behind it,
//              so the reassessment-overdue cron and M30's `prn_effectiveness_documented_rate` read a table
//              that was empty in production (their live tests seeded it by raw SQL, which is why they were
//              green).
// `planPrn` runs BEFORE the administration row is inserted (a violation must leave nothing behind);
// `insertPrn` runs in the SAME transaction right after it, so the wrapper and the administration commit or
// roll back together and the emitted event names a row that exists.
import { type DbClient, schema } from "@wardenx/db";
import {
  type PrnIntervalOverride,
  assertPrnInterval,
  resolveReassessmentWindowMinutes,
} from "@wardenx/emar";
import { and, desc, eq, ne, sql } from "drizzle-orm";

const ADM = schema.administrationRecords;
const PRN = schema.prnAdministrations;
const POL = schema.administrationPolicy;

/** The reassessment scale recommended when nothing about the drug's clinical category is known (M9 owns scoring). */
export const DEFAULT_PRN_REASSESSMENT_SCALE = "esas_r";

/** What the route / caller supplies about the PRN dose. */
export interface PrnRequest {
  readonly triggeringPrnReason: string;
  readonly requestedByKind: string;
  /** Supervisor override of the minimum interval: the permission fact is resolved by the ROUTE, not the body. */
  readonly intervalOverride?: { readonly hasPermission: boolean; readonly reason: string };
}

export interface PrnPlan {
  readonly prnAdministrationId: string;
  readonly reassessmentWindowMinutes: number;
  readonly reassessmentDueAt: Date;
  readonly recommendedReassessmentScale: string;
  readonly overridden: boolean;
  readonly overrideReason: string | null;
}

const INACTIVE_ADMINISTRATION_STATUSES = ["voided", "superseded"] as const;

/** The administered-at of the most recent live (not voided / superseded / refused) PRN dose of this order. */
async function lastPrnAdministeredAt(
  tx: DbClient,
  medicationOrderId: string,
  patientId: string,
): Promise<string | null> {
  const [last] = await tx
    .select({ at: ADM.administeredAt })
    .from(PRN)
    .innerJoin(ADM, eq(ADM.id, PRN.administrationRecordId))
    .where(
      and(
        eq(PRN.medicationOrderId, medicationOrderId),
        eq(PRN.patientId, patientId),
        eq(ADM.refused, false),
        ne(ADM.status, INACTIVE_ADMINISTRATION_STATUSES[0]),
        ne(ADM.status, INACTIVE_ADMINISTRATION_STATUSES[1]),
      ),
    )
    .orderBy(desc(ADM.administeredAt))
    .limit(1);
  return last ? last.at.toISOString() : null;
}

/**
 * §2.4 D3 -- enforce the minimum interval and resolve the reassessment trigger for a PRN dose.
 * Throws `PRN_INTERVAL_VIOLATION` (422) inside the window unless a valid supervisor override rides along.
 */
export async function planPrn(
  tx: DbClient,
  args: {
    readonly medicationOrderId: string;
    readonly patientId: string;
    readonly administeredAt: string;
    readonly minimumIntervalMinutes: number | null;
    readonly prn: PrnRequest;
  },
): Promise<PrnPlan> {
  // Serialise concurrent PRN doses of one order so two simultaneous requests cannot both read the same
  // "last dose" and both pass the interval. Released with the transaction.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`prn:${args.medicationOrderId}`}))`);
  const last = await lastPrnAdministeredAt(tx, args.medicationOrderId, args.patientId);
  const override: PrnIntervalOverride | undefined = args.prn.intervalOverride
    ? {
        hasOverridePermission: args.prn.intervalOverride.hasPermission,
        reason: args.prn.intervalOverride.reason,
      }
    : undefined;
  const verdict = assertPrnInterval(
    {
      minimumIntervalMinutes: args.minimumIntervalMinutes,
      lastAdministeredAt: last,
      requestedAdministeredAt: args.administeredAt,
    },
    override,
  );

  const [policy] = await tx
    .select({ window: POL.defaultPrnReassessmentWindowMinutes })
    .from(POL)
    .limit(1);
  const windowMinutes = resolveReassessmentWindowMinutes({
    tenantDefaultMinutes: policy?.window ?? null,
    category: "other",
  });
  return {
    prnAdministrationId: crypto.randomUUID(),
    reassessmentWindowMinutes: windowMinutes,
    reassessmentDueAt: new Date(Date.parse(args.administeredAt) + windowMinutes * 60_000),
    recommendedReassessmentScale: DEFAULT_PRN_REASSESSMENT_SCALE,
    overridden: verdict.overridden,
    overrideReason: verdict.overridden ? (override?.reason.trim() ?? null) : null,
  };
}

/** Insert the 1:1 `prn_administration` wrapper on the caller's tx (the row the cron + M30 read). */
export async function insertPrn(
  tx: DbClient,
  args: {
    readonly organizationId: string;
    readonly administrationRecordId: string;
    readonly providerEntityId: string | null;
    readonly locationId: string | null;
    readonly patientId: string;
    readonly admissionId: string;
    readonly medicationOrderId: string;
    readonly actorMembershipId: string;
    readonly prn: PrnRequest;
    readonly plan: PrnPlan;
  },
): Promise<void> {
  await tx.insert(PRN).values({
    id: args.plan.prnAdministrationId,
    organizationId: args.organizationId,
    // Siting is copied from the scheduled dose when there is one; an ad-hoc PRN dose has none (mig 0640).
    providerEntityId: args.providerEntityId,
    locationId: args.locationId,
    administrationRecordId: args.administrationRecordId,
    patientId: args.patientId,
    admissionId: args.admissionId,
    medicationOrderId: args.medicationOrderId,
    triggeringPrnReason: args.prn.triggeringPrnReason,
    requestedByKind: args.prn.requestedByKind as never,
    reassessmentWindowMinutes: args.plan.reassessmentWindowMinutes,
    reassessmentDueAt: args.plan.reassessmentDueAt,
    recommendedReassessmentScale: args.plan.recommendedReassessmentScale,
    prnIntervalOverride: args.plan.overridden,
    prnIntervalOverrideReason: args.plan.overrideReason,
    prnIntervalOverrideBy: args.plan.overridden ? args.actorMembershipId : null,
  });
}
