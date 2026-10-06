// apps/backend/src/modules/15-discipline-care-plans/volunteer/hours.ts — M15-T04 (§2.2.7 / §7.6).
//
// The 42 CFR §418.78(e) 5% volunteer-time ledger: the append-only `volunteer_hour_entry` rows, the
// materialized `volunteer_hour_ledger` per (provider entity × fiscal year), and the ratio the M33/M30
// dashboards badge.
//
// The one rule this file exists to keep honest (M15-F04 / §7.6): **the ratio is hours ÷ hours, and the
// DENOMINATOR is not M15's.** Total patient-care hours of paid + contract staff are M27's cost basis,
// read at request time. Until that bind is live `computeVolunteerHourRatio` returns `ratio: null` with
// status `unavailable` and a stated reason — never a 0, which the dashboard would render as a CoP breach
// the agency does not actually have, and never a fabricated denominator.
//
// The second honesty rule is in `aggregateVolunteerHours`: a candidate volunteer visit whose duration
// could not be resolved is COUNTED AS UNRESOLVED, not as zero. A silently-dropped visit understates the
// numerator, which is the direction that produces a false CoP failure.
//
// PURE — entries, durations and `now` are injected; the Drizzle reads + the cron land in M15-T06.
import {
  VOLUNTEER_RATIO_POLICY,
  fiscalYearFor,
  volunteerRatioStatus,
} from "@wardenx/discipline-plans";
import type {
  EncounterId,
  FiscalYear,
  IsoInstant,
  MembershipId,
  ProviderEntityId,
  VolunteerHourEntrySource,
  VolunteerHourRatio,
} from "@wardenx/types";
import type { DisciplinePlanSideEffect } from "../lifecycle/effects";
import { require_ } from "../lifecycle/errors";

/** A `volunteer_hour_entry` row as the aggregator sees it (§2.2.7). */
export interface VolunteerHourEntryFacts {
  readonly volunteerMembershipId: MembershipId;
  readonly source: VolunteerHourEntrySource;
  readonly durationMinutes: number;
  readonly occurredAt: IsoInstant;
  readonly sourceEncounterId: EncounterId | null;
  readonly adjustmentReason: string | null;
  readonly adjustedByMembershipId: MembershipId | null;
}

/**
 * §2.2.7 / M15-F04 — validate a `volunteer_hour_entry` INSERT (route 24 and the nightly aggregator use
 * the same guard). Mirrors the two DB CHECKs at the service level so the caller gets a typed §4.2 code
 * rather than a 23514: a `manual_adjustment` must carry BOTH a reason and the adjusting membership (it is
 * the audited correction path), an `encounter`-sourced entry must name its M8 encounter, and no entry may
 * be zero-minute — a zero row is noise that makes the ledger's provenance harder to read, not safer.
 */
export function checkVolunteerHourEntry(entry: VolunteerHourEntryFacts): void {
  require_(
    Number.isInteger(entry.durationMinutes) && entry.durationMinutes !== 0,
    "HOUR_ENTRY_DURATION_INVALID",
    "a volunteer hour entry's durationMinutes must be a non-zero whole number of minutes",
  );
  if (entry.source === "manual_adjustment") {
    require_(
      (entry.adjustmentReason ?? "").trim().length > 0 && entry.adjustedByMembershipId !== null,
      "HOUR_ADJUSTMENT_REASON_REQUIRED",
      "a manual hour adjustment requires an adjustment reason and the adjusting membership",
    );
  } else {
    require_(
      entry.durationMinutes > 0,
      "HOUR_ENTRY_DURATION_INVALID",
      "only an audited manual_adjustment may carry negative minutes",
    );
  }
  if (entry.source === "encounter") {
    require_(
      entry.sourceEncounterId !== null,
      "HOUR_ENTRY_SOURCE_MISMATCH",
      "an encounter-sourced hour entry must reference its M8 encounter",
    );
  }
}

