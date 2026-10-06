// apps/backend/src/modules/28-fhir/routes/token-mint.ts — R3, the `/fhir/oauth2/token` mint (F-035, #95).
//
// THE ROUTE THAT MADE EVERY OTHER ROUTE UNREACHABLE. Phase 1 registered R3 as a body-shape check followed
// by an unconditional `401 invalid_client`, with a comment calling that "correct — no external client is
// provisioned yet". It was not a posture, it was a wall: R4 through R22 all begin with `resolveBearer`,
// a bearer token is only obtainable here, and this endpoint could not issue one for any input. Whether a
// client was provisioned made no difference; the surface refused everyone identically.
//
// The pure decision cores this composes have existed, complete and unit-tested, since M28-T03 with no
// caller: `verifyClientAssertion` (RS384 / iss=sub=client_id / aud / 5-minute lifetime ceiling / jti /
// signature), `verifyApiKey`, `resolveGrantedScopes` and `buildSessionMint`. This file supplies only the
// three stateful obligations those cores deliberately refuse to own — fetching the client's JWKS,
// burning the assertion's `jti` against replay, and writing the session row — and the org context they
// all run in.
//
// ── THE ERROR MODEL IS OAuth, NOT FHIR ─────────────────────────────────────────────────────────────
// R3 is an OAuth token endpoint, so its failures are `application/json` OAuth errors
// (`invalid_client` / `invalid_scope` / `invalid_request` / `unsupported_grant_type`), NOT
// `OperationOutcome`. Every other route in this file's neighbourhood answers FHIR; this one must not,
// because a SMART client's token layer parses OAuth and would report a conformant OperationOutcome as an
// unparseable response.
//
// ── WHAT THE CLIENT IS TOLD, AND WHAT IT IS NOT ────────────────────────────────────────────────────
// Every authentication failure — unknown client, wrong status, bad signature, expired assertion, replayed
// jti, wrong secret — collapses to one `invalid_client` with one generic description. The typed rejection
// reason from the pure core is real and is what the server LOGS; it is not what the caller reads. A
// partner debugging a genuine misconfiguration is not helped much by the difference, and an attacker
// probing client ids very much is: distinguishing "no such client" from "wrong secret" turns this
// endpoint into a client-id oracle. `invalid_scope` is the one exception and is deliberate — §2.3 says a
// token is never silently down-scoped, so the client MUST be told exactly which scopes exceeded its
// grant, and knowing that already requires holding the credential.
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import {
  FHIR_JWT_BEARER_ASSERTION_TYPE,
  type FhirJwk,
  buildSessionMint,
  resolveGrantedScopes,
  verifyClientAssertion,
} from "@wardenx/fhir";
import type { FhirClientId, FhirClientSessionJti } from "@wardenx/types";

import type { FhirBaaStatusView } from "../seams/index";
import { BAA_NOT_IN_FORCE_CODE, isBaaInForce, isIpAllowed } from "./client-gates";
import type { FhirClientRateLimiter } from "./client-rate-limiter";
import type { FhirGatewayStore, FhirTokenClientView } from "./store";

/** Resolves a registered client's `jwks_uri` to its published key set. */
export interface FhirJwksFetcher {
  /** The RSA JWKs at `jwksUri`, or null when the set cannot be fetched or parsed. */
  fetch(jwksUri: string): Promise<readonly FhirJwk[] | null>;
}

/**
 * The `jti` replay defence the SMART profile requires. `claim` returns true when this assertion id has
 * NOT been seen before and is now burned until `expiresAtMs`; false when it has.
 *
 * A separate port rather than a reuse of the rate-limit store because the failure semantics invert: a
 * rate limiter that cannot reach its backend fails OPEN (a brief over-admission beats an outage), and a
 * replay guard that cannot reach its backend must fail CLOSED — "I do not know whether this assertion
 * has been used" is not a reason to accept it a second time.
 */
export interface FhirAssertionReplayGuard {
  claim(jti: string, expiresAtMs: number): Promise<boolean>;
}

