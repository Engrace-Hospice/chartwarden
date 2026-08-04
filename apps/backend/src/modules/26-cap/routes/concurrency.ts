// apps/backend/src/modules/26-cap/routes/concurrency.ts — keyset-pagination cursor helpers + the
// Idempotency-Key presence guard (the M25/M27 precedent). A cursor is the base64url of `{ts,id}`; pages
// order by `(anchor DESC, id DESC)`.
import { WardenXError } from "@wardenx/types";
import type { PreHandler } from "./actor";

/** §F08 — every mutating route requires a client-supplied Idempotency-Key (1–128 chars). */
export function requireIdempotencyKey(): PreHandler {
  return async (request) => {
    const raw = request.headers["idempotency-key"];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value !== "string" || value.length < 1 || value.length > 128) {
      throw new WardenXError(
        "IDEMPOTENCY_KEY_REQUIRED",
        "an Idempotency-Key header is required",
        400,
      );
    }
  };
}

/** Clamp a `limit` query param into [1, 100], default 50. */
export function clampLimit(raw: unknown): number {
  const n = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : Number.NaN;
  if (!Number.isFinite(n)) return 50;
  return Math.min(100, Math.max(1, Math.floor(n)));
}

export interface Cursor {
  readonly ts: string;
  readonly id: string;
}

export interface CursorPage<T> {
  readonly items: T[];
  readonly nextCursor: string | null;
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

export function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Cursor;
    return typeof parsed?.ts === "string" && typeof parsed?.id === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/** Slice a `limit+1` row set into a page + the next cursor (anchor extracted by `anchorOf`). */
export function toPage<R, T>(
  rows: R[],
  limit: number,
  anchorOf: (r: R) => Cursor,
  map: (r: R) => T,
): CursorPage<T> {
  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;
  const last = slice[slice.length - 1];
  return {
    items: slice.map(map),
    nextCursor: hasMore && last ? encodeCursor(anchorOf(last)) : null,
  };
}
