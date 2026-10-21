// apps/backend/src/modules/02-identity/routes/link-routes.ts — the per-patient external-collaborator and funeral-home
// MAGIC LINKS (M2 §3.6, §4.1, §7.6; GAP-115 and its redemption follow-up).
//
//   POST /api/v1/collaborators/invite   staff mints a per-patient collaborator link (caseload ABAC)
//   POST /api/v1/funeral/invite         staff mints a per-DECEASED-patient funeral-home link (caseload ABAC, 409 unless deceased)
//   POST /api/v1/collaborators/consume  PUBLIC: the holder redeems the token into a scoped session (cookie)
//   GET  /api/v1/funeral/case           a redeemed funeral-home session reads the ONE decedent's minimum facts
//
// THE TOKEN IS A CREDENTIAL. It is delivered out of band (email) and never appears in a response body, a log line or an
// audit payload. Issuance is fail-closed on delivery: a durable mount REQUIRES `recipientEmail` and a bound delivery
// port, and refuses 503 BEFORE minting anything, so there is never a live link that no one received. If the send itself
// fails after the link was minted, the link is revoked and the call fails - the invite is not "created but lost".
//
// REDEMPTION (the part this file closes). The store claims the use in ONE conditional UPDATE (single-use by default,
// bounded by `max_uses`, expiring on the database clock, org-scoped, hashed at rest); only then do we re-check eligibility
// (a funeral link whose patient is no longer deceased reads nothing), revoke any earlier session of the link's principal
// (one active session per link), and mint the session through Better Auth's server-only mint (ADR-0026: no module mints
// its own tokens). A failure after the claim GIVES THE USE BACK, so a transient fault never burns a one-time link the
// holder never got a session for. Replay, expiry and revocation are refused with the same typed envelope; only the AUDIT
// learns which. Failed redemptions are throttled per IP (§5.3.1 shape).
import {
  CredentialThrottleError,
  requireAbac,
  requirePermission,
  requireSession,
} from "@chartwarden/auth";
import { ValidationError, ChartWardenError } from "@chartwarden/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { auditCollaboratorInvited, auditCollaboratorSessionStarted } from "../audit/identity-audit";
import { auditFuneralInvited } from "../audit/org-admin-audit";
import { auditLinkRedeemed, auditLinkRedemptionRefused } from "../audit/session-link-audit";
import { FUNERAL_LINK_TTL_SEC, type IdentityRouteDeps, LinkError } from "../identity-ports";
import {
  auditContextFor,
  linkErrorToHttp,
  publishM2,
  readString,
  resolveActor,
  unavailable,
} from "./route-helpers";

const DEFAULT_COLLAB_SESSION_TTL_SEC = 8 * 3600; // §7.6 — up to 8h
const MAX_EMAIL_LENGTH = 254;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type LinkKind = "external_collaborator" | "funeral_home";

/** An optional, well-formed recipient address (never echoed into an audit payload or a response). */
function readRecipientEmail(body: unknown): string | null {
  const value = (body as Record<string, unknown> | null)?.recipientEmail;
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "string" ||
    value.length > MAX_EMAIL_LENGTH ||
    !EMAIL_RE.test(value.trim())
  ) {
    throw new ValidationError("invalid recipientEmail", [
      {
        field: "recipientEmail",
        code: "INVALID",
        message: "recipientEmail must be an email address",
      },
    ]);
  }
  return value.trim().toLowerCase();
}

/** The request headers as a web `Headers` (Better Auth reads the client IP / user agent off them). */
function webHeaders(request: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(", ") : String(value));
  }
  return headers;
}

/** Append Set-Cookie values to a reply WITHOUT dropping what an earlier hook (the CSRF cookie) already staged. */
function appendSetCookies(reply: FastifyReply, cookies: readonly string[]): void {
  const existing = reply.getHeader("set-cookie");
  const staged =
    existing === undefined
      ? []
      : Array.isArray(existing)
        ? existing.map(String)
        : [String(existing)];
  reply.header("set-cookie", [...staged, ...cookies]);
}

const patientTarget = (req: { body?: unknown }): Record<string, unknown> => {
  const patientId = (req.body as { patientId?: unknown } | null)?.patientId;
  return typeof patientId === "string" ? { patientId } : {};
};

