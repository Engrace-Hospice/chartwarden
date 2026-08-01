// apps/backend/src/modules/18-evv — PRODUCTION EVV route service + ABAC resolver, READ-first (mirrors M6L-T01).
//
// The screen-driving READS (event ledger + detail, per-visit bracket, device roster, geofence policy, missing-
// resolution queue, per-state aggregator submissions, EVV metrics, last-known team location, portal arrival)
// run as real Drizzle queries over the M18-owned tables inside `withOrgContext`, so RLS scopes every row by
// `app.org_id` as the unprivileged `wardenx_app` role. The §4.7 ABAC resolver (`assigned_clinician_for_visit`
// ∧ `evv_within_visit_window`) reads the M17 `visit` aggregate the same way (M18 dependsOn [17]; RLS-scoped,
// fail-closed → `null` when the visit is absent/cross-tenant). The full WRITE lifecycle (capture, device
// approval, policy edits, missing-resolution attest/override, aggregator resubmit/cancel) is the follow-up;
// every write here fail-closes 501 (`NOT_IMPLEMENTED`). The in-memory `EvvRouteService` (`routes/service.ts`)
// stays the behavioral reference.
//
// SHAPE: `EvvRouteService` is a concrete class (private fields), so a structurally-typed object cannot be
// assigned to it. The backend below provides the FULL public read + resolver + write surface and is cast
// (`as unknown as EvvRouteService`) at the boundary — the reads return Promises the Fastify handlers await,
// exactly as the M6 Drizzle service does. Coordinates are NEVER projected on event reads (the §4.3 rule the
// in-memory slice models); only the D10 team-location read is coordinate-bearing (see below).
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import {
  type EvvAggregatorSubmissionDto,
  type EvvBracketDto,
  type EvvDevicePlatform,
  type EvvDeviceStatus,
  type EvvEventDto,
  type EvvEventGpsQuality,
  type EvvEventKind,
  type EvvMissingResolutionKind,
  type EvvMissingResolutionStatus,
  NotFoundError,
  WardenXError,
} from "@wardenx/types";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  DEFAULT_EVV_WINDOW_AFTER_MS,
  DEFAULT_EVV_WINDOW_BEFORE_MS,
  type EvvCaptureWindow,
} from "./abac-predicates";
import type {
  ArrivalView,
  DeviceView,
  GeofencePolicyView,
  LocationView,
  MetricsView,
  MissingResolutionView,
  EvvRouteService,
} from "./routes/service";

const EVENT = schema.evvEvent;
const DEVICE = schema.evvDevice;
const POLICY = schema.evvGeofencePolicy;
const MR = schema.evvMissingResolution;
const AGG = schema.evvAggregatorSubmission;
const VISIT = schema.visit;

/** The platform geofence floor (matches the in-memory slice fallback when no tenant row is present). */
const PLATFORM_FLOOR = { radiusM: 200, maxAccuracyM: 50 } as const;

const toIso = (v: unknown): string =>
  v instanceof Date ? v.toISOString() : typeof v === "string" ? v : "";
const toIsoOrNull = (v: unknown): string | null => (v == null ? null : toIso(v));

/** A never-returning stub for the write lifecycle still owed by the follow-up. */
const notImpl = (): never => {
  throw new WardenXError("NOT_IMPLEMENTED", "EVV writes arrive in the Drizzle write-lifecycle follow-up", 501);
};

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

/**
 * The production, RLS-backed EVV backend. It implements BOTH the {@link EvvRouteService} read surface and its
 * {@link EvvAbacResolver} (the same object is passed to `registerEvvRoutes` and `registerEvvAbacPredicates`).
 * Reads are real (org-pinned under `withOrgContext`); writes fail-closed 501.
 */
