// apps/backend/src/modules/14-idg/seams/store.ts — M14-T05 the data PORT the §4.8 seam providers
// (IdgPacketProvider + IdgDecisionProvider + IdgScheduleProvider) compose over, plus an in-memory slice for
// tests / boot-without-DB. The providers (./providers.ts) are pure orchestration over this port; production
// injects a Drizzle-backed store that reads M14's `idg_patient_packet` / `idg_decision` / `idg_meeting` rows
// under the CONSUMER's `withOrgContext` — the providers never switch tenants; RLS scopes every read by
// `app.org_id` (§3.6). Mirrors the M9/M10/M11/M12/M13 read-seam store precedents.
//
// All three M14 seams are READ-only (no mutate path — M14 owns the meeting/decision/packet lifecycle internally
// and never writes through a seam). Reads project the read-only DTO shapes from @wardenx/types (never Drizzle
// rows); the SUD-redacted packet layer is applied by M14 at packet read (W-SUD-01) before the snapshot crosses
// the seam — the raw free-text PHI NEVER crosses.
import type {
  AdmissionId,
  CarePlanId,
  DisciplineKey,
  DisciplineViewBlock,
  IdgDecisionDto,
  IdgMeetingDigest,
  IdgMeetingId,
  IdgMeetingStatus,
  IdgPatientPacketId,
  IsoInstant,
  LocationId,
  PacketSnapshot,
  PatientId,
} from "@wardenx/types";

/** A built packet the store resolves — the snapshot + per-discipline views + the two-layer cover + freeze
 * stamp. `IdgPacketProvider.getPacketSnapshot` projects this directly; `renderPayloadFor` wraps it with the
 * meeting/patient ids and the schema version. */
export interface StoredIdgPacket {
  readonly packetId: IdgPatientPacketId;
  readonly meetingId: IdgMeetingId;
  readonly patientId: string;
  readonly snapshot: PacketSnapshot;
  readonly disciplineViews: Record<DisciplineKey, DisciplineViewBlock>;
  readonly coverSummaryLayer1: string;
  readonly coverSummaryLayer2: string | null;
  readonly frozenAt: IsoInstant | null;
}

/** The 15-day-cadence-adherence rollup `IdgScheduleProvider.getCadenceAdherence` reads (M30 measure): the
 * admission day count, the count of completed IDG reviews, and the longest gap between consecutive reviews. */
export interface IdgCadenceAdherence {
  readonly admissionId: AdmissionId;
  readonly admissionDayCount: number;
  readonly reviewCount: number;
  readonly longestGapDays: number;
}

/**
 * The data port the §4.8 seam providers compose over. Read methods return read-only DTO shapes (never Drizzle
 * rows); the Drizzle adapter projects rows to these under the consumer's RLS context. Reads key on `packetId` /
 * `carePlanId` / `meetingId` / `locationId` / `admissionId` — the org is already pinned by RLS — and return an
 * empty slice / null when the subject has no visible rows under the consumer's tenant.
 */
export interface IdgSeamStore {
  // ── packet reads (IdgPacketProvider) ───────────────────────────────────────────────────────────────────
  packetById(packetId: IdgPatientPacketId): Promise<StoredIdgPacket | null>;
  // ── decision reads (IdgDecisionProvider) ───────────────────────────────────────────────────────────────
  decisionsForCarePlan(carePlanId: CarePlanId): Promise<ReadonlyArray<IdgDecisionDto>>;
  decisionsForMeeting(meetingId: IdgMeetingId): Promise<ReadonlyArray<IdgDecisionDto>>;
  // ── schedule reads (IdgScheduleProvider) ───────────────────────────────────────────────────────────────
  meetingsForLocation(
    locationId: LocationId,
    range: { fromIso: IsoInstant; toIso: IsoInstant },
  ): Promise<ReadonlyArray<IdgMeetingDigest>>;
  cadenceForAdmission(admissionId: AdmissionId): Promise<IdgCadenceAdherence | null>;
  /**
   * Most recent ADJOURNED meeting (real `actual_start`) with a FROZEN packet for the patient, in the
   * explicit org's tenant context; null when none. Id + instant + status only.
   */
  lastMeetingForPatient(
    organizationId: string,
    patientId: PatientId,
  ): Promise<{ meetingId: IdgMeetingId; heldAt: IsoInstant; status: IdgMeetingStatus } | null>;
  /** One meeting's link facts (id, status, scheduled start, location) in the explicit org; null when absent. */
  meetingForLink(
    organizationId: string,
    meetingId: string,
  ): Promise<{
    id: IdgMeetingId;
    status: IdgMeetingStatus;
    scheduledStart: IsoInstant;
    locationId: string;
  } | null>;
  /**
   * ORG-LEVEL IDG meeting-cadence tally over a SCHEDULED-START window — M30's `idg_cadence_adherence`
   * input. Denominator = meetings scheduled to start inside the window (the cycles that came due);
   * numerator = those actually convened within their scheduled slot. Aggregate counts only (D6).
   */
  cadenceCountsForOrg(
    organizationId: string,
    window: { from: string; to: string },
  ): Promise<{ numerator: number; denominator: number }>;
}

