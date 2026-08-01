// apps/backend/src/modules/19-oncall/seams/store.ts — M19-T06, the data PORT the five §4.3 published
// seams (`OnCallProvider` · `TriageCallReader` · `TriageCallProvider` · `PortalTriageReader` ·
// `TriageCallMetricsProvider`) compose over, plus an in-memory slice for tests / a boot without a DB.
//
// The providers (./providers.ts) are pure orchestration over this port; production injects the
// Drizzle-backed store (./store-drizzle.ts), which reads M19's rows under the CONSUMER's ambient request
// context — the providers never switch tenants; RLS scopes every read by `app.org_id` (§3.5). This is the
// M9…M18 / M21 read-seam store precedent.
//
// THREE SHAPES HERE DELIBERATELY DO NOT MATCH THEIR SEAM DTO, each for a reason worth stating:
//
//  1. METRICS ARE COUNTS, NEVER RATES. `hospitalizationAvoidanceCounts` and
//     `afterHoursVisitConversionCounts` return `{numerator, denominator}`; the providers divide. M30's
//     `ratioResult()` suppresses a measure below the CMS reportable floor, and that suppression IS the
//     public-reporting rule — a bare rate cannot express it and back-computing a denominator publishes a
//     number CMS requires withheld (the M15-T05 / M30 lesson, and why §4.3's rate methods grew `*Counts`
//     siblings at M19-T01).
//
//  2. THE P95 PORT RETURNS SAMPLES, NOT A PERCENTILE. `responseLatencySeconds` hands back the raw
//     per-call latencies and `percentileOf` (a pure function in ./providers.ts) computes p95. Pushing
//     `percentile_cont` into SQL would put the one number a §9.7 performance target is asserted against
//     somewhere no unit test can reach, and the volume argument does not bite: a triage call is a
//     human-answered phone call at after-hours volume (tens per agency per night), not an event stream.
//
//  3. COVERAGE GAP IS INTERVALS IN, MINUTES OUT. `rnCoverageWindows` returns the covering `clinical_rn`
//     shift intervals per ProviderEntity and `coverageGapMinutesOf` (pure) does the interval arithmetic.
//     The subtle part is the DENOMINATOR: a gap is only a gap for a ProviderEntity that is supposed to be
//     covered, so the port also returns the org's PE ids. An org with no PEs has no gap; a PE with no
//     shifts at all has a gap for the WHOLE window, which is the truth a survey finding is written from.
//
// PORTAL PROJECTION. `portalCallRows` returns the narrow row shape §5.3 permits and NOTHING else — no
// disposition enum, no risk band (D11 excludes the advisory), no vendor-handoff detail (D13), no protocol
// answers, no escalation tiers, no clinician free text. The lay-language rendering happens in the
// provider (`portalSummaryOf`), so the oracle is one pure function a test can pin, not SQL.
import type {
  IsoInstant,
  MeasureCounts,
  OnCallShiftDto,
  OnCallShiftId,
  OrderRecordId,
  PatientId,
  ProviderEntityId,
  TriageCallCallerKind,
  TriageCallDigest,
  TriageCallFeatureDto,
  TriageCallId,
  TriageCallPacketSlice,
  TriageDisposition,
  TriageEscalationTier,
  TriageMetricsWindow,
} from "@wardenx/types";

/** One covering `clinical_rn` shift interval, as the coverage-gap arithmetic needs it. */
export interface RnCoverageWindow {
  readonly providerEntityId: ProviderEntityId;
  readonly fromIso: IsoInstant;
  readonly toIso: IsoInstant;
}

/** The per-PE coverage picture over a window: who must be covered, and when they were. */
export interface RnCoverageRead {
  /** Every ProviderEntity in the org — the DENOMINATOR. Empty ⇒ no coverage obligation, no gap. */
  readonly providerEntityIds: readonly ProviderEntityId[];
  readonly windows: readonly RnCoverageWindow[];
}

/**
 * The row behind one portal care-log entry. Deliberately NOT `PortalTriageSummary`: the DTO carries
 * `dispositionSummaryLay`, which is rendered prose, and rendering it in SQL would put the family-facing
 * wording out of reach of the §9.1 lay-language oracle.
 */
export interface PortalTriageCallRow {
  readonly triageCallId: TriageCallId;
  readonly occurredAt: IsoInstant;
  readonly callerKind: TriageCallCallerKind;
  readonly callerRelationshipLabel: string | null;
  readonly disposition: TriageDisposition | null;
}

