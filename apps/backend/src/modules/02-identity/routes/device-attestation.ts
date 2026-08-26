// apps/backend/src/modules/02-identity/routes/device-attestation.ts — M2, SecHardening §12.2/§12.4;
// the write path for the surface ADR-0023 D2 adjudicated onto M2.
//
//   POST /api/v1/devices/attestation/challenge   mint a single-use nonce bound to this session
//   POST /api/v1/devices/attestation             submit the assertion; verify; record; bind the session
//   POST /api/v1/devices/attestation/:id/revoke  take a lost/compromised device out of service
//   GET  /api/v1/devices/attestation             the caller's own devices (admin list is by membership)
//
// THE CHALLENGE IS THE CONTROL. Everything the device says about itself arrives inside a MAC over a
// nonce this server minted seconds earlier and spends on read, so an assertion cannot be forged without
// the enrolment secret, cannot be replayed, and cannot be edited in flight. The route never reads a
// device fact from a header, a query or an unauthenticated body — see `device-attestation-verifier.ts`
// for why that is the whole assurance argument.
//
// YOU CAN ONLY EVER ATTEST YOUR OWN DEVICE. Both the org and the membership come off the resolved
// session, never the body. That is why attesting needs no permission key: the narrowest possible scope
// is already structural, and requiring `device_attestation.write` would force orgs to hand every field
// clinician a security-management grant just to sign in from their phone. REVOKING acts on someone
// else's device and is permission-gated.
//
// A FAILED CHECK IS RECORDED, NOT DISCARDED. SecHardening §12.4 names the server-side audit as the
// complement to on-device detection ("unusual access patterns from clinical mobile may flag"), and a
// device that repeatedly fails the posture check is precisely that signal. The row is written before
// the 401 is sent.
import type { AuditContext, AuditExecutor } from "@wardenx/audit";
import { requirePermission, requireSession } from "@wardenx/auth";
import { UnauthorizedError, ValidationError } from "@wardenx/types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  auditDeviceAttestationFailed,
  auditDeviceAttestationRevoked,
  auditDeviceAttested,
} from "../audit/device-attestation-audit";
import type {
  DeviceAttestationAssertion,
  DeviceAttestationChallengeStore,
  DeviceAttestationPlatform,
  DeviceAttestationProvider,
  DeviceAttestationSession,
  DeviceAttestationStore,
  DeviceAttestationVerifier,
} from "../device-attestation-ports";

/** How long a minted challenge stays usable. Short: the device MACs it immediately. */
const CHALLENGE_TTL_SEC = 120;
/** How long a passing attestation stands before the device must prove itself again (§12.2 posture is
 *  a point-in-time observation, so the window is days, not the session's lifetime). */
const ATTESTATION_TTL_HOURS = 24 * 30;

const PLATFORMS: readonly DeviceAttestationPlatform[] = ["ios", "android"];
const PROVIDERS: readonly DeviceAttestationProvider[] = [
  "managed_enrollment",
  "apple_app_attest",
  "google_play_integrity",
];

export interface DeviceAttestationRouteDeps {
  readonly challenges: DeviceAttestationChallengeStore;
  readonly verifier: DeviceAttestationVerifier;
  readonly store: DeviceAttestationStore;
  readonly audit: AuditExecutor;
  /** Injectable for tests; production mints a uuid. */
  readonly newChallengeId?: () => string;
  readonly newNonce?: () => string;
  readonly now?: () => Date;
}

function auditContextFor(request: FastifyRequest, session: DeviceAttestationSession): AuditContext {
  return {
    organizationId: session.organizationId,
    userId: session.userId,
    actorKind: "user",
    correlationId: request.context.correlationId,
    requestId: String(request.id),
    sourceIp: request.context.ip,
    userAgent: request.context.userAgent,
  };
}

/**
 * Resolve the session off `request.context` — the bag the authenticate hook fills from the REAL session
 * row — or fail closed.
 *
 * Every field is server-assembled. `sessionId` and `membershipId` ride on `context.attributes` (both
 * declared producers in the F-030 registry, both written by the hook); the org and user are on the
 * context proper. Nothing here is reachable from the request body, which is the whole reason the routes
 * can bind an attestation to a person without a permission key: you cannot name someone else.
 *
 * A session with no membership yet — authenticated but pre-org — is not an error, it is the wrong
 * moment: there is no org whose device fleet this handset would join. The caller gets a 409.
 */
