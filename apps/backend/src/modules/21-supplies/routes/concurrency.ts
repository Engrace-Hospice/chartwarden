// apps/backend/src/modules/21-supplies/routes/concurrency.ts — M21-T05 (§7.2 / §7.3 / ADR-0021).
//
// Three route-boundary concerns that are policy, not per-route detail (the M16 routes/concurrency.ts
// precedent):
//
//   • §7.2 / §7.3 optimistic concurrency — a state-transition route carries the row `updated_at` it read
//     in `If-Match`; a mismatch is 412 `M21_STALE_VERSION` with the current state. §7.2's two-coordinator
//     race (both press "assign vendor" on the same request) and §7.3's two-reconciler race are the exact
//     failures this closes. A transition that omits `If-Match` is refused rather than silently
//     last-write-wins — for a controlled-substance count, "last write wins" means one of the two counts is
//     silently gone.
//   • cursor pagination — offset pagination is FORBIDDEN on PHI list routes (SD-052): `?offset=` is
//     rejected 400 `OFFSET_PAGINATION_FORBIDDEN`. The cursor is an opaque base64url of the `(anchor, id)`
//     keyset pair; clients must not decode or construct one.
//   • ADR-0021 idempotency — every mutating route requires a client-supplied `Idempotency-Key`. This is
//     the HTTP-layer guard against a duplicate client submission; it is NOT the §4.5.1 worker-side
//     state-check, which stays orthogonal (a redelivered outbox message and a double-clicked button are
//     different problems with different owners).
//
// WHY `If-Match` CARRIES A TIMESTAMP AND NOT A VERSION NUMBER. M21's tables have no `version` column —
// §3.1 gives every row `updated_at` and no integer counter (unlike M16's `bereavement_plan`). The ETag is
// therefore the row's `updated_at` in ISO form, and the comparison is exact-string. That is sound because
// every M21 write goes through the service layer, which sets `updated_at` from one clock per transaction;
// it would NOT be sound if a trigger could bump the column without the service seeing it, which is why
// migration 0106's triggers only compute discrepancy columns and never touch `updated_at`.
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

/** SD-052 — refuse `?offset=` on a PHI list route (offset pagination is forbidden). */
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
 * §7.2 / §7.3 — parse `If-Match` into the row `updated_at` the caller read. `required` (every state
 * transition) refuses an absent/garbled header with 428 rather than letting a blind write through.
 */
export function ifMatchStamp(
  request: { headers: Record<string, unknown> },
  required = false,
): string | undefined {
  const raw = request.headers["if-match"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const cleaned = typeof value === "string" ? value.replace(/"/g, "").trim() : "";
  const parsed = cleaned !== "" && !Number.isNaN(Date.parse(cleaned)) ? cleaned : undefined;
  if (parsed === undefined && required) {
    throw new ChartWardenError(
      "IF_MATCH_REQUIRED",
      "this route requires an If-Match header carrying the row updated_at you read (§7.2)",
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

/** Page sizes per the §4.1 list routes. The catalog reads are wider — a SKU list is browsed, not paged. */
export const M21_PAGE_SIZES = {
  requests: { defaultSize: 25, maxSize: 100 },
  dispatches: { defaultSize: 25, maxSize: 100 },
  returns: { defaultSize: 25, maxSize: 100 },
  catalog: { defaultSize: 100, maxSize: 500 },
  parStock: { defaultSize: 100, maxSize: 500 },
  routingRules: { defaultSize: 100, maxSize: 500 },
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

/** The paginated response envelope (`next_cursor` is null on the last page). */
export interface CursorPage<T> {
  readonly data: T[];
  readonly next_cursor: string | null;
  readonly has_more: boolean;
  readonly total_count?: number;
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

/** Decode an opaque cursor; a malformed one is `null` (treated as "start from the beginning"). */
export function decodeCursor(raw: string | undefined | null): Cursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Cursor;
    return typeof parsed?.a === "string" && typeof parsed?.id === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/** Slice a `limit + 1` row set into the page envelope (the anchor is extracted per route). */
export function toCursorPage<R, T>(
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
    next_cursor: hasMore && last !== undefined ? encodeCursor(anchorOf(last)) : null,
    has_more: hasMore,
  };
}
