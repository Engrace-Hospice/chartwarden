// apps/backend/src/modules/16-bereavement/routes/pagination.ts — the M16 list page sizes. Cursors decode
// through the route kit's `decodeKeysetCursor` (signature + anchor/id shape, 422 INVALID_CURSOR).
import type { PageSizePolicy } from "@chartwarden/shared/route-kit";

/** Page sizes per the §4.1 list routes (1 plans · 19 outreach · 29 risk scores · 30/31 dashboards). */
export const M16_PAGE_SIZES = {
  plans: { defaultSize: 25, maxSize: 100 },
  outreach: { defaultSize: 50, maxSize: 200 },
  riskScores: { defaultSize: 25, maxSize: 100 },
  dashboard: { defaultSize: 50, maxSize: 200 },
} as const satisfies Record<string, PageSizePolicy>;