/**
 * Per-process replay guard. Correct for a single-replica deployment, where one replica IS the cluster.
 *
 * On a multi-replica deployment it is NOT sufficient on its own and the composition root binds the Valkey
 * one instead: an assertion burned on replica A is unknown to replica B, so a captured assertion could be
 * replayed there inside its ≤5-minute lifetime. That window is exactly what the lifetime ceiling exists
 * to bound, which is why this fallback is a bounded weakness rather than an open door — but it is a real
 * one, and it is stated here rather than left for someone to discover.
 */
export function createInMemoryFhirReplayGuard(): FhirAssertionReplayGuard {
  const burned = new Map<string, number>();
  return {
    async claim(jti, expiresAtMs) {
      const now = Date.now();
      // Prune on write: entries are only ever short-lived (≤ the 5-minute assertion ceiling), so the map
      // cannot grow without bound even under sustained mint traffic.
      for (const [key, expiry] of burned) if (expiry <= now) burned.delete(key);
      if (burned.has(jti)) return false;
      burned.set(jti, expiresAtMs);
      return true;
    },
  };
}

/** The minimal Valkey/Redis surface the cluster-wide replay guard needs (an ioredis client satisfies it). */
export interface FhirReplayRedis {
  set(
    key: string,
    value: string,
    mode: "PX",
    ttlMs: number,
    condition: "NX",
  ): Promise<string | null>;
}

/**
 * Cluster-wide replay guard over Valkey. `SET key value PX ttl NX` is atomic set-if-absent, so two
 * replicas racing on the same assertion serialize and exactly one wins — the same primitive
 * `putPending` uses on the idempotency store, for the same reason.
 *
 * A store error REFUSES the claim (fail closed), per the port's contract.
 */
export function createRedisFhirReplayGuard(redis: FhirReplayRedis): FhirAssertionReplayGuard {
  return {
    async claim(jti, expiresAtMs) {
      const ttlMs = Math.max(1000, expiresAtMs - Date.now());
      try {
        const result = await redis.set(`m28:assertion:${jti}`, "1", "PX", ttlMs, "NX");
        return result === "OK";
      } catch {
        return false;
      }
    },
  };
}

