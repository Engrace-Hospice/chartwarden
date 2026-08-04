// @wardenx/subscription-billing — §D5/D6 usage-metering + active-period service (pure over ports, M35-T03).
//
// Two pipelines, both PHI-free by construction:
//
//  1. USAGE EVENTS (D5) — the append-only `usage_event` ledger. `ingest` validates `quantity > 0`
//     (`isValidUsageQuantity`) and dedups on `(organizationId, sourceModule, sourceEventId)` (§2.6 ingest
//     idempotency) so an M28/M32 re-delivery is a no-op. `computeMeterAggregate` rolls a period's events
//     into the `usage_period_aggregate` total + overage, and `buildUsageCloseOutbox` maps the 80%/100%
//     threshold crossings onto the §2.4 outbox.
//
//  2. ACTIVE PERIODS (D6) — the pseudonymized `patient_active_period` / `user_active_period` counters.
//     `recordPatientActive` / `recordUserActive` compute `HMAC-SHA256(active_key, subjectId)` INSIDE this
//     boundary (`computeBillingPseudonym`) and upsert idempotently on `(org, pseudonym, periodYearMonth)`.
//     The raw `patient_id` / `membership_id` is passed to the hasher and discarded — it never reaches the
//     store, and the §2.3 CHECK would reject it anyway.
//
// PURE: the store owns the partitioned insert + the RLS session; the key provider owns the KMS decrypt;
// T06 supplies both and publishes the returned {@link OutboxIntent}s.

import type { IsoInstant, OrgId, UsageEventType } from "@wardenx/types";
import { isValidUsageQuantity } from "../domain/validation";
import { computeBillingPseudonym } from "../pseudonym/hasher";
import {
  type ActivePeriodStore,
  type OutboxIntent,
  type PseudonymKeyProvider,
  type UsageEventInput,
  type UsageEventStore,
  outboxIntent,
} from "./ports";

/** `YYYY-MM` (UTC) bucket key for a Date — the active-period + revenue-snapshot calendar key. */
export function toBillingYearMonth(date: Date): string {
  const y = date.getUTCFullYear().toString().padStart(4, "0");
  const m = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  return `${y}-${m}`;
}

export interface IngestResult {
  readonly accepted: boolean;
  readonly deduped: boolean;
  readonly reason?: string;
}

export class UsageMeteringService {
  constructor(
    private readonly usageStore: UsageEventStore,
    private readonly activePeriodStore: ActivePeriodStore,
    private readonly keyProvider: PseudonymKeyProvider,
  ) {}

  /** §D5 ingest one usage event (idempotent on `(org, sourceModule, sourceEventId)` when the id is given). */
  async ingest(input: UsageEventInput, now: Date): Promise<IngestResult> {
    if (!isValidUsageQuantity(input.quantity)) {
      return { accepted: false, deduped: false, reason: "quantity must be a positive integer" };
    }
    if (input.sourceEventId) {
      const exists = await this.usageStore.usageEventExists({
        organizationId: input.organizationId,
        sourceModule: input.sourceModule,
        sourceEventId: input.sourceEventId,
      });
      if (exists) return { accepted: false, deduped: true };
    }
    await this.usageStore.insertUsageEvent({
      organizationId: input.organizationId,
      eventType: input.eventType,
      quantity: input.quantity,
      sourceModule: input.sourceModule,
      sourceEventId: input.sourceEventId ?? null,
      recordedAt: input.recordedAt ? new Date(input.recordedAt) : now,
    });
    return { accepted: true, deduped: false };
  }

  /** §D5 batch ingest — each event runs the single-event path; the counts feed the seam's batch DTO. */
  async ingestBatch(
    events: readonly UsageEventInput[],
    now: Date,
  ): Promise<{
    acceptedCount: number;
    dedupedCount: number;
    rejectedCount: number;
    rejections: { sourceEventId: string | null; eventType: UsageEventType; reason: string }[];
  }> {
    let acceptedCount = 0;
    let dedupedCount = 0;
    const rejections: {
      sourceEventId: string | null;
      eventType: UsageEventType;
      reason: string;
    }[] = [];
    for (const ev of events) {
      const r = await this.ingest(ev, now);
      if (r.accepted) acceptedCount += 1;
      else if (r.deduped) dedupedCount += 1;
      else
        rejections.push({
          sourceEventId: ev.sourceEventId ?? null,
          eventType: ev.eventType,
          reason: r.reason ?? "rejected",
        });
    }
    return { acceptedCount, dedupedCount, rejectedCount: rejections.length, rejections };
  }

  /** §D6 W-SB-08 — pseudonymize a raw `patient_id` and upsert its active-period row (idempotent). */
  async recordPatientActive(input: {
    organizationId: OrgId;
    rawPatientId: string;
    now: Date;
  }): Promise<{ inserted: boolean; pseudonymKeyEpoch: string }> {
    const key = await this.keyProvider.activeKey();
    const patientPseudonym = computeBillingPseudonym(key.keyMaterial, input.rawPatientId);
    const { inserted } = await this.activePeriodStore.upsertPatientActivePeriod({
      organizationId: input.organizationId,
      patientPseudonym,
      pseudonymKeyEpoch: key.keyEpoch,
      periodYearMonth: toBillingYearMonth(input.now),
      becameActiveAt: input.now,
    });
    return { inserted, pseudonymKeyEpoch: key.keyEpoch };
  }