// ── in-memory slice store ─────────────────────────────────────────────────────────────────────────────────

/** A decision seed row keyed by the care plan it updates (the by-care-plan read filters per call; the DTO
 * itself carries no `carePlanId` — M14's `idg_decision` row links to the care-plan version internally). */
export interface IdgDecisionSeedRow {
  readonly carePlanId: CarePlanId;
  readonly decision: IdgDecisionDto;
}

/** Deterministic, I/O-free seed for the in-memory {@link IdgSeamStore} (slice + seam tests). */
export interface IdgSeamSeed {
  /** Built packet rows the packet reads resolve. */
  readonly packets?: readonly StoredIdgPacket[];
  /** Decision rows, each keyed by the care plan it updated (for the by-care-plan read). */
  readonly decisions?: readonly IdgDecisionSeedRow[];
  /** Meeting digests the schedule reads resolve (filtered by location + range per call). */
  readonly meetings?: readonly IdgMeetingDigest[];
  /** Cadence-adherence rollups keyed by their `admissionId`. */
  readonly cadence?: readonly IdgCadenceAdherence[];
  /** Per-patient last-meeting rows the by-patient read resolves (slice default: none). */
  /** Meetings the by-id link reads resolve. */
  readonly linkMeetings?: ReadonlyArray<{
    readonly organizationId: string;
    readonly id: IdgMeetingId;
    readonly status: IdgMeetingStatus;
    readonly scheduledStart: IsoInstant;
    readonly locationId: string;
  }>;
  readonly lastMeetings?: ReadonlyArray<{
    readonly organizationId: string;
    readonly patientId: PatientId;
    readonly meetingId: IdgMeetingId;
    readonly heldAt: IsoInstant;
    readonly status: IdgMeetingStatus;
  }>;
}

/** An in-memory {@link IdgSeamStore} for the slice/tests — no DB, deterministic, RLS-free. */
export function createInMemoryIdgSeamStore(seed: IdgSeamSeed = {}): { store: IdgSeamStore } {
  const packets = new Map<IdgPatientPacketId, StoredIdgPacket>(
    (seed.packets ?? []).map((p) => [p.packetId, p]),
  );
  const decisions = seed.decisions ?? [];
  const meetings = seed.meetings ?? [];
  const cadence = new Map<AdmissionId, IdgCadenceAdherence>(
    (seed.cadence ?? []).map((c) => [c.admissionId, c]),
  );

  return {
    store: {
      async packetById(packetId) {
        return packets.get(packetId) ?? null;
      },
      async decisionsForCarePlan(carePlanId) {
        return decisions.filter((d) => d.carePlanId === carePlanId).map((d) => d.decision);
      },
      async decisionsForMeeting(meetingId) {
        return decisions.filter((d) => d.decision.meetingId === meetingId).map((d) => d.decision);
      },
      async meetingsForLocation(locationId, range) {
        return meetings.filter(
          (m) =>
            m.locationId === locationId &&
            m.scheduledStart >= range.fromIso &&
            m.scheduledStart <= range.toIso,
        );
      },
      async cadenceForAdmission(admissionId) {
        return cadence.get(admissionId) ?? null;
      },
      async lastMeetingForPatient(organizationId, patientId) {
        const rows = (seed.lastMeetings ?? [])
          .filter((r) => r.organizationId === organizationId && r.patientId === patientId)
          .sort((a, b) => (a.heldAt < b.heldAt ? 1 : -1));
        const top = rows[0];
        return top ? { meetingId: top.meetingId, heldAt: top.heldAt, status: top.status } : null;
      },
      async meetingForLink(organizationId, meetingId) {
        const m = (seed.linkMeetings ?? []).find(
          (r) => r.organizationId === organizationId && r.id === meetingId,
        );
        return m
          ? {
              id: m.id,
              status: m.status,
              scheduledStart: m.scheduledStart,
              locationId: m.locationId,
            }
          : null;
      },
      /** Slice default: 0/0 — M30's kernel SUPPRESSES rather than scoring perfect cadence. */
      async cadenceCountsForOrg() {
        return { numerator: 0, denominator: 0 };
      },
    },
  };
}
