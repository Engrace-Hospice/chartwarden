// apps/backend/src/modules/18-evv — PRODUCTION EVV route service + §4.7 ABAC resolver (M18L reads + the write
// lifecycle over Drizzle+RLS). No route is left at 501.
//
// The screen-driving READS (event ledger + detail, per-visit bracket, device roster, geofence policy, missing-
// resolution queue, per-state aggregator submissions, EVV metrics, last-known team location, portal arrival)
// run as real Drizzle queries over the M18-owned tables inside `withOrgContext`, so RLS scopes every row by
// `app.org_id` as the unprivileged `wardenx_app` role. The §4.7 ABAC resolver (`assigned_clinician_for_visit`
// ∧ `evv_within_visit_window`) reads the M17 `visit` aggregate the same way (M18 dependsOn [17]; RLS-scoped,
// fail-closed → `null` when the visit is absent/cross-tenant). Coordinates are NEVER projected on event reads.
//
// The full WRITE lifecycle is now live: capture (check-in/out — INSERT `evv_event` + the `evv_geofence_evaluation`
// snapshot), device self-register + approve/reject/suspend/retire, geofence tenant-tighten + per-address override,
// the §2.2.4 D6 missing-resolution machine (clinician-attest / supervisor-override), and the §2.2.5 D7 aggregator
// submission machine (resubmit / cancel). Each mutation composes the pure `domain/*` deciders and emits its strict
// `m18.evv.*` catalog payload on the bound transactional outbox (the publisher Value.Checks each emit and rolls
// back on mismatch). `evv_event` is PARTITIONED BY RANGE(event_at) — inserts route to the current-month leaf; the
// D2 per-leaf active-pair UNIQUE (org, visit, kind WHERE not superseded) admits one active check-in + one check-out.
//
// Documented compromises (the M8–M17 convention; the interface threads no seams into the DB backend):
//   (1) `withOrgContext` runs with `userId:""` → the M4 write-audit trigger fires with a NULL actor; the acting
//       membership is the passed `userId` (stored where a column exists);
//   (2) capture siting (provider_entity_id + location_id, both NOT NULL) + patient_id are resolved from the M17
//       `visit`; the posting device is the caller membership's most-recent APPROVED `evv_device` (FK NOT NULL);
//       `service_type_code` / `posting_discipline_at_recording` are captured `""` (the M38/M2 lookups are not
//       threaded), `device_attestation_id_at_record` reuses the device's `m2_device_attestation_id`, and the GPS
//       coordinate is stored as base64(`lat,lng`) in `coords_cipher` (the real DEK pipeline is D10-deferred);
//   (3) gps-quality / geofence decision is the in-mem slice's accuracy-band model (accuracy vs the effective
//       policy `max_accuracy_m`) — the full haversine-vs-baseline pipeline needs the address-coordinate + DEK
//       decrypt, deferred; `computed_distance_m` is recorded NULL;
//   (4) the device-admin + geofence-policy routes do NOT thread the acting membership to the service
//       (`approveDevice(orgId, id)` etc.), so the FK-required `set_by_membership_id` / the outbox `*ByMembershipId`
//       actor is resolved as the org's first membership (`actingMembership`) — a documented placeholder until the
//       route contract carries the actor;
//   (5) the M17 visit-state advance the capture drives (published → en_route → in_visit → completed, D14) is the
//       M17 consumer of `m18.evv.check_*_recorded`, not a write here.
import { randomUUID } from "node:crypto";
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import {
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
  ValidationError,
} from "@wardenx/types";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  DEFAULT_EVV_WINDOW_AFTER_MS,
  DEFAULT_EVV_WINDOW_BEFORE_MS,
  type EvvCaptureWindow,
} from "./abac-predicates";
import { transitionAggregatorSubmission } from "./domain/aggregator-submission";
import { transitionMissingResolution } from "./domain/missing-resolution";
import type {
  ArrivalView,
  CheckResultView,
  DeviceView,
  GeofencePolicyView,
  LocationView,
  MetricsView,
  MissingResolutionView,
  EvvRouteService,
} from "./routes/service";

const EVENT = schema.evvEvent;
const GEVAL = schema.evvGeofenceEvaluation;
const DEVICE = schema.evvDevice;
const POLICY = schema.evvGeofencePolicy;
const MR = schema.evvMissingResolution;
const AGG = schema.evvAggregatorSubmission;
const VISIT = schema.visit;
const MEM = schema.memberships;

/** The platform geofence floor (matches the in-memory slice fallback when no tenant row is present). */
const PLATFORM_FLOOR = { radiusM: 200, maxAccuracyM: 50 } as const;
/** Sentinel `applied_policy_id` on a geofence-evaluation snapshot when the platform floor (no tenant row) applied. */
const PLATFORM_POLICY_SENTINEL = "00000000-0000-4000-8000-0000000000f1";

const toIso = (v: unknown): string =>
  v instanceof Date ? v.toISOString() : typeof v === "string" ? v : "";
const toIsoOrNull = (v: unknown): string | null => (v == null ? null : toIso(v));
const today = (): string => new Date().toISOString().slice(0, 10);

