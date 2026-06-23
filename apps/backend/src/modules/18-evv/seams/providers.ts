// apps/backend/src/modules/18-evv/seams/providers.ts — M18-T05 the §4.3 seam implementations: pure
// orchestration over an injected {@link EvvSeamStore}. Each returns the leaf-typed seam interface (@wardenx/types)
// the M1 registry validates and M8/M20/M23/M24/M25/M30/M31/M33 resolve. The providers add NO tenant logic — RLS
// scopes every store read by the consumer's `app.org_id` (§3.6); they project store rows to the read DTOs and do
// the read-side rate math (vacuous-window handling). All six seams are READ-only — M18 owns the EVV lifecycle
// internally and never mutates through a seam. Mirrors the M9/M10/M11/M12/M13/M14/M17 read-seam provider precedents.
//
// The sixth seam, `EvvBracketResolver`, is published over M8's EXISTING `resolveBracket` contract (M18-T01 GOTCHA:
// M8 leaf-typed `EvvBracketResolver`/`EvvBracketResolution` in encounter.ts as its forward seam; re-declaring it
// would be a TS2308 collision, so M18 publishes the impl against that contract — the richer internal `EvvBracketDto`
// projection from the store is mapped down to `EvvBracketResolution` here). Per M8 D9 the resolver returns null when
// no EVV events bracket the visit, so M8's `evv_missing_reason` ≥20-char fallback path stays operative.
import type {
  EvvAggregatorReferenceReader,
  EvvBracketDto,
  EvvBracketResolution,
  EvvBracketResolver,
  EvvBracketState,
  EvvComplianceReader,
  EvvLocationProvider,
  EvvMetricsProvider,
  EvvVerificationProvider,
} from "@wardenx/types";
import type { EvvSeamStore } from "./store";

/** Map the richer §4.3 internal bracket DTO down to M8's `EvvBracketResolution` contract (D9). Returns null when
 * the visit has no EVV events to bracket it (`missing_open` / `no_evv_path` / no placeholder) so M8's
 * documented-missing fallback (`evv_missing_reason` ≥20 chars → `evv_missing_documented`) becomes operative. A
 * complete bracket reifies `evv_present` with the AUTHORITATIVE check-in/out instants (clinician-entered times
 * never override, D9); a documented-missing bracket reifies `evv_missing_documented` with whatever event ids exist. */
function toBracketResolution(bracket: EvvBracketDto | null): EvvBracketResolution | null {
  if (bracket === null) return null;
  if (bracket.bracketState !== "present" && bracket.bracketState !== "missing_documented") {
    return null; // missing_open / no_evv_path → M8's fallback path owns it
  }
  const state: EvvBracketState =
    bracket.bracketState === "present" ? "evv_present" : "evv_missing_documented";
  return {
    checkInEventId: bracket.checkInEvent?.id ?? null,
    checkOutEventId: bracket.checkOutEvent?.id ?? null,
    startedAt: bracket.checkInEvent?.capturedAt ?? null,
    endedAt: bracket.checkOutEvent?.capturedAt ?? null,
    bracketState: state,
  };
}

/**
 * §4.3 EvvBracketResolver over the store — published over M8's EXISTING `resolveBracket` contract (the
 * "is the visit EVV-bracketed" read M8 consumes at encounter authoring + sign, closing M8's `encounter.period`
 * forward seam, M8 D9). Pure projection; RLS pins the tenant.
 */
export function createEvvBracketResolver(store: EvvSeamStore): EvvBracketResolver {
  return {
    async resolveBracket({ visitId }) {
      return toBracketResolution(await store.bracketForVisit(visitId));
    },
  };
}

/**
 * §4.3 EvvComplianceReader over the store — the billing pre-submission gate M23/M24 read ("is this visit
 * EVV-compliant for billing") + the M30 HQRP compliance-rate measure. Per ADR-0008 only `unresolved_missing`
 * blocks billing — `documented_missing` is allowed and EVV is NEVER a Medicare claim gate. Pure projection.
 */
export function createEvvComplianceReader(store: EvvSeamStore): EvvComplianceReader {
  return {
    async bracketStateForVisit(_orgId, visitId) {
      return store.complianceStateForVisit(visitId);
    },
    async complianceRateForWindow(_orgId, windowIso, filters) {
      return store.complianceCountsForWindow(windowIso, filters);
    },
  };
}