async function resolveSessionOrThrow(request: FastifyRequest): Promise<DeviceAttestationSession> {
  await requireSession()(request);
  const ctx = request.context;
  const sessionId = ctx?.attributes?.sessionId;
  const membershipId = ctx?.attributes?.membershipId;
  if (!ctx?.userId || typeof sessionId !== "string" || sessionId.length === 0) {
    throw new UnauthorizedError();
  }
  return {
    sessionId,
    userId: ctx.userId,
    organizationId: ctx.organizationId ?? "",
    membershipId: typeof membershipId === "string" ? membershipId : "",
  };
}

/** Read + validate the assertion body. Rejects rather than coerces: an ill-typed device claim is not a
 *  device claim, and silently defaulting one field of a MAC'd payload would break the MAC anyway. */
function readAssertion(body: unknown): {
  challengeId: string;
  assertion: DeviceAttestationAssertion;
} {
  const b = (body ?? {}) as Record<string, unknown>;
  const issues: { field: string; code: string; message: string }[] = [];
  const str = (field: string): string => {
    const v = b[field];
    if (typeof v !== "string" || v.length === 0) {
      issues.push({ field, code: "REQUIRED", message: `${field} is required` });
      return "";
    }
    return v;
  };
  const challengeId = str("challengeId");
  const deviceKeyFingerprint = str("deviceKeyFingerprint");
  const assertionValue = str("assertion");
  const platform = b.platform;
  if (!PLATFORMS.includes(platform as DeviceAttestationPlatform)) {
    issues.push({
      field: "platform",
      code: "INVALID",
      message: `platform must be one of ${PLATFORMS.join(", ")}`,
    });
  }
  const provider = b.provider;
  if (!PROVIDERS.includes(provider as DeviceAttestationProvider)) {
    issues.push({
      field: "provider",
      code: "INVALID",
      message: `provider must be one of ${PROVIDERS.join(", ")}`,
    });
  }
  const posture = b.posture;
  if (typeof posture !== "object" || posture === null || Array.isArray(posture)) {
    issues.push({ field: "posture", code: "REQUIRED", message: "posture object is required" });
  }
  if (issues.length > 0) throw new ValidationError("invalid device attestation", issues);
  return {
    challengeId,
    assertion: {
      deviceKeyFingerprint,
      platform: platform as DeviceAttestationPlatform,
      provider: provider as DeviceAttestationProvider,
      posture: posture as DeviceAttestationAssertion["posture"],
      assertion: assertionValue,
    },
  };
}

