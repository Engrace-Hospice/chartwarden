// @wardenx/scheduling — §2.2.4 / §7.7 D5 frequency-driven visit-proposal domain (M17-T04). Pure, IO-free,
// `Date.now()`-free.
//
// The `propose-from-frequency` cron (M17-T08) runs nightly and reads M7's
// `CarePlanReader.activeInterventionsWithFrequency(patientId)` for every active admission (D5). For each
// active intervention whose `frequency` is CADENCED (`@wardenx/scheduling` `frequency.ts`), the worker
// computes the next-due-by-cadence service dates inside a rolling window and inserts one `visit_proposal`
// row per date in the scheduler's inbox (`pending`). This module is the deterministic heart of that cron: it
// enumerates the org-local due dates from a cadence + anchor, and builds the typed proposal-insert input +
// the per-proposal idempotency key (so re-running the cron is idempotent on `(org, source, key)` per the
// §3.3 `vp_idempotency_uidx`) + the §2.4 genesis effect list (audit + the `m17.visit.proposed` event whose
// §4.11 payload carries the proposal id). It also models the §2.2.4 proposal status machine
// (`pending → published | dismissed | stale`).
//
// IO lives upstream: the cron resolves the M7 intervention, the M5 `PatientAddressReader` geocoded service
// address, and the M40 `Location`/`Facility` identity, then passes the resolved facts in. The actual
// `visit` row genesis on publish is the visit-machine `publish` transition; here `publish` only flips the
// proposal row and links the minted visit id.
import type {
  AdmissionId,
  IsoDate,
  MembershipId,
  OrgId,
  PatientId,
  VisitId,
  VisitProposalStatus,
  VisitPurpose,
} from "@wardenx/types";
import { type FrequencyValue, frequencyCadenceDays, parseFrequency } from "../frequency";
import { type SchedulingSideEffect, type SchedulingTransitionResult, result } from "./effects";
import { SchedulingStateError, require_ } from "./errors";
import { addCalendarDays, calendarDaysBetween } from "./time";

/** The §2.2.4 default rolling proposal window (days). One week of look-ahead — the cron may widen it. */
export const PROPOSE_HORIZON_DAYS = 7;

/**
 * Enumerate the org-local service dates a cadenced frequency is due on within `[windowStart, windowStart +
 * horizonDays]`. `anchorDate` is the cadence origin — the last serviced date for that intervention, or (for
 * a brand-new intervention) the care-plan/admission start: the first due date is `anchorDate + interval`,
 * fast-forwarded into the window if the anchor is far in the past so a long-dormant intervention does not
 * back-fill stale proposals. With `anchorDate = null` the cadence starts at `windowStart`. A non-cadenced
 * frequency (`prn` / `continuous` / `episode`) yields `[]` — those never auto-propose (D5). Deterministic:
 * same inputs always produce the identical date set, so the cron upserts on the idempotency key.
 */
export function computeProposalDates(
  freq: FrequencyValue,
  anchorDate: IsoDate | null,
  windowStart: IsoDate,
  horizonDays: number = PROPOSE_HORIZON_DAYS,
): IsoDate[] {
  const interval = frequencyCadenceDays(freq);
  if (interval === null) return [];
  const horizonEnd = addCalendarDays(windowStart, horizonDays);

  // First due date: one interval past the anchor (or the window start when there is no anchor yet).
  let cursor = anchorDate === null ? windowStart : addCalendarDays(anchorDate, interval);
  // Fast-forward whole intervals until the cursor reaches the window (no stale back-fill).
  while (calendarDaysBetween(cursor, windowStart) > 0) {
    cursor = addCalendarDays(cursor, interval);
  }

  const out: IsoDate[] = [];
  for (let d = cursor; calendarDaysBetween(d, horizonEnd) >= 0; d = addCalendarDays(d, interval)) {
    out.push(d);
  }
  return out;
}

