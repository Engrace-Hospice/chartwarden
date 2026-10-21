// apps/backend/src/modules/06-admission/election-period-completion.ts
//
// The ONE place a benefit (election) period is completed AND announced (GAP-025). Two callers share it:
//   * the discharge / revocation / transfer-out cascade (`end_election_period` effect), and
//   * the daily auto-end cron (a period whose last covered day has passed without a successor taking over).
// Both previously diverged: the cascade ran a bare UPDATE and discarded the transition's `outbox` effect, and
// nothing at all ended a period at its end date — so `m6.election.period_ended` was declared (and bound by
// M23's revalidate consumer) but never published.
import { type DbClient, schema } from "@chartwarden/db";
import { and, eq, sql } from "drizzle-orm";
import type { ElectionEndCause } from "./state-machines/effects";
import {
  type ElectionPeriodState,
  transitionElectionPeriod,
} from "./state-machines/election-period";

const EP = schema.electionPeriods;

/** The transactional-outbox publish port (structural; the composition root binds the catalog-validating one). */
export interface ElectionPeriodOutboxPort {
  publish(
    tx: DbClient,
    input: {
      readonly eventName: string;
      readonly payload: Record<string, unknown>;
      readonly organizationId: string;
      readonly aggregateKind: string;
      readonly aggregateId: string;
    },
  ): Promise<void>;
}

export interface CompletableElectionPeriod {
  readonly id: string;
  readonly admissionId: string;
  readonly sequenceNumber: number;
  readonly status: string;
}

/** The `m6.election.period_ended` payload (events-by-m6.ts schema: id, sequence, endDate, admissionId). */
export function electionPeriodEndedPayload(input: {
  readonly electionPeriodId: string;
  readonly sequence: number;
  readonly endDate: string;
  readonly admissionId: string;
}): Record<string, unknown> {
  return {
    electionPeriodId: input.electionPeriodId,
    sequence: input.sequence,
    endDate: input.endDate,
    admissionId: input.admissionId,
  };
}

/**
 * Complete one ACTIVE period on the caller's tx and publish `m6.election.period_ended` in the same unit of
 * work. Returns `false` (and publishes nothing) when the period is not active or a concurrent writer already
 * completed it — the status-guarded UPDATE is the idempotency gate, so a cron replay or a cascade racing the
 * cron can never emit a second event for the same period.
 *
 * The §2.3.2 graph accepts `complete` only from `active`: a `pending`/`signed` period never started, and
 * completing it would record an election that never ran, so those rows are left untouched.
 */
export async function completeActiveElectionPeriod(
  tx: DbClient,
  deps: { readonly outbox: ElectionPeriodOutboxPort; readonly now: () => Date },
  input: {
    readonly organizationId: string;
    readonly period: CompletableElectionPeriod;
    readonly cause: ElectionEndCause;
    /** `YYYY-MM-DD` — stamped as `actual_end_at` and carried as the event's `endDate`. */
    readonly endDate: string;
  },
): Promise<boolean> {
  const { period } = input;
  if ((period.status as ElectionPeriodState) !== "active") return false;
  transitionElectionPeriod("active", {
    type: "complete",
    cause: input.cause,
    actualEndAt: input.endDate,
  });
  const updated = await tx
    .update(EP)
    .set({
      status: "completed",
      actualEndAt: input.endDate,
      completedByCause: input.cause,
      version: sql`${EP.version} + 1`,
      updatedAt: deps.now(),
    })
    .where(and(eq(EP.id, period.id), eq(EP.status, "active")))
    .returning({ id: EP.id });
  if (updated.length === 0) return false;
  await deps.outbox.publish(tx, {
    eventName: "m6.election.period_ended",
    payload: electionPeriodEndedPayload({
      electionPeriodId: period.id,
      sequence: period.sequenceNumber,
      endDate: input.endDate,
      admissionId: period.admissionId,
    }),
    organizationId: input.organizationId,
    aggregateKind: "election_period",
    aggregateId: period.id,
  });
  return true;
}
