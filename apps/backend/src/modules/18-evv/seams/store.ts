// apps/backend/src/modules/18-evv/seams/store.ts — M18-T05 the data PORT the §4.3 seam providers
// (the EvvBracketResolver impl + EvvComplianceReader + EvvAggregatorReferenceReader + EvvLocationProvider +
// EvvMetricsProvider + EvvVerificationProvider) compose over, plus an in-memory slice for tests /
// boot-without-DB. The providers (./providers.ts) are pure orchestration over this port; production injects a
// Drizzle-backed store that reads M18's `evv_event` / `evv_missing_resolution` / `evv_aggregator_submission`
// rows under the CONSUMER's `withOrgContext` — the providers never switch tenants; RLS scopes every read by
// `app.org_id` (§3.6). Mirrors the M9/M10/M11/M12/M13/M14/M17 read-seam store precedents.
//
// All six M18 seams are READ-only (no mutate path — M18 owns the EVV lifecycle internally and never writes
// through a seam). Reads project the read-only DTO shapes from @wardenx/types (never Drizzle rows). The GPS
// coordinate (D10, encrypted at rest) crosses ONLY the coordinate-bearing `EvvLocationProvider` projection
// (`EvvLocationDto`); every other projection is coordinate-free — the portal verification surface is
// timestamp-only and the compliance/aggregator/metrics projections carry no coordinates.
import type {
  EvvAggregatorSubmissionDto,
  EvvBracketDto,
  EvvComplianceDto,
  EvvLocationDto,
  IsoInstant,
  MembershipId,
  VisitId,
} from "@wardenx/types";

/** The 4-state billing-compliance verdict `EvvComplianceReader.bracketStateForVisit` returns (§4.3): only
 * `unresolved_missing` blocks billing — `documented_missing` is allowed (in-encounter attestation) and EVV is
 * NEVER a Medicare claim gate (ADR-0008). `not_required` is the open-model "no aggregator / no EVV path" case. */
export type EvvComplianceState =
  | "compliant"
  | "documented_missing"
  | "unresolved_missing"
  | "not_required";

/** The window tallies `EvvMetricsProvider` derives its non-compliance rates from (§4.3). The provider does the
 * division so the rate semantics (vacuous-window handling) live in ONE pure place, not the data port. The
 * compliance rate reuses {@link EvvComplianceDto} (compliant ÷ total); the aggregator success rate has its own
 * filter-bearing counts. Late-checkout is per-visit; geofence-deviation + spoofing are per-event. */
export interface EvvMetricWindowCounts {
  /** Visits whose checkout arrived after the tenant grace window — numerator for getLateCheckoutRate. */
  readonly lateCheckoutVisits: number;
  /** Billable visits in the window — denominator for getLateCheckoutRate. */
  readonly totalVisits: number;
  /** Events flagged `outside_geofence` — numerator for getGeofenceDeviationRate. */
  readonly geofenceDeviationEvents: number;
  /** Events flagged `suspected_spoof` — numerator for getGpsSpoofingDetectedRate. */
  readonly suspectedSpoofEvents: number;
  /** EVV events in the window — denominator for getGeofenceDeviationRate + getGpsSpoofingDetectedRate. */
  readonly totalEvents: number;
}

/** The aggregator-submission tallies `EvvMetricsProvider.getAggregatorSubmissionSuccessRate` divides (§4.3):
 * accepted ÷ total submissions in the window (optionally narrowed to one state's aggregator regime). */
export interface EvvAggregatorWindowCounts {
  /** Submissions that reached `accepted` — numerator. */
  readonly accepted: number;
  /** Submissions attempted in the window — denominator. */
  readonly total: number;
}

/** The device-registration coverage `EvvMetricsProvider.getDeviceRegistrationCoverage` returns (§4.3) — the
 * org-wide non-windowed snapshot (not a rate; the provider returns it as-is). */
export interface EvvDeviceCoverage {
  readonly totalActiveClinicians: number;
  readonly cliniciansWithApprovedDevice: number;
}

/** The portal arrival projection `EvvVerificationProvider.arrivalEventForVisit` returns (§4.3) — timestamp +
 * lay identity only; NEVER coordinates (the portal session never sees a clinician's GPS, D10 / §4.6). */
export interface EvvArrival {
  readonly arrivedAt: IsoInstant;
  readonly clinicianFirstName: string;
  readonly discipline: string;
}

/** The portal post-visit summary `EvvVerificationProvider.visitVerificationSummaryForPortal` returns (§4.3). */
export interface EvvVerificationSummary {
  readonly arrivedAt: IsoInstant;
  readonly departedAt: IsoInstant;
  readonly durationMinutes: number;
}

