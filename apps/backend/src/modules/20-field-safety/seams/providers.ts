import { pointInRings } from "@chartwarden/shared/geo";
import { getRequestContext } from "@chartwarden/tenancy";
// apps/backend/src/modules/20-field-safety/seams/providers.ts — M20-T05, the §4.3 seam implementations:
// pure orchestration over an injected {@link SafetySeamStore}. Each returns the leaf-typed seam interface
// (`@chartwarden/types`) the M1 registry validates and M8 / M17 / M19 / M30 / M32 / M33 / M36 resolve. The
// providers add NO tenant logic — RLS scopes every store read by the caller's ambient `app.org_id` (§3.5).
//
// ── THE `orgId` ARGUMENT IS AN ASSERTION, NOT A SELECTOR ───────────────────────────────────────────────
//
// §4.3 gives every method an `orgId` first parameter, and the honest thing to do with it is REFUSE when it
// disagrees with the scope RLS already pinned — not to select rows by it. Using it as a selector would
// make the seam's tenancy depend on an argument the CALLER controls, which is precisely what the §9.4 IDOR
// tests exist to catch; ignoring it silently would let a caller believe it asked about org A while being
// answered about org B. `assertCallerOrg` throws `SAFETY_SEAM_ORG_MISMATCH`. Outside a request scope (a
// cron that forgot `runWithRequestContext`) there is no ambient org and the Drizzle store itself refuses,
// so no read runs unscoped. This is M19-T06's rule, restated because it is the one that keeps a seam from
// becoming a cross-tenant read.
//
// ── FAIL POSTURE, PER SEAM (asymmetric on purpose — the M15/M16/M19/M21 rule: pick the direction by what
//    the consumer DOES with the answer) ────────────────────────────────────────────────────────────────
//
//   • `SafetyDashboardProvider` PROPAGATES. An empty board and an unreadable board are the same picture
//     on a screen that collapses them, and one of them tells a supervisor asking "is everyone OK?" that
//     everyone is fine. A throw is what makes the §5 board render its third state (the M19-T08 rule).
//   • `SafetySupervisorProvider` PROPAGATES, and it is the one that matters most. `[]` is a REAL answer —
//     it is the §7.8 coverage gap the system-locked critical alert wakes the DON for — so a store failure
//     must not be able to produce it. M36 routing a 3 a.m. SOS to an empty recipient list looks exactly
//     like a genuine gap and silently swallows the page; a throw makes the caller fall back to the tenant
//     emergency number (M20-F01).
//   • `SafetyContextReader` PROPAGATES. `null` from `activeIncidentForVisit` means "no OPEN incident in
//     the caller's org", indistinguishable from "no such visit" on purpose, so a cross-tenant probe
//     learns nothing — but it must never mean "M20 did not answer".
//   • `SafetyMetricsProvider` PROPAGATES. A zeroed rate on a safety tile is a reportable claim ("no
//     incidents"), not a degraded read — the M21 `SupplyCostProvider` / M19 `TriageCallMetricsProvider`
//     posture.
//   • `SafetyCheckInProvider` PROPAGATES. `not_required` is a real badge value; a failed read that
//     produced it would tell M17's day grid that a visit never owed a check-in whose clinician is overdue.
//   • `SafetyPolicyProvider` is THE ONE THAT ANSWERS SOFTLY, and only for one specific absence: a tenant
//     with NO version row yet gets the platform floor (`SAFETY_POLICY_FLOOR`) rather than an error,
//     because the floor is what governs that tenant by construction (M20-F03) and refusing would take
//     every threshold read down during onboarding. A store FAILURE still propagates — "no row" and "no
//     answer" are different facts and only the first has a correct default.
//   • `SafetyIncidentReader` PROPAGATES, and additionally REFUSES when no coordinate decipher is bound —
//     see the block on §8.6 below.
//
// ── §8.6: WHY AN UNBOUND DECIPHER IS A REFUSAL AND NOT A NULL ─────────────────────────────────────────
//
// `SafetyIncidentMinNecDto.roundedCoordinates` is non-null exactly for SOS-linked incidents, and the only
// geography an incident has lives in its linked SOS's `posted_coordinates_cipher` (§3.3 gives
// `safety_incident` no coordinate column). Decrypting it needs the per-tenant DEK, which does not leave
// M20's boundary — so the decipher is an injected dependency, and the write path that would bind it is
// M20-T06's. Until it is bound, BOTH methods throw `SAFETY_COORDINATE_DECIPHER_UNBOUND` rather than
// answering with `roundedCoordinates: null` everywhere. Answering would be a lie in both directions: the
// area query would match nothing and read as "no incidents happened there" to a model whose whole job is
// to suggest a polygon where they did, and the per-clinician query would claim her incidents had no
// geography. A registered contract that denies and says why is the platform rule (CLAUDE.md, the
// `deviceAttestationValid` precedent) — an absent capability must be distinguishable from a mistake.
//
// ── WHAT THE BOARD STRUCTURALLY CANNOT SHOW TODAY ─────────────────────────────────────────────────────
//
// `SafetyClinicianStatusDto.inHighRiskArea` ships `null` on every row, and that is a carried-forward
// absence, not an oversight. D12's evaluation needs a coordinate for the clinician; §4.4's
// `PatientAddressReader.geocodedAddressFor` DOES NOT EXIST (M20-T04 established this and did not invent
// it), M18's coordinates are deliberately projected away at `../consumers/seam-context` before they reach
// any composer, and no polygon evaluator was built. Rendering a fabricated advisory — or an absent one
// dressed as "not in a high-risk area" — would tell a clinician a house is safe. `null` is the honest
// value and the §5 screens render it as "not evaluated", never as "clear".
import type {
  IsoInstant,
  LocationId,
  MembershipId,
  OrgId,
  SafetyCheckInBadge,
  SafetyCheckInProvider,
  SafetyClinicianStatusDto,
  SafetyContextReader,
  SafetyDashboardProvider,
  SafetyDashboardSnapshot,
  SafetyIncidentMinNecDto,
  SafetyIncidentReader,
  SafetyIncidentSummaryDto,
  SafetyMetricsProvider,
  SafetyPolicyEffectiveDto,
  SafetyPolicyProvider,
  SafetyPolicyVersionId,
  SafetyPolygonRings,
  SafetyRoundedCoordinates,
  SafetySupervisorProvider,
  SafetySupervisorRecipientDto,
  SafetyVisitCheckInStatusDto,
} from "@chartwarden/types";
import { SAFETY_POLICY_FLOOR, ChartWardenError } from "@chartwarden/types";
import type { SafetyClinicianSignalCache } from "../consumers/m18-gps-spoof";
import {
  lastKnownLocationFrom,
  readCurrentVisitForClinician,
  readLastKnownLocation,
  readOrgShiftLocations,
  readPatientFirstName,
} from "../consumers/seam-context";
import { minutesPastExpected, overdueBadgeFor, overdueTierAt } from "../lifecycle/check-in-overdue";
import { detectCoverageGaps, subscriptionCovers } from "../lifecycle/coverage-gap";
import { isAfterHours, mergeEffectivePolicy } from "../lifecycle/policy";
import type {
  SafetyIncidentGeoFacts,
  SafetyIncidentSummaryFacts,
  SafetySeamStore,
  SafetyVisitScheduleFacts,
} from "./store";