/** JWKS over `fetch`, with a short positive cache. */
export function createHttpFhirJwksFetcher(opts: { cacheTtlMs?: number } = {}): FhirJwksFetcher {
  const ttl = opts.cacheTtlMs ?? 5 * 60 * 1000;
  const cache = new Map<string, { keys: readonly FhirJwk[]; expiresAt: number }>();
  return {
    async fetch(jwksUri) {
      const hit = cache.get(jwksUri);
      if (hit && hit.expiresAt > Date.now()) return hit.keys;
      try {
        // `https` only: a `jwks_uri` is the root of trust for everything this client will ever assert,
        // and fetching it over plaintext would let a network attacker substitute their own key set and
        // authenticate as the partner. The admin registration surface should refuse a non-https uri too;
        // this is the belt to that pair of braces.
        if (!jwksUri.startsWith("https://")) return null;
        const response = await fetch(jwksUri, {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) return null;
        const body = (await response.json()) as { keys?: unknown };
        if (!Array.isArray(body.keys)) return null;
        const keys = body.keys.filter(
          (k): k is FhirJwk => typeof k === "object" && k !== null,
        ) as readonly FhirJwk[];
        // Only a POSITIVE result is cached. Caching a failure would turn a momentary partner outage into
        // a `cacheTtlMs`-long one for a client whose keys came back seconds later.
        cache.set(jwksUri, { keys, expiresAt: Date.now() + ttl });
        return keys;
      } catch {
        return null;
      }
    },
  };
}

/** An OAuth error body, as the token endpoint must render it (RFC 6749 §5.2). */
export interface FhirTokenError {
  readonly status: number;
  readonly body: {
    readonly error: string;
    readonly error_description: string;
    /** Only set for a BAA refusal, which is reported AFTER the credential verified (no oracle). */
    readonly wardenx_code?: string;
  };
  /** Seconds to wait; set on a 429 so the route can emit `Retry-After`. */
  readonly retryAfterSeconds?: number;
  /** Set when the BAA gate refused: the route writes the structured server-side log line from it. */
  readonly baaFailure?: {
    readonly clientId: string;
    readonly organizationId: string;
    readonly contractReference: string;
  };
  /** The precise internal reason, for the server log — never sent to the client (see header). */
  readonly logReason: string;
}

/** A successful mint: the OAuth access-token response, plus the row already written. */
export interface FhirTokenGrant {
  readonly body: {
    readonly access_token: string;
    readonly token_type: "bearer";
    readonly expires_in: number;
    readonly scope: string;
  };
  readonly clientId: string;
  readonly organizationId: string;
}

export type FhirTokenResult =
  | { readonly ok: true; readonly grant: FhirTokenGrant }
  | { readonly ok: false; readonly error: FhirTokenError };

export interface FhirTokenMintDeps {
  readonly store: FhirGatewayStore;
  readonly jwks: FhirJwksFetcher;
  readonly replay: FhirAssertionReplayGuard;
  /**
   * The absolute URL of THIS token endpoint — the `aud` an assertion must carry. Bound from
   * `FHIR_TOKEN_ENDPOINT_URL`; absent, the mint refuses the SMART path entirely rather than accepting
   * an unbound audience, because audience is the check that stops an assertion minted for a partner's
   * OTHER server being replayed against this one.
   */
  readonly tokenEndpointUrl?: string;
  readonly nowMs?: () => number;
  /**
   * GAP-083 — the M40 BAA gate. UNBOUND ⇒ no token is minted (fail closed): a client whose BAA cannot be
   * shown to be in force must not be handed a credential for PHI egress.
   */
  readonly baa?: Pick<FhirBaaStatusView, "isBaaActive">;
  /** D16 — per-client token bucket for the mint (absent ⇒ unthrottled, as before; production binds it). */
  readonly rateLimiter?: FhirClientRateLimiter;
}

/** The token-request fields, after body validation. */
export interface FhirTokenRequest {
  readonly scope: string;
  readonly clientId?: string;
  readonly clientAssertionType?: string;
  readonly clientAssertion?: string;
  readonly clientSecret?: string;
  readonly ip?: string | null;
}

const INVALID_CLIENT = (logReason: string): FhirTokenError => ({
  status: 401,
  body: {
    error: "invalid_client",
    error_description: "the presenting client could not be authenticated",
  },
  logReason,
});

const sha256Hex = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

/** Constant-time compare of a presented secret's digest against one stored digest. */
function digestMatches(presentedDigest: string, storedDigest: string): boolean {
  const a = Buffer.from(presentedDigest, "utf8");
  const b = Buffer.from(storedDigest, "utf8");
  // Length is not secret (both are sha256 hex), but `timingSafeEqual` throws on a mismatch, so guard it.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Read the `iss` out of an assertion WITHOUT verifying it, purely to decide which registered client to
 * look up. Safe because nothing is trusted on the strength of it: `verifyClientAssertion` then binds
 * `iss = sub = the client id we looked up` AND verifies the signature against THAT client's key set, so
 * a lie here selects a client whose key cannot verify the assertion and the request fails.
 */
function unverifiedIssuer(assertion: string): string | null {
  const payload = assertion.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    if (typeof claims !== "object" || claims === null) return null;
    const iss = (claims as { iss?: unknown }).iss;
    return typeof iss === "string" && iss.length > 0 ? iss : null;
  } catch {
    return null;
  }
}

/**
 * R3 — authenticate a token request by either §D2 path and mint a `fhir_client_session`.
 *
 * The returned `access_token` IS the session `jti`: an opaque, server-minted uuid that carries no claims
 * and is worthless without the row behind it, so revoking a session (§2.4's cascade, R30) takes effect on
 * the very next request rather than at the end of a self-asserted lifetime.
 */
export async function mintFhirToken(
  deps: FhirTokenMintDeps,
  request: FhirTokenRequest,
): Promise<FhirTokenResult> {
  const nowMs = (deps.nowMs ?? (() => Date.now()))();
  const usingAssertion =
    request.clientAssertion !== undefined && request.clientAssertion.length > 0;

  // ── select the §D2 path, and enforce ITS requirements ────────────────────────────────────────────
  let client: FhirTokenClientView | null;
  let tokenKeyFingerprint: string;

  if (usingAssertion) {
    if (request.clientAssertionType !== FHIR_JWT_BEARER_ASSERTION_TYPE) {
      return {
        ok: false,
        error: {
          status: 400,
          body: {
            error: "invalid_request",
            error_description: `client_assertion_type must be ${FHIR_JWT_BEARER_ASSERTION_TYPE}`,
          },
          logReason: "assertion presented with a wrong or missing client_assertion_type",
        },
      };
    }
    if (deps.tokenEndpointUrl === undefined || deps.tokenEndpointUrl.length === 0) {
      // A DEPLOYMENT fault, not a client fault, and it must not be reported as one: telling a partner
      // their credential is invalid when the server does not know its own audience sends them to debug
      // a key that is fine. 503 with a distinct code is the honest answer.
      return {
        ok: false,
        error: {
          status: 503,
          body: {
            error: "temporarily_unavailable",
            error_description:
              "this deployment has no FHIR token-endpoint URL configured, so a client assertion's audience cannot be verified",
          },
          logReason: "FHIR_TOKEN_ENDPOINT_URL is unset; the SMART Backend Services path is unbound",
        },
      };
    }
    const clientId = request.clientId ?? unverifiedIssuer(request.clientAssertion as string);
    if (clientId === null) return { ok: false, error: INVALID_CLIENT("no client_id and no iss") };
    client = await deps.store.resolveClientForToken(clientId);
    if (client === null) return { ok: false, error: INVALID_CLIENT("unknown client_id") };
    if (client.type !== "smart_backend_services") {
      return {
        ok: false,
        error: INVALID_CLIENT("client is not registered for the assertion flow"),
      };
    }
    if (client.status !== "active") {
      return { ok: false, error: INVALID_CLIENT(`client status is ${client.status}`) };
    }
    // GAP-083 / D12 — the IP allowlist binds the mint too; `request.ip` is the trusted-proxy-derived peer.
    if (!isIpAllowed(request.ip, client.ipAllowlist)) {
      return { ok: false, error: INVALID_CLIENT("source ip is outside the client's allowlist") };
    }
    if (client.jwksUri === null || client.jwksUri.length === 0) {
      return { ok: false, error: INVALID_CLIENT("client has no registered jwks_uri") };
    }
    const jwks = await deps.jwks.fetch(client.jwksUri);
    if (jwks === null || jwks.length === 0) {
      return { ok: false, error: INVALID_CLIENT("the client's jwks_uri could not be resolved") };
    }
    const verdict = verifyClientAssertion({
      assertion: request.clientAssertion as string,
      expectedClientId: client.id as FhirClientId,
      expectedAudience: deps.tokenEndpointUrl,
      jwks,
      nowMs,
    });
    if (!verdict.ok) return { ok: false, error: INVALID_CLIENT(`assertion ${verdict.reason}`) };
    // Replay LAST, and only after the signature verified: burning a jti carried by an unverified
    // assertion would let anyone who can guess a jti deny that assertion to its real holder.
    const fresh = await deps.replay.claim(verdict.claims.jti, verdict.claims.expiresAtMs);
    if (!fresh) return { ok: false, error: INVALID_CLIENT("assertion jti replayed") };
    tokenKeyFingerprint = sha256Hex(verdict.claims.jti);
  } else {
    const clientId = request.clientId;
    const secret = request.clientSecret;
    if (clientId === undefined || secret === undefined) {
      return {
        ok: false,
        error: {
          status: 400,
          body: {
            error: "invalid_request",
            error_description:
              "present either client_assertion (SMART Backend Services) or client_id + client_secret (api key)",
          },
          logReason: "token request carried neither §D2 credential",
        },
      };
    }
    client = await deps.store.resolveClientForToken(clientId);
    if (client === null) return { ok: false, error: INVALID_CLIENT("unknown client_id") };
    if (client.type !== "api_key") {
      return { ok: false, error: INVALID_CLIENT("client is not registered for the api-key flow") };
    }
    if (client.status !== "active") {
      return { ok: false, error: INVALID_CLIENT(`client status is ${client.status}`) };
    }
    // GAP-083 / D12 — the IP allowlist binds the mint too; `request.ip` is the trusted-proxy-derived peer.
    if (!isIpAllowed(request.ip, client.ipAllowlist)) {
      return { ok: false, error: INVALID_CLIENT("source ip is outside the client's allowlist") };
    }
    const presented = sha256Hex(secret);
    // Every candidate is compared, without short-circuiting on the first match, so the time taken does
    // not reveal WHICH credential matched — during a rotation overlap that would leak whether the
    // partner is still on the old secret.
    const matched = client.apiKeyDigests.reduce(
      (found, stored) => digestMatches(presented, stored) || found,
      false,
    );
    if (!matched) return { ok: false, error: INVALID_CLIENT("api-key secret did not match") };
    tokenKeyFingerprint = presented;
  }

  // D16 — the mint is throttled per client, AFTER the credential verified so an unauthenticated caller
  // cannot drain a real client's allowance. A separate key from reads: a read flood must not block a
  // client from refreshing its token, and a mint loop must not starve its reads.
  if (deps.rateLimiter !== undefined) {
    const verdict = await deps.rateLimiter.consume(`mint:${client.id}`, client.rateLimitRps);
    if (!verdict.allowed) {
      return {
        ok: false,
        error: {
          status: 429,
          body: {
            error: "temporarily_unavailable",
            error_description: "token requests for this client are rate limited; retry later",
          },
          retryAfterSeconds: verdict.retryAfterSeconds,
          logReason: "token mint rate limit exceeded for client",
        },
      };
    }
  }

  // GAP-083 / D12 — BAA after the credential verified (so an unauthenticated caller cannot drive the
  // lookup), before any token exists.
  const baaOk = await isBaaInForce(deps.baa, {
    organizationId: client.organizationId,
    contractReference: client.baaContractReference,
    asOf: new Date(nowMs).toISOString(),
  });
  if (!baaOk) {
    // The caller has proven the credential, so naming the cause leaks nothing and tells the partner (and
    // the operator reading logs) this is a contract problem, not a bad secret.
    return {
      ok: false,
      error: {
        ...INVALID_CLIENT(`client BAA is not in force (${BAA_NOT_IN_FORCE_CODE})`),
        body: {
          error: "invalid_client",
          error_description:
            "the presenting client could not be authenticated: no BAA is in force for this client",
          wardenx_code: BAA_NOT_IN_FORCE_CODE,
        },
        baaFailure: {
          clientId: client.id,
          organizationId: client.organizationId,
          contractReference: client.baaContractReference,
        },
      },
    };
  }

  // ── §2.3 scope resolution: subset-or-refuse, never a silent down-scope ───────────────────────────
  const requested = request.scope.split(/\s+/).filter((s) => s.length > 0);
  const grant = resolveGrantedScopes(requested, client.allowedScopes);
  if (!grant.ok) {
    return {
      ok: false,
      error: {
        status: 400,
        body: {
          error: "invalid_scope",
          error_description: `these scopes exceed the client's grant: ${grant.invalidScopes.join(" ")}`,
        },
        logReason: `scopes outside grant: ${grant.invalidScopes.join(" ")}`,
      },
    };
  }

  const jti = randomUUID();
  const envelope = buildSessionMint({
    clientId: client.id as FhirClientId,
    jti: jti as FhirClientSessionJti,
    scopesGranted: grant.granted,
    issuedAtMs: nowMs,
  });
  await deps.store.mintSession({
    organizationId: client.organizationId,
    clientId: client.id,
    jti,
    scopesGranted: envelope.scopesGranted,
    issuedAt: new Date(envelope.issuedAtMs).toISOString(),
    expiresAt: new Date(envelope.expiresAtMs).toISOString(),
    tokenKeyFingerprint,
    ipAtIssue: request.ip ?? null,
  });
  return {
    ok: true,
    grant: {
      body: {
        access_token: jti,
        token_type: "bearer",
        expires_in: Math.floor((envelope.expiresAtMs - envelope.issuedAtMs) / 1000),
        scope: envelope.scopesGranted.join(" "),
      },
      clientId: client.id,
      organizationId: client.organizationId,
    },
  };
}