/**
 * The data port the §4.3 seam providers compose over. Read methods return read-only DTO / projection shapes
 * (never Drizzle rows); the Drizzle adapter projects rows to these under the consumer's RLS context. Reads key
 * on `visitId` / `membershipId` / a window — the org is already pinned by RLS — and return an empty slice / null
 * when the subject has no visible rows under the consumer's tenant.
 */
export interface EvvSeamStore {
  // ── bracket reads (EvvBracketResolver — published over M8's EXISTING `resolveBracket` contract) ───────────
  bracketForVisit(visitId: VisitId): Promise<EvvBracketDto | null>;
  // ── compliance reads (EvvComplianceReader) ───────────────────────────────────────────────────────────────
  complianceStateForVisit(visitId: VisitId): Promise<EvvComplianceState>;
  complianceCountsForWindow(
    window: { from: IsoInstant; to: IsoInstant },
    filters?: { discipline?: string },
  ): Promise<EvvComplianceDto>;
  // ── aggregator reads (EvvAggregatorReferenceReader) ──────────────────────────────────────────────────────
  submissionForVisit(visitId: VisitId): Promise<EvvAggregatorSubmissionDto | null>;
  // ── location reads (EvvLocationProvider — the only coordinate-bearing surface, D10) ───────────────────────
  lastKnownLocationForClinician(membershipId: MembershipId): Promise<EvvLocationDto | null>;
  lastKnownLocationsForOrgShift(): Promise<ReadonlyArray<EvvLocationDto>>;
  // ── metric reads (EvvMetricsProvider) ────────────────────────────────────────────────────────────────────
  metricWindowCounts(window: { from: IsoInstant; to: IsoInstant }): Promise<EvvMetricWindowCounts>;
  aggregatorWindowCounts(
    window: { from: IsoInstant; to: IsoInstant },
    filters?: { stateCode?: string },
  ): Promise<EvvAggregatorWindowCounts>;
  deviceRegistrationCoverage(): Promise<EvvDeviceCoverage>;
  // ── verification reads (EvvVerificationProvider — timestamp only, no coordinates) ─────────────────────────
  arrivalForVisit(visitId: VisitId): Promise<EvvArrival | null>;
  verificationSummaryForVisit(visitId: VisitId): Promise<EvvVerificationSummary | null>;
}

// ── in-memory slice store ─────────────────────────────────────────────────────────────────────────────────

/** A windowed rollup keyed by its [from,to] (the by-window read matches on both bounds, exactly). */
export interface EvvWindowSeedRow<T> {
  readonly window: { from: IsoInstant; to: IsoInstant };
  readonly counts: T;
}

/** An aggregator-window rollup, optionally narrowed to one state (the by-state read matches `stateCode`). */
export interface EvvAggregatorWindowSeedRow {
  readonly window: { from: IsoInstant; to: IsoInstant };
  readonly stateCode?: string;
  readonly counts: EvvAggregatorWindowCounts;
}

/** Deterministic, I/O-free seed for the in-memory {@link EvvSeamStore} (slice + seam tests). */
export interface EvvSeamSeed {
  /** Bracket projections keyed by visit (EvvBracketResolver + the compliance-state default derive from these). */
  readonly brackets?: ReadonlyArray<{ visitId: VisitId; bracket: EvvBracketDto }>;
  /** Explicit billing-compliance verdicts keyed by visit (override the bracket-derived default when present). */
  readonly complianceStates?: ReadonlyArray<{ visitId: VisitId; state: EvvComplianceState }>;
  /** Aggregator submissions keyed by visit (the by-visit reads filter per call). */
  readonly submissions?: ReadonlyArray<{ visitId: VisitId; submission: EvvAggregatorSubmissionDto }>;
  /** Last-known coordinate per clinician (the by-membership + org-shift reads filter per call). */
  readonly locations?: ReadonlyArray<EvvLocationDto>;
  /** Portal arrival projections keyed by visit (timestamp + lay identity only). */
  readonly arrivals?: ReadonlyArray<{ visitId: VisitId; arrival: EvvArrival }>;
  /** Portal post-visit summaries keyed by visit. */
  readonly verificationSummaries?: ReadonlyArray<{ visitId: VisitId; summary: EvvVerificationSummary }>;
  /** Windowed compliance breakdowns (for EvvComplianceReader.complianceRateForWindow + getComplianceRate). */
  readonly complianceWindows?: ReadonlyArray<EvvWindowSeedRow<EvvComplianceDto>>;
  /** Windowed metric tallies (for the late-checkout / geofence-deviation / spoofing rates). */
  readonly metricWindows?: ReadonlyArray<EvvWindowSeedRow<EvvMetricWindowCounts>>;
  /** Windowed aggregator tallies (for the aggregator-submission success rate). */
  readonly aggregatorWindows?: ReadonlyArray<EvvAggregatorWindowSeedRow>;
  /** The org-wide device-registration coverage snapshot. */
  readonly deviceCoverage?: EvvDeviceCoverage;
}