export function registerLinkRoutes(app: FastifyInstance, deps: IdentityRouteDeps): void {
  const collabSessionTtlSec = deps.collaboratorSessionTtlSec ?? DEFAULT_COLLAB_SESSION_TTL_SEC;

  /**
   * Mint + deliver one link. Shared by the collaborator and funeral invites; the callers have already authorized
   * and (for funeral) proved the patient deceased.
   */
  async function issueLink(
    request: FastifyRequest,
    input: { kind: LinkKind; organizationId: string; membershipId: string; patientId: string },
  ): Promise<{ linkId: string; expiresAt: string }> {
    const recipient = readRecipientEmail(request.body);
    if (deps.linkRecipientRequired && recipient === null) {
      throw new ValidationError("recipientEmail is required", [
        { field: "recipientEmail", code: "REQUIRED", message: "recipientEmail is required" },
      ]);
    }
    // Fail closed BEFORE minting: no delivery channel ⇒ no credential.
    if ((recipient !== null || deps.linkRecipientRequired) && !deps.linkDelivery) {
      throw unavailable(
        "LINK_DELIVERY_UNAVAILABLE",
        "this deployment has no delivery channel for links (the transactional email provider is not bound); no link was issued",
      );
    }
    const link = await deps.collaborators.create({
      organizationId: input.organizationId,
      patientId: input.patientId,
      invitedByMembershipId: input.membershipId,
      kind: input.kind,
      sessionTtlSec: input.kind === "funeral_home" ? FUNERAL_LINK_TTL_SEC : collabSessionTtlSec,
    });
    if (recipient !== null && deps.linkDelivery && link.token) {
      try {
        await deps.linkDelivery.deliver({
          kind: input.kind,
          email: recipient,
          token: link.token,
          expiresAt: new Date(link.expiresAt),
        });
      } catch {
        // The link exists but nobody received it: kill it rather than leave an unreachable live credential.
        await deps.collaborators.revoke?.({
          organizationId: input.organizationId,
          linkId: link.linkId,
        });
        throw unavailable(
          "LINK_DELIVERY_FAILED",
          "the link could not be delivered; it was revoked. Try again",
        );
      }
    }
    return { linkId: link.linkId, expiresAt: link.expiresAt };
  }

  app.post("/api/v1/collaborators/invite", async (request, reply) => {
    // staff-class session; the patient must be on the actor's caseload (§4.7 collaborator.invite,
    // ABAC: caseload_membership). The predicate is M3-owned and resolves through the M5/M17
    // CaseloadProvider seam (deny-by-default until that provider registers at boot).
    await requireSession()(request);
    await requireAbac("collaborator.invite", "caseload_membership", {
      getTarget: patientTarget,
    })(request);
    const actor = await resolveActor(deps, request);
    if (!actor.organizationId || !actor.membershipId) {
      throw new ChartWardenError("FORBIDDEN", "an org-bound staff session is required", 403);
    }
    const patientId = readString(request.body, "patientId");
    const link = await issueLink(request, {
      kind: "external_collaborator",
      organizationId: actor.organizationId,
      membershipId: actor.membershipId,
      patientId,
    });
    await auditCollaboratorInvited(
      deps.audit,
      auditContextFor(request, { organizationId: actor.organizationId, userId: actor.userId }),
      { linkId: link.linkId, organizationId: actor.organizationId, patientId },
    );
    await publishM2(deps, {
      eventName: "m2.collaborator.invited",
      payload: { linkId: link.linkId, organizationId: actor.organizationId, patientId },
      organizationId: actor.organizationId,
      aggregateKind: "collaborator_link",
      aggregateId: link.linkId,
    });
    // Token delivered out-of-band (email) — never in body.
    return reply.code(201).send(link);
  });

  // --- GAP-115 (M2 §4.1, §3.6) Funeral home: mint a per-deceased link --------------------------
  // The same one-time link store as the collaborator link, with the funeral-home session class and its 72 h
  // lifetime. Gated like the collaborator link (session + the `caseload_membership` ABAC on the patient) and
  // FAIL-CLOSED on the one fact only M5 owns: the patient must be deceased. With no deceased-status reader bound
  // the route refuses (503) rather than minting disposition access for a living patient.
  app.post("/api/v1/funeral/invite", async (request, reply) => {
    await requireSession()(request);
    await requirePermission("funeral.invite")(request); // RBAC first; `requireAbac` below is ABAC only
    await requireAbac("funeral.invite", "caseload_membership", {
      getTarget: patientTarget,
    })(request);
    const actor = await resolveActor(deps, request);
    if (!actor.organizationId || !actor.membershipId) {
      throw new ChartWardenError("FORBIDDEN", "an org-bound staff session is required", 403);
    }
    const patientId = readString(request.body, "patientId");
    if (!deps.deceasedPatients) {
      throw unavailable(
        "DECEASED_STATUS_UNAVAILABLE",
        "the deceased-status reader is not bound; a funeral-home link cannot be minted until it is",
      );
    }
    if (!(await deps.deceasedPatients.isDeceased(actor.organizationId, patientId))) {
      throw new ChartWardenError(
        "PATIENT_NOT_DECEASED",
        "a funeral-home link can only be issued for a deceased patient",
        409,
      );
    }
    const link = await issueLink(request, {
      kind: "funeral_home",
      organizationId: actor.organizationId,
      membershipId: actor.membershipId,
      patientId,
    });
    await auditFuneralInvited(
      deps.audit,
      auditContextFor(request, { organizationId: actor.organizationId, userId: actor.userId }),
      { linkId: link.linkId, organizationId: actor.organizationId, patientId },
    );
    await publishM2(deps, {
      eventName: "m2.funeral.invited",
      payload: { linkId: link.linkId, organizationId: actor.organizationId, patientId },
      organizationId: actor.organizationId,
      aggregateKind: "funeral_link",
      aggregateId: link.linkId,
    });
    // Token delivered out-of-band — never in the body (same as the collaborator link).
    return reply.code(201).send(link);
  });

  // --- Redeem: the holder presents the one-time token and receives a scoped session ------------
  app.post("/api/v1/collaborators/consume", async (request, reply: FastifyReply) => {
    // Auth column `none`: the holder presents the one-time token (§4.2).
    const token = readString(request.body, "token");
    const ip = request.ip || "unknown";
    // §5.3.1 - a spent failed-redemption budget refuses BEFORE any lookup (canonical 429 envelope).
    try {
      await deps.linkRedeemThrottle?.assertUnderBudget({ username: null, ip });
    } catch (err) {
      if (err instanceof CredentialThrottleError) {
        reply.header("Retry-After", String(err.retryAfterSeconds));
      }
      throw err;
    }

    let scope: Awaited<ReturnType<typeof deps.collaborators.consume>>;
    try {
      scope = await deps.collaborators.consume(token);
    } catch (err) {
      if (err instanceof LinkError) {
        await deps.linkRedeemThrottle?.record({ username: null, ip, outcome: "failure" });
        if (err.link) {
          await auditLinkRedemptionRefused(
            deps.audit,
            auditContextFor(request, {
              organizationId: err.link.organizationId,
              userId: null,
              actorKind: "external_collaborator",
            }),
            { linkId: err.link.linkId, kind: err.link.kind, reason: err.link.reason },
          );
        }
        throw linkErrorToHttp(err);
      }
      throw err;
    }

    const kind = scope.kind ?? "external_collaborator";
    const durable = scope.linkId !== undefined && scope.principalUserId !== undefined;
    const giveBack = async (): Promise<void> => {
      if (scope.linkId) {
        await deps.collaborators.release?.({
          organizationId: scope.organizationId,
          linkId: scope.linkId,
        });
      }
    };

    // Eligibility is re-proved AT REDEMPTION: a funeral link outlives nothing about the patient's status.
    if (kind === "funeral_home" && durable) {
      const stillDeceased = deps.deceasedPatients
        ? await deps.deceasedPatients.isDeceased(scope.organizationId, scope.patientId)
        : false;
      if (!stillDeceased) {
        await giveBack();
        await deps.linkRedeemThrottle?.record({ username: null, ip, outcome: "failure" });
        await auditLinkRedemptionRefused(
          deps.audit,
          auditContextFor(request, {
            organizationId: scope.organizationId,
            userId: null,
            actorKind: "external_collaborator",
          }),
          { linkId: scope.linkId as string, kind, reason: "not_eligible" },
        );
        throw new ChartWardenError("LINK_EXPIRED", "link invalid or expired", 410);
      }
    }

    const sessionTtlSec =
      scope.sessionTtlSec ?? (kind === "funeral_home" ? FUNERAL_LINK_TTL_SEC : collabSessionTtlSec);
    const expiresAt = new Date(Date.now() + sessionTtlSec * 1000);
    let sessionId: string = crypto.randomUUID();

    if (durable) {
      // A durable link with no session minter must not burn the token: give the use back and say so.
      if (!deps.linkSessions) {
        await giveBack();
        throw unavailable(
          "LINK_SESSION_UNAVAILABLE",
          "this deployment cannot start a session from a link right now; the link was not used",
        );
      }
      try {
        // One active session per link (§3.6 `one_active_per_link`): earlier sessions of the principal end first.
        await deps.sessions.revokeAllForUser(scope.principalUserId as string);
        const minted = await deps.linkSessions.mint(
          {
            userId: scope.principalUserId as string,
            organizationId: scope.organizationId,
            sessionClass: kind,
            patientId: scope.patientId,
            expiresAt,
          },
          webHeaders(request),
        );
        sessionId = minted.sessionId;
        appendSetCookies(reply, minted.setCookies);
      } catch {
        await giveBack();
        throw unavailable(
          "LINK_SESSION_UNAVAILABLE",
          "a session could not be started from this link; the link was not used",
        );
      }
      await auditLinkRedeemed(
        deps.audit,
        auditContextFor(request, {
          organizationId: scope.organizationId,
          userId: null,
          actorKind: "external_collaborator",
        }),
        {
          linkId: scope.linkId as string,
          sessionId,
          kind,
          patientId: scope.patientId,
          useCount: scope.useCount ?? 1,
        },
      );
      await deps.linkRedeemThrottle?.record({ username: null, ip, outcome: "success" });
    }

    await auditCollaboratorSessionStarted(
      deps.audit,
      auditContextFor(request, {
        organizationId: scope.organizationId,
        userId: null,
        actorKind: "external_collaborator",
      }),
      { sessionId, organizationId: scope.organizationId, patientId: scope.patientId },
    );
    await publishM2(deps, {
      eventName: "m2.collaborator.session_started",
      payload: { sessionId, organizationId: scope.organizationId, patientId: scope.patientId },
      organizationId: scope.organizationId,
      aggregateKind: "session",
      aggregateId: sessionId,
    });
    // Durable mounts have set the session cookie above; the per-process slice store (tests only) cannot.
    return reply.code(200).send({
      sessionClass: kind,
      scope: { patientId: scope.patientId },
      expiresAt: expiresAt.toISOString(),
    });
  });

  // --- The ONE read a funeral-home session holds ------------------------------------------------
  // RBAC: `funeral.case_read` is a property of the `funeral_home` SESSION CLASS (rbac/session-class-permissions) - no
  // staff role carries it. ABAC `funeral_session_pinned_patient`: the class is funeral_home AND the patient is the one
  // the session was pinned to at mint (read from the SESSION, never from the URL - there is no id in the path).
  app.get(
    "/api/v1/funeral/case",
    {
      preHandler: [
        requirePermission("funeral.case_read"),
        requireAbac("funeral.case_read", "funeral_session_pinned_patient", {
          getTarget: (req: { context?: { attributes?: Record<string, unknown> } }) => ({
            patientId: req.context?.attributes?.sessionPatientId,
          }),
        }),
      ],
      // The patient id (an opaque uuid the session is already pinned to) rides the payload so the §164.528 accounting
      // joins this read to the decedent; the name and date of death are never copied into the audit row.
      config: { auditRead: { resourceKind: "funeral_case", patientIdPayloadPath: "patientId" } },
    },
    async (request) => {
      const organizationId = request.context.organizationId;
      const patientId = request.context.attributes?.sessionPatientId;
      if (!organizationId || typeof patientId !== "string" || patientId.length === 0) {
        throw new ChartWardenError("NOT_FOUND", "case not found", 404);
      }
      if (!deps.funeralCases) {
        throw unavailable("FUNERAL_CASE_UNAVAILABLE", "the decedent record reader is not bound");
      }
      const found = await deps.funeralCases.read(organizationId, patientId);
      if (!found) throw new ChartWardenError("NOT_FOUND", "case not found", 404);
      return { patientId, decedentName: found.decedentName, dateOfDeath: found.dateOfDeath };
    },
  );
}
