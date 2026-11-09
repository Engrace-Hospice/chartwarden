// @chartwarden/shared/route-kit — pagination: one HMAC-signed opaque cursor (keyset or offset) and one page-query shape.
//
// A cursor is `base64url(JSON payload).base64url(HMAC-SHA256(key, orgId.body))`. The org id is mixed into the
// HMAC input, so a cursor minted for org A does not verify for org B; a forged or tampered cursor is 422
// INVALID_CURSOR, never silently "page 1". The key is configured once at boot from the validated
// `CURSOR_SIGNING_KEY` (apps/backend/src/bootstrap/env.ts). Unconfigured, production refuses to sign;
// dev/test sign with a process-local random key (cursors then do not survive a restart).
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ChartWardenError } from "@chartwarden/types";
import { type TInteger, type TOptional, type TString, Type } from "@sinclair/typebox";

/** The default and the usual hard cap on `?limit=`. */
export const DEFAULT_PAGE_MAX = 200;
/** Room for a signed `(sort value, uuid)` cursor with margin. */
export const CURSOR_MAX_LENGTH = 512;
const EPHEMERAL_KEY_BYTES = 32;

let configuredKey: Buffer | undefined;
let ephemeralKey: Buffer | undefined;

/** Boot wiring: sign cursors with the deployment's `CURSOR_SIGNING_KEY`. */
export function configureCursorSigningKey(key: string): void {
  configuredKey = Buffer.from(key, "utf8");
}

function signingKey(): Buffer {
  if (configuredKey) return configuredKey;
  if (process.env.NODE_ENV === "production") {
    throw new ChartWardenError("INTERNAL_ERROR", "cursor signing is not configured", 500);
  }
  ephemeralKey ??= randomBytes(EPHEMERAL_KEY_BYTES);
  return ephemeralKey;
}

/** 422 — the cursor does not verify or is not a cursor of this route. */
export class InvalidCursorError extends ChartWardenError {
  constructor() {
    super("INVALID_CURSOR", "the pagination cursor is invalid; start from the first page", 422);
    this.name = "InvalidCursorError";
  }
}

function sign(orgId: string, body: string): string {
  return createHmac("sha256", signingKey()).update(`${orgId}.${body}`).digest("base64url");
}

