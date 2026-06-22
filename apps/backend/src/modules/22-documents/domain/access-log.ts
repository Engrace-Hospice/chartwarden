// apps/backend/src/modules/22-documents/domain/access-log.ts — M22-T03 (§2.4, §2.6, §7.9, §7.10 D11).
//
// The PURE signed-URL TTL + access-log policy. Every metadata read / content download / signed-URL issuance +
// consumption / portal view / disclosure export appends one `document_access_log` row feeding M4's
// accounting-of-disclosures surface (HIPAA §164.528, §2.4). The numeric / window math lives here, clock-free —
// the service layer (M22-T07) supplies `now` and persists the row.
import type { DocumentAccessKind } from "@wardenx/types";
import type { DocumentSideEffect } from "./effects";
import { require_ } from "./errors";

/** §7.10 D11 — the signed-URL TTL ceilings: 5 min for non-portal direct streams, 60 min for portal access. */
export const SIGNED_URL_MAX_TTL_SECONDS = { nonPortal: 5 * 60, portal: 60 * 60 } as const;

/** §2.6 — the idempotency window (s): repeat requests inside it for the same (version, requester) reuse the URL. */
export const SIGNED_URL_IDEMPOTENCY_WINDOW_SECONDS = 5;

/**
 * §7.10 D11 — clamp a requested signed-URL TTL to `min(requested, ceiling)` where the ceiling is 5 min for a
 * non-portal direct stream and 60 min for portal access. A non-positive request is refused (a URL must live for
 * at least one second). Pure; the service layer applies the result to the presign call.
 */
export function clampSignedUrlTtlSeconds(requestedSeconds: number, isPortal: boolean): number {
  require_(
    Number.isFinite(requestedSeconds) && requestedSeconds >= 1,
    "DOCUMENT_SIGNED_URL_TTL_INVALID",
    "A signed-URL TTL must be a finite number of seconds ≥ 1.",
  );
  const ceiling = isPortal ? SIGNED_URL_MAX_TTL_SECONDS.portal : SIGNED_URL_MAX_TTL_SECONDS.nonPortal;
  return Math.min(Math.floor(requestedSeconds), ceiling);
}

/**
 * §2.6 — is a fresh signed-URL request a no-op reuse of a prior one? True when the prior request for the same
 * `(documentVersionId, requesterMembershipId)` landed within the 5-second window. Pure: both instants are epoch
 * milliseconds supplied by the service layer. After the window, a new URL is minted + audited separately.
 */
export function isWithinSignedUrlIdempotencyWindow(priorIssuedAtMs: number, nowMs: number): boolean {
  return nowMs - priorIssuedAtMs >= 0 && nowMs - priorIssuedAtMs <= SIGNED_URL_IDEMPOTENCY_WINDOW_SECONDS * 1000;
}

/**
 * §2.4 / §7.9 — declare the §164.528 read-audit effects for a document access. Every access writes the
 * `document_access_log` row AND the M4 write-audit row (the access log is itself audited). A signed-URL
 * issuance also publishes `m22.signed_url.issued`; a consumption publishes `m22.signed_url.consumed`
 * (§4.10 / §2.4 disclosure stream). Pure: the caller commits the effects in one tx.
 */
export function accessLogEffects(accessKind: DocumentAccessKind): readonly DocumentSideEffect[] {
  const effects: DocumentSideEffect[] = [{ kind: "insert_access_log", accessKind }, { kind: "audit" }];
  if (accessKind === "signed_url_issued") effects.push({ kind: "outbox", event: "m22.signed_url.issued" });
  if (accessKind === "signed_url_consumed") effects.push({ kind: "outbox", event: "m22.signed_url.consumed" });
  return effects;
}
