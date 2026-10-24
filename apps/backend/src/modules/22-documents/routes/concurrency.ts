// apps/backend/src/modules/22-documents/routes/concurrency.ts — M22-T07 (§4.1 cursor pagination + §2.5).
//
// Two pure, IO-free route helpers layered on top of the REAL Authorization Contract:
//
//   1. The opaque CURSOR codec (§4.1 / SD-052). PHI list routes paginate by an opaque cursor encoding
//      `(createdAt DESC, id)`; offset pagination is forbidden on PHI lists. The slice encodes the keyset
//      as base64url JSON; production HMAC-signs it (the codec shape is identical so the routes are stable).
//      `decodeCursor` rejects a malformed cursor as 400 VALIDATION_FAILED (never silently page-from-start).
//
//   2. The `If-Match` precondition guard the overlay PUT layers on (optimistic concurrency, §2.5): the
//      caller carries the row `version` it read; a missing header is 428 PRECONDITION_REQUIRED, a malformed
//      one is 400, and a stale value surfaces (service-side) as 412 VERSION_MISMATCH. Mirrors the M7/M8
//      routes/concurrency.ts precedent.
import { ForbiddenError, ChartWardenError } from "@chartwarden/types";
import type { FastifyReply, FastifyRequest } from "fastify";

/** A @chartwarden/auth GuardHandler-shaped Fastify pre-handler. */
export type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

// ── opaque keyset cursor (§4.1 / SD-052) ──────────────────────────────────────────────────────────────

/** The keyset a cursor encodes — `(createdAt DESC, id)` (§4.1). Opaque to clients. */
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
    throw new ChartWardenError("VALIDATION_FAILED", "the cursor is malformed", 400);
  }
}

/** The default + maximum page size for PHI list routes (§4.1: default 50, max 200). */
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

/** Clamp a requested page size into the [1, MAX] range, defaulting to {@link DEFAULT_PAGE_SIZE}. */
export function pageSizeOf(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_SIZE;
  return Math.max(1, Math.min(MAX_PAGE_SIZE, limit));
}

/** One page of `items` plus the opaque `nextCursor`/`hasMore` envelope every PHI list route returns. */
export interface CursorPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

/**
 * Keyset-paginate `rows` (already org-scoped + DESC-sorted by `(createdAt, id)`) into a {@link CursorPage}.
 * Pure: given the same rows + cursor + limit it returns the same page (RLS handles tenancy upstream).
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
    // strict keyset: skip everything at-or-after the cursor row in DESC `(createdAt, id)` order.
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

// ── If-Match optimistic concurrency (§2.5) ──────────────────────────────────────────────────────────

/** Request carrying the parsed `If-Match` version the PUT handler reads (set by {@link requireIfMatch}). */
export type WithIfMatch = FastifyRequest & { ifMatchVersion?: number };

/** 428 PRECONDITION_REQUIRED — the mutating route did not carry the required `If-Match` header (§2.5). */
export class IfMatchRequiredError extends ChartWardenError {
  constructor() {
    super(
      "PRECONDITION_REQUIRED",
      "an If-Match header (the row version you read) is required on this route",
      428,
    );
    this.name = "IfMatchRequiredError";
  }
}

const IF_MATCH_RE = /^"?(\d+)"?$/; // bare integer or quoted ETag form (`"3"`)

/** §2.5 — require + parse the `If-Match` header into `request.ifMatchVersion` (412 on skew, service-side). */
export function requireIfMatch(): PreHandler {
  return async (request) => {
    const raw = request.headers["if-match"];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value !== "string" || value.trim().length === 0) throw new IfMatchRequiredError();
    const m = IF_MATCH_RE.exec(value.trim());
    if (!m) {
      throw new ChartWardenError(
        "VALIDATION_FAILED",
        "If-Match must be the integer row version you read",
        400,
      );
    }
    (request as WithIfMatch).ifMatchVersion = Number.parseInt(m[1] ?? "", 10);
  };
}

/** Read the parsed `If-Match` version off the request (the {@link requireIfMatch} guard ran first). */
export function ifMatchVersionOf(request: FastifyRequest): number {
  const v = (request as WithIfMatch).ifMatchVersion;
  if (typeof v !== "number") throw new IfMatchRequiredError(); // defensive — guard ordering invariant
  return v;
}

// ── chart-writeback commit guards (§4.1 route 23; F-235) ─────────────────────────────────────────────────

/** §4.1 route 23 — `Idempotency-Key` header required (400 when absent/oversized). The replay itself is
 * collapsed service-side: a re-completed review returns `complete` without committing twice. */
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

/** AI Governance §7.3.2 "never auto-commits": an `ai_*` principal can never attest a DocLens review into the
 * chart (the M19 F-224 / M24 `rejectAiActor` shape over the server-assembled `actorKind`). */
export function rejectAiActor(): PreHandler {
  return async (request) => {
    const kind = request.context?.attributes?.actorKind;
    if (typeof kind === "string" && kind.startsWith("ai_")) {
      throw new ForbiddenError("AI principals cannot commit a WardenLens extraction review");
    }
  };
}