/** One escalation-tier tally straight off the ledger (the provider shapes it into the §4.3 DTO). */
export interface EscalationTierTally {
  readonly tier: TriageEscalationTier;
  readonly count: number;
}

/** One chief-complaint tally, keyed on the protocol CATALOG entry (never a tenant's free text). */
export interface ChiefComplaintTally {
  readonly protocolKey: string;
  readonly chiefComplaintLabel: string;
  readonly count: number;
}

/**
 * The §4.3 data port. Every method is scoped to the CALLER's org by RLS, never by an argument — the seam
 * signatures take an `orgId` because §4.3 says so, and the providers assert it against the ambient scope
 * rather than using it to select rows (see `assertCallerOrg` in ./providers.ts).
 */
export interface OncallSeamStore {
  // ── OnCallProvider ─────────────────────────────────────────────────────────────────────────────────
  /** Shifts covering `asOfIso` for one ProviderEntity, `active` first. Empty ⇒ a real coverage gap. */
  shiftsCoveringForProviderEntity(
    providerEntityId: ProviderEntityId,
    asOfIso: IsoInstant,
  ): Promise<readonly OnCallShiftDto[]>;
  /** Every `active` shift covering `asOfIso` across the org — M36's channel re-sync read. */
  activeShiftsAt(asOfIso: IsoInstant): Promise<readonly OnCallShiftDto[]>;
  /** The user id behind a membership, for the `OnCallActor` membership arm. Missing ⇒ absent from the map. */
  userIdsForMemberships(
    membershipIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>>;

  // ── TriageCallReader ───────────────────────────────────────────────────────────────────────────────
  callFeaturesForPatientSince(
    patientId: PatientId,
    sinceIso: IsoInstant,
  ): Promise<readonly TriageCallFeatureDto[]>;
  callDigestsForPatientSince(
    patientId: PatientId,
    sinceIso: IsoInstant,
  ): Promise<readonly TriageCallDigest[]>;

  // ── TriageCallProvider ─────────────────────────────────────────────────────────────────────────────
  /** The full §4.3 packet slice, or null when the id does not resolve IN THE CALLER'S ORG. */
  packetSlice(triageCallId: TriageCallId): Promise<TriageCallPacketSlice | null>;
  /** The call + shift a verbal order was taken on. Null ⇒ the order was not taken during a triage call. */
  triageContextForVerbalOrder(verbalOrderId: OrderRecordId): Promise<{
    readonly triageCallId: TriageCallId;
    readonly onCallShiftId: OnCallShiftId;
  } | null>;

  // ── PortalTriageReader ─────────────────────────────────────────────────────────────────────────────
  portalCallRows(
    patientId: PatientId,
    sinceIso: IsoInstant,
  ): Promise<readonly PortalTriageCallRow[]>;

  // ── TriageCallMetricsProvider ──────────────────────────────────────────────────────────────────────
  /** Per-call seconds from `opened_at` to `first_response_at` over the window (see header note 2). */
  responseLatencySeconds(window: TriageMetricsWindow): Promise<readonly number[]>;
  /** Calls that did NOT end in an ED transfer / GIP proposal, over all dispositioned calls. */
  hospitalizationAvoidanceCounts(window: TriageMetricsWindow): Promise<MeasureCounts>;
  /** Calls that produced a visit (now or first-light), over all dispositioned calls. */
  afterHoursVisitConversionCounts(window: TriageMetricsWindow): Promise<MeasureCounts>;
  escalationTierTallies(window: TriageMetricsWindow): Promise<readonly EscalationTierTally[]>;
  chiefComplaintTallies(window: TriageMetricsWindow): Promise<readonly ChiefComplaintTally[]>;
  rnCoverage(window: TriageMetricsWindow): Promise<RnCoverageRead>;
}

/** The rows an in-memory slice is seeded from (tests / a boot without a DB). */
export interface OncallSeamSeed {
  readonly shifts?: readonly OnCallShiftDto[];
  /** membershipId → userId, for the `OnCallActor` membership arm. */
  readonly membershipUserIds?: Readonly<Record<string, string>>;
  /** Keyed by patient id. */
  readonly featuresByPatient?: Readonly<Record<string, readonly TriageCallFeatureDto[]>>;
  readonly digestsByPatient?: Readonly<Record<string, readonly TriageCallDigest[]>>;
  readonly portalRowsByPatient?: Readonly<Record<string, readonly PortalTriageCallRow[]>>;
  readonly packets?: readonly TriageCallPacketSlice[];
  /** verbalOrderId → the triage context it was taken in. */
  readonly verbalOrderContexts?: Readonly<
    Record<string, { readonly triageCallId: TriageCallId; readonly onCallShiftId: OnCallShiftId }>
  >;
  readonly responseLatencySeconds?: readonly number[];
  readonly hospitalizationAvoidance?: MeasureCounts;
  readonly afterHoursVisitConversion?: MeasureCounts;
  readonly escalationTierTallies?: readonly EscalationTierTally[];
  readonly chiefComplaintTallies?: readonly ChiefComplaintTally[];
  readonly rnCoverage?: RnCoverageRead;
}

/** The handle a slice hands back (there is nothing to assert on the WRITE side — all five seams read). */
export interface InMemoryOncallSeamStore {
  readonly store: OncallSeamStore;
}

const EMPTY_COUNTS: MeasureCounts = { numerator: 0, denominator: 0 };

const withinShift = (shift: OnCallShiftDto, asOfIso: IsoInstant): boolean =>
  shift.shiftStartsAt <= asOfIso && asOfIso < shift.shiftEndsAt;

/**
 * An in-memory {@link OncallSeamStore} over a plain seed — the test seam and the boot-without-DB default.
 *
 * A slice answers `[]` / `null` / zeroed counts because the SLICE has nothing, which is a different fact
 * from the seam being unreachable. That distinction is why the composition root registers the deny-stubs
 * (which throw) when no DB client is present rather than this slice: an empty roster from here would read
 * to M36 as a genuine coverage gap. See `registerOncallSeams` in ./index.ts.
 */
export function createInMemoryOncallSeamStore(seed: OncallSeamSeed = {}): InMemoryOncallSeamStore {
  const shifts = seed.shifts ?? [];
  const membershipUserIds = new Map(Object.entries(seed.membershipUserIds ?? {}));
  const packets = new Map((seed.packets ?? []).map((p) => [p.triageCallId, p]));
  const verbalOrderContexts = new Map(Object.entries(seed.verbalOrderContexts ?? {}));

  const store: OncallSeamStore = {
    async shiftsCoveringForProviderEntity(providerEntityId, asOfIso) {
      return shifts
        .filter((s) => s.providerEntityId === providerEntityId && withinShift(s, asOfIso))
        .sort((a, b) => (a.status === b.status ? 0 : a.status === "active" ? -1 : 1));
    },
    async activeShiftsAt(asOfIso) {
      return shifts.filter((s) => s.status === "active" && withinShift(s, asOfIso));
    },
    async userIdsForMemberships(membershipIds) {
      const out = new Map<string, string>();
      for (const id of membershipIds) {
        const userId = membershipUserIds.get(id);
        if (userId !== undefined) out.set(id, userId);
      }
      return out;
    },
    async callFeaturesForPatientSince(patientId, sinceIso) {
      return (seed.featuresByPatient?.[patientId] ?? []).filter((f) => f.openedAt >= sinceIso);
    },
    async callDigestsForPatientSince(patientId, sinceIso) {
      return (seed.digestsByPatient?.[patientId] ?? []).filter((d) => d.openedAt >= sinceIso);
    },
    async packetSlice(triageCallId) {
      return packets.get(triageCallId) ?? null;
    },
    async triageContextForVerbalOrder(verbalOrderId) {
      return verbalOrderContexts.get(verbalOrderId) ?? null;
    },
    async portalCallRows(patientId, sinceIso) {
      return (seed.portalRowsByPatient?.[patientId] ?? []).filter((r) => r.occurredAt >= sinceIso);
    },
    async responseLatencySeconds() {
      return seed.responseLatencySeconds ?? [];
    },
    async hospitalizationAvoidanceCounts() {
      return seed.hospitalizationAvoidance ?? EMPTY_COUNTS;
    },
    async afterHoursVisitConversionCounts() {
      return seed.afterHoursVisitConversion ?? EMPTY_COUNTS;
    },
    async escalationTierTallies() {
      return seed.escalationTierTallies ?? [];
    },
    async chiefComplaintTallies() {
      return seed.chiefComplaintTallies ?? [];
    },
    async rnCoverage() {
      return seed.rnCoverage ?? { providerEntityIds: [], windows: [] };
    },
  };

  return { store };
}

export { EMPTY_COUNTS as EMPTY_MEASURE_COUNTS };
