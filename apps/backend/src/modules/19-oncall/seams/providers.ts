// apps/backend/src/modules/19-oncall/seams/providers.ts — M19-T06, the §4.3 seam implementations: pure
// orchestration over an injected {@link OncallSeamStore}. Each returns the leaf-typed seam interface
// (`@chartwarden/types`) the M1 registry validates and M14 / M20 / M30 / M31 / M32 / M33 / M36 resolve. The
// providers add NO tenant logic — RLS scopes every store read by the caller's ambient `app.org_id` (§3.5).
//
// ── THE `orgId` ARGUMENT IS AN ASSERTION, NOT A SELECTOR ───────────────────────────────────────────────
//
// §4.3 gives every method an `orgId` first parameter, and the honest thing to do with it is REFUSE when it
// disagrees with the scope RLS already pinned — not to select rows by it. Using it as a selector would
// make the seam's tenancy depend on an argument the CALLER controls, which is precisely the IDOR §9.4
// tests exist to catch; ignoring it silently would let a caller believe it asked about org A while being
// answered about org B. `assertCallerOrg` throws `TRIAGE_SEAM_ORG_MISMATCH`. Outside a request scope
// (a cron that forgot `runWithRequestContext`) there is no ambient org and the Drizzle store itself
// refuses, so no read runs unscoped.
//
// ── FAIL POSTURE, PER SEAM (asymmetric on purpose — the M15-T05 / M16-T05 / M21-T05 rule: pick the
//    direction by what the consumer DOES with the answer) ───────────────────────────────────────────────
//
//   • `OnCallProvider` PROPAGATES. It is the one that matters. `[]` from this seam is a REAL and
//     load-bearing answer — it means nobody is covering, the §4.8 watchdog's whole subject — so a store
//     failure must not be able to produce it. M36 routing an escalation to an empty recipient list looks
//     identical to a genuine coverage gap and silently swallows a 2 a.m. page; a throw makes M36 take its
//     degraded alert path. (Same reason `OnCallRosterRead` is a union on the CONSUMED side, M19-T04.)
//   • `TriageCallReader` / `TriageCallProvider` PROPAGATE. `null` from `callForPacket` means the id does
//     not resolve IN THE CALLER'S ORG — indistinguishable from "does not exist" on purpose, so a
//     cross-tenant probe learns nothing.
//   • `PortalTriageReader` PROPAGATES. A family-facing care log that silently omits last night's call
//     reads as "nothing happened"; an error state reads as "we can't show this right now".
//   • `TriageCallMetricsProvider` PROPAGATES. A zeroed p95 or a fabricated `{0,0}` on a quality surface
//     is a reportable misstatement, not a degraded read (the M21 `SupplyCostProvider` posture).
//
// ── THE ONE PLACE A SEAM ANSWERS SOFTLY ────────────────────────────────────────────────────────────────
//
// `currentOnCallActors` DROPS a membership shift whose user id will not resolve, rather than failing the
// whole roster read. Publishing an actor with a fabricated user id would page nobody while LOOKING like
// coverage; dropping it makes the shift show up as uncovered, which is the truth M36 and the watchdog can
// act on. The `external_vendor` arm is structurally incapable of carrying a user id (§4.3 / M19-T01), so
// it is never affected.
import { getRequestContext } from "@chartwarden/tenancy";
import {
  ChartWardenError,
  type ChiefComplaintBucket,
  type EscalationTierCount,
  type IsoInstant,
  type MeasureCounts,
  type OnCallActor,
  type OnCallProvider,
  type OnCallShiftDto,
  type OrgId,
  type PatientId,
  type PortalTriageReader,
  type PortalTriageSummary,
  type ProviderEntityId,
  type TriageCallMetricsProvider,
  type TriageCallProvider,
  type TriageCallReader,
  type TriageDisposition,
  type TriageEscalationTier,
  type TriageMetricsWindow,
} from "@chartwarden/types";
import type { OncallSeamStore, PortalTriageCallRow, RnCoverageRead } from "./store";

/** The CALLER's org, resolved from the ambient request context (injected so the providers unit-test with
 *  no request scope). Outside a request it answers `""`, which `assertCallerOrg` treats as "no ambient
 *  scope to compare against" — the Drizzle store is what refuses in that case, and it refuses hard. */
