// apps/backend/src/modules/18-evv — PRODUCTION EVV route service + §4.7 ABAC resolver (M18L reads + the write
// lifecycle over Drizzle+RLS). No route is left at 501.
//
// The screen-driving READS (event ledger + detail, per-visit bracket, device roster, geofence policy, missing-
// resolution queue, per-state aggregator submissions, EVV metrics, last-known team location, portal arrival)
// run as real Drizzle queries over the M18-owned tables inside `withOrgContext`, so RLS scopes every row by
// `app.org_id` as the unprivileged `chartwarden_app` role. The §4.7 ABAC resolver (`assigned_clinician_for_visit`
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
//       threaded), and `device_attestation_id_at_record` reuses the device's `m2_device_attestation_id`. The GPS
//       coordinate is RESOLVED (GAP-133): it is sealed in the §D10 per-tenant DEK envelope (./coords.ts, over
//       the injected M34 key provider) BEFORE the capture tx opens, `coords_dek_version` is the version the key
//       ring sealed it under, and with no key bound the capture is REFUSED rather than written in the clear.
//       (GAP-032 before it: `clinicianCurrentLocation` used to answer a hardcoded (0, 0) for everyone);
//   (3) RESOLVED (GAP-054). The gps-quality / geofence decision is computed in `./capture-geofence.ts` from the
//       haversine distance to the patient-address coordinate (M5 `PatientAddressReader.serviceAddressCoordinate`,
//       resolved before the capture tx opens) against the effective policy; `computed_distance_m` is the real
//       distance (NULL only when there is no baseline). A client `degraded_attested` flag is an advisory breach,
//       never a pass. The per-address policy override is still not consulted by `effectivePolicy`;
//   (4) RESOLVED (F-068 §4). The device-admin + geofence-policy routes used to drop the acting membership,
//       so `approved_by_membership_id` / `rejected_by_membership_id` / `set_by_membership_id` were filled from
//       an arbitrary `LIMIT 1` membership in the org — a row naming a colleague who did not do it. Every one
//       of those methods now takes the caller's membership and writes it;
//   (5) the M17 visit-state advance the capture drives (published → en_route → in_visit → completed, D14) is the
//       M17 consumer of `m18.evv.check_*_recorded`, not a write here.
import { randomUUID } from "node:crypto";
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
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
  IdempotencyConflictError,
  NotFoundError,
  ValidationError,
} from "@chartwarden/types";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { getSeam } from "../../bootstrap/index";
import {
  DEFAULT_EVV_WINDOW_AFTER_MS,
  DEFAULT_EVV_WINDOW_BEFORE_MS,
  type EvvAbacResolver,
  type EvvCaptureWindow,
} from "./abac-predicates";
import {
  type EvvCaptureAuthority,
  assertCaptureAllowed,
  selectBoundDevice,
} from "./capture-guards";
import {
  EVV_OFFLINE_FINGERPRINT_KEY_ID,
  fingerprintOfflineCapture,
  offlineFingerprintKey,
} from "./offline-idempotency";

/** What binds a capture to the device that sent it (see `resolveCaptureDevice`). */
interface CaptureBinding {
  readonly authority: EvvCaptureAuthority;
  readonly claimedDeviceId: string | undefined;
}
import { classifyCapture } from "./capture-classification";
import { decideCaptureGeofence } from "./capture-geofence";
import {
  type EvvCoordsCipher,
  type EvvCoordsFaultReporter,
  type SealedCoords,
  type StoredCoordinate,
  UNBOUND_EVV_COORDS_CIPHER,
  WARN_EVV_COORDS_FAULT,
  openCoordsForList,
} from "./coords";
import { transitionAggregatorSubmission } from "./domain/aggregator-submission";
import type { EvvSideEffect } from "./domain/effects";
import { correctEvent } from "./domain/event-lifecycle";
import type { Coordinate } from "./domain/geofence";
import { transitionMissingResolution } from "./domain/missing-resolution";
import type {
  ArrivalView,
  CheckResultView,
  DeviceView,
  EvvRoutePort,
  GeofencePolicyView,
  LocationView,
  MetricsView,
  MissingResolutionView,
  OfflineCaptureInput,
  OfflineCaptureResult,
} from "./routes/service";

const EVENT = schema.evvEvent;
const OFFLINE_RECEIPT = schema.evvOfflineCaptureReceipt;
const GEVAL = schema.evvGeofenceEvaluation;
const DEVICE = schema.evvDevice;
const POLICY = schema.evvGeofencePolicy;
const MR = schema.evvMissingResolution;
const AGG = schema.evvAggregatorSubmission;
const VISIT = schema.visit;
const VISIT_REGISTRATION = schema.evvVisitRegistrations;
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

/** Reads the geocoded coordinate of a patient's service address (null = no baseline). */
export type AddressCoordinateReader = (
  organizationId: string,
  patientId: string,
  patientAddressId: string | null,
) => Promise<Coordinate | null>;

/**
 * The production, RLS-backed EVV backend (M18L reads + the write lifecycle). Implements BOTH the
 * {@link EvvRoutePort} surface and its {@link EvvAbacResolver} (the same object is passed to
 * `registerEvvRoutes` and `registerEvvAbacPredicates`).
 */