  /** §D6 — pseudonymize a raw `membership_id` and upsert its active-period row (idempotent). */
  async recordUserActive(input: {
    organizationId: OrgId;
    rawMembershipId: string;
    now: Date;
  }): Promise<{ inserted: boolean; pseudonymKeyEpoch: string }> {
    const key = await this.keyProvider.activeKey();
    const membershipPseudonym = computeBillingPseudonym(key.keyMaterial, input.rawMembershipId);
    const { inserted } = await this.activePeriodStore.upsertUserActivePeriod({
      organizationId: input.organizationId,
      membershipPseudonym,
      pseudonymKeyEpoch: key.keyEpoch,
      periodYearMonth: toBillingYearMonth(input.now),
      becameActiveAt: input.now,
    });
    return { inserted, pseudonymKeyEpoch: key.keyEpoch };
  }
}

// ── §D5 pure aggregate + overage math (no float; integer cents — §2.3) ─────────────────────────────────

export interface MeterAggregate {
  readonly totalQuantity: number;
  readonly inclusiveQuantity: number;
  readonly overageQuantity: number;
  readonly overageCents: number;
  /** Percent of the inclusive quantity consumed, floored to an integer (0 when inclusive is 0/unbounded). */
  readonly pctOfInclusive: number;
  readonly crossed80: boolean;
  readonly crossed100: boolean;
}

/**
 * §D5 roll a meter's period total into its overage. `overageQuantity = max(0, total - inclusive)`;
 * `overageCents = overageQuantity * overageUnitPriceCents` (integer — no float). The 80%/100% crossings
 * drive `m35.usage.overage_threshold_warning` / `…_breached`. A meter with `inclusiveQuantity = 0` is
 * treated as pure-overage (every unit bills; no percentage warning fires).
 */
export function computeMeterAggregate(input: {
  totalQuantity: number;
  inclusiveQuantity: number;
  overageUnitPriceCents: number;
}): MeterAggregate {
  const total = Math.max(0, Math.trunc(input.totalQuantity));
  const inclusive = Math.max(0, Math.trunc(input.inclusiveQuantity));
  const overageQuantity = Math.max(0, total - inclusive);
  const overageCents = overageQuantity * Math.max(0, Math.trunc(input.overageUnitPriceCents));
  const pctOfInclusive = inclusive > 0 ? Math.floor((total * 100) / inclusive) : 0;
  return {
    totalQuantity: total,
    inclusiveQuantity: inclusive,
    overageQuantity,
    overageCents,
    pctOfInclusive,
    crossed80: inclusive > 0 && pctOfInclusive >= 80,
    crossed100: inclusive > 0 && total >= inclusive,
  };
}

/** §2.4 build the period-close + overage outbox for one meter's aggregate (pure; the aggregator reuses it). */
export function buildUsageOverageOutbox(input: {
  subscriptionId: string;
  organizationId: OrgId;
  eventType: UsageEventType;
  aggregate: MeterAggregate;
}): OutboxIntent[] {
  const { subscriptionId, organizationId, eventType, aggregate } = input;
  const out: OutboxIntent[] = [];
  if (aggregate.crossed100) {
    out.push(
      outboxIntent("m35.usage.overage_threshold_breached", {
        subscriptionId,
        organizationId,
        eventType,
        totalQuantity: aggregate.totalQuantity,
        inclusiveQuantity: aggregate.inclusiveQuantity,
      }),
    );
  } else if (aggregate.crossed80) {
    out.push(
      outboxIntent("m35.usage.overage_threshold_warning", {
        subscriptionId,
        organizationId,
        eventType,
        totalQuantity: aggregate.totalQuantity,
        inclusiveQuantity: aggregate.inclusiveQuantity,
        projectedOverageCents: aggregate.overageCents,
      }),
    );
  }
  return out;
}

/** §2.4 the `m35.usage.period_closed` emit (on close, not on every aggregate update). */
export function buildUsagePeriodClosedOutbox(input: {
  subscriptionId: string;
  organizationId: OrgId;
  periodStart: Date;
  periodEnd: Date;
  meterTotals: ReadonlyArray<{ eventType: UsageEventType; totalQuantity: number }>;
}): OutboxIntent {
  return outboxIntent("m35.usage.period_closed", {
    subscriptionId: input.subscriptionId,
    organizationId: input.organizationId,
    periodStart: input.periodStart.toISOString() as IsoInstant,
    periodEnd: input.periodEnd.toISOString() as IsoInstant,
    meterTotals: input.meterTotals.map((m) => ({
      eventType: m.eventType,
      totalQuantity: m.totalQuantity,
    })),
  });
}