export type OncallSeamOrgResolver = () => OrgId;

/** The clock the §4.3 default windows derive "now" from — injected so seam reads are deterministic. */
export type OncallSeamClock = () => IsoInstant;

export const defaultOncallSeamOrgResolver: OncallSeamOrgResolver = () =>
  (getRequestContext()?.organizationId ?? "") as OrgId;

export const defaultOncallSeamClock: OncallSeamClock = () => new Date().toISOString() as IsoInstant;

/**
 * Refuse a seam call whose `orgId` argument disagrees with the scope RLS pinned. An EMPTY ambient org
 * (no request scope) is not a mismatch — there is nothing to disagree with, and the store below refuses
 * to read unscoped anyway. See the header.
 */
export function assertCallerOrg(orgOf: OncallSeamOrgResolver, orgId: OrgId): void {
  const ambient = orgOf();
  if (ambient !== "" && ambient !== orgId) {
    throw new ChartWardenError(
      "TRIAGE_SEAM_ORG_MISMATCH",
      "on-call seam called with an organization id that is not the caller's scope",
      403,
    );
  }
}

// ── pure oracles the providers compose (exported so §9.1 can pin them without a store) ────────────────

/**
 * The nearest-rank percentile over an unsorted sample, in the sample's own units. Nearest-rank rather
 * than an interpolating variant because the §9.7 target ("p95 first-response ≤ N seconds") is asserted
 * against an OBSERVED call, and an interpolated value is a latency no call actually had.
 *
 * An EMPTY sample answers 0 — and that is safe here only because the caller cannot confuse it with an
 * outage: an unreadable store throws before reaching this function.
 */
export function percentileOf(samples: readonly number[], percentile: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((percentile / 100) * sorted.length);
  const index = Math.min(sorted.length, Math.max(1, rank)) - 1;
  return sorted[index] as number;
}

/**
 * `numerator / denominator`, or 0 when the denominator is 0.
 *
 * The zero is why the `*Counts` siblings exist. A rate of 0 over an empty population and a rate of 0 over
 * a hundred calls are the same number and completely different facts; M30 reads the COUNTS and applies
 * its own small-N suppression. This helper exists for the §4.3 rate methods a M33 dashboard tile wants,
 * and no measure input goes through it.
 */
export function rateOf(counts: MeasureCounts): number {
  return counts.denominator === 0 ? 0 : counts.numerator / counts.denominator;
}

/**
 * §2.4 / §9.7 — minutes inside `[from, to)` during which some ProviderEntity had NO `clinical_rn`
 * coverage, summed across ProviderEntities.
 *
 * PER-PE, SUMMED — not "minutes in which the ORG was uncovered". CoP 418.100(c)(2) is a per-CCN
 * obligation (the same read that made `on_call_shift.provider_entity_id` NOT NULL at M19-T04), so a
 * two-PE agency that covered one and left the other dark for an hour has 60 gap-minutes, not 0. Taking
 * the org-wide union would let one covered PE mask every other PE's gap — the exact finding a surveyor
 * writes up.
 *
 * A PE with no windows at all contributes the WHOLE window. Overlapping windows are merged first, so
 * double-booked coverage never subtracts twice.
 */
export function coverageGapMinutesOf(
  window: TriageMetricsWindow,
  coverage: RnCoverageRead,
): number {
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return 0;
  const totalMs = to - from;

  let gapMs = 0;
  for (const providerEntityId of coverage.providerEntityIds) {
    const clipped = coverage.windows
      .filter((w) => w.providerEntityId === providerEntityId)
      .map((w) => ({
        start: Math.max(from, Date.parse(w.fromIso)),
        end: Math.min(to, Date.parse(w.toIso)),
      }))
      .filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start)
      .sort((a, b) => a.start - b.start);

    let coveredMs = 0;
    let cursorStart = Number.NaN;
    let cursorEnd = Number.NaN;
    for (const w of clipped) {
      if (Number.isNaN(cursorStart)) {
        cursorStart = w.start;
        cursorEnd = w.end;
        continue;
      }
      if (w.start <= cursorEnd) {
        cursorEnd = Math.max(cursorEnd, w.end);
      } else {
        coveredMs += cursorEnd - cursorStart;
        cursorStart = w.start;
        cursorEnd = w.end;
      }
    }
    if (!Number.isNaN(cursorStart)) coveredMs += cursorEnd - cursorStart;

    gapMs += Math.max(0, totalMs - coveredMs);
  }
  return Math.round(gapMs / 60_000);
}

