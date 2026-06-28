// apps/backend/src/modules/25-remittance/routes/concurrency.ts — M25 (§2.5 If-Match + §F05 Idempotency-Key
// + cursor pagination). The opaque keyset-cursor codec the LIST routes paginate on, the mutating-route
// Idempotency-Key presence guard, and the If-Match version parser the PATCH routes 412 on. Mirrors the
// M27/M30 routes/concurrency.ts precedent: base64url JSON in the slice (HMAC-signed in prod); a malformed/
// tampered cursor or a missing/invalid If-Match is a 400, never a page-from-start / blind write.
import { WardenXError } from "@wardenx/types";
import type { FastifyReply, FastifyRequest } from "fastify";

export type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** 400 IDEMPOTENCY_KEY_REQUIRED — a mutating route did not carry the required `Idempotency-Key` header. */
export class IdempotencyKeyRequiredError extends WardenXError {
  constructor() {
    super("IDEMPOTENCY_KEY_REQUIRED", "an Idempotency-Key header is required on this route", 400);
    this.name = "IdempotencyKeyRequiredError";
  }
}

/** 400 IF_MATCH_REQUIRED — a PATCH route under optimistic concurrency lacked a valid If-Match version. */
export class IfMatchRequiredError extends WardenXError {
  constructor() {
    super("IF_MATCH_REQUIRED", "a numeric If-Match header is required on this route", 400);
    this.name = "IfMatchRequiredError";
  }
}

/** 409 VERSION_CONFLICT — the persisted row version moved since the client last read it (§2.5). */
export class VersionConflictError extends WardenXError {
  constructor(currentVersion: number | null) {
    super(
      "VERSION_CONFLICT",
      `the resource was modified by another writer (current version ${currentVersion ?? "unknown"}); re-read and retry`,
      409,
    );
    this.name = "VersionConflictError";
  }
}

/**
 * §F05 — refuse a mutating request that does not carry an `Idempotency-Key` header (1–128 chars). The 24h
 * replay / body-mismatch caching is the M1 platform `applyIdempotency` middleware (global); this pure
 * presence guard refuses a retry-unsafe client up front (the M27/M30 `requireIdempotencyKey` precedent).
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

/** Parse the `If-Match` header into a non-negative integer version, or throw 400 (§2.5). */
export function ifMatchVersion(request: FastifyRequest): number {
  const raw = request.headers["if-match"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const n = typeof value === "string" ? Number(value.replace(/"/g, "")) : NaN;
  if (!Number.isInteger(n) || n < 0) throw new IfMatchRequiredError();
  return n;
}

/** The keyset a cursor encodes — `(createdAt DESC, id)`. Opaque to clients. */
export interface CursorKeyset {
  readonly createdAt: string;
  readonly id: string;
}

/** A page of results plus the next opaque cursor (null at the end). */
export interface CursorPage<T> {
  readonly items: T[];
  readonly nextCursor: string | null;
}

/** Encode a keyset into an opaque base64url cursor. */
export function encodeCursor(keyset: CursorKeyset): string {
  return Buffer.from(JSON.stringify(keyset), "utf8").toString("base64url");
}

/** Decode an opaque cursor; a malformed/tampered value is a 400 (never page-from-start). */
export function decodeCursor(raw: string | undefined): CursorKeyset | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<CursorKeyset>;
    if (typeof parsed.createdAt === "string" && typeof parsed.id === "string") {
      return { createdAt: parsed.createdAt, id: parsed.id };
    }
  } catch {
    /* fallthrough to the 400 below */
  }
  throw new WardenXError("VALIDATION_FAILED", "malformed pagination cursor", 400);
}

/** Clamp a page-size query param to [1, 100] with a default of 50. */
export function clampLimit(raw: unknown): number {
  const n = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : NaN;
  if (!Number.isFinite(n)) return 50;
  return Math.min(100, Math.max(1, Math.floor(n)));
}
