// apps/backend/src/modules/18-evv/routes/service.ts — M18-T06 the §4.1 route service contract + an in-memory
// slice (Drizzle-backed in prod under `withOrgContext` so RLS backstops every read/write by `app.org_id`).
//
// The service is the single place the §4.1 handlers compose over. It also implements {@link EvvAbacResolver}
// (the §4.7 capture predicates resolve the visit's assigned membership + scheduled window from the SAME
// dataset). The aggregator submission resubmit/cancel paths drive the pure §2.2.5 D7 state machine
// (`transitionAggregatorSubmission`); the missing-resolution attest/override paths drive the pure §2.2.4 D6
// machine (`transitionMissingResolution`). Every patient-touching read is org-pinned; the in-memory slice
// filters by `organizationId` exactly as RLS would.
//
// The in-memory slice is intentionally narrow — it backs the route guards + the aggregator/resolution lifecycle
// (the task headline) deterministically for tests; the full geofence/device-attestation capture pipeline is the
// pure domain (M18-T03/T04) the production service wires under one transaction.
import {
  ConflictError,
  type EvvAggregatorSubmissionDto,
  type EvvAggregatorSubmissionStatus,
  type EvvBracketDto,
  type EvvDevicePlatform,
  type EvvDeviceStatus,
  type EvvEventDto,
  type EvvEventGpsQuality,
  type EvvEventKind,
  type EvvMissingResolutionKind,
  type EvvMissingResolutionStatus,
  ForbiddenError,
  NotFoundError,
} from "@wardenx/types";
import {
  DEFAULT_EVV_WINDOW_AFTER_MS,
  DEFAULT_EVV_WINDOW_BEFORE_MS,
  type EvvAbacResolver,
  type EvvCaptureWindow,
} from "../abac-predicates";
import {
  type EvvCaptureAuthority,
  assertCaptureAllowed,
  selectBoundDevice,
} from "../capture-guards";
import {
  type EvvAggregatorSubmissionEvent,
  transitionAggregatorSubmission,
} from "../domain/aggregator-submission";
import { type CorrectionInput, correctEvent } from "../domain/event-lifecycle";
import {
  type EvvMissingResolutionEvent,
  transitionMissingResolution,
} from "../domain/missing-resolution";

// ── view shapes returned to the route layer (coordinate-free except the team-location read, D10) ──────────
export interface CheckResultView {
  readonly eventId: string;
  readonly kind: EvvEventKind;
  readonly gpsQuality: EvvEventGpsQuality;
  readonly geofenceDecision: "pass" | "fail_distance" | "fail_accuracy" | "fail_no_baseline";
  readonly visitStateAfterEvent: string | null;
}
export interface DeviceView {
  readonly id: string;
  readonly membershipId: string;
  readonly platform: EvvDevicePlatform;
  readonly modelDescription: string;
  readonly status: EvvDeviceStatus;
}
export interface GeofencePolicyView {
  readonly tenant: { readonly radiusM: number; readonly maxAccuracyM: number };
  readonly perAddress: ReadonlyArray<{
    readonly patientAddressId: string;
    readonly radiusM: number;
    readonly maxAccuracyM: number;
  }>;
}
export interface MissingResolutionView {
  readonly id: string;
  readonly visitId: string;
  readonly kind: EvvMissingResolutionKind;
  readonly status: EvvMissingResolutionStatus;
  readonly resolvedByMembershipId: string | null;
}
export interface MetricsView {
  readonly complianceRate: number;
  readonly lateCheckoutRate: number;
  readonly geofenceDeviationRate: number;
  readonly gpsSpoofingDetectedRate: number;
  readonly aggregatorSubmissionSuccessRate: number;
}
export interface LocationView {
  readonly membershipId: string;
  readonly eventId: string;
  readonly visitId: string;
  /** GAP-032 — NULL when the stored coordinate is absent or unparseable. Previously a non-nullable
   *  `number` that the production service always filled with `0`, so a caller could not tell a real
   *  coordinate from "not recovered"; an explicit null is the honest third state. */
  readonly lat: number | null;
  readonly lng: number | null;
  readonly accuracyM: number;
  readonly capturedAt: string;
}
export interface ArrivalView {
  readonly visitId: string;
  readonly arrivedAt: string | null;
  readonly departedAt: string | null;
}

