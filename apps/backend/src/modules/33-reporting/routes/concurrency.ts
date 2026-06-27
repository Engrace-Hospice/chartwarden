// apps/backend/src/modules/33-reporting/routes/concurrency.ts — M33 (§4.1 cursor pagination).
//
// The opaque keyset-cursor codec + page helper the M33 LIST routes paginate on (dashboards / bases /
// metrics / MV registry / drilldown audit). Mirrors the M34/M22 routes/concurrency.ts precedent EXACTLY
// (cursor encodes `(createdAt DESC, id)`; offset pagination is forbidden); base64url JSON in the slice,
// HMAC-signed in prod — the route surface is stable either way. A malformed cursor is a 400
// VALIDATION_FAILED (never page-from-start).
import { WardenXError } from "@wardenx/types";
import type { FastifyReply, FastifyRequest } from "fastify";

/** A @wardenx/auth GuardHandler-shaped Fastify pre-handler. */
export type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** 400 IDEMPOTENCY_KEY_REQUIRED — a mutating route did not carry the required `Idempotency-Key` header. */
export class IdempotencyKeyRequiredError extends WardenXError {
  constructor() {
    super("IDEMPOTENCY_KEY_REQUIRED", "an Idempotency-Key header is required on this route", 400);
    this.name = "IdempotencyKeyRequiredError";
  }
}

/**
 * §4.1 — refuse a mutating request that does not carry an `Idempotency-Key` header (1–128 chars). Every
 * M33 definition/view/share/schedule COMMAND route is idempotency-required: the actual replay /
 * body-mismatch caching is the M1 platform `applyIdempotency` middleware (mounted globally on
 * buildServer); this pure header guard only enforces PRESENCE so a retry-unsafe client is refused up
 * front (the M07 `requireIdempotencyKey` precedent — no IO, no cross-module import).
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
    throw new WardenXError("VALIDATION_FAILED", "the cursor is malformed", 400);
  }
}

/** The default + maximum page size for the M33 list routes (default 50, max 200). */
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

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
 * given the same rows + cursor + limit it returns the same page (RLS scopes upstream).
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