/**
 * §4.3 EvvAggregatorReferenceReader over the store — the per-state aggregator transaction-id back-link M24
 * (Medicaid claim builder populates the state-required aggregator id) + M25 (denial-categorization back-links a
 * rejected claim to the submission) read. `aggregatorIdForVisit` returns null until a submission has an accepted
 * transaction id; the full submission row is the M25 read. Pure projection; RLS pins the tenant.
 */
export function createEvvAggregatorReferenceReader(store: EvvSeamStore): EvvAggregatorReferenceReader {
  return {
    async aggregatorIdForVisit(_orgId, visitId) {
      const submission = await store.submissionForVisit(visitId);
      if (submission === null || submission.aggregatorTransactionId === null) return null;
      return {
        aggregatorTransactionId: submission.aggregatorTransactionId,
        stateCode: submission.stateCode,
        aggregatorVendor: submission.aggregatorVendor,
      };
    },
    async submissionForVisit(_orgId, visitId) {
      return store.submissionForVisit(visitId);
    },
  };
}

/**
 * §4.3 EvvLocationProvider over the store — M20 field-safety supervisor live-awareness (the most recent event
 * within the last 12h per clinician). This is the ONLY coordinate-bearing seam (D10); the coordinate read is
 * itself gated by `evv.location.read_team` with audit-prominence at the route (§4.6). Pure projection; RLS pins
 * the tenant; the store applies the 12h recency bound (in SQL for the Drizzle adapter).
 */
export function createEvvLocationProvider(store: EvvSeamStore): EvvLocationProvider {
  return {
    async lastKnownLocationForClinician(_orgId, membershipId) {
      return store.lastKnownLocationForClinician(membershipId);
    },
    async lastKnownLocationsForOrgShift(_orgId) {
      return [...(await store.lastKnownLocationsForOrgShift())];
    },
  };
}

/**
 * §4.3 EvvMetricsProvider over the store — the M30/M33 productivity + quality measures read path. The store
 * returns the window TALLIES; the provider does the rate math so the semantics (vacuous-window handling) live in
 * ONE pure place. Compliance reuses the §4.3 `EvvComplianceDto` breakdown (compliant ÷ total). The
 * "bad-event" rates (late-checkout / geofence-deviation / spoofing) are vacuously 0; the aggregator SUCCESS rate
 * is vacuously 1 (no submissions → no failures). RLS pins the tenant.
 */
export function createEvvMetricsProvider(store: EvvSeamStore): EvvMetricsProvider {
  return {
    async getComplianceRate(_orgId, windowIso) {
      const c = await store.complianceCountsForWindow(windowIso);
      // No billable visits in window → vacuously fully compliant (no non-compliant visit has occurred).
      return c.total === 0 ? 1 : c.compliant / c.total;
    },
    async getLateCheckoutRate(_orgId, windowIso) {
      const m = await store.metricWindowCounts(windowIso);
      return m.totalVisits === 0 ? 0 : m.lateCheckoutVisits / m.totalVisits;
    },
    async getGeofenceDeviationRate(_orgId, windowIso) {
      const m = await store.metricWindowCounts(windowIso);
      return m.totalEvents === 0 ? 0 : m.geofenceDeviationEvents / m.totalEvents;
    },
    async getGpsSpoofingDetectedRate(_orgId, windowIso) {
      const m = await store.metricWindowCounts(windowIso);
      return m.totalEvents === 0 ? 0 : m.suspectedSpoofEvents / m.totalEvents;
    },
    async getAggregatorSubmissionSuccessRate(_orgId, windowIso, filters) {
      const a = await store.aggregatorWindowCounts(windowIso, filters);
      // No submissions in window → vacuously 1 (no failed submission has occurred).
      return a.total === 0 ? 1 : a.accepted / a.total;
    },
    async getDeviceRegistrationCoverage(_orgId) {
      return store.deviceRegistrationCoverage();
    },
  };
}

/**
 * §4.3 EvvVerificationProvider over the store — the M31 portal "Nurse arrived at HH:MM" surface + the post-visit
 * summary. Timestamp + lay identity only; clinician GPS coordinates are NEVER projected to a portal session
 * (D10 / §4.6). Pure projection; RLS pins the tenant; the route additionally authorizes the M39
 * `family_caregiver_access` consent scope before exposing even the timestamp (§4.1).
 */
export function createEvvVerificationProvider(store: EvvSeamStore): EvvVerificationProvider {
  return {
    async arrivalEventForVisit(_orgId, visitId) {
      return store.arrivalForVisit(visitId);
    },
    async visitVerificationSummaryForPortal(_orgId, visitId) {
      return store.verificationSummaryForVisit(visitId);
    },
  };
}