/** A signed `volunteer_visit` the aggregator is offered for one nightly run (§7.4 / §7.6). */
export interface VolunteerVisitCandidate {
  readonly encounterId: EncounterId;
  readonly volunteerMembershipId: MembershipId;
  readonly occurredAt: IsoInstant;
  /**
   * The visit's duration, or `null` when it could not be resolved. M8's `SignedEncounterDigest` carries
   * no duration (see `../consumers/volunteer-visits`), so this arrives from the visit bracket the caller
   * resolved. A null is REPORTED, never silently treated as zero.
   */
  readonly durationMinutes: number | null;
}

/** The result of one nightly aggregator pass over a (provider entity × fiscal year) bucket (§2.2.7). */
export interface VolunteerHourAggregate {
  readonly providerEntityId: ProviderEntityId;
  readonly fiscalYear: FiscalYear;
  readonly totalVolunteerHourMinutes: number;
  readonly asOfAt: IsoInstant;
  /** New `volunteer_hour_entry` rows the pass creates from unledgered visits. */
  readonly newEntries: ReadonlyArray<VolunteerHourEntryFacts>;
  /** Candidates skipped because their duration was unresolvable — surfaced, never swallowed. */
  readonly unresolvedDurationEncounterIds: ReadonlyArray<EncounterId>;
  readonly effects: ReadonlyArray<DisciplinePlanSideEffect>;
}

/**
 * §2.2.7 / §7.6 — one aggregator pass. `existingEntries` are the ledger's current rows (the pass is
 * idempotent on `(providerEntityId, fiscalYear, aggDate)` per §4.6: a visit already ledgered by
 * `source_encounter_id` is never counted twice), `candidates` are the signed volunteer visits resolved
 * through M8 for the window, and `fiscalYearStartMonth` is the agency's FY opening month.
 *
 * Candidates that fall outside the bucket's fiscal year are ignored here — the caller runs one pass per
 * bucket, and silently folding a September visit into the wrong FY would corrupt the CoP denominator's
 * counterpart period.
 */
export function aggregateVolunteerHours(args: {
  readonly providerEntityId: ProviderEntityId;
  readonly fiscalYear: FiscalYear;
  readonly existingEntries: ReadonlyArray<VolunteerHourEntryFacts>;
  readonly candidates: ReadonlyArray<VolunteerVisitCandidate>;
  readonly asOfAt: IsoInstant;
  readonly fiscalYearStartMonth?: number;
}): VolunteerHourAggregate {
  const startMonth =
    args.fiscalYearStartMonth ?? VOLUNTEER_RATIO_POLICY.defaultFiscalYearStartMonth;
  const ledgered = new Set(
    args.existingEntries
      .map((e) => e.sourceEncounterId)
      .filter((id): id is EncounterId => id !== null),
  );

  const newEntries: VolunteerHourEntryFacts[] = [];
  const unresolved: EncounterId[] = [];
  for (const c of args.candidates) {
    if (fiscalYearFor(c.occurredAt, startMonth) !== args.fiscalYear) continue;
    if (ledgered.has(c.encounterId)) continue;
    if (c.durationMinutes === null || c.durationMinutes <= 0) {
      unresolved.push(c.encounterId);
      continue;
    }
    newEntries.push({
      volunteerMembershipId: c.volunteerMembershipId,
      source: "encounter",
      durationMinutes: c.durationMinutes,
      occurredAt: c.occurredAt,
      sourceEncounterId: c.encounterId,
      adjustmentReason: null,
      adjustedByMembershipId: null,
    });
  }

  const totalVolunteerHourMinutes = [...args.existingEntries, ...newEntries].reduce(
    (sum, e) => sum + e.durationMinutes,
    0,
  );
  return {
    providerEntityId: args.providerEntityId,
    fiscalYear: args.fiscalYear,
    totalVolunteerHourMinutes,
    asOfAt: args.asOfAt,
    newEntries,
    unresolvedDurationEncounterIds: unresolved,
    effects: [
      {
        kind: "set_ledger_total",
        totalVolunteerHourMinutes,
        asOfAt: args.asOfAt,
      },
      { kind: "audit" },
      { kind: "outbox", event: "m15.volunteer.ratio_recomputed" },
    ],
  };
}

