// apps/backend/src/modules/19-oncall/routes/concurrency.ts — M19-T07 (§2.5, §4.1.1, ADR-0021).
//
// Three route-boundary concerns that are policy, not per-route detail (the M16/M21 routes/concurrency.ts
// precedent):
//
//   • §2.5 OPTIMISTIC CONCURRENCY — a state-transition route carries the row `version` it read in
//     `If-Match`; a mismatch is 412 `STALE_VERSION`. §2.5's own case is the ordinary one: a supervisor is
//     reading the call while the RN answers question 4, and without the stamp the supervisor's disposition
//     silently overwrites two answers. M19's rows carry an INTEGER `version` column (unlike M21's, which
//     had only `updated_at`), so the ETag is that integer and the comparison is numeric — which also means
//     a caller cannot fabricate a passing stamp from a timestamp they guessed.
//   • §4.1.1 CURSOR PAGINATION — offset pagination is FORBIDDEN on PHI list routes (ADR-0021 §6):
//     `?offset=` is rejected 400 `OFFSET_PAGINATION_FORBIDDEN`. The cursor is an opaque, HMAC-SIGNED
//     base64url of the `(anchor, id)` keyset pair. §4.1.1 is explicit that the signature is required and
//     that a tampered cursor is 422 `INVALID_CURSOR` — M21's cursors were unsigned, and the difference
//     matters here because a forged cursor on `GET /triage-calls` is an attempt to page past the RLS-scoped
//     window into another anchor, i.e. the enumeration §8.3.4 lists.
//   • ADR-0021 IDEMPOTENCY — every mutating route requires a client-supplied `Idempotency-Key`. This is the
//     HTTP-layer guard against a double-tapped button on a phone with one bar of signal; it is NOT the
//     §2.6 worker-side dedupe on `source_outbox_event_id`, which stays orthogonal.
//
// `total_count` IS NEVER EMITTED ON A PHI LIST. §4.1.1 says so, and the reason is that a count is an
// enumeration oracle: a caller who cannot read another PE's calls can still learn how many there were.
// {@link toCursorPage} has no field for it, which is the compile-time half of that rule.
import { createHmac, timingSafeEqual } from "node:crypto";
import { ChartWardenError } from "@chartwarden/types";
import type { PreHandler } from "./actor";

/** ADR-0021 — every mutating route requires a client-supplied Idempotency-Key (1–128 chars). */
export function requireIdempotencyKey(): PreHandler {
  return async (request) => {
    const raw = request.headers["idempotency-key"];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value !== "string" || value.length < 1 || value.length > 128) {
      throw new ChartWardenError(
        "IDEMPOTENCY_KEY_REQUIRED",
        "an Idempotency-Key header is required",
        400,
      );
    }
  };
}

/** §4.1.1 — refuse `?offset=` on a PHI list route (offset pagination is forbidden). */
export function rejectOffsetPagination(): PreHandler {
  return async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    if (query.offset !== undefined) {
      throw new ChartWardenError(
        "OFFSET_PAGINATION_FORBIDDEN",
        "offset pagination is not supported on PHI list routes; use ?cursor=",
        400,
      );
    }
  };
}

/**
 * §2.5 — parse `If-Match` into the row `version` the caller read.
 *
 * `required` (every state transition) refuses an absent or non-numeric header with 428 rather than letting
 * a blind write through. A weak-ETag prefix (`W/"3"`) and quotes are tolerated because HTTP caches and
 * browser `fetch` add them; anything that is not an integer after that is refused rather than coerced —
 * `Number("")` is 0, and version 0 does not exist, so a coercion would turn an empty header into a stamp
 * that fails loudly instead of one that is refused clearly.
 */