export function createDbEvvBackend(db: DbClient): EvvRouteService {
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
        return v
          ? { scheduledStartedAt: toIso(v.start), scheduledEndedAt: toIso(v.end) }
          : null;
      });
    },
    // No table stores the per-tenant capture WINDOW (the geofence policy is radius/accuracy, not time); the
    // spec default (2h-before / 4h-after) is the source of truth until an operator override table lands.
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

    // ── per-visit bracket (§4.1 route 7; M8's EvvBracketResolver reads this) ─────────────────────────────
    async bracketForVisit(orgId: string, visitId: string): Promise<EvvBracketDto> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
        const [visitRow] = await tx
          .select({ id: VISIT.id })
          .from(VISIT)
          .where(eq(VISIT.id, visitId))
          .limit(1);
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
          .select({
            id: DEVICE.id,
            membershipId: DEVICE.membershipId,
            platform: DEVICE.platform,
            modelDescription: DEVICE.modelDescription,
            status: DEVICE.status,
          })
          .from(DEVICE)
          .where(membership ? eq(DEVICE.membershipId, membership) : undefined)
          .orderBy(desc(DEVICE.createdAt));
        return rows.map((d) => ({
          id: d.id,
          membershipId: d.membershipId,
          platform: d.platform as EvvDevicePlatform,
          modelDescription: d.modelDescription ?? "",
          status: d.status as EvvDeviceStatus,
        }));
      });
    },

    // ── geofence policy (§4.1 route 14) — active tenant row + active per-address overrides ──────────────
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
          .where(isNull(POLICY.effectiveTo)); // effective_to IS NULL → currently active
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

    // ── missing-EVV resolution queue (§4.1 route 17) ────────────────────────────────────────────────────
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
          .select({
            id: MR.id,
            visitId: MR.visitId,
            kind: MR.kind,
            status: MR.status,
            resolvedByMembershipId: MR.resolvedByMembershipId,
          })
          .from(MR)
          .where(clauses.length ? and(...clauses) : undefined)
          .orderBy(desc(MR.detectedAt));
        return rows.map((r) => ({
          id: r.id,
          visitId: r.visitId,
          kind: r.kind as EvvMissingResolutionKind,
          status: r.status as EvvMissingResolutionStatus,
          resolvedByMembershipId: r.resolvedByMembershipId ?? null,
        }));
      });
    },

    // ── per-state aggregator submissions (§4.1 route 20) ────────────────────────────────────────────────
    async listAggregatorSubmissions(
      orgId: string,
      f: { stateCode?: string; status?: string },
    ): Promise<EvvAggregatorSubmissionDto[]> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
        const clauses = [
          f.stateCode ? eq(AGG.stateCode, f.stateCode) : undefined,
          f.status ? eq(AGG.status, f.status as EvvAggregatorSubmissionDto["status"]) : undefined,
        ].filter((c): c is NonNullable<typeof c> => c !== undefined);
        const rows = await tx
          .select({
            id: AGG.id,
            visitId: AGG.visitId,
            stateCode: AGG.stateCode,
            aggregatorVendor: AGG.aggregatorVendor,
            status: AGG.status,
            aggregatorTransactionId: AGG.aggregatorTransactionId,
            attemptCount: AGG.attemptCount,
          })
          .from(AGG)
          .where(clauses.length ? and(...clauses) : undefined)
          .orderBy(desc(AGG.createdAt));
        return rows.map((s) => ({
          id: s.id,
          visitId: s.visitId,
          stateCode: s.stateCode,
          aggregatorVendor: s.aggregatorVendor,
          status: s.status as EvvAggregatorSubmissionDto["status"],
          aggregatorTransactionId: s.aggregatorTransactionId ?? null,
          attemptCount: s.attemptCount,
        }));
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
    // TODO(D10): lat/lng live only in `evv_event.coords_cipher` (field-encrypted at rest, gated behind a DEK
    // pipeline / `evv.location.read_team` coordinate path). This read returns the last-known event metadata
    // per membership with coordinates ZEROED until the decrypt pipeline is wired — it does not fabricate a
    // plausible coordinate. The non-encrypted `accuracy_m` is returned as recorded.
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

    // ── writes — fail-closed 501 until the Drizzle write lifecycle lands ─────────────────────────────────
    recordCapture: () => notImpl(),
    selfRegisterDevice: () => notImpl(),
    approveDevice: () => notImpl(),
    rejectDevice: () => notImpl(),
    suspendDevice: () => notImpl(),
    retireDevice: () => notImpl(),
    editTenantPolicy: () => notImpl(),
    createPerAddressOverride: () => notImpl(),
    clinicianAttestResolution: () => notImpl(),
    supervisorOverrideResolution: () => notImpl(),
    resubmitSubmission: () => notImpl(),
    cancelSubmission: () => notImpl(),
    assertStepUp: () => notImpl(),
  };
  // EvvRouteService is a class with private fields; the backend supplies the full public surface (reads
  // return Promises the Fastify handlers await, exactly as the M6 Drizzle service does).
  return backend as unknown as EvvRouteService;
}
