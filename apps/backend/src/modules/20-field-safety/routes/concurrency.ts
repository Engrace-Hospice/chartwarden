// apps/backend/src/modules/20-field-safety/routes/concurrency.ts — M20-T06 (§2.5, §4.1, ADR-0021).
//
// Three route-boundary concerns that are policy, not per-route detail (the M16/M19/M21 precedent):
//
//   • §2.5 OPTIMISTIC CONCURRENCY — a state-transition route carries the row `version` it read in
//     `If-Match`. M20's `safety_sos_alert` and `safety_incident` both carry an INTEGER `version` column,
//     so the ETag is that integer and the comparison is numeric. §2.5 fixes the mismatch status at **409
//     `STALE_LIFECYCLE_STATE`**, not the 412 M15/M16/M19/M21 chose for their own codes — the wire contract
//     is the spec's, and it is already encoded in `../lifecycle/errors.ts`.
//   • §4.1 CURSOR PAGINATION — offset pagination is FORBIDDEN on PHI list routes (ADR-0021 §6): `?offset=`
//     is 400 `OFFSET_PAGINATION_FORBIDDEN`. The cursor is an opaque, HMAC-SIGNED base64url of the
//     `(anchor, id)` keyset pair, and a tampered one THROWS rather than serving page 1 (the M19 posture):
//     a signature that does not verify is an attempted forgery, and silently serving the first page tells
//     the forger the attempt was indistinguishable from success.
//   • ADR-0021 IDEMPOTENCY — every mutating route requires a client-supplied `Idempotency-Key`.
//
// ── THE ONE ROUTE THAT DOES **NOT** TAKE AN IDEMPOTENCY KEY ─────────────────────────────────────────
//
// `POST /api/v1/safety/sos` is the platform's single non-idempotent write (§2.6 / M20-F10), and §4.1's own
// Idempotent column says `no` for exactly that row. Every press is a separate call for help; collapsing
// two onto one alert IS the suppression S13 forbids. The mobile client's `localIdempotencyKey` (§4.2's
// `RaiseSosRequest`) is a D15 OFFLINE-SYNC key — it exists so a press captured in the device's SQLCipher
// outbox and replayed on reconnect is not recorded twice — and it is a BODY field the write service
// interprets, deliberately not an HTTP header this layer would enforce uniformly.
//
// `total_count` IS NEVER EMITTED ON A PHI LIST (ADR-0021 §6 / §8.3): a count is an enumeration oracle.
// {@link CursorPage} has no field for it, which is the compile-time half of that rule.
import { createHmac, timingSafeEqual } from "node:crypto";
import { ChartWardenError } from "@wardenx/types";
import type { PreHandler } from "./actor";

/** ADR-0021 — every mutating route except the SOS press requires an Idempotency-Key (1–128 chars). */
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

/** §4.1 — refuse `?offset=` on a PHI list route (offset pagination is forbidden). */
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
 * browser `fetch` add them; anything that is not an integer after that is refused rather than coerced.
 *
 * THE SOS CANCEL IS THE ONE TRANSITION THAT DOES NOT REQUIRE IT. The cancel is a five-second, one-tap act
 * on a phone the clinician may be palming under a table (§7.4); demanding that the client have read and
 * echoed a version number is a round-trip that does not fit inside D5's window, and the guard the cancel
 * actually needs — "are you the raiser, is the window open, did the biometric pass" — is stronger than a
 * version compare and runs in `cancelSos`.
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

/** The §4.1 list routes' page sizes. */
export const M20_PAGE_SIZES = {
  checkIns: { defaultSize: 25, maxSize: 100 },
  sosAlerts: { defaultSize: 25, maxSize: 100 },
  incidents: { defaultSize: 25, maxSize: 100 },
  locationStream: { defaultSize: 100, maxSize: 500 },
  subscriptions: { defaultSize: 50, maxSize: 200 },
  highRiskAreas: { defaultSize: 50, maxSize: 200 },
} as const satisfies Record<string, PageSizePolicy>;

/** Clamp a `limit` query param into `[1, maxSize]`, defaulting to the route's declared page size. */
export function clampLimit(raw: unknown, policy: PageSizePolicy): number {
  const n = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : Number.NaN;
  if (!Number.isFinite(n)) return policy.defaultSize;
  return Math.min(policy.maxSize, Math.max(1, Math.floor(n)));
}

/** The keyset anchor a cursor encodes: the sort column's value plus the tie-breaking row id. */
export interface Cursor {
  /** The sort-column value as a string (an ISO instant). */
  readonly a: string;
  readonly id: string;
}

/** The paginated response envelope. NO `total_count` field exists, deliberately — see the header. */
export interface CursorPage<T> {
  readonly data: T[];
  readonly next_cursor: string | null;
  readonly has_more: boolean;
}

/** Raised on a cursor whose signature does not verify, or whose body is not a cursor (§4.1). */
export class InvalidCursorError extends ChartWardenError {
  constructor() {
    super("INVALID_CURSOR", "the pagination cursor is invalid; start from the first page", 422);
    this.name = "InvalidCursorError";
  }
}

/**
 * The cursor signing key. The org id is mixed into the HMAC input rather than into the key, which gives
 * the same property (a cursor minted for org A does not verify for org B) without a per-org key
 * derivation the platform does not yet publish.
 *
 * With no configured secret the cursor is signed with a PROCESS-LOCAL random key, so cursors do not
 * survive a restart. That is the right failure: an unsigned cursor is a forgeable one, and a cursor that
 * stops working after a deploy costs a caller one re-page.
 */
const CURSOR_SECRET: string =
  process.env.M20_CURSOR_SIGNING_KEY ??
  process.env.CURSOR_SIGNING_KEY ??
  `m20-ephemeral-${process.pid}-${Math.random().toString(36).slice(2)}`;

function sign(orgId: string, body: string): string {
  return createHmac("sha256", CURSOR_SECRET).update(`${orgId}.${body}`).digest("base64url");
}

/** Encode + sign an opaque cursor. Clients must not parse or construct one (§4.1). */
export function encodeCursor(orgId: string, c: Cursor): string {
  const body = Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
  return `${body}.${sign(orgId, body)}`;
}

/** Decode + VERIFY an opaque cursor. Absent ⇒ `null`; present-but-invalid ⇒ {@link InvalidCursorError}. */
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
