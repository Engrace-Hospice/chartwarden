// apps/backend/src/modules/20-field-safety/routes/page-sizes.ts — the §4.1 list routes' page sizes.
// The keyset cursor, `?offset=` refusal and `If-Match`/`Idempotency-Key` guards are the shared route kit's.
import type { PageSizePolicy } from "@chartwarden/shared/route-kit";

export const M20_PAGE_SIZES = {
  checkIns: { defaultSize: 25, maxSize: 100 },
  sosAlerts: { defaultSize: 25, maxSize: 100 },
  incidents: { defaultSize: 25, maxSize: 100 },
  locationStream: { defaultSize: 100, maxSize: 500 },
  subscriptions: { defaultSize: 50, maxSize: 200 },
  highRiskAreas: { defaultSize: 50, maxSize: 200 },
} as const satisfies Record<string, PageSizePolicy>;
