import type { schema } from "@wardenx/db";
// @wardenx/quality — M30 §2.6 / D9 / §4.12 / §7.13 mortality-review auto-creation (P2a). PURE.
//
// Every patient death auto-creates a `mortality_review` row: M30 subscribes to `m6.discharge.death` and
// this PURE function maps the event to the row to insert + the derived completion-clock / retention /
// reminder descriptors the consumer acts on. No DB, no clock — the consumer injects nothing the event does
// not already carry. Idempotency is by `created_via_event_idempotency_key` (§2.6 — re-receiving the death
// event for the same admission is a no-op).
//
// Two §4.12 / §7.13 behaviours are encoded here as DERIVED DESCRIPTORS rather than row columns, because the
// frozen `mortality_review` schema does not carry them (architecture wins over the spec's §4.12 code, which
// predates the frozen schema):
//
//   - W-M30-27 external-source defer-completion-clock — the spec sets `completionTargetAt = NULL` for an
//     `hl7_external` death, but `mortality_review.target_completion_at` is NOT NULL in the frozen schema.
//     We therefore ALWAYS populate the column with a provisional target (satisfying NOT NULL) AND return a
//     `completionClock.deferred` descriptor so the consumer suppresses reminders / the overdue sweep until
//     the M6 `m6.discharge.cosigned` receipt re-anchors the clock. The lifecycle machine's `markOverdue`
//     guard reads `completionClockActive` (= !deferred), so a deferred review never goes overdue.
//   - W-M30-28 SUD-decedent Part 2 promotion — the actual `retention_class` set happens in a BEFORE INSERT
//     DB trigger (a migration-owned column, not a Drizzle column). We surface the PROMOTION DECISION as a
//     `retention` descriptor so the later trigger/worker phase has the pure determination to mirror.
import { WardenXError } from "@wardenx/types";

/** Default completion target — 30 days from death (D9). Tenant policy may TIGHTEN (≤ 30), never loosen. */
export const MORTALITY_DEFAULT_COMPLETION_DAYS = 30;

/** The M6 discharge `source` discriminator (M6 v0.3 D6). */
export type DischargeDeathSource = "internal_clinician_recorded" | "hl7_external";

/** External-source provenance carried on an `hl7_external` death (M6 v0.3). */
export interface ExternalDeathSource {
  readonly sourceProposalId?: string;
  readonly sourceMessageId?: string;
  readonly sourceFacilityMdmId?: string;
  readonly sourceFacilityName?: string;
  readonly ackReceivedAt?: string;
}

/** The `m6.discharge.death` event payload M30 consumes (the §4.12 shape, mapped to frozen-schema columns). */
export interface DischargeDeathEvent {
  readonly organizationId: string;
  readonly providerEntityId: string;
  /** The decedent (logical FK M5). */
  readonly deceasedPatientId: string;
  /** The admission the death closes (logical FK M6, V-16); the §2.6 idempotency anchor. */
  readonly admissionId: string;
  /** The instant of death (the partition key on `mortality_review`). */
  readonly deathAt: Date;
  /** The outbox-event id, recorded as `created_via_event_idempotency_key` (§2.6). */
  readonly eventIdempotencyKey: string;
  /** M6 v0.3 source discriminator (defaults to internal when absent on a v0.2-era event). */
  readonly source?: DischargeDeathSource;
  /** External-source provenance (present iff `source === 'hl7_external'`). */
  readonly externalSource?: ExternalDeathSource;
  /** The org-policy default mortality assignee (Medical Director or delegate); null ⇒ unassigned. */
  readonly assignedReviewerMembershipId?: string | null;
  /** W-M30-28 — the decedent's M5 `privacy_flag_snapshot.has_sud` (drives the Part 2 promotion). */
  readonly decedentHasSud?: boolean;
  /** W-M30-28 variant (c) — the chart carries an M22 document tagged `compliance_42cfr_part2`. */
  readonly hasPart2DocumentInChart?: boolean;
  /** Tenant completion-target window in days (tighten-only; defaults to {@link MORTALITY_DEFAULT_COMPLETION_DAYS}). */
  readonly completionTargetDays?: number;
}

/** The M4 retention class the row should carry (§7.13). `compliance_42cfr_part2` is the promoted class. */
export type MortalityRetentionClass = "phi" | "compliance_42cfr_part2";

/** The W-M30-28 retention determination surfaced for the BEFORE INSERT trigger to mirror. */
export interface MortalityRetentionDecision {
  readonly class: MortalityRetentionClass;
  /** True iff promoted to Part 2 (from SUD flag and/or a Part 2 document in chart). */
  readonly part2Promoted: boolean;
  /** Why promotion applied (audit/explanatory; omitted when not promoted). */
  readonly basis?: string;
}

