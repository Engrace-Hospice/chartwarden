// apps/backend/src/modules/31-portal/routes/sign-in.routes.ts — M31 invitee SIGN-IN (§2.2.4, §8.1, D2–D3).
//
// An invitee authenticates through M2/Better Auth (magic link — the same primitive the CAHPS/auditor links use —
// or password + TOTP, or a passkey). That yields a PRE-ORG session. These two routes turn it into a PORTAL session:
//
//   GET  /api/v1/portal/sign-in/accounts   which portal accounts this signed-in user holds, and which can sign in
//   POST /api/v1/portal/sign-in/establish  bind THIS session to one of them (org + session class + portalAccountId)
//
// Once bound, the ordinary authenticate hook stamps `portalAccountId` / `sessionClass` on every request, the
// session-class permission set (packages/auth rbac/session-class-permissions) answers RBAC, and the §4.7 ABAC
// predicates on every portal route narrow to the account's live grant. The patient is bound afterwards by
// `select-patient` (D2) — a portal session is scoped to the patients the account is GRANTED, never to the user.
//
// THE USER AND THE SESSION COME FROM THE SERVER, NEVER THE BODY. The only request field is an optional account
// id, and it is matched solely against the signed-in user's OWN accounts (naming another user's account is
// indistinguishable from naming none). No PHI is read or returned before the bind: the responses carry a tenant
// display name, an enum relationship and ids.
//
// ABUSE CONTROLS. The global per-user rate tier (SD-055) applies; on top, failed binds are throttled per user and per
// IP with the §5.3.1 shape (5 failures / 10 min / user, 30 / IP — a fixed self-healing window, not an admin
// unlock), and every bind and refusal is audited. A suspended/revoked account is refused (lockout), as is an
// unverified email, a non-active tenant and an account with no live grant. Idempotent: a replay of the same bind
// answers 200 `replayed:true`; a different bind of an already-bound session is a 409, never a silent re-scope.
import { CredentialThrottleError } from "@wardenx/auth";
import { ForbiddenError, UnauthorizedError, type ChartWardenError } from "@wardenx/types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { PortalStateError } from "../lifecycle/errors";
import { accountRefusal, decideSignIn } from "../sign-in";
import { requireIdempotencyKey } from "./concurrency";
import type { PortalRouteDeps } from "./index";
import { PortalSignInEstablishRequest, parse } from "./portal-typebox";

/** The authenticated, PRE-ORG caller: a user and a session id, no tenant bound yet. */
function preOrgCaller(request: FastifyRequest): { userId: string; sessionId: string } {
  const ctx = request.context;
  const sessionId = ctx?.attributes?.sessionId;
  if (!ctx?.userId || typeof sessionId !== "string" || sessionId.length === 0) {
    throw new UnauthorizedError();
  }
  // The system principal and any non-interactive caller can never sign in to the portal.
  if (ctx.attributes?.actorKind !== "user") throw new ForbiddenError("interactive sign-in only");
  return { userId: ctx.userId, sessionId };
}

const unavailable = (): ChartWardenError =>
  new PortalStateError("SIGN_IN_UNAVAILABLE", "portal sign-in is not available in this deployment");

export function registerPortalSignInRoutes(app: FastifyInstance, deps: PortalRouteDeps): void {
  const now = deps.now ?? (() => new Date());

  app.get(
    "/api/v1/portal/sign-in/accounts",
    {
      config: {
        auditRead: {
          none: "pre-org: the caller's OWN portal accounts (tenant display name, relationship enum, refusal code); no PHI, no patient id",
        },
      },
    },
    async (request) => {
      const { userId } = preOrgCaller(request);
      if (!deps.signIn) throw unavailable();
      const accounts = await deps.signIn.accountsForUser(userId);
      return {
        items: accounts.map((a) => ({
          portalAccountId: a.portalAccountId,
          organizationName: a.organizationName,
          relationship: a.relationship,
          blockedReason: accountRefusal(a)?.code ?? null,
        })),
      };
    },
  );

  app.post(
    "/api/v1/portal/sign-in/establish",
    { preHandler: [requireIdempotencyKey()] },
    async (request, reply) => {
      const { userId, sessionId } = preOrgCaller(request);
      const port = deps.signIn;
      if (!port) throw unavailable();
      const body = parse(PortalSignInEstablishRequest, request.body);
      const ip = request.ip || "unknown";
      const userAgent =
        typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : null;
      // §5.3.1 — refuse a spent budget BEFORE doing any work (throws the canonical 429 envelope).
      try {
        await deps.signInThrottle?.assertUnderBudget({ username: userId, ip });
      } catch (err) {
        if (err instanceof CredentialThrottleError) {
          reply.header("Retry-After", String(err.retryAfterSeconds));
        }
        throw err;
      }

      const decision = decideSignIn(await port.accountsForUser(userId), body.portalAccountId);
      if (decision.kind === "select") {
        throw new PortalStateError(
          "SIGN_IN_ACCOUNT_SELECTION_REQUIRED",
          "this sign-in holds more than one family portal account; choose which one to open",
        );
      }
      if (decision.kind === "refuse") {
        await deps.signInThrottle?.record({ username: userId, ip, outcome: "failure" });
        if (decision.account) {
          await port.recordRefusal({
            sessionId,
            userId,
            organizationId: decision.account.organizationId,
            portalAccountId: decision.account.portalAccountId,
            reason: decision.error.code,
            ip,
            userAgent,
          });
        }
        throw decision.error;
      }

      const { account, sessionClass } = decision;
      const outcome = await port.bindSession({
        sessionId,
        userId,
        organizationId: account.organizationId,
        portalAccountId: account.portalAccountId,
        sessionClass,
        ip,
        userAgent,
      });
      if (outcome === "refused") {
        await deps.signInThrottle?.record({ username: userId, ip, outcome: "failure" });
        throw new PortalStateError(
          "SIGN_IN_SESSION_NOT_BINDABLE",
          "this session is already in use for something else; sign out and sign in again",
        );
      }
      await deps.signInThrottle?.record({ username: userId, ip, outcome: "success" });
      if (outcome === "bound") {
        await deps.store.recordLogin(account.organizationId, account.portalAccountId, now());
      }
      return {
        portalAccountId: account.portalAccountId,
        organizationName: account.organizationName,
        sessionClass,
        replayed: outcome === "already_bound",
      };
    },
  );
}
