import { capYearForDate } from "@wardenx/cap-management";
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
// apps/backend/src/modules/26-cap/consumers/drizzle-store.ts — the Drizzle-backed `CapConsumerStore`
// (F-131, #248). `./handlers.ts`'s five §4.4 handlers (`handleRemittancePosted`, `handleClaimReversed`,
// `handleInpatientDay`, `handleFreeze`, `handleTransfer`) have been complete, pure and unit-tested since
// they landed — the only thing missing was this store. It was deferred behind two facts
// `cap_beneficiary_accrual` requires NOT NULL on first insert (`mbi_normalized`,
// `first_election_in_period`) and that M26 cannot resolve itself: M26's manifest `dependsOn` is
// `[1, 23, 36]` — it has no compile-time edge to M5 (patient/MBI) or M6 (admission/election) — so both
// facts are injected as typed PORTS (the `ProviderCcnPort` shape, M23's `routes/write-service.ts`),
// bound at the composition root to the real org-explicit readers:
//   - `mbiNormalizedForPatient` (apps/backend/src/modules/05-patient/seams/mbi-reader.ts)
//   - `firstElectionEffectiveDateInRangeForOrg` (apps/backend/src/modules/06-admission/seams/cap-election-context.ts)
//
// CAP-PERIOD RESOLUTION. None of `AccrualLineToRecord` / `InpatientDayToRecord` / `setProportionalWeight`
// carries a `capPeriodId` — the store resolves it itself from the event's own date (`postedAt`, or
// "today" for the date-less `setProportionalWeight`) via `capYearForDate` + a lookup by
// `(organizationId, capYear)`, deliberately IGNORING `cap_period.ccn` — the same simplification
// `seam-impls.ts`'s `accrual.aggregateForCostReport` and `getProjectionForServiceDate` already make
// ("one cap period per (org, capYear) in Phase 1 (multi-CCN sums in a follow-up)"), because
// `write-service-drizzle.ts`'s `openPeriod` itself still writes every tenant's `cap_period.ccn` as the
// literal sentinel `"000000"` pending the M40 CCN bind (§4.4 fallback) — resolving a REAL per-patient
// CCN here would never match that sentinel and would make every accrual silently unrecordable. When no
// cap_period exists for the resolved (org, capYear) — the tenant has not opened cap tracking for that
// year — every method no-ops (`recorded`/`frozen`/`updated`: false): a real, unremarkable case, not an
// error to raise or a row to fabricate.
//
// ROW CREATION. `cap_beneficiary_accrual` is one row per (org, cap_period, patient) and is created
// LAZILY, the first time any of the four methods needs it, via `ensureAccrualRow`. If the injected MBI
// or first-election port answers `null` (no MBI on file yet; no election overlapping the cap period),
// NOTHING is inserted and the caller reports `false` — a patient the store cannot yet site into a cap
// period honestly records nothing rather than a row with a fabricated join key or anchor date.
//
// IDEMPOTENCY. Both line tables (`cap_beneficiary_accrual_line`, `cap_inpatient_day_line`) carry a
// real unique index on their natural key; every line insert here uses `.onConflictDoNothing()` against
// it (§2.6 — "replaying the same remittance line is a no-op"), never a pre-read-then-insert. The
// roll-up increments (`paid_cents`, `gip_days`/`irc_days`) are gated on the LINE insert actually
// having happened (checked via `.returning()`), so a replay increments nothing twice. The roll-up
// UPDATEs themselves are single atomic `SET col = col + delta` statements — safe under concurrent
// deliveries for the same patient, never a read-then-write-back race.
import type { WriteOutboxPort } from "../routes/write-service";
import type {
  AccrualLineToRecord,
  CapConsumerStore,
  InpatientDayToRecord,
  InpatientDaysReversal,
} from "./handlers";
import { reconcileInpatientAccrual } from "./inpatient-reconcile";

const P = schema.capPeriod;
const BA = schema.capBeneficiaryAccrual;
const BAL = schema.capBeneficiaryAccrualLine;
const IA = schema.capInpatientAccrual;
const IDL = schema.capInpatientDayLine;

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

/** The seam envelope's actor id — a cross-module consumer write has no acting membership. */
const CAP_CONSUMER_SYSTEM_USER_ID = "";

/** The M5 MBI-read port (F-131) — injected because M26 cannot import M5 directly (`dependsOn` gap). */
export interface CapMbiPort {
  mbiNormalizedForPatient(organizationId: string, patientId: string): Promise<string | null>;
}

