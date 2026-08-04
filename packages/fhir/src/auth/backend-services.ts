// @wardenx/fhir — SMART-on-FHIR Backend Services client-assertion verification (§2.2/D2, M28-T03).
//
// Phase 1 authenticates system-to-system FHIR clients two ways (D2); this file is the FIRST — the
// SMART Backend Services asymmetric flow (RFC 7523 / SMART "Backend Services" profile). A registered
// `fhir_client` mints a short-lived `client_assertion` JWT signed with ITS private key (the public half
// is at its registered `jwks_uri`), POSTs it to `/fhir/oauth2/token`, and M28 mints a bearer session
// (`session.ts`) once THIS verification passes. The api-key alternative is `api-key.ts`.
//
// PURE crypto core, IO-free (the M13 witness-token / M12 webhook-verify precedent): the route (M28-T08)
// fetches + caches the client's JWKS, reads `nowMs` off the clock, dedups the `jti` against Valkey, then
// hands this function the token string, the registered `client_id`, this gateway's token-endpoint URL
// (the required `aud`), the resolved JWK set, and `nowMs`. Nothing here touches the network or a clock,
// so every boundary (expiry, lifetime ceiling, audience, iss/sub binding, signature) is unit-testable.
//
// The SMART Backend Services assertion constraints this enforces, in order:
//   - `alg = RS384` in the header — the ONLY algorithm SMART Backend Services mandates for asymmetric
//     auth; anything else (incl. `none`, HS*, RS256) is refused so a client cannot downgrade.
//   - `iss = sub = <registered client_id>` — the assertion is self-issued by the client it names; a
//     mismatch is an attempt to authenticate AS a different client.
//   - `aud = <this token endpoint>` — the assertion is bound to THIS gateway; an assertion minted for a
//     partner's endpoint cannot be replayed against ours (audience confusion).
//   - `exp` in the future AND the assertion lifetime (`exp - nowMs`) within the 5-minute ceiling — a
//     long-lived assertion is a stealable bearer credential; SMART caps it tight.
//   - `jti` present — the replay-dedup identity the route burns in Valkey; absent ⇒ un-dedupable.
//   - the RS384 signature verifies against the JWK whose `kid` the header names (or, if the header omits
//     `kid`, any RSA JWK in the set) — the client actually holds the private key.
import { createPublicKey, createVerify } from "node:crypto";

import type { FhirClientId } from "@wardenx/types";

/**
 * SMART Backend Services mandates RS384 for asymmetric client authentication. Pinned as the sole accepted
 * `alg`; a token declaring anything else is refused before any signature work (algorithm-confusion / `alg:none`
 * defense). The value is the JOSE `alg`; {@link RS384_NODE_ALGORITHM} is its `node:crypto` spelling.
 */
export const FHIR_ASSERTION_ALG = "RS384" as const;

/** The `node:crypto` verifier name for RS384 (RSASSA-PKCS1-v1_5 over SHA-384). */
const RS384_NODE_ALGORITHM = "RSA-SHA384";

/**
 * §D2 — the maximum lifetime of a `client_assertion` (5 minutes). Even a validly-signed assertion is
 * rejected if `exp` is further than this from `nowMs`: the assertion is a bearer credential in flight, so
 * a short window bounds the damage of one being captured. SMART Backend Services recommends ≤ 5 minutes.
 */
export const FHIR_ASSERTION_MAX_LIFETIME_MS = 5 * 60 * 1000;

/**
 * A small tolerance (30s) for `exp` being marginally in the past relative to `nowMs`, absorbing clock skew
 * between the client's signer and this gateway. Applied ONLY to the expiry check, never to the lifetime
 * ceiling (a client cannot buy a longer-lived token by being skewed).
 */
export const FHIR_ASSERTION_CLOCK_SKEW_MS = 30 * 1000;