/** The CALLER's org, resolved from the ambient request context (injected so the providers unit-test with
 *  no request scope). Outside a request it answers `""`, which `assertCallerOrg` treats as "no ambient
 *  scope to compare against" — the Drizzle store is what refuses in that case, and it refuses hard. */
export type SafetySeamOrgResolver = () => OrgId;

/** The org's IANA time zone, for the D14 after-hours arithmetic. REQUIRED and with NO default: a silent
 *  "UTC" puts a Pacific agency's night shift at 10 a.m. and nothing would ever say so (M20-T04's rule,
 *  applied here to a metric a state-agency reviewer reads). Absent ⇒ the after-hours count REFUSES. */
export type SafetySeamTimeZoneResolver = () => string | null;

/** §8.6 — open one `posted_coordinates_cipher` inside M20's boundary. The DEK never crosses the seam. */
export type SafetyCoordinateDecipher = (
  cipher: Uint8Array,
) => Promise<{ readonly lat: number; readonly lng: number } | null>;

export const defaultSafetySeamOrgResolver: SafetySeamOrgResolver = () =>
  (getRequestContext()?.organizationId ?? "") as OrgId;

/**
 * Refuse a seam call whose `orgId` argument disagrees with the scope RLS pinned. An EMPTY ambient org
 * (no request scope) is not a mismatch — there is nothing to disagree with, and the store below refuses
 * to read unscoped anyway. See the header.
 */