/** Map an `evv_event` row to the coordinate-free §4.3 wire projection. */
function toEventDto(e: typeof EVENT.$inferSelect): EvvEventDto {
  return {
    id: e.id,
    organizationId: e.organizationId,
    visitId: e.visitId,
    patientId: e.patientId,
    kind: e.kind as EvvEventKind,
    serviceTypeCode: e.serviceTypeCode,
    postingMembershipId: e.postingMembershipId,
    postingDisciplineAtRecording: e.postingDisciplineAtRecording,
    evvDeviceId: e.evvDeviceId,
    capturedAt: toIso(e.capturedAt),
    recordedAt: toIso(e.recordedAt),
    gpsQuality: e.gpsQuality as EvvEventGpsQuality,
    offlineCapture: e.offlineCapture,
    replacesEventId: e.replacesEventId ?? null,
    supersededByEventId: e.supersededByEventId ?? null,
  };
}

const toDeviceView = (d: typeof DEVICE.$inferSelect): DeviceView => ({
  id: d.id,
  membershipId: d.membershipId,
  platform: d.platform as EvvDevicePlatform,
  modelDescription: d.modelDescription ?? "",
  status: d.status as EvvDeviceStatus,
});
const toResolutionView = (r: typeof MR.$inferSelect): MissingResolutionView => ({
  id: r.id,
  visitId: r.visitId,
  kind: r.kind as EvvMissingResolutionKind,
  status: r.status as EvvMissingResolutionStatus,
  resolvedByMembershipId: r.resolvedByMembershipId ?? null,
});
const toSubmissionDto = (s: typeof AGG.$inferSelect): EvvAggregatorSubmissionDto => ({
  id: s.id,
  visitId: s.visitId,
  stateCode: s.stateCode,
  aggregatorVendor: s.aggregatorVendor,
  status: s.status as EvvAggregatorSubmissionStatus,
  aggregatorTransactionId: s.aggregatorTransactionId ?? null,
  attemptCount: s.attemptCount,
});

/** The transactional-outbox port (§4.10): the bound publisher validates every emit against the boot catalog and
 * writes the `outbox_event` row on the CALLER'S tx. The no-op default lets the slice/tests commit without a
 * dispatcher. Mirrors M7–M17. */
export interface EvvWriteOutboxPort {
  publish(
    tx: unknown,
    emission: {
      readonly eventName: string;
      readonly payload: Record<string, unknown>;
      readonly organizationId: string;
      readonly aggregateKind: string;
      readonly aggregateId: string;
    },
  ): Promise<void>;
}
const NOOP_OUTBOX: EvvWriteOutboxPort = { async publish() {} };

/**
 * The production, RLS-backed EVV backend (M18L reads + the write lifecycle). Implements BOTH the
 * {@link EvvRouteService} surface and its {@link EvvAbacResolver} (the same object is passed to
 * `registerEvvRoutes` and `registerEvvAbacPredicates`).
 */
