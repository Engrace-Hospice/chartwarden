// @wardenx/emar — §7.4 witness-attestation token security (M13-T04). PURE crypto core, IO-free.
//
// The witness-attestation token is the linchpin of the §2.6 D7 double-witness rule. The witness clinician
// mints it on a SEPARATE device via `POST /administrations/witness-attest`; the administering clinician
// carries it in the `X-Witness-Attestation` header on the administration write; the server verifies it,
// resolves the witness membership, and burns it. This module is the PURE crypto core the route (M13-T08)
// calls — it never touches Valkey or the DB. The §7.4 security properties, all enforced here except the
// single-use burn (which is the Valkey entry the route deletes on consumption):
//   - HMAC-signed (SHA-256) with the tenant-scoped session-token secret — tampering invalidates.
//   - Scope-bound to `(patientId, medicationOrderId, administeringMembershipId)` — a token for patient A's
//     morphine cannot be used for patient B's, nor for patient A's lorazepam.
//   - Short TTL (60s) — checked against an INJECTED `nowMs` (never a clock), so the boundary is testable.
//   - Audit digest — `witnessTokenDigest` is SHA-256 of the burned token, stored on `administration_witness`
//     (`attestation_token_digest`); survey-defensible that THIS token was minted and consumed in one tx.
// Mirrors the M12 `verifyWebhookEnvelope` precedent (HMAC + constant-time compare + injected `nowMs`).
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { AdministrationStateError } from "../lifecycle/errors";

/** §7.4 — the witness-attestation token TTL (60 seconds). */
export const WITNESS_TOKEN_TTL_MS = 60 * 1000;

/** §7.4 — the scope a token is bound to. A token minted for one scope cannot be consumed for another. */
export interface WitnessTokenScope {
  readonly patientId: string;
  readonly medicationOrderId: string;
  readonly administeringClinicianMembershipId: string;
}

/** §7.4 — the signed claims inside a witness-attestation token. */
export interface WitnessTokenClaims extends WitnessTokenScope {
  /** The witness's M3 membership id (the identity the route resolves + eligibility-checks). */
  readonly witnessMembershipId: string;
  /** The mint time (ms epoch); the TTL is measured from here. INJECTED — never read from a clock here. */
  readonly issuedAtMs: number;
  /** A per-mint random nonce (the route supplies it) so two tokens for the same scope differ. */
  readonly nonce: string;
}

/** §7.4 — the rejection reasons, mapped to the M13 error catalog (all 401) by {@link assertWitnessToken}. */
export type WitnessTokenRejectionReason =
  | "WITNESS_TOKEN_INVALID" // malformed or HMAC mismatch
  | "WITNESS_TOKEN_EXPIRED" // past the 60s TTL (or issued in the future beyond skew)
  | "WITNESS_TOKEN_SCOPE_MISMATCH"; // claims scope ≠ the administration's scope

/** A verified token: the resolved claims the route uses (witness identity + the audit digest). */
export type WitnessTokenVerifyResult =
  | { readonly ok: true; readonly claims: WitnessTokenClaims; readonly digest: string }
  | { readonly ok: false; readonly reason: WitnessTokenRejectionReason };

/** Canonical claims serialization — stable key order so the signature is reproducible. */
function canonicalClaims(c: WitnessTokenClaims): string {
  return JSON.stringify([
    c.patientId,
    c.medicationOrderId,
    c.administeringClinicianMembershipId,
    c.witnessMembershipId,
    c.issuedAtMs,
    c.nonce,
  ]);
}

/** §7.4 — HMAC-SHA256 (hex) of the canonical claims with the tenant-scoped session-token secret. */
export function computeWitnessTokenSignature(claims: WitnessTokenClaims, secret: string): string {
  return createHmac("sha256", secret).update(canonicalClaims(claims), "utf8").digest("hex");
}

/**
 * §7.4 — mint a witness-attestation token: `base64url(canonicalClaims).hexHMAC`. The route persists the
 * single-use marker in Valkey (keyed by the token) with the 60s TTL; this function only produces the signed
 * string. The caller supplies `issuedAtMs` + `nonce` (no clock/RNG here — purity).
 */
export function buildWitnessAttestationToken(claims: WitnessTokenClaims, secret: string): string {
  const body = Buffer.from(canonicalClaims(claims), "utf8").toString("base64url");
  return `${body}.${computeWitnessTokenSignature(claims, secret)}`;
}

/** §7.4 — SHA-256 (hex) of the burned token, stored as `administration_witness.attestation_token_digest`. */
export function witnessTokenDigest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Constant-time hex-digest comparison (the M12 `signaturesMatch` precedent). */
function signaturesMatch(expectedHex: string, providedHex: string): boolean {
  if (expectedHex.length !== providedHex.length) return false;
  const expected = Buffer.from(expectedHex, "hex");
  const provided = Buffer.from(providedHex, "hex");
  if (expected.length !== provided.length || expected.length === 0) return false;
  return timingSafeEqual(expected, provided);
}