/**
 * §4.3 / §5.3 — the lay-language disposition oracle: what the FAMILY is told a call ended in.
 *
 * A closed table rather than a template, and never the raw enum. `ed_transfer_acknowledged` is the one
 * that proves the point: the enum member is a hospice-election-adjacent record a surveyor reads, and
 * rendering it verbatim into a care-log the family reads at 7 a.m. would put a clinical-legal term in
 * front of a grieving household with no one to explain it. Two more are deliberate:
 *
 *   • `escalated_unresolved` and `abandoned` say a nurse is still working on it / that the agency tried to
 *     ring back. They do NOT expose the escalation tier or the attempt count (§5.3 scrubs both) — a
 *     family does not need to know a Compliance Officer was paged to know their call is being handled.
 *   • `pronouncement_scheduled` stays factual and gentle. It is the entry a family sees the morning
 *     after a death, and any softening beyond this reads as evasion.
 *
 * A call with NO disposition yet gets the in-progress wording rather than being hidden: an entry that
 * silently disappears from the care log is worse than one that says "still open".
 */
export const PORTAL_DISPOSITION_LAY_SUMMARY: {
  readonly [K in TriageDisposition]: string;
} = {
  caregiver_education_only: "The on-call nurse gave guidance over the phone.",
  prn_intervention_authorized:
    "The on-call nurse approved use of an as-needed medication already ordered.",
  verbal_order_recorded: "The on-call nurse took a new order from the doctor over the phone.",
  visit_dispatched_now: "A visit was arranged right away.",
  visit_scheduled_first_light: "A visit was arranged for the next morning.",
  gip_admission_proposed: "The care team began arranging a higher level of care.",
  ed_transfer_acknowledged: "The care team was told about a trip to the emergency department.",
  pronouncement_scheduled: "A nurse was arranged to come to the home.",
  escalated_unresolved:
    "The call was passed to another member of the care team, who is following up.",
  abandoned: "The call ended before it was finished; the team tried to reach you back.",
};

/** The wording for a call that has not reached a disposition yet — see the note above. */
export const PORTAL_IN_PROGRESS_LAY_SUMMARY = "The care team is still working on this call.";

/** §4.3 / §5.3 — project one row onto the family-facing DTO. Pure, so the oracle is testable alone. */
export function portalSummaryOf(row: PortalTriageCallRow): PortalTriageSummary {
  return {
    triageCallId: row.triageCallId,
    occurredAt: row.occurredAt,
    callerRelationshipLabel: row.callerRelationshipLabel,
    callerKind: row.callerKind,
    dispositionSummaryLay:
      row.disposition === null
        ? PORTAL_IN_PROGRESS_LAY_SUMMARY
        : PORTAL_DISPOSITION_LAY_SUMMARY[row.disposition],
    visitDispatched: row.disposition === "visit_dispatched_now",
    visitScheduledFirstLight: row.disposition === "visit_scheduled_first_light",
  };
}

/**
 * §4.3 — project a shift row onto the on-call ACTOR(s) it designates.
 *
 * A membership shift yields up to TWO actors: the primary and, when set, the backup — `isBackup` is what
 * lets M36 page the primary first and fall back, rather than treating a backup as a second primary. A
 * shift whose primary user id did not resolve yields nothing for that person (see the header's soft-fail
 * note); a vendor shift yields exactly one external actor and no user id at all, by construction.
 */
