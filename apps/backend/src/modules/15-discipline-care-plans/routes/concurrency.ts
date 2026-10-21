// apps/backend/src/modules/15-discipline-care-plans/routes/concurrency.ts — M15-T06 (§2.5 / §4.6.1 / §F08).
//
// Three route-boundary concerns that are policy, not per-route detail:
//
//   • §2.5 / §7.10 optimistic concurrency — a PATCH carries the row `version` it read in `If-Match`; the
//     pure `checkOptimisticConcurrency` guard turns a mismatch into 412 with the current row state. A
//     PATCH that omits `If-Match` is refused here rather than silently last-write-wins.
//   • §4.6.1 / SD-052 cursor pagination — offset pagination is FORBIDDEN on PHI list routes: `?offset=`
//     is rejected 400 `OFFSET_PAGINATION_FORBIDDEN`. The cursor is an opaque base64url of the
//     `(anchor, id)` keyset pair; clients must not decode or construct one. The response envelope is the
//     spec's `{ data, next_cursor, has_more, total_count? }` — NOT the `{items, nextCursor}` shape other
//     modules use, because §4.6.1 pins this one.
//   • §F08 idempotency — every mutating route requires a client-supplied `Idempotency-Key`.
import { ChartWardenError } from "@wardenx/types";
import type { PreHandler } from "./actor";

/** §F08 — every mutating route requires a client-supplied Idempotency-Key (1–128 chars). */
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

/** §4.6.1 — refuse `?offset=` on a PHI list route (offset pagination is forbidden, SD-052). */
export function rejectOffsetPagination(): PreHandler {
  return async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    if (query.offset !== undefined) {
      throw new ChartWardenError(
        "OFFSET_PAGINATION_FORBIDDEN",
        "offset pagination is not supported on PHI list routes; use ?cursor= (§4.6.1)",
        400,
      );
    }
  };
}

/**
 * §2.5 — parse `If-Match` into the row version the caller read. `required` (the PATCH/state-transition
 * routes) refuses an absent/garbled header with 428 rather than letting a blind write through.
 */
export function ifMatchVersion(
  request: { headers: Record<string, unknown> },
  required = false,
): number | null {
  const raw = request.headers["if-match"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const cleaned = typeof value === "string" ? value.replace(/"/g, "").trim() : "";
  const n = Number(cleaned);
  const parsed = cleaned !== "" && Number.isInteger(n) && n >= 0 ? n : null;
  if (parsed === null && required) {
    throw new ChartWardenError(
      "IF_MATCH_REQUIRED",
      "this route requires an If-Match header carrying the row version you read (§2.5)",
      428,
    );
  }
  return parsed;
}

/** §4.6.1 — the per-route page-size policy (default + hard max), applied to `?limit=`. */
export interface PageSizePolicy {
  readonly defaultSize: number;
  readonly maxSize: number;
}

/** §4.6.1 page sizes, per the route table (routes 1 / 4 / 19 / 25 / 26 / 28). */
export const M15_PAGE_SIZES = {
  plans: { defaultSize: 25, maxSize: 100 },
  versions: { defaultSize: 20, maxSize: 50 },
  gates: { defaultSize: 25, maxSize: 100 },
  relevantElements: { defaultSize: 50, maxSize: 200 },
  riskFactors: { defaultSize: 25, maxSize: 100 },
  supervisoryCadence: { defaultSize: 50, maxSize: 200 },
} as const satisfies Record<string, PageSizePolicy>;

/** Clamp a `limit` query param into `[1, maxSize]`, defaulting to the route's declared page size. */
export function clampLimit(raw: unknown, policy: PageSizePolicy): number {
  const n = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : Number.NaN;
  if (!Number.isFinite(n)) return policy.defaultSize;
  return Math.min(policy.maxSize, Math.max(1, Math.floor(n)));
}

/** The keyset anchor a cursor encodes: the sort column's value plus the tie-breaking row id. */
export interface Cursor {
  /** The sort-column value as a string (an ISO instant, or a zero-padded sequence). */
  readonly a: string;
  readonly id: string;
}

/** §4.6.1 — the paginated response envelope (`next_cursor` is null on the last page). */
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

/** Slice a `limit + 1` row set into the §4.6.1 page envelope (the anchor is extracted per route). */
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