// ── seed rows for the in-memory slice / tests ─────────────────────────────────────────────────────────
export interface EvvVisitSeed {
  readonly organizationId: string;
  readonly visitId: string;
  readonly patientId: string;
  readonly assignedMembershipId: string;
  readonly scheduledStartedAt: string;
  readonly scheduledEndedAt: string;
}
export interface EvvAggregatorSubmissionSeed {
  readonly organizationId: string;
  readonly id: string;
  readonly visitId: string;
  readonly stateCode: string;
  readonly aggregatorVendor: string;
  readonly status: EvvAggregatorSubmissionStatus;
  readonly aggregatorTransactionId?: string | null;
  readonly attemptCount?: number;
}
export interface EvvMissingResolutionSeed {
  readonly organizationId: string;
  readonly id: string;
  readonly visitId: string;
  readonly kind: EvvMissingResolutionKind;
  readonly status: EvvMissingResolutionStatus;
  readonly checkInAt?: string;
  readonly visitDate?: string;
}
export interface EvvDeviceSeed {
  readonly organizationId: string;
  readonly id: string;
  readonly membershipId: string;
  readonly status: EvvDeviceStatus;
  readonly attestationId: string | null;
}
export interface EvvServiceSeed {
  readonly devices?: readonly EvvDeviceSeed[];
  readonly visits?: readonly EvvVisitSeed[];
  readonly submissions?: readonly EvvAggregatorSubmissionSeed[];
  readonly resolutions?: readonly EvvMissingResolutionSeed[];
}

interface DeviceRow extends DeviceView {
  readonly organizationId: string;
  /** `evv_device.m2_device_attestation_id` — never part of the {@link DeviceView}. */
  readonly attestationId: string | null;
}
interface SubmissionRow {
  organizationId: string;
  id: string;
  visitId: string;
  stateCode: string;
  aggregatorVendor: string;
  status: EvvAggregatorSubmissionStatus;
  aggregatorTransactionId: string | null;
  attemptCount: number;
}
interface ResolutionRow {
  organizationId: string;
  id: string;
  visitId: string;
  kind: EvvMissingResolutionKind;
  status: EvvMissingResolutionStatus;
  resolvedByMembershipId: string | null;
  checkInAt: string | null;
  visitDate: string | null;
}
interface EventRow {
  organizationId: string;
  id: string;
  visitId: string;
  patientId: string;
  kind: EvvEventKind;
  postingMembershipId: string;
  capturedAt: string;
  gpsQuality: EvvEventGpsQuality;
  lat: number;
  lng: number;
  accuracyM: number;
  /** §7.7 correction chain. `replacesEventId` on the correction, `supersededByEventId` on the original. */
  replacesEventId: string | null;
  supersededByEventId: string | null; // stamped in place when a correction supersedes this row
}