export function actorsOfShift(
  shift: OnCallShiftDto,
  userIdByMembership: ReadonlyMap<string, string>,
): readonly OnCallActor[] {
  if (shift.externalActorId !== null) {
    return [
      {
        kind: "external_vendor",
        shiftId: shift.shiftId,
        externalActorId: shift.externalActorId,
        externalActorLabel: shift.externalActorLabel,
        discipline: "external",
        shiftStartsAt: shift.shiftStartsAt,
        shiftEndsAt: shift.shiftEndsAt,
      },
    ];
  }

  const out: OnCallActor[] = [];
  const push = (membershipId: string | null, isBackup: boolean): void => {
    if (membershipId === null) return;
    const userId = userIdByMembership.get(membershipId);
    if (userId === undefined) return;
    out.push({
      kind: "membership",
      shiftId: shift.shiftId,
      membershipId,
      userId,
      discipline: shift.discipline,
      isBackup,
      shiftStartsAt: shift.shiftStartsAt,
      shiftEndsAt: shift.shiftEndsAt,
    });
  };
  push(shift.primaryOnCallMembershipId, false);
  push(shift.backupMembershipId, true);
  return out;
}

// ── the five §4.3 published seams ─────────────────────────────────────────────────────────────────────

/**
 * §4.3 `OnCallProvider` — who is on call now (M36's `on_call` recipient resolver, M20's after-hours SOS
 * parallel recipient), and the active shifts M36's channel synchronizer re-syncs membership from.
 *
 * `currentOnCallActors` reads the shifts covering the instant — NOT only `active` ones. §2.2.2's
 * `scheduled → active` transition is a cron tick, so a shift whose window has begun but whose open tick
 * has not fired yet is still the nurse the agency expects to answer. Filtering to `active` would make
 * every shift start a coverage gap for as long as the cron interval. `activeShiftsAt` is the other
 * method and DOES filter, because M36's channel membership must follow the transition it is reacting to.
 */
export function createOnCallProvider(
  store: OncallSeamStore,
  orgOf: OncallSeamOrgResolver = defaultOncallSeamOrgResolver,
): OnCallProvider {
  return {
    async currentOnCallActors(
      orgId: OrgId,
      providerEntityId: ProviderEntityId,
      asOfIso: IsoInstant,
    ) {
      assertCallerOrg(orgOf, orgId);
      const shifts = await store.shiftsCoveringForProviderEntity(providerEntityId, asOfIso);
      const membershipIds = shifts.flatMap((s) =>
        [s.primaryOnCallMembershipId, s.backupMembershipId].filter(
          (id): id is string => id !== null,
        ),
      );
      const userIdByMembership = await store.userIdsForMemberships(membershipIds);
      return shifts.flatMap((s) => actorsOfShift(s, userIdByMembership));
    },
    async activeShiftsAt(orgId: OrgId, asOfIso: IsoInstant) {
      assertCallerOrg(orgOf, orgId);
      return store.activeShiftsAt(asOfIso);
    },
  };
}

/**
 * §4.3 `TriageCallReader` — M32's feature read (PHI-free by DTO construction: no caller identity, no
 * chief-complaint free text, and never either cipher column) and M14's since-last-IDG digest.
 */
export function createTriageCallReader(
  store: OncallSeamStore,
  orgOf: OncallSeamOrgResolver = defaultOncallSeamOrgResolver,
): TriageCallReader {
  return {
    async recentCallsForPatient(orgId: OrgId, patientId: PatientId, sinceIso: IsoInstant) {
      assertCallerOrg(orgOf, orgId);
      return store.callFeaturesForPatientSince(patientId, sinceIso);
    },
    async callsForPatientSince(orgId: OrgId, patientId: PatientId, sinceIso: IsoInstant) {
      assertCallerOrg(orgOf, orgId);
      return store.callDigestsForPatientSince(patientId, sinceIso);
    },
  };
}

/**
 * §4.3 `TriageCallProvider` — M14's full packet slice (M14 does its own PHI minimization) and M11's
 * reverse lookup from an expiring verbal order to the triage context it was taken in, so the 48-hour
 * countersignature reminder reaches the on-call actor who took the order rather than the day shift.
 */
export function createTriageCallProvider(
  store: OncallSeamStore,
  orgOf: OncallSeamOrgResolver = defaultOncallSeamOrgResolver,
): TriageCallProvider {
  return {
    async callForPacket(orgId, triageCallId) {
      assertCallerOrg(orgOf, orgId);
      return store.packetSlice(triageCallId);
    },
    async triageContextForVerbalOrder(orgId, verbalOrderId) {
      assertCallerOrg(orgOf, orgId);
      return store.triageContextForVerbalOrder(verbalOrderId);
    },
  };
}

