// apps/backend/src/modules/27-cost-report/routes/concurrency.ts — M27 (§4.1.1 Idempotency-Key + cursor).
//
// The opaque keyset-cursor codec + page helper the M27 LIST routes paginate on, plus the mutating-route
// Idempotency-Key presence guard. Mirrors the M30 routes/concurrency.ts precedent EXACTLY:
//   - the cursor encodes `(createdAt DESC, id)`; the M27 list routes anchor on a stable timestamp — a
//     cost report's `fiscal_year_end_date`, an import's `pulled_at`, a validation run's `run_started_at`,
//     a snapshot's `created_at` — which the Drizzle read service maps onto the `createdAt` slot of
//     {@link CursorKeyset} so this one helper serves every list route.
//   - base64url JSON in the slice, HMAC-signed in prod — the route surface is stable either way. A
//     malformed/tampered cursor is a 400 VALIDATION_FAILED (never page-from-start).
import { ChartWardenError } from "@wardenx/types";
import type { FastifyReply, FastifyRequest } from "fastify";

/** A @wardenx/auth GuardHandler-shaped Fastify pre-handler. */
export type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** 400 IDEMPOTENCY_KEY_REQUIRED — a mutating route did not carry the required `Idempotency-Key` header. */
export class IdempotencyKeyRequiredError extends ChartWardenError {
  constructor() {
    super("IDEMPOTENCY_KEY_REQUIRED", "an Idempotency-Key header is required on this route", 400);
    this.name = "IdempotencyKeyRequiredError";
  }
}

/**
 * §4.1.1 — refuse a mutating request that does not carry an `Idempotency-Key` header (1–128 chars). Every
 * M27 non-idempotent POST/PUT/PATCH/DELETE is idempotency-required; the actual 24h replay / body-mismatch
 * caching is the M1 platform `applyIdempotency` middleware (mounted globally on buildServer). This pure
 * header guard only enforces PRESENCE so a retry-unsafe client is refused up front (the M30
 * `requireIdempotencyKey` precedent — no IO, no cross-module import).
 */
export function requireIdempotencyKey(): PreHandler {
  return async (request) => {
    const raw = request.headers["idempotency-key"];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value !== "string" || value.length < 1 || value.length > 128) {
      throw new IdempotencyKeyRequiredError();
    }
  };
}

/** The keyset a cursor encodes — `(createdAt DESC, id)`. Opaque to clients. */
export interface CursorKeyset {
  /** The anchor timestamp (a row's `created_at`, or the partition/sort key `fiscal_year_end_date`/`pulled_at`). */
  readonly createdAt: string;
  readonly id: string;
}

/** Encode a keyset into an opaque base64url cursor (HMAC-signed in prod; shape identical). */
export function encodeCursor(keyset: CursorKeyset): string {
  return Buffer.from(JSON.stringify(keyset), "utf8").toString("base64url");
}

/** Decode an opaque cursor → keyset, or throw 400 VALIDATION_FAILED on a malformed/tampered value. */
export function decodeCursor(cursor: string): CursorKeyset {
  try {
    const json = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as Partial<CursorKeyset>;
    if (typeof parsed.createdAt !== "string" || typeof parsed.id !== "string") {
      throw new Error("missing keyset fields");
    }
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    throw new ChartWardenError("VALIDATION_FAILED", "the cursor is malformed", 400);
  }
}

/** The default + maximum page size for the M27 list routes (default 50, max 100). */
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

/** Clamp a requested page size into the [1, MAX] range, defaulting to {@link DEFAULT_PAGE_SIZE}. */
export function pageSizeOf(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_SIZE;
  return Math.max(1, Math.min(MAX_PAGE_SIZE, limit));
}

/** One page of `items` plus the opaque `nextCursor`/`hasMore` envelope every list route returns. */
export interface CursorPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

/**
 * Keyset-paginate `rows` (already DESC-sorted by `(createdAt, id)`) into a {@link CursorPage}. Pure:
 * given the same rows + cursor + limit it returns the same page (RLS scopes upstream). The keyset
 * invariant — `WHERE (ts, id) < (cursor.ts, cursor.id)` — is realised by the Drizzle services; this
 * helper is the in-memory equivalent the slice + route tests share.
 */
export function paginate<T extends CursorKeyset>(
  rows: readonly T[],
  cursor: string | undefined,
  limit: number | undefined,
): CursorPage<T> {
  const size = pageSizeOf(limit);
  let start = 0;
  if (cursor) {
    const key = decodeCursor(cursor);
    start = rows.findIndex(
      (r) => r.createdAt < key.createdAt || (r.createdAt === key.createdAt && r.id < key.id),
    );
    if (start === -1) start = rows.length;
  }
  const slice = rows.slice(start, start + size);
  const hasMore = start + size < rows.length;
  const last = slice[slice.length - 1];
  return {
    items: slice,
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
    hasMore,
  };
}
