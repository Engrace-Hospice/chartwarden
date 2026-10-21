// apps/backend/src/modules/16-bereavement/routes/concurrency.ts — M16-T06 (§2.5 / §4.1 / ADR-0021).
//
// Three route-boundary concerns that are policy, not per-route detail:
//
//   • §2.5 / §7.14 optimistic concurrency — a PATCH carries the row `version` it read in `If-Match`; the
//     pure `checkVersion` guard in ../lifecycle turns a mismatch into 412 with the current row state. A
//     PATCH that omits `If-Match` is refused here rather than silently last-write-wins.
//   • cursor pagination — offset pagination is FORBIDDEN on PHI list routes (SD-052): `?offset=` is
//     rejected 400 `OFFSET_PAGINATION_FORBIDDEN`. The cursor is an opaque base64url of the `(anchor, id)`
//     keyset pair; clients must not decode or construct one.
//   • ADR-0021 idempotency — §4.1 marks 25 of the 33 routes "Idempotent: yes", so every mutating route
//     requires a client-supplied `Idempotency-Key`. This is the HTTP-layer guard against a duplicate
//     client submission; it is NOT the §4.9 worker-side state-check, which §4.9's own note is explicit
//     about keeping orthogonal.
import { ChartWardenError } from "@wardenx/types";
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
 * §2.5 — parse `If-Match` into the row version the caller read. `required` (the PATCH / state-transition
 * routes) refuses an absent/garbled header with 428 rather than letting a blind write through.
 */
export function ifMatchVersion(
  request: { headers: Record<string, unknown> },
  required = false,
): number | undefined {
  const raw = request.headers["if-match"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const cleaned = typeof value === "string" ? value.replace(/"/g, "").trim() : "";
  const n = Number(cleaned);
  const parsed = cleaned !== "" && Number.isInteger(n) && n >= 0 ? n : undefined;
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

/** Page sizes per the §4.1 list routes (1 plans · 19 outreach · 29 risk scores · 30/31 dashboards). */
export const M16_PAGE_SIZES = {
  plans: { defaultSize: 25, maxSize: 100 },
  outreach: { defaultSize: 50, maxSize: 200 },
  riskScores: { defaultSize: 25, maxSize: 100 },
  dashboard: { defaultSize: 50, maxSize: 200 },
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