/** A monotonic in-memory id minter (deterministic per prefix; production mints uuids). */
function idMinter(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}-${(++n).toString().padStart(8, "0")}`;
}

/** Per-tenant geofence policy (platform floor seeded; tenant tighten-only). */
const PLATFORM_FLOOR = { radiusM: 200, maxAccuracyM: 50 } as const;

export class EvvRouteService implements EvvAbacResolver {
  private readonly visits = new Map<string, EvvVisitSeed>();
  private readonly events: EventRow[] = [];
  private readonly devices: DeviceRow[] = [];
  private readonly submissions = new Map<string, SubmissionRow>();
  private readonly resolutions = new Map<string, ResolutionRow>();
  private readonly tenantPolicy = new Map<string, { radiusM: number; maxAccuracyM: number }>();
  private readonly perAddress: Array<{
    organizationId: string;
    patientAddressId: string;
    radiusM: number;
    maxAccuracyM: number;
  }> = [];
  private readonly captureWindows = new Map<string, EvvCaptureWindow>();
  private readonly nextEventId = idMinter("evvevt");
  private readonly nextDeviceId = idMinter("evvdev");
  private readonly nextOverrideId = idMinter("evvovr");

  /** GAP-055 follow-up: attestation + session-device binding enforced? Injected from server config; default off. */
  private readonly deviceAttestationEnforced: boolean;

  constructor(
    seed: EvvServiceSeed = {},
    options: { readonly deviceAttestationEnforced?: boolean } = {},
  ) {
    this.deviceAttestationEnforced = options.deviceAttestationEnforced ?? false;
    for (const v of seed.visits ?? []) this.visits.set(v.visitId, v);
    for (const d of seed.devices ?? [])
      this.devices.push({
        organizationId: d.organizationId,
        id: d.id,
        membershipId: d.membershipId,
        platform: "ios",
        modelDescription: "seeded",
        status: d.status,
        attestationId: d.attestationId,
      });
    for (const s of seed.submissions ?? []) {
      this.submissions.set(s.id, {
        organizationId: s.organizationId,
        id: s.id,
        visitId: s.visitId,
        stateCode: s.stateCode,
        aggregatorVendor: s.aggregatorVendor,
        status: s.status,
        aggregatorTransactionId: s.aggregatorTransactionId ?? null,
        attemptCount: s.attemptCount ?? 0,
      });
    }
    for (const r of seed.resolutions ?? []) {
      this.resolutions.set(r.id, {
        organizationId: r.organizationId,
        id: r.id,
        visitId: r.visitId,
        kind: r.kind,
        status: r.status,
        resolvedByMembershipId: null,
        checkInAt: r.checkInAt ?? null,
        visitDate: r.visitDate ?? null,
      });
    }
  }

  // ── EvvAbacResolver (§4.7) ──────────────────────────────────────────────────────────────────────────
  async assignedMembershipForVisit(orgId: string, visitId: string): Promise<string | null> {
    const v = this.visits.get(visitId);
    return v && v.organizationId === orgId ? v.assignedMembershipId : null;
  }
  async visitWindowForVisit(
    orgId: string,
    visitId: string,
  ): Promise<{ scheduledStartedAt: string; scheduledEndedAt: string } | null> {
    const v = this.visits.get(visitId);
    if (!v || v.organizationId !== orgId) return null;
    return { scheduledStartedAt: v.scheduledStartedAt, scheduledEndedAt: v.scheduledEndedAt };
  }
  async captureWindow(orgId: string): Promise<EvvCaptureWindow> {
    return (
      this.captureWindows.get(orgId) ?? {
        beforeMs: DEFAULT_EVV_WINDOW_BEFORE_MS,
        afterMs: DEFAULT_EVV_WINDOW_AFTER_MS,
      }
    );
  }

  // ── capture (§4.1 routes 1–3) ─────────────────────────────────────────────────────────────────────────
  private requireVisit(orgId: string, visitId: string): EvvVisitSeed {
    const v = this.visits.get(visitId);
    if (!v || v.organizationId !== orgId) throw new NotFoundError("visit", visitId);
    return v;
  }

  /** Record a capture event. The route layer has already passed RBAC + the §4.7 capture predicates; this
   * persists the event and computes the gps-quality / geofence verdict from the device accuracy + tenant
   * policy (the in-memory slice models the pass/fail boundary; the full haversine pipeline is the domain). */
  recordCapture(
    orgId: string,
    userId: string,
    kind: EvvEventKind,
    input: {
      visitId: string;
      coords: { lat: number; lng: number };
      accuracyM: number;
      capturedAt: string;
      gpsQualityAttested?: "degraded_attested";
      /** The client's CLAIM of the posting device — only ever compared to the session-bound device. */
      claimedDeviceId?: string;
    },
    authority: EvvCaptureAuthority,
  ): Promise<CheckResultView> {
    return assertCaptureAllowed(
      this,
      orgId,
      userId,
      input,
      authority,
      this.deviceAttestationEnforced,
    ).then(() => {
      this.boundDeviceOf(orgId, userId, input.claimedDeviceId, authority);
      return this.captureUnguarded(orgId, userId, kind, input);
    });
  }

  /** Pre-flight for a batch: refuse a claimed device that is not the session-bound one, before any write. */
  assertCaptureDevice(
    orgId: string,
    userId: string,
    claimedDeviceId: string | undefined,
    authority: EvvCaptureAuthority,
  ): Promise<void> {
    try {
      this.boundDeviceOf(orgId, userId, claimedDeviceId, authority);
      return Promise.resolve();
    } catch (e) {
      return Promise.reject(e);
    }
  }

  private boundDeviceOf(
    orgId: string,
    userId: string,
    claimedDeviceId: string | undefined,
    authority: EvvCaptureAuthority,
  ): string | null {
    const candidates = this.devices
      .filter((d) => d.organizationId === orgId)
      .map((d, index) => ({
        id: d.id,
        membershipId: d.membershipId,
        status: d.status,
        attestationId: d.attestationId,
        approvedAtMs: index, // the in-memory slice has no approval clock: later registration = more recent
      }));
    return selectBoundDevice(
      authority,
      userId,
      claimedDeviceId,
      candidates,
      this.deviceAttestationEnforced,
    );
  }

  /** The capture write with NO §8.2 guards — only `recordCapture` (guarded) and `correctEvent` reach it. */
  private captureUnguarded(
    orgId: string,
    userId: string,
    kind: EvvEventKind,
    input: {
      visitId: string;
      coords: { lat: number; lng: number };
      accuracyM: number;
      capturedAt: string;
      gpsQualityAttested?: "degraded_attested";
      /** Set only by {@link EvvRouteService.correctEvent} — the event this one supersedes (§7.7). */
      replacesEventId?: string;
    },
  ): CheckResultView {
    const visit = this.requireVisit(orgId, input.visitId);
    const policy = this.tenantPolicy.get(orgId) ?? PLATFORM_FLOOR;
    let gpsQuality: EvvEventGpsQuality;
    let decision: CheckResultView["geofenceDecision"];
    if (input.accuracyM > policy.maxAccuracyM) {
      gpsQuality = input.gpsQualityAttested ?? "outside_geofence";
      decision = input.gpsQualityAttested ? "pass" : "fail_accuracy";
    } else {
      gpsQuality = input.accuracyM <= policy.maxAccuracyM / 2 ? "high" : "acceptable";
      decision = "pass";
    }
    const id = this.nextEventId();
    this.events.push({
      organizationId: orgId,
      id,
      visitId: input.visitId,
      patientId: visit.patientId,
      kind,
      postingMembershipId: userId,
      capturedAt: input.capturedAt,
      gpsQuality,
      lat: input.coords.lat,
      lng: input.coords.lng,
      accuracyM: input.accuracyM,
      replacesEventId: input.replacesEventId ?? null,
      supersededByEventId: null,
    });
    return {
      eventId: id,
      kind,
      gpsQuality,
      geofenceDecision: decision,
      visitStateAfterEvent: kind === "check_in" ? "in_visit" : "completed",
    };
  }

  listEvents(
    orgId: string,
    f: { visit?: string; clinician?: string; patient?: string; kind?: EvvEventKind },
  ): EvvEventDto[] {
    return this.events
      .filter((e) => e.organizationId === orgId)
      .filter((e) => (f.visit ? e.visitId === f.visit : true))
      .filter((e) => (f.clinician ? e.postingMembershipId === f.clinician : true))
      .filter((e) => (f.patient ? e.patientId === f.patient : true))
      .filter((e) => (f.kind ? e.kind === f.kind : true))
      .map((e) => this.toEventDto(e));
  }

  getEvent(orgId: string, eventId: string): EvvEventDto {
    const e = this.events.find((x) => x.organizationId === orgId && x.id === eventId);
    if (!e) throw new NotFoundError("evv_event", eventId);
    return this.toEventDto(e);
  }

  /**
   * §7.7 correction-of-record — supersede one event with a corrected one.
   *
   * The route used to call {@link recordCapture} directly and throw the `:eventId` param and the
   * `correctionReason` away (F-068 §1), so a "correction" was an ordinary second capture: it linked to
   * nothing, superseded nothing, emitted no `m18.evv.event_corrected`, reopened no resolution, and
   * accepted both a correction of an already-corrected event and a check-out offered as the correction
   * of a check-in. Against the real per-leaf `UNIQUE (organization_id, visit_id, kind)` backstop it also
   * could not succeed — two live events for one leg.
   *
   * NEITHER COULD THIS ONE, until 0236 (F-088). That index defined ACTIVE as `superseded_by_event_id IS
   * NULL` — a column holding the id of the row that replaces this one, so it cannot be set until that
   * row exists, so both rows were active at the instant of the insert and Postgres refused it (23505).
   * The write path was always written for the fix — it stamps `superseded_at` first — and 0236 keys the
   * predicate on that marker instead.
   *
   * The decision is the pure {@link correctEvent} machine, which has been sitting in
   * `domain/event-lifecycle.ts` complete and uncalled; this method applies the effects it declares.
   */
  correctEvent(
    orgId: string,
    userId: string,
    originalEventId: string,
    input: {
      kind: EvvEventKind;
      visitId: string;
      coords: { lat: number; lng: number };
      accuracyM: number;
      capturedAt: string;
      gpsQualityAttested?: "degraded_attested";
      correctionReason: string;
      stepUpVerified: boolean;
    },
  ): CheckResultView {
    const original = this.events.find(
      (e) => e.organizationId === orgId && e.id === originalEventId,
    );
    if (!original) throw new NotFoundError("evv_event", originalEventId);
    const decision: CorrectionInput = {
      originalEventId,
      originalKind: original.kind,
      originalSupersededByEventId: original.supersededByEventId,
      newKind: input.kind,
      correctionReason: input.correctionReason,
      stepUpVerified: input.stepUpVerified,
    };
    // Throws EVV_CORRECTION_STEP_UP_REQUIRED / _REASON_TOO_SHORT / EVV_EVENT_ALREADY_SUPERSEDED /
    // _KIND_MISMATCH — the four refusals the route never had.
    correctEvent(decision);
    const result = this.captureUnguarded(orgId, userId, input.kind, {
      visitId: input.visitId,
      coords: input.coords,
      accuracyM: input.accuracyM,
      capturedAt: input.capturedAt,
      gpsQualityAttested: input.gpsQualityAttested,
      replacesEventId: originalEventId,
    });
    original.supersededByEventId = result.eventId;
    return result;
  }

  private toEventDto(e: EventRow): EvvEventDto {
    return {
      id: e.id,
      organizationId: e.organizationId,
      visitId: e.visitId,
      patientId: e.patientId,
      kind: e.kind,
      serviceTypeCode: "",
      postingMembershipId: e.postingMembershipId,
      postingDisciplineAtRecording: "",
      evvDeviceId: "",
      capturedAt: e.capturedAt,
      recordedAt: e.capturedAt,
      gpsQuality: e.gpsQuality,
      offlineCapture: false,
      replacesEventId: e.replacesEventId,
      supersededByEventId: e.supersededByEventId,
    };
  }

  bracketForVisit(orgId: string, visitId: string): EvvBracketDto {
    this.requireVisit(orgId, visitId);
    const evts = this.events.filter(
      (e) => e.organizationId === orgId && e.visitId === visitId && e.supersededByEventId === null,
    );
    const checkIn = evts.find((e) => e.kind === "check_in") ?? null;
    const checkOut = evts.find((e) => e.kind === "check_out") ?? null;
    const open = [...this.resolutions.values()].find(
      (r) => r.organizationId === orgId && r.visitId === visitId && r.status === "open",
    );
    const bracketState: EvvBracketDto["bracketState"] =
      checkIn && checkOut ? "present" : open ? "missing_open" : "no_evv_path";
    return {
      visitId,
      checkInEvent: checkIn ? this.toEventDto(checkIn) : null,
      checkOutEvent: checkOut ? this.toEventDto(checkOut) : null,
      bracketState,
      missingResolution: null,
    };
  }

  // ── devices (§4.1 routes 8–12) ───────────────────────────────────────────────────────────────────────
  listDevices(orgId: string, membership?: string): DeviceView[] {
    return this.devices
      .filter((d) => d.organizationId === orgId)
      .filter((d) => (membership ? d.membershipId === membership : true))
      .map(({ organizationId: _o, attestationId: _a, ...v }) => v);
  }
  selfRegisterDevice(
    orgId: string,
    userId: string,
    body: { platform: EvvDevicePlatform; modelDescription: string },
    sessionAttestationId: string | null = null,
  ): DeviceView {
    const row: DeviceRow = {
      organizationId: orgId,
      id: this.nextDeviceId(),
      membershipId: userId,
      platform: body.platform,
      modelDescription: body.modelDescription,
      status: "pending_approval",
      attestationId: sessionAttestationId,
    };
    this.devices.push(row);
    const { organizationId: _o, attestationId: _a, ...v } = row;
    return v;
  }
  private transitionDevice(orgId: string, id: string, status: EvvDeviceStatus): DeviceView {
    const d = this.devices.find((x) => x.organizationId === orgId && x.id === id);
    if (!d) throw new NotFoundError("evv_device", id);
    (d as { status: EvvDeviceStatus }).status = status;
    const { organizationId: _o, attestationId: _a, ...v } = d;
    return v;
  }
  // The four device-lifecycle transitions take the ACTING membership and (where the schema has a column
  // for it) the reason. Both used to stop at the route: `reason` was validated by typebox and dropped,
  // and the production service filled `approved_by_membership_id` / `rejected_by_membership_id` from an
  // arbitrary `LIMIT 1` membership in the org (F-068 §4) — a row asserting that a NAMED colleague
  // approved the device. The slice keeps neither, but it carries both so the signature the Drizzle
  // implementation must satisfy is the one that has somewhere to put them.
  approveDevice(orgId: string, _userId: string, id: string): DeviceView {
    return this.transitionDevice(orgId, id, "approved");
  }
  rejectDevice(orgId: string, _userId: string, id: string, _reason: string): DeviceView {
    return this.transitionDevice(orgId, id, "rejected");
  }
  suspendDevice(orgId: string, _userId: string, id: string, _reason: string): DeviceView {
    return this.transitionDevice(orgId, id, "suspended");
  }
  retireDevice(orgId: string, _userId: string, id: string, _reason?: string): DeviceView {
    return this.transitionDevice(orgId, id, "retired");
  }

  // ── geofence policy (§4.1 routes 13–15) ──────────────────────────────────────────────────────────────
  getGeofencePolicy(orgId: string): GeofencePolicyView {
    return {
      tenant: this.tenantPolicy.get(orgId) ?? PLATFORM_FLOOR,
      perAddress: this.perAddress
        .filter((p) => p.organizationId === orgId)
        .map(({ organizationId: _o, ...v }) => v),
    };
  }
  /** §2.2.2 tighten-only: the tenant may NARROW (smaller radius / tighter accuracy) below the platform floor,
   * never loosen above it. */
  editTenantPolicy(
    orgId: string,
    _userId: string,
    body: { radiusM: number; maxAccuracyM: number },
  ): GeofencePolicyView {
    if (body.radiusM > PLATFORM_FLOOR.radiusM || body.maxAccuracyM > PLATFORM_FLOOR.maxAccuracyM) {
      throw new ConflictError(
        "Tenant geofence policy may not loosen beyond the platform floor (tighten-only).",
      );
    }
    this.tenantPolicy.set(orgId, { radiusM: body.radiusM, maxAccuracyM: body.maxAccuracyM });
    return this.getGeofencePolicy(orgId);
  }
  createPerAddressOverride(
    orgId: string,
    _userId: string,
    body: {
      patientAddressId: string;
      radiusM: number;
      maxAccuracyM: number;
      /** ≥30 chars, `evv_geofence_policy.override_reason`; DENYLISTED from audit (§3.6). */
      overrideReason: string;
    },
  ): GeofencePolicyView {
    const existing = this.perAddress.findIndex(
      (p) => p.organizationId === orgId && p.patientAddressId === body.patientAddressId,
    );
    const row = {
      organizationId: orgId,
      patientAddressId: body.patientAddressId,
      radiusM: body.radiusM,
      maxAccuracyM: body.maxAccuracyM,
    };
    if (existing >= 0) this.perAddress[existing] = row;
    else this.perAddress.push(row);
    void this.nextOverrideId();
    return this.getGeofencePolicy(orgId);
  }

  // ── missing-EVV resolution (§4.1 routes 16–18; §2.2.4 D6 machine) ─────────────────────────────────────
  listMissingResolutions(
    orgId: string,
    f: { status?: string; visit?: string },
  ): MissingResolutionView[] {
    return [...this.resolutions.values()]
      .filter((r) => r.organizationId === orgId)
      .filter((r) => (f.status ? r.status === f.status : true))
      .filter((r) => (f.visit ? r.visitId === f.visit : true))
      .map((r) => this.toResolutionView(r));
  }
  private requireResolution(orgId: string, id: string): ResolutionRow {
    const r = this.resolutions.get(id);
    if (!r || r.organizationId !== orgId) throw new NotFoundError("evv_missing_resolution", id);
    return r;
  }
  private hoursSince(iso: string | null): number {
    return iso ? (Date.now() - Date.parse(iso)) / 3_600_000 : 0;
  }
  private daysSince(iso: string | null): number {
    return iso ? (Date.now() - Date.parse(iso)) / 86_400_000 : 0;
  }
  clinicianAttestResolution(
    orgId: string,
    userId: string,
    id: string,
    reason: string,
  ): MissingResolutionView {
    const r = this.requireResolution(orgId, id);
    const assigned = this.visits.get(r.visitId)?.assignedMembershipId ?? null;
    const event: EvvMissingResolutionEvent = {
      type: "clinician_attest",
      callerIsAssignedClinician: assigned === userId,
      hoursSinceCheckIn: this.hoursSince(r.checkInAt),
      reason,
    };
    const t = transitionMissingResolution(r.status, event);
    r.status = t.status;
    r.resolvedByMembershipId = userId;
    return this.toResolutionView(r);
  }
  supervisorOverrideResolution(
    orgId: string,
    userId: string,
    id: string,
    reason: string,
    stepUpFresh: boolean,
  ): MissingResolutionView {
    const r = this.requireResolution(orgId, id);
    const event: EvvMissingResolutionEvent = {
      type: "supervisor_override",
      stepUpVerified: stepUpFresh,
      daysSinceVisit: this.daysSince(r.visitDate),
      reason,
    };
    const t = transitionMissingResolution(r.status, event);
    r.status = t.status;
    r.resolvedByMembershipId = userId;
    return this.toResolutionView(r);
  }
  private toResolutionView(r: ResolutionRow): MissingResolutionView {
    return {
      id: r.id,
      visitId: r.visitId,
      kind: r.kind,
      status: r.status,
      resolvedByMembershipId: r.resolvedByMembershipId,
    };
  }

  // ── per-state aggregator submissions (§4.1 routes 19–21; §2.2.5 D7 machine; §7.8/§7.9) ────────────────
  listAggregatorSubmissions(
    orgId: string,
    f: { stateCode?: string; status?: string },
  ): EvvAggregatorSubmissionDto[] {
    return [...this.submissions.values()]
      .filter((s) => s.organizationId === orgId)
      .filter((s) => (f.stateCode ? s.stateCode === f.stateCode : true))
      .filter((s) => (f.status ? s.status === f.status : true))
      .map((s) => this.toSubmissionDto(s));
  }
  private requireSubmission(orgId: string, id: string): SubmissionRow {
    const s = this.submissions.get(id);
    if (!s || s.organizationId !== orgId) throw new NotFoundError("evv_aggregator_submission", id);
    return s;
  }
  /** §7.9 operator-initiated resubmit (valid only from rejected/timeout → queued; attempt_count++). */
  resubmitSubmission(
    orgId: string,
    _userId: string,
    id: string,
    _reason?: string,
  ): EvvAggregatorSubmissionDto {
    const s = this.requireSubmission(orgId, id);
    return this.applySubmissionEvent(s, { type: "resubmit" });
  }
  /** §4.1 operator-initiated cancel (valid only from a non-terminal status → cancelled). The reason
   * lands in `evv_aggregator_submission.cancellation_reason` and in the `aggregator_cancelled` outbox
   * payload, which used to carry a literal `""` (F-068). */
  cancelSubmission(
    orgId: string,
    _userId: string,
    id: string,
    _reason: string,
  ): EvvAggregatorSubmissionDto {
    const s = this.requireSubmission(orgId, id);
    return this.applySubmissionEvent(s, { type: "cancel" });
  }
  private applySubmissionEvent(
    s: SubmissionRow,
    event: EvvAggregatorSubmissionEvent,
  ): EvvAggregatorSubmissionDto {
    const t = transitionAggregatorSubmission(s.status, event);
    s.status = t.status;
    if (t.incrementsAttempt) s.attemptCount += 1;
    return this.toSubmissionDto(s);
  }
  private toSubmissionDto(s: SubmissionRow): EvvAggregatorSubmissionDto {
    return {
      id: s.id,
      visitId: s.visitId,
      stateCode: s.stateCode,
      aggregatorVendor: s.aggregatorVendor,
      status: s.status,
      aggregatorTransactionId: s.aggregatorTransactionId,
      attemptCount: s.attemptCount,
    };
  }

  // ── metrics + team-location + portal arrival (§4.1 routes 22–24) ─────────────────────────────────────
  metrics(orgId: string): MetricsView {
    const evts = this.events.filter((e) => e.organizationId === orgId);
    const total = evts.length;
    const deviations = evts.filter((e) => e.gpsQuality === "outside_geofence").length;
    const spoof = evts.filter((e) => e.gpsQuality === "suspected_spoof").length;
    const subs = [...this.submissions.values()].filter((s) => s.organizationId === orgId);
    const accepted = subs.filter((s) => s.status === "accepted").length;
    return {
      complianceRate: 1,
      lateCheckoutRate: 0,
      geofenceDeviationRate: total === 0 ? 0 : deviations / total,
      gpsSpoofingDetectedRate: total === 0 ? 0 : spoof / total,
      aggregatorSubmissionSuccessRate: subs.length === 0 ? 1 : accepted / subs.length,
    };
  }
  clinicianCurrentLocation(orgId: string, membership?: string): LocationView[] {
    const byMember = new Map<string, EventRow>();
    for (const e of this.events) {
      if (e.organizationId !== orgId) continue;
      if (membership && e.postingMembershipId !== membership) continue;
      byMember.set(e.postingMembershipId, e); // last wins (insertion order is capture order)
    }
    return [...byMember.values()].map((e) => ({
      membershipId: e.postingMembershipId,
      eventId: e.id,
      visitId: e.visitId,
      lat: e.lat,
      lng: e.lng,
      accuracyM: e.accuracyM,
      capturedAt: e.capturedAt,
    }));
  }
  portalArrival(orgId: string, visitId: string, patientId?: string): ArrivalView {
    const evts = this.events.filter(
      (e) =>
        e.organizationId === orgId &&
        e.visitId === visitId &&
        (patientId === undefined || e.patientId === patientId),
    );
    return {
      visitId,
      arrivedAt: evts.find((e) => e.kind === "check_in")?.capturedAt ?? null,
      departedAt: evts.find((e) => e.kind === "check_out")?.capturedAt ?? null,
    };
  }

  /** Guard helper the correction route uses (Clinical Supervisor + step-up; §2.3). */
  assertStepUp(stepUpFresh: boolean): void {
    if (!stepUpFresh)
      throw new ForbiddenError("A correction-of-record requires fresh M2 step-up auth.");
  }
}

/**
 * The surface `registerEvvRoutes` composes over: every public method of {@link EvvRouteService}, with its
 * return type widened to allow a Promise.
 *
 * The two implementations differ in exactly one way — the in-memory slice is synchronous and the Drizzle
 * one is not — and `createDbEvvBackend` used to bridge that with `return backend as unknown as
 * EvvRouteService`. A double assertion takes EVERY divergence with it, not just the async one, and that
 * is how the production implementation came to accept fewer parameters than the routes had to give it: a
 * `reason` the route validated and dropped, an acting membership resolved on the line above and never
 * passed, a correction-of-record calling plain capture (F-068 §5).
 *
 * What naming the widening buys, precisely: a missing or renamed method and a wrong return shape become
 * compile errors. It does NOT catch an implementation that ignores a trailing parameter — TypeScript
 * accepts a function of fewer parameters wherever one of more is expected, and that is the shape the
 * dropped reasons were in. The compiler closes the half it can; the suite closes the other.
 */
export type EvvRoutePort = {
  [K in keyof EvvRouteService]: EvvRouteService[K] extends (...args: infer A) => infer R
    ? (...args: A) => R | Promise<Awaited<R>>
    : EvvRouteService[K];
};