/** Encode + sign an opaque cursor over `payload` for `orgId`. Clients never parse or construct one. */
export function encodeCursor(orgId: string, payload: unknown): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${sign(orgId, body)}`;
}

/**
 * Verify + decode a cursor. Absent (undefined, null, "") is `null` (first page); a cursor whose signature
 * does not verify, or whose payload fails `isPayload`, is {@link InvalidCursorError}.
 */
export function decodeCursor<T>(
  orgId: string,
  raw: string | null | undefined,
  isPayload: (value: unknown) => value is T,
): T | null {
  if (!raw) return null;
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) throw new InvalidCursorError();
  const body = raw.slice(0, dot);
  const provided = Buffer.from(raw.slice(dot + 1), "utf8");
  const expected = Buffer.from(sign(orgId, body), "utf8");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new InvalidCursorError();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw new InvalidCursorError();
  }
  if (!isPayload(parsed)) throw new InvalidCursorError();
  return parsed;
}

/**
 * The payload of an offset-paged list (SQL `OFFSET`): the position of the next page's first row. Offset paging
 * stays where a list has no stable keyset, but its cursor is signed like every other one, so a tampered or
 * garbage position is 422 INVALID_CURSOR instead of silently restarting at page 1.
 */
interface OffsetCursor {
  readonly o: number;
}

function isOffsetCursor(value: unknown): value is OffsetCursor {
  const o = (value as Partial<OffsetCursor> | null)?.o;
  return typeof o === "number" && Number.isSafeInteger(o) && o >= 0;
}

/** Sign the offset of the next page's first row for `orgId`. */
export function encodeOffsetCursor(orgId: string, offset: number): string {
  return encodeCursor(orgId, { o: offset } satisfies OffsetCursor);
}

/**
 * Verify + decode an offset cursor; absent (undefined, null, "") is offset 0, anything else that does not verify
 * is {@link InvalidCursorError}. `raw` is `unknown` so a route that reads `request.query` unvalidated can pass it
 * straight through: a repeated `?cursor=a&cursor=b` (an array) is refused, not coerced to page 1.
 */
export function decodeOffsetCursor(orgId: string, raw: unknown): number {
  if (raw !== undefined && raw !== null && typeof raw !== "string") throw new InvalidCursorError();
  return decodeCursor(orgId, raw, isOffsetCursor)?.o ?? 0;
}

/** The common keyset payload: a sort value (ISO instant/date or text) plus the tie-breaking row id. */
export interface KeysetCursor {
  readonly a: string;
  readonly id: string;
}

function isKeysetCursor(value: unknown): value is KeysetCursor {
  const v = value as Partial<KeysetCursor> | null;
  return typeof v?.a === "string" && typeof v.id === "string";
}

/**
 * What a list's SQL does with the cursor's sort value: `instant` is cast `::timestamptz`, `date` is a `date`
 * column, `integer` an int4 column, `text` a real text sort key (compared, never cast).
 */
export type KeysetAnchorKind = "instant" | "date" | "integer" | "text";

export interface KeysetCursorOptions {
  /** The tie-breaker id's shape. Default `uuid`; `text` only for a list whose tie-breaker is not a uuid. */
  readonly id?: "uuid" | "text";
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PG_INT4_MAX = 2147483647;
const DATE_SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/;
// ISO 8601 (`toISOString()`) or Postgres `timestamptz::text` (`2026-01-01 10:00:00.123456+00`).
const INSTANT_SHAPE =
  /^(\d{4}-\d{2}-\d{2})[T ]([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,9})?)?(Z|[+-]\d{2}(:?\d{2})?)?$/;

/** A real calendar date: `Date` rolls `2026-02-31` over to March, Postgres rejects it. */
function isCalendarDate(a: string): boolean {
  const m = DATE_SHAPE.exec(a);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

const ANCHOR_SHAPE: Record<KeysetAnchorKind, (a: string) => boolean> = {
  instant: (a) => {
    const m = INSTANT_SHAPE.exec(a);
    return m !== null && isCalendarDate(m[1] as string);
  },
  date: isCalendarDate,
  // a Postgres int4: 10 digits can still overflow it
  integer: (a) => /^\d{1,10}$/.test(a) && Number(a) <= PG_INT4_MAX,
  text: (a) => a.length <= CURSOR_MAX_LENGTH,
};

/**
 * Verify + decode a `{a, id}` keyset cursor AND check the anchor and id have the shape this list's SQL casts
 * them to. The signature binds a cursor to the org, not to the list: a cursor the same org minted for another
 * list verifies, and without this check reaches a `::timestamptz` / `::uuid` cast as a 500. A bad shape is
 * 422 INVALID_CURSOR, the same as a bad signature.
 */
export function decodeKeysetCursor(
  orgId: string,
  raw: string | null | undefined,
  anchor: KeysetAnchorKind,
  options: KeysetCursorOptions = {},
): KeysetCursor | null {
  const cursor = decodeCursor(orgId, raw, isKeysetCursor);
  if (cursor === null) return null;
  const idOk = options.id === "text" ? cursor.id.length > 0 : UUID_SHAPE.test(cursor.id);
  if (!ANCHOR_SHAPE[anchor](cursor.a) || !idOk) throw new InvalidCursorError();
  return cursor;
}

export interface PageOptions {
  /** Hard cap on `?limit=` (default {@link DEFAULT_PAGE_MAX}). */
  readonly max?: number;
  /** Server default when `?limit=` is absent; omit to let the service decide. */
  readonly defaultSize?: number;
}

/** The `?limit=` schema: an integer in `[1, max]`. */
export function pageLimit(options: PageOptions = {}): TOptional<TInteger> {
  return Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: options.max ?? DEFAULT_PAGE_MAX,
      ...(options.defaultSize === undefined ? {} : { default: options.defaultSize }),
    }),
  );
}

/** The `?cursor=&limit=` properties of a cursor-paginated list query; spread into `Type.Object({...})`. */
export function pageQuery(options: PageOptions = {}): {
  cursor: TOptional<TString>;
  limit: TOptional<TInteger>;
} {
  return {
    cursor: Type.Optional(Type.String({ maxLength: CURSOR_MAX_LENGTH })),
    limit: pageLimit(options),
  };
}

/** A per-route page-size policy (server default + hard max) for a `?limit=` read as raw query input. */
export interface PageSizePolicy {
  readonly defaultSize: number;
  readonly maxSize: number;
}

/** Clamp a raw `?limit=` into `[1, maxSize]`, defaulting to the route's page size when absent or non-numeric. */
export function clampLimit(raw: unknown, policy: PageSizePolicy): number {
  const n =
    typeof raw === "string" && raw.trim() !== ""
      ? Number(raw)
      : typeof raw === "number"
        ? raw
        : Number.NaN;
  if (!Number.isFinite(n)) return policy.defaultSize;
  return Math.min(policy.maxSize, Math.max(1, Math.floor(n)));
}

/**
 * The snake_case keyset envelope the PHI list routes pin (`{ data, next_cursor, has_more }`). No
 * `total_count`: a count on a PHI list is an enumeration oracle.
 */
export interface CursorPage<T> {
  readonly data: T[];
  readonly next_cursor: string | null;
  readonly has_more: boolean;
}

/** Slice a `limit + 1` row set into a {@link CursorPage}, signing the last row's anchor for `orgId`. */
export function toCursorPage<R, T>(
  orgId: string,
  rows: readonly R[],
  limit: number,
  anchorOf: (row: R) => KeysetCursor,
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

/** Pre-handler: refuse `?offset=` on a keyset-paginated PHI list (400 OFFSET_PAGINATION_FORBIDDEN). */
export function rejectOffsetPagination() {
  return async (request: { readonly query?: unknown }): Promise<void> => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    if (query.offset !== undefined) {
      throw new ChartWardenError(
        "OFFSET_PAGINATION_FORBIDDEN",
        "offset pagination is not supported on this list; use ?cursor=",
        400,
      );
    }
  };
}
