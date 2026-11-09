// apps/backend/src/modules/21-supplies/routes/route-policy.ts — the two M21-specific route policies on top
// of `@chartwarden/shared/route-kit`.
//
// WHY `If-Match` CARRIES A TIMESTAMP AND NOT A VERSION NUMBER. M21's tables have no `version` column —
// §3.1 gives every row `updated_at` and no integer counter. The ETag is therefore the row's `updated_at` in
// ISO form, and the comparison is exact-string. That is sound because every M21 write goes through the
// service layer, which sets `updated_at` from one clock per transaction; migration 0106's triggers only
// compute discrepancy columns and never touch `updated_at`. A transition that omits `If-Match` is refused
// (428) rather than silently last-write-wins — for a controlled-substance count, one of two counts would
// otherwise be silently gone (§7.2 / §7.3).
import { IfMatchRequiredError, type PageSizePolicy } from "@chartwarden/shared/route-kit";
import { ChartWardenError } from "@chartwarden/types";

/** The row `updated_at` the caller read, from `If-Match`: absent 428, not an instant 400. */
export function ifMatchStamp(request: { headers: Record<string, unknown> }): string {
  const raw = request.headers["if-match"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const cleaned =
    typeof value === "string" ? value.replace(/^W\//, "").replace(/"/g, "").trim() : "";
  if (cleaned === "") throw new IfMatchRequiredError();
  if (Number.isNaN(Date.parse(cleaned))) {
    throw new ChartWardenError(
      "VALIDATION_FAILED",
      "If-Match must be the row updated_at you read",
      400,
    );
  }
  return cleaned;
}

/** Page sizes per the §4.1 list routes. The catalog reads are wider — a SKU list is browsed, not paged. */
export const M21_PAGE_SIZES = {
  requests: { defaultSize: 25, maxSize: 100 },
  dispatches: { defaultSize: 25, maxSize: 100 },
  returns: { defaultSize: 25, maxSize: 100 },
  catalog: { defaultSize: 100, maxSize: 500 },
  parStock: { defaultSize: 100, maxSize: 500 },
  routingRules: { defaultSize: 100, maxSize: 500 },
} as const satisfies Record<string, PageSizePolicy>;
