// apps/backend/src/modules/31-portal/routes/telehealth.routes.ts — M31 (§4.1) the telehealth surface: the
// portal-side patient/caregiver join+leave, the staff-side clinician join/leave/record/end, and the two
// signature-verified vendor webhooks.
//
// `telehealth_visit` IS an M31-owned table, so these routes drive the real lifecycle over the Drizzle store
// (`../write-paths` / `../telehealth` cores decide the transitions; the store persists them). The video
// vendor is M31's own adapter (`@wardenx/telehealth-client`, injected via `deps.telehealth`) — the vendor
// never sees a real identity (per-participant short-TTL tokens), and the room url/token are cipher-only in
// the row (never projected). The Record button is D9-gated by `state_two_party_recording_consent_present`
// (+ step-up), composed in `./mount`; the webhooks verify the vendor HMAC before touching the row.
import { ForbiddenError, NotFoundError, ChartWardenError } from "@wardenx/types";
import type { FastifyInstance } from "fastify";
import { ensureTelehealthRoomForVisit } from "../telehealth/room-mint";
import {
  deriveEndReason,
  endStateFor,
  foldParticipantJoin,
  isTelehealthEnded,
} from "../telehealth/visit-lifecycle";
import { type M31Actor, actorOf } from "./actor";
import { requireIdempotencyKey } from "./concurrency";
import {
  ABAC_GRANT,
  ABAC_IN_ORG,
  ABAC_RECORDING_STATE,
  ABAC_TELEHEALTH_CONSENT,
  P,
  STEP_UP,
} from "./guards";
import type { PortalRouteDeps, TelehealthAdapterPort } from "./index";
import { StartRecordingRequest, parse } from "./portal-typebox";
import { assertStaffMayAccessVisit, staffVisitScopeGuard } from "./staff-visit-scope";

const IDEMPOTENT = requireIdempotencyKey();

/** A fail-closed adapter used when no vendor adapter is injected — mints nothing, denies recording. */
const NOOP_ADAPTER: TelehealthAdapterPort = {
  vendor: "native_webrtc",
  async mintParticipantToken() {
    return { token: "", expiresAt: new Date(0).toISOString() };
  },
  async endRoom() {},
  async startRecording() {
    return { vendorRecordingId: "" };
  },
  async stopRecording() {
    return { recordingUrl: "", durationSec: 0 };
  },
  verifyWebhookSignature() {
    return false;
  },
};

/**
 * GAP-094 — a portal join/leave is authorized against the SESSION's granted patient, never the visit id on
 * the wire: the visit's own patient must equal `actor.portalPatientId`, else 404 (the portal never discloses
 * another patient's visit). Used by the route guard AND the handlers (defence in depth).
 */
function assertVisitIsSessionPatients(
  actor: M31Actor,
  visit: { readonly patientId: string } | null,
): void {
  if (!visit || actor.portalPatientId === null || visit.patientId !== actor.portalPatientId) {
    throw new NotFoundError("telehealth visit not found");
  }
}