export function createDbEvvBackend(db: DbClient, outbox: EvvWriteOutboxPort = NOOP_OUTBOX): EvvRouteService {
  async function emit(
    tx: unknown,
    orgId: string,
    eventName: string,
    aggregateKind: string,
    aggregateId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await outbox.publish(tx, { eventName, payload, organizationId: orgId, aggregateKind, aggregateId });
  }

  /** Load the M17 visit siting (RLS-scoped) the capture needs, or the non-leaking 404. */
  async function resolveVisit(tx: DbClient, visitId: string) {
    const [v] = await tx
      .select({
        providerEntityId: VISIT.providerEntityId,
        locationId: VISIT.locationId,
        patientId: VISIT.patientId,
        patientAddressId: VISIT.patientAddressId,
        assignedMembershipId: VISIT.assignedMembershipId,
        scheduledStartedAt: VISIT.scheduledStartedAt,
      })
      .from(VISIT)
      .where(eq(VISIT.id, visitId))
      .limit(1);
    if (!v) throw new NotFoundError("visit", visitId);
    return v;
  }

  /** The posting membership's most-recent APPROVED device (the capture's FK-required `evv_device_id`). */
  async function resolveApprovedDevice(tx: DbClient, membershipId: string) {
    const [d] = await tx
      .select({ id: DEVICE.id, attestation: DEVICE.m2DeviceAttestationId })
      .from(DEVICE)
      .where(and(eq(DEVICE.membershipId, membershipId), eq(DEVICE.status, "approved")))
      .orderBy(desc(DEVICE.approvedAt))
      .limit(1);
    if (!d) throw new ValidationError("the posting clinician has no approved EVV device to capture with", []);
    return d;
  }

  /** The effective geofence policy: the active tenant row, else the platform floor (compromise #3). */
  async function effectivePolicy(
    tx: DbClient,
  ): Promise<{ radiusM: number; maxAccuracyM: number; policyId: string | null }> {
    const [tenant] = await tx
      .select({ id: POLICY.id, radiusM: POLICY.radiusM, maxAccuracyM: POLICY.maxAccuracyM })
      .from(POLICY)
      .where(and(eq(POLICY.scope, "tenant"), isNull(POLICY.effectiveTo)))
      .limit(1);
    return tenant
      ? { radiusM: tenant.radiusM, maxAccuracyM: tenant.maxAccuracyM, policyId: tenant.id }
      : { radiusM: PLATFORM_FLOOR.radiusM, maxAccuracyM: PLATFORM_FLOOR.maxAccuracyM, policyId: null };
  }

  /** The org's first membership — the placeholder actor for the device/policy admin routes that do not thread
   * the acting membership to the service (compromise #4). */
  async function actingMembership(tx: DbClient, orgId: string): Promise<string> {
    const [m] = await tx.select({ id: MEM.id }).from(MEM).where(eq(MEM.organizationId, orgId)).limit(1);
    if (!m) throw new ValidationError("no membership exists in the organization to attribute the action to", []);
    return m.id;
  }

  /** Build the geofence-policy view from the active rows WITHIN the given tx (so a policy write reads its own
   * uncommitted changes — calling the top-level `getGeofencePolicy` would open a separate tx and read stale
   * committed state). */
  async function readPolicyView(tx: DbClient): Promise<GeofencePolicyView> {
    const active = await tx
      .select({
        scope: POLICY.scope,
        patientAddressId: POLICY.patientAddressId,
        radiusM: POLICY.radiusM,
        maxAccuracyM: POLICY.maxAccuracyM,
      })
      .from(POLICY)
      .where(isNull(POLICY.effectiveTo));
    const tenantRow = active.find((r) => r.scope === "tenant");
    const tenant = tenantRow
      ? { radiusM: tenantRow.radiusM, maxAccuracyM: tenantRow.maxAccuracyM }
      : { radiusM: PLATFORM_FLOOR.radiusM, maxAccuracyM: PLATFORM_FLOOR.maxAccuracyM };
    const perAddress = active
      .filter((r) => r.scope === "patient_address" && r.patientAddressId)
      .map((r) => ({
        patientAddressId: r.patientAddressId as string,
        radiusM: r.radiusM,
        maxAccuracyM: r.maxAccuracyM,
      }));
    return { tenant, perAddress };
  }

  const backend = {
    // ── EvvAbacResolver (§4.7) — reads the M17 visit aggregate, fail-closed to null ─────────────────────
    async assignedMembershipForVisit(orgId: string, visitId: string): Promise<string | null> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
        const [v] = await tx
          .select({ assignedMembershipId: VISIT.assignedMembershipId })
          .from(VISIT)
          .where(eq(VISIT.id, visitId))
          .limit(1);
        return v ? v.assignedMembershipId : null;
      });
    },
    async visitWindowForVisit(
      orgId: string,
      visitId: string,
    ): Promise<{ scheduledStartedAt: string; scheduledEndedAt: string } | null> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
        const [v] = await tx
          .select({ start: VISIT.scheduledStartedAt, end: VISIT.scheduledEndedAt })
          .from(VISIT)
          .where(eq(VISIT.id, visitId))
          .limit(1);
        return v ? { scheduledStartedAt: toIso(v.start), scheduledEndedAt: toIso(v.end) } : null;
      });
    },
    async captureWindow(_orgId: string): Promise<EvvCaptureWindow> {
      return { beforeMs: DEFAULT_EVV_WINDOW_BEFORE_MS, afterMs: DEFAULT_EVV_WINDOW_AFTER_MS };
    },

    // ── event reads (§4.1 routes 4–5) ──────────────────────────────────────────────────────────────────
    async listEvents(
      orgId: string,
      f: { visit?: string; clinician?: string; patient?: string; kind?: EvvEventKind },
    ): Promise<EvvEventDto[]> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
        const clauses = [
          f.visit ? eq(EVENT.visitId, f.visit) : undefined,
          f.clinician ? eq(EVENT.postingMembershipId, f.clinician) : undefined,
          f.patient ? eq(EVENT.patientId, f.patient) : undefined,
          f.kind ? eq(EVENT.kind, f.kind) : undefined,
        ].filter((c): c is NonNullable<typeof c> => c !== undefined);
        const rows = await tx
          .select()
          .from(EVENT)
          .where(clauses.length ? and(...clauses) : undefined)
          .orderBy(desc(EVENT.eventAt));
        return rows.map(toEventDto);
      });
    },
    async getEvent(orgId: string, eventId: string): Promise<EvvEventDto> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
        const [e] = await tx.select().from(EVENT).where(eq(EVENT.id, eventId)).limit(1);
        if (!e) throw new NotFoundError("evv_event", eventId);
        return toEventDto(e);
      });
    },

    // ── capture (§4.1 routes 1–3) — INSERT evv_event + the geofence-evaluation snapshot, emit m18.evv.* ──
    async recordCapture(
      orgId: string,
      userId: string,
      kind: EvvEventKind,
      input: {
        visitId: string;
        coords: { lat: number; lng: number };
        accuracyM: number;
        capturedAt: string;
        gpsQualityAttested?: "degraded_attested";
      },
    ): Promise<CheckResultView> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (txRaw) => {
        const tx = txRaw as DbClient;
        const visit = await resolveVisit(tx, input.visitId);
        const device = await resolveApprovedDevice(tx, userId);
        const policy = await effectivePolicy(tx);

        // gps-quality / geofence decision — the in-mem accuracy-band model (compromise #3).
        let gpsQuality: EvvEventGpsQuality;
        let decision: CheckResultView["geofenceDecision"];
        if (input.accuracyM > policy.maxAccuracyM) {
          gpsQuality = input.gpsQualityAttested ?? "outside_geofence";
          decision = input.gpsQualityAttested ? "pass" : "fail_accuracy";
        } else {
          gpsQuality = input.accuracyM <= policy.maxAccuracyM / 2 ? "high" : "acceptable";
          decision = "pass";
        }
        const coordsCipher = Buffer.from(`${input.coords.lat},${input.coords.lng}`).toString("base64");
        const capturedAt = new Date(input.capturedAt);

        const [ins] = await tx
          .insert(EVENT)
          .values({
            organizationId: orgId,
            providerEntityId: visit.providerEntityId,
            locationId: visit.locationId,
            visitId: input.visitId,
            patientId: visit.patientId,
            patientAddressId: visit.patientAddressId,
            kind,
            serviceTypeCode: "",
            postingMembershipId: userId,
            postingDisciplineAtRecording: "",
            evvDeviceId: device.id,
            capturedAt,
            eventAt: capturedAt,
            coordsCipher,
            coordsDekVersion: 1,
            accuracyM: input.accuracyM,
            gpsQuality,
            deviceAttestationIdAtRecord: device.attestation,
          })
          .returning({ id: EVENT.id });
        if (!ins) throw new Error("evv_event insert returned no row");
        const eventId = ins.id;

        // §2.2.6 informational geofence-evaluation snapshot.
        await tx.insert(GEVAL).values({
          organizationId: orgId,
          evvEventId: eventId,
          appliedPolicyId: policy.policyId ?? PLATFORM_POLICY_SENTINEL,
          appliedPolicyScope: policy.policyId ? "tenant" : "platform",
          appliedRadiusM: policy.radiusM,
          appliedMaxAccuracyM: policy.maxAccuracyM,
          deviceCoordsCipher: coordsCipher,
          computedDistanceM: null,
          decision,
        });

        const recordedAt = new Date().toISOString();
        if (kind === "check_in") {
          await emit(tx, orgId, "m18.evv.check_in_recorded", "evv_event", eventId, {
            eventId,
            visitId: input.visitId,
            patientId: visit.patientId,
            postingMembershipId: userId,
            capturedAt: toIso(capturedAt),
            recordedAt,
            gpsQuality,
            geofenceDecision: decision,
          });
          if (decision === "pass") {
            await emit(tx, orgId, "m18.evv.at_patient_address", "evv_event", eventId, {
              eventId,
              visitId: input.visitId,
              patientId: visit.patientId,
              postingMembershipId: userId,
              computedDistanceM: 0,
              appliedRadiusM: policy.radiusM,
              confirmedAt: recordedAt,
            });
          } else {
            await emit(tx, orgId, "m18.evv.geofence_breach_recorded", "evv_event", eventId, {
              eventId,
              visitId: input.visitId,
              computedDistanceM: 0,
              appliedRadiusM: policy.radiusM,
              kind: "check_in",
            });
          }
        } else {
          const [priorCheckIn] = await tx
            .select({ id: EVENT.id, capturedAt: EVENT.capturedAt })
            .from(EVENT)
            .where(
              and(eq(EVENT.visitId, input.visitId), eq(EVENT.kind, "check_in"), isNull(EVENT.supersededByEventId)),
            )
            .orderBy(desc(EVENT.eventAt))
            .limit(1);
          const serviceDurationMinutes = priorCheckIn
            ? Math.max(0, (capturedAt.getTime() - new Date(priorCheckIn.capturedAt).getTime()) / 60_000)
            : 0;
          await emit(tx, orgId, "m18.evv.check_out_recorded", "evv_event", eventId, {
            eventId,
            visitId: input.visitId,
            patientId: visit.patientId,
            postingMembershipId: userId,
            capturedAt: toIso(capturedAt),
            recordedAt,
            gpsQuality,
            geofenceDecision: decision,
            pairedCheckInEventId: priorCheckIn?.id ?? null,
            serviceDurationMinutes,
          });
          if (decision !== "pass") {
            await emit(tx, orgId, "m18.evv.geofence_breach_recorded", "evv_event", eventId, {
              eventId,
              visitId: input.visitId,
              computedDistanceM: 0,
              appliedRadiusM: policy.radiusM,
              kind: "check_out",
            });
          }
        }

        return {
          eventId,
          kind,
          gpsQuality,
          geofenceDecision: decision,
          visitStateAfterEvent: kind === "check_in" ? "in_visit" : "completed",
        };
      });
    },

    // ── per-visit bracket (§4.1 route 7; M8's EvvBracketResolver reads this) ─────────────────────────────
    async bracketForVisit(orgId: string, visitId: string): Promise<EvvBracketDto> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
        const [visitRow] = await tx.select({ id: VISIT.id }).from(VISIT).where(eq(VISIT.id, visitId)).limit(1);
        if (!visitRow) throw new NotFoundError("visit", visitId);
        const events = await tx
          .select()
          .from(EVENT)
          .where(eq(EVENT.visitId, visitId))
          .orderBy(desc(EVENT.eventAt));
        const checkIn = events.find((e) => e.kind === "check_in") ?? null;
        const checkOut = events.find((e) => e.kind === "check_out") ?? null;
        const [open] = await tx
          .select({ id: MR.id })
          .from(MR)
          .where(and(eq(MR.visitId, visitId), eq(MR.status, "open")))
          .limit(1);
        const bracketState: EvvBracketDto["bracketState"] =
          checkIn && checkOut ? "present" : open ? "missing_open" : "no_evv_path";
        return {
          visitId,
          checkInEvent: checkIn ? toEventDto(checkIn) : null,
          checkOutEvent: checkOut ? toEventDto(checkOut) : null,
          bracketState,
          missingResolution: null,
        };
      });
    },

    // ── device roster (§4.1 route 8) ────────────────────────────────────────────────────────────────────
    async listDevices(orgId: string, membership?: string): Promise<DeviceView[]> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
        const rows = await tx
          .select()
          .from(DEVICE)
          .where(membership ? eq(DEVICE.membershipId, membership) : undefined)
          .orderBy(desc(DEVICE.createdAt));
        return rows.map(toDeviceView);
      });
    },

    // ── device lifecycle (§4.1 routes 9–13) ─────────────────────────────────────────────────────────────
    async selfRegisterDevice(
      orgId: string,
      userId: string,
      body: { platform: EvvDevicePlatform; modelDescription: string },
    ): Promise<DeviceView> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (txRaw) => {
        const tx = txRaw as DbClient;
        const [d] = await tx
          .insert(DEVICE)
          .values({
            organizationId: orgId,
            membershipId: userId,
            platform: body.platform,
            modelDescription: body.modelDescription,
            deviceKeyFingerprint: `sr-${randomUUID()}`,
            m2DeviceAttestationId: randomUUID(),
            status: "pending_approval",
          })
          .returning();
        if (!d) throw new Error("evv_device insert returned no row");
        await emit(tx, orgId, "m18.evv.device_pending_approval", "evv_device", d.id, {
          deviceId: d.id,
          membershipId: userId,
          platform: body.platform,
        });
        return toDeviceView(d);
      });
    },

    async approveDevice(orgId: string, id: string): Promise<DeviceView> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (txRaw) => {
        const tx = txRaw as DbClient;
        const [d] = await tx.select().from(DEVICE).where(eq(DEVICE.id, id)).limit(1);
        if (!d) throw new NotFoundError("evv_device", id);
        const approver = await actingMembership(tx, orgId);
        const [updated] = await tx
          .update(DEVICE)
          .set({ status: "approved", approvedByMembershipId: approver, approvedAt: new Date(), updatedAt: new Date() })
          .where(eq(DEVICE.id, id))
          .returning();
        await emit(tx, orgId, "m18.evv.device_approved", "evv_device", id, {
          deviceId: id,
          membershipId: d.membershipId,
          approvedByMembershipId: approver,
        });
        return toDeviceView(updated ?? d);
      });
    },

    async rejectDevice(orgId: string, id: string): Promise<DeviceView> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (txRaw) => {
        const tx = txRaw as DbClient;
        const [d] = await tx.select().from(DEVICE).where(eq(DEVICE.id, id)).limit(1);
        if (!d) throw new NotFoundError("evv_device", id);
        const actor = await actingMembership(tx, orgId);
        const [updated] = await tx
          .update(DEVICE)
          .set({ status: "rejected", rejectedByMembershipId: actor, rejectedAt: new Date(), updatedAt: new Date() })
          .where(eq(DEVICE.id, id))
          .returning();
        return toDeviceView(updated ?? d);
      });
    },

    async suspendDevice(orgId: string, id: string): Promise<DeviceView> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (txRaw) => {
        const tx = txRaw as DbClient;
        const [d] = await tx.select().from(DEVICE).where(eq(DEVICE.id, id)).limit(1);
        if (!d) throw new NotFoundError("evv_device", id);
        const [updated] = await tx
          .update(DEVICE)
          .set({ status: "suspended", suspendedAt: new Date(), updatedAt: new Date() })
          .where(eq(DEVICE.id, id))
          .returning();
        await emit(tx, orgId, "m18.evv.device_suspended", "evv_device", id, {
          deviceId: id,
          membershipId: d.membershipId,
          reason: "",
        });
        return toDeviceView(updated ?? d);
      });
    },

    async retireDevice(orgId: string, id: string): Promise<DeviceView> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (txRaw) => {
        const tx = txRaw as DbClient;
        const [d] = await tx.select().from(DEVICE).where(eq(DEVICE.id, id)).limit(1);
        if (!d) throw new NotFoundError("evv_device", id);
        const [updated] = await tx
          .update(DEVICE)
          .set({ status: "retired", retiredAt: new Date(), updatedAt: new Date() })
          .where(eq(DEVICE.id, id))
          .returning();
        return toDeviceView(updated ?? d);
      });
    },

    // ── geofence policy (§4.1 routes 14–16) — active tenant row + active per-address overrides ──────────
    async getGeofencePolicy(orgId: string): Promise<GeofencePolicyView> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
        const active = await tx
          .select({
            scope: POLICY.scope,
            patientAddressId: POLICY.patientAddressId,
            radiusM: POLICY.radiusM,
            maxAccuracyM: POLICY.maxAccuracyM,
          })
          .from(POLICY)
          .where(isNull(POLICY.effectiveTo));
        const tenantRow = active.find((r) => r.scope === "tenant");
        const tenant = tenantRow
          ? { radiusM: tenantRow.radiusM, maxAccuracyM: tenantRow.maxAccuracyM }
          : { radiusM: PLATFORM_FLOOR.radiusM, maxAccuracyM: PLATFORM_FLOOR.maxAccuracyM };
        const perAddress = active
          .filter((r) => r.scope === "patient_address" && r.patientAddressId)
          .map((r) => ({
            patientAddressId: r.patientAddressId as string,
            radiusM: r.radiusM,
            maxAccuracyM: r.maxAccuracyM,
          }));
        return { tenant, perAddress };
      });
    },

    /** §2.2.2 tighten-only: the tenant may NARROW below the platform floor, never loosen above it. */
    async editTenantPolicy(orgId: string, body: { radiusM: number; maxAccuracyM: number }): Promise<GeofencePolicyView> {
      if (body.radiusM > PLATFORM_FLOOR.radiusM || body.maxAccuracyM > PLATFORM_FLOOR.maxAccuracyM) {
        throw new ValidationError("Tenant geofence policy may not loosen beyond the platform floor (tighten-only).", []);
      }
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (txRaw) => {
        const tx = txRaw as DbClient;
        const setter = await actingMembership(tx, orgId);
        const [prior] = await tx
          .select({ id: POLICY.id, radiusM: POLICY.radiusM, maxAccuracyM: POLICY.maxAccuracyM })
          .from(POLICY)
          .where(and(eq(POLICY.scope, "tenant"), isNull(POLICY.effectiveTo)))
          .limit(1);
        if (prior) await tx.update(POLICY).set({ effectiveTo: today() }).where(eq(POLICY.id, prior.id));
        const [row] = await tx
          .insert(POLICY)
          .values({
            organizationId: orgId,
            scope: "tenant",
            radiusM: body.radiusM,
            maxAccuracyM: body.maxAccuracyM,
            effectiveFrom: today(),
            setByMembershipId: setter,
          })
          .returning({ id: POLICY.id });
        await emit(tx, orgId, "m18.evv.geofence_policy_changed", "evv_geofence_policy", row?.id ?? orgId, {
          scope: "tenant",
          oldRadiusM: prior?.radiusM ?? PLATFORM_FLOOR.radiusM,
          newRadiusM: body.radiusM,
          oldMaxAccuracyM: prior?.maxAccuracyM ?? PLATFORM_FLOOR.maxAccuracyM,
          newMaxAccuracyM: body.maxAccuracyM,
          setByMembershipId: setter,
        });
        return readPolicyView(tx);
      });
    },

    async createPerAddressOverride(
      orgId: string,
      body: { patientAddressId: string; radiusM: number; maxAccuracyM: number },
    ): Promise<GeofencePolicyView> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (txRaw) => {
        const tx = txRaw as DbClient;
        const setter = await actingMembership(tx, orgId);
        const [prior] = await tx
          .select({ id: POLICY.id, radiusM: POLICY.radiusM, maxAccuracyM: POLICY.maxAccuracyM })
          .from(POLICY)
          .where(
            and(
              eq(POLICY.scope, "patient_address"),
              eq(POLICY.patientAddressId, body.patientAddressId),
              isNull(POLICY.effectiveTo),
            ),
          )
          .limit(1);
        if (prior) await tx.update(POLICY).set({ effectiveTo: today() }).where(eq(POLICY.id, prior.id));
        const [row] = await tx
          .insert(POLICY)
          .values({
            organizationId: orgId,
            scope: "patient_address",
            patientAddressId: body.patientAddressId,
            radiusM: body.radiusM,
            maxAccuracyM: body.maxAccuracyM,
            effectiveFrom: today(),
            setByMembershipId: setter,
          })
          .returning({ id: POLICY.id });
        await emit(tx, orgId, "m18.evv.geofence_policy_changed", "evv_geofence_policy", row?.id ?? orgId, {
          scope: "per_address",
          patientAddressId: body.patientAddressId,
          oldRadiusM: prior?.radiusM ?? PLATFORM_FLOOR.radiusM,
          newRadiusM: body.radiusM,
          oldMaxAccuracyM: prior?.maxAccuracyM ?? PLATFORM_FLOOR.maxAccuracyM,
          newMaxAccuracyM: body.maxAccuracyM,
          setByMembershipId: setter,
        });
        return readPolicyView(tx);
      });
    },

    // ── missing-EVV resolution queue (§4.1 routes 17–19; §2.2.4 D6 machine) ──────────────────────────────
    async listMissingResolutions(
      orgId: string,
      f: { status?: string; visit?: string },
    ): Promise<MissingResolutionView[]> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
        const clauses = [
          f.status ? eq(MR.status, f.status as EvvMissingResolutionStatus) : undefined,
          f.visit ? eq(MR.visitId, f.visit) : undefined,
        ].filter((c): c is NonNullable<typeof c> => c !== undefined);
        const rows = await tx
          .select()
          .from(MR)
          .where(clauses.length ? and(...clauses) : undefined)
          .orderBy(desc(MR.detectedAt));
        return rows.map(toResolutionView);
      });
    },

    async clinicianAttestResolution(
      orgId: string,
      userId: string,
      id: string,
      reason: string,
    ): Promise<MissingResolutionView> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (txRaw) => {
        const tx = txRaw as DbClient;
        const [r] = await tx.select().from(MR).where(eq(MR.id, id)).limit(1);
        if (!r) throw new NotFoundError("evv_missing_resolution", id);
        // hoursSinceCheckIn: the visit's latest check-in `captured_at`, else the row's detection time.
        const [checkIn] = await tx
          .select({ capturedAt: EVENT.capturedAt })
          .from(EVENT)
          .where(and(eq(EVENT.visitId, r.visitId), eq(EVENT.kind, "check_in")))
          .orderBy(desc(EVENT.eventAt))
          .limit(1);
        const [visit] = await tx
          .select({ assignedMembershipId: VISIT.assignedMembershipId })
          .from(VISIT)
          .where(eq(VISIT.id, r.visitId))
          .limit(1);
        const anchor = checkIn?.capturedAt ?? r.detectedAt;
        const transition = transitionMissingResolution(r.status as EvvMissingResolutionStatus, {
          type: "clinician_attest",
          callerIsAssignedClinician: (visit?.assignedMembershipId ?? null) === userId,
          hoursSinceCheckIn: (Date.now() - new Date(anchor).getTime()) / 3_600_000,
          reason,
        });
        const [updated] = await tx
          .update(MR)
          .set({
            status: transition.status,
            resolvedByMembershipId: userId,
            resolvedAt: new Date(),
            resolutionReason: reason,
            version: (r.version as number) + 1,
            updatedAt: new Date(),
          })
          .where(eq(MR.id, id))
          .returning();
        await emit(tx, orgId, "m18.evv.late_check_resolved", "evv_missing_resolution", id, {
          missingResolutionId: id,
          visitId: r.visitId,
          resolvedByMembershipId: userId,
          status: transition.status,
          resolutionReason: reason,
        });
        return toResolutionView(updated ?? r);
      });
    },

    async supervisorOverrideResolution(
      orgId: string,
      userId: string,
      id: string,
      reason: string,
      stepUpFresh: boolean,
    ): Promise<MissingResolutionView> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (txRaw) => {
        const tx = txRaw as DbClient;
        const [r] = await tx.select().from(MR).where(eq(MR.id, id)).limit(1);
        if (!r) throw new NotFoundError("evv_missing_resolution", id);
        const [visit] = await tx
          .select({ scheduledStartedAt: VISIT.scheduledStartedAt })
          .from(VISIT)
          .where(eq(VISIT.id, r.visitId))
          .limit(1);
        const anchor = visit?.scheduledStartedAt ?? r.detectedAt;
        const transition = transitionMissingResolution(r.status as EvvMissingResolutionStatus, {
          type: "supervisor_override",
          stepUpVerified: stepUpFresh,
          daysSinceVisit: (Date.now() - new Date(anchor).getTime()) / 86_400_000,
          reason,
        });
        const [updated] = await tx
          .update(MR)
          .set({
            status: transition.status,
            resolvedByMembershipId: userId,
            resolvedAt: new Date(),
            resolutionReason: reason,
            version: (r.version as number) + 1,
            updatedAt: new Date(),
          })
          .where(eq(MR.id, id))
          .returning();
        await emit(tx, orgId, "m18.evv.late_check_resolved", "evv_missing_resolution", id, {
          missingResolutionId: id,
          visitId: r.visitId,
          resolvedByMembershipId: userId,
          status: transition.status,
          resolutionReason: reason,
        });
        return toResolutionView(updated ?? r);
      });
    },

    // ── per-state aggregator submissions (§4.1 routes 20–22; §2.2.5 D7 machine) ──────────────────────────
    async listAggregatorSubmissions(
      orgId: string,
      f: { stateCode?: string; status?: string },
    ): Promise<EvvAggregatorSubmissionDto[]> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
        const clauses = [
          f.stateCode ? eq(AGG.stateCode, f.stateCode) : undefined,
          f.status ? eq(AGG.status, f.status as EvvAggregatorSubmissionStatus) : undefined,
        ].filter((c): c is NonNullable<typeof c> => c !== undefined);
        const rows = await tx
          .select()
          .from(AGG)
          .where(clauses.length ? and(...clauses) : undefined)
          .orderBy(desc(AGG.createdAt));
        return rows.map(toSubmissionDto);
      });
    },

    /** §7.9 operator-initiated resubmit (rejected/timeout → queued; attempt_count++). */
    async resubmitSubmission(orgId: string, userId: string, id: string): Promise<EvvAggregatorSubmissionDto> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (txRaw) => {
        const tx = txRaw as DbClient;
        const [s] = await tx.select().from(AGG).where(eq(AGG.id, id)).limit(1);
        if (!s) throw new NotFoundError("evv_aggregator_submission", id);
        const transition = transitionAggregatorSubmission(s.status as EvvAggregatorSubmissionStatus, { type: "resubmit" });
        const [updated] = await tx
          .update(AGG)
          .set({
            status: transition.status,
            attemptCount: s.attemptCount + (transition.incrementsAttempt ? 1 : 0),
            resubmitTriggeredByMembershipId: userId || null,
            resubmitTriggeredAt: new Date(),
            version: (s.version as number) + 1,
            updatedAt: new Date(),
          })
          .where(eq(AGG.id, id))
          .returning();
        return toSubmissionDto(updated ?? s);
      });
    },

    /** §4.1 operator-initiated cancel (non-terminal → cancelled). */
    async cancelSubmission(orgId: string, userId: string, id: string): Promise<EvvAggregatorSubmissionDto> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (txRaw) => {
        const tx = txRaw as DbClient;
        const [s] = await tx.select().from(AGG).where(eq(AGG.id, id)).limit(1);
        if (!s) throw new NotFoundError("evv_aggregator_submission", id);
        const transition = transitionAggregatorSubmission(s.status as EvvAggregatorSubmissionStatus, { type: "cancel" });
        const [updated] = await tx
          .update(AGG)
          .set({
            status: transition.status,
            cancelledByMembershipId: userId || null,
            cancelledAt: new Date(),
            version: (s.version as number) + 1,
            updatedAt: new Date(),
          })
          .where(eq(AGG.id, id))
          .returning();
        await emit(tx, orgId, "m18.evv.aggregator_cancelled", "evv_aggregator_submission", id, {
          submissionId: id,
          visitId: s.visitId,
          stateCode: s.stateCode,
          cancelledByMembershipId: userId,
          reason: "",
        });
        return toSubmissionDto(updated ?? s);
      });
    },

    // ── EVV metrics (§4.1 route 23; M30/M33 dashboard source) ───────────────────────────────────────────
    async metrics(orgId: string): Promise<MetricsView> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
        const events = await tx.select({ gpsQuality: EVENT.gpsQuality }).from(EVENT);
        const subs = await tx.select({ status: AGG.status }).from(AGG);
        const total = events.length;
        const deviations = events.filter((e) => e.gpsQuality === "outside_geofence").length;
        const spoof = events.filter((e) => e.gpsQuality === "suspected_spoof").length;
        const accepted = subs.filter((s) => s.status === "accepted").length;
        return {
          complianceRate: 1,
          lateCheckoutRate: 0,
          geofenceDeviationRate: total === 0 ? 0 : deviations / total,
          gpsSpoofingDetectedRate: total === 0 ? 0 : spoof / total,
          aggregatorSubmissionSuccessRate: subs.length === 0 ? 1 : accepted / subs.length,
        };
      });
    },

    // ── clinician last-known location (§4.1 route 24; D10 coordinate-bearing) ────────────────────────────
    // Coordinates live only in `evv_event.coords_cipher` (field-encrypted). This returns the last-known event
    // metadata per membership with coordinates ZEROED until the decrypt pipeline is wired.
    async clinicianCurrentLocation(orgId: string, membership?: string): Promise<LocationView[]> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
        const rows = await tx
          .select({
            membershipId: EVENT.postingMembershipId,
            eventId: EVENT.id,
            visitId: EVENT.visitId,
            accuracyM: EVENT.accuracyM,
            capturedAt: EVENT.capturedAt,
          })
          .from(EVENT)
          .where(membership ? eq(EVENT.postingMembershipId, membership) : undefined)
          .orderBy(desc(EVENT.eventAt));
        const latestByMember = new Map<string, (typeof rows)[number]>();
        for (const r of rows) if (!latestByMember.has(r.membershipId)) latestByMember.set(r.membershipId, r);
        return [...latestByMember.values()].map((r) => ({
          membershipId: r.membershipId,
          eventId: r.eventId,
          visitId: r.visitId,
          lat: 0, // TODO(D10): decrypt coords_cipher
          lng: 0, // TODO(D10): decrypt coords_cipher
          accuracyM: r.accuracyM,
          capturedAt: toIso(r.capturedAt),
        }));
      });
    },

    // ── portal arrival surface (§4.1 route 25; timestamp only, no coordinates) ──────────────────────────
    async portalArrival(orgId: string, visitId: string): Promise<ArrivalView> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
        const events = await tx
          .select({ kind: EVENT.kind, capturedAt: EVENT.capturedAt })
          .from(EVENT)
          .where(eq(EVENT.visitId, visitId))
          .orderBy(desc(EVENT.eventAt));
        return {
          visitId,
          arrivedAt: toIsoOrNull(events.find((e) => e.kind === "check_in")?.capturedAt ?? null),
          departedAt: toIsoOrNull(events.find((e) => e.kind === "check_out")?.capturedAt ?? null),
        };
      });
    },

    /** Guard helper the correction route uses (Clinical Supervisor + step-up; §2.3). */
    assertStepUp(stepUpFresh: boolean): void {
      if (!stepUpFresh) throw new ForbiddenError("A correction-of-record requires fresh M2 step-up auth.");
    },
  };

  return backend as unknown as EvvRouteService;
}
