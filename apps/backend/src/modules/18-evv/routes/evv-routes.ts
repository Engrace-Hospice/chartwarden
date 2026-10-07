// apps/backend/src/modules/18-evv/routes/evv-routes.ts — M18-T06 the §4.1 route inventory behind the REAL
// Authorization Contract (`requirePermission`/`requireAbac` from @wardenx/auth, M3) over the §4.6 keys M18
// registers into M3's catalog (`M18_CONTRIBUTED_PERMISSIONS`). Org binding is server-side (`request.context`,
// never the body). Handlers compose over the injected {@link EvvRoutePort} (in-memory slice; Drizzle in prod
// under `withOrgContext` so RLS backstops every read/write).
//
// §4.7 wiring: the `POST /evv/check-in` / `POST /evv/check-out` routes compose M18's two OWNED capture
// predicates (`assigned_clinician_for_visit` ∧ `evv_within_visit_window`) against a target lifted from the body
// (`visitId` + `eventCapturedAt`) and the session (`membershipId` = the posting membership). The
// correction-of-record route requires fresh M2 step-up (Clinical Supervisor+, §2.3); the supervisor-override
// resolution route likewise. The portal arrival route runs under the portal session class (per-patient via M39
// consent, not caseload).
import {
  type AbacTarget,
  DEVICE_ATTESTATION_ATTRIBUTE,
  requireAbac,
  requirePermission,
} from "@wardenx/auth";
import { ForbiddenError, NotFoundError, UnauthorizedError } from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requestStepUpFresh } from "../../../bootstrap/index";
import { clinicianCapture } from "../capture-guards";
import {
  AggregatorListQuery,
  CancelSubmissionRequest,
  CheckInRequest,
  CheckOutRequest,
  ClinicianAttestResolutionRequest,
  CorrectEventRequest,
  CreatePerAddressOverrideRequest,
  EditTenantPolicyRequest,
  EventGetQuery,
  EventIdParams,
  EventListQuery,
  IdParams,
  MembershipIdQuery,
  MetricsQuery,
  MissingResolutionListQuery,
  OfflineSyncRequest,
  RejectDeviceRequest,
  ResubmitSubmissionRequest,
  RetireDeviceRequest,
  SelfRegisterDeviceRequest,
  SupervisorOverrideResolutionRequest,
  SuspendDeviceRequest,
  VisitIdParams,
  parse,
} from "./evv-typebox";
import type { EvvRoutePort } from "./service";

/** A @wardenx/auth GuardHandler wrapped as a Fastify preHandler (structurally assignable). */
type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface EvvRouteDeps {
  service: EvvRoutePort;
  /**
   * GAP-055 follow-up (ADR-0035): apply the `device_attestation_valid` gate to check-in / check-out /
   * offline-sync. Injected from validated server config (`EVV_DEVICE_ATTESTATION_ENFORCED`) — never from a
   * request. Default OFF (no attested client exists yet); the assigned-clinician and visit-window gates
   * apply either way. The service must be built with the same value.
   */
  deviceAttestationEnforced?: boolean;
}

function actorOf(request: FastifyRequest): { organizationId: string; userId: string } {
  const ctx = request.context;
  // `userId` here is the codebase-wide convention of "the acting MEMBERSHIP id" (every FK this value
  // feeds — posting_membership_id, approved_by_membership_id, etc. — references `membership.id`, not
  // Better Auth's `user.id`).
  const membershipId = ctx?.attributes.membershipId;
  if (!ctx?.organizationId || typeof membershipId !== "string") throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: membershipId };
}

/**
 * The M2 step-up freshness signal the correction-of-record (§2.3) and the D6 supervisor override need.
 *
 * Was `request.headers["x-step-up"] === "fresh"` — a client-supplied string, which made the step-up on a
 * retroactive EVV correction and on a supervisor override self-asserted by the very caller being gated
 * (F-028). Resolves the real session state through M2's `SessionContextResolver` seam now. The boolean
 * (rather than a `requireStepUp` preHandler) is kept because the refusals belong to the service and the
 * pure `transitionMissingResolution` machine, which carry their own reasons.
 */
const CORRECT_STEP_UP_OPERATION = "evv.correct_record";
const OVERRIDE_STEP_UP_OPERATION = "evv.missing_resolution.supervisor_override";

