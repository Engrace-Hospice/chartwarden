// apps/backend/src/modules/14-idg/seams/providers.ts — M14-T05 the §4.8 seam implementations: pure
// orchestration over an injected {@link IdgSeamStore}. Each returns the leaf-typed seam interface
// (@wardenx/types) the M1 registry validates and M22/M28/M30/M33 resolve. The providers add NO tenant logic —
// RLS scopes every store read by the consumer's `app.org_id` (§3.6); they project store rows to the read DTOs
// and derive the read-side signals (the 15-day-cadence longest-gap compliance verdict; the M22 deterministic
// render payload assembled from the frozen snapshot). All three seams are READ-only — M14 owns the
// meeting/decision/packet lifecycle internally and never mutates through a seam. Mirrors the M9/M10/M11/M12/M13
// read-seam provider precedents.
import type {
  IdgDecisionProvider,
  IdgPacketProvider,
  IdgPacketRenderPayload,
  IdgScheduleProvider,
} from "@wardenx/types";
import type { IdgSeamStore } from "./store";

/** The platform 15-day per-patient review floor (§2.2 / M14-F01): a cadence is compliant when no gap between
 * consecutive completed reviews exceeds 15 days. */
const IDG_CADENCE_FLOOR_DAYS = 15 as const;

/**
 * §4.8 IdgPacketProvider over the store — the packet-snapshot + M22 render handshake M22 (minutes/packet PDF)
 * and M33 (dashboards) consume. Pure projection; the SUD-redacted layer (W-SUD-01) is applied by M14 at packet
 * build/read before the snapshot reaches the store, so the seam never re-derives redaction. RLS pins the tenant.
 */
export function createIdgPacketProvider(store: IdgSeamStore): IdgPacketProvider {
  return {
    async getPacketSnapshot(_orgId, packetId) {
      const packet = await store.packetById(packetId);
      if (packet === null) return null;
      return {
        snapshot: packet.snapshot,
        disciplineViews: packet.disciplineViews,
        coverSummaryLayer1: packet.coverSummaryLayer1,
        coverSummaryLayer2: packet.coverSummaryLayer2,
        frozenAt: packet.frozenAt,
      };
    },
    async renderPayloadFor(packetId) {
      const packet = await store.packetById(packetId);
      // The M22 render path pulls a built, frozen packet by id — an unknown id is a contract violation (M22 only
      // renders packets M14 emitted a `packet.render_requested` for), so it fails LOUD rather than null.
      if (packet === null) {
        throw new Error(`IdgPacketProvider.renderPayloadFor: packet '${packetId}' not found`);
      }
      const payload: IdgPacketRenderPayload = {
        packetId: packet.packetId,
        meetingId: packet.meetingId,
        patientId: packet.patientId,
        schemaVersion: "2026-01-v1",
        snapshot: packet.snapshot,
        disciplineViews: packet.disciplineViews,
        coverSummaryLayer1: packet.coverSummaryLayer1,
        coverSummaryLayer2: packet.coverSummaryLayer2,
      };
      return payload;
    },
  };
}

/**
 * §4.8 IdgDecisionProvider over the store — the decision read path M30 (decision-to-careplan-update latency
 * measure) and M33 consume. Pure projection; RLS pins the tenant.
 */
export function createIdgDecisionProvider(store: IdgSeamStore): IdgDecisionProvider {
  return {
    async getDecisionsForCarePlan(_orgId, carePlanId) {
      return [...(await store.decisionsForCarePlan(carePlanId))];
    },
    async getDecisionsForMeeting(_orgId, meetingId) {
      return [...(await store.decisionsForMeeting(meetingId))];
    },
  };
}

/** Fail closed on a blank org/id rather than querying with an empty predicate. */
function assertNonBlank(orgId: string, id: string): void {
  if (!orgId.trim() || !id.trim()) {
    throw new Error("IdgScheduleProvider: organizationId and id are required");
  }
}

/**
 * §4.8 IdgScheduleProvider over the store — the meeting-schedule + 15-day-cadence read path M28 (FHIR
 * `CareTeam`/`Encounter`) + M30 (cadence-adherence measure) + M33 consume. Pure projection + the cadence-floor
 * compliance derivation; RLS pins the tenant.
 */
export function createIdgScheduleProvider(store: IdgSeamStore): IdgScheduleProvider {
  return {
    async listMeetingsForLocation(_orgId, locationId, range) {
      return [...(await store.meetingsForLocation(locationId, range))];
    },
    async getCadenceCountsForOrg(organizationId, window) {
      return store.cadenceCountsForOrg(organizationId, window);
    },
    async getLastMeetingForPatient(orgId, patientId) {
      const last = await store.lastMeetingForPatient(orgId, patientId);
      return last === null ? null : { ...last, asOf: new Date().toISOString() };
    },
    async linkSummary(orgId, id) {
      assertNonBlank(orgId, id);
      const m = await store.meetingForLink(orgId, id);
      // patientId is ALWAYS null: a meeting has no patient (patients link via packets); M36 special-cases it.
      return m === null
        ? null
        : { id: m.id, patientId: null, status: m.status, occurredAt: m.scheduledStart };
    },
    async meetingLocation(orgId, meetingId) {
      assertNonBlank(orgId, meetingId);
      return (await store.meetingForLink(orgId, meetingId))?.locationId ?? null;
    },
    async getCadenceAdherence(_orgId, admissionId) {
      const rollup = await store.cadenceForAdmission(admissionId);
      // A null-safe shape when the admission has no visible IDG context under the consumer's tenant: zero
      // reviews over zero days is vacuously compliant (no breach has occurred yet).
      if (rollup === null) {
        return { admissionDayCount: 0, reviewCount: 0, longestGapDays: 0, isCompliant: true };
      }
      return {
        admissionDayCount: rollup.admissionDayCount,
        reviewCount: rollup.reviewCount,
        longestGapDays: rollup.longestGapDays,
        isCompliant: rollup.longestGapDays <= IDG_CADENCE_FLOOR_DAYS,
      };
    },
  };
}