/**
 * §4.3 / §5.3 `PortalTriageReader` — the ONLY M19 surface M31's portal may reach.
 *
 * `withinHours` is clamped at zero and interpreted as a look-BACK from now: a negative or absurd value
 * would otherwise let a portal session widen its own window. The consent gate itself is M39's
 * (`portal_session_consent_active`, §4.7) and is applied at the ROUTE, not here — a seam that also
 * decided consent would be a second authorization implementation, which is how the two drift.
 */
export function createPortalTriageReader(
  store: OncallSeamStore,
  orgOf: OncallSeamOrgResolver = defaultOncallSeamOrgResolver,
  clock: OncallSeamClock = defaultOncallSeamClock,
): PortalTriageReader {
  return {
    async summaryForPatient(orgId, patientId, withinHours) {
      assertCallerOrg(orgOf, orgId);
      const hours = Number.isFinite(withinHours) ? Math.max(0, withinHours) : 0;
      const sinceIso = new Date(
        Date.parse(clock()) - hours * 3_600_000,
      ).toISOString() as IsoInstant;
      const rows = await store.portalCallRows(patientId, sinceIso);
      return rows.map(portalSummaryOf);
    },
  };
}

/**
 * §4.3 `TriageCallMetricsProvider` — M30's measure inputs and M33's dashboard tiles.
 *
 * The rate methods and their `*Counts` siblings read the SAME store method, so a dashboard tile and a
 * CMS-reportable measure can never disagree about the population — the rate is literally the counts
 * divided. That single-source shape is the point of the pair; two independent queries would be two
 * places for the definition to drift.
 */
export function createTriageCallMetricsProvider(
  store: OncallSeamStore,
  orgOf: OncallSeamOrgResolver = defaultOncallSeamOrgResolver,
): TriageCallMetricsProvider {
  return {
    async getResponseTimeP95(orgId: OrgId, windowIso: TriageMetricsWindow) {
      assertCallerOrg(orgOf, orgId);
      return percentileOf(await store.responseLatencySeconds(windowIso), 95);
    },
    async getHospitalizationAvoidanceRate(orgId: OrgId, windowIso: TriageMetricsWindow) {
      assertCallerOrg(orgOf, orgId);
      return rateOf(await store.hospitalizationAvoidanceCounts(windowIso));
    },
    async getHospitalizationAvoidanceCounts(orgId: OrgId, windowIso: TriageMetricsWindow) {
      assertCallerOrg(orgOf, orgId);
      return store.hospitalizationAvoidanceCounts(windowIso);
    },
    async getEscalationDistribution(orgId: OrgId, windowIso: TriageMetricsWindow) {
      assertCallerOrg(orgOf, orgId);
      const tallies = await store.escalationTierTallies(windowIso);
      return tallies.map(
        (t): EscalationTierCount => ({ tier: t.tier as TriageEscalationTier, count: t.count }),
      );
    },
    async getAfterHoursVisitConversionRate(orgId: OrgId, windowIso: TriageMetricsWindow) {
      assertCallerOrg(orgOf, orgId);
      return rateOf(await store.afterHoursVisitConversionCounts(windowIso));
    },
    async getAfterHoursVisitConversionCounts(orgId: OrgId, windowIso: TriageMetricsWindow) {
      assertCallerOrg(orgOf, orgId);
      return store.afterHoursVisitConversionCounts(windowIso);
    },
    async getChiefComplaintPareto(orgId: OrgId, windowIso: TriageMetricsWindow) {
      assertCallerOrg(orgOf, orgId);
      const tallies = await store.chiefComplaintTallies(windowIso);
      return [...tallies]
        .sort((a, b) => b.count - a.count || a.protocolKey.localeCompare(b.protocolKey))
        .map(
          (t): ChiefComplaintBucket => ({
            protocolKey: t.protocolKey,
            chiefComplaintLabel: t.chiefComplaintLabel,
            count: t.count,
          }),
        );
    },
    async getCoverageGapMinutes(orgId: OrgId, windowIso: TriageMetricsWindow) {
      assertCallerOrg(orgOf, orgId);
      return coverageGapMinutesOf(windowIso, await store.rnCoverage(windowIso));
    },
  };
}