// Static permission guards (§4.6).
const P = (key: string): PreHandler => requirePermission(key) as PreHandler;
const CHECK_IN = P("evv.check_in");
const CHECK_OUT = P("evv.check_out");
const READ = P("evv.read");
const CORRECT = P("evv.correct_record");
const DEVICE_READ = P("evv.device.read");
const DEVICE_REGISTER = P("evv.device.register_self");
const DEVICE_APPROVE = P("evv.device.approve");
const DEVICE_SUSPEND = P("evv.device.suspend");
const DEVICE_RETIRE = P("evv.device.retire");
const POLICY_READ = P("evv.policy.read");
const POLICY_EDIT = P("evv.policy.edit");
const MR_READ = P("evv.missing_resolution.read");
const MR_ATTEST = P("evv.missing_resolution.attest_self");
const MR_OVERRIDE = P("evv.missing_resolution.supervisor_override");
const AGG_READ = P("evv.aggregator.read");
const AGG_RESUBMIT = P("evv.aggregator.resubmit");
const AGG_CANCEL = P("evv.aggregator.cancel");
const READ_METRICS = P("evv.read_metrics");
const LOCATION_READ = P("evv.location.read_team");
const PORTAL_ARRIVAL = P("portal.evv.read_arrival");
// GAP-132 — the portal session is paired with its pinned patient by an ACTIVE M31 grant AND a live M39 consent
// (`portal_grant_active_for_patient`, resolved by name from the shared ABAC registry — no M31 import). Account and
// patient come from the SESSION, never the request; a withdrawn consent refuses the read before any byte crosses.
const sessionAttrOf = (request: FastifyRequest, key: string): string => {
  const value = request.context?.attributes?.[key];
  return typeof value === "string" ? value : "";
};
const ABAC_PORTAL_GRANT = (action: string): PreHandler =>
  requireAbac(action, "portal_grant_active_for_patient", {
    getTarget: ((r: FastifyRequest) => ({
      portalAccountId: sessionAttrOf(r, "portalAccountId"),
      patientId: sessionAttrOf(r, "sessionPatientId"),
    })) as never,
    notFoundOnDeny: false,
  }) as PreHandler;
const PORTAL_GRANT = ABAC_PORTAL_GRANT("portal.evv.read_arrival");

// §4.7 — the capture routes' gate target: visitId + capturedAt from the body, membershipId from the session.
const captureGateTarget = (request: {
  readonly body?: unknown;
  readonly context?: { readonly attributes?: { readonly membershipId?: unknown } };
}): AbacTarget => {
  const body = (request.body ?? {}) as { visitId?: unknown; capturedAt?: unknown };
  const target: Record<string, unknown> = {};
  if (typeof body.visitId === "string") target.visitId = body.visitId;
  if (typeof body.capturedAt === "string") target.eventCapturedAt = body.capturedAt;
  if (typeof request.context?.attributes?.membershipId === "string")
    target.membershipId = request.context.attributes.membershipId;
  return target;
};
// GAP-055 — break-glass proves an emergency, not that the caller is the assigned clinician, inside the visit
// window, on an attested device; a capture is a mutating, attributable legal record, so no grant stands in.
const CAPTURE_GATE_OPTIONS = { getTarget: captureGateTarget, breakGlassBypassable: false } as const;
const CAPTURE_GATE = (permission: string, predicate: string): PreHandler =>
  requireAbac(permission, predicate, CAPTURE_GATE_OPTIONS) as PreHandler;
// §8.2 — the session-bound attestation verdict (the shared M3 predicate reads the server-stamped attribute).
// Mounted only when `EVV_DEVICE_ATTESTATION_ENFORCED` is on (`deps.deviceAttestationEnforced`).
const attestationGate = (permission: string): PreHandler =>
  requireAbac(permission, "device_attestation_valid", {
    breakGlassBypassable: false,
  }) as PreHandler;
const CHECK_IN_ASSIGNED = CAPTURE_GATE("evv.check_in", "assigned_clinician_for_visit");
const CHECK_IN_WINDOW = CAPTURE_GATE("evv.check_in", "evv_within_visit_window");
const CHECK_IN_ATTESTED = attestationGate("evv.check_in");
const CHECK_OUT_ASSIGNED = CAPTURE_GATE("evv.check_out", "assigned_clinician_for_visit");
const CHECK_OUT_WINDOW = CAPTURE_GATE("evv.check_out", "evv_within_visit_window");
const CHECK_OUT_ATTESTED = attestationGate("evv.check_out");

