// apps/backend/src/modules/34-saas-tenant-platform/routes/public/signup-intents.ts — M34 the PUBLIC
// self-serve signup surface (§4.1 "Public routes (no session)"; §7.1 Phase-3). Three pre-organization,
// session-less routes that drive a prospect from "interested" → verified email → first-admin acceptance:
//
//   POST /api/v1/public/signup-intents                          create a tenant_signup_intent('new') + token
//   POST /api/v1/public/signup-intents/:tokenHash/verify-email  consume the email-verification token
//   POST /api/v1/public/tenant-invitations/:tokenHash/accept    accept the platform → first-admin invitation
//
// PHASE BOUNDARY (D14 / §0): self-serve signup ships Phase 3. The route exists Phase 1 with the
// `m34.self_serve_signup` feature flag DENY-BY-DEFAULT — when the flag is OFF (the Phase-1 default for the
// platform) every route returns `503 SIGNUP_DISABLED` BEFORE the handler runs, so no intent is ever created.
// This mirrors the M22 `documents.doclens` 503-gate precedent. The supporting tables exist Phase 1; the
// marketing front-end (apps/marketing/) is Phase 3 and is NOT in this file.
//
// PRE-ORGANIZATION (M34-F02 / ADR-0010, §3.10): `tenant_signup_intent` / `tenant_signup_token` are the one
// legitimate org-less exemption — there is NO org to scope to yet. So these routes carry NEITHER a session
// NOR `withOrgContext`/`withPlatformContext` at the route layer; the injected service performs every write
// under `withPlatformContext` INSIDE itself (the M1 RLS-bypass helper, allowlisted per M01-F05; the
// `SignupIntentRepository` doc-comment), because `tenant_platform_writer` is the only role that may write
// these org-less tables. The `source` is server-pinned to `self_serve_form` (the body can never widen it).
//
// ABUSE CONTROLS (§5 threat model): rate-limited 5/IP/hour via the injected `RateLimiter` port (M1's
// limiter in prod; Cloudflare WAF in front). On limit → `429 RATE_LIMITED` with `Retry-After`. The raw token
// is returned to the prospect's email channel (M36), NEVER in the HTTP response, and only its SHA256 hash is
// persisted (value-capture-denylisted in the audit projection, §3.10).
import { type Static, Type } from "@sinclair/typebox";
import { RateLimitedError, WardenXError } from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  AcceptInvitationRequest,
  PublicSignupIntentRequest,
  TokenHashParamsSchema,
  parse,
} from "../typebox";

/** A preHandler wrapped as a Fastify preHandler (structurally assignable). */
type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** The capability flag that unlocks self-serve signup (D14) — Phase 3, default OFF for the platform. */
export const SELF_SERVE_SIGNUP_FLAG = "m34.self_serve_signup" as const;
/** The error code the public routes return when the flag is OFF (the Phase-1 platform default). */
export const SIGNUP_DISABLED_CODE = "SIGNUP_DISABLED" as const;

/** 503 SIGNUP_DISABLED — self-serve signup is OFF (Phase-1 deny-default; the body is never reached). */
export function signupDisabled(): WardenXError {
  return new WardenXError(SIGNUP_DISABLED_CODE, "self-serve signup is not enabled", 503);
}

/**
 * Resolves whether self-serve signup is enabled for the PLATFORM (global flag — there is no org pre-
 * provision). Deny-default: absent reader ⇒ false (the Phase-1 default → every public route 503s). The
 * platform-global flag store is M1-owned; this thin port keeps the public route from importing the M1
 * flag admin directly (no dependency edge), the M22 `DocumentFeatureFlagReader` precedent.
 */
export interface SelfServeSignupGate {
  /** `true` only when the platform-global `m34.self_serve_signup` flag is ON. */
  isEnabled(): Promise<boolean>;
}

/** Deny-default gate: no flag store wired ⇒ self-serve signup OFF (Phase-1). */
export function createDenyDefaultSelfServeSignupGate(): SelfServeSignupGate {
  return {
    async isEnabled() {
      return false;
    },
  };
}

/**
 * Per-IP rate limiter port (§5 — 5/IP/hour). `consume` returns `false` (or a `retryAfterSeconds`) when the
 * caller is over budget. Absent ⇒ unlimited (the slice default; prod injects M1's limiter). The public
 * routes are the one place IP — not a session principal — is the rate key, so the key is the request IP.
 */
export interface RateLimiter {
  consume(key: string): Promise<{ allowed: boolean; retryAfterSeconds?: number }>;
}

/** Deny-nothing limiter: no limiter wired ⇒ every call allowed (slice default; M1's limiter in prod). */
export function createAllowAllRateLimiter(): RateLimiter {
  return {
    async consume() {
      return { allowed: true };
    },
  };
}

/** Result of creating a signup intent (the public ack — never carries the raw token). */
export interface SignupIntentCreated {
  readonly signupIntentId: string;
}

/**
 * The org-less signup-intent route service the public handlers compose over. Every method performs its
 * persistence under `withPlatformContext` internally (the org-less tables; §3.10). In prod this is a
 * Drizzle-backed adapter over `SignupIntentRepository`; the slice injects an in-memory fake. The raw token
 * is dispatched out-of-band (M36 email) — it is NEVER returned to the HTTP caller.
 */