/** RFC 7523 — the `client_assertion_type` the token request must carry for this flow. */
export const FHIR_JWT_BEARER_ASSERTION_TYPE =
  "urn:ietf:params:oauth:client-assertion-type:jwt-bearer" as const;

/** A JWK as it appears in a client's published JWKS (the RSA public-key fields are what we use). */
export interface FhirJwk {
  readonly kty?: string;
  readonly kid?: string;
  readonly use?: string;
  readonly alg?: string;
  readonly n?: string;
  readonly e?: string;
  readonly [field: string]: unknown;
}

/** The verified assertion claims the route needs: the `jti` to burn for replay-dedup, the confirmed
 *  client id, and the assertion's own expiry (so the route can cache the dedup marker exactly that long). */
export interface FhirAssertionClaims {
  readonly clientId: FhirClientId;
  readonly jti: string;
  readonly expiresAtMs: number;
}

/** Why a `client_assertion` was refused. The route (M28-T08) maps every one to `400 invalid_client` /
 *  `401` per the OAuth error model; they are distinct here so the audit trail records exactly what failed. */
export type FhirAssertionRejectionReason =
  | "MALFORMED_ASSERTION" // not three base64url segments / not JSON / missing required claim
  | "UNSUPPORTED_ALG" // header `alg` ≠ RS384 (incl. `none`)
  | "ISS_SUB_MISMATCH" // iss ≠ sub, or ≠ the registered client_id
  | "AUDIENCE_MISMATCH" // aud ≠ this token endpoint
  | "ASSERTION_EXPIRED" // exp is in the past (beyond skew)
  | "ASSERTION_LIFETIME_TOO_LONG" // exp − nowMs exceeds the 5-minute ceiling
  | "MISSING_JTI" // no jti ⇒ un-dedupable ⇒ replayable
  | "NO_MATCHING_JWK" // the header `kid` names no RSA key in the resolved set
  | "SIGNATURE_INVALID"; // RS384 verification failed

/** The verifier verdict: `ok:true` carries the claims the route acts on; `ok:false` the rejection reason. */
export type FhirAssertionVerifyResult =
  | { readonly ok: true; readonly claims: FhirAssertionClaims }
  | { readonly ok: false; readonly reason: FhirAssertionRejectionReason };

/** What the route hands the verifier — everything resolved off the request + the registered client. */
export interface FhirAssertionVerifyInput {
  /** The raw `client_assertion` JWT (`header.payload.signature`, each base64url). */
  readonly assertion: string;
  /** The `fhir_client.id` the request presented (`client_id` form field); iss/sub must equal it. */
  readonly expectedClientId: FhirClientId;
  /** This gateway's token-endpoint absolute URL; the assertion's `aud` must equal it. */
  readonly expectedAudience: string;
  /** The RSA JWKs fetched (and cached) from the client's `jwks_uri`. */
  readonly jwks: readonly FhirJwk[];
  /** The verification clock (ms epoch) — INJECTED, never read here (purity / testability). */
  readonly nowMs: number;
  /** Override the 5-minute lifetime ceiling (tests only); defaults to {@link FHIR_ASSERTION_MAX_LIFETIME_MS}. */
  readonly maxLifetimeMs?: number;
}

interface DecodedAssertion {
  readonly header: Record<string, unknown>;
  readonly payload: Record<string, unknown>;
  /** The exact `header.payload` bytes the signature covers — re-serializing would break verification. */
  readonly signingInput: string;
  readonly signature: Buffer;
}