/** The facts the cron resolves (M7 intervention + M5/M40 tenancy spine) and injects per proposal batch. */
export interface FrequencyProposalInput {
  readonly organizationId: OrgId;
  readonly providerEntityId: string;
  readonly locationId: string;
  readonly patientId: PatientId;
  readonly admissionId: AdmissionId;
  /** The M7 intervention id — the cadence origin + the idempotency anchor (one proposal per intervention/date). */
  readonly interventionId: string;
  /** The raw M7/M15 `frequency` string (parsed here; non-cadenced ⇒ no proposals). */
  readonly frequency: string;
  /** §2.2.4 — the visit the cadence proposes (discipline + intent). */
  readonly proposedVisitPurpose: VisitPurpose;
  /** §2.2.4 — the discipline that should staff it (from the intervention). */
  readonly proposedDiscipline: string;
  /** §2.2.4 — the nominal visit length. */
  readonly proposedDurationMinutes: number;
  /** The cadence origin (last serviced date, or care-plan/admission start for a new intervention). */
  readonly anchorDate: IsoDate | null;
  /** The rolling-window start (org-local "today" the cron runs for). */
  readonly windowStart: IsoDate;
  /** Optional best-fit clinician suggestion; the scheduler may reassign at publish. */
  readonly suggestedMembershipId?: MembershipId | null;
  /** Window override (default {@link PROPOSE_HORIZON_DAYS}). */
  readonly horizonDays?: number;
}

/** The typed `source_payload` (§2.2.4) capturing the upstream id for audit + idempotency. */
export interface FrequencyProposalSourcePayload {
  /** The id the §3.3 `vp_idempotency_uidx` dedupes on (the M7 intervention). */
  readonly upstreamEventId: string;
  readonly interventionId: string;
  readonly frequency: string;
  readonly anchorDate: IsoDate | null;
  readonly proposedForDate: IsoDate;
}

/** One planned `visit_proposal` insert + its genesis side effects (the service writes the row in one tx). */
export interface PlannedVisitProposal {
  readonly source: "frequency_driven_m7";
  readonly organizationId: OrgId;
  readonly providerEntityId: string;
  readonly locationId: string;
  readonly patientId: PatientId;
  readonly admissionId: AdmissionId;
  readonly sourceIdempotencyKey: string;
  readonly proposedForDate: IsoDate;
  readonly proposedVisitPurpose: VisitPurpose;
  readonly proposedDiscipline: string;
  readonly proposedDurationMinutes: number;
  readonly suggestedMembershipId: MembershipId | null;
  readonly sourcePayload: FrequencyProposalSourcePayload;
  /** §2.4 genesis — the M4 write-audit row + the `m17.visit.proposed` outbox event (proposal payload). */
  readonly effects: ReadonlyArray<SchedulingSideEffect>;
}

/** The §2.4 genesis effects every freshly-inserted `pending` proposal row carries. */
function proposalGenesisEffects(): ReadonlyArray<SchedulingSideEffect> {
  return [{ kind: "audit" }, { kind: "outbox", event: "m17.visit.proposed" }];
}

/**
 * Plan the frequency-driven `visit_proposal` rows for one M7 intervention (D5). Parses the `frequency`
 * (throws {@link SchedulingStateError} `FREQUENCY_UNPARSEABLE` on a malformed string), enumerates the due
 * dates inside the rolling window via {@link computeProposalDates}, and emits one planned proposal per date
 * with a deterministic `interventionId:date` idempotency key. A non-cadenced frequency yields `[]` (the cron
 * skips it). Pure — the service inserts the rows + runs the effects in one optimistic-locked tx.
 */