export interface SignupIntentRouteService {
  /** Create a `tenant_signup_intent('new')` + issue an `email_verification` token (raw token → M36). */
  createIntent(args: {
    contactEmail: string;
    legalBusinessName: string;
    intendedFirstAdminEmail: string;
  }): Promise<SignupIntentCreated>;
  /** Consume a single-use `email_verification` token by its SHA256 hash; idempotent on re-consume → 409. */
  verifyEmail(tokenHash: string): Promise<{ verified: true }>;
  /** Accept the platform → first-admin invitation by token hash; creates the M2 user + first org_admin. */
  acceptInvitation(tokenHash: string, args: { displayName?: string }): Promise<{ accepted: true }>;
}

export interface PublicSignupRouteDeps {
  service: SignupIntentRouteService;
  /** Deny-default self-serve gate (absent ⇒ OFF → every route 503s; the Phase-1 platform default). */
  signupGate?: SelfServeSignupGate;
  /** Per-IP limiter (absent ⇒ unlimited; prod injects M1's 5/IP/hour limiter). */
  rateLimiter?: RateLimiter;
}

/** Resolve the caller IP for the rate key (X-Forwarded-For-aware via Fastify's trustProxy `request.ip`). */
const ipOf = (request: FastifyRequest): string => request.ip || "unknown";

const PublicAck = Type.Object({ signupIntentId: Type.String(), status: Type.Literal("new") });
type PublicAckType = Static<typeof PublicAck>;

export function registerPublicSignupRoutes(
  app: FastifyInstance,
  deps: PublicSignupRouteDeps,
): void {
  const { service } = deps;
  const signupGate = deps.signupGate ?? createDenyDefaultSelfServeSignupGate();
  const rateLimiter = deps.rateLimiter ?? createAllowAllRateLimiter();

  /**
   * D14 deny-default gate. When `m34.self_serve_signup` is OFF (the Phase-1 platform default) we throw
   * `503 SIGNUP_DISABLED` BEFORE the handler runs, so no signup intent is ever created. Defense in depth:
   * the gate fronts the self-serve intent and email-verification routes. Platform-issued first-admin
   * invitations remain acceptable while self-serve acquisition is disabled.
   */
  const requireSignupEnabled: PreHandler = async () => {
    if (!(await signupGate.isEnabled())) throw signupDisabled();
  };

  /** §5 — per-IP 5/hour limit. On budget exhaustion → `429 RATE_LIMITED` with `Retry-After`. */
  const requireUnderRateLimit: PreHandler = async (request, reply) => {
    const verdict = await rateLimiter.consume(ipOf(request));
    if (!verdict.allowed) {
      if (verdict.retryAfterSeconds !== undefined) {
        reply.header("Retry-After", String(verdict.retryAfterSeconds));
      }
      throw new RateLimitedError("too many signup attempts from this address");
    }
  };

  // 1 — public self-serve signup intake. No session, no org (pre-organization). `source` is server-pinned
  //     to `self_serve_form`; the raw token goes to the prospect's email (M36), never the HTTP response.
  app.post(
    "/api/v1/public/signup-intents",
    { preHandler: [requireSignupEnabled, requireUnderRateLimit] },
    async (request, reply) => {
      const body = parse(PublicSignupIntentRequest, request.body);
      const created = await service.createIntent({
        contactEmail: body.contactEmail,
        legalBusinessName: body.legalBusinessName,
        intendedFirstAdminEmail: body.intendedFirstAdminEmail,
      });
      const ack: PublicAckType = { signupIntentId: created.signupIntentId, status: "new" };
      return reply.code(201).send(ack);
    },
  );

  // 2 — consume the single-use email-verification token (idempotent re-consume → 409 from the service).
  app.post(
    "/api/v1/public/signup-intents/:tokenHash/verify-email",
    { preHandler: [requireSignupEnabled, requireUnderRateLimit] },
    async (request, reply) => {
      const { tokenHash } = parse(TokenHashParamsSchema, request.params);
      const res = await service.verifyEmail(tokenHash);
      return reply.code(200).send(res);
    },
  );

  // 3 — accept the platform → first-admin invitation; creates the M2 user + first org_admin membership.
  app.post(
    "/api/v1/public/tenant-invitations/:tokenHash/accept",
    { preHandler: [requireUnderRateLimit] },
    async (request, reply) => {
      const { tokenHash } = parse(TokenHashParamsSchema, request.params);
      const body = parse(AcceptInvitationRequest, request.body);
      const res = await service.acceptInvitation(tokenHash, { displayName: body.displayName });
      return reply.code(200).send(res);
    },
  );
}

// TODO(Phase 2D — worker/adapter wiring): bind `SignupIntentRouteService` to the Drizzle adapter over
// `SignupIntentRepository` (every call inside `withPlatformContext`), bind `SelfServeSignupGate` to the
// M1 platform-global feature-flag store, and bind `RateLimiter` to M1's 5/IP/hour limiter. The
// first-admin acceptance path (route 3) additionally calls M2's `createUser` + first-`org_admin`-membership
// helper through the auth foundation (no new dependency edge — M34 dependsOn stays [1,2,3,4,36]). Token
// dispatch (the raw email_verification / first_admin_setup token) is an M36 PHI-sanitized channel publish;
// the raw token is value-capture-denylisted in the audit projection (§3.10) and never returned over HTTP.