export function ifMatchVersion(
  request: { headers: Record<string, unknown> },
  required = false,
): number | undefined {
  const raw = request.headers["if-match"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const cleaned =
    typeof value === "string" ? value.replace(/^W\//, "").replace(/"/g, "").trim() : "";
  const parsed = /^\d+$/.test(cleaned) ? Number(cleaned) : undefined;
  if (parsed === undefined && required) {
    throw new ChartWardenError(
      "IF_MATCH_REQUIRED",
      "this route requires an If-Match header carrying the row version you read (§2.5)",
      428,
    );
  }
  return parsed;
}

/** The per-route page-size policy (default + hard max), applied to `?limit=`. */
export interface PageSizePolicy {
  readonly defaultSize: number;
  readonly maxSize: number;
}

/** §4.1.1's table, verbatim. */
export const M19_PAGE_SIZES = {
  triageCalls: { defaultSize: 25, maxSize: 100 },
  escalations: { defaultSize: 25, maxSize: 100 },
  shifts: { defaultSize: 50, maxSize: 200 },
  protocols: { defaultSize: 50, maxSize: 200 },
  portalRecent: { defaultSize: 10, maxSize: 30 },
} as const satisfies Record<string, PageSizePolicy>;

/** Clamp a `limit` query param into `[1, maxSize]`, defaulting to the route's declared page size. */
export function clampLimit(raw: unknown, policy: PageSizePolicy): number {
  const n = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : Number.NaN;
  if (!Number.isFinite(n)) return policy.defaultSize;
  return Math.min(policy.maxSize, Math.max(1, Math.floor(n)));
}

/** The keyset anchor a cursor encodes: the sort column's value plus the tie-breaking row id. */
export interface Cursor {
  /** The sort-column value as a string (an ISO instant, or a `YYYY-MM-DD` date). */
  readonly a: string;
  readonly id: string;
}

/**
 * The paginated response envelope. NO `total_count` field exists, deliberately (§4.1.1 / §8.3.4) — see the
 * module header.
 */
export interface CursorPage<T> {
  readonly data: T[];
  readonly next_cursor: string | null;
  readonly has_more: boolean;
}

/** Raised on a cursor whose signature does not verify, or whose body is not a cursor (§4.1.1). */
export class InvalidCursorError extends ChartWardenError {
  constructor() {
    super("INVALID_CURSOR", "the pagination cursor is invalid; start from the first page", 422);
    this.name = "InvalidCursorError";
  }
}

/**
 * The cursor signing key. §4.1.1 calls for the "org-scoped signing key (M1 pattern)"; the org id is mixed
 * into the HMAC input rather than into the key, which gives the same property (a cursor minted for org A
 * does not verify for org B) without needing a per-org key derivation the platform does not yet publish.
 *
 * With no configured secret the cursor is signed with a PROCESS-LOCAL random key, so cursors do not survive
 * a restart. That is the right failure: an unsigned cursor is a forgeable one, and a cursor that stops
 * working after a deploy costs a caller one re-page.
 */
const CURSOR_SECRET: string =
  process.env.M19_CURSOR_SIGNING_KEY ??
  process.env.CURSOR_SIGNING_KEY ??
  `m19-ephemeral-${process.pid}-${Math.random().toString(36).slice(2)}`;

function sign(orgId: string, body: string): string {
  return createHmac("sha256", CURSOR_SECRET).update(`${orgId}.${body}`).digest("base64url");
}

/** Encode + sign an opaque cursor. Clients must not parse or construct one (§4.1.1). */
export function encodeCursor(orgId: string, c: Cursor): string {
  const body = Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
  return `${body}.${sign(orgId, body)}`;
}

/**
 * Decode + VERIFY an opaque cursor. Absent ⇒ `null` (start from the beginning); present-but-invalid ⇒
 * {@link InvalidCursorError}.
 *
 * A malformed cursor THROWS rather than being treated as "start from the beginning" (M21's posture). The
 * two modules differ because M21's cursor was unsigned, so "malformed" only ever meant a client bug; here
 * a signature that does not verify is an attempted forgery, and silently serving page 1 to a forger tells
 * them the attempt was indistinguishable from success.
 */
export function decodeCursor(orgId: string, raw: string | undefined | null): Cursor | null {
  if (!raw) return null;
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) throw new InvalidCursorError();
  const body = raw.slice(0, dot);
  const provided = Buffer.from(raw.slice(dot + 1), "utf8");
  const expected = Buffer.from(sign(orgId, body), "utf8");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new InvalidCursorError();
  }
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Cursor;
    if (typeof parsed?.a !== "string" || typeof parsed?.id !== "string") {
      throw new InvalidCursorError();
    }
    return parsed;
  } catch {
    throw new InvalidCursorError();
  }
}

/** Slice a `limit + 1` row set into the page envelope (the anchor is extracted per route). */
export function toCursorPage<R, T>(
  orgId: string,
  rows: readonly R[],
  limit: number,
  anchorOf: (row: R) => Cursor,
  map: (row: R) => T,
): CursorPage<T> {
  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;
  const last = slice[slice.length - 1];
  return {
    data: slice.map(map),
    next_cursor: hasMore && last !== undefined ? encodeCursor(orgId, anchorOf(last)) : null,
    has_more: hasMore,
  };
}