/**
 * §7.6 / M15-F04 — the 418.78(e) ratio at read time. `staffPatientCareMinutes` is M27's total patient-care
 * hours (as minutes) for the same provider entity + fiscal year, or `null` while that seam is unbound —
 * which is the honest `unavailable` badge, with the reason carried through to the UI, not a zero.
 *
 * A zero denominator is also `unavailable`, not a division by zero and not a 0% breach: a provider entity
 * with no recorded patient-care hours has no CoP ratio to fail.
 */
export function computeVolunteerHourRatio(args: {
  readonly providerEntityId: ProviderEntityId;
  readonly fiscalYear: FiscalYear;
  readonly volunteerHourMinutes: number;
  readonly staffPatientCareMinutes: number | null;
  /**
   * When the nightly aggregator last persisted the denominator. `null` = never computed; `undefined` = the
   * caller computed the denominator inline (no staleness semantics). Together with `now`, a computed-at older
   * than {@link DENOMINATOR_STALE_AFTER_MS} still serves the value but marks the reason `stale`.
   */
  readonly denominatorComputedAt?: string | null;
  readonly now?: string;
}): VolunteerHourRatio {
  const denominator = args.staffPatientCareMinutes;
  const neverComputed = args.denominatorComputedAt === null;
  if (denominator === null || denominator <= 0) {
    return {
      providerEntityId: args.providerEntityId,
      fiscalYear: args.fiscalYear,
      volunteerHourMinutes: args.volunteerHourMinutes,
      staffPatientCareMinutes: denominator,
      ratio: null,
      status: "unavailable",
      reason: neverComputed
        ? "cost basis unavailable — the staff patient-care denominator has not been computed yet for this provider entity and fiscal year (the nightly hour aggregator persists it)"
        : denominator === null
          ? "cost basis unavailable — no signed staff patient-care visit with a resolved duration for this provider entity and fiscal year"
          : "cost basis unavailable — no patient-care hours recorded for this provider entity and fiscal year",
    };
  }
  const ratio = args.volunteerHourMinutes / denominator;
  return {
    providerEntityId: args.providerEntityId,
    fiscalYear: args.fiscalYear,
    volunteerHourMinutes: args.volunteerHourMinutes,
    staffPatientCareMinutes: denominator,
    ratio,
    status: volunteerRatioStatus(ratio),
    ...staleReason(args.denominatorComputedAt, args.now),
  };
}

/** A persisted denominator older than this is still served, but its ratio carries a `stale` reason. */
export const DENOMINATOR_STALE_AFTER_MS = 48 * 60 * 60 * 1000;

function staleReason(
  computedAt: string | null | undefined,
  now: string | undefined,
): { readonly reason?: string } {
  if (computedAt === null || computedAt === undefined || now === undefined) return {};
  const ageMs = Date.parse(now) - Date.parse(computedAt);
  if (!(ageMs > DENOMINATOR_STALE_AFTER_MS)) return {};
  return {
    reason: `stale — the staff patient-care denominator was last computed ${computedAt} (over 48h ago); the nightly hour aggregator has not refreshed it`,
  };
}

/**
 * §7.6 / §4.7 — whether a computed ratio pages, and how loudly: `warn` in the 3–5% band (a
 * corrective-action prompt to the Vol Coord, DON and Compliance Officer), `critical` below 3%. An
 * `unavailable` ratio never pages — alerting on a missing denominator would train the recipients to
 * ignore the real breach.
 */
export function ratioAlertSeverity(ratio: VolunteerHourRatio): "warn" | "critical" | null {
  switch (ratio.status) {
    case "red":
      return "critical";
    case "yellow":
      return "warn";
    default:
      return null;
  }
}

/** §7.6 — the fiscal-year bucket an instant belongs to (re-exported so the workers have one import). */
export { fiscalYearFor };