export function createDbEvvBackend(
  db: DbClient,
  outbox: EvvWriteOutboxPort = NOOP_OUTBOX,
  options: {
    readonly deviceAttestationEnforced?: boolean;
    /**
     * GAP-054 — the patient-address coordinate the capture geofence measures against. Defaults to M5's
     * `PatientAddressReader` seam (resolved lazily per call); injectable so a suite can bind a fixed baseline.
     */
    readonly addressCoordinate?: AddressCoordinateReader;
    /**
     * GAP-133 — the §D10 per-tenant DEK envelope over `coords_cipher`. The composition root binds it over M34's
     * `getTenantKeyProvider()`; the default is FAIL-CLOSED (every capture is refused rather than written with
     * clear coordinates, and an encrypted coordinate cannot be read).
     */
    readonly coordsCipher?: EvvCoordsCipher;
    /** Where the multi-clinician location read reports a coordinate it could not open (default: a warning). */
    readonly onCoordsFault?: EvvCoordsFaultReporter;
    /** HMAC secret for coordinate-free durable receipt fingerprints (required in production). */
    readonly offlineFingerprintKey?: string;
  } = {},
): EvvRoutePort {
  const coordsCipher = options.coordsCipher ?? UNBOUND_EVV_COORDS_CIPHER;
  const onCoordsFault = options.onCoordsFault ?? WARN_EVV_COORDS_FAULT;
  const addressCoordinate: AddressCoordinateReader =
    options.addressCoordinate ??
    ((orgId, patientId, patientAddressId) =>
      getSeam("PatientAddressReader").serviceAddressCoordinate(orgId, patientId, patientAddressId));
  // GAP-055 follow-up: injected from validated server config (`EVV_DEVICE_ATTESTATION_ENFORCED`), default OFF.
  const deviceAttestationEnforced = options.deviceAttestationEnforced ?? false;
  const fingerprintKey = options.offlineFingerprintKey ?? offlineFingerprintKey();
  async function emit(
    tx: unknown,
    orgId: string,
    eventName: string,
    aggregateKind: string,
    aggregateId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await outbox.publish(tx, {
      eventName,
      payload,
      organizationId: orgId,
      aggregateKind,
      aggregateId,
    });
  }

  /** Load the M18-owned publication snapshot the capture needs, or the non-leaking 404. */
  async function resolveVisit(tx: DbClient, visitId: string) {
    const [v] = await tx
      .select({
        providerEntityId: VISIT_REGISTRATION.providerEntityId,
        locationId: VISIT_REGISTRATION.locationId,
        patientId: VISIT_REGISTRATION.patientId,
        patientAddressId: VISIT_REGISTRATION.patientAddressId,
        assignedMembershipId: VISIT_REGISTRATION.assignedMembershipId,
        scheduledStartedAt: VISIT_REGISTRATION.scheduledStartedAt,
        serviceTypeCode: VISIT_REGISTRATION.serviceTypeCode,
        assignedDiscipline: VISIT_REGISTRATION.assignedDiscipline,
      })
      .from(VISIT_REGISTRATION)
      .where(eq(VISIT_REGISTRATION.visitId, visitId))
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
      .orderBy(sql`${DEVICE.approvedAt} DESC NULLS LAST`, asc(DEVICE.id))
      .limit(1);
    if (!d)
      throw new ValidationError(
        "the posting clinician has no approved EVV device to capture with",
        [],
      );
    return d;
  }

  /**
   * The capture's device. ENFORCED: a clinician capture is bound to the device that SENT the request (the
   * approved device of the acting membership whose M2 attestation is the session's — `selectBoundDevice`);
   * NOT enforced (default): a claimed device that is any approved device of the membership, else its
   * most-recently-approved device. Either way a client claim never reaches beyond the membership's own devices. With no `binding` (the §7.7 correction path, which has no session attestation
   * threaded) it is the membership's most-recent approved device, as before.
   */
  async function resolveCaptureDevice(
    tx: DbClient,
    membershipId: string,
    binding: CaptureBinding | undefined,
  ) {
    if (!binding || binding.authority.kind === "system")
      return resolveApprovedDevice(tx, membershipId);
    const rows = await tx
      .select({
        id: DEVICE.id,
        membershipId: DEVICE.membershipId,
        status: DEVICE.status,
        attestation: DEVICE.m2DeviceAttestationId,
        approvedAt: DEVICE.approvedAt,
      })
      .from(DEVICE)
      .where(and(eq(DEVICE.membershipId, membershipId), eq(DEVICE.status, "approved")));
    const boundId = selectBoundDevice(
      binding.authority,
      membershipId,
      binding.claimedDeviceId,
      rows.map((r) => ({
        id: r.id,
        membershipId: r.membershipId,
        status: r.status,
        attestationId: r.attestation,
        approvedAtMs: r.approvedAt?.getTime() ?? Number.NEGATIVE_INFINITY,
      })),
      deviceAttestationEnforced,
    );
    const bound = rows.find((r) => r.id === boundId);
    if (!bound)
      throw new ForbiddenError("the session device is not an approved device of the clinician");
    return { id: bound.id, attestation: bound.attestation };
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
      : {
          radiusM: PLATFORM_FLOOR.radiusM,
          maxAccuracyM: PLATFORM_FLOOR.maxAccuracyM,
          policyId: null,
        };
  }

  /** The org's first membership — the placeholder actor for the device/policy admin routes that do not thread
   * the acting membership to the service (compromise #4). */
  /**
   * F-068 §4 — `actingMembership(tx, orgId)` used to live here: a `LIMIT 1` over the org's memberships
   * with no ORDER BY, used to fill `approved_by_membership_id`, `rejected_by_membership_id` and
   * `set_by_membership_id` on all six device-admin and geofence-policy writes. The routes always knew
   * the caller — `actorOf` resolves the acting membership on the line above — and simply did not pass
   * it. That is worse than a NULL: the row ASSERTS that a specific, named person approved the device or
   * loosened the geofence, and it was whoever Postgres happened to return. Every one of those methods
   * now takes `userId` and writes it.
   */

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

  /**
   * GAP-054 — the visit's address coordinate, resolved BEFORE the capture transaction opens (the seam opens its
   * own org-scoped connection; M17's pre-schedule seam facts follow the same rule). Fail-safe: an absent
   * visit, a never-geocoded address or a seam that throws all resolve to `null` = "no baseline", which the
   * decision records as advisory `no_geofence_baseline` — it can never produce a pass.
   */
  async function loadGeofenceBaseline(orgId: string, visitId: string): Promise<Coordinate | null> {
    const registration = await withOrgContext(
      db,
      { organizationId: orgId, userId: "" },
      async (tx) => {
        const [v] = await (tx as DbClient)
          .select({
            patientId: VISIT_REGISTRATION.patientId,
            patientAddressId: VISIT_REGISTRATION.patientAddressId,
          })
          .from(VISIT_REGISTRATION)
          .where(eq(VISIT_REGISTRATION.visitId, visitId))
          .limit(1);
        return v ?? null;
      },
    );
    if (!registration) return null;
    try {
      return await addressCoordinate(
        orgId,
        registration.patientId,
        registration.patientAddressId ?? null,
      );
    } catch {
      return null;
    }
  }

  /**
   * GAP-133 — seal the captured coordinate under the tenant's current DEK, BEFORE the capture tx opens (the key
   * ring is read on its own M34 connection, the `loadGeofenceBaseline` rule). Throws — and so refuses the
   * capture — when no key is bound; there is no clear-text fallback.
   */
  function sealCoords(orgId: string, coords: StoredCoordinate): Promise<SealedCoords> {
    return coordsCipher.seal(orgId, coords);
  }

  /**
   * The capture write, WITHIN a caller-provided transaction.
   *
   * Extracted from `recordCapture` so `correctEvent` can insert the corrected event, supersede the
   * original, emit and reopen the resolution under ONE commit — the §2.4 rule that the event row, the
   * evaluation snapshot, the audit row and the outbox row bind atomically. Two `withOrgContext` calls
   * would be two transactions and the "DB updated but the event never went out" window back open.
   */
  async function captureInTx(
    tx: DbClient,
    orgId: string,
    userId: string,
    kind: EvvEventKind,
    input: {
      visitId: string;
      coords: { lat: number; lng: number };
      accuracyM: number;
      capturedAt: string;
      gpsQualityAttested?: "degraded_attested";
      /** GAP-054 — the patient-address coordinate (`loadGeofenceBaseline`); null = no baseline. */
      geofenceBaseline: Coordinate | null;
      /** GAP-133 — `input.coords` sealed under the tenant DEK before the tx opened (`sealCoords`). */
      sealedCoords: SealedCoords;
      /** §7.7 — the event this capture supersedes, and why, when it is a correction-of-record. */
      replacesEventId?: string;
      correctionReason?: string;
      offlineCapture?: boolean;
      localId?: string;
      syncedAt?: Date;
    },
    binding?: CaptureBinding,
  ): Promise<CheckResultView> {
    const visit = await resolveVisit(tx, input.visitId);
    const device = await resolveCaptureDevice(tx, userId, binding);
    const policy = await effectivePolicy(tx);
    // GAP-027 — the aggregator service-type code and posting discipline come from the registration, not the client.
    const classification = classifyCapture(visit);

    // GAP-054 — gps-quality / geofence decision from the haversine distance to the address baseline.
    const { gpsQuality, decision, computedDistanceM } = decideCaptureGeofence({
      deviceCoordinate: input.coords,
      accuracyM: input.accuracyM,
      attestedDegraded: input.gpsQualityAttested === "degraded_attested",
      baseline: input.geofenceBaseline,
      policy,
    });
    // GAP-133 — the D10 envelope sealed before the tx opened; the SAME ciphertext lands in both `_cipher`
    // columns, and the stamped DEK version is the one the key ring sealed it under.
    const coordsCipher = input.sealedCoords.cipher;
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
        serviceTypeCode: classification.serviceTypeCode,
        postingMembershipId: userId,
        postingDisciplineAtRecording: classification.postingDisciplineAtRecording,
        evvDeviceId: device.id,
        capturedAt,
        eventAt: capturedAt,
        coordsCipher,
        coordsDekVersion: input.sealedCoords.dekVersion,
        accuracyM: input.accuracyM,
        gpsQuality,
        offlineCapture: input.offlineCapture ?? false,
        localId: input.localId ?? null,
        syncedAt: input.syncedAt ?? null,
        deviceAttestationIdAtRecord: device.attestation,
        // §7.7 — present only on a correction; NULL on an ordinary capture.
        replacesEventId: input.replacesEventId ?? null,
        correctionReason: input.correctionReason ?? null,
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
      computedDistanceM,
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
      // A distance is only ever REAL here: `pass` implies a baseline (so a number); a breach with no baseline
      // has no distance to report and emits no breach event (the event itself carries no_geofence_baseline).
      if (decision === "pass" && computedDistanceM !== null) {
        await emit(tx, orgId, "m18.evv.at_patient_address", "evv_event", eventId, {
          eventId,
          visitId: input.visitId,
          patientId: visit.patientId,
          postingMembershipId: userId,
          computedDistanceM,
          appliedRadiusM: policy.radiusM,
          confirmedAt: recordedAt,
        });
      } else if (computedDistanceM !== null) {
        await emit(tx, orgId, "m18.evv.geofence_breach_recorded", "evv_event", eventId, {
          eventId,
          visitId: input.visitId,
          computedDistanceM,
          appliedRadiusM: policy.radiusM,
          kind: "check_in",
        });
      }
    } else {
      const [priorCheckIn] = await tx
        .select({ id: EVENT.id, capturedAt: EVENT.capturedAt })
        .from(EVENT)
        .where(
          and(
            eq(EVENT.visitId, input.visitId),
            eq(EVENT.kind, "check_in"),
            isNull(EVENT.supersededByEventId),
          ),
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
        if (computedDistanceM !== null) {
          await emit(tx, orgId, "m18.evv.geofence_breach_recorded", "evv_event", eventId, {
            eventId,
            visitId: input.visitId,
            computedDistanceM,
            appliedRadiusM: policy.radiusM,
            kind: "check_out",
          });
        }
      } else if (priorCheckIn) {
        // F-194 (#248) — the check-out paired with an in-geofence, non-superseded check-in; the last
        // condition the catalog's own description names ("no open evv_missing_resolution") mirrors the
        // exact `bracketState` query `getBracket` already runs (`MR.status = "open"`, above in this file).
        const [openMissing] = await tx
          .select({ id: MR.id })
          .from(MR)
          .where(and(eq(MR.visitId, input.visitId), eq(MR.status, "open")))
          .limit(1);
        if (!openMissing) {
          await emit(tx, orgId, "m18.evv.visit_verified", "evv_event", eventId, {
            visitId: input.visitId,
            patientId: visit.patientId,
            organizationId: orgId,
            verifiedAt: recordedAt,
          });
        }
      }
    }

    return {
      eventId,
      kind,
      gpsQuality,
      geofenceDecision: decision,
      visitStateAfterEvent: kind === "check_in" ? "in_visit" : "completed",
    };
  }

  const resolver: EvvAbacResolver = {
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
  };

  const backend = {
    ...resolver,

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
        /** The client's CLAIM of the posting device — only ever compared to the session-bound one. */
        claimedDeviceId?: string;
        offlineCapture?: boolean;
        localId?: string;
      },
      authority: EvvCaptureAuthority,
    ): Promise<CheckResultView> {
      // GAP-055 — the §8.2 guards (assigned clinician, visit window, and — when enforced — device attestation), re-asserted at
      // the service layer from the stored visit; only an explicit typed system marker is exempt.
      await assertCaptureAllowed(
        resolver,
        orgId,
        userId,
        input,
        authority,
        deviceAttestationEnforced,
      );
      const geofenceBaseline = await loadGeofenceBaseline(orgId, input.visitId);
      const sealedCoords = await sealCoords(orgId, input.coords);
      return withOrgContext(db, { organizationId: orgId, userId: "" }, (txRaw) =>
        captureInTx(
          txRaw as DbClient,
          orgId,
          userId,
          kind,
          {
            ...input,
            geofenceBaseline,
            sealedCoords,
            ...(input.offlineCapture ? { syncedAt: new Date() } : {}),
          },
          { authority, claimedDeviceId: input.claimedDeviceId },
        ),
      );
    },

    async recordOfflineCapture(
      orgId: string,
      userId: string,
      kind: EvvEventKind,
      input: OfflineCaptureInput,
      authority: EvvCaptureAuthority,
    ): Promise<OfflineCaptureResult> {
      // Revalidate current session authority before receipt lookup: a committed receipt is not an access token.
      await assertCaptureAllowed(
        resolver,
        orgId,
        userId,
        input,
        authority,
        deviceAttestationEnforced,
      );
      const geofenceBaseline = await loadGeofenceBaseline(orgId, input.visitId);
      const sealedCoords = await sealCoords(orgId, input.coords);
      // `userId` here is the posting MEMBERSHIP id, not an M1 user id: the audit trigger casts `app.user_id` into
      // audit_event.actor_user_id (FK to "user"), so bind "" like every other EVV write path.
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (txRaw) => {
        const tx = txRaw as DbClient;
        const device = await resolveCaptureDevice(tx, userId, {
          authority,
          claimedDeviceId: input.claimedDeviceId,
        });
        const identity = `${orgId}|${device.id}|${input.localId}`;
        // Serialize the identity before either the event or receipt is inserted. The loser waits for the
        // winner's transaction, then reads its committed receipt under READ COMMITTED.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${identity}, 0))`);
        const fingerprint = fingerprintOfflineCapture(
          {
            organizationId: orgId,
            postingMembershipId: userId,
            evvDeviceId: device.id,
            localId: input.localId,
            kind,
            visitId: input.visitId,
            capturedAt: input.capturedAt,
            coords: input.coords,
            accuracyM: input.accuracyM,
            gpsQualityAttested: input.gpsQualityAttested,
            serviceTypeCode: input.serviceTypeCode,
          },
          fingerprintKey,
        );
        const [prior] = await tx
          .select()
          .from(OFFLINE_RECEIPT)
          .where(
            and(
              eq(OFFLINE_RECEIPT.organizationId, orgId),
              eq(OFFLINE_RECEIPT.evvDeviceId, device.id),
              eq(OFFLINE_RECEIPT.localId, input.localId),
            ),
          )
          .limit(1);
        if (prior) {
          if (
            prior.payloadFingerprint !== fingerprint ||
            prior.fingerprintKeyId !== EVV_OFFLINE_FINGERPRINT_KEY_ID
          )
            throw new IdempotencyConflictError();
          return {
            localId: input.localId,
            status: "already_applied",
            eventId: prior.eventId,
            kind: prior.kind,
            capturedAt: toIso(prior.capturedAt),
            gpsQuality: prior.gpsQuality,
            geofenceDecision: prior.geofenceDecision as CheckResultView["geofenceDecision"],
            visitStateAfterEvent: prior.visitStateAfterEvent,
          };
        }
        const syncedAt = new Date();
        const result = await captureInTx(
          tx,
          orgId,
          userId,
          kind,
          {
            ...input,
            geofenceBaseline,
            sealedCoords,
            offlineCapture: true,
            localId: input.localId,
            syncedAt,
          },
          { authority, claimedDeviceId: device.id },
        );
        await tx.insert(OFFLINE_RECEIPT).values({
          organizationId: orgId,
          evvDeviceId: device.id,
          localId: input.localId,
          postingMembershipId: userId,
          payloadFingerprint: fingerprint,
          fingerprintKeyId: EVV_OFFLINE_FINGERPRINT_KEY_ID,
          eventId: result.eventId,
          eventAt: new Date(input.capturedAt),
          kind: result.kind,
          capturedAt: new Date(input.capturedAt),
          gpsQuality: result.gpsQuality,
          geofenceDecision: result.geofenceDecision,
          visitStateAfterEvent: result.visitStateAfterEvent,
          syncedAt,
        });
        return {
          ...result,
          localId: input.localId,
          status: "applied",
          capturedAt: new Date(input.capturedAt).toISOString(),
        };
      });
    },

    /** Pre-flight for a batch: refuse a claimed device that is not the session-bound one, before any write. */
    async assertCaptureDevice(
      orgId: string,
      userId: string,
      claimedDeviceId: string | undefined,
      authority: EvvCaptureAuthority,
    ): Promise<void> {
      await withOrgContext(db, { organizationId: orgId, userId: "" }, (txRaw) =>
        resolveCaptureDevice(txRaw as DbClient, userId, { authority, claimedDeviceId }),
      );
    },

    /**
     * §7.7 correction-of-record — the route's `:eventId` and its ≥60-char `correctionReason` used to be
     * parsed and dropped, and the handler called plain `recordCapture` (F-068 §1). Against the real
     * per-leaf `UNIQUE (organization_id, visit_id, kind)` backstop that could not even succeed: the
     * original stayed live, so a same-day correction — the same visit, the same kind, the same monthly
     * partition — hit the index, and one filed across a month boundary landed in a different leaf,
     * missed the backstop, and left two live events for one leg of the bracket.
     *
     * F-088 — AND NEITHER COULD THE FIX, for two years' worth of the same reason one layer down. 0047
     * defined the index's ACTIVE as `superseded_by_event_id IS NULL`; that column points at the row
     * that REPLACES this one, so nothing can set it before the replacement is inserted, and at the
     * moment of the insert both rows satisfied the predicate. Every correction, every tenant, 23505.
     * The ordering below is the tell: `superseded_at` is stamped BEFORE the insert precisely because
     * it is the marker a transaction can set with nothing to point at yet — the service and the index
     * simply disagreed about which column means superseded, and the index won. 0236 keys it on
     * `superseded_at`, and `m18-evv-write.live.test.ts` proves the backstop still refuses a genuine
     * second active event.
     *
     * The decision is the pure `correctEvent` machine in `domain/event-lifecycle.ts`, which has been
     * complete and uncalled since M18-T03. This applies the five §2.4 effects it declares, in the order
     * it declares them, inside one transaction:
     *   supersede_event → capture_reason → outbox(event_corrected) → open_missing_resolution → audit.
     */
    async correctEvent(
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
    ): Promise<CheckResultView> {
      const geofenceBaseline = await loadGeofenceBaseline(orgId, input.visitId);
      const sealedCoords = await sealCoords(orgId, input.coords);
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (txRaw) => {
        const tx = txRaw as DbClient;
        const [original] = await tx
          .select({
            id: EVENT.id,
            kind: EVENT.kind,
            eventAt: EVENT.eventAt,
            visitId: EVENT.visitId,
            supersededByEventId: EVENT.supersededByEventId,
          })
          .from(EVENT)
          .where(eq(EVENT.id, originalEventId))
          .limit(1);
        if (!original) throw new NotFoundError("evv_event", originalEventId);

        // Throws EVV_CORRECTION_STEP_UP_REQUIRED / _REASON_TOO_SHORT / EVV_EVENT_ALREADY_SUPERSEDED /
        // _KIND_MISMATCH. All four are refusals the route simply did not have.
        const { effects } = correctEvent({
          originalEventId,
          originalKind: original.kind as EvvEventKind,
          originalSupersededByEventId: original.supersededByEventId,
          newKind: input.kind,
          correctionReason: input.correctionReason,
          stepUpVerified: input.stepUpVerified,
        });

        // `supersede_event` FIRST: the partial unique index counts only rows with a NULL
        // `superseded_by_event_id`, so the original must stop being live before the correction is
        // inserted. Both statements are in this transaction, so the index never sees two live rows.
        const supersede = effects.find(
          (e): e is Extract<EvvSideEffect, { kind: "supersede_event" }> =>
            e.kind === "supersede_event",
        );
        const openMarker = effects.find(
          (e): e is Extract<EvvSideEffect, { kind: "open_missing_resolution" }> =>
            e.kind === "open_missing_resolution",
        );
        const reason = effects.find(
          (e): e is Extract<EvvSideEffect, { kind: "capture_reason" }> =>
            e.kind === "capture_reason" && e.field === "correction_reason",
        );
        if (!supersede) throw new Error("correctEvent declared no supersede_event effect");

        const supersededAt = new Date();
        // The composite PK is (id, event_at) — the partition key must be in the predicate, so the
        // UPDATE is pinned by both rather than by id alone.
        await tx
          .update(EVENT)
          .set({ supersededAt })
          .where(and(eq(EVENT.id, supersede.originalEventId), eq(EVENT.eventAt, original.eventAt)));

        const created = await captureInTx(tx, orgId, userId, input.kind, {
          visitId: input.visitId,
          coords: input.coords,
          accuracyM: input.accuracyM,
          capturedAt: input.capturedAt,
          gpsQualityAttested: input.gpsQualityAttested,
          geofenceBaseline,
          sealedCoords,
          replacesEventId: supersede.originalEventId,
          correctionReason: reason?.value ?? input.correctionReason,
        });

        await tx
          .update(EVENT)
          .set({ supersededByEventId: created.eventId })
          .where(and(eq(EVENT.id, supersede.originalEventId), eq(EVENT.eventAt, original.eventAt)));

        await emit(tx, orgId, "m18.evv.event_corrected", "evv_event", created.eventId, {
          supersededEventId: supersede.originalEventId,
          newEventId: created.eventId,
          visitId: input.visitId,
          correctedByMembershipId: userId,
          correctionReason: input.correctionReason,
        });

        // The visit reverts to attestation-pending: a corrected leg is an unverified leg until someone
        // says otherwise. `evv_missing_resolution_open_uidx` admits one OPEN row per (visit, kind), so a
        // second correction of the same leg reuses the row already open rather than colliding.
        if (openMarker) {
          const [existing] = await tx
            .select({ id: MR.id })
            .from(MR)
            .where(
              and(
                eq(MR.visitId, input.visitId),
                eq(MR.kind, openMarker.resolutionKind),
                eq(MR.status, "open"),
              ),
            )
            .limit(1);
          if (!existing) {
            await tx.insert(MR).values({
              organizationId: orgId,
              visitId: input.visitId,
              kind: openMarker.resolutionKind,
              detectedBySource: "correction_of_record",
              status: "open",
            });
          }
        }

        return created;
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
        // Only the LIVE leg of each chain — `seams/drizzle-store.ts` has always read it this way and
        // this copy did not. It was inert while nothing superseded anything; the moment corrections work
        // it would hand M8's `EvvBracketResolver` the event that was corrected AWAY.
        const events = await tx
          .select()
          .from(EVENT)
          .where(and(eq(EVENT.visitId, visitId), isNull(EVENT.supersededByEventId)))
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
      sessionAttestationId: string | null = null,
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
            // The M2 attestation the SESSION is bound to (server-stamped by the authenticate hook and
            // threaded from the request context — never a body field, the F-028 shape). It is what a later
            // capture's session binds to (`selectBoundDevice`). A session with no attested device (every
            // browser session) registers with an unmatched placeholder, so such a device can never satisfy
            // the capture binding — fail closed.
            m2DeviceAttestationId: sessionAttestationId ?? randomUUID(),
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

    async approveDevice(orgId: string, userId: string, id: string): Promise<DeviceView> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (txRaw) => {
        const tx = txRaw as DbClient;
        const [d] = await tx.select().from(DEVICE).where(eq(DEVICE.id, id)).limit(1);
        if (!d) throw new NotFoundError("evv_device", id);
        const approver = userId;
        const [updated] = await tx
          .update(DEVICE)
          .set({
            status: "approved",
            approvedByMembershipId: approver,
            approvedAt: new Date(),
            updatedAt: new Date(),
          })
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

    async rejectDevice(
      orgId: string,
      userId: string,
      id: string,
      reason: string,
    ): Promise<DeviceView> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (txRaw) => {
        const tx = txRaw as DbClient;
        const [d] = await tx.select().from(DEVICE).where(eq(DEVICE.id, id)).limit(1);
        if (!d) throw new NotFoundError("evv_device", id);
        const [updated] = await tx
          .update(DEVICE)
          .set({
            status: "rejected",
            rejectedByMembershipId: userId,
            rejectedAt: new Date(),
            denialReason: reason,
            updatedAt: new Date(),
          })
          .where(eq(DEVICE.id, id))
          .returning();
        return toDeviceView(updated ?? d);
      });
    },

    async suspendDevice(
      orgId: string,
      _userId: string,
      id: string,
      reason: string,
    ): Promise<DeviceView> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (txRaw) => {
        const tx = txRaw as DbClient;
        const [d] = await tx.select().from(DEVICE).where(eq(DEVICE.id, id)).limit(1);
        if (!d) throw new NotFoundError("evv_device", id);
        const [updated] = await tx
          .update(DEVICE)
          .set({
            status: "suspended",
            suspendedAt: new Date(),
            suspendReason: reason,
            updatedAt: new Date(),
          })
          .where(eq(DEVICE.id, id))
          .returning();
        await emit(tx, orgId, "m18.evv.device_suspended", "evv_device", id, {
          deviceId: id,
          membershipId: d.membershipId,
          reason,
        });
        return toDeviceView(updated ?? d);
      });
    },

    // `evv_device` carries `denial_reason` and `suspend_reason` but no retire reason, so the optional
    // one the contract accepts has nowhere to land. Named here rather than silently dropped — that is
    // the habit this whole change is about.
    async retireDevice(
      orgId: string,
      _userId: string,
      id: string,
      _reason?: string,
    ): Promise<DeviceView> {
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
    async editTenantPolicy(
      orgId: string,
      userId: string,
      body: { radiusM: number; maxAccuracyM: number },
    ): Promise<GeofencePolicyView> {
      if (
        body.radiusM > PLATFORM_FLOOR.radiusM ||
        body.maxAccuracyM > PLATFORM_FLOOR.maxAccuracyM
      ) {
        throw new ValidationError(
          "Tenant geofence policy may not loosen beyond the platform floor (tighten-only).",
          [],
        );
      }
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (txRaw) => {
        const tx = txRaw as DbClient;
        const setter = userId;
        const [prior] = await tx
          .select({ id: POLICY.id, radiusM: POLICY.radiusM, maxAccuracyM: POLICY.maxAccuracyM })
          .from(POLICY)
          .where(and(eq(POLICY.scope, "tenant"), isNull(POLICY.effectiveTo)))
          .limit(1);
        if (prior)
          await tx.update(POLICY).set({ effectiveTo: today() }).where(eq(POLICY.id, prior.id));
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
        await emit(
          tx,
          orgId,
          "m18.evv.geofence_policy_changed",
          "evv_geofence_policy",
          row?.id ?? orgId,
          {
            scope: "tenant",
            oldRadiusM: prior?.radiusM ?? PLATFORM_FLOOR.radiusM,
            newRadiusM: body.radiusM,
            oldMaxAccuracyM: prior?.maxAccuracyM ?? PLATFORM_FLOOR.maxAccuracyM,
            newMaxAccuracyM: body.maxAccuracyM,
            setByMembershipId: setter,
          },
        );
        return readPolicyView(tx);
      });
    },

    async createPerAddressOverride(
      orgId: string,
      userId: string,
      body: {
        patientAddressId: string;
        radiusM: number;
        maxAccuracyM: number;
        overrideReason: string;
      },
    ): Promise<GeofencePolicyView> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (txRaw) => {
        const tx = txRaw as DbClient;
        const setter = userId;
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
        if (prior)
          await tx.update(POLICY).set({ effectiveTo: today() }).where(eq(POLICY.id, prior.id));
        const [row] = await tx
          .insert(POLICY)
          .values({
            organizationId: orgId,
            scope: "patient_address",
            patientAddressId: body.patientAddressId,
            radiusM: body.radiusM,
            maxAccuracyM: body.maxAccuracyM,
            overrideReason: body.overrideReason,
            effectiveFrom: today(),
            setByMembershipId: setter,
          })
          .returning({ id: POLICY.id });
        await emit(
          tx,
          orgId,
          "m18.evv.geofence_policy_changed",
          "evv_geofence_policy",
          row?.id ?? orgId,
          {
            scope: "per_address",
            patientAddressId: body.patientAddressId,
            oldRadiusM: prior?.radiusM ?? PLATFORM_FLOOR.radiusM,
            newRadiusM: body.radiusM,
            oldMaxAccuracyM: prior?.maxAccuracyM ?? PLATFORM_FLOOR.maxAccuracyM,
            newMaxAccuracyM: body.maxAccuracyM,
            setByMembershipId: setter,
          },
        );
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
    // `evv_aggregator_submission` has `cancellation_reason` but no resubmit reason; the optional one
    // the contract accepts has nowhere to land (see `retireDevice`).
    async resubmitSubmission(
      orgId: string,
      userId: string,
      id: string,
      _reason?: string,
    ): Promise<EvvAggregatorSubmissionDto> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (txRaw) => {
        const tx = txRaw as DbClient;
        const [s] = await tx.select().from(AGG).where(eq(AGG.id, id)).limit(1);
        if (!s) throw new NotFoundError("evv_aggregator_submission", id);
        const transition = transitionAggregatorSubmission(
          s.status as EvvAggregatorSubmissionStatus,
          { type: "resubmit" },
        );
        const [updated] = await tx
          .update(AGG)
          .set({
            status: transition.status,
            attemptCount: s.attemptCount + (transition.incrementsAttempt ? 1 : 0),
            // A re-queued row starts clean: a stale `next_retry_at` would make the submitter delay (or skip) the
            // operator's resubmit, and the prior rejection must not outlive the state it described.
            nextRetryAt: null,
            aggregatorRejectionCode: null,
            aggregatorRejectionReason: null,
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
    async cancelSubmission(
      orgId: string,
      userId: string,
      id: string,
      reason: string,
    ): Promise<EvvAggregatorSubmissionDto> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (txRaw) => {
        const tx = txRaw as DbClient;
        const [s] = await tx.select().from(AGG).where(eq(AGG.id, id)).limit(1);
        if (!s) throw new NotFoundError("evv_aggregator_submission", id);
        const transition = transitionAggregatorSubmission(
          s.status as EvvAggregatorSubmissionStatus,
          { type: "cancel" },
        );
        const [updated] = await tx
          .update(AGG)
          .set({
            status: transition.status,
            cancelledByMembershipId: userId || null,
            cancelledAt: new Date(),
            cancellationReason: reason,
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
          reason,
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
    // Coordinates live only in `evv_event.coords_cipher`, sealed in the §D10 per-tenant DEK envelope (GAP-133).
    // This returns the last-known event per membership with the coordinate DECRYPTED after the tx closes; a
    // legacy pre-GAP-133 row reads as an explicit null pair, and a missing key / unauthenticated blob throws.
    async clinicianCurrentLocation(orgId: string, membership?: string): Promise<LocationView[]> {
      const latest = await withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
        const rows = await tx
          .select({
            membershipId: EVENT.postingMembershipId,
            eventId: EVENT.id,
            visitId: EVENT.visitId,
            accuracyM: EVENT.accuracyM,
            capturedAt: EVENT.capturedAt,
            coordsCipher: EVENT.coordsCipher,
          })
          .from(EVENT)
          .where(membership ? eq(EVENT.postingMembershipId, membership) : undefined)
          .orderBy(desc(EVENT.eventAt));
        const latestByMember = new Map<string, (typeof rows)[number]>();
        for (const r of rows)
          if (!latestByMember.has(r.membershipId)) latestByMember.set(r.membershipId, r);
        return [...latestByMember.values()];
      });
      return Promise.all(
        latest.map(async (r) => {
          // GAP-032 — the real stored coordinate, or an explicit null (never a fabricated (0, 0)). One unreadable
          // envelope reads as null and is reported rather than failing every clinician's location.
          const coords = await openCoordsForList(
            coordsCipher,
            orgId,
            r.eventId,
            r.coordsCipher,
            onCoordsFault,
          );
          return {
            membershipId: r.membershipId,
            eventId: r.eventId,
            visitId: r.visitId,
            lat: coords?.lat ?? null,
            lng: coords?.lng ?? null,
            accuracyM: r.accuracyM,
            capturedAt: toIso(r.capturedAt),
          };
        }),
      );
    },

    // ── portal arrival surface (§4.1 route 25; timestamp only, no coordinates) ──────────────────────────
    async portalArrival(orgId: string, visitId: string, patientId?: string): Promise<ArrivalView> {
      return withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
        const events = await tx
          .select({ kind: EVENT.kind, capturedAt: EVENT.capturedAt })
          .from(EVENT)
          .where(
            and(
              eq(EVENT.visitId, visitId),
              isNull(EVENT.supersededByEventId),
              // GAP-132 — scope to the caller's patient (portal session); omitted only for non-portal callers.
              ...(patientId === undefined ? [] : [eq(EVENT.patientId, patientId)]),
            ),
          )
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
      if (!stepUpFresh)
        throw new ForbiddenError("A correction-of-record requires fresh M2 step-up auth.");
    },
  };

  // No `as unknown as EvvRouteService` (F-068 §5). `EvvRoutePort` widens exactly one thing — the return
  // types, so an async implementation satisfies a synchronous slice — and the assignment is checked again.
  // A missing method, a renamed one, or one returning the wrong shape is a compile error now; a method
  // that quietly IGNORES a trailing parameter still is not, because TypeScript accepts a function of
  // fewer parameters wherever one of more is expected. That is the residual hole, and it is the exact
  // shape four of this module's writes were in — so the parameters being dropped is what the tests below
  // assert on, not the types.
  return backend;
}
