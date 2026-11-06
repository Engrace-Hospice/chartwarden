// @chartwarden/shared/route-kit — keyset pagination: one HMAC-signed opaque cursor and one page-query shape.
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

/** The common keyset payload: a sort value (ISO instant/date or text) plus the tie-breaking row id. */
export interface KeysetCursor {
  readonly a: string;
  readonly id: string;
}

export function isKeysetCursor(value: unknown): value is KeysetCursor {
  const v = value as Partial<KeysetCursor> | null;
  return typeof v?.a === "string" && typeof v.id === "string";
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