/** The W-M30-27 completion-clock determination (drives reminder scheduling + the overdue sweep). */
export interface MortalityCompletionClock {
  /** True iff the clock is deferred (external-source death awaiting M6 cosign): no reminders, no overdue. */
  readonly deferred: boolean;
  /** The effective completion target the reminders/overdue anchor on — null while deferred. */
  readonly effectiveTargetCompletionAt: Date | null;
}

/** The full PURE result of mapping a death event to a mortality-review draft. */
export interface MortalityReviewAutoCreateResult {
  /** The schema-valid `mortality_review` insert row (`$inferInsert`). */
  readonly row: schema.NewMortalityReview;
  /** W-M30-27 — the completion-clock decision (deferred for external-source pre-cosign). */
  readonly completionClock: MortalityCompletionClock;
  /** W-M30-28 — the retention-class decision the BEFORE INSERT trigger mirrors. */
  readonly retention: MortalityRetentionDecision;
  /** The `m30.mortality_review.*` outbox events the consumer publishes on insert (§2.4 / §4.10). */
  readonly outboxEvents: ReadonlyArray<"m30.mortality_review.created">;
}

/** Add whole days to a `Date` without mutation (pure). */
function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}

/**
 * Map an `m6.discharge.death` event to the mortality-review draft to insert (PURE). Implements:
 *
 *   - the §2.2 genesis: a `pending` row with the cross-module logical FKs + the §2.6 idempotency key;
 *   - the D9 completion target = death + N days (default 30, tenant-tighten-only ≤ 30);
 *   - W-M30-27 external-source defer: for an `hl7_external` death the column carries a provisional target
 *     (NOT NULL) but `completionClock.deferred` is set so the consumer suppresses reminders/overdue until
 *     cosign;
 *   - W-M30-28 Part 2 promotion: when the decedent has a SUD flag OR a Part 2 document is in chart, the
 *     `retention` decision promotes to `compliance_42cfr_part2` (the BEFORE INSERT trigger sets the column).
 *
 * Throws a `WardenXError` (`MORTALITY_TARGET_EXCEEDS_FLOOR`, 422) if a tenant completion window exceeds the
 * 30-day platform floor (tighten-only, D15-style), or is below 1 day.
 */
export function buildMortalityReviewFromDeath(
  event: DischargeDeathEvent,
): MortalityReviewAutoCreateResult {
  const source: DischargeDeathSource = event.source ?? "internal_clinician_recorded";
  const isExternal = source === "hl7_external";

  const days = event.completionTargetDays ?? MORTALITY_DEFAULT_COMPLETION_DAYS;
  if (days > MORTALITY_DEFAULT_COMPLETION_DAYS || days < 1) {
    throw new WardenXError(
      "MORTALITY_TARGET_EXCEEDS_FLOOR",
      `mortality completion target must be between 1 and ${MORTALITY_DEFAULT_COMPLETION_DAYS} days (tenant-tighten-only)`,
      422,
    );
  }

  // The provisional target satisfies the NOT NULL column; for an external-source death it is NOT the active
  // clock — the cosign-receipt handler re-anchors it (§4.12). The active clock lives in `completionClock`.
  const provisionalTarget = addDays(event.deathAt, days);
  const completionClock: MortalityCompletionClock = isExternal
    ? { deferred: true, effectiveTargetCompletionAt: null }
    : { deferred: false, effectiveTargetCompletionAt: provisionalTarget };

  // W-M30-28 — Part 2 promotion: SUD flag (check b) OR a Part 2 document in chart (variant c).
  const part2BySud = event.decedentHasSud === true;
  const part2ByDocument = event.hasPart2DocumentInChart === true;
  const part2Promoted = part2BySud || part2ByDocument;
  const retention: MortalityRetentionDecision = part2Promoted
    ? {
        class: "compliance_42cfr_part2",
        part2Promoted: true,
        basis: part2BySud
          ? "decedent privacy_flag_snapshot.has_sud = true (42 CFR Part 2)"
          : "chart carries an M22 document tagged compliance_42cfr_part2 (42 CFR Part 2)",
      }
    : { class: "phi", part2Promoted: false };

  const row: schema.NewMortalityReview = {
    organizationId: event.organizationId,
    providerEntityId: event.providerEntityId,
    deceasedPatientId: event.deceasedPatientId,
    admissionId: event.admissionId,
    deathAt: event.deathAt,
    status: "pending",
    targetCompletionAt: provisionalTarget,
    createdViaEventIdempotencyKey: event.eventIdempotencyKey,
    ...(event.assignedReviewerMembershipId != null
      ? { assignedReviewerMembershipId: event.assignedReviewerMembershipId }
      : {}),
  };

  return { row, completionClock, retention, outboxEvents: ["m30.mortality_review.created"] };
}