export function assertCallerOrg(orgOf: SafetySeamOrgResolver, orgId: OrgId): void {
  const ambient = orgOf();
  if (ambient !== "" && ambient !== orgId) {
    throw new ChartWardenError(
      "SAFETY_SEAM_ORG_MISMATCH",
      "field-safety seam called with an organization id that is not the caller's scope",
      403,
    );
  }
}

// ── pure oracles the providers compose (exported so §9.1 can pin them without a store) ────────────────

/**
 * The nearest-rank percentile over an unsorted sample, in the sample's own units. Nearest-rank rather
 * than an interpolating variant because §9.7's response-time target is asserted against an OBSERVED
 * alert, and an interpolated value is a latency no SOS actually had. An EMPTY sample answers 0, which is
 * safe only because an unreadable store throws before reaching this function.
 */
export function percentileOf(samples: readonly number[], percentile: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((percentile / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] as number;
}

/** `numerator / denominator`, or 0 when the denominator is 0. Every §4.3 method that uses it also ships
 *  the denominator, so a consumer can never mistake "0 over nothing" for "0 over a hundred". */
export function rateOf(counts: {
  readonly numerator: number;
  readonly denominator: number;
}): number {
  return counts.denominator === 0 ? 0 : counts.numerator / counts.denominator;
}

/** `count` per hundred visits, or 0 when M20 observed no visits. See `observedVisitCount` in ./store.ts
 *  on why that denominator is what M20 can honestly count and why it always ships alongside. */
export function perHundredVisits(count: number, visitCount: number): number {
  return visitCount === 0 ? 0 : (count / visitCount) * 100;
}

/**
 * §8.6 — round to three decimals (~110 m at the equator), the resolution the M32 boundary permits.
 *
 * `Math.round` rather than a truncation so the error is symmetric: truncating always moves a point toward
 * the equator and the prime meridian, which biases every polygon the suggestion model would propose.
 */
export function roundCoordinates(lat: number, lng: number): SafetyRoundedCoordinates {
  return {
    latitude3: Math.round(lat * 1000) / 1000,
    longitude3: Math.round(lng * 1000) / 1000,
  };
}

/**
 * Even-odd ray-cast point-in-polygon over M20-F07's jsonb rings (`[[[lng,lat], …], …]`, WGS-84).
 *
 * The first ring is the outer boundary; any further rings are holes, so a point inside an odd number of
 * rings is inside the polygon and a point inside two (outer + hole) is not. There is no PostGIS
 * (M20-F07 struck it — ARCH-027's stack is pgvector + pgcrypto and M1 is frozen), so this is app-side and
 * pure, which is also what lets §9.1 pin it.
 *
 * A ring with fewer than three points bounds no area and matches nothing rather than throwing: it is a
 * misconfigured polygon, and refusing the whole area query because one saved shape is degenerate would
 * take down a read over data the tenant can fix.
 */
export function pointInPolygon(
  rings: SafetyPolygonRings,
  point: SafetyRoundedCoordinates,
): boolean {
  // GAP-032: the ray-cast itself moved to the leaf `@chartwarden/shared/geo` so M40's PSAP resolver (which may
  // not import M20) shares ONE implementation. This wrapper keeps M20's rounded-coordinate signature.
  return pointInRings(rings, { latitude: point.latitude3, longitude: point.longitude3 });
}

/**
 * §4.3 — map one `safety_check_in_schedule.state` onto M17's four-value badge.
 *
 * The vocabularies are deliberately different sizes. The stored ladder has five members; the badge has
 * four, and `escalated` collapses into `overdue` because M17's day grid renders a visit cell, not an
 * escalation ladder — the rung is the supervisor board's business (§4.2). `superseded` maps to
 * `not_required`: a corrected-away obligation is one nobody owes any more.
 */
export function checkInBadgeForState(state: string): SafetyCheckInBadge {
  switch (state) {
    case "recorded":
      return "recorded";
    case "overdue":
    case "escalated":
      return "overdue";
    case "proposed":
      return "pending";
    default:
      return "not_required";
  }
}

/**
 * §4.3 — the per-visit badge trio from the visit's obligation rows.
 *
 * A visit with NO obligation of a kind gets `not_required`, which is the truth: D2/D3 materialize the
 * cadence per visit, and a 20-minute visit legitimately owes no `mid_visit` prompt (§2.2.1's
 * `midVisitMinVisitDurationMinutes` floor). Several `mid_visit` rows are the ORDINARY case for a
 * 90-minute visit (M20-F04 put `expected_at` in the uniqueness key precisely so they can exist), so the
 * trio's mid cell reports the WORST outstanding one: an answered 11:02 prompt does not clear an
 * unanswered 12:02 prompt, and a grid that showed `recorded` would hide the live one.
 */
export function visitCheckInBadges(
  schedules: readonly SafetyVisitScheduleFacts[],
): SafetyVisitCheckInStatusDto {
  const severity: { readonly [K in SafetyCheckInBadge]: number } = {
    not_required: 0,
    recorded: 1,
    pending: 2,
    overdue: 3,
  };
  const worstOf = (kind: string): SafetyCheckInBadge => {
    let worst: SafetyCheckInBadge = "not_required";
    for (const s of schedules) {
      if (s.kind !== kind) continue;
      const badge = checkInBadgeForState(s.state);
      if (severity[badge] > severity[worst]) worst = badge;
    }
    return worst;
  };
  return {
    preVisit: worstOf("pre_visit"),
    midVisit: worstOf("mid_visit"),
    postVisit: worstOf("post_visit"),
  };
}

/** The §4.3 incident summary DTO from the store's facts. */
export function incidentSummaryOf(facts: SafetyIncidentSummaryFacts): SafetyIncidentSummaryDto {
  return {
    incidentId: facts.incidentId,
    category: facts.category,
    severity: facts.severity,
    lifecycleState: facts.lifecycleState as SafetyIncidentSummaryDto["lifecycleState"],
    occurredAt: facts.occurredAt,
    affectedClinicianMembershipId: facts.affectedClinicianMembershipId,
    visitId: facts.visitId,
    linkedSosAlertId: facts.linkedSosAlertId,
    oshaReportable: facts.oshaReportable,
  };
}

/**
 * §4.3 — resolve one clinician's paging recipients from the active subscription rows that reach her.
 *
 * VACATION FORWARDING IS NOT COSMETIC (§4.3's own note): the DTO carries both the subscribed supervisor
 * AND the forward target, because M36 must deliver to the TARGET while an audit of "who was supposed to
 * be watching" reads the subscriber. A resolver that returned only one of them would either page a
 * supervisor who is on a plane or lose the accountability trail.
 *
 * DEDUPLICATED BY SUPERVISOR, WIDEST SCOPE LOSING. One person may be reached by an `explicit` row AND
 * the org-wide `role` layer; paging the same phone twice for one SOS is noise on the channel that can
 * least afford it. The `explicit` row wins so the reported `scopeKind` is the most specific reason she is
 * on the list, which is what a coverage review reads.
 */
export function supervisorRecipientsFrom(
  subscriptions: readonly {
    readonly supervisorMembershipId: MembershipId;
    readonly scopeKind: "explicit" | "location" | "provider_entity" | "role";
    readonly isVacationForwarding: boolean;
    readonly vacationForwardToMembershipId: MembershipId | null;
  }[],
): readonly SafetySupervisorRecipientDto[] {
  const rank: { readonly [K in SafetySupervisorRecipientDto["scopeKind"]]: number } = {
    explicit: 3,
    location: 2,
    provider_entity: 1,
    role: 0,
  };
  const bySupervisor = new Map<MembershipId, SafetySupervisorRecipientDto>();
  for (const s of subscriptions) {
    const candidate: SafetySupervisorRecipientDto = {
      supervisorMembershipId: s.supervisorMembershipId,
      scopeKind: s.scopeKind,
      isVacationForwarded: s.isVacationForwarding,
      vacationForwardToMembershipId: s.vacationForwardToMembershipId,
    };
    const existing = bySupervisor.get(s.supervisorMembershipId);
    if (existing === undefined || rank[candidate.scopeKind] > rank[existing.scopeKind]) {
      bySupervisor.set(s.supervisorMembershipId, candidate);
    }
  }
  return [...bySupervisor.values()];
}

// ── the seven §4.3 seam implementations ────────────────────────────────────────────────────────────────

/** §2.2.4 — the effective policy, floor merged under the tenant's version row. */
async function resolvePolicy(
  store: SafetySeamStore,
  orgId: OrgId,
  asOfIso: IsoInstant,
): Promise<SafetyPolicyEffectiveDto> {
  const version = await store.policyVersionAt(asOfIso);
  if (version !== null) return mergeEffectivePolicy(orgId, version);
  // No version row for this tenant yet. The FLOOR is what governs it by construction (M20-F03), so the
  // resolver says so rather than failing every threshold read during onboarding. `versionId` is empty:
  // there is no row to pin, and inventing an id would let a write snapshot a version that does not exist.
  return {
    organizationId: orgId,
    versionId: "" as SafetyPolicyVersionId,
    effectiveFrom: new Date(0).toISOString() as IsoInstant,
    effectiveTo: null,
    ...SAFETY_POLICY_FLOOR,
  };
}

/** §4.3 — the ONLY read path to the effective policy (§2.2.4). */
export function createSafetyPolicyProvider(
  store: SafetySeamStore,
  orgOf: SafetySeamOrgResolver = defaultSafetySeamOrgResolver,
  now: () => IsoInstant = () => new Date().toISOString() as IsoInstant,
): SafetyPolicyProvider {
  return {
    async effectivePolicy(orgId, asOfIso) {
      assertCallerOrg(orgOf, orgId);
      return resolvePolicy(store, orgId, asOfIso ?? now());
    },
    async policyAtTime(orgId, atIso) {
      assertCallerOrg(orgOf, orgId);
      return resolvePolicy(store, orgId, atIso);
    },
  };
}

/** §4.3 / §7.8 — who gets paged, and who nobody is watching. */
export function createSafetySupervisorProvider(
  store: SafetySeamStore,
  orgOf: SafetySeamOrgResolver = defaultSafetySeamOrgResolver,
  now: () => IsoInstant = () => new Date().toISOString() as IsoInstant,
): SafetySupervisorProvider {
  return {
    async supervisorsForClinician(orgId, clinicianMembershipId, alertKind) {
      assertCallerOrg(orgOf, orgId);
      const [subjects, subscriptions] = await Promise.all([
        store.coverageSubjects(now()),
        store.activeSubscriptions(),
      ]);
      const subject = subjects.find((s) => s.membershipId === clinicianMembershipId);
      // A clinician the coverage roster does not carry cannot be scope-matched against a `location`,
      // `provider_entity` or `role` row — there is no location list or PE to match on. Only the rows that
      // name her DIRECTLY resolve, and the roster miss is visible as a narrower set rather than as `[]`.
      const reaching = subscriptions.filter((s) =>
        subject === undefined
          ? s.scopeKind === "explicit" &&
            s.clinicianMembershipId === clinicianMembershipId &&
            s.alertKinds.includes(alertKind)
          : subscriptionCovers(s, subject, alertKind),
      );
      return supervisorRecipientsFrom(reaching);
    },

    async coverageGapsForOrg(orgId, asOfIso) {
      assertCallerOrg(orgOf, orgId);
      const [subjects, subscriptions, inactive] = await Promise.all([
        store.coverageSubjects(asOfIso),
        store.activeSubscriptions(),
        store.membershipsWithInactiveSubscriptions(),
      ]);
      // BOTH sides of the forwarding pair are candidates: `coverageGapFor` tests the SUBSCRIBER when the
      // row does not forward and the TARGET when it does, so a set built from forward targets alone would
      // report every non-forwarding subscription as `vacation_forwards_unresolved`.
      const candidates = new Set<MembershipId>();
      for (const s of subscriptions) {
        candidates.add(s.supervisorMembershipId);
        if (s.vacationForwardToMembershipId !== null) {
          candidates.add(s.vacationForwardToMembershipId);
        }
      }
      const activeSupervisorMembershipIds = await store.activeMembershipIds([...candidates]);

      return detectCoverageGaps({
        subjects: subjects.map((s) => ({
          ...s,
          hasInactiveSubscriptions: inactive.has(s.membershipId),
        })),
        activeSubscriptions: subscriptions,
        activeSupervisorMembershipIds,
      });
    },
  };
}

/** §4.3 — M8's encounter-authoring safety context. */
export function createSafetyContextReader(
  store: SafetySeamStore,
  orgOf: SafetySeamOrgResolver = defaultSafetySeamOrgResolver,
): SafetyContextReader {
  return {
    async activeIncidentForVisit(orgId, visitId) {
      assertCallerOrg(orgOf, orgId);
      const facts = await store.openIncidentForVisit(visitId);
      return facts === null ? null : incidentSummaryOf(facts);
    },
    async activeIncidentsForClinicianToday(orgId, clinicianMembershipId, asOfDate) {
      assertCallerOrg(orgOf, orgId);
      const rows = await store.incidentsForClinicianOnDate(clinicianMembershipId, asOfDate);
      return rows.map(incidentSummaryOf);
    },
  };
}

/** §4.3 — M17's per-visit badge trio. */
export function createSafetyCheckInProvider(
  store: SafetySeamStore,
  orgOf: SafetySeamOrgResolver = defaultSafetySeamOrgResolver,
): SafetyCheckInProvider {
  return {
    async checkInStatusForVisit(orgId, visitId) {
      assertCallerOrg(orgOf, orgId);
      return visitCheckInBadges(await store.scheduleFactsForVisit(visitId));
    },
  };
}

/** §4.3 / §8.6 — M32's minimum-necessary incident projection. */
export function createSafetyIncidentReader(
  store: SafetySeamStore,
  orgOf: SafetySeamOrgResolver = defaultSafetySeamOrgResolver,
  decipher?: SafetyCoordinateDecipher,
): SafetyIncidentReader {
  const project = async (facts: SafetyIncidentGeoFacts): Promise<SafetyIncidentMinNecDto> => {
    if (decipher === undefined) {
      throw new ChartWardenError(
        "SAFETY_COORDINATE_DECIPHER_UNBOUND",
        "the §8.6 incident projection cannot resolve coordinates: no tenant-DEK coordinate decipher is bound",
        503,
      );
    }
    const cipher = facts.linkedSosCoordinatesCipher;
    const coords = cipher === null ? null : await decipher(cipher);
    return {
      incidentId: facts.incidentId,
      category: facts.category,
      severity: facts.severity,
      occurredAt: facts.occurredAt,
      roundedCoordinates: coords === null ? null : roundCoordinates(coords.lat, coords.lng),
    };
  };

  return {
    async recentIncidentsForArea(orgId, polygon, sinceIso) {
      assertCallerOrg(orgOf, orgId);
      const rows = await store.incidentGeoFactsSince(sinceIso);
      const projected = await Promise.all(rows.map(project));
      // A freestanding incident has no geography and cannot be inside any polygon — see the note on
      // `SafetyIncidentMinNecDto`. It is dropped, not defaulted to the polygon's centroid.
      return projected.filter(
        (dto) => dto.roundedCoordinates !== null && pointInPolygon(polygon, dto.roundedCoordinates),
      );
    },
    async recentIncidentsForClinician(orgId, clinicianMembershipId, sinceIso) {
      assertCallerOrg(orgOf, orgId);
      const rows = await store.incidentGeoFactsForClinicianSince(clinicianMembershipId, sinceIso);
      return Promise.all(rows.map(project));
    },
  };
}

/** §4.3 — M30 / M33 aggregates. Every rate ships WITH its denominator; see the store header. */
export function createSafetyMetricsProvider(
  store: SafetySeamStore,
  orgOf: SafetySeamOrgResolver = defaultSafetySeamOrgResolver,
  timeZoneOf: SafetySeamTimeZoneResolver = () => null,
): SafetyMetricsProvider {
  const windowed = async <T>(orgId: OrgId, read: () => Promise<T>): Promise<T> => {
    assertCallerOrg(orgOf, orgId);
    return read();
  };

  return {
    async getSosFrequency(orgId, providerEntityId, window) {
      return windowed(orgId, async () => {
        const [count, visitCount] = await Promise.all([
          store.sosCount(providerEntityId, window),
          store.observedVisitCount(providerEntityId, window),
        ]);
        return { count, perHundredVisits: perHundredVisits(count, visitCount), visitCount };
      });
    },

    async getOverdueRate(orgId, providerEntityId, window) {
      return windowed(orgId, async () => {
        const counts = await store.overdueCounts(providerEntityId, window);
        return { rate: rateOf(counts), sampleSize: counts.denominator };
      });
    },

    async getIncidentRate(orgId, providerEntityId, window) {
      return windowed(orgId, async () => {
        const [count, visitCount] = await Promise.all([
          store.incidentCount(providerEntityId, window),
          store.observedVisitCount(providerEntityId, window),
        ]);
        return {
          rate: visitCount === 0 ? 0 : count / visitCount,
          perHundredVisits: perHundredVisits(count, visitCount),
          visitCount,
        };
      });
    },

    async getResponseTimeMedian(orgId, providerEntityId, window) {
      return windowed(orgId, async () => {
        const samples = await store.sosResponseSeconds(providerEntityId, window);
        return {
          medianSeconds: percentileOf(samples, 50),
          p95Seconds: percentileOf(samples, 95),
          sampleSize: samples.length,
        };
      });
    },

    async getCheckInComplianceRate(orgId, providerEntityId, window) {
      return windowed(orgId, async () => {
        const counts = await store.checkInComplianceCounts(providerEntityId, window);
        return { rate: rateOf(counts), sampleSize: counts.denominator };
      });
    },

    async getAfterHoursSosCount(orgId, providerEntityId, window) {
      return windowed(orgId, async () => {
        const timeZone = timeZoneOf();
        if (timeZone === null) {
          // See {@link SafetySeamTimeZoneResolver}. Counting against UTC would report a Pacific agency's
          // 22:30 presses as business-hours and the number a reviewer reads would be wrong by a shift.
          throw new ChartWardenError(
            "SAFETY_SEAM_ORG_TIME_ZONE_UNRESOLVED",
            "the after-hours SOS count needs the organization's IANA time zone and none is bound",
            503,
          );
        }
        const samples = await store.afterHoursSosSamples(providerEntityId, window);
        // The window comes off the policy version the ALERT pinned, never today's — `isAfterHours`
        // (../lifecycle/policy) owns the midnight-wrapping disjunction, so there is exactly one
        // implementation of the D14 rule.
        const count = samples.filter((s) =>
          isAfterHours(
            {
              afterHoursStartHour: s.afterHoursStartHour,
              afterHoursEndHour: s.afterHoursEndHour,
            },
            s.postedAt,
            timeZone,
          ),
        ).length;
        return { count };
      });
    },
  };
}

/**
 * §4.2 / §4.3 — the supervisor live-awareness board.
 *
 * The composition is: M20's own rows (obligations, presses, check-ins) merged with the cross-module
 * enrichment `../consumers/seam-context` resolves through M17 / M18 / M5. The enrichment reads are
 * three-valued by construction there and every one of them DEGRADES to a null cell rather than failing
 * the board: a clinician's safety row must not disappear because M5 was slow. The M20-owned half is what
 * propagates — see the fail-posture block in the header.
 */
export function createSafetyDashboardProvider(
  store: SafetySeamStore,
  orgOf: SafetySeamOrgResolver = defaultSafetySeamOrgResolver,
  signals?: SafetyClinicianSignalCache,
): SafetyDashboardProvider {
  const compose = async (
    orgId: OrgId,
    memberships: readonly MembershipId[],
    asOfIso: IsoInstant,
  ): Promise<SafetyDashboardSnapshot> => {
    const [facts, policy, shiftLocations] = await Promise.all([
      store.boardFactsForMemberships(memberships, asOfIso),
      resolvePolicy(store, orgId, asOfIso),
      readOrgShiftLocations(orgId),
    ]);

    const clinicians: SafetyClinicianStatusDto[] = [];
    for (const row of facts) {
      const visit = await readCurrentVisitForClinician(orgId, row.membershipId);
      const currentVisitId = visit.kind === "in_visit" ? visit.visitId : null;
      const currentPatientFirstName =
        visit.kind === "in_visit" ? await readPatientFirstName(orgId, visit.patientId) : null;

      // One org-wide EVV read serves the whole board; the per-clinician call is only the fallback for a
      // membership the shift read did not carry. `null` from the shift read is M18 not answering — every
      // row then renders its location cell as unknown, rather than as "we never heard from any of them".
      let lastKnownLocation: SafetyClinicianStatusDto["lastKnownLocation"] = null;
      if (shiftLocations === null) {
        const read = await readLastKnownLocation({
          orgId,
          membershipId: row.membershipId,
          nowIso: asOfIso,
          currentVisitId,
        });
        lastKnownLocation = read.kind === "location" ? read.location : null;
      } else {
        const sample = shiftLocations.get(row.membershipId);
        lastKnownLocation =
          sample === undefined ? null : lastKnownLocationFrom(sample, asOfIso, currentVisitId);
      }

      const overdueState =
        row.nextExpectedCheckInAt === null
          ? "on_time"
          : overdueBadgeFor({
              minutesOverdue: minutesPastExpected(row.nextExpectedCheckInAt, asOfIso),
              windowMinutes: row.nextExpectedWindowMinutes ?? 0,
              tier: overdueTierAt({
                expectedAt: row.nextExpectedCheckInAt,
                atIso: asOfIso,
                policy,
              }),
            });

      clinicians.push({
        membershipId: row.membershipId,
        displayName: row.displayName,
        currentVisitId,
        currentPatientFirstName,
        lastKnownLocation,
        lastCheckInAt: row.lastCheckInAt,
        lastCheckInStatus: row.lastCheckInStatus,
        nextExpectedCheckInAt: row.nextExpectedCheckInAt,
        overdueState,
        activeSosAlert: row.activeSosAlert,
        // See the header: D12 has no address source, so this is `null` rather than "clear".
        inHighRiskArea: null,
        gpsSpoofSuspected: signals?.gpsSpoofSuspected(orgId, row.membershipId, asOfIso) ?? false,
      });
    }

    return {
      clinicians,
      // Computed over the SAME snapshot as `clinicians`, so the tiles and the grid can never disagree.
      activeSosCount: clinicians.filter((c) => c.activeSosAlert !== null).length,
      overdueCount: clinicians.filter(
        (c) => c.overdueState === "overdue" || c.overdueState === "escalated",
      ).length,
      fetchedAt: asOfIso,
    };
  };

  return {
    async clinicianStatusForLocation(orgId, locationId: LocationId, asOfIso) {
      assertCallerOrg(orgOf, orgId);
      const subjects = await store.coverageSubjects(asOfIso);
      const inScope = subjects
        .filter((s) => s.locationIds.includes(locationId))
        .map((s) => s.membershipId);
      return compose(orgId, inScope, asOfIso);
    },

    async clinicianStatusForSupervisor(orgId, supervisorMembershipId, asOfIso) {
      assertCallerOrg(orgOf, orgId);
      const [subjects, subscriptions] = await Promise.all([
        store.coverageSubjects(asOfIso),
        store.activeSubscriptions(),
      ]);
      // THE BOARD IS THE PAGING SCOPE, not the RBAC scope. §4.3 asks "which clinicians does THIS
      // supervisor watch", and the row that answers it is the subscription (§2.2.5 / D8) — the same row
      // that decides who her phone rings for. A supervisor may be entitled to SEE a wider board (that is
      // RBAC + ABAC, deliberately independent per the `safety_supervisor_subscription` header); this
      // method is the narrower question, and answering it with the RBAC set would put clinicians on her
      // board whose SOS will never reach her.
      const mine = subscriptions.filter((s) => s.supervisorMembershipId === supervisorMembershipId);
      const inScope = subjects
        .filter((subject) => mine.some((s) => subscriptionCovers(s, subject)))
        .map((s) => s.membershipId);
      return compose(orgId, inScope, asOfIso);
    },
  };
}
