// @chartwarden/fhir — `fhir_client_session` mint + bearer-verification decision (§2.2 / §2.4, M28-T03).
//
// Once EITHER auth path succeeds (`backend-services.ts` client-assertion or `api-key.ts`), the token
// route (M28-T08) mints a bearer session: a 15-minute `fhir_client_session` row keyed by the `jti`. The
// bearer TOKEN itself is never stored — only the `jti`, the granted scopes, and (per §2.2) a key-fingerprint
// hash; the verification middleware looks the `jti` up, checks `expires_at` + `revoked_at IS NULL`, and
// bumps `last_used_at`. This module is the PURE decision core for BOTH ends — the mint envelope and the
// per-request verification verdict — IO-free, with `nowMs` INJECTED (never a clock).
//
// Two invariants it encodes that a bare row cannot:
//   1. The granted scopes are the intersection-by-subset of what the client REQUESTED and what its
//      `allowed_scopes[]` hold; a request for a broader scope is `400 invalid_scope` (§2.3), NOT a
//      silently-narrowed grant — the caller must learn its config is wrong.
//   2. A session is servable ONLY while unexpired AND unrevoked; a revocation cascade (§2.4) stamps
//      `revoked_at` on every live session the instant its client is suspended/revoked, so a still-in-TTL
//      bearer stops working immediately — expiry alone is not the whole gate.
import {
  FHIR_SESSION_TTL_MINUTES,
  type FhirClientId,
  type FhirClientSessionJti,
} from "@chartwarden/types";

import { scopesExceedingGrant } from "./scopes";

/** §2.2 — the 15-minute session TTL as milliseconds (the leaf constant is in minutes). */
export const FHIR_SESSION_TTL_MS = FHIR_SESSION_TTL_MINUTES * 60 * 1000;

/** The scope-resolution outcome at mint: either the exact granted set, or the deviating scopes to name in
 *  the `400 invalid_scope` OAuth error (§2.3). Returned as a list so the error enumerates what was refused. */
export type FhirScopeGrantResult =
  | { readonly ok: true; readonly granted: readonly string[] }
  | { readonly ok: false; readonly invalidScopes: readonly string[] };

/**
 * §2.3 — resolve the scopes to grant a session. The client's `requested` set must be a SUBSET of its
 * registered `allowed`; any scope beyond the grant fails the whole mint with `invalid_scope` (a token is
 * not silently down-scoped — the partner's client config is wrong and must be told). An empty request is
 * legal and grants nothing (a token that can read nothing is useless but not an error).
 */
export function resolveGrantedScopes(
  requested: readonly string[],
  allowed: readonly string[],
): FhirScopeGrantResult {
  const invalidScopes = scopesExceedingGrant(requested, allowed);
  if (invalidScopes.length > 0) return { ok: false, invalidScopes };
  return { ok: true, granted: [...requested] };
}

/** The mint inputs the route supplies after auth succeeds. `jti` comes from the verified client-assertion
 *  (Backend Services) or is route-generated (api-key); `issuedAtMs` is the injected mint clock. */
export interface FhirSessionMintInput {
  readonly clientId: FhirClientId;
  readonly jti: FhirClientSessionJti;
  readonly scopesGranted: readonly string[];
  readonly issuedAtMs: number;
}

/** The persisted `fhir_client_session` shape this module reasons about (the columns that gate a read). */
export interface FhirSessionEnvelope {
  readonly clientId: FhirClientId;
  readonly jti: FhirClientSessionJti;
  readonly scopesGranted: readonly string[];
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
}

/**
 * Build the `fhir_client_session` row's temporal fields: `expires_at = issued_at + 15min` (§2.2). The
 * expiry is server-derived from the mint clock, never client-influenced — the client cannot ask for a
 * longer-lived bearer. The route persists this alongside the `jti` and the signing-key fingerprint hash.
 */
export function buildSessionMint(input: FhirSessionMintInput): FhirSessionEnvelope {
  return {
    clientId: input.clientId,
    jti: input.jti,
    scopesGranted: [...input.scopesGranted],
    issuedAtMs: input.issuedAtMs,
    expiresAtMs: input.issuedAtMs + FHIR_SESSION_TTL_MS,
  };
}

/** Why a presented bearer session is not servable. The verification middleware maps both to `401`; they
 *  are distinct so the audit trail (and a partner's debugging) can tell "your token aged out" from "your
 *  client was revoked mid-session". */
export type FhirSessionRejectionReason =
  | "SESSION_EXPIRED" // past the 15-minute TTL
  | "SESSION_REVOKED"; // revoked_at stamped by the §2.4 client-revocation cascade

/** The per-request verdict: `ok:true` carries the granted scopes the mapper then scope-checks per resource. */
export type FhirSessionVerifyResult =
  | {
      readonly ok: true;
      readonly clientId: FhirClientId;
      readonly scopesGranted: readonly string[];
    }
  | { readonly ok: false; readonly reason: FhirSessionRejectionReason };

/**
 * §2.4 — decide whether a looked-up session may serve the current request. The middleware has already
 * matched the bearer's `jti` to this row; this applies the two remaining gates: not expired (against the
 * injected `nowMs`) and not revoked. `revokedAtMs` is the `fhir_client_session.revoked_at` (undefined/null
 * ⇒ live) — a revocation stamped even one millisecond before `nowMs` refuses the read, so a still-in-TTL
 * bearer stops the instant its client is cut off.
 */
export function verifySession(
  session: FhirSessionEnvelope,
  nowMs: number,
  revokedAtMs?: number | null,
): FhirSessionVerifyResult {
  if (typeof revokedAtMs === "number" && revokedAtMs <= nowMs) {
    return { ok: false, reason: "SESSION_REVOKED" };
  }
  if (nowMs >= session.expiresAtMs) {
    return { ok: false, reason: "SESSION_EXPIRED" };
  }
  return { ok: true, clientId: session.clientId, scopesGranted: [...session.scopesGranted] };
}