export function planFrequencyProposals(input: FrequencyProposalInput): PlannedVisitProposal[] {
  const freq = parseFrequency(input.frequency);
  const dates = computeProposalDates(freq, input.anchorDate, input.windowStart, input.horizonDays);
  return dates.map((proposedForDate) => ({
    source: "frequency_driven_m7" as const,
    organizationId: input.organizationId,
    providerEntityId: input.providerEntityId,
    locationId: input.locationId,
    patientId: input.patientId,
    admissionId: input.admissionId,
    sourceIdempotencyKey: `${input.interventionId}:${proposedForDate}`,
    proposedForDate,
    proposedVisitPurpose: input.proposedVisitPurpose,
    proposedDiscipline: input.proposedDiscipline,
    proposedDurationMinutes: input.proposedDurationMinutes,
    suggestedMembershipId: input.suggestedMembershipId ?? null,
    sourcePayload: {
      upstreamEventId: input.interventionId,
      interventionId: input.interventionId,
      frequency: freq.raw,
      anchorDate: input.anchorDate,
      proposedForDate,
    },
    effects: proposalGenesisEffects(),
  }));
}

// ── §2.2.4 proposal status machine (pending → published | dismissed | stale) ───────────────────────────

export type ProposalState = VisitProposalStatus;

/** The §2.2.4 proposal lifecycle events. The minted visit id (publish) is resolved upstream and injected. */
export type ProposalEvent =
  | {
      readonly type: "publish";
      /** The `visit` row the service mints in the same tx (visit-machine genesis + publish). */
      readonly visitId: VisitId;
    }
  | {
      readonly type: "dismiss";
      /** §2.2.4 — the denylisted dismissal reason (must be non-empty). */
      readonly reason: string;
    }
  /** Not actioned by the cadence hard-cutoff — the stale-sweep cron flips it (system actor). */
  | { readonly type: "stale" };

export type ProposalTransition = SchedulingTransitionResult<ProposalState, ProposalEvent["type"]>;

/** The legal §2.2.4 transition graph (from → events accepted). Terminal states accept nothing. */
export const PROPOSAL_GRAPH: Readonly<Record<ProposalState, ReadonlyArray<ProposalEvent["type"]>>> =
  {
    pending: ["publish", "dismiss", "stale"],
    published: [],
    dismissed: [],
    stale: [],
  };

/**
 * Apply a §2.2.4 proposal lifecycle event. Throws {@link SchedulingStateError} `ILLEGAL_PROPOSAL_TRANSITION`
 * when the event is not accepted from `from`, or `PROPOSAL_DISMISSAL_REASON_REQUIRED` on an empty dismissal
 * reason. Returns the new state + the side-effect list. `publish` links the minted visit id on the proposal
 * row (the visit's own genesis + `m17.visit.published` come from the visit-machine `publish` the service
 * runs alongside, NOT from here — the proposal row only records the linkage).
 */
export function transitionProposal(from: ProposalState, event: ProposalEvent): ProposalTransition {
  if (!PROPOSAL_GRAPH[from].includes(event.type)) {
    throw new SchedulingStateError(
      "ILLEGAL_PROPOSAL_TRANSITION",
      `proposal cannot ${event.type} from '${from}'`,
    );
  }

  switch (event.type) {
    case "publish":
      return result(from, event.type, "published", [
        { kind: "set_timestamp", field: "published_as_visit_id" },
        { kind: "bump_version" },
        { kind: "audit" },
      ]);

    case "dismiss":
      require_(
        event.reason.trim().length > 0,
        "PROPOSAL_DISMISSAL_REASON_REQUIRED",
        "a proposal dismissal requires a documented reason",
      );
      return result(from, event.type, "dismissed", [
        { kind: "capture_reason", field: "dismissal_reason", value: event.reason },
        { kind: "set_timestamp", field: "dismissed_by" },
        { kind: "bump_version" },
        { kind: "audit" },
      ]);

    case "stale":
      return result(from, event.type, "stale", [
        { kind: "set_timestamp", field: "stale_at" },
        { kind: "bump_version" },
        { kind: "audit" },
        { kind: "outbox", event: "m17.stale_visit_detected" },
      ]);
  }
}