export function registerTelehealthRoutes(app: FastifyInstance, deps: PortalRouteDeps): void {
  const { store } = deps;
  const adapter = deps.telehealth ?? NOOP_ADAPTER;
  const now = deps.now ?? (() => new Date());
  const scopeDeps = { store, visitReader: deps.visitReader };
  /** Staff route guard — the visit's stored patient must be the actor's (org-wide / assigned / caseload). */
  const staffScope = staffVisitScopeGuard(scopeDeps);
  /** The join is the one staff route whose id may be an M17 visit id (lazy mint), decided before any mint. */
  const staffJoinScope = staffVisitScopeGuard(scopeDeps, { allowM17Fallback: true });
  /** Handler backstop — the same rule, re-asserted before lifecycle or a token is touched. */
  const reassertStaff = (
    request: import("fastify").FastifyRequest,
    opts?: { readonly allowM17Fallback?: boolean },
  ) => {
    const { visitId } = request.params as { visitId: string };
    return assertStaffMayAccessVisit(scopeDeps, actorOf(request), visitId, opts);
  };

  /** GAP-095 — every vendor-facing call that cannot be made refuses 503; nothing is fabricated or half-written. */
  const vendorUnavailable = (what: string): ChartWardenError =>
    new ChartWardenError(
      "TELEHEALTH_VENDOR_UNAVAILABLE",
      `the telehealth vendor is unavailable: ${what}`,
      503,
    );

  /** GAP-095 — open a sealed room column (the real vendor room id / url); 503 when it cannot be opened. */
  const openRoomValue = async (
    organizationId: string,
    telehealthVisitId: string,
    column: "vendor_room_id" | "vendor_room_url",
  ): Promise<string> => {
    if (!deps.roomCipher) throw vendorUnavailable("no room cipher is bound");
    const facts = await store.telehealthRoomFacts(organizationId, telehealthVisitId);
    if (!facts) throw new NotFoundError("telehealth visit not found");
    try {
      return await deps.roomCipher.decrypt(
        organizationId,
        column,
        column === "vendor_room_id" ? facts.vendorRoomIdCipher : facts.vendorRoomUrlCipher,
      );
    } catch {
      throw vendorUnavailable("the stored room cannot be opened");
    }
  };

  /**
   * GAP-093 — only the clinician who STARTED a recording may stop it (§4.6 `telehealth.record_stop`:
   * "whoever started"). Nothing recording ⇒ idempotent no-op for any in-scope clinician. When the starter
   * is not recorded (no column yet) the fallback is the visit's ASSIGNED clinician; the org-wide
   * compliance halt (`halt-recording`, step-up) remains the override. Any read failure denies.
   */
  const assertMayStopRecording = async (
    actor: M31Actor,
    visitId: string,
    assignedMembershipId: string | null,
  ): Promise<void> => {
    const state = await store.telehealthRecordingState(actor.organizationId, visitId);
    if (!state) throw new NotFoundError("telehealth visit not found");
    if (!state.enabled) return;
    const allowed =
      state.startedByUserId !== null
        ? state.startedByUserId === actor.userId
        : actor.membershipId !== null && actor.membershipId === assignedMembershipId;
    if (!allowed) {
      throw new ForbiddenError("only the clinician who started the recording may stop it");
    }
  };

  /** Route-layer ownership guard for the portal-side routes (runs before the consent predicate). */
  const portalVisitOwnership = async (request: import("fastify").FastifyRequest) => {
    const actor = actorOf(request);
    const { visitId } = request.params as { visitId: string };
    assertVisitIsSessionPatients(actor, await store.telehealthById(actor.organizationId, visitId));
  };

  const joinHandler =
    (who: "patient" | "clinician") => async (request: import("fastify").FastifyRequest) => {
      const actor = actorOf(request);
      const { visitId } = request.params as { visitId: string };
      if (who === "clinician") await reassertStaff(request, { allowM17Fallback: true });
      let visit = await store.telehealthById(actor.organizationId, visitId);
      // F-220 (#248) — LAZY room mint. The staff join is the one path that can reach this point for an id that
      // is not yet a `telehealth_visit` id (the patient join is ABAC-gated on an existing row): treat the param
      // as an M17 visit id, pull the visit through M17's published reader and mint the room on this first join.
      if (!visit && who === "clinician" && deps.visitReader && deps.roomCipher) {
        visit = await ensureTelehealthRoomForVisit(
          {
            visits: deps.visitReader,
            cipher: deps.roomCipher,
            adapter,
            store,
          },
          actor.organizationId,
          actor.userId,
          visitId,
        );
      }
      if (!visit) throw new NotFoundError("telehealth visit not found");
      if (who === "patient") assertVisitIsSessionPatients(actor, visit);
      const telehealthVisitId = visit.telehealthVisitId;
      const nextState = foldParticipantJoin(visit.lifecycleState, who);
      // GAP-095 — mint the credential and open the room BEFORE writing the lifecycle: a vendor/cipher failure
      // must leave the visit untouched (it used to write `in_progress` first, then hand back a fake url).
      let token: Awaited<ReturnType<TelehealthAdapterPort["mintParticipantToken"]>>;
      try {
        token = await adapter.mintParticipantToken({ telehealthVisitId, role: who });
      } catch {
        throw vendorUnavailable("a participant token could not be minted");
      }
      if (!token.token) throw vendorUnavailable("no vendor adapter is bound");
      const vendorJoinUrl = await openRoomValue(
        actor.organizationId,
        telehealthVisitId,
        "vendor_room_url",
      );
      const leftPatch = who === "patient" ? { patientLeftAt: null } : { clinicianLeftAt: null };
      if (nextState !== visit.lifecycleState) {
        const startsNow = visit.visitStartedAt === null && nextState === "in_progress";
        await store.updateTelehealthLifecycle(
          actor.organizationId,
          actor.userId,
          telehealthVisitId,
          {
            lifecycleState: nextState,
            firstParticipantJoinedAt: visit.visitStartedAt === null ? now() : undefined,
            ...(startsNow ? { visitStartedAt: now() } : {}),
            ...leftPatch,
          },
        );
      } else {
        // A re-join of an already-present party still clears that party's `left` mark.
        await store.updateTelehealthLifecycle(
          actor.organizationId,
          actor.userId,
          telehealthVisitId,
          leftPatch,
        );
      }
      return {
        vendor: adapter.vendor,
        vendorJoinUrl,
        vendorParticipantToken: token.token,
        tokenExpiresAt: token.expiresAt,
        audioOnlyFallbackActive: visit.audioOnlyFallbackActive,
        recordingActive: false,
      };
    };

  const leaveHandler =
    (who: "patient" | "clinician") => async (request: import("fastify").FastifyRequest) => {
      const actor = actorOf(request);
      const { visitId } = request.params as { visitId: string };
      if (who === "clinician") await reassertStaff(request);
      const visit = await store.telehealthById(actor.organizationId, visitId);
      if (!visit) throw new NotFoundError("telehealth visit not found");
      if (who === "patient") assertVisitIsSessionPatients(actor, visit);
      // GAP-095 — persist the departure (leave used to store nothing, so `end` could not tell who dropped).
      // An ended visit has nobody left to mark; the call stays an idempotent no-op.
      if (!isTelehealthEnded(visit.lifecycleState)) {
        await store.updateTelehealthLifecycle(
          actor.organizationId,
          actor.userId,
          visit.telehealthVisitId,
          who === "patient" ? { patientLeftAt: now() } : { clinicianLeftAt: now() },
        );
      }
      return { ok: true };
    };

  // portal-side join / leave (patient or caregiver).
  app.post(
    "/api/v1/portal/telehealth/visits/:visitId/join",
    {
      preHandler: [
        P("telehealth.join_patient_or_caregiver"),
        ABAC_GRANT("telehealth.join_patient_or_caregiver"),
        portalVisitOwnership,
        ABAC_TELEHEALTH_CONSENT("telehealth.join_patient_or_caregiver"),
        IDEMPOTENT,
      ],
    },
    joinHandler("patient"),
  );
  app.post(
    "/api/v1/portal/telehealth/visits/:visitId/leave",
    {
      preHandler: [
        P("telehealth.join_patient_or_caregiver"),
        ABAC_GRANT("telehealth.join_patient_or_caregiver"),
        portalVisitOwnership,
        ABAC_TELEHEALTH_CONSENT("telehealth.join_patient_or_caregiver"),
        IDEMPOTENT,
      ],
    },
    leaveHandler("patient"),
  );

  // staff-side join / leave (clinician).
  app.post(
    "/api/v1/telehealth/visits/:visitId/join",
    {
      preHandler: [
        P("telehealth.join_clinician"),
        ABAC_IN_ORG("telehealth.join_clinician"),
        staffJoinScope,
        IDEMPOTENT,
      ],
    },
    joinHandler("clinician"),
  );
  app.post(
    "/api/v1/telehealth/visits/:visitId/leave",
    {
      preHandler: [
        P("telehealth.join_clinician"),
        ABAC_IN_ORG("telehealth.join_clinician"),
        staffScope,
        IDEMPOTENT,
      ],
    },
    leaveHandler("clinician"),
  );

  // start recording — D9-gated + step-up (composed in ./mount).
  app.post(
    "/api/v1/telehealth/visits/:visitId/start-recording",
    {
      preHandler: [
        P("telehealth.record_start"),
        staffScope,
        STEP_UP("telehealth.record_start"),
        ABAC_RECORDING_STATE("telehealth.record_start"),
        IDEMPOTENT,
      ],
    },
    async (request) => {
      const actor = actorOf(request);
      const { visitId } = request.params as { visitId: string };
      await reassertStaff(request);
      parse(StartRecordingRequest, request.body);
      const visit = await store.telehealthById(actor.organizationId, visitId);
      if (!visit) throw new NotFoundError("telehealth visit not found");
      // GAP-095 — address the VENDOR room (not our visit id) and keep the vendor's recording id.
      const vendorRoomId = await openRoomValue(actor.organizationId, visitId, "vendor_room_id");
      let started: { vendorRecordingId: string };
      try {
        started = await adapter.startRecording(vendorRoomId);
      } catch {
        throw vendorUnavailable("the recording could not be started");
      }
      if (!started.vendorRecordingId)
        throw vendorUnavailable("the vendor returned no recording id");
      await store.updateTelehealthLifecycle(actor.organizationId, actor.userId, visitId, {
        recordingEnabled: true,
        recordingRequested: true,
        vendorRecordingId: started.vendorRecordingId,
        // GAP-093 — the starter is the SESSION user, never a body field.
        recordingStartedByUserId: actor.userId,
      });
      return { ok: true };
    },
  );

  // stop recording — idempotent.
  app.post(
    "/api/v1/telehealth/visits/:visitId/stop-recording",
    {
      preHandler: [
        P("telehealth.record_stop"),
        ABAC_IN_ORG("telehealth.record_stop"),
        staffScope,
        IDEMPOTENT,
      ],
    },
    async (request) => {
      const actor = actorOf(request);
      const { visitId } = request.params as { visitId: string };
      const facts = await reassertStaff(request);
      await assertMayStopRecording(actor, visitId, facts.assignedMembershipId);
      // GAP-095 — stop the recording at the vendor too (before clearing local state, so a vendor failure keeps
      // the row truthful). A recording started before 0420 has no stored vendor id and is only cleared locally.
      const room = await store.telehealthRoomFacts(actor.organizationId, visitId);
      if (room?.vendorRecordingId) {
        const vendorRoomId = await openRoomValue(actor.organizationId, visitId, "vendor_room_id");
        try {
          await adapter.stopRecording(vendorRoomId, room.vendorRecordingId);
        } catch {
          throw vendorUnavailable("the recording could not be stopped");
        }
      }
      // `recording_requested` must drop with `recording_enabled` (CHECK telehealth_visit_recording_requires_enabled);
      // `recordingStartedByUserId` is kept as the record of who ran the last recording.
      await store.updateTelehealthLifecycle(actor.organizationId, actor.userId, visitId, {
        recordingEnabled: false,
        recordingRequested: false,
        vendorRecordingId: null,
      });
      return { ok: true };
    },
  );

  // end visit — server-forced close.
  app.post(
    "/api/v1/telehealth/visits/:visitId/end",
    {
      preHandler: [
        P("telehealth.end_visit"),
        ABAC_IN_ORG("telehealth.end_visit"),
        staffScope,
        IDEMPOTENT,
      ],
    },
    async (request) => {
      const actor = actorOf(request);
      const { visitId } = request.params as { visitId: string };
      await reassertStaff(request);
      const visit = await store.telehealthById(actor.organizationId, visitId);
      if (!visit) throw new NotFoundError("telehealth visit not found");
      const room = await store.telehealthRoomFacts(actor.organizationId, visitId);
      if (!room) throw new NotFoundError("telehealth visit not found");
      // GAP-095 — close the VENDOR room (end used to flip our row only, leaving a live room). Done after the
      // local close so a vendor failure is reported (503) without losing the close; a retry is idempotent.
      if (!isTelehealthEnded(visit.lifecycleState)) {
        const clean = visit.lifecycleState === "in_progress";
        // Presence at end: a party is present if it joined (the state machine records that) and has not left.
        const patientJoined =
          visit.lifecycleState === "patient_joined" || visit.lifecycleState === "in_progress";
        const clinicianJoined =
          visit.lifecycleState === "clinician_joined" || visit.lifecycleState === "in_progress";
        const endReason = deriveEndReason({
          clean,
          patientPresentAtEnd: patientJoined && room.patientLeftAt === null,
          clinicianPresentAtEnd: clinicianJoined && room.clinicianLeftAt === null,
        });
        const startedMs = visit.visitStartedAt ? Date.parse(visit.visitStartedAt) : now().getTime();
        await store.updateTelehealthLifecycle(actor.organizationId, actor.userId, visitId, {
          lifecycleState: endStateFor(clean),
          visitEndedAt: now(),
          endReason,
          totalDurationSec: Math.max(0, Math.round((now().getTime() - startedMs) / 1000)),
        });
      }
      const vendorRoomId = await openRoomValue(actor.organizationId, visitId, "vendor_room_id");
      try {
        await adapter.endRoom(vendorRoomId);
      } catch {
        throw vendorUnavailable("the vendor room could not be closed; retry to finish closing it");
      }
      return { ok: true };
    },
  );

  // vendor webhooks — signature-verified ingest (no auth; HMAC only). A bad signature is a 401 (API-008)
  // — mirroring M35's Stripe webhook route (registerWebhookRoutes) — never a 200, so an upstream
  // misconfiguration (wrong shared secret, a stale vendor key) is visible in the vendor's own delivery
  // logs instead of being silently swallowed as an accepted, dropped event.
  const webhook = async (
    request: import("fastify").FastifyRequest,
    reply: import("fastify").FastifyReply,
  ) => {
    const headers = Object.fromEntries(
      Object.entries(request.headers).map(([k, v]) => [
        k,
        Array.isArray(v) ? (v[0] ?? "") : String(v ?? ""),
      ]),
    );
    const raw =
      typeof request.body === "string" ? request.body : JSON.stringify(request.body ?? {});
    const ok = adapter.verifyWebhookSignature(headers, raw);
    if (!ok) return reply.code(401).send({ received: false });
    return reply.code(200).send({ received: true });
  };
  // GAP-051: the vendor signs the EXACT bytes it sent, so the signature can only verify against the raw body. The
  // default JSON parser hands the handler a parsed object whose re-serialisation need not match those bytes, so the
  // webhooks live in an encapsulated scope whose JSON parser keeps the body as the raw string.
  // The encapsulated instance is deliberately named `app`: scripts/openapi/scan-routes.ts discovers routes by
  // the `app.<method>("<path>")` call shape, so a differently-named scope would hide them from the contract.
  void app.register(async (app) => {
    app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) =>
      done(null, body),
    );
    app.post("/api/v1/telehealth/webhooks/daily-co", webhook);
    app.post("/api/v1/telehealth/webhooks/twilio-video", webhook);
  });
}