export function registerDeviceAttestationRoutes(
  app: FastifyInstance,
  deps: DeviceAttestationRouteDeps,
): void {
  const newChallengeId = deps.newChallengeId ?? (() => crypto.randomUUID());
  const newNonce = deps.newNonce ?? (() => crypto.randomUUID().replace(/-/g, ""));
  const now = deps.now ?? (() => new Date());

  // --- Mint a challenge -----------------------------------------------------------------------
  app.post("/api/v1/devices/attestation/challenge", async (request, reply) => {
    const session = await resolveSessionOrThrow(request);
    // A session with no membership has no device to enrol against: the attestation is per-membership,
    // and a pre-org session has not chosen which org's fleet it belongs to yet.
    if (!session.membershipId || !session.organizationId) {
      return reply.code(409).send({ error: "organization_not_selected" });
    }
    const challengeId = newChallengeId();
    const nonce = newNonce();
    await deps.challenges.put(
      challengeId,
      {
        sessionId: session.sessionId,
        membershipId: session.membershipId,
        organizationId: session.organizationId,
        nonce,
        createdAt: now().toISOString(),
      },
      CHALLENGE_TTL_SEC,
    );
    return reply.code(200).send({ challengeId, nonce, expiresInSec: CHALLENGE_TTL_SEC });
  });

  // --- Submit an assertion --------------------------------------------------------------------
  app.post("/api/v1/devices/attestation", async (request, reply) => {
    const session = await resolveSessionOrThrow(request);
    const { challengeId, assertion } = readAssertion(request.body);

    // Single-use: `take` spends the challenge, so a captured assertion cannot be replayed.
    const challenge = await deps.challenges.take(challengeId);
    if (!challenge) return reply.code(400).send({ error: "challenge_expired_or_invalid" });
    // The challenge belongs to THIS session. Without this a caller could mint a challenge on their own
    // session and spend it on another, which is the whole point of binding it at mint time.
    if (challenge.sessionId !== session.sessionId) {
      return reply.code(400).send({ error: "challenge_session_mismatch" });
    }

    const verdict = await deps.verifier.verify({ challenge, assertion });
    const at = now();
    const expiresAt = new Date(at.getTime() + ATTESTATION_TTL_HOURS * 3600 * 1000);

    if (!verdict.ok) {
      // `unavailable` is not a failure: nothing was proved and nothing was disproved, so no `failed`
      // row is written. Recording one would put "this device is compromised" in the trail for a
      // deployment that simply has not installed the provider.
      if ("unavailable" in verdict) {
        return reply
          .code(501)
          .send({ error: "attestation_provider_unavailable", reason: verdict.reason });
      }
      const failedRow = await deps.store.recordFailed({
        organizationId: challenge.organizationId,
        membershipId: challenge.membershipId,
        deviceKeyFingerprint: assertion.deviceKeyFingerprint,
        platform: assertion.platform,
        provider: assertion.provider,
        posture: assertion.posture,
        failureReason: verdict.reason,
        verifiedAt: at,
        expiresAt,
      });
      await auditDeviceAttestationFailed(deps.audit, auditContextFor(request, session), {
        attestationId: failedRow.id,
        provider: assertion.provider,
        platform: assertion.platform,
        reason: verdict.reason,
      });
      return reply.code(401).send({ error: "attestation_failed", reason: verdict.reason });
    }

    const record = await deps.store.recordAttested({
      organizationId: challenge.organizationId,
      membershipId: challenge.membershipId,
      sessionId: session.sessionId,
      deviceKeyFingerprint: assertion.deviceKeyFingerprint,
      platform: assertion.platform,
      provider: assertion.provider,
      posture: assertion.posture,
      verifiedAt: at,
      expiresAt,
    });
    await auditDeviceAttested(deps.audit, auditContextFor(request, session), {
      attestationId: record.id,
      provider: assertion.provider,
      platform: assertion.platform,
      expiresAt: record.expiresAt,
    });
    return reply.code(201).send({
      attestationId: record.id,
      verdict: record.verdict,
      verifiedAt: record.verifiedAt,
      expiresAt: record.expiresAt,
    });
  });

  // --- Revoke ---------------------------------------------------------------------------------
  app.post(
    "/api/v1/devices/attestation/:id/revoke",
    { preHandler: requirePermission("device_attestation.revoke") },
    async (request, reply) => {
      const session = await resolveSessionOrThrow(request);
      if (!session.membershipId || !session.organizationId) {
        return reply.code(409).send({ error: "organization_not_selected" });
      }
      const reason = (request.body as { reason?: unknown } | null)?.reason;
      // The 10-character floor mirrors the DB CHECK. Enforced here too so the caller gets a 422 naming
      // the field rather than a 500 from a constraint they cannot see.
      if (typeof reason !== "string" || reason.trim().length < 10) {
        throw new ValidationError("invalid device attestation revocation", [
          {
            field: "reason",
            code: "REQUIRED",
            message: "reason is required and must be at least 10 characters",
          },
        ]);
      }
      const id = (request.params as { id: string }).id;
      const record = await deps.store.revoke({
        organizationId: session.organizationId,
        attestationId: id,
        revokedByMembershipId: session.membershipId,
        reason: reason.trim(),
      });
      // Absent, cross-tenant and already-revoked all answer 404: the caller learns nothing about which.
      if (!record) return reply.code(404).send({ error: "attestation_not_found" });
      await auditDeviceAttestationRevoked(deps.audit, auditContextFor(request, session), {
        attestationId: record.id,
        membershipId: record.membershipId,
      });
      return reply.code(200).send({ attestationId: record.id, verdict: record.verdict });
    },
  );

  // --- List (own devices) ---------------------------------------------------------------------
  app.get(
    "/api/v1/devices/attestation",
    {
      preHandler: requirePermission("device_attestation.read"),
      config: {
        auditRead: { none: "device registrations for the caller's own membership; no PHI" },
      },
    },
    async (request, reply) => {
      const session = await resolveSessionOrThrow(request);
      if (!session.membershipId || !session.organizationId) {
        return reply.code(409).send({ error: "organization_not_selected" });
      }
      const items = await deps.store.listForMembership({
        organizationId: session.organizationId,
        membershipId: session.membershipId,
      });
      return reply.code(200).send({ items });
    },
  );
}