/** Parse + structurally validate the claims body; returns null on any malformation. */
function parseClaims(body: string): WitnessTokenClaims | null {
  let decoded: string;
  try {
    decoded = Buffer.from(body, "base64url").toString("utf8");
  } catch {
    return null;
  }
  let arr: unknown;
  try {
    arr = JSON.parse(decoded);
  } catch {
    return null;
  }
  if (!Array.isArray(arr) || arr.length !== 6) return null;
  const [
    patientId,
    medicationOrderId,
    administeringClinicianMembershipId,
    witnessMembershipId,
    issuedAtMs,
    nonce,
  ] = arr;
  if (
    typeof patientId !== "string" ||
    typeof medicationOrderId !== "string" ||
    typeof administeringClinicianMembershipId !== "string" ||
    typeof witnessMembershipId !== "string" ||
    typeof issuedAtMs !== "number" ||
    !Number.isFinite(issuedAtMs) ||
    typeof nonce !== "string"
  ) {
    return null;
  }
  return {
    patientId,
    medicationOrderId,
    administeringClinicianMembershipId,
    witnessMembershipId,
    issuedAtMs,
    nonce,
  };
}

/** The inputs the route hands the verifier: the raw token, the tenant secret, the administration scope, and
 * the injected `nowMs`. The single-use burn is the route's Valkey delete — checked separately. */
export interface WitnessTokenVerifyInput {
  readonly token: string;
  readonly secret: string;
  readonly expectedScope: WitnessTokenScope;
  readonly nowMs: number;
  readonly ttlMs?: number;
}

/**
 * §7.4 — verify a witness-attestation token. The order is: structural parse → HMAC (constant-time) → TTL →
 * scope. Returns the resolved claims + the audit digest on success; the first failing reason otherwise. PURE
 * — `nowMs` is injected; no clock, no IO. The route still must burn the single-use Valkey entry (a replay
 * passes HMAC/TTL/scope but finds no entry — the route rejects it there, not here).
 */
export function verifyWitnessAttestationToken(
  input: WitnessTokenVerifyInput,
): WitnessTokenVerifyResult {
  const dot = input.token.indexOf(".");
  if (dot <= 0 || dot === input.token.length - 1) {
    return { ok: false, reason: "WITNESS_TOKEN_INVALID" };
  }
  const body = input.token.slice(0, dot);
  const providedSig = input.token.slice(dot + 1);

  const claims = parseClaims(body);
  if (claims === null) return { ok: false, reason: "WITNESS_TOKEN_INVALID" };

  // HMAC — recompute over the parsed claims and constant-time compare (tamper → invalid).
  const expectedSig = computeWitnessTokenSignature(claims, input.secret);
  if (!signaturesMatch(expectedSig, providedSig)) {
    return { ok: false, reason: "WITNESS_TOKEN_INVALID" };
  }

  // TTL — within [issuedAt, issuedAt + 60s]. A future issued-at beyond the window is also expired/invalid.
  const ttl = input.ttlMs ?? WITNESS_TOKEN_TTL_MS;
  const age = input.nowMs - claims.issuedAtMs;
  if (age < 0 || age > ttl) {
    return { ok: false, reason: "WITNESS_TOKEN_EXPIRED" };
  }

  // Scope — the claims must bind to THIS administration's (patient, order, administering clinician).
  if (
    claims.patientId !== input.expectedScope.patientId ||
    claims.medicationOrderId !== input.expectedScope.medicationOrderId ||
    claims.administeringClinicianMembershipId !==
      input.expectedScope.administeringClinicianMembershipId
  ) {
    return { ok: false, reason: "WITNESS_TOKEN_SCOPE_MISMATCH" };
  }

  return { ok: true, claims, digest: witnessTokenDigest(input.token) };
}

/**
 * Server-side throwing wrapper: runs {@link verifyWitnessAttestationToken} and throws
 * `AdministrationStateError` (HTTP 401) with the precise rejection code on failure, else returns the
 * verified claims + audit digest. The route still burns the single-use Valkey entry after this returns.
 */
export function assertWitnessToken(input: WitnessTokenVerifyInput): {
  readonly claims: WitnessTokenClaims;
  readonly digest: string;
} {
  const r = verifyWitnessAttestationToken(input);
  if (!r.ok) {
    throw new AdministrationStateError(r.reason, `witness-attestation token rejected: ${r.reason}`);
  }
  return { claims: r.claims, digest: r.digest };
}