/** The M6 first-election-in-range-read port (F-131) — injected for the same reason. */
export interface CapFirstElectionPort {
  firstElectionEffectiveDateInRange(
    organizationId: string,
    patientId: string,
    rangeStart: string,
    rangeEnd: string,
  ): Promise<string | null>;
}

export interface DrizzleCapConsumerStoreDeps {
  readonly mbi: CapMbiPort;
  readonly firstElection: CapFirstElectionPort;
  /**
   * GAP-150 — the bound transactional outbox (callerModule `m26`). When present, `recordAccrualLine` emits the
   * catalogued `m26.cap.accrual_recorded` IN THE SAME TRANSACTION as the accrual line it announces. Optional so
   * a slice without an outbox (unit tests) still records; production always binds it.
   */
  readonly outbox?: WriteOutboxPort;
}

type CapPeriodRow = {
  id: string;
  startsOn: string | Date;
  endsOn: string | Date;
};

const isoDate = (d: string | Date): string =>
  (d instanceof Date ? d.toISOString() : new Date(d).toISOString()).slice(0, 10);

/** Build the real, live-Postgres `CapConsumerStore` (F-131, #248). */
export function createDrizzleCapConsumerStore(
  db: DbClient,
  deps: DrizzleCapConsumerStoreDeps,
): CapConsumerStore {
  /** Resolve the org's cap_period for the cap year containing `dateIso` (ignoring ccn — see header). */
  async function resolveCapPeriod(
    organizationId: string,
    dateIso: string,
  ): Promise<CapPeriodRow | null> {
    const capYear = capYearForDate(dateIso.slice(0, 10));
    return withOrgContext(
      db,
      { organizationId, userId: CAP_CONSUMER_SYSTEM_USER_ID },
      async (tx) => {
        const [row] = await tx
          .select({ id: P.id, startsOn: P.startsOn, endsOn: P.endsOn })
          .from(P)
          .where(and(eq(P.organizationId, organizationId), eq(P.capYear, capYear)))
          .limit(1);
        return row ?? null;
      },
    );
  }

  /**
   * Ensure `cap_beneficiary_accrual` exists for (org, period, patient); `null` when it cannot be
   * created honestly (no MBI on file, or no election overlapping the period — see header). Reads the
   * two cross-module facts OUTSIDE the write transaction (each port opens its own `withOrgContext`,
   * so nesting them inside a live `db.transaction` would open a second, independent transaction on the
   * same pool rather than participating in the first — the `admissionSchedulingContextForOrg` callers'
   * established shape), then does the actual ensure-insert inside the caller's own transaction.
   */
  async function ensureAccrualRow(
    tx: Tx,
    organizationId: string,
    period: CapPeriodRow,
    patientId: string,
  ): Promise<{ id: string } | null> {
    const [existing] = await tx
      .select({ id: BA.id })
      .from(BA)
      .where(
        and(
          eq(BA.organizationId, organizationId),
          eq(BA.capPeriodId, period.id),
          eq(BA.patientId, patientId),
        ),
      )
      .limit(1);
    if (existing) return existing;

    const [mbiNormalized, firstElectionInPeriod] = await Promise.all([
      deps.mbi.mbiNormalizedForPatient(organizationId, patientId),
      deps.firstElection.firstElectionEffectiveDateInRange(
        organizationId,
        patientId,
        isoDate(period.startsOn),
        isoDate(period.endsOn),
      ),
    ]);
    if (mbiNormalized === null || firstElectionInPeriod === null) return null;

    const inserted = await tx
      .insert(BA)
      .values({
        organizationId,
        capPeriodId: period.id,
        patientId,
        mbiNormalized,
        firstElectionInPeriod,
      })
      .onConflictDoNothing({ target: [BA.organizationId, BA.capPeriodId, BA.patientId] })
      .returning({ id: BA.id });
    if (inserted[0]) return inserted[0];
    // Lost a create race to a concurrent delivery — re-read rather than treat it as a failure.
    const [row] = await tx
      .select({ id: BA.id })
      .from(BA)
      .where(
        and(
          eq(BA.organizationId, organizationId),
          eq(BA.capPeriodId, period.id),
          eq(BA.patientId, patientId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  return {
    async recordAccrualLine(line: AccrualLineToRecord) {
      const period = await resolveCapPeriod(line.organizationId, line.postedAt);
      if (!period) return { recorded: false };
      return withOrgContext(
        db,
        { organizationId: line.organizationId, userId: CAP_CONSUMER_SYSTEM_USER_ID },
        async (tx) => {
          const accrual = await ensureAccrualRow(tx, line.organizationId, period, line.patientId);
          if (!accrual) return { recorded: false };
          const insertedLine = await tx
            .insert(BAL)
            .values({
              organizationId: line.organizationId,
              capPeriodId: period.id,
              patientId: line.patientId,
              sourceKind: line.sourceKind,
              sourceId: line.sourceId,
              amountCents: line.amountCents,
              serviceFrom: line.serviceFrom,
              serviceTo: line.serviceTo,
              postedAt: new Date(line.postedAt),
            })
            .onConflictDoNothing()
            .returning({ id: BAL.id });
          if (!insertedLine[0]) return { recorded: false }; // replay — already recorded
          await tx
            .update(BA)
            .set({
              paidCents: sql`${BA.paidCents} + ${line.amountCents}`,
              lastUpdatedAt: new Date(),
            })
            .where(eq(BA.id, accrual.id));
          // GAP-150 — announced only when the line was ACTUALLY inserted (a replay returned above), so the
          // event is exactly-once per accrual line and commits atomically with it.
          await deps.outbox?.publish(tx, {
            eventName: "m26.cap.accrual_recorded",
            organizationId: line.organizationId,
            aggregateKind: "cap_beneficiary_accrual_line",
            aggregateId: insertedLine[0].id,
            payload: {
              organizationId: line.organizationId,
              capPeriodId: period.id,
              patientId: line.patientId,
              accrualLineId: insertedLine[0].id,
              paidAmountCents: line.amountCents,
              postingDate: new Date(line.postedAt).toISOString(),
            },
          });
          return { recorded: true };
        },
      );
    },

    async recordInpatientDay(day: InpatientDayToRecord) {
      const period = await resolveCapPeriod(day.organizationId, day.postedAt);
      if (!period) return { recorded: false };
      return withOrgContext(
        db,
        { organizationId: day.organizationId, userId: CAP_CONSUMER_SYSTEM_USER_ID },
        async (tx) => {
          // GAP-038 - the ledger insert carries the claim identity.
          const [line] = await tx
            .insert(IDL)
            .values({
              organizationId: day.organizationId,
              capPeriodId: period.id,
              claimId: day.claimId,
              patientId: day.patientId,
              sourceId: day.sourceId,
              revCode: day.revCode,
              days: day.days,
              serviceFrom: day.serviceFrom,
              serviceTo: day.serviceTo,
              postedAt: new Date(day.postedAt),
            })
            .onConflictDoNothing()
            .returning({ id: IDL.id });
          if (!line) {
            // A replay, a re-delivery, or a re-pay after a recoup: only the two annotation columns may move,
            // NEVER the days.
            //   claim_id     stamped on a row written before the column existed (COALESCE: first identity wins);
            //   reversed_at  cleared when this delivery was posted AFTER the reversal (a claim re-paid after a
            //                recoup reuses the same claim_line ids); a stale re-delivery posted BEFORE the
            //                reversal leaves it set.
            await tx
              .update(IDL)
              .set({
                claimId: sql`coalesce(${IDL.claimId}, ${day.claimId}::uuid)`,
                reversedAt: sql`CASE WHEN ${IDL.reversedAt} IS NOT NULL AND ${day.postedAt}::timestamptz > ${IDL.reversedAt} THEN NULL ELSE ${IDL.reversedAt} END`,
              })
              .where(
                and(
                  eq(IDL.organizationId, day.organizationId),
                  eq(IDL.capPeriodId, period.id),
                  eq(IDL.sourceKind, "claim_line"),
                  eq(IDL.sourceId, day.sourceId),
                  eq(IDL.revCode, day.revCode),
                ),
              );
            // The ledger may have just been re-stamped / un-reversed, and a pre-fix row's roll-up may be
            // stale (total_patient_days = 0): rebuild it from the ledger in this same transaction.
            await reconcileInpatientAccrual(tx, day.organizationId, period.id);
            return { recorded: false };
          }
          // rev_code '0655' = IRC, '0656' = GIP (packages/db/src/schema/cap/accrual.ts's own comment).
          const gipDelta = day.revCode === "0656" ? day.days : 0;
          const ircDelta = day.revCode === "0655" ? day.days : 0;
          // One atomic upsert (never a read-then-branch INSERT-or-UPDATE pair): two concurrent
          // deliveries for the same (org, period) racing an UPDATE-if-exists-else-INSERT would let one
          // lose its delta entirely on an ON CONFLICT DO NOTHING insert. ON CONFLICT DO UPDATE folds
          // the delta into the existing row (or seeds it, on first insert) under one row lock.
          // GAP-038 - every level-of-care day (RHC/CHC/IRC/GIP) is the cap's denominator, so
          // total_patient_days grows by the same replay-safe line (the unique key above gates it).
          await tx
            .insert(IA)
            .values({
              organizationId: day.organizationId,
              capPeriodId: period.id,
              gipDays: gipDelta,
              ircDays: ircDelta,
              totalPatientDays: day.days,
            })
            .onConflictDoUpdate({
              target: [IA.organizationId, IA.capPeriodId],
              set: {
                gipDays: sql`${IA.gipDays} + ${gipDelta}`,
                ircDays: sql`${IA.ircDays} + ${ircDelta}`,
                totalPatientDays: sql`${IA.totalPatientDays} + ${day.days}`,
                lastUpdatedAt: new Date(),
              },
            });
          return { recorded: true };
        },
      );
    },

    async reverseInpatientDays(reversal: InpatientDaysReversal) {
      return withOrgContext(
        db,
        { organizationId: reversal.organizationId, userId: CAP_CONSUMER_SYSTEM_USER_ID },
        async (tx) => {
          const reversedAt = reversal.reversedAt ? new Date(reversal.reversedAt) : new Date();
          const hit = await tx
            .update(IDL)
            .set({
              reversedAt,
              claimId: sql`coalesce(${IDL.claimId}, ${reversal.claimId}::uuid)`,
            })
            .where(
              and(
                eq(IDL.organizationId, reversal.organizationId),
                sql`${IDL.reversedAt} IS NULL`,
                or(
                  eq(IDL.claimId, reversal.claimId),
                  // A pre-identity row: no claim id yet, matched by its claim_line id.
                  reversal.claimLineIds && reversal.claimLineIds.length > 0
                    ? and(isNull(IDL.claimId), inArray(IDL.sourceId, [...reversal.claimLineIds]))
                    : undefined,
                ),
              ),
            )
            .returning({ periodId: IDL.capPeriodId });
          // The roll-up is a cache of the ledger: rebuild every period the claim's days touched, same tx.
          const periodIds = [...new Set(hit.map((r) => r.periodId))];
          for (const periodId of periodIds) {
            await reconcileInpatientAccrual(tx, reversal.organizationId, periodId);
          }
          return { reversed: hit.length };
        },
      );
    },

    async freezePatient(organizationId: string, patientId: string, frozenAt: string) {
      const period = await resolveCapPeriod(organizationId, frozenAt);
      if (!period) return { frozen: false };
      return withOrgContext(
        db,
        { organizationId, userId: CAP_CONSUMER_SYSTEM_USER_ID },
        async (tx) => {
          const accrual = await ensureAccrualRow(tx, organizationId, period, patientId);
          if (!accrual) return { frozen: false };
          const updated = await tx
            .update(BA)
            .set({ deceasedAt: frozenAt.slice(0, 10), lastUpdatedAt: new Date() })
            .where(and(eq(BA.id, accrual.id), sql`${BA.deceasedAt} IS NULL`)) // idempotent: first freeze wins
            .returning({ id: BA.id });
          return { frozen: updated.length > 0 };
        },
      );
    },

    async setProportionalWeight(organizationId: string, patientId: string, weight: number) {
      // `handleTransfer`'s payload carries no date — anchor on "today" (the transfer event is
      // processed close to real time; a late-arriving/backfilled transfer near a cap-year boundary
      // could resolve to the wrong year, a documented limit rather than a silent one).
      const today = new Date().toISOString().slice(0, 10);
      const period = await resolveCapPeriod(organizationId, today);
      if (!period) return { updated: false };
      return withOrgContext(
        db,
        { organizationId, userId: CAP_CONSUMER_SYSTEM_USER_ID },
        async (tx) => {
          const accrual = await ensureAccrualRow(tx, organizationId, period, patientId);
          if (!accrual) return { updated: false };
          await tx
            .update(BA)
            .set({ methodologyWeight: weight.toFixed(6), lastUpdatedAt: new Date() })
            .where(eq(BA.id, accrual.id));
          return { updated: true };
        },
      );
    },
  };
}