/** Split + base64url-decode the JWT into header/payload/signature. Returns null on any structural fault. */
function decodeAssertion(assertion: string): DecodedAssertion | null {
  const parts = assertion.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts;
  if (!headerB64 || !payloadB64 || !signatureB64) return null;
  try {
    const header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8")) as unknown;
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as unknown;
    if (!isRecord(header) || !isRecord(payload)) return null;
    return {
      header,
      payload,
      signingInput: `${headerB64}.${payloadB64}`,
      signature: Buffer.from(signatureB64, "base64url"),
    };
  } catch {
    return null;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Pick the JWK to verify against: by `kid` if the header names one, else the first RSA key in the set. */
function selectJwk(jwks: readonly FhirJwk[], kid: unknown): FhirJwk | null {
  const rsaKeys = jwks.filter(
    (k) => k.kty === "RSA" && typeof k.n === "string" && typeof k.e === "string",
  );
  if (typeof kid === "string" && kid.length > 0) {
    return rsaKeys.find((k) => k.kid === kid) ?? null;
  }
  return rsaKeys[0] ?? null;
}

/**
 * §D2 — verify a SMART Backend Services `client_assertion`. Fails CLOSED: any structural fault, claim
 * mismatch, expiry, or signature failure returns a typed rejection; only a fully-valid assertion returns
 * `ok:true`. The route still owns the two stateful obligations this pure core cannot: fetching/caching the
 * JWKS, and burning the returned `jti` in Valkey to defeat replay within the assertion's lifetime.
 */
export function verifyClientAssertion(input: FhirAssertionVerifyInput): FhirAssertionVerifyResult {
  const maxLifetimeMs = input.maxLifetimeMs ?? FHIR_ASSERTION_MAX_LIFETIME_MS;

  const decoded = decodeAssertion(input.assertion);
  if (!decoded) return { ok: false, reason: "MALFORMED_ASSERTION" };

  // Header: RS384 only.
  if (decoded.header.alg !== FHIR_ASSERTION_ALG) return { ok: false, reason: "UNSUPPORTED_ALG" };

  const { iss, sub, aud, exp, jti } = decoded.payload;

  // iss = sub = the registered client_id.
  if (
    typeof iss !== "string" ||
    typeof sub !== "string" ||
    iss !== sub ||
    iss !== input.expectedClientId
  ) {
    return { ok: false, reason: "ISS_SUB_MISMATCH" };
  }

  // aud = this token endpoint. `aud` may be a string or an array per JWT; accept either shape.
  const audMatches =
    aud === input.expectedAudience || (Array.isArray(aud) && aud.includes(input.expectedAudience));
  if (!audMatches) return { ok: false, reason: "AUDIENCE_MISMATCH" };

  // exp present + not expired (with skew) + within the lifetime ceiling.
  if (typeof exp !== "number" || !Number.isFinite(exp)) {
    return { ok: false, reason: "MALFORMED_ASSERTION" };
  }
  const expiresAtMs = exp * 1000; // JWT `exp` is seconds since epoch.
  if (expiresAtMs <= input.nowMs - FHIR_ASSERTION_CLOCK_SKEW_MS) {
    return { ok: false, reason: "ASSERTION_EXPIRED" };
  }
  if (expiresAtMs - input.nowMs > maxLifetimeMs) {
    return { ok: false, reason: "ASSERTION_LIFETIME_TOO_LONG" };
  }

  // jti present (replay-dedup identity).
  if (typeof jti !== "string" || jti.length === 0) return { ok: false, reason: "MISSING_JTI" };

  // Signature: RS384 against the client's registered public key.
  const jwk = selectJwk(input.jwks, decoded.header.kid);
  if (!jwk) return { ok: false, reason: "NO_MATCHING_JWK" };

  let verified: boolean;
  try {
    const publicKey = createPublicKey({ key: jwk as Record<string, unknown>, format: "jwk" });
    verified = createVerify(RS384_NODE_ALGORITHM)
      .update(decoded.signingInput)
      .verify(publicKey, decoded.signature);
  } catch {
    // A structurally-broken JWK (bad n/e) is not a "no matching key" — it's a signature that cannot verify.
    return { ok: false, reason: "SIGNATURE_INVALID" };
  }
  if (!verified) return { ok: false, reason: "SIGNATURE_INVALID" };

  return { ok: true, claims: { clientId: input.expectedClientId, jti, expiresAtMs } };
}