/** Map a richer §4.3 bracket DTO to the default billing-compliance verdict when no explicit state is seeded: a
 * complete bracket is `compliant`; documented-missing maps through; an open missing-resolution blocks; and the
 * no-EVV-path open-model case is `not_required` (ADR-0008 — only `unresolved_missing` blocks). */
function complianceFromBracket(bracket: EvvBracketDto): EvvComplianceState {
  switch (bracket.bracketState) {
    case "present":
      return "compliant";
    case "missing_documented":
      return "documented_missing";
    case "missing_open":
      return "unresolved_missing";
    case "no_evv_path":
      return "not_required";
  }
}

const ZERO_COMPLIANCE: EvvComplianceDto = {
  compliant: 0,
  documentedMissing: 0,
  unresolvedMissing: 0,
  notRequired: 0,
  total: 0,
};

const ZERO_METRICS: EvvMetricWindowCounts = {
  lateCheckoutVisits: 0,
  totalVisits: 0,
  geofenceDeviationEvents: 0,
  suspectedSpoofEvents: 0,
  totalEvents: 0,
};

/** Two windows are the same iff both bounds match exactly (the in-memory rollup lookup; SQL bounds the range). */
function sameWindow(
  a: { from: IsoInstant; to: IsoInstant },
  b: { from: IsoInstant; to: IsoInstant },
): boolean {
  return a.from === b.from && a.to === b.to;
}

/** An in-memory {@link EvvSeamStore} for the slice/tests — no DB, deterministic, RLS-free. */
export function createInMemoryEvvSeamStore(seed: EvvSeamSeed = {}): { store: EvvSeamStore } {
  const brackets = new Map<VisitId, EvvBracketDto>(
    (seed.brackets ?? []).map((b) => [b.visitId, b.bracket]),
  );
  const complianceStates = new Map<VisitId, EvvComplianceState>(
    (seed.complianceStates ?? []).map((c) => [c.visitId, c.state]),
  );
  const submissions = new Map<VisitId, EvvAggregatorSubmissionDto>(
    (seed.submissions ?? []).map((s) => [s.visitId, s.submission]),
  );
  const locations = seed.locations ?? [];
  const arrivals = new Map<VisitId, EvvArrival>(
    (seed.arrivals ?? []).map((a) => [a.visitId, a.arrival]),
  );
  const summaries = new Map<VisitId, EvvVerificationSummary>(
    (seed.verificationSummaries ?? []).map((s) => [s.visitId, s.summary]),
  );
  const complianceWindows = seed.complianceWindows ?? [];
  const metricWindows = seed.metricWindows ?? [];
  const aggregatorWindows = seed.aggregatorWindows ?? [];
  const deviceCoverage = seed.deviceCoverage ?? {
    totalActiveClinicians: 0,
    cliniciansWithApprovedDevice: 0,
  };

  return {
    store: {
      async bracketForVisit(visitId) {
        return brackets.get(visitId) ?? null;
      },
      async complianceStateForVisit(visitId) {
        const explicit = complianceStates.get(visitId);
        if (explicit !== undefined) return explicit;
        const bracket = brackets.get(visitId);
        // No bracket placeholder at all → the visit has no EVV path (open-model / non-EVV service) → not required.
        return bracket ? complianceFromBracket(bracket) : "not_required";
      },
      async complianceCountsForWindow(window) {
        return complianceWindows.find((r) => sameWindow(r.window, window))?.counts ?? ZERO_COMPLIANCE;
      },
      async submissionForVisit(visitId) {
        return submissions.get(visitId) ?? null;
      },
      async lastKnownLocationForClinician(membershipId) {
        return locations.find((l) => l.membershipId === membershipId) ?? null;
      },
      async lastKnownLocationsForOrgShift() {
        return locations;
      },
      async metricWindowCounts(window) {
        return metricWindows.find((r) => sameWindow(r.window, window))?.counts ?? ZERO_METRICS;
      },
      async aggregatorWindowCounts(window, filters) {
        const row = aggregatorWindows.find(
          (r) =>
            sameWindow(r.window, window) &&
            (filters?.stateCode === undefined || r.stateCode === filters.stateCode),
        );
        return row?.counts ?? { accepted: 0, total: 0 };
      },
      async deviceRegistrationCoverage() {
        return deviceCoverage;
      },
      async arrivalForVisit(visitId) {
        return arrivals.get(visitId) ?? null;
      },
      async verificationSummaryForVisit(visitId) {
        return summaries.get(visitId) ?? null;
      },
    },
  };
}
