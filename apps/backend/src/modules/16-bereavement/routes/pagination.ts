// apps/backend/src/modules/16-bereavement/routes/pagination.ts — the M16 list page sizes and the anchor-shape
// check on the route kit's signed keyset cursor.
import {
  type KeysetCursor,
  type PageSizePolicy,
  decodeCursor,
  isKeysetCursor,
} from "@chartwarden/shared/route-kit";
import { ValidationError } from "@chartwarden/types";

/** Page sizes per the §4.1 list routes (1 plans · 19 outreach · 29 risk scores · 30/31 dashboards). */
export const M16_PAGE_SIZES = {
  plans: { defaultSize: 25, maxSize: 100 },
  outreach: { defaultSize: 50, maxSize: 200 },
  riskScores: { defaultSize: 25, maxSize: 100 },
  dashboard: { defaultSize: 50, maxSize: 200 },
} as const satisfies Record<string, PageSizePolicy>;

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PG_INT4_MAX = 2147483647;
const ANCHOR_SHAPE: Record<"date" | "instant" | "integer", (a: string) => boolean> = {
  date: (a) => /^\d{4}-\d{2}-\d{2}$/.test(a) && !Number.isNaN(Date.parse(`${a}T00:00:00Z`)),
  instant: (a) => !Number.isNaN(Date.parse(a)),
  // a Postgres int4 (the anchor is compared against an `integer` column): 10 digits can still overflow it
  integer: (a) => /^\d{1,10}$/.test(a) && Number(a) <= PG_INT4_MAX,
};

/**
 * Verify a signed keyset cursor (422 INVALID_CURSOR when it does not verify) AND check its anchor and id
 * have the shape the route's SQL casts them to: a cursor this org minted for a different list would
 * otherwise reach a `::uuid` cast or a `new Date(...)` and surface as a 500. A bad shape is a 422
 * validation error.
 */
export function decodeCheckedCursor(
  orgId: string,
  raw: string | undefined | null,
  anchor: "date" | "instant" | "integer",
): KeysetCursor | null {
  const cursor = decodeCursor(orgId, raw, isKeysetCursor);
  if (cursor === null) return null;
  if (!ANCHOR_SHAPE[anchor](cursor.a) || !UUID_SHAPE.test(cursor.id)) {
    throw new ValidationError("request validation failed", [
      { field: "cursor", code: "INVALID", message: "the cursor is not one this route issued" },
    ]);
  }
  return cursor;
}