/** The service-layer authority for a capture: the SESSION's attestation verdict, never a body field. */
const captureAuthorityOf = (request: FastifyRequest) =>
  clinicianCapture(request.context?.attributes?.[DEVICE_ATTESTATION_ATTRIBUTE]);

/** The M2 attestation id the SESSION is bound to (server-stamped), or null — never a body field. */
const sessionAttestationIdOf = (request: FastifyRequest): string | null =>
  captureAuthorityOf(request).deviceAttestation?.attestationId ?? null;

export function registerEvvRoutes(app: FastifyInstance, deps: EvvRouteDeps): void {
  const { service } = deps;
  const attested = deps.deviceAttestationEnforced === true;
  /** The attestation preHandler for a route, present only when attestation is enforced. */
  const attestationGates = (gate: PreHandler): PreHandler[] => (attested ? [gate] : []);

  // 1 — record a check-in (runs the two §4.7 capture predicates after RBAC).
  app.post(
    "/api/v1/evv/check-in",
    {
      preHandler: [
        CHECK_IN,
        ...attestationGates(CHECK_IN_ATTESTED),
        CHECK_IN_ASSIGNED,
        CHECK_IN_WINDOW,
      ],
    },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const b = parse(CheckInRequest, request.body);
      const res = await service.recordCapture(
        organizationId,
        userId,
        "check_in",
        {
          visitId: b.visitId,
          coords: b.coords,
          accuracyM: b.accuracyM,
          capturedAt: b.capturedAt,
          gpsQualityAttested: b.gpsQualityAttested,
          claimedDeviceId: b.evvDeviceId,
        },
        captureAuthorityOf(request),
      );
      return reply.code(201).send(res);
    },
  );

  // 2 — record a check-out.
  app.post(
    "/api/v1/evv/check-out",
    {
      preHandler: [
        CHECK_OUT,
        ...attestationGates(CHECK_OUT_ATTESTED),
        CHECK_OUT_ASSIGNED,
        CHECK_OUT_WINDOW,
      ],
    },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const b = parse(CheckOutRequest, request.body);
      const res = await service.recordCapture(
        organizationId,
        userId,
        "check_out",
        {
          visitId: b.visitId,
          coords: b.coords,
          accuracyM: b.accuracyM,
          capturedAt: b.capturedAt,
          gpsQualityAttested: b.gpsQualityAttested,
          claimedDeviceId: b.evvDeviceId,
        },
        captureAuthorityOf(request),
      );
      return reply.code(201).send(res);
    },
  );

  // 3 — batch offline-sync. GAP-055: every event is held to the SAME guards as the single capture routes,
  // derived server-side — the clinician is the session actor; the assignment and the window come from the
  // stored visit; attestation is the session's. The per-event RBAC key follows the event's kind (a check-out
  // needs `evv.check_out`, which the route-level `evv.check_in` does not imply). Every event is checked
  // BEFORE any is written, so one guard failure refuses the whole batch (the module-wide offline-sync
  // convention, cf. M13) — a denied event cannot slip through behind a "synced" ack. The writes themselves are
  // independent transactions, so a runtime failure on event N can still leave events 1..N-1 committed.
  app.post("/api/v1/evv/offline-sync", { preHandler: [CHECK_IN] }, async (request) => {
    const { organizationId, userId } = actorOf(request);
    const b = parse(OfflineSyncRequest, request.body);
    const authority = captureAuthorityOf(request);
    const checked = new Set<string>();
    for (const e of b.events) {
      const permission = e.kind === "check_out" ? "evv.check_out" : "evv.check_in";
      const key = `${permission}|${e.visitId}|${e.capturedAt}`;
      if (checked.has(key)) continue;
      const target = captureGateTarget({
        body: { visitId: e.visitId, capturedAt: e.capturedAt },
        context: request.context,
      });
      await requirePermission(permission)(request);
      if (attested)
        await requireAbac(permission, "device_attestation_valid", {
          breakGlassBypassable: false,
        })(request);
      await requireAbac(permission, "assigned_clinician_for_visit", {
        getTarget: () => target,
        breakGlassBypassable: false,
      })(request);
      await requireAbac(permission, "evv_within_visit_window", {
        getTarget: () => target,
        breakGlassBypassable: false,
      })(request);
      checked.add(key);
    }
    // The batch-level and per-event device claims must agree, and every claim must be acceptable for the
    // session (the session-bound device when enforced; any approved device of the same membership when not) —
    // checked for the whole batch before any event is written. A claim never widens past the clinician.
    const claims = new Set<string>([b.evvDeviceId]);
    for (const e of b.events) {
      if (e.evvDeviceId !== b.evvDeviceId)
        throw new ForbiddenError("an offline-sync event names a different device than the batch");
      claims.add(e.evvDeviceId);
    }
    for (const claimed of claims)
      await service.assertCaptureDevice(organizationId, userId, claimed, authority);
    // `Promise.all`, not a bare `.map` (F-068 §2): the production service is async. The service re-asserts
    // the same guards per event (defence in depth).
    return Promise.all(
      b.events.map((e) =>
        service.recordCapture(
          organizationId,
          userId,
          e.kind,
          {
            visitId: e.visitId,
            coords: e.coords,
            accuracyM: e.accuracyM,
            capturedAt: e.capturedAt,
            gpsQualityAttested: e.gpsQualityAttested,
            claimedDeviceId: e.evvDeviceId,
          },
          authority,
        ),
      ),
    );
  });

  // 4 — fetch one event (coords only with ?include=coords + evv.read_coords; the slice returns metadata).
  app.get(
    "/api/v1/evv/events/:eventId",
    {
      preHandler: [READ],
      config: { auditRead: { resourceKind: "evv_visit_event", resourceIdParam: "eventId" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { eventId } = parse(EventIdParams, request.params);
      parse(EventGetQuery, request.query);
      return service.getEvent(organizationId, eventId);
    },
  );

  // 5 — list events by filters.
  app.get(
    "/api/v1/evv/events",
    { preHandler: [READ], config: { auditRead: { resourceKind: "evv_visit_event", list: true } } },
    async (request) => {
      const { organizationId } = actorOf(request);
      const q = parse(EventListQuery, request.query);
      return service.listEvents(organizationId, {
        visit: q.visit,
        clinician: q.clinician,
        patient: q.patient,
        kind: q.kind,
      });
    },
  );

  // 6 — correction-of-record (Clinical Supervisor+, step-up; §2.3, §7.7).
  //
  // Goes through `service.correctEvent`, which runs the pure `correctEvent` machine and applies its five
  // §2.4 effects in one transaction. It used to call plain `recordCapture` with the `:eventId` param and
  // the ≥60-char `correctionReason` parsed and thrown away (F-068 §1) — no supersede, no link, no reason,
  // no `event_corrected` emission for M8/M17 to re-read on, no reopened resolution, and none of the four
  // refusals the machine carries.
  app.post("/api/v1/evv/events/:eventId/correct", { preHandler: [CORRECT] }, async (request) => {
    const { organizationId, userId } = actorOf(request);
    const { eventId } = parse(EventIdParams, request.params);
    const b = parse(CorrectEventRequest, request.body);
    const e = b.newEvent;
    // Step-up first, then the lookup: the machine checks it too, but it can only do so after the row is
    // read, and a caller who has not re-authenticated should be refused without learning whether the
    // event id exists. `assertStepUp` throws the same ForbiddenError the route always did.
    const stepUpVerified = await requestStepUpFresh(request, CORRECT_STEP_UP_OPERATION);
    service.assertStepUp(stepUpVerified);
    return service.correctEvent(organizationId, userId, eventId, {
      // `serviceTypeCode` is CheckInRequest's only discriminating field; a mismatch against the original
      // is the machine's EVV_CORRECTION_KIND_MISMATCH refusal rather than a silently swapped leg.
      kind: "serviceTypeCode" in e ? "check_in" : "check_out",
      visitId: e.visitId,
      coords: e.coords,
      accuracyM: e.accuracyM,
      capturedAt: e.capturedAt,
      gpsQualityAttested: e.gpsQualityAttested,
      correctionReason: b.correctionReason,
      stepUpVerified,
    });
  });

  // 7 — the EVV bracket for a visit (M8's EvvBracketResolver reads this).
  app.get(
    "/api/v1/evv/visits/:visitId/bracket",
    {
      preHandler: [READ],
      config: { auditRead: { resourceKind: "evv_visit_bracket", resourceIdParam: "visitId" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { visitId } = parse(VisitIdParams, request.params);
      return service.bracketForVisit(organizationId, visitId);
    },
  );

  // 8 — list registered devices (self or supervisor).
  app.get(
    "/api/v1/evv/devices",
    {
      preHandler: [DEVICE_READ],
      config: {
        auditRead: {
          none: "Device inventory is clinician/device hardware metadata (platform, model, status) — carries no patient identifiers or clinical content.",
        },
      },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const q = parse(MembershipIdQuery, request.query);
      return service.listDevices(organizationId, q.membership);
    },
  );

  // 9 — clinician self-registers a new device (→ pending_approval).
  app.post(
    "/api/v1/evv/devices/self-register",
    { preHandler: [DEVICE_REGISTER] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const b = parse(SelfRegisterDeviceRequest, request.body);
      return reply
        .code(201)
        .send(
          await service.selfRegisterDevice(
            organizationId,
            userId,
            { platform: b.platform, modelDescription: b.modelDescription },
            sessionAttestationIdOf(request),
          ),
        );
    },
  );

  // 10 — approve a pending device.
  app.post("/api/v1/evv/devices/:id/approve", { preHandler: [DEVICE_APPROVE] }, async (request) => {
    const { organizationId, userId } = actorOf(request);
    const { id } = parse(IdParams, request.params);
    return service.approveDevice(organizationId, userId, id);
  });

  // 11 — reject a pending device (reason).
  app.post("/api/v1/evv/devices/:id/reject", { preHandler: [DEVICE_APPROVE] }, async (request) => {
    const { organizationId, userId } = actorOf(request);
    const { id } = parse(IdParams, request.params);
    const b = parse(RejectDeviceRequest, request.body);
    return service.rejectDevice(organizationId, userId, id, b.reason);
  });

  // 12 — suspend a device.
  app.post("/api/v1/evv/devices/:id/suspend", { preHandler: [DEVICE_SUSPEND] }, async (request) => {
    const { organizationId, userId } = actorOf(request);
    const { id } = parse(IdParams, request.params);
    const b = parse(SuspendDeviceRequest, request.body);
    return service.suspendDevice(organizationId, userId, id, b.reason);
  });

  // 13 — retire a device.
  app.post("/api/v1/evv/devices/:id/retire", { preHandler: [DEVICE_RETIRE] }, async (request) => {
    const { organizationId, userId } = actorOf(request);
    const { id } = parse(IdParams, request.params);
    const b = parse(RetireDeviceRequest, request.body);
    return service.retireDevice(organizationId, userId, id, b.reason);
  });

  // 14 — read geofence policy (tenant + per-address overrides).
  app.get(
    "/api/v1/evv/geofence-policy",
    {
      preHandler: [POLICY_READ],
      config: { auditRead: { resourceKind: "evv_geofence_policy", list: true } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      return service.getGeofencePolicy(organizationId);
    },
  );

  // 15 — edit tenant tighten-only policy.
  app.patch(
    "/api/v1/evv/geofence-policy/tenant",
    { preHandler: [POLICY_EDIT] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const b = parse(EditTenantPolicyRequest, request.body);
      return service.editTenantPolicy(organizationId, userId, {
        radiusM: b.radiusM,
        maxAccuracyM: b.maxAccuracyM,
      });
    },
  );

  // 16 — create / replace a per-address override (reason ≥30 chars).
  app.post(
    "/api/v1/evv/geofence-policy/per-address",
    { preHandler: [POLICY_EDIT] },
    async (request, reply) => {
      const { organizationId, userId } = actorOf(request);
      const b = parse(CreatePerAddressOverrideRequest, request.body);
      return reply.code(201).send(
        await service.createPerAddressOverride(organizationId, userId, {
          patientAddressId: b.patientAddressId,
          radiusM: b.radiusM,
          maxAccuracyM: b.maxAccuracyM,
          overrideReason: b.overrideReason,
        }),
      );
    },
  );

  // 17 — open + recently-closed resolution queue.
  app.get(
    "/api/v1/evv/missing-resolutions",
    {
      preHandler: [MR_READ],
      config: { auditRead: { resourceKind: "evv_missing_resolution", list: true } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const q = parse(MissingResolutionListQuery, request.query);
      return service.listMissingResolutions(organizationId, { status: q.status, visit: q.visit });
    },
  );

  // 18 — assigned clinician self-attests (reason ≥40 chars; D6 ≤24h window).
  app.post(
    "/api/v1/evv/missing-resolutions/:id/clinician-attest",
    { preHandler: [MR_ATTEST] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(IdParams, request.params);
      const b = parse(ClinicianAttestResolutionRequest, request.body);
      return service.clinicianAttestResolution(organizationId, userId, id, b.reason);
    },
  );

  // 19 — supervisor override (step-up; reason ≥60 chars; D6 ≤7d window).
  app.post(
    "/api/v1/evv/missing-resolutions/:id/supervisor-override",
    { preHandler: [MR_OVERRIDE] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(IdParams, request.params);
      const b = parse(SupervisorOverrideResolutionRequest, request.body);
      return service.supervisorOverrideResolution(
        organizationId,
        userId,
        id,
        b.reason,
        await requestStepUpFresh(request, OVERRIDE_STEP_UP_OPERATION),
      );
    },
  );

  // 20 — per-state aggregator submission queue + status.
  app.get(
    "/api/v1/evv/aggregator-submissions",
    {
      preHandler: [AGG_READ],
      config: { auditRead: { resourceKind: "evv_aggregator_submission", list: true } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const q = parse(AggregatorListQuery, request.query);
      return service.listAggregatorSubmissions(organizationId, {
        stateCode: q.stateCode,
        status: q.status,
      });
    },
  );

  // 21 — operator-initiated resubmit (§7.9; valid from rejected/timeout).
  app.post(
    "/api/v1/evv/aggregator-submissions/:id/resubmit",
    { preHandler: [AGG_RESUBMIT] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(IdParams, request.params);
      const b = parse(ResubmitSubmissionRequest, request.body);
      return service.resubmitSubmission(organizationId, userId, id, b.reason);
    },
  );

  // 22 — operator-initiated cancel (valid from a non-terminal status).
  app.post(
    "/api/v1/evv/aggregator-submissions/:id/cancel",
    { preHandler: [AGG_CANCEL] },
    async (request) => {
      const { organizationId, userId } = actorOf(request);
      const { id } = parse(IdParams, request.params);
      const b = parse(CancelSubmissionRequest, request.body);
      return service.cancelSubmission(organizationId, userId, id, b.reason);
    },
  );

  // 23 — EVV metrics (M30/M33 dashboard source).
  app.get(
    "/api/v1/evv/metrics",
    {
      preHandler: [READ_METRICS],
      config: {
        auditRead: {
          none: "Pure aggregate compliance-rate percentages (org-wide rates only) — zero per-visit or per-patient breakdown.",
        },
      },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      parse(MetricsQuery, request.query);
      return service.metrics(organizationId);
    },
  );

  // 24 — clinician current last-known location (M20 supervisor live-awareness; D10 coordinate-bearing).
  app.get(
    "/api/v1/evv/clinician-current-location",
    {
      preHandler: [LOCATION_READ],
      config: { auditRead: { resourceKind: "evv_clinician_location", list: true } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const q = parse(MembershipIdQuery, request.query);
      return service.clinicianCurrentLocation(organizationId, q.membership);
    },
  );

  // 25 — portal arrival surface (timestamp only, no coordinates; portal session class).
  app.get(
    "/api/v1/portal/visits/:visitId/arrival",
    {
      preHandler: [PORTAL_ARRIVAL, PORTAL_GRANT],
      config: { auditRead: { resourceKind: "evv_visit_arrival", resourceIdParam: "visitId" } },
    },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { visitId } = parse(VisitIdParams, request.params);
      // GAP-132 — only the patient the portal session is pinned to may read a visit's arrival; the service
      // scopes the events to that patient, so another patient's visit reads as "not yet arrived".
      const pinned = request.context?.attributes.sessionPatientId;
      if (typeof pinned !== "string" || pinned.length === 0) throw new NotFoundError("visit");
      return service.portalArrival(organizationId, visitId, pinned);
    },
  );
}
