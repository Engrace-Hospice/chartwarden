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
import { NotFoundError } from "@wardenx/types";
import type { FastifyInstance } from "fastify";
import { deriveEndReason, endStateFor, foldParticipantJoin } from "../telehealth/visit-lifecycle";
import { actorOf } from "./actor";
import { requireIdempotencyKey } from "./concurrency";
import { ABAC_IN_ORG, ABAC_RECORDING_STATE, ABAC_TELEHEALTH_CONSENT, P, STEP_UP } from "./guards";
import type { PortalRouteDeps, TelehealthAdapterPort } from "./index";
import { StartRecordingRequest, parse } from "./portal-typebox";

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

export function registerTelehealthRoutes(app: FastifyInstance, deps: PortalRouteDeps): void {
  const { store } = deps;
  const adapter = deps.telehealth ?? NOOP_ADAPTER;
  const now = deps.now ?? (() => new Date());

  const joinHandler =
    (who: "patient" | "clinician") => async (request: import("fastify").FastifyRequest) => {
      const actor = actorOf(request);
      const { visitId } = request.params as { visitId: string };
      const visit = await store.telehealthById(actor.organizationId, visitId);
      if (!visit) throw new NotFoundError("telehealth visit not found");
      const nextState = foldParticipantJoin(visit.lifecycleState, who);
      if (nextState !== visit.lifecycleState) {
        const startsNow = visit.visitStartedAt === null && nextState === "in_progress";
        await store.updateTelehealthLifecycle(actor.organizationId, actor.userId, visitId, {
          lifecycleState: nextState,
          firstParticipantJoinedAt: visit.visitStartedAt === null ? now() : undefined,
          ...(startsNow ? { visitStartedAt: now() } : {}),
        });
      }
      const token = await adapter.mintParticipantToken({
        telehealthVisitId: visitId,
        role: who,
      });
      return {
        vendor: adapter.vendor,
        vendorJoinUrl: `https://telehealth.invalid/${visitId}`,
        vendorParticipantToken: token.token,
        tokenExpiresAt: token.expiresAt,
        audioOnlyFallbackActive: visit.audioOnlyFallbackActive,
        recordingActive: false,
      };
    };

  const leaveHandler = async (request: import("fastify").FastifyRequest) => {
    const actor = actorOf(request);
    const { visitId } = request.params as { visitId: string };
    const visit = await store.telehealthById(actor.organizationId, visitId);
    if (!visit) throw new NotFoundError("telehealth visit not found");
    return { ok: true };
  };

  // portal-side join / leave (patient or caregiver).
  app.post(
    "/api/v1/portal/telehealth/visits/:visitId/join",
    {
      preHandler: [
        P("telehealth.join_patient_or_caregiver"),
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
        ABAC_TELEHEALTH_CONSENT("telehealth.join_patient_or_caregiver"),
        IDEMPOTENT,
      ],
    },
    leaveHandler,
  );

  // staff-side join / leave (clinician).
  app.post(
    "/api/v1/telehealth/visits/:visitId/join",
    {
      preHandler: [
        P("telehealth.join_clinician"),
        ABAC_IN_ORG("telehealth.join_clinician"),
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
        IDEMPOTENT,
      ],
    },
    leaveHandler,
  );

  // start recording — D9-gated + step-up (composed in ./mount).
  app.post(
    "/api/v1/telehealth/visits/:visitId/start-recording",
    {
      preHandler: [
        P("telehealth.record_start"),
        STEP_UP("telehealth.record_start"),
        ABAC_RECORDING_STATE("telehealth.record_start"),
        IDEMPOTENT,
      ],
    },
    async (request) => {
      const actor = actorOf(request);
      const { visitId } = request.params as { visitId: string };
      parse(StartRecordingRequest, request.body);
      const visit = await store.telehealthById(actor.organizationId, visitId);
      if (!visit) throw new NotFoundError("telehealth visit not found");
      await adapter.startRecording(visitId);
      await store.updateTelehealthLifecycle(actor.organizationId, actor.userId, visitId, {
        recordingEnabled: true,
        recordingRequested: true,
      });
      return { ok: true };
    },
  );

  // stop recording — idempotent.
  app.post(
    "/api/v1/telehealth/visits/:visitId/stop-recording",
    {
      preHandler: [P("telehealth.record_stop"), ABAC_IN_ORG("telehealth.record_stop"), IDEMPOTENT],
    },
    async (request) => {
      const actor = actorOf(request);
      const { visitId } = request.params as { visitId: string };
      await store.updateTelehealthLifecycle(actor.organizationId, actor.userId, visitId, {
        recordingEnabled: false,
      });
      return { ok: true };
    },
  );

  // end visit — server-forced close.
  app.post(
    "/api/v1/telehealth/visits/:visitId/end",
    { preHandler: [P("telehealth.end_visit"), ABAC_IN_ORG("telehealth.end_visit"), IDEMPOTENT] },
    async (request) => {
      const actor = actorOf(request);
      const { visitId } = request.params as { visitId: string };
      const visit = await store.telehealthById(actor.organizationId, visitId);
      if (!visit) throw new NotFoundError("telehealth visit not found");
      const clean = visit.lifecycleState === "in_progress";
      const endReason = deriveEndReason({
        clean,
        patientPresentAtEnd: false,
        clinicianPresentAtEnd: true,
      });
      const startedMs = visit.visitStartedAt ? Date.parse(visit.visitStartedAt) : now().getTime();
      await store.updateTelehealthLifecycle(actor.organizationId, actor.userId, visitId, {
        lifecycleState: endStateFor(clean),
        visitEndedAt: now(),
        endReason,
        totalDurationSec: Math.max(0, Math.round((now().getTime() - startedMs) / 1000)),
      });
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
  app.post("/api/v1/telehealth/webhooks/daily-co", webhook);
  app.post("/api/v1/telehealth/webhooks/twilio-video", webhook);
}
